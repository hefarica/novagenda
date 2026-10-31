/**
 * Self-test end-to-end del subsistema LLM + agente.
 *
 * Levanta un servidor OpenAI-compatible de mentira (`lib/llm/mock-server.mjs`),
 * arranca la app en un DATA_DIR temporal y en un puerto libre, y verifica el
 * contrato completo:
 *
 *   status → configurar clave en la bóveda → test → modelos → autocompletado →
 *   crear cita → mover con confirmación → comandos deterministas → workflows
 *   (brief/cierre) → consumo → kill-switch → cascada Ollama → sin clave →
 *   memoria → validaciones → cero fugas de la clave.
 *
 * Uso:  node lib/llm/selftest.mjs
 * Salida: JSON con `ok`, `checks` y `failures`; exit code 1 si algo falla.
 * NO toca `data/` real (siempre DATA_DIR temporal) ni requiere red externa.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockLlmServer } from './mock-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TZ = 'America/Bogota';

const results = [];
const failures = [];
const responses = [];

function check(name, condition, detail = null) {
  const row = { name, ok: !!condition, detail: detail === undefined ? null : detail };
  results.push(row);
  if (!row.ok) failures.push(row);
  return row.ok;
}

function clockOf(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function dateKeyOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mock = await createMockLlmServer();
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), `agenda-llm-selftest-${process.pid}-${Date.now()}`);
  const secretKey = `sk-mock-agenda-${Math.random().toString(36).slice(2, 12)}`;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    APP_HOST: '127.0.0.1',
    HOST: '127.0.0.1',
    APP_SECRET: 'selftest-master-key-123',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: `${mock.url}/v1`,
    OPENAI_MODEL: 'mock-agenda-1',
    LLM_PROVIDER: '',
    OLLAMA_URL: '',
    OLLAMA_MODEL: '',
    LLM_OLLAMA_ENABLED: '',
    LOG_LEVEL: 'debug',
    NODE_ENV: 'test'
  };
  delete env.APP_SETUP_TOKEN;
  delete env.WA_ACCESS_TOKEN;
  delete env.TELEGRAM_BOT_TOKEN;

  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const request = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${pathname}`, init);
    const text = await response.text();
    responses.push({ pathname, method, status: response.status, text });
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  };

  const step = async (name, fn) => {
    try {
      const detail = await fn();
      check(name, true, detail ?? null);
    } catch (error) {
      check(name, false, `${error?.name || 'Error'}: ${error?.message || String(error)}`);
    }
  };

  try {
    // --------------------- arranque --------------------------------
    let health = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await request('/api/health');
        if (response.status === 200) { health = response.json; break; }
      } catch { /* aún arrancando */ }
      await delay(200);
    }
    await step('health: app arriba y módulo llm cargado', () => {
      if (!health) throw new Error(`La app no arrancó. stderr=${stderr.slice(-800)}`);
      const module = (health.modules || []).find((entry) => entry.name === 'llm');
      if (!module) throw new Error(`Módulo llm ausente: ${JSON.stringify(health.modules)}`);
      if (!module.ok) throw new Error(`Módulo llm con error: ${module.error}`);
      if (!(health.routes >= 12)) throw new Error(`Pocas rutas: ${health.routes}`);
      return `rutas=${health.routes} módulos=${(health.modules || []).length}`;
    });

    // ------------------ estado sin configurar ----------------------
    await step('status inicial: no configurado y reachable=false', async () => {
      const response = await request('/api/llm/status?probe=1');
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const body = response.json;
      if (body.configured !== false) throw new Error(`configured=${body.configured}`);
      if (body.reachable !== false) throw new Error(`reachable=${body.reachable}`);
      if (body.available !== false) throw new Error(`available=${body.available}`);
      if (body.fallback !== 'deterministic') throw new Error(`fallback=${body.fallback}`);
      if (body.openaiConfigured !== false) throw new Error('openaiConfigured debería ser false');
      if (JSON.stringify(body).includes(secretKey)) throw new Error('la clave apareció en status');
      return `provider=${body.provider} mode=${body.mode}`;
    });

    // --------------- configurar clave en la bóveda -----------------
    await step('POST /api/secrets/llm.openai.apiKey guarda en bóveda', async () => {
      const response = await request('/api/secrets/llm.openai.apiKey', { method: 'PUT', body: { value: secretKey } });
      if (response.status !== 200) throw new Error(`status ${response.status}: ${response.text.slice(0, 200)}`);
      const listed = await request('/api/secrets');
      const item = (listed.json?.items || []).find((row) => row.name === 'llm.openai.apiKey');
      if (!item) throw new Error('secreto no listado');
      if (item.configured !== true) throw new Error('configured=false tras guardar');
      if ('value' in item) throw new Error('el valor de la clave se devolvió en /api/secrets');
      return `source=${item.source} hint=${item.hint}`;
    });

    // ------------------ prueba con reintento -----------------------
    await step('POST /api/llm/test responde OK (reintento + contenido vacío tolerado)', async () => {
      mock.state.failFirst = 1;
      const response = await request('/api/llm/test', { method: 'POST', body: {} });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const body = response.json;
      if (body.ok !== true) throw new Error(`ok=${body.ok} error=${body.error} code=${body.errorCode}`);
      if (body.provider !== 'openai') throw new Error(`provider=${body.provider}`);
      if (body.model !== 'mock-agenda-1') throw new Error(`model=${body.model}`);
      if (!(body.latencyMs >= 0)) throw new Error('latencyMs inválida');
      if (!body.detail) throw new Error('falta detail del probe');
      if (body.probe !== 'chat') throw new Error(`probe=${body.probe}`);
      if (response.text.includes(secretKey)) throw new Error('la clave apareció en la respuesta de test');
      const postCalls = mock.calls().filter((call) => call.route === 'POST /v1/chat/completions');
      if (postCalls.length < 2) throw new Error(`se esperaban 2 intentos, hubo ${postCalls.length}`);

      // Regresión t12: 200 con contenido vacío + finish_reason "length" NO es fallo.
      // Debe degradar al probe de salud y devolver ok:true con detail.
      mock.state.emptyCompletion = 1;
      const emptyProbe = await request('/api/llm/test', { method: 'POST', body: { probe: 'chat' } });
      if (emptyProbe.status !== 200) throw new Error(`empty status ${emptyProbe.status}`);
      const emptyBody = emptyProbe.json;
      if (emptyBody.ok !== true) throw new Error(`empty probe ok=${emptyBody.ok} code=${emptyBody.errorCode} error=${emptyBody.error}`);
      if (emptyBody.probe !== 'health') throw new Error(`empty probe=${emptyBody.probe}`);
      if (!/salud|health/i.test(String(emptyBody.detail || ''))) throw new Error(`detail sin modo salud: ${emptyBody.detail}`);
      if (emptyBody.errorCode) throw new Error(`empty probe errorCode=${emptyBody.errorCode}`);
      if (mock.state.emptyCompletion !== 0) throw new Error('el mock no consumió el contenido vacío');

      // Contrato intacto: un fallo real (401) conserva su código, no LLM_BAD_RESPONSE.
      mock.state.failStatus = 401;
      mock.state.failFirst = 1;
      const authFail = await request('/api/llm/test', { method: 'POST', body: { probe: 'chat' } });
      mock.state.failStatus = 500;
      if (authFail.json?.ok !== false) throw new Error('401 debería fallar el test');
      if (authFail.json?.errorCode !== 'LLM_AUTH') throw new Error(`401 errorCode=${authFail.json?.errorCode}`);
      return `latencyMs=${body.latencyMs} intentos=${postCalls.length} · vacío→health ok · 401→LLM_AUTH`;
    });

    await step('status con clave: reachable=true, available=true y cadena API', async () => {
      const response = await request('/api/llm/status?probe=1');
      const body = response.json;
      if (body.reachable !== true) throw new Error(`reachable=${body.reachable} error=${body.lastError}`);
      if (body.available !== true) throw new Error(`available=${body.available}`);
      if (body.configured !== true) throw new Error('configured=false');
      if (body.openaiConfigured !== true) throw new Error('openaiConfigured=false');
      if (body.mode !== 'api') throw new Error(`mode=${body.mode}`);
      if (!Array.isArray(body.chain) || !body.chain.length) throw new Error('chain vacía');
      if (body.provider !== 'openai') throw new Error(`provider=${body.provider}`);
      if (JSON.stringify(body).includes(secretKey)) throw new Error('la clave apareció en status');
      return `model=${body.model} latencyMs=${body.latencyMs}`;
    });

    await step('GET /api/llm/models lista el modelo del proveedor', async () => {
      const response = await request('/api/llm/models');
      const ids = (response.json?.items || []).map((item) => item.id);
      if (!ids.includes('mock-agenda-1')) throw new Error(`items=${JSON.stringify(ids)}`);
      return ids.join(',');
    });

    // ------------- cabeceras extra + versión de API ----------------
    await step('POST /api/llm/config aplica extraHeaders y apiVersion', async () => {
      const response = await request('/api/llm/config', {
        method: 'POST',
        body: { extraHeaders: { 'x-mock-header': 'abc-123' }, apiVersion: '2024-10-01', maxRetries: 2, limits: { dailyCalls: 400, dailyTokens: 200000, ratePerMin: 60 } }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}: ${response.text.slice(0, 300)}`);
      if (response.json?.ok !== true) throw new Error('ok!=true');
      const test = await request('/api/llm/test', { method: 'POST', body: { probe: 'chat' } });
      if (test.json?.ok !== true) throw new Error(`test falló: ${test.json?.error}`);
      const last = mock.calls().filter((call) => call.route === 'POST /v1/chat/completions').at(-1);
      if (last?.headers?.['x-mock-header'] !== 'abc-123') throw new Error(`cabecera extra no enviada: ${JSON.stringify(last?.headers)}`);
      if (!String(last?.authorization || '').startsWith('Bearer ')) throw new Error('sin Authorization Bearer');
      if (last.authorization.includes('«secreto»')) throw new Error('la Authorization llegó redactada');
      return `header=${last.headers['x-mock-header']}`;
    });

    await step('adaptadores: openai-responses y anthropic responden', async () => {
      const createResponses = await request('/api/llm/config', { method: 'POST', body: { provider: 'openai-responses' } });
      if (createResponses.status !== 200) throw new Error(`config responses ${createResponses.status}`);
      const testResponses = await request('/api/llm/test', { method: 'POST', body: {} });
      if (testResponses.json?.ok !== true || testResponses.json?.provider !== 'openai-responses') {
        throw new Error(`responses: ${JSON.stringify(testResponses.json)}`);
      }
      const createAnthropic = await request('/api/llm/config', { method: 'POST', body: { provider: 'anthropic' } });
      if (createAnthropic.status !== 200) throw new Error(`config anthropic ${createAnthropic.status}`);
      const testAnthropic = await request('/api/llm/test', { method: 'POST', body: {} });
      if (testAnthropic.json?.ok !== true || testAnthropic.json?.provider !== 'anthropic') {
        throw new Error(`anthropic: ${JSON.stringify(testAnthropic.json)}`);
      }
      const messageCall = mock.calls().filter((call) => call.route === 'POST /v1/messages').at(-1);
      if (!messageCall?.anthropicKey) throw new Error('anthropic sin cabecera x-api-key');
      if (!messageCall?.anthropicVersion) throw new Error('anthropic sin anthropic-version');
      const restore = await request('/api/llm/config', { method: 'POST', body: { provider: 'openai' } });
      if (restore.status !== 200) throw new Error(`restore ${restore.status}`);
      const testRestored = await request('/api/llm/test', { method: 'POST', body: {} });
      if (testRestored.json?.provider !== 'openai') throw new Error(`restore provider=${testRestored.json?.provider}`);
      return 'responses+anthropic+openai';
    });

    // -------------------- autocompletado ---------------------------
    const tomorrow = addDays(dateKeyOf(new Date().toISOString()), 1);
    await step('POST /api/agent/autocomplete propone campos validados sin guardar', async () => {
      const before = await request('/api/agenda?limit=500');
      const countBefore = before.json?.count ?? before.json?.items?.length ?? 0;
      const response = await request('/api/agent/autocomplete', {
        method: 'POST',
        body: { text: 'reunión con Ana mañana 10:00 45 min urgente para revisar la propuesta comercial' }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}: ${response.text.slice(0, 300)}`);
      const body = response.json;
      const fields = body.proposal || body.fields;
      if (!fields) throw new Error('sin propuesta');
      if (body.validated !== true) throw new Error('validated!=true');
      if (body.requiresConfirmation !== true) throw new Error('requiresConfirmation!=true');
      if (body.saved !== false) throw new Error('saved!=false');
      if (fields.type !== 'Reunión') throw new Error(`type=${fields.type}`);
      if (fields.durationMin !== 45) throw new Error(`durationMin=${fields.durationMin}`);
      if (fields.priority !== 'P1') throw new Error(`priority=${fields.priority}`);
      if (fields.date !== tomorrow) throw new Error(`date=${fields.date} esperado ${tomorrow}`);
      if (fields.time !== '10:00') throw new Error(`time=${fields.time}`);
      if (!fields.start) throw new Error('sin instante start');
      if (!fields.title.toLowerCase().includes('ana')) throw new Error(`title=${fields.title}`);
      // El mock simula el fallo real: attendees:["Ana"] (nombre sin email).
      // La propuesta no debe llevar nombres en attendees y no debe perderlos.
      if (fields.attendees !== undefined) throw new Error(`attendees inválidos en propuesta: ${JSON.stringify(fields.attendees)}`);
      const proposalText = `${fields.title} ${fields.notes}`.toLowerCase();
      if (!proposalText.includes('ana')) throw new Error('el nombre se perdió en la propuesta');
      if (!proposalText.includes('sin email')) throw new Error(`falta la nota de asistente sin email: ${fields.notes}`);
      if (body.suggestedRequest && 'attendees' in body.suggestedRequest) throw new Error('suggestedRequest incluye attendees sin email');
      if (body.source !== 'llm') throw new Error(`source=${body.source}`);
      if (body.fallback !== false) throw new Error('fallback!=false');
      const after = await request('/api/agenda?limit=500');
      const countAfter = after.json?.count ?? after.json?.items?.length ?? 0;
      if (countBefore !== countAfter) throw new Error(`se escribió en agenda (${countBefore}→${countAfter})`);
      return `type=${fields.type} priority=${fields.priority} dur=${fields.durationMin}`;
    });

    // ------------------ crear cita con el agente -------------------
    let createdId = null;
    await step("agente: 'agenda reunión con Ana mañana 10:00 45 min' crea la cita", async () => {
      const response = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'agenda reunión con Ana mañana 10:00 45 min', channel: 'web', userId: 'selftest' }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}: ${response.text.slice(0, 300)}`);
      const body = response.json;
      if (body.fallback !== false) throw new Error(`fallback=${body.fallback} error=${body.error}`);
      if (body.provider !== 'openai') throw new Error(`provider=${body.provider}`);
      if (!body.reply.includes('Agendado')) throw new Error(`reply=${body.reply.slice(0, 120)}`);
      if (/correo inválido/i.test(body.reply)) throw new Error(`regresión: ${body.reply.slice(0, 120)}`);
      const action = (body.actions || []).find((row) => row.type === 'create');
      if (!action || !action.agendaId) throw new Error(`actions=${JSON.stringify(body.actions)}`);
      createdId = action.agendaId;
      const fetched = await request(`/api/agenda/${createdId}`);
      const item = fetched.json?.item;
      if (!item) throw new Error(`no encontré ${createdId}`);
      if (item.type !== 'Reunión') throw new Error(`type=${item.type}`);
      if (!['P1', 'P2', 'P3'].includes(item.priority)) throw new Error(`priority=${item.priority}`);
      if (item.plannedMin !== 45) throw new Error(`plannedMin=${item.plannedMin}`);
      if (clockOf(item.start) !== '10:00') throw new Error(`hora=${clockOf(item.start)}`);
      if (dateKeyOf(item.start) !== tomorrow) throw new Error(`fecha=${dateKeyOf(item.start)}`);
      if (!item.score && item.score !== 0) throw new Error('sin score');
      // Nombre sin email: attendees debe quedar [] y el nombre conservado.
      if (!Array.isArray(item.attendees) || item.attendees.length !== 0) {
        throw new Error(`attendees debería ser []: ${JSON.stringify(item.attendees)}`);
      }
      const itemText = `${item.title} ${item.notes}`.toLowerCase();
      if (!itemText.includes('ana')) throw new Error('el nombre se perdió en título/notas');
      if (!itemText.includes('sin email')) throw new Error(`falta la nota de asistente sin email: ${item.notes}`);
      return `${createdId} ${item.type} ${item.priority} ${item.plannedMin}min · asistentes=[] · nombre en título/notas`;
    });

    // ------------- mover con confirmación explícita ----------------
    let pendingCode = null;
    await step("agente: 'muéveme la reunión de Ana a las 3' pide confirmación", async () => {
      const response = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'muéveme la reunión de Ana a las 3', channel: 'web', userId: 'selftest' }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const body = response.json;
      if (!body.pending) throw new Error(`sin pendiente: ${body.reply}`);
      if (body.pending.type !== 'confirm') throw new Error(`pending.type=${body.pending.type}`);
      if (body.pending.requiresConfirmation !== true) throw new Error('requiresConfirmation!=true');
      pendingCode = body.pending.confirmCode;
      if (!pendingCode) throw new Error('sin confirmCode utilizable');
      if (pendingCode === '«secreto»' || !/^[A-Za-z0-9_-]{6,}$/.test(pendingCode)) throw new Error(`confirmCode enmascarado: ${pendingCode}`);
      if (!/confirmas/i.test(body.reply)) throw new Error(`reply=${body.reply.slice(0, 140)}`);
      const fetched = await request(`/api/agenda/${createdId}`);
      if (clockOf(fetched.json.item.start) !== '10:00') throw new Error('se movió sin confirmar');
      return `confirmCode=${pendingCode.slice(0, 6)}…`;
    });

    await step("agente: 'sí' confirma y mueve a las 15:00", async () => {
      const response = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'sí', channel: 'web', userId: 'selftest' }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const body = response.json;
      if (body.pending) throw new Error('el pendiente no se limpió');
      if (!/movido/i.test(body.reply)) throw new Error(`reply=${body.reply.slice(0, 140)}`);
      const fetched = await request(`/api/agenda/${createdId}`);
      const clock = clockOf(fetched.json.item.start);
      if (clock !== '15:00') throw new Error(`hora tras mover=${clock}`);
      if (dateKeyOf(fetched.json.item.start) !== tomorrow) throw new Error('cambió de día');
      return `start=${clock}`;
    });

    await step('POST /api/agent/confirm confirma con el confirmCode (sin texto)', async () => {
      const ask = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'mueve la reunión de Ana a las 6 de la tarde', channel: 'web', userId: 'selftest' }
      });
      const code = ask.json?.pending?.confirmCode;
      if (!code) throw new Error(`sin confirmCode: ${ask.json?.reply}`);
      const confirmed = await request('/api/agent/confirm', {
        method: 'POST',
        body: { confirmCode: code, channel: 'web', userId: 'selftest' }
      });
      if (confirmed.status !== 200) throw new Error(`confirm status ${confirmed.status}`);
      if (confirmed.json?.pending) throw new Error('el pendiente no se limpió');
      const fetched = await request(`/api/agenda/${createdId}`);
      const clock = clockOf(fetched.json.item.start);
      if (clock !== '18:00') throw new Error(`hora=${clock}`);
      return `start=${clock}`;
    });

    // ------------------ comandos garantizados ----------------------
    await step("agente: 'HOY' responde determinista sin LLM", async () => {
      const response = await request('/api/agent/chat', { method: 'POST', body: { text: 'HOY', channel: 'web', userId: 'selftest' } });
      const body = response.json;
      if (body.fallback !== true) throw new Error(`fallback=${body.fallback}`);
      if (body.provider) throw new Error(`provider=${body.provider}`);
      if (!/AGENDA COPILOT|Pendientes/i.test(body.reply)) throw new Error(`reply=${body.reply.slice(0, 120)}`);
      return body.reply.split('\n')[0];
    });

    await step('agente: dryRun no escribe y devuelve acciones propuestas', async () => {
      const before = await request(`/api/agenda/${createdId}`);
      const response = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'cancela la reunión de Ana', channel: 'web', userId: 'selftest', dryRun: true }
      });
      const body = response.json;
      if (body.pending) throw new Error('dryRun no debe dejar pendiente');
      const action = (body.actions || []).find((row) => row.type === 'cancel');
      if (!action) throw new Error(`actions=${JSON.stringify(body.actions)}`);
      if (action.status !== 'planned') throw new Error(`status=${action.status}`);
      const after = await request(`/api/agenda/${createdId}`);
      if (after.json.item.status === 'Cancelada') throw new Error('dryRun canceló de verdad');
      if (before.json.item.status !== after.json.item.status) throw new Error('dryRun cambió el estado');
      return action.status;
    });

    // --------------- captura → convertir en cita -----------------
    let inboxId = null;
    let convertedId = null;
    await step('agente: CAPTURA + convertir en cita con confirmación', async () => {
      const capture = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'CAPTURA revisar propuesta comercial', channel: 'web', userId: 'tools' }
      });
      if (capture.status !== 200) throw new Error(`captura ${capture.status}`);
      const match = String(capture.json?.reply || '').match(/IN-\d{4}/);
      if (!match) throw new Error(`sin IN en: ${capture.json?.reply}`);
      inboxId = match[0];
      const ask = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: `convierte ${inboxId} en cita mañana a las 11`, channel: 'web', userId: 'tools' }
      });
      if (ask.json?.pending?.type !== 'confirm') throw new Error(`pending=${JSON.stringify(ask.json?.pending)} reply=${ask.json?.reply}`);
      const confirmed = await request('/api/agent/chat', { method: 'POST', body: { text: 'sí', channel: 'web', userId: 'tools' } });
      if (!/convertida/i.test(confirmed.json?.reply || '')) throw new Error(`reply=${String(confirmed.json?.reply).slice(0, 160)}`);
      const action = (confirmed.json?.actions || []).find((row) => row.type === 'convert');
      if (!action?.agendaId) throw new Error(`actions=${JSON.stringify(confirmed.json?.actions)}`);
      convertedId = action.agendaId;
      const inbox = await request(`/api/inbox/${inboxId}`);
      if (inbox.json?.item?.processed !== true) throw new Error('la captura no quedó processed');
      if (inbox.json?.item?.agendaId !== convertedId) throw new Error(`agendaId=${inbox.json?.item?.agendaId}`);
      const event = await request(`/api/agenda/${convertedId}`);
      if (clockOf(event.json.item.start) !== '11:00') throw new Error(`hora=${clockOf(event.json.item.start)}`);
      return `${inboxId}→${convertedId}`;
    });

    let routineId = null;
    await step('agente: crear rutina y pausarla con confirmación', async () => {
      const create = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'crea rutina de foco diaria a las 8:00 90 min', channel: 'web', userId: 'tools' }
      });
      if (!/Rutina creada/i.test(create.json?.reply || '')) throw new Error(`reply=${String(create.json?.reply).slice(0, 160)}`);
      const match = String(create.json?.reply || '').match(/R-\d{3,}/);
      if (!match) throw new Error('sin id de rutina');
      routineId = match[0];
      const list = await request('/api/routines?limit=200');
      const routine = (list.json?.items || []).find((row) => row.id === routineId);
      if (!routine) throw new Error('la rutina no aparece en /api/routines');
      if (routine.time !== '08:00' || routine.durationMin !== 90 || routine.active !== true) {
        throw new Error(`rutina=${JSON.stringify({ time: routine.time, durationMin: routine.durationMin, active: routine.active })}`);
      }
      const ask = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'pausa la rutina de foco', channel: 'web', userId: 'tools' }
      });
      if (ask.json?.pending?.type !== 'confirm') throw new Error(`pending=${JSON.stringify(ask.json?.pending)} reply=${ask.json?.reply}`);
      const confirmed = await request('/api/agent/chat', { method: 'POST', body: { text: 'sí', channel: 'web', userId: 'tools' } });
      if (confirmed.status !== 200) throw new Error(`confirm ${confirmed.status}`);
      const list2 = await request('/api/routines?limit=200');
      const routine2 = (list2.json?.items || []).find((row) => row.id === routineId);
      if (routine2?.active !== false) throw new Error(`active=${routine2?.active}`);
      return routineId;
    });

    await step('agente: completar una cita con confirmación', async () => {
      const ask = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: `marca como hecho ${createdId}`, channel: 'web', userId: 'tools' }
      });
      if (ask.json?.pending?.type !== 'confirm') throw new Error(`pending=${JSON.stringify(ask.json?.pending)} reply=${ask.json?.reply}`);
      const confirmed = await request('/api/agent/chat', { method: 'POST', body: { text: 'sí', channel: 'web', userId: 'tools' } });
      if (confirmed.status !== 200) throw new Error(`confirm ${confirmed.status}`);
      const event = await request(`/api/agenda/${createdId}`);
      if (event.json?.item?.status !== 'Hecho') throw new Error(`status=${event.json?.item?.status}`);
      return 'Hecho';
    });

    // --------------------- workflows LLM ---------------------------
    await step('workflow close usa el LLM (fallback=false)', async () => {
      const before = mock.calls().filter((call) => call.route === 'POST /v1/chat/completions').length;
      const response = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'close' } });
      if (response.status !== 200) throw new Error(`status ${response.status}: ${response.text.slice(0, 300)}`);
      const body = response.json;
      if (body.provider !== 'openai') throw new Error(`provider=${body.provider}`);
      if (body.fallback !== false) throw new Error(`fallback=${body.fallback} error=${body.error}`);
      if (!body.text || body.text.length < 10) throw new Error('texto vacío');
      const after = mock.calls().filter((call) => call.route === 'POST /v1/chat/completions').length;
      if (after <= before) throw new Error('el LLM no recibió la llamada del cierre');
      return body.text.slice(0, 60);
    });

    await step('workflow brief usa el LLM (fallback=false)', async () => {
      const response = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'brief' } });
      const body = response.json;
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      if (body.fallback !== false) throw new Error(`fallback=${body.fallback}`);
      if (!body.text) throw new Error('sin texto');
      return body.text.slice(0, 60);
    });

    await step('caché: la segunda llamada idéntica del brief se sirve de caché', async () => {
      const first = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'brief' } });
      const second = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'brief' } });
      if (first.status !== 200 || second.status !== 200) throw new Error('status');
      if (second.json?.cached !== true) throw new Error(`cached=${second.json?.cached}`);
      if (second.json?.fallback !== false) throw new Error('fallback en caché');
      return 'cached';
    });

    await step('GET /api/llm/usage refleja llamadas y tokens', async () => {
      const response = await request('/api/llm/usage?days=2');
      const body = response.json;
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      if (!(body.today.calls > 0)) throw new Error(`calls=${body.today.calls}`);
      if (!(body.today.tokens > 0)) throw new Error(`tokens=${body.today.tokens}`);
      if (!(body.byWorkflow.intent?.calls > 0)) throw new Error(`intent calls=${body.byWorkflow.intent?.calls}`);
      if (!(body.byWorkflow.close?.calls > 0)) throw new Error('close sin contador');
      if (!body.limits) throw new Error('sin límites');
      return `calls=${body.today.calls} tokens=${body.today.tokens}`;
    });

    await step('presupuesto: tope por workflow degrada con LLM_BUDGET_CALLS', async () => {
      const config = await request('/api/llm/config', { method: 'POST', body: { limits: { perWorkflow: { weekly: { calls: 0 } } } } });
      if (config.status !== 200) throw new Error(`config ${config.status}`);
      const workflow = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'weekly' } });
      if (workflow.json?.fallback !== true) throw new Error(`fallback=${workflow.json?.fallback}`);
      if (workflow.json?.errorCode !== 'LLM_BUDGET_CALLS') throw new Error(`code=${workflow.json?.errorCode}`);
      const restore = await request('/api/llm/config', { method: 'POST', body: { limits: { perWorkflow: { weekly: { calls: 1000 } } } } });
      if (restore.status !== 200) throw new Error(`restore ${restore.status}`);
      return 'budget ok';
    });

    // --------------------- kill-switch -----------------------------
    await step('kill-switch global degrada a determinista y se puede desactivar', async () => {
      const on = await request('/api/llm/config', { method: 'POST', body: { killSwitch: true } });
      if (on.status !== 200 || on.json?.config?.killSwitch !== true) throw new Error(`no se activó: ${on.status}`);
      const workflow = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'close' } });
      if (workflow.json?.fallback !== true) throw new Error(`fallback=${workflow.json?.fallback}`);
      if (workflow.json?.errorCode !== 'LLM_KILL_SWITCH') throw new Error(`errorCode=${workflow.json?.errorCode}`);
      const chat = await request('/api/agent/chat', { method: 'POST', body: { text: 'HOY', channel: 'web', userId: 'selftest' } });
      if (chat.status !== 200) throw new Error(`agente caído con kill-switch: ${chat.status}`);
      const off = await request('/api/llm/config', { method: 'POST', body: { killSwitch: false } });
      if (off.json?.config?.killSwitch !== false) throw new Error('no se desactivó');
      return 'on/off ok';
    });

    // ------------------ sin clave: la app sigue --------------------
    await step('sin clave la app funciona y lo reporta', async () => {
      const deleted = await request('/api/secrets/llm.openai.apiKey', { method: 'DELETE' });
      if (deleted.status !== 200) throw new Error(`DELETE status ${deleted.status}`);
      const status = await request('/api/llm/status?probe=1');
      if (status.json.configured !== false) throw new Error('configured=true tras borrar la clave');
      if (status.json.reachable !== false) throw new Error('reachable=true sin clave');
      if (status.json.openaiConfigured !== false) throw new Error('openaiConfigured=true sin clave');
      const test = await request('/api/llm/test', { method: 'POST', body: {} });
      if (test.json?.ok !== false) throw new Error('test ok sin clave');
      if (test.text.includes(secretKey)) throw new Error('fuga de clave');
      const chat = await request('/api/agent/chat', { method: 'POST', body: { text: 'HOY', channel: 'web', userId: 'selftest' } });
      if (chat.status !== 200) throw new Error(`agente caído sin clave: ${chat.status}`);
      const fallbackChat = await request('/api/llm/chat', { method: 'POST', body: { text: 'hola' } });
      if (fallbackChat.status !== 200 || fallbackChat.json?.fallback !== true) throw new Error(`chat sin clave: ${fallbackChat.status} ${JSON.stringify(fallbackChat.json)}`);
      const required = await request('/api/llm/chat', { method: 'POST', body: { text: 'hola', requireLlm: true } });
      if (required.status !== 503 || required.json?.code !== 'LLM_UNAVAILABLE') throw new Error(`requireLlm: ${required.status} ${required.json?.code}`);
      const workflow = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'close' } });
      if (workflow.json?.fallback !== true) throw new Error('close no degradó');
      if (!workflow.json?.text) throw new Error('sin texto de fallback');
      return `mode=${status.json.mode}`;
    });

    // ------------- sin LLM: parser determinista --------------------
    let localEventId = null;
    await step('sin LLM: el parser determinista crea la cita (fallback completo)', async () => {
      const response = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'agenda almuerzo con Luis mañana 12:30 30 min', channel: 'web', userId: 'localmode' }
      });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const body = response.json;
      if (body.fallback !== true) throw new Error(`fallback=${body.fallback}`);
      if (body.provider !== null) throw new Error(`provider=${body.provider}`);
      if (body.source !== 'deterministic') throw new Error(`source=${body.source}`);
      if (!/Agendado/i.test(body.reply)) throw new Error(`reply=${body.reply.slice(0, 140)}`);
      const action = (body.actions || []).find((row) => row.type === 'create');
      if (!action?.agendaId) throw new Error(`actions=${JSON.stringify(body.actions)}`);
      localEventId = action.agendaId;
      const fetched = await request(`/api/agenda/${localEventId}`);
      const item = fetched.json.item;
      if (item.plannedMin !== 30) throw new Error(`plannedMin=${item.plannedMin}`);
      if (clockOf(item.start) !== '12:30') throw new Error(`hora=${clockOf(item.start)}`);
      if (dateKeyOf(item.start) !== tomorrow) throw new Error(`fecha=${dateKeyOf(item.start)}`);
      return `${localEventId} 12:30 30min`;
    });

    await step('sin LLM: mover pide confirmación y se confirma con «sí»', async () => {
      const ask = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'muéveme el almuerzo con Luis a la 1', channel: 'web', userId: 'localmode' }
      });
      if (ask.json?.pending?.type !== 'confirm') throw new Error(`pending=${JSON.stringify(ask.json?.pending)} reply=${ask.json?.reply}`);
      if (ask.json?.fallback !== true) throw new Error('fallback!=true');
      const confirmed = await request('/api/agent/chat', {
        method: 'POST',
        body: { text: 'sí', channel: 'web', userId: 'localmode' }
      });
      if (!/movido/i.test(confirmed.json?.reply || '')) throw new Error(`reply=${confirmed.json?.reply}`);
      const fetched = await request(`/api/agenda/${localEventId}`);
      if (clockOf(fetched.json.item.start) !== '13:00') throw new Error(`hora=${clockOf(fetched.json.item.start)}`);
      return '13:00';
    });

    await step('sin LLM: CIERRE y SEMANA siguen siendo deterministas', async () => {
      const cierre = await request('/api/agent/chat', { method: 'POST', body: { text: 'CIERRE', channel: 'web', userId: 'localmode' } });
      if (!/CIERRE/i.test(cierre.json?.reply || '')) throw new Error(`cierre=${cierre.json?.reply?.slice(0, 100)}`);
      const semana = await request('/api/agent/chat', { method: 'POST', body: { text: 'SEMANA', channel: 'web', userId: 'localmode' } });
      if (!/SEMANA|Reporte|REPORTE/i.test(semana.json?.reply || '')) throw new Error(`semana=${semana.json?.reply?.slice(0, 100)}`);
      const weekly = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'weekly' } });
      if (weekly.json?.fallback !== true) throw new Error('weekly no degradó');
      if (!weekly.json?.text) throw new Error('weekly sin texto determinista');
      return 'determinista ok';
    });

    // ------------------- cascada a Ollama --------------------------
    await step('cascada: sin API usa Ollama local (mock) y luego determinista', async () => {
      const enable = await request('/api/llm/config', {
        method: 'POST',
        body: { ollamaEnabled: true, ollamaUrl: mock.url, ollamaModel: 'mock-ollama:3b' }
      });
      if (enable.status !== 200) throw new Error(`config status ${enable.status}: ${enable.text.slice(0, 200)}`);
      const status = await request('/api/llm/status?probe=1');
      if (status.json.reachable !== true) throw new Error(`ollama no reachable: ${status.json.lastError}`);
      if (status.json.provider !== 'ollama') throw new Error(`provider=${status.json.provider}`);
      const workflow = await request('/api/llm/workflow', { method: 'POST', body: { workflow: 'close' } });
      if (workflow.json?.provider !== 'ollama') throw new Error(`provider=${workflow.json?.provider}`);
      if (workflow.json?.fallback !== false) throw new Error('ollama no respondió');
      const disable = await request('/api/llm/config', { method: 'POST', body: { ollamaEnabled: false } });
      if (disable.status !== 200) throw new Error('no se pudo apagar Ollama');
      const after = await request('/api/llm/status?probe=1');
      if (after.json.reachable !== false) throw new Error('ollama sigue reachable tras apagarlo');
      return 'api→ollama→determinista';
    });

    // ------------------------- memoria -----------------------------
    await step('memoria: historial visible y aislado por canal/usuario', async () => {
      const list = await request('/api/agent/conversations?limit=20');
      const key = (list.json?.items || []).find((row) => row.key === 'web:selftest');
      if (!key) throw new Error(`conversación web:selftest ausente: ${JSON.stringify(list.json?.items?.map((row) => row.key))}`);
      const history = await request('/api/agent/conversations/web%3Aselftest?limit=20');
      const messages = history.json?.messages || [];
      if (!messages.length) throw new Error('sin mensajes');
      if (messages.length > 12) throw new Error(`memoria sin recorte: ${messages.length}`);
      if (!messages.some((message) => message.role === 'assistant')) throw new Error('sin respuestas del agente');
      const other = await request('/api/agent/conversations/web%3Aotro');
      if ((other.json?.messages || []).length !== 0) throw new Error('la memoria no está aislada por usuario');
      const actions = await request('/api/agent/actions?limit=50');
      if (!(actions.json?.items || []).length) throw new Error('sin registro de acciones');
      return `mensajes=${messages.length} acciones=${actions.json.items.length}`;
    });

    // ---------------------- validaciones ---------------------------
    await step('validaciones 400: REQUIRED, INVALID_TYPE y UNKNOWN_FIELD', async () => {
      const empty = await request('/api/agent/chat', { method: 'POST', body: {} });
      if (empty.status !== 400 || empty.json?.code !== 'REQUIRED') throw new Error(`vacío → ${empty.status} ${empty.json?.code}`);
      const unknown = await request('/api/agent/chat', { method: 'POST', body: { text: 'HOY', foo: 1 } });
      if (unknown.status !== 400 || unknown.json?.code !== 'UNKNOWN_FIELD') throw new Error(`desconocido → ${unknown.status} ${unknown.json?.code}`);
      const badMessages = await request('/api/llm/chat', { method: 'POST', body: { messages: [] } });
      if (badMessages.status !== 400) throw new Error(`messages=[] → ${badMessages.status}`);
      const badConfig = await request('/api/llm/config', { method: 'POST', body: { baseUrl: 'javascript:alert(1)' } });
      if (badConfig.status !== 400 || badConfig.json?.code !== 'INVALID_URL') throw new Error(`baseUrl inválida → ${badConfig.status} ${badConfig.json?.code}`);
      const badProfile = await request('/api/llm/chat', { method: 'POST', body: { text: 'hola', profile: 'inventado' } });
      if (badProfile.status !== 400) throw new Error(`profile inválido → ${badProfile.status}`);
      return '400 ok';
    });

    // --------------------- fuga de secretos ------------------------
    await step('ninguna clave aparece en respuestas ni en logs', () => {
      const bodyText = responses.map((row) => row.text).join('\n');
      if (bodyText.includes(secretKey)) throw new Error('la clave apareció en una respuesta HTTP');
      if (stdout.includes(secretKey)) throw new Error('la clave apareció en stdout');
      if (stderr.includes(secretKey)) throw new Error('la clave apareció en stderr');
      const status = responses.find((row) => row.pathname.startsWith('/api/llm/status'));
      if (status && /"apiKey"\s*:/.test(status.text)) throw new Error('status expone apiKey');
      return '0 fugas';
    });
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await delay(300);
    try { await mock.close(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const ok = failures.length === 0;
  const summary = {
    ok,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
    checks: results,
    logTail: { stdout: stdout.slice(-1_500), stderr: stderr.slice(-1_500) }
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
}

await main();
