/**
 * Lanzador local de Agenda Copilot P95 (t6).
 *
 * - Carga `.env` si existe (sin sobreescribir variables ya definidas).
 * - Valida el entorno (Node, HOST, auth, DATA_DIR, LLM opcional).
 * - Elige un puerto libre (3000 por defecto; si está ocupado, 3001…3020).
 * - Arranca `server.mjs` en el mismo proceso (apagado limpio SIGINT/SIGTERM).
 * - Abre el navegador cuando `/api/health` responde (salvo `--no-open`/NO_OPEN/CI).
 *
 * Uso:
 *   node start.mjs                 # 3000 o el siguiente libre, abre navegador
 *   node start.mjs --no-open       # sin navegador
 *   PORT=3100 node start.mjs       # intenta 3100 primero
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = new Set(process.argv.slice(2));
const NO_OPEN = argv.has('--no-open') || /^(1|true|on|yes)$/i.test(String(process.env.NO_OPEN || '')) || process.env.CI === 'true';

function unquote(value = '') {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = unquote(line.slice(index + 1));
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function isLoopback(host) {
  return ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(String(host || '').toLowerCase().replace(/^\[|\]$/g, ''));
}

function tryListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findFreePort(preferred, host) {
  const start = Number.isFinite(Number(preferred)) && Number(preferred) > 0 ? Number(preferred) : 3000;
  for (let offset = 0; offset < 21; offset += 1) {
    const candidate = start + offset;
    if (candidate > 65535) break;
    // Se comprueba en el HOST real de escucha; para loopback se usa 127.0.0.1.
    const probeHost = isLoopback(host) ? '127.0.0.1' : undefined;
    if (await tryListen(candidate, probeHost)) return candidate;
  }
  throw new Error(`No hay puerto libre entre ${start} y ${start + 20}.`);
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

/* ------------------------------------------------------------------ */
/* 1. Entorno                                                          */
/* ------------------------------------------------------------------ */
const envLoaded = loadEnv(path.join(ROOT, '.env'));
const HOST = String(process.env.APP_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const desiredPort = Number(process.env.PORT || 3000);

if (nodeMajor() < 24) {
  console.warn(`⚠ Node ${process.versions.node} detectado. Este proyecto usa APIs de Node 24 (recomendado: 24 LTS o superior).`);
}
if (!fs.existsSync(path.join(ROOT, 'node_modules')) && fs.existsSync(path.join(ROOT, 'package.json'))) {
  // Sin dependencias npm; se informa solo para evitar confusión.
  console.log('ℹ Proyecto sin dependencias npm: no hace falta `npm install`.');
}
if (!isLoopback(HOST) && !/^(1|true|on|yes|s[ií])$/i.test(String(process.env.APP_AUTH || ''))) {
  console.log(`⚠ HOST=${HOST} no es loopback: la app exigirá sesión (auth obligatoria) antes de permitir escrituras.`);
}
if (!process.env.APP_SECRET) {
  console.log('ℹ APP_SECRET no definido: se usará la clave local de desarrollo (bóveda/firma de sesiones). Para uso real define APP_SECRET en .env.');
}

const port = await findFreePort(desiredPort, HOST);
process.env.PORT = String(port);
const shownHost = isLoopback(HOST) ? '127.0.0.1' : HOST;
const url = `http://${shownHost}:${port}`;

if (port !== desiredPort) {
  console.log(`ℹ Puerto ${desiredPort} ocupado; usando ${port}.`);
}
console.log('──────────────────────────────────────────────');
console.log(' Agenda Copilot P95');
console.log(` URL:    ${url}`);
console.log(` HOST:   ${HOST} · DATA_DIR: ${path.resolve(process.env.DATA_DIR || './data')}`);
console.log(` .env:   ${envLoaded ? 'cargado' : 'no existe (se usan valores por defecto)'}`);
console.log('──────────────────────────────────────────────');

if (!process.env.LLM_PROVIDER && !process.env.OPENAI_API_KEY && !process.env.OLLAMA_HOST) {
  console.log(' LLM (opcional): configura una API (Integraciones → LLM o POST /api/llm/config)');
  console.log('                 o instala Ollama y define OLLAMA_HOST. Sin LLM la app funciona igual.');
}

/* ------------------------------------------------------------------ */
/* 2. Servidor (mismo proceso: apagado limpio ya implementado)         */
/* ------------------------------------------------------------------ */
await import('./server.mjs');
// Worker de encargos del Estudio: vive en este proceso mientras la app está
// encendida; al arrancar recupera queued/running y reintenta con backoff.
const { startStudioWorker } = await import('./lib/studio/jobs.mjs');
startStudioWorker();

/* ------------------------------------------------------------------ */
/* 3. Navegador (no bloquea; el timer es unref)                        */
/* ------------------------------------------------------------------ */
async function waitHealthy(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch { /* aún arrancando */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* abrir el navegador es best-effort */ }
}

if (!NO_OPEN) {
  const timer = setTimeout(async () => {
    if (await waitHealthy()) {
      console.log(`Abriendo navegador en ${url} …`);
      openBrowser(url);
    } else {
      console.log(`La app aún no responde en ${url}. Ábrela manualmente cuando termine de arrancar.`);
    }
  }, 400);
  timer.unref();
}
