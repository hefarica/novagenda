/**
 * Fetch HTTP seguro para research.
 *
 * Defensa SSRF en capas:
 *  - solo http/https (nunca file:, data:, gopher:, ftp:…);
 *  - resolución DNS y bloqueo de loopback, rangos privados, link-local,
 *    IPv6 local y endpoints de metadata cloud;
 *  - cada redirección se revalida (máx. 3);
 *  - timeout 8 s, cuerpo máximo 2 MB y content-type acotado.
 *
 * La resolución DNS es inyectable para tests (`setResearchDnsResolver`) y el
 * transporte HTTP también (`setResearchTransport`), de modo que se puede
 * probar una página “permitida” sin abrir tráfico a 127.0.0.1.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export const RESEARCH_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 8000,
  userAgent: 'AgendaCopilot-P95/1.1 (research; local)',
  allowedContentTypes: [
    'text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown',
    'application/json', 'application/ld+json',
    'application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml'
  ]
});

export class ResearchError extends Error {
  constructor(status, code, message, { field, details } = {}) {
    super(message);
    this.name = 'ResearchError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

let transport = (url, options) => fetch(url, options);
let dnsResolver = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** Inyecta transporte falso para tests (firma fetch: url, options → Response). */
export function setResearchTransport(fn) {
  transport = typeof fn === 'function' ? fn : ((url, options) => fetch(url, options));
}

export function resetResearchTransport() {
  transport = (url, options) => fetch(url, options);
}

/** Inyecta resolvedor DNS falso para tests (hostname → [{address,family}] o [string]). */
export function setResearchDnsResolver(fn) {
  dnsResolver = typeof fn === 'function' ? fn : async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });
}

export function resetResearchDnsResolver() {
  dnsResolver = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });
}

function ipv4ToInt(value) {
  const parts = String(value).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inIpv4Range(value, network, prefix) {
  const ip = ipv4ToInt(value);
  const base = ipv4ToInt(network);
  if (ip === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

const BLOCKED_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32]
];

function ipv6ToBigInt(value) {
  let address = String(value).toLowerCase();
  if (address.includes('::')) {
    const [left, right] = address.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    address = [...leftParts, ...Array(Math.max(0, missing)).fill('0'), ...rightParts].join(':');
  }
  const parts = address.split(':');
  if (parts.length !== 8) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    result = (result << 16n) + BigInt(parseInt(part, 16));
  }
  return result;
}

function ipv4FromBigInt(value) {
  const number = Number(value & 0xffffffffn);
  return `${(number >>> 24) & 255}.${(number >>> 16) & 255}.${(number >>> 8) & 255}.${number & 255}`;
}

function isBlockedIpv6(value) {
  const address = String(value).toLowerCase().replace(/^\[|\]$/g, '');
  if (address === '::1' || address === '::') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isBlockedIp(mapped[1]);
  const number = ipv6ToBigInt(address);
  if (number === null) return true;
  // IPv4-mapped en formato hexadecimal: ::ffff:7f00:1
  if ((number >> 32n) === 0xffffn) return isBlockedIp(ipv4FromBigInt(number));
  // 6to4: 2002:V4ADDR::/48
  if ((number >> 112n) === 0x2002n) return isBlockedIp(ipv4FromBigInt(number >> 80n));
  const inPrefix = (prefix, bits) => (number >> BigInt(128 - bits)) === (prefix >> BigInt(128 - bits));
  if (inPrefix(ipv6ToBigInt('fc00::'), 7)) return true; // fc00::/7
  if (inPrefix(ipv6ToBigInt('fe80::'), 10)) return true; // fe80::/10
  if (inPrefix(ipv6ToBigInt('ff00::'), 8)) return true; // multicast
  if (inPrefix(ipv6ToBigInt('2001:db8::'), 32)) return true; // documentación
  return false;
}

/** ¿La dirección IP (v4 o v6) es privada, local, link-local o reservada? */
export function isBlockedIp(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').trim();
  if (!value) return true;
  const family = net.isIP(value);
  if (family === 4) return BLOCKED_IPV4.some(([network, prefix]) => inIpv4Range(value, network, prefix));
  if (family === 6) return isBlockedIpv6(value);
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal',
  'metadata.goog', 'instance-data', 'instance-data.ec2.internal'
]);

/** ¿El hostname es localhost, .local/.internal o metadata cloud? */
export function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('metadata.')) return true;
  return false;
}

function normalizeAddressEntry(entry) {
  if (typeof entry === 'string') return { address: entry, family: net.isIP(entry) };
  return { address: entry?.address, family: entry?.family || net.isIP(entry?.address) };
}

/**
 * Valida protocolo, hostname y todas las direcciones DNS resueltas.
 * @param {string|URL} input
 * @returns {Promise<{url:URL, hostname:string, addresses:Array<{address:string,family:number}>}>}
 */
