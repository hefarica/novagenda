/**
 * Registro de adaptadores de canal.
 *
 * Contrato mínimo de un adaptador (ver docs/CANALES.md §Añadir un canal):
 *
 *   {
 *     id: string, label: string, kind: string,
 *     alwaysAvailable: boolean,
 *     capabilities: {inbound, outbound, proactive, buttons, typing, threads, templates},
 *     configFields: FieldSpec[],          // metadatos para la UI (sin valores)
 *     instructions: string[],             // pasos para configurarlo
 *     status(): Status,                   // estado público (nunca secretos)
 *     configure(patch): Promise<…>,       // guarda credenciales/ajustes en caliente
 *     test(input): Promise<…>,            // prueba real de credenciales
 *     send(input): Promise<{id, skipped?, …}>, // saliente (reply o proactivo)
 *     typing?(to): Promise<void>,         // “escribiendo…”
 *     start?({onMessage}): void,          // arranque (polling/watchdog)
 *     stop?(): void,
 *     processWebhook?(payload, context): Promise<…>
 *   }
 *
 * `onMessage` es la única dependencia que el adaptador recibe del exterior: un
 * callback `(message) => Promise<…>` que ejecuta el pipeline (dedupe, asistente,
 * respuesta). Así los adaptadores no importan el pipeline y no hay ciclos ESM.
 */

const ORDER = ['simulator', 'telegram', 'whatsapp', 'email', 'generic'];

function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('El adaptador debe ser un objeto.');
  if (!/^[a-z0-9][a-z0-9:_-]{1,40}$/.test(String(adapter.id || ''))) {
    throw new TypeError(`id de adaptador inválido: ${adapter.id}`);
  }
  for (const method of ['status', 'configure', 'test', 'send']) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`El adaptador ${adapter.id} no implementa ${method}().`);
  }
  if (adapter.start && typeof adapter.start !== 'function') throw new TypeError(`start de ${adapter.id} inválido.`);
  return adapter;
}

export function createChannelRegistry() {
  /** @type {Map<string, any>} */
  const adapters = new Map();

  return {
    register(adapter) {
      assertAdapter(adapter);
      adapters.set(adapter.id, adapter);
      return adapter;
    },
    get(id) {
      return adapters.get(String(id || '')) || null;
    },
    has(id) {
      return adapters.has(String(id || ''));
    },
    list() {
      const items = [...adapters.values()];
      return items.sort((a, b) => {
        const indexA = ORDER.indexOf(a.id);
        const indexB = ORDER.indexOf(b.id);
        if (indexA !== indexB) return (indexA < 0 ? 99 : indexA) - (indexB < 0 ? 99 : indexB);
        return String(a.id).localeCompare(String(b.id));
      });
    },
    ids() {
      return this.list().map((adapter) => adapter.id);
    },
    statuses() {
      return this.list().map((adapter) => {
        try {
          const status = adapter.status();
          return { ...status, id: adapter.id };
        } catch (error) {
          return {
            id: adapter.id,
            label: adapter.label || adapter.id,
            configured: false,
            enabled: false,
            ready: false,
            detail: 'El adaptador no pudo calcular su estado.',
            warnings: [String(error?.message || error).slice(0, 200)],
            instructions: adapter.instructions || []
          };
        }
      });
    }
  };
}
