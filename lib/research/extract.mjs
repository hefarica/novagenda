/**
 * Extracción heurística de contenido sin navegador ni dependencias.
 *
 * No pretende ser un lector de artículos perfecto: obtiene título, metadatos,
 * texto principal limpio (sin script/style/nav/footer), enlaces e idioma, con
 * un límite de 40.000 caracteres.
 */

export const MAX_TEXT_CHARS = 40_000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿'
};

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return match; }
    })
    .replace(/&#(\d+);/g, (match, number) => {
      try { return String.fromCodePoint(Number(number)); } catch { return match; }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match);
}

function decodeBuffer(buffer, charset = 'utf-8') {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  try {
    return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

function charsetOf(contentType = '') {
  return /charset\s*=\s*"?([a-zA-Z0-9._-]+)"?/i.exec(String(contentType))?.[1] || 'utf-8';
}

export function stripTags(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' '));
}

function parseAttributes(tag) {
  const attributes = {};
  const source = String(tag || '');
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = regex.exec(source))) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function metaMap(html) {
  const map = {};
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').trim().toLowerCase();
    if (key && attrs.content !== undefined && map[key] === undefined) map[key] = attrs.content;
  }
  return map;
}

function firstMatch(html, regex) {
  const match = regex.exec(html);
  return match ? decodeEntities(match[1]) : '';
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase().replace('_', '-');
  if (!raw) return '';
  const primary = raw.split('-')[0];
  return /^[a-z]{2}$/.test(primary) ? primary : '';
}

function detectLanguage(text) {
  const sample = String(text || '').slice(0, 4000).toLowerCase();
  const spanish = ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'para', 'por', 'con', 'del', 'se', 'es', 'como', 'más'];
  const english = ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'on', 'that', 'as', 'this', 'are', 'be', 'from'];
  const tokens = sample.match(/[a-záéíóúüñ]+/g) || [];
  let es = 0, en = 0;
  for (const token of tokens) {
    if (spanish.includes(token)) es += 1;
    if (english.includes(token)) en += 1;
  }
  if (es >= 3 && es > en * 1.2) return 'es';
  if (en >= 3 && en > es * 1.2) return 'en';
  return '';
}

function extractMainHtml(html) {
  const articleMatches = [...String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)]
    .map((match) => match[1])
    .sort((a, b) => b.length - a.length);
  if (articleMatches[0] && articleMatches[0].length > 200) return articleMatches[0];
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (mainMatch && mainMatch[1].length > 200) return mainMatch[1];
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return bodyMatch ? bodyMatch[1] : String(html);
}

function removeBoilerplate(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*\/>/gi, ' ');
}

const DROP_LINES = new Set([
  'compartir', 'share', 'menú', 'menu', 'inicio', 'home', 'suscríbete', 'suscribete',
  'newsletter', 'cookie', 'cookies', 'política de cookies', 'privacy policy'
]);

