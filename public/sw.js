/* Agenda Copilot P95 — service worker
   Estrategia:
   - Precache versionado del shell (HTML, CSS, módulos JS, iconos).
   - Navegación: red primero y, si falla, index.html cacheado (funciona sin red).
   - Estáticos: stale-while-revalidate.
   - API: nunca se cachea (los datos son del servidor local).
   - El trabajador nuevo espera; la página avisa y envía SKIP_WAITING al actualizar.
*/
const VERSION = '2026-10-30.123';
const CACHE = `agenda-p95-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/theme-light.css',
  '/motion.css',
  '/studio.css',
  '/app.js',
  '/js/main.js',
  '/js/core.js',
  '/js/api.js',
  '/js/state.js',
  '/js/data.js',
  '/js/offline.js',
  '/js/nlp.js',
  '/js/home.js',
  '/js/agenda.js',
  '/js/routines.js',
  '/js/assistant.js',
  '/js/integrations.js',
  '/js/workflows.js',
  '/js/system.js',
  '/js/onboarding.js',
  '/js/setup.js',
  '/js/office.js',
  '/js/docs.js',
  '/js/wiki.js',
  '/js/mail-guard.js',
  '/js/base.js',
  '/js/lingo.js',
  '/js/audit.js',
  '/js/meeting-capture.js',
  '/js/identity.js',
  '/js/approvals.js',
  '/js/okr.js',
  '/js/rooms.js',
  '/js/moments.js',
  '/js/attendance.js',
  '/js/modules.js',
  '/js/approval-types.js',
  '/js/backup.js',
  '/js/style.js',
  '/js/nudges.js',
  '/js/travel.js',
  '/js/voice.js',
  '/js/home-agent.js',
  '/js/ambient.js',
  '/js/organization.js',
  '/js/studio.js',
  '/js/compose.js',
  '/js/features.js',
  '/js/tasks.js',
  '/js/mcp.js',
  '/js/email-accounts.js',
  '/js/imap-accounts.js',
  '/js/theme-boot.js',
  '/js/theme.js',
  '/js/theme-init.js',
  '/js/markdown.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (error) {
        /* Un recurso ausente no debe impedir la instalación del resto. */
        console.warn('[sw] no se pudo precachear', path, error?.message || error);
      }
    }));
    /* Sin skipWaiting automático: la página decide cuándo aplicar la actualización. */
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldKeys = keys.filter((key) => key.startsWith('agenda-p95-') && key !== CACHE);
    await Promise.all(oldKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
    /* Solo se avisa de "actualización" cuando había una versión anterior. */
    if (!oldKeys.length) return;
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'SW_UPDATED', version: VERSION });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage?.({ type: 'SW_VERSION', version: VERSION });
  }
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return; // la API va siempre a la red

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', response.clone()).catch(() => {});
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('/index.html');
        return cached || new Response('<h1>Sin conexión</h1><p>Vuelve a abrir la app con el servidor encendido.</p>', {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});







































































































































