/**
 * API del conector MCP (auto-descubierta, priority 140).
 *
 *   GET    /api/mcp/status
 *   GET    /api/mcp/servers
 *   POST   /api/mcp/servers
 *   GET    /api/mcp/servers/:id
 *   PATCH  /api/mcp/servers/:id
 *   DELETE /api/mcp/servers/:id
 *   POST   /api/mcp/servers/:id/probe
 *   GET    /api/mcp/servers/:id/tools
 *   POST   /api/mcp/servers/:id/call   {tool,args}
 *
 * Autenticación normal de la app. Los valores de `env`/`headers` se cifran y
 * nunca se devuelven; las respuestas solo incluyen `envKeys`/`headerKeys`.
 */
import { bodyOf, paramOf, respond, route } from '../agenda/http.mjs';
import { mcpError, MCP_CODES } from '../mcp/errors.mjs';
import {
  validateServerCreate, validateServerPatch, validateCall, validateProbe
} from '../mcp/schema.mjs';
import {
  createServer, updateServer, deleteServer, listServers, getServerPublic,
  findServerRecord, recordProbe, resolveEnv, resolveHeaders, mcpSummary
} from '../mcp/state.mjs';
import { withSession, probeServer } from '../mcp/client.mjs';
import { classifyTool, isToolAllowed, publicTool } from '../mcp/tools.mjs';
import { gateToolCall, officeGateStatus, registerMcpExecutor } from '../mcp/gate.mjs';

export const name = 'mcp';
export const priority = 140;

// Deja el ejecutor listo para que una propuesta MCP aprobada pueda ejecutarse
// incluso si la aprobación ocurre en otro request. Si la Oficina no existe,
// el gate responderá MCP_GATE_UNAVAILABLE.
try {
  await registerMcpExecutor();
} catch {
  /* la Oficina es opcional */
}

function actorOf(ctx) {
  const user = ctx?.auth?.user;
  return user && user !== 'local' ? String(user) : 'api';
}

function requireServer(id) {
  const server = findServerRecord(id);
  if (!server) throw mcpError(404, MCP_CODES.SERVER_NOT_FOUND, `Servidor MCP ${id} no encontrado.`, { id });
  return server;
}

async function statusRoute(ctx) {
  return respond(ctx, 200, {
    ok: true,
    gate: await officeGateStatus(),
    summary: mcpSummary(),
    defaults: { timeoutMs: 10000, maxResponseBytes: Number(process.env.MCP_MAX_RESPONSE_BYTES) || 1_000_000 }
  });
}

async function listRoute(ctx) {
  return respond(ctx, 200, {
    ok: true,
    ...listServers(),
    gate: await officeGateStatus()
  });
}

async function createRoute(ctx) {
  const input = validateServerCreate(await bodyOf(ctx));
  const item = await createServer(input);
  return respond(ctx, 201, {
    ok: true,
    item,
    id: item.id,
    name: item.name,
    envKeys: item.envKeys,
    headerKeys: item.headerKeys
  });
}

async function getRoute(ctx) {
  const item = getServerPublic(paramOf(ctx, 'id'));
  if (!item) throw mcpError(404, MCP_CODES.SERVER_NOT_FOUND, `Servidor MCP ${paramOf(ctx, 'id')} no encontrado.`);
  return respond(ctx, 200, { ok: true, item });
}

async function patchRoute(ctx) {
  const patch = validateServerPatch(await bodyOf(ctx));
  const item = await updateServer(paramOf(ctx, 'id'), patch);
  return respond(ctx, 200, { ok: true, item });
}

async function deleteRoute(ctx) {
  const result = await deleteServer(paramOf(ctx, 'id'));
  return respond(ctx, 200, { ok: true, deleted: true, id: result.id });
}

async function probeRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const server = requireServer(id);
  if (server.enabled === false) throw mcpError(409, MCP_CODES.SERVER_DISABLED, `El servidor MCP ${id} está deshabilitado.`, { id });
  const probeInput = validateProbe(await bodyOf(ctx));
  const effective = probeInput.timeoutMs ? { ...server, timeoutMs: probeInput.timeoutMs } : server;
  const env = resolveEnv(server);
  const headers = resolveHeaders(server);
  try {
    const probe = await probeServer(effective, { env, headers, timeoutMs: effective.timeoutMs });
    const tools = probe.tools.map(publicTool);
    await recordProbe(id, {
      ok: true,
      toolCount: probe.toolCount,
      tools: tools.map((tool) => ({ name: tool.name, effect: tool.effect })),
      serverInfo: probe.serverInfo,
      protocolVersion: probe.protocolVersion,
      latencyMs: probe.latencyMs
    });
    return respond(ctx, 200, {
      ok: true,
      item: getServerPublic(id),
      probe: {
        protocolVersion: probe.protocolVersion,
        serverInfo: probe.serverInfo,
        capabilities: probe.capabilities,
        toolCount: probe.toolCount,
        latencyMs: probe.latencyMs
      },
      tools,
      count: tools.length
    });
  } catch (error) {
    await recordProbe(id, {
      ok: false,
      toolCount: 0,
      tools: [],
      errorCode: error?.code || MCP_CODES.PROTOCOL_ERROR
    }).catch(() => {});
    throw error;
  }
}

