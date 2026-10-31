/* Prueba: resolver el hilo de Gmail por Message-ID contra un Gmail API local. */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-gmail-thread-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.APP_SECRET = 'gmail-thread-secret-0123456789abcdef';

const seen = [];
let mode = 'found';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  seen.push({ path: url.pathname, query: url.searchParams.get('q'), auth: req.headers.authorization || null });
  res.setHeader('content-type', 'application/json');
  if (url.pathname !== '/gmail/v1/users/me/messages') {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (mode === 'error') {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: 'boom' } }));
    return;
  }
  if (mode === 'empty') {
    res.end(JSON.stringify({ messages: [] }));
    return;
  }
  res.end(JSON.stringify({ messages: [{ id: 'm1', threadId: 't-42' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.GMAIL_API_BASE = `http://127.0.0.1:${server.address().port}/gmail/v1`;

const { gmailThreadIdForMessage } = await import('../lib/channel/email.mjs');
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const threadId = await gmailThreadIdForMessage('token-123', '<msg-12@test.local>');
check('Encuentra el hilo por Message-ID', threadId === 't-42', threadId);
check('Consulta rfc822msgid y manda el token', seen[0]?.query === 'rfc822msgid:<msg-12@test.local>' && seen[0]?.auth === 'Bearer token-123', JSON.stringify(seen[0]));

check('Sin Message-ID no llama a Gmail', (await gmailThreadIdForMessage('token-123', '')) === null && seen.length === 1);
check('Sin token no llama a Gmail', (await gmailThreadIdForMessage('', '<x@y>')) === null && seen.length === 1);

mode = 'empty';
check('Sin coincidencias devuelve null', (await gmailThreadIdForMessage('token-123', '<nadie@test.local>')) === null);

mode = 'error';
let failed = null;
try { await gmailThreadIdForMessage('token-123', '<error@test.local>'); } catch (error) { failed = error; }
check('Un error de Gmail queda explícito', !!failed, failed?.message);

server.close();
const failures = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failures.length ? `${failures.length} fallo(s)` : 'PASS'}`);
process.exitCode = failures.length ? 1 : 0;