export async function assertUrlAllowed(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input).trim());
  } catch {
    throw new ResearchError(400, 'INVALID_URL', 'La URL no es válida', { field: 'url' });
  }
  if (!['http:', 'https:'].includes(url.protocol.toLowerCase())) {
    throw new ResearchError(400, 'UNSUPPORTED_PROTOCOL', `Protocolo no permitido: ${url.protocol}`, { field: 'url' });
  }
  if (url.username || url.password) {
    throw new ResearchError(400, 'INVALID_URL', 'La URL no debe incluir credenciales', { field: 'url' });
  }
  if (url.href.length > 2048) {
    throw new ResearchError(400, 'INVALID_URL', 'La URL excede 2048 caracteres', { field: 'url' });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (isBlockedHostname(hostname)) {
    throw new ResearchError(403, 'SSRF_BLOCKED', `Host bloqueado por seguridad: ${hostname}`, { field: 'url' });
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new ResearchError(403, 'SSRF_BLOCKED', `Dirección IP privada/reservada bloqueada: ${hostname}`, { field: 'url' });
    }
    return { url, hostname, addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  }
  let resolved;
  try {
    resolved = await dnsResolver(hostname);
  } catch (error) {
    throw new ResearchError(502, 'DNS_ERROR', `No se pudo resolver ${hostname}: ${error.message}`, { field: 'url' });
  }
  const addresses = (Array.isArray(resolved) ? resolved : [resolved]).map(normalizeAddressEntry).filter((entry) => entry.address);
  if (!addresses.length) {
    throw new ResearchError(502, 'DNS_ERROR', `Sin direcciones DNS para ${hostname}`, { field: 'url' });
  }
  for (const entry of addresses) {
    if (isBlockedIp(entry.address)) {
      throw new ResearchError(403, 'SSRF_BLOCKED', `El host ${hostname} resuelve a una IP bloqueada: ${entry.address}`, { field: 'url' });
    }
  }
  return { url, hostname, addresses };
}

function parseContentType(header) {
  return String(header || '').split(';')[0].trim().toLowerCase();
}

function isAllowedContentType(contentType) {
  return RESEARCH_LIMITS.allowedContentTypes.includes(contentType)
    || contentType === 'application/problem+json'
    || /^text\/[a-z0-9.+-]+$/i.test(contentType)
    || /\+json$/i.test(contentType)
    || /\+xml$/i.test(contentType);
}

function decodeBody(buffer, contentTypeHeader) {
  const charset = /charset\s*=\s*"?([a-zA-Z0-9._-]+)"?/i.exec(String(contentTypeHeader || ''))?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

async function readLimitedBody(response, maxBytes) {
  if (!response) throw new ResearchError(502, 'EMPTY_RESPONSE', 'El servidor no devolvió respuesta');
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* noop */ }
          throw new ResearchError(413, 'TOO_LARGE', `La respuesta excede ${maxBytes} bytes`, { field: 'url' });
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* noop */ }
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ResearchError(413, 'TOO_LARGE', `La respuesta excede ${maxBytes} bytes`, { field: 'url' });
    return buffer;
  }
  throw new ResearchError(502, 'EMPTY_RESPONSE', 'La respuesta no tiene cuerpo');
}

function redirectLocation(response) {
  return response.headers?.get?.('location') || response.headers?.location || null;
}

/**
 * Realiza un GET seguro y devuelve cuerpo/pertenencia.
 * @param {string} url
 * @param {{timeoutMs?:number,maxBytes?:number,maxRedirects?:number}} [options]
 */
export async function fetchSafe(url, options = {}) {
  const maxBytes = Math.min(RESEARCH_LIMITS.maxBytes, Math.max(1024, Number(options.maxBytes) || RESEARCH_LIMITS.maxBytes));
  const maxRedirects = Number.isFinite(options.maxRedirects) ? Math.max(0, Number(options.maxRedirects)) : RESEARCH_LIMITS.maxRedirects;
  const timeoutMs = Math.min(30_000, Math.max(1000, Number(options.timeoutMs) || RESEARCH_LIMITS.timeoutMs));
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let current = String(url || '').trim();
  let redirects = 0;
  try {
    for (;;) {
      const allowed = await assertUrlAllowed(current);
      let response;
      try {
        response = await transport(allowed.url.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': RESEARCH_LIMITS.userAgent,
            accept: 'text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1',
            'accept-language': 'es-CO,es;q=0.9,en;q=0.7'
          }
        });
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') {
          throw new ResearchError(504, 'TIMEOUT', `La petición superó ${timeoutMs} ms`, { field: 'url' });
        }
        throw new ResearchError(502, 'FETCH_ERROR', `No se pudo conectar: ${error.message}`, { field: 'url' });
      }
      const status = Number(response.status) || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= maxRedirects) {
          throw new ResearchError(502, 'TOO_MANY_REDIRECTS', `Máximo ${maxRedirects} redirecciones`, { field: 'url' });
        }
        const location = redirectLocation(response);
        if (!location) throw new ResearchError(502, 'INVALID_REDIRECT', 'Redirección sin Location', { field: 'url' });
        try {
          current = new URL(location, allowed.url).href;
        } catch {
          throw new ResearchError(502, 'INVALID_REDIRECT', 'Redirección con URL inválida', { field: 'url' });
        }
        redirects += 1;
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new ResearchError(502, 'HTTP_ERROR', `El servidor respondió ${status}`, { field: 'url', details: { status } });
      }
      const contentTypeHeader = response.headers?.get?.('content-type') || '';
      const contentType = parseContentType(contentTypeHeader);
      if (!isAllowedContentType(contentType)) {
        throw new ResearchError(415, 'UNSUPPORTED_CONTENT_TYPE', `Content-type no permitido: ${contentType || '(vacío)'}`, { field: 'url' });
      }
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new ResearchError(413, 'TOO_LARGE', `Content-Length ${contentLength} supera ${maxBytes} bytes`, { field: 'url' });
      }
      const buffer = await readLimitedBody(response, maxBytes);
      const headers = {};
      try {
        for (const [key, value] of response.headers || []) headers[key] = value;
      } catch { /* headers iterables opcionales */ }
      return {
        url: String(url),
        finalUrl: allowed.url.href,
        status,
        contentType,
        contentTypeHeader,
        headers,
        bytes: buffer.length,
        redirects,
        elapsedMs: Date.now() - started,
        text: decodeBody(buffer, contentTypeHeader),
        buffer,
        address: allowed.addresses[0]?.address || null
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

export { parseContentType, isAllowedContentType };
