#!/usr/bin/env node
/**
 * Servidor web de pruebas para research/SSRF.
 *
 * Escucha en 127.0.0.1 (por defecto 3261). `fetchSafe` DEBE rechazarlo: sirve
 * para demostrar el bloqueo de loopback. Para probar páginas “permitidas” en
 * tests automáticos se inyecta transporte/DNS (ver lib/research/selfcheck.mjs).
 *
 * Uso:
 *   node scripts/mock-web-server.mjs [--port 3261] [--host 127.0.0.1]
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARTICLE = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Artículo de prueba — Agenda P95</title>
  <meta name="author" content="Redacción P95">
  <meta property="article:published_time" content="2026-10-27T10:00:00Z">
  <meta property="og:site_name" content="Mock Research">
</head>
<body>
  <header><h1>Portal de pruebas</h1><nav><a href="/">Inicio</a><a href="/json">JSON</a></nav></header>
  <main>
    <article>
      <h1>Cómo proteger una agenda de investigación</h1>
      <p>La agenda P95 protege bloques de foco profundo y evita reuniones sin propósito.</p>
      <p>Un informe de research debe citar fuentes verificables y no inventar datos ausentes.</p>
      <p>La protección SSRF bloquea direcciones privadas, loopback y endpoints de metadata cloud.</p>
      <ul><li>Resolver DNS antes de conectar.</li><li>Revalidar cada redirección.</li></ul>
      <p>Más información en <a href="/json">el recurso JSON</a> o en <a href="https://example.com/">un enlace externo</a>.</p>
      <script>window.__secreto = 'NO DEBE APARECER';</script>
      <style>.oculto { display: none; }</style>
    </article>
  </main>
  <footer>© 2026 Mock Footer — NO DEBE APARECER</footer>
</body>
</html>`;

const JSON_BODY = JSON.stringify({
  title: 'Recurso JSON de prueba',
  author: 'API Mock',
  facts: ['El foco profundo mejora la ejecución', 'Las fuentes deben citarse'],
  updatedAt: '2026-10-27T10:00:00Z'
}, null, 2);

export async function createMockWebServer({ port = 3261, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    const pathname = url.pathname;
    const send = (status, body, type = 'text/html; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        ...extra
      });
      res.end(body);
    };
    if (pathname === '/' || pathname === '/article') return send(200, ARTICLE);
    if (pathname === '/json') return send(200, JSON_BODY, 'application/json; charset=utf-8');
    if (pathname === '/xml') return send(200, '<?xml version="1.0"?><root><title>XML de prueba</title><p>Contenido XML</p></root>', 'application/xml; charset=utf-8');
    if (pathname === '/binary') return send(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]), 'image/png');
    if (pathname === '/no-content-type') {
      res.writeHead(200);
      return res.end('<html><body>sin content-type</body></html>');
    }
    if (pathname === '/large') {
      const chunk = '<p>relleno de prueba</p>'.repeat(110_000);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><body>${chunk}</body></html>`);
    }
    if (pathname === '/redirect-ok') {
      res.writeHead(302, { location: '/article' });
      return res.end();
    }
    if (pathname === '/redirect-private') {
      const target = `http://127.0.0.1:${port}/article`;
      res.writeHead(302, { location: target });
      return res.end();
    }
    if (pathname === '/redirect-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    if (pathname === '/redirect-loop') {
      res.writeHead(302, { location: '/redirect-loop' });
      return res.end();
    }
    if (pathname === '/slow') {
      setTimeout(() => send(200, ARTICLE), 12_000);
      return;
    }
    if (pathname === '/echo') {
      return send(200, JSON.stringify({ url: req.url, headers: req.headers }), 'application/json; charset=utf-8');
    }
    send(404, '<html><body>404</body></html>', 'text/html; charset=utf-8');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 1500).unref?.();
    })
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const readArg = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const port = Number(readArg('port', process.env.MOCK_WEB_PORT || 3261));
  const host = readArg('host', process.env.MOCK_WEB_HOST || '127.0.0.1');
  const mock = await createMockWebServer({ port, host });
  console.log(`MOCK_WEB_URL=${mock.url}`);
  console.log('Páginas: /  /article  /json  /xml  /binary  /large  /redirect-ok  /redirect-private  /redirect-file  /slow  /echo');
  const stop = async () => { await mock.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
