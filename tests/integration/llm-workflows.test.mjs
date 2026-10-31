/**
 * Tests de integración del agente LLM (mock OpenAI-compatible), presupuesto,
 * kill-switch, workflows (idempotencia/catch-up) y señales (disparo/cooldown).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api, waitFor } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-llm-');
const { createMockLlmServer } = await importLib('lib/llm/mock-server.mjs');
const { store } = await importLib('lib/store.mjs');
const engine = await importLib('lib/agenda/index.mjs');
const workflows = await importLib('lib/workflows/scheduler.mjs');
const signalsEngine = await importLib('lib/signals/engine.mjs');

const mockLlm = await createMockLlmServer();
const app = await startTestApp();

test.after(async () => {
  await app.close();
  await mockLlm.close();
});

const API_KEY = 'sk-qa-mock-1234567890';

test('sin clave LLM la app responde en modo determinista', async () => {
  const status = await api(app.base, 'GET', '/api/llm/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.configured, false);
  const chat = await api(app.base, 'POST', '/api/agent/chat', { text: 'HOY' });
  assert.equal(chat.status, 200, chat.text);
  assert.ok(String(chat.json.reply || chat.json.text || '').includes('AGENDA COPILOT'), chat.text.slice(0, 200));
});

test('agente con proveedor mockeado: crear cita interpretando lenguaje natural', async () => {
  const configured = await api(app.base, 'POST', '/api/llm/config', {
    provider: 'openai',
    baseUrl: `${mockLlm.url}/v1`,
    model: 'mock-agenda-1',
    apiKey: API_KEY
  });
  assert.equal(configured.status, 200, configured.text);

  const probe = await api(app.base, 'GET', '/api/llm/status?probe=1');
  assert.equal(probe.json.configured, true);
  assert.equal(probe.json.reachable, true, probe.text.slice(0, 300));

  const chat = await api(app.base, 'POST', '/api/agent/chat', { text: 'Agenda reunión con Ana mañana a las 10 por 45 minutos' });
  assert.equal(chat.status, 200, chat.text);
  const payload = chat.json;
  assert.ok(String(payload.reply || '').length > 10, payload.reply);
  const agenda = store.get().agenda;
  const created = agenda.find((event) => /Ana/.test(String(event.title)) && event.start.includes('T10:00'));
  assert.ok(created, `no se creó la cita: ${agenda.slice(-3).map((event) => `${event.title}@${event.start}`).join(' | ')}`);
  assert.ok(Array.isArray(created.attendees), 'attendees debe ser array');
  assert.equal(created.attendees.length, 0, 'un nombre no debe viajar como attendee');
  assert.ok(!/Correo inválido/i.test(JSON.stringify(payload)), 'no debe haber error de correo');
});

test('kill-switch y presupuesto degradan sin romper (fallback determinista)', async () => {
  let response = await api(app.base, 'POST', '/api/llm/config', { killSwitch: true });
  assert.equal(response.status, 200, response.text);
  const killed = await api(app.base, 'POST', '/api/llm/chat', { text: 'Hola' });
  assert.equal(killed.status, 200, killed.text);
  assert.equal(killed.json.fallback, true, killed.text.slice(0, 300));
  assert.equal(killed.json.errorCode, 'LLM_KILL_SWITCH');

  response = await api(app.base, 'POST', '/api/llm/config', { killSwitch: false, limits: { dailyCalls: 0 } });
  assert.equal(response.status, 200, response.text);
  const budget = await api(app.base, 'POST', '/api/llm/chat', { text: 'Hola otra vez' });
  assert.equal(budget.status, 200, budget.text);
  assert.equal(budget.json.fallback, true, budget.text.slice(0, 300));
  assert.match(String(budget.json.errorCode || ''), /LLM_BUDGET_CALLS|LLM_RATE_LIMITED/);

  const usage = await api(app.base, 'GET', '/api/llm/usage?days=1');
  assert.equal(usage.status, 200);
  assert.ok(usage.json && typeof usage.json === 'object');

  await api(app.base, 'POST', '/api/llm/config', { killSwitch: false, limits: { dailyCalls: 500 } });
});

test('workflows: seed con días en español, scheduler apagado y tick idempotente', async () => {
  await workflows.ensureSeededNow();
  const data = store.get();
  assert.ok(Array.isArray(data.workflows) && data.workflows.length >= 8, `workflows=${data.workflows?.length}`);
  const weekly = data.workflows.find((workflow) => workflow.id === 'WF-WEEKLY');
  assert.deepEqual(weekly.trigger.weekdays, ['VIE'], 'WF-WEEKLY debe usar VIE');
  assert.equal(workflows.schedulerStatus().started, false, 'el scheduler no debe arrancar con WORKFLOWS_AUTOSTART=0');

  let friday = engine.addDaysKey(new Date().toISOString().slice(0, 10), 0);
  for (let index = 0; index < 8; index += 1) {
    if (engine.weekdayCodeOfKey(friday) === 'VIE') break;
    friday = engine.addDaysKey(friday, 1);
  }
  const now = new Date(`${friday}T17:46:00-05:00`);

  const first = await workflows.workflowTick({ now, includeSignals: false });
  assert.equal(first.ok, true);
  const runsAfterFirst = (store.get().workflowRuns || []).filter((run) => run.workflowId === 'WF-WEEKLY');
  assert.equal(runsAfterFirst.length, 1, `runs=${runsAfterFirst.length}`);
  assert.match(runsAfterFirst[0].windowKey, new RegExp(`WF-WEEKLY:${friday}`));

  const second = await workflows.workflowTick({ now, includeSignals: false });
  assert.equal(second.ok, true);
  const runsAfterSecond = (store.get().workflowRuns || []).filter((run) => run.workflowId === 'WF-WEEKLY');
  assert.equal(runsAfterSecond.length, 1, 'el mismo tick no debe repetir la ventana');
});

test('workflows: catch-up de un job perdido se ejecuta una sola vez', async () => {
  await workflows.ensureSeededNow();
  const oldTick = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
  await store.mutate((data) => {
    data.workflowsMeta = { ...(data.workflowsMeta || {}), lastTickAt: oldTick };
    data.workflowRuns = (data.workflowRuns || []).filter((run) => !String(run.workflowId).startsWith('WF-BRIEF') && !String(run.workflowId).startsWith('WF-CLOSE'));
  });
  const now = new Date();
  const first = await workflows.workflowTick({ now, includeSignals: false });
  assert.equal(first.ok, true);
  const briefingRuns = () => (store.get().workflowRuns || []).filter((run) => String(run.workflowId).startsWith('WF-BRIEF'));
  const afterCatchUp = briefingRuns().length;
  const second = await workflows.workflowTick({ now, includeSignals: false });
  assert.equal(second.ok, true);
  assert.equal(briefingRuns().length, afterCatchUp, 'el catch-up no debe repetirse en el tick siguiente');
  const windowKeys = briefingRuns().map((run) => run.windowKey);
  assert.equal(new Set(windowKeys).size, windowKeys.length, 'ventanas duplicadas en catch-up');
});

test('señales: dry-run detecta, la emisión real dispara y respeta cooldown', async () => {
  await signalsEngine.ensureSignalsSeeded();
  // Ventana ampliada en el fixture para que el test sea determinista a
  // cualquier hora del día (la ventana real 12:00–20:00 haría el test
  // dependiente de la hora a la que se ejecute la suite).
  await store.mutate((data) => {
    const rule = (data.signalRules || []).find((item) => item.id === 'SIG-FOCUS-LOW');
    if (rule) rule.window = { from: '00:00', to: '23:59' };
  });
  const now = new Date();
  const dry = await signalsEngine.evaluateSignals({ now, dryRun: true, types: ['focus_low'], useLlm: false });
  assert.ok(Array.isArray(dry.candidates) && dry.candidates.length > 0, 'dry-run sin candidatos');
  assert.ok(dry.candidates.some((candidate) => candidate.status === 'would-emit' && candidate.ruleId === 'SIG-FOCUS-LOW'), JSON.stringify(dry.candidates));

  const signalsBefore = (store.get().signals || []).length;
  const real = await signalsEngine.evaluateSignals({ now, dryRun: false, types: ['focus_low'], useLlm: false, notify: false });
  assert.ok(real.emitted >= 1, `emitted=${real.emitted}`);
  assert.ok((store.get().signals || []).length > signalsBefore);

  const repeat = await signalsEngine.evaluateSignals({ now, dryRun: false, types: ['focus_low'], useLlm: false, notify: false });
  assert.equal(repeat.emitted, 0, 'el cooldown debe impedir una segunda emisión');
  assert.ok(repeat.candidates.some((candidate) => candidate.status === 'cooldown'), JSON.stringify(repeat.candidates));
});
