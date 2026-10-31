/**
 * Conectores MCP: cualquier microservicio que hable MCP (HTTP, SSE o stdio)
 * se añade desde aquí, se prueba y se listan sus herramientas. Los secretos
 * (headers/env) viajan al servidor y nunca vuelven al navegador.
 */
import { api } from './api.js';
import { $, esc, toast } from './core.js';

let items = [];
let status = null;

function headersObject(lines) {
  const out = {};
  for (const line of String(lines || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const index = raw.indexOf(':');
    if (index <= 0) continue;
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function probeLabel(server) {
  const probe = server.lastProbe;
  if (!probe) return 'sin probar';
  if (probe.ok !== true) return `error ${esc(probe.errorCode || '')}`.trim();
  return `${probe.toolCount ?? 0} herramientas · ${probe.latencyMs ?? '—'} ms`;
}

function row(server) {
  const probeOk = server.lastProbe?.ok === true;
  const tag = server.enabled ? (probeOk ? 'ok' : 'warn') : 'off';
  return `<div class="feature-row mcp-row" data-id="${esc(server.id)}">
    <div class="feature-meta">
      <b>${esc(server.name)}</b>
      <small>${esc(server.transport)} · ${esc(server.url || server.command || '')} · ${probeLabel(server)}</small>
      <div class="tool-list" data-tools hidden></div>
    </div>
    <span class="tag ${tag}">${server.enabled ? 'activo' : 'pausado'}</span>
    <div class="row-actions">
      <button type="button" class="ghost small" data-mcp-probe>Probar</button>
      <button type="button" class="ghost small" data-mcp-tools>Herramientas</button>
      <button type="button" class="ghost small" data-mcp-toggle>${server.enabled ? 'Pausar' : 'Activar'}</button>
      <button type="button" class="danger small" data-mcp-delete>Eliminar</button>
    </div>
  </div>`;
}

function paint() {
  const state = $('#mcpState');
  if (state) {
    const gate = status?.gate;
    state.textContent = `${items.length} conector(es)${gate?.available === false ? ' · aprobación no disponible' : ''}`;
    state.className = `tag ${items.length ? 'ok' : 'off'}`;
  }
  const body = $('#mcpBody');
  if (body) body.innerHTML = items.length
    ? items.map(row).join('')
    : '<p class="hint">Sin conectores. Añade la URL MCP de tu microservicio (por ejemplo http://127.0.0.1:3001/mcp).</p>';
}

async function load() {
  const [list, info] = await Promise.all([api.get('/api/mcp/servers'), api.get('/api/mcp/status')]);
  items = Array.isArray(list.items) ? list.items : [];
  status = info;
  paint();
}

export async function renderMcpLab() {
  if (!$('#mcpBody')) return;
  try {
    await load();
  } catch (error) {
    const body = $('#mcpBody');
    if (body) body.innerHTML = `<p class="hint">No pude cargar los conectores: ${esc(error?.message || 'error')}</p>`;
  }
}

function toggleTransportFields() {
  const form = $('#mcpForm');
  if (!form) return;
  const transport = form.elements.transport.value;
  const isStdio = transport === 'stdio';
  const urlField = form.querySelector('[data-field="url"]');
  const commandField = form.querySelector('[data-field="command"]');
  const argsField = form.querySelector('[data-field="args"]');
  const headersField = form.querySelector('[data-field="headers"]');
  if (urlField) urlField.hidden = isStdio;
  if (headersField) headersField.hidden = isStdio;
  if (commandField) commandField.hidden = !isStdio;
  if (argsField) argsField.hidden = !isStdio;
}

export function initMcpLab() {
  const body = $('#mcpBody');
  const form = $('#mcpForm');
  if (!body || !form) return;

  $('#mcpNewBtn')?.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.name.focus();
  });
  $('#mcpCancel')?.addEventListener('click', () => { form.hidden = true; form.reset(); toggleTransportFields(); });
  $('#mcpRefresh')?.addEventListener('click', () => renderMcpLab());
  form.elements.transport.addEventListener('change', toggleTransportFields);
  toggleTransportFields();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const transport = String(data.get('transport') || 'http');
    const payload = {
      name: String(data.get('name') || '').trim(),
      transport,
      timeoutMs: Number(data.get('timeoutMs') || 10000)
    };
    if (transport === 'stdio') {
      payload.command = String(data.get('command') || '').trim();
      const args = String(data.get('args') || '').trim();
      if (args) payload.args = args.split(/\s+/);
    } else {
      payload.url = String(data.get('url') || '').trim();
      const headers = headersObject(data.get('headers'));
      if (headers) payload.headers = headers;
    }
    try {
      await api.post('/api/mcp/servers', payload);
      toast('Conector añadido', 'ok');
      form.reset();
      form.hidden = true;
      toggleTransportFields();
      await load();
    } catch (error) {
      toast(error?.message || 'No se pudo añadir el conector', 'err');
    }
  });

  body.addEventListener('click', async (event) => {
    const rowEl = event.target.closest('.mcp-row');
    if (!rowEl) return;
    const id = rowEl.getAttribute('data-id');
    const toolsBox = rowEl.querySelector('[data-tools]');
    try {
      if (event.target.closest('[data-mcp-probe]')) {
        const result = await api.post(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, {});
        toast(`Conector OK · ${result.probe?.toolCount ?? 0} herramientas · ${result.probe?.latencyMs ?? '—'} ms`, 'ok');
        await load();
        return;
      }
      if (event.target.closest('[data-mcp-tools]')) {
        if (toolsBox.hidden) {
          const result = await api.get(`/api/mcp/servers/${encodeURIComponent(id)}/tools`);
          const tools = Array.isArray(result.tools) ? result.tools : [];
          toolsBox.innerHTML = tools.length
            ? tools.map((tool) => `<span class="tag off" title="${esc(tool.description || '')}">${esc(tool.name)}${tool.effect ? ` · ${esc(tool.effect)}` : ''}</span>`).join(' ')
            : '<span class="hint">El servidor no declara herramientas.</span>';
          toolsBox.hidden = false;
        } else {
          toolsBox.hidden = true;
        }
        return;
      }
      if (event.target.closest('[data-mcp-toggle]')) {
        const current = items.find((item) => item.id === id);
        await api.patch(`/api/mcp/servers/${encodeURIComponent(id)}`, { enabled: current?.enabled === false });
        toast(current?.enabled === false ? 'Conector activado' : 'Conector pausado', 'ok');
        await load();
        return;
      }
      if (event.target.closest('[data-mcp-delete]')) {
        if (!window.confirm('¿Eliminar este conector MCP?')) return;
        await api.del(`/api/mcp/servers/${encodeURIComponent(id)}`);
        toast('Conector eliminado', 'ok');
        await load();
      }
    } catch (error) {
      toast(error?.message || 'Operación MCP fallida', 'err');
    }
  });
}