async function toolsRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const server = requireServer(id);
  if (server.enabled === false) throw mcpError(409, MCP_CODES.SERVER_DISABLED, `El servidor MCP ${id} está deshabilitado.`, { id });
  const env = resolveEnv(server);
  const headers = resolveHeaders(server);
  try {
    const probe = await probeServer(server, { env, headers, timeoutMs: server.timeoutMs });
    const tools = probe.tools.map(publicTool);
    await recordProbe(id, {
      ok: true,
      toolCount: probe.toolCount,
      tools: tools.map((tool) => ({ name: tool.name, effect: tool.effect })),
      serverInfo: probe.serverInfo,
      protocolVersion: probe.protocolVersion,
      latencyMs: probe.latencyMs
    });
    return respond(ctx, 200, {
      ok: true,
      item: getServerPublic(id),
      tools,
      count: tools.length,
      serverInfo: probe.serverInfo,
      protocolVersion: probe.protocolVersion
    });
  } catch (error) {
    await recordProbe(id, {
      ok: false,
      toolCount: 0,
      tools: [],
      errorCode: error?.code || MCP_CODES.PROTOCOL_ERROR
    }).catch(() => {});
    throw error;
  }
}

async function callRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const input = validateCall(await bodyOf(ctx));
  const server = requireServer(id);
  if (server.enabled === false) throw mcpError(409, MCP_CODES.SERVER_DISABLED, `El servidor MCP ${id} está deshabilitado.`, { id });
  const env = resolveEnv(server);
  const headers = resolveHeaders(server);

  let toolInfo = null;
  let classification = null;
  let directResult = null;

  await withSession(server, { env, headers, timeoutMs: server.timeoutMs }, async (client) => {
    const tools = await client.listTools();
    toolInfo = tools.find((tool) => tool && tool.name === input.tool) || null;
    if (!toolInfo) throw mcpError(404, MCP_CODES.TOOL_NOT_FOUND, `La herramienta "${input.tool}" no existe en el servidor ${id}.`, { tool: input.tool, serverId: id });
    classification = classifyTool(toolInfo);
    if (!isToolAllowed(server.toolAllowlist, input.tool, classification)) {
      throw mcpError(403, MCP_CODES.TOOL_NOT_ALLOWED, `La herramienta "${input.tool}" no está permitida en este servidor.`, {
        tool: input.tool,
        allowlist: server.toolAllowlist,
        effect: classification.effect
      });
    }
    if (!classification.effect) {
      directResult = await client.callTool(input.tool, input.args);
    }
  });

  const serverPublic = getServerPublic(id);
  const tool = {
    name: input.tool,
    effect: classification.effect,
    readOnly: classification.readOnly,
    reason: classification.reason
  };

  if (classification.effect) {
    const gate = await gateToolCall({
      server,
      toolInfo,
      args: input.args,
      actor: actorOf(ctx)
    });
    return respond(ctx, 202, {
      ok: true,
      gated: true,
      status: gate.proposal?.status || 'pending',
      executed: gate.executed === true,
      auto: gate.auto === true,
      server: serverPublic,
      tool,
      proposal: gate.proposal,
      gate: {
        provider: 'office',
        module: 'lib/office/proposals.mjs',
        proposalId: gate.proposal?.id || null,
        level: gate.proposal?.level || null,
        status: gate.proposal?.status || null,
        requiresApproval: gate.proposal?.policy?.requiresApproval === true,
        requiresCode: gate.proposal?.policy?.requiresCode === true,
        mode: gate.officeMode,
        approvalHint: 'Aprueba la propuesta en /api/office/proposals/:id/approve y ejecútala para que se llame a la herramienta MCP.'
      }
    });
  }

  return respond(ctx, 200, {
    ok: true,
    gated: false,
    server: serverPublic,
    tool,
    result: directResult
  });
}

export const routes = [
  { method: 'GET', path: '/api/mcp/status', name: 'mcp.status', handler: route(statusRoute) },
  { method: 'GET', path: '/api/mcp/servers', name: 'mcp.servers.list', handler: route(listRoute) },
  { method: 'POST', path: '/api/mcp/servers', name: 'mcp.servers.create', handler: route(createRoute) },
  { method: 'GET', path: '/api/mcp/servers/:id', name: 'mcp.servers.get', handler: route(getRoute) },
  { method: 'PATCH', path: '/api/mcp/servers/:id', name: 'mcp.servers.patch', handler: route(patchRoute) },
  { method: 'DELETE', path: '/api/mcp/servers/:id', name: 'mcp.servers.delete', handler: route(deleteRoute) },
  { method: 'POST', path: '/api/mcp/servers/:id/probe', name: 'mcp.servers.probe', handler: route(probeRoute) },
  { method: 'GET', path: '/api/mcp/servers/:id/tools', name: 'mcp.servers.tools', handler: route(toolsRoute) },
  { method: 'POST', path: '/api/mcp/servers/:id/call', name: 'mcp.servers.call', handler: route(callRoute) }
];

export default { name, priority, routes };
