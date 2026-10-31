#!/usr/bin/env node
/**
 * Autochequeo de research (t25), sin red externa.
 *
 * - Usa el mock web server en 127.0.0.1 para demostrar el bloqueo SSRF.
 * - Usa transporte/DNS simulados para probar páginas “permitidas”, tamaño,
 *   content-type, redirecciones y el informe con citas.
 * - Nunca toca data/ real: DATA_DIR temporal.
 *
 * Uso: node lib/research/selfcheck.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmpRoot = path.join(os.tmpdir(), `agenda-research-selfcheck-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.DATA_DIR = tmpRoot;
process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
process.env.APP_SECRET = process.env.APP_SECRET || 'research-selfcheck-secret';
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.OLLAMA_URL;

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const results = [];
function check(name, condition, evidence = '') {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  [${evidence}]` : ''}`);
}
async function expectError(name, fn, code) {
  try {
    await fn();
    check(name, false, 'no lanzó error');
  } catch (error) {
    check(name, !code || error.code === code, `${error.code || error.name}: ${String(error.message).slice(0, 100)}`);
  }
}

const { store } = await imp('lib/store.mjs');
const fetchSafeModule = await imp('lib/research/fetchSafe.mjs');
const extract = await imp('lib/research/extract.mjs');
const reportModule = await imp('lib/research/report.mjs');
const researchRoutes = await imp('lib/routes/research.mjs');
const { createMockWebServer } = await imp('scripts/mock-web-server.mjs');

const {
  fetchSafe, assertUrlAllowed, setResearchTransport, resetResearchTransport,
  setResearchDnsResolver, resetResearchDnsResolver, isBlockedIp, ResearchError
} = fetchSafeModule;
const { createResearchReport, fetchResearchSource } = reportModule;

function htmlSource(label, facts) {
  return `<!doctype html><html lang="es"><head>
    <title>${label} — Agenda P95</title>
    <meta name="author" content="Redacción ${label}">
    <meta property="article:published_time" content="2026-10-27T10:00:00Z">
    <meta property="og:site_name" content="Mock ${label}">
  </head><body>
    <nav>Menú Inicio Contacto</nav>
    <article>
      <h1>${label}</h1>
      ${facts.map((fact) => `<p>${fact}</p>`).join('\n')}
      <p>Enlace de referencia <a href="https://example.com/${label.toLowerCase()}">externo</a>.</p>
      <script>NO_DEBE_APARECER_${label}</script>
      <style>.x{display:none}</style>
    </article>
    <footer>FOOTER_NO_DEBE_APARECER</footer>
  </body></html>`;
}

const pages = {
  'https://allow.test/article': htmlSource('Fuente A', [
    'La agenda P95 protege bloques de foco profundo y evita reuniones sin propósito.',
    'Un informe de research debe citar fuentes verificables y no inventar datos ausentes.',
    'La protección SSRF bloquea direcciones privadas, loopback y endpoints de metadata cloud.',
    'El texto principal se extrae sin scripts ni menús de navegación.'
  ]),
  'https://a.test/article': htmlSource('Fuente A', [
    'La agenda P95 protege bloques de foco profundo y evita reuniones sin propósito.',
    'Un informe de research debe citar fuentes verificables y no inventar datos ausentes.',
    'La protección SSRF bloquea direcciones privadas, loopback y endpoints de metadata cloud.'
  ]),
  'https://b.test/article': htmlSource('Fuente B', [
    'Resolver DNS antes de conectar reduce el riesgo de acceso a redes internas.',
    'Cada redirección debe revalidarse para no saltarse el control de destino.',
    'El contenido descargado se limita a dos megabytes para evitar abusos.'
  ]),
  'https://allow.test/json': JSON.stringify({ title: 'JSON mock', facts: ['dato A', 'dato B'] }),
  'https://allow.test/redirect-private': null,
  'https://allow.test/redirect-file': null,
  'https://allow.test/loop': null,
  'https://allow.test/large': '<html><body>' + '<p>relleno</p>'.repeat(300_000) + '</body></html>',
  'https://allow.test/binary': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'https://allow.test/no-type': '<html><body>sin tipo</body></html>'
};

const privateHosts = new Set(['private.test', 'metadata.test']);
setResearchDnsResolver(async (hostname) => {
  if (privateHosts.has(hostname)) return [{ address: '10.0.0.5', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
});
setResearchTransport(async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/redirect-private')) {
    return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } });
  }
  if (target.includes('/redirect-file')) {
    return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
  }
  if (target.includes('/loop')) {
    return new Response(null, { status: 302, headers: { location: '/loop' } });
  }
  if (target.includes('/large')) {
    return new Response(pages['https://allow.test/large'], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (target.includes('/binary')) {
    return new Response(pages['https://allow.test/binary'], { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (target.includes('/no-type')) {
    return new Response(pages['https://allow.test/no-type'], { status: 200, headers: { 'content-type': '' } });
  }
  if (target.includes('/json')) {
    return new Response(pages['https://allow.test/json'], { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const body = pages[target];
  if (body === undefined) return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
});

// ---------------------------------------------------------------------------
// 1. SSRF literal / protocolo / DNS / metadata
// ---------------------------------------------------------------------------
check('IP privadas detectadas', ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:7f00:1', '2002:7f00:1::'].every((ip) => isBlockedIp(ip)));
check('IP pública no bloqueada', isBlockedIp('93.184.216.34') === false);
await expectError('file:// bloqueado', () => assertUrlAllowed('file:///etc/passwd'), 'UNSUPPORTED_PROTOCOL');
await expectError('data: bloqueado', () => assertUrlAllowed('data:text/html,hola'), 'UNSUPPORTED_PROTOCOL');
await expectError('gopher: bloqueado', () => assertUrlAllowed('gopher://127.0.0.1/'), 'UNSUPPORTED_PROTOCOL');
await expectError('127.0.0.1 bloqueado', () => assertUrlAllowed('http://127.0.0.1/'), 'SSRF_BLOCKED');
await expectError('10.x bloqueado', () => assertUrlAllowed('http://10.0.0.1/'), 'SSRF_BLOCKED');
await expectError('192.168.x bloqueado', () => assertUrlAllowed('http://192.168.1.1/'), 'SSRF_BLOCKED');
await expectError('169.254.169.254 bloqueado', () => assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), 'SSRF_BLOCKED');
await expectError('::1 bloqueado', () => assertUrlAllowed('http://[::1]/'), 'SSRF_BLOCKED');
await expectError('localhost bloqueado', () => assertUrlAllowed('http://localhost/'), 'SSRF_BLOCKED');
await expectError('DNS a IP privada bloqueado', () => assertUrlAllowed('https://private.test/'), 'SSRF_BLOCKED');

// Mock web server real en loopback: debe ser rechazado.
let mock = null;
try {
  mock = await createMockWebServer({ port: Number(process.env.MOCK_WEB_PORT || 3261), host: '127.0.0.1' });
} catch (error) {
  mock = await createMockWebServer({ port: 0, host: '127.0.0.1' });
}
check('mock web server escucha en loopback', mock.port >= 3261 || mock.port > 0, `${mock.url}`);
await expectError('fetch al mock 127.0.0.1 bloqueado', () => fetchSafe(`${mock.url}/article`), 'SSRF_BLOCKED');

// ---------------------------------------------------------------------------
// 2. Redirecciones, tamaño, content-type y fetch permitido
// ---------------------------------------------------------------------------
await expectError('redirección a IP privada bloqueada', () => fetchSafe('https://allow.test/redirect-private'), 'SSRF_BLOCKED');
await expectError('redirección a file: bloqueada', () => fetchSafe('https://allow.test/redirect-file'), 'UNSUPPORTED_PROTOCOL');
await expectError('máximo de redirecciones', () => fetchSafe('https://allow.test/loop'), 'TOO_MANY_REDIRECTS');
await expectError('límite de 2 MB', () => fetchSafe('https://allow.test/large'), 'TOO_LARGE');
await expectError('content-type binario rechazado', () => fetchSafe('https://allow.test/binary'), 'UNSUPPORTED_CONTENT_TYPE');
await expectError('content-type vacío rechazado', () => fetchSafe('https://allow.test/no-type'), 'UNSUPPORTED_CONTENT_TYPE');

const fetched = await fetchSafe('https://allow.test/article');
check('fetch permitido (DNS simulado) devuelve HTML', fetched.status === 200 && fetched.contentType === 'text/html' && fetched.text.includes('agenda P95'), `${fetched.bytes} bytes`);
const article = extract.extractFromFetch(fetched);
check('extracción: título', /Fuente A/.test(article.title), article.title);
check('extracción: autor y fecha', article.author === 'Redacción Fuente A' && article.publishedAt.startsWith('2026-10-27'), `${article.author} / ${article.publishedAt}`);
check('extracción: idioma', article.language === 'es', article.language);
check('extracción: texto limpio sin script/nav/footer', article.text.includes('foco profundo') && !article.text.includes('NO_DEBE_APARECER') && !article.text.includes('FOOTER_NO') && !article.text.includes('Menú Inicio'), `${article.text.length} chars`);
check('extracción: enlaces absolutos', article.links.some((link) => decodeURIComponent(link.url) === 'https://example.com/fuente a'), JSON.stringify(article.links.slice(0, 2)));
check('extracción: límite 40k', article.text.length <= 40000, String(article.text.length));
const jsonFetched = await fetchSafe('https://allow.test/json');
const jsonExtract = extract.extractFromFetch(jsonFetched);
check('extracción JSON', jsonExtract.contentType === 'application/json' && /JSON mock/.test(jsonExtract.text), String(jsonExtract.length));

// ---------------------------------------------------------------------------
// 3. Informe sin LLM: 2 fuentes, 3 citas, persistencia
// ---------------------------------------------------------------------------
const report = await createResearchReport({
  question: '¿Cómo proteger una agenda de investigación?',
  urls: ['https://a.test/article', 'https://b.test/article'],
  maxSources: 2,
  useLlm: false,
  attachDocument: false,
  emailTo: null
});
console.log('REPORT', JSON.stringify({ sources: report.sourceCount, citations: report.citations, usedLlm: report.usedLlm }).slice(0, 500));
check('informe con 2 fuentes', report.sourceCount === 2 && report.sources.length === 2, JSON.stringify(report.sources.map((s) => s.title)));
check('informe con al menos 3 citas', report.citations.length >= 3 && report.citationCount >= 3, JSON.stringify(report.citations));
check('citas [1]/[2] presentes en la respuesta', /\[1\]/.test(report.answer) && /\[2\]/.test(report.answer));
check('sin LLM funciona y lo declara', report.usedLlm === false && report.llmError === null, String(report.llmError));
check('respuesta no incluye texto de script', !report.answer.includes('NO_DEBE_APARECER'));
check('citas fuera de rango se rechazan', reportModule.validateCitations('[9]', 2).valid === false && reportModule.validateCitations('[1] [2]', 2).valid === true);
check('persistencia de fuentes', store.get().research.sources.length >= 2, String(store.get().research.sources.length));
check('persistencia de informe', Boolean(store.get().research.reports.find((item) => item.id === report.reportId)));
check('downloadUrl de markdown', report.downloadUrl === `/api/research/reports/${report.reportId}/markdown`, report.downloadUrl);

const fallbackLlm = await createResearchReport({
  question: '¿Cómo se cita una fuente?',
  urls: ['https://a.test/article'],
  maxSources: 1,
  useLlm: true,
  attachDocument: false
});
check('sin proveedor LLM cae al informe determinista', fallbackLlm.usedLlm === false && /\[1\]/.test(fallbackLlm.answer), String(fallbackLlm.llmError));

// Integración con la oficina (t17 docs + propuesta N2)
const reportOffice = await createResearchReport({
  question: '¿Cómo proteger una agenda de investigación?',
  urls: ['https://a.test/article', 'https://b.test/article'],
  maxSources: 2,
  useLlm: false,
  attachDocument: true,
  emailTo: 'destino@example.com'
});
console.log('OFFICE', JSON.stringify({ document: reportOffice.document, proposal: reportOffice.proposal, docError: reportOffice.documentError, propError: reportOffice.proposalError }).slice(0, 900));
check('informe adjunta documento DOCX (t17)', Boolean(reportOffice.document?.id) && reportOffice.document.downloadUrl?.includes('/api/docs/'), reportOffice.document?.filename || reportOffice.documentError);
check('informe crea propuesta N2 por correo', reportOffice.proposal?.level === 'N2' && ['pending', 'held', 'approved'].includes(reportOffice.proposal?.status), JSON.stringify(reportOffice.proposal));

// ---------------------------------------------------------------------------
// 4. Rutas HTTP con contexto falso
// ---------------------------------------------------------------------------
function makeCtx({ method = 'GET', pathname = '/', query = {}, params = {}, body = undefined }) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  return {
    method, path: pathname, params, query: search, requestId: 'research-selfcheck',
    url: new URL(`http://localhost${pathname}${search.toString() ? `?${search}` : ''}`),
    _body: body,
    async body() { return this._body === undefined ? {} : this._body; },
    json(status, payload) { this.response = { status, payload }; return status; },
    text(status, payload, contentType, headers) { this.response = { status, payload, contentType, headers }; return status; }
  };
}
async function callRoute(method, pathname, options = {}) {
  const handler = researchRoutes.routes.find((entry) => entry.method === method && entry.path === pathname)?.handler;
  if (!handler) throw new Error(`Ruta no encontrada: ${method} ${pathname}`);
  const ctx = makeCtx({ method, pathname, ...options });
  await handler(ctx);
  return ctx.response;
}
let response = await callRoute('POST', '/api/research/fetch', { body: { url: 'https://allow.test/article' } });
check('POST /api/research/fetch', response.status === 200 && /Fuente A/.test(response.payload.title) && response.payload.source?.id, String(response.status));
response = await callRoute('GET', '/api/research/sources', { query: { limit: 1 } });
check('GET /api/research/sources', response.status === 200 && response.payload.items.length === 1 && response.payload.total >= 2, `total=${response.payload.total}`);
const sourceId = response.payload.items[0].id;
response = await callRoute('DELETE', '/api/research/sources/:id', { params: { id: sourceId } });
check('DELETE /api/research/sources/:id', response.status === 200 && response.payload.ok === true);
response = await callRoute('GET', '/api/research/reports/:id/markdown', { params: { id: report.reportId } });
check('GET report markdown descargable', response.status === 200 && /text\/markdown/.test(response.contentType) && /^# Informe/.test(response.payload), response.contentType);
response = await callRoute('GET', '/api/research/status', {});
check('GET /api/research/status', response.status === 200 && response.payload.item.limits.maxBytes === 2 * 1024 * 1024, '');

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------
resetResearchTransport();
resetResearchDnsResolver();
await mock.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n=== RESEARCH SELFCHECK === ${results.length} checks, ${failed.length} failed`);
if (failed.length) console.log(failed.map((result) => `- ${result.name}`).join('\n'));
try { await store.flush?.(); } catch { /* noop */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows puede retener handles */ }
process.exit(failed.length ? 1 : 0);




