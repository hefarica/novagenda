/**
 * Integración MCP ↔ Oficina (t13).
 *
 * - Las herramientas de solo lectura se ejecutan directas.
 * - Las herramientas con efectos NO se ejecutan: se crea una propuesta N2 en la
 *   Oficina (canal `webhook`, adjunto `mcp:<tool>` para forzar riesgo > 3) y se
 *   guardan los argumentos cifrados en `data.mcp.pendingCalls`; el token viaja
 *   en `proposal.meta.mcp.gateToken`.
 * - Si la Oficina no está disponible (o `MCP_GATE_DISABLE=1` para tests), se
 *   deniega con 503 `MCP_GATE_UNAVAILABLE`.
 * - Cuando la propuesta se aprueba y ejecuta, el ejecutor registrado en el canal
 *   `webhook` recupera los argumentos, llama a la herramienta MCP y deja el
 *   resultado en `proposal.execution`.
 */
import { HttpError } from '../http/errors.mjs';
import { redactString } from '../security/redact.mjs';
import { mcpError, gateUnavailable, gateFailed, MCP_CODES } from './errors.mjs';
import {
  createPendingCall, readPendingCall, deletePendingCall, findServerRecord,
  resolveEnv, resolveHeaders, getServerPublic
} from './state.mjs';
import { callToolDirect } from './client.mjs';

const OFFICE_PROPOSALS = '../office/proposals.mjs';
const OFFICE_EXECUTORS = '../office/executors.mjs';
let officePromise = null;
let registerPromise = null;
let executorRegistered = false;

export async function loadOfficeProposals() {
  if (!officePromise) {
    officePromise = import(OFFICE_PROPOSALS)
      .then((module) => (typeof module.createProposal === 'function' ? module : null))
      .catch(() => null);
  }
  return officePromise;
}

/** Estado del gate para /api/mcp/status y para decidir si se permite ejecutar. */
export async function officeGateStatus() {
  if (process.env.MCP_GATE_DISABLE === '1') {
    return { available: false, disabledByEnv: true, module: 'lib/office/proposals.mjs', executorRegistered };
  }
  const office = await loadOfficeProposals();
  return {
    available: !!office,
    disabledByEnv: false,
    module: 'lib/office/proposals.mjs',
    executorRegistered
  };
}

/**
 * Registra (una vez) el ejecutor MCP en el canal webhook de la Oficina.
 * @returns {Promise<boolean>}
 */
export async function registerMcpExecutor() {
  if (executorRegistered) return true;
  if (registerPromise) return registerPromise;
  registerPromise = (async () => {
    try {
      const office = await loadOfficeProposals();
      if (!office) return false;
      const { registerExecutor } = await import(OFFICE_EXECUTORS);
      registerExecutor('webhook', {
        name: 'mcp-office-executor',
        available: async () => true,
        execute: async (proposal) => {
          const meta = proposal?.meta?.mcp;
          if (!meta || proposal?.kind !== 'mcp' || !meta.serverId || !meta.tool) {
            throw new Error('La propuesta de webhook no es una llamada MCP válida.');
          }
          const server = findServerRecord(meta.serverId);
          if (!server) throw new Error(`Servidor MCP ${meta.serverId} no encontrado.`);
          if (server.enabled === false) throw new Error(`El servidor MCP ${server.id} está deshabilitado.`);
          const pending = readPendingCall(meta.gateToken);
          if (pending.serverId !== server.id || pending.tool !== meta.tool) {
            throw new Error('El token de la llamada MCP no coincide con la propuesta.');
          }
          const env = resolveEnv(server);
          const headers = resolveHeaders(server);
          const result = await callToolDirect(server, {
            tool: meta.tool,
            args: pending.args,
            env,
            headers,
            timeoutMs: server.timeoutMs
          });
          if (result.isError) {
            throw new Error(`La herramienta MCP ${meta.tool} devolvió error: ${String(result.text || '').slice(0, 300)}`);
          }
          await deletePendingCall(meta.gateToken);
          return {
            ok: true,
            executor: 'mcp',
            detail: `Herramienta MCP ${server.name}/${meta.tool} ejecutada tras aprobación.`,
            artifacts: [{
              type: 'mcp',
              serverId: server.id,
              tool: meta.tool,
              text: String(result.text || '').slice(0, 1000),
              isError: false
            }]
          };
        }
      });
      executorRegistered = true;
      return true;
    } catch {
      return false;
    } finally {
      registerPromise = null;
    }
  })();
  return registerPromise;
}

function argsKeys(args) {
  if (!args || typeof args !== 'object') return [];
  return Object.keys(args).slice(0, 30);
}

/**
 * Crea la propuesta de aprobación para una llamada con efectos.
 *
 * @param {{server:object, toolInfo:object, args:object, actor?:string}} input
 * @returns {Promise<{proposal:object, token:string, auto:boolean, executed:boolean, code:string|null, error:object|null, officeMode:string|null}>}
 */
export async function gateToolCall({ server, toolInfo, args = {}, actor = 'api' }) {
  const status = await officeGateStatus();
  if (!status.available) {
    throw gateUnavailable(status.disabledByEnv ? 'MCP_GATE_DISABLE=1' : 'módulo de Oficina no disponible');
  }
  const office = await loadOfficeProposals();
  if (!office) throw gateUnavailable('módulo de Oficina no disponible');
  if (!(await registerMcpExecutor())) throw gateUnavailable('no se pudo registrar el ejecutor MCP en la Oficina');

  const toolName = String(toolInfo?.name || '').slice(0, 120);
  const keys = argsKeys(args);
  const token = await createPendingCall({ serverId: server.id, tool: toolName, args });
  const body = [
    `Herramienta MCP "${toolName}" del servidor "${server.name}" (${server.transport}).`,
    `Argumentos declarados: ${keys.length ? keys.join(', ') : '(ninguno)'}.`,
    'Es una operación con efectos: requiere aprobación de la Oficina antes de ejecutarse.'
  ].join('\n').slice(0, 2000);
  const meta = {
    mcp: {
      serverId: server.id,
      serverName: server.name,
      tool: toolName,
      gateToken: token,
      transport: server.transport,
      effect: true
    },
    effect: true
  };

  let result;
  try {
    result = await office.createProposal({
      input: {
        kind: 'mcp',
        channel: 'webhook',
        recipients: [],
        subject: `MCP ${server.name}: ${toolName}`.slice(0, 300),
        body,
        attachments: [`mcp:${toolName}`.slice(0, 500)],
        meta
      },
      actor: String(actor || 'api').slice(0, 80)
    });
  } catch (error) {
    await deletePendingCall(token).catch(() => {});
    if (error instanceof HttpError) {
      // Conserva el código de validación de la Oficina, pero envuelto como fallo de gate.
      throw mcpError(error.status >= 500 ? 502 : error.status, error.code || MCP_CODES.GATE_FAILED, `Gate MCP: ${redactString(error.message || '')}`, error.details || null);
    }
    throw gateFailed(redactString(error?.message || error));
  }

  return {
    proposal: result.proposal,
    token,
    auto: result.auto === true,
    executed: result.executed === true,
    code: result.code || null,
    error: result.error || null,
    officeMode: result.proposal?.modeAtCreation || null
  };
}

/** Vista pública del servidor sin secretos (útil en respuestas de gate). */
export function publicServerForGate(serverId) {
  return getServerPublic(serverId);
}
