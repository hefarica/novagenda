/**
 * Rate limit en memoria para canales.
 *
 * Se usa una ventana deslizante por clave (`canal:usuario`, `simulate:ip`, …).
 * Los límites son deliberadamente bajos: la app es local y monousuario; lo que
 * se protege es que un bucle (webhook repetido, bot mal configurado) sature el
 * proceso, no un ataque distribuido.
 *
 * Los contadores viven en memoria y se reinician al reiniciar: son protección
 * operativa, no cuota persistente.
 */

/** @type {Map<string, {hits:number[], windowMs:number}>} */
const buckets = new Map();
const MAX_KEYS = 5_000;

/**
 * Consume una unidad del cubo. Devuelve si la petición está permitida.
 * @param {string} key
 * @param {{max:number, windowMs:number}} rule
 * @returns {{ok:boolean, remaining:number, retryAfterSec:number, limit:number, windowMs:number}}
 */
export function consume(key, rule) {
  const max = Math.max(1, Number(rule.max) || 60);
  const windowMs = Math.max(1_000, Number(rule.windowMs) || 60_000);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [], windowMs };
    buckets.set(key, bucket);
  }
  bucket.windowMs = windowMs;
  const since = now - windowMs;
  bucket.hits = bucket.hits.filter((at) => at > since);
  if (bucket.hits.length >= max) {
    const oldest = bucket.hits[0];
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      limit: max,
      windowMs
    };
  }
  bucket.hits.push(now);
  if (buckets.size > MAX_KEYS) prune();
  return { ok: true, remaining: max - bucket.hits.length, retryAfterSec: 0, limit: max, windowMs };
}

function prune() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (!bucket.hits.length || bucket.hits[bucket.hits.length - 1] < now - bucket.windowMs) {
      buckets.delete(key);
    }
    if (buckets.size <= MAX_KEYS / 2) break;
  }
}

/**
 * Devuelve un error descriptivo (código y detalles) cuando se supera el límite.
 * @param {string} scope
 * @param {{ok:boolean, retryAfterSec:number, limit:number, windowMs:number}} result
 * @returns {{code:string, message:string, details:object}|null}
 */
export function limitError(scope, result) {
  if (result.ok) return null;
  return {
    code: 'TOO_MANY_REQUESTS',
    message: `Demasiados mensajes en ${scope}. Espera ${result.retryAfterSec} s.`,
    details: { retryAfterSec: result.retryAfterSec, limit: result.limit, windowMs: result.windowMs }
  };
}

/** Reglas centralizadas (documentadas en docs/CANALES.md). */
export const LIMITS = Object.freeze({
  simulatePerIp: { max: 60, windowMs: 60_000 },
  inboundPerUser: { max: 30, windowMs: 60_000 },
  inboundPerChannel: { max: 180, windowMs: 60_000 },
  outboundPerChannel: { max: 120, windowMs: 60_000 },
  webhookPerIp: { max: 120, windowMs: 60_000 }
});

/** Solo para pruebas: vacía los contadores. */
export function resetLimiters() {
  buckets.clear();
}

/** Estado para diagnóstico (sin datos personales). */
export function limiterStats() {
  let active = 0;
  const now = Date.now();
  for (const bucket of buckets.values()) {
    if (bucket.hits.length && bucket.hits[bucket.hits.length - 1] > now - bucket.windowMs) active += 1;
  }
  return { keys: buckets.size, active, limits: LIMITS };
}
