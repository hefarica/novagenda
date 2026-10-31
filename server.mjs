/**
 * Agenda Copilot P95 — servidor HTTP.
 *
 * Responsabilidades (decisión B del capitán):
 *   - Crear el servidor HTTP y montar el router auto-descubierto.
 *   - Registrar el apagado limpio (SIGINT/SIGTERM) y los manejadores globales
 *     de errores.
 *   - NO programa ticks ni envíos: los intervalos, recordatorios y
 *     automatizaciones viven en `lib/workflows/scheduler.mjs` (t8).
 *
 * Manejadores globales: `unhandledRejection` se registra y la app sigue vivo;
 * `uncaughtException` se registra y se cierra de forma limpia tras el flush.
 */
import http from 'node:http';
import { createApp } from './lib/http/app.mjs';
import { installConsoleRedaction } from './lib/security/redact.mjs';
import { log, logError } from './lib/http/logger.mjs';
import { store } from './lib/store.mjs';
import { applyVaultToEnv, refreshRedactionIndex } from './lib/security/vault.mjs';
import { hostConfig } from './lib/security/session.mjs';

// La redacción se instala antes de cualquier log de arranque.
installConsoleRedaction();

const HOST = String(process.env.APP_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const config = hostConfig();

const vaultApplied = applyVaultToEnv();
refreshRedactionIndex();
if (vaultApplied.failures.length) {
  log('warn', `Secretos guardados no descifrables (clave maestra distinta?): ${vaultApplied.failures.map((failure) => failure.name).join(', ')}`);
}
if (store.isReadOnly()) {
  log('error', `Almacén en SOLO LECTURA: ${store.status().loadError || 'motivo desconocido'}`);
}

const app = await createApp();

const server = http.createServer((req, res) => {
  // El handler ya captura todo; este catch es la última red de seguridad.
  Promise.resolve(app.handler(req, res)).catch((err) => {
    logError('server:handler', err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Error interno del servidor', code: 'INTERNAL' }));
      } else {
        res.end();
      }
    } catch { /* socket cerrado */ }
  });
});

// Sockets keep-alive: si el servidor cierra antes que el navegador, Chrome
// reutiliza un socket muerto y el fetch falla ("Failed to fetch") sin llegar
// al servidor. Los GET se reintentan solos; POST/PATCH/DELETE NO, y el usuario
// ve "No pude hablar con el servidor". Node exige headersTimeout > keepAliveTimeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;
server.on('clientError', (err, socket) => {
  log('warn', `clientError: ${err.code || err.message}`);
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\ncontent-length: 0\r\n\r\n');
    else socket.destroy();
  } catch { /* ignore */ }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log('error', `El puerto ${PORT} está ocupado. Cierra la instancia anterior o usa PORT=<otro>.`);
    process.exit(2);
  }
  logError('server', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shownHost = config.loopback ? '127.0.0.1' : HOST;
  log('info', `Agenda Copilot P95 → http://${shownHost}:${PORT}`);
  log('info', `Auth: ${config.required ? 'sesión obligatoria (HOST≠loopback o APP_AUTH=on)' : 'modo local sin login'} · HOST=${config.host}`);
  log('info', `Datos: ${store.status().file} (schema v${store.status().schemaVersion})`);
});

/* ------------------------------------------------------------------ */
/* Cierre limpio y manejadores globales                                */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

/**
 * @param {number} code
 * @param {string} reason
 */
async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Cerrando Agenda Copilot (${reason})…`);
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch (err) {
    logError('shutdown:server', err);
  }
  try {
    const flush = await store.flush();
    if (flush.persistError) log('error', `Persistencia pendiente con error: ${flush.persistError}`);
  } catch (err) {
    logError('shutdown:flush', err);
  }
  process.exit(code);
}

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  void shutdown(1, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  // Se registra y la app continúa: los datos se guardan de forma atómica y cada
  // petición está aislada. Un rechazo suelto no debe tumbar el servidor.
  logError('unhandledRejection', reason);
});

process.on('SIGINT', () => { void shutdown(0, 'SIGINT'); });
process.on('SIGTERM', () => { void shutdown(0, 'SIGTERM'); });
