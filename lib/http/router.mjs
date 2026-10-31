/**
 * Router con auto-descubrimiento de `lib/routes/*.mjs`.
 *
 * Cada módulo exporta:
 *   export const name = 'agenda';        // opcional
 *   export const priority = 100;         // opcional (core = 0)
 *   export const routes = [{ method, path, handler, auth?, localOnly?, rawBody?, maxBodyBytes?, webhook?, csrf?, name? }];
 *
 * `handler(ctx)` recibe un único contexto (ver lib/http/app.mjs).
 * Si un módulo falla al importar, la app sigue arrancando y el error queda
 * visible en /api/health.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, logError } from './logger.mjs';
import { HttpError } from './errors.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(method) {
  return MUTATING.has(String(method || 'GET').toUpperCase());
}

function normalizePath(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/')) throw new Error(`path debe empezar con "/": ${raw}`);
  const clean = raw.replace(/\/{2,}/g, '/');
  return clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

function segmentsOf(cleanPath) {
  return cleanPath.split('/').filter(Boolean);
}

export class Router {
  constructor() {
    /** @type {any[]} */
    this.routes = [];
    /** @type {any[]} */
    this.modules = [];
    /** @type {any[]} */
    this.conflicts = [];
    this.compiled = false;
  }

  /**
   * @param {{name:string, file:string, priority:number, routes:any[]}} module
   */
  registerModule(module) {
    const { name, file, priority, routes } = module;
    const accepted = [];
    for (const definition of routes) {
      if (!definition || typeof definition !== 'object') {
        this.conflicts.push({ file, reason: 'ruta no es un objeto', route: String(definition) });
        continue;
      }
      if (typeof definition.handler !== 'function') {
        this.conflicts.push({ file, reason: 'handler no es función', route: definition.path });
        continue;
      }
      const methods = Array.isArray(definition.method) ? definition.method : [definition.method];
      let cleanPath;
      try {
        cleanPath = normalizePath(definition.path);
      } catch (err) {
        this.conflicts.push({ file, reason: err.message, route: definition.path });
        continue;
      }
      if (!cleanPath.startsWith('/api/')) {
        this.conflicts.push({ file, reason: 'las rutas deben empezar con /api/', route: cleanPath });
        continue;
      }
      for (const rawMethod of methods) {
        const method = String(rawMethod || 'GET').toUpperCase();
        if (!METHODS.has(method)) {
          this.conflicts.push({ file, reason: `método inválido: ${rawMethod}`, route: cleanPath });
          continue;
        }
        const route = {
          method,
          path: cleanPath,
          segments: segmentsOf(cleanPath),
          handler: definition.handler,
          auth: definition.auth ?? 'default',
          localOnly: definition.localOnly === true,
          rawBody: definition.rawBody === true,
          webhook: definition.webhook ?? false,
          csrf: definition.csrf !== false,
          maxBodyBytes: Number(definition.maxBodyBytes) || 1_000_000,
          name: definition.name || `${name}:${method} ${cleanPath}`,
          module: name,
          file,
          priority,
          order: this.routes.length
        };
        this.routes.push(route);
        accepted.push(route);
      }
    }
    this.modules.push({ name, file, priority, routes: accepted.length, ok: true });
    return accepted;
  }

  compile() {
    const seen = new Map();
    const winners = [];
    // Mayor prioridad primero; a igualdad, orden de registro.
    const ordered = [...this.routes].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.order - b.order;
    });
    for (const route of ordered) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) {
        const winner = seen.get(key);
        this.conflicts.push({ method: route.method, path: route.path, ignored: route.module, winner: winner.module, reason: 'ruta duplicada (gana mayor priority)' });
        continue;
      }
      seen.set(key, route);
      winners.push(route);
    }
    winners.sort((a, b) => {
      const staticA = a.segments.filter((seg) => !seg.startsWith(':')).length;
      const staticB = b.segments.filter((seg) => !seg.startsWith(':')).length;
      if (staticB !== staticA) return staticB - staticA;
      if (b.segments.length !== a.segments.length) return b.segments.length - a.segments.length;
      return a.order - b.order;
    });
    this.compiled = winners;
    return winners;
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @returns {{route:any, params:Record<string,string>}|null}
   */
  match(method, pathname) {
    const upper = String(method || 'GET').toUpperCase();
    const normalizedMethod = upper === 'HEAD' ? 'HEAD' : upper;
    const cleanPath = normalizePath(pathname || '/');
    const parts = segmentsOf(cleanPath);
    const candidates = this.compiled || this.compile();

    for (const route of candidates) {
      if (route.method !== normalizedMethod) {
        if (!(normalizedMethod === 'HEAD' && route.method === 'GET')) continue;
      }
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) {
          try {
            params[segment.slice(1)] = decodeURIComponent(parts[index]);
          } catch {
            throw new HttpError(400, 'INVALID_PATH', 'La ruta contiene caracteres inválidos.');
          }
        } else if (segment !== parts[index]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  summary() {
    return {
      modules: this.modules,
      routes: (this.compiled || this.routes).length,
      conflicts: this.conflicts
    };
  }
}

/**
 * Importa todos los módulos de `routesDir/*.mjs` (excepto `_*` y `*.test.mjs`).
 * @param {string} routesDir
 * @param {{onModuleError?:(info:any)=>void}} [options]
 */
export async function discoverRoutes(routesDir, options = {}) {
  const router = new Router();
  let files = [];
  try {
    files = fs.readdirSync(routesDir)
      .filter((file) => file.endsWith('.mjs') && !file.startsWith('_') && !file.endsWith('.test.mjs'))
      .sort();
  } catch (err) {
    logError('router:read-routes-dir', err, { routesDir });
    return router;
  }

  for (const file of files) {
    const fallbackName = file.replace(/\.mjs$/, '');
    const fullPath = path.join(routesDir, file);
    try {
      const module = await import(pathToFileURL(fullPath).href);
      const definitions = module.routes;
      if (!Array.isArray(definitions)) {
        router.modules.push({ name: module.name || fallbackName, file, priority: 100, routes: 0, ok: false, error: 'El módulo no exporta "routes" (array).' });
        log('warn', `Módulo de rutas ignorado (sin export routes): ${file}`);
        continue;
      }
      const name = typeof module.name === 'string' && module.name ? module.name : fallbackName;
      const priority = Number.isFinite(Number(module.priority)) ? Number(module.priority) : 100;
      router.registerModule({ name, file, priority, routes: definitions });
      log('debug', `Módulo de rutas cargado: ${name} (${definitions.length} rutas, priority ${priority})`);
    } catch (err) {
      router.modules.push({ name: fallbackName, file, priority: 100, routes: 0, ok: false, error: `${err.code ? `${err.code}: ` : ''}${err.message}` });
      logError(`router:import:${file}`, err);
      if (options.onModuleError) {
        try { options.onModuleError({ file, error: err }); } catch { /* ignore */ }
      }
    }
  }

  router.compile();
  return router;
}