export function htmlToText(html) {
  const prepared = removeBoilerplate(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|h[1-6]|blockquote|pre|tr|td|th)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ');
  const raw = stripTags(prepared)
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  const lines = [];
  for (const line of raw.split('\n')) {
    const clean = line.trim();
    if (!clean) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    if (clean.length < 2) continue;
    if (DROP_LINES.has(clean.toLowerCase())) continue;
    lines.push(clean);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractLinks(html, baseUrl) {
  const seen = new Set();
  const links = [];
  const source = String(html || '');
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(`<a ${match[1]}>`);
    const href = String(attrs.href || '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    let absolute;
    try {
      absolute = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = stripTags(match[2]).replace(/\s+/g, ' ').trim().slice(0, 200);
    links.push({ url: absolute, text });
    if (links.length >= 100) break;
  }
  return links;
}

function titleFromHtml(html, meta, baseUrl) {
  const rawTitle = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripTags(meta['og:title'] || meta['twitter:title'] || rawTitle || h1 || '').replace(/\s+/g, ' ').trim();
  if (title) return title.slice(0, 300);
  try {
    return decodeURIComponent(new URL(baseUrl).pathname.split('/').filter(Boolean).pop() || new URL(baseUrl).hostname);
  } catch {
    return String(baseUrl || '');
  }
}

function excerptOf(text, max = 500) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (sentenceEnd > max * 0.45 ? cut.slice(0, sentenceEnd + 1) : cut).trim();
}

/**
 * Extrae contenido útil de una respuesta HTTP ya descargada.
 * @param {{text:string, contentType?:string, url?:string, finalUrl?:string}} input
 */
export function extractContent({ text = '', contentType = 'text/html', url = '', finalUrl = '' } = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const baseUrl = finalUrl || url || '';
  const raw = String(text || '');

  if (type === 'application/json' || type.endsWith('+json') || type === 'application/ld+json') {
    let formatted = raw;
    let title = '';
    try {
      const parsed = JSON.parse(raw);
      formatted = JSON.stringify(parsed, null, 2);
      title = String(parsed?.title || parsed?.headline || parsed?.name || '').slice(0, 300);
    } catch { /* JSON inválido: se conserva el texto */ }
    const clean = formatted.slice(0, MAX_TEXT_CHARS);
    return {
      title: title || (() => { try { return new URL(baseUrl).pathname; } catch { return ''; } })(),
      author: '', publishedAt: '', language: '', siteName: '',
      text: clean, excerpt: excerptOf(clean), links: [],
      length: clean.length, wordCount: clean.split(/\s+/).filter(Boolean).length,
      contentType: type || 'application/json'
    };
  }

  if (type.includes('xml')) {
    const title = stripTags(firstMatch(raw, /<title\b[^>]*>([\s\S]*?)<\/title>/i)).trim();
    const clean = htmlToText(raw).slice(0, MAX_TEXT_CHARS);
    return {
      title: title || baseUrl, author: '', publishedAt: '', language: '',
      siteName: '', text: clean, excerpt: excerptOf(clean), links: [],
      length: clean.length, wordCount: clean.split(/\s+/).filter(Boolean).length,
      contentType: type || 'application/xml'
    };
  }

  const meta = metaMap(raw);
  const htmlLang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1] || '';
  const declaredLanguage = normalizeLanguage(htmlLang || meta['content-language'] || meta['og:locale'] || '');
  const main = extractMainHtml(removeBoilerplate(raw));
  let clean = htmlToText(main);
  if (clean.length < 200) {
    const fallback = htmlToText(raw);
    if (fallback.length > clean.length) clean = fallback;
  }
  clean = clean.slice(0, MAX_TEXT_CHARS);
  const language = declaredLanguage || detectLanguage(clean);
  const publishedAt = String(meta['article:published_time'] || meta['date'] || meta['pubdate']
    || meta['citation_publication_date'] || firstMatch(raw, /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i) || '');
  const author = String(meta['author'] || meta['article:author'] || meta['citation_author'] || '').trim();
  return {
    title: titleFromHtml(raw, meta, baseUrl),
    author: stripTags(author).replace(/\s+/g, ' ').trim().slice(0, 200),
    publishedAt: publishedAt.slice(0, 100),
    language,
    siteName: String(meta['og:site_name'] || '').slice(0, 120),
    text: clean,
    excerpt: excerptOf(clean),
    links: extractLinks(raw, baseUrl),
    length: clean.length,
    wordCount: clean.split(/\s+/).filter(Boolean).length,
    contentType: type || 'text/html'
  };
}

/**
 * Extrae desde el resultado de `fetchSafe` (buffer/contentType/url).
 */
export function extractFromFetch(result) {
  const text = result?.text ?? decodeBuffer(result?.buffer, charsetOf(result?.contentTypeHeader));
  return extractContent({
    text,
    contentType: result?.contentType || result?.contentTypeHeader || 'text/html',
    url: result?.url,
    finalUrl: result?.finalUrl
  });
}

export { decodeBuffer, charsetOf, metaMap };
