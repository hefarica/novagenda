/**
 * Autocheck del motor de avisos inteligentes (t16).
 *
 * Ejecuta:  node lib/nudges/selfcheck.mjs
 *
 * - Usa un DATA_DIR temporal (nunca toca datos reales).
 * - No envía mensajes reales: canales desactivados y `deliver` falso.
 * - Verifica también el hook del scheduler de t8 (paridad, aislamiento,
 *   timeout de 5 s, registro idempotente y dry-run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (relative) => import(pathToFileURL(path.join(HERE, relative)).href);

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-nudges-selfcheck-'));
process.env.DATA_DIR = DATA_DIR;
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.NODE_ENV = 'test';
process.env.WA_ENABLED = 'false';
process.env.TELEGRAM_ENABLED = 'false';
process.env.EMAIL_ENABLED = 'false';
process.env.LLM_OLLAMA_ENABLED = 'false';
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.OPENAI_MODEL;
delete process.env.LLM_PROVIDER;

const { store } = await load('../store.mjs');
const scheduler = await load('../workflows/scheduler.mjs');
const time = await load('../agenda/time.mjs');
const engine = await load('./engine.mjs');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

function tzOf() {
  return time.timezoneOf(store.get().settings || {});
}

const TEST_DATE = '2026-10-27';

function at(hhmm, dateKey = TEST_DATE) {
  return new Date(time.isoAtLocal(dateKey, hhmm, tzOf()));
}

async function prepare(config = {}) {
  await store.reset();
  await engine.updateConfig({
    enabled: true,
    llmEnabled: false,
    silence: { enabled: false, from: '21:30', to: '07:00' },
    channels: [],
    maxPerHour: 2,
    maxPerDay: 8,
    cooldownMin: 90,
    maxItems: 3,
    dedupeTtlMin: 360,
    reportAt: '23:59',
    closeCheckAt: '23:59',
    ...config
  });
}

async function setAgenda(events) {
  await store.mutate((data) => { data.agenda = events; data.inbox = []; });
}

function overdueEvent(id, due = '2026-10-26') {
  return {
    id,
    title: `Vencida ${id}`,
    start: time.isoAtLocal(due, '09:00', tzOf()),
    end: time.isoAtLocal(due, '10:00', tzOf()),
    type: 'Tarea',
    status: 'Pendiente',
    due,
    priority: 'P2',
    impact: 3,
    urgency: 3,
    energy: 'Media',
    deepFocus: false,
    reminderMin: 10,
    plannedMin: 60,
    actualMin: 0
  };
}

function stableJobs(tickResult) {
  return JSON.stringify((tickResult.jobs || []).map((job) => ({
    workflowId: job.workflowId,
    status: job.status,
    skipped: job.skipped === true,
    reason: job.reason || null,
    windowKey: job.windowKey || null
  })));
}

/* ------------------------------------------------------------------ */
/* 1. Hook del scheduler: idempotencia, paridad, aislamiento y timeout */
/* ------------------------------------------------------------------ */

{
  let calls = 0;
  const noop = () => { calls += 1; };
  await prepare();
  await scheduler.ensureSeededNow();
  await scheduler.workflowTick({ now: at('10:00'), includeSignals: false });

  const unregisterA = scheduler.registerTickHandler(noop);
  const unregisterB = scheduler.registerTickHandler(noop);
  const tick = await scheduler.workflowTick({ now: at('10:01'), includeSignals: false });
  check('hook: registro idempotente (una sola llamada)', calls === 1 && tick.handlers?.length === 1,
    `calls=${calls} handlers=${tick.handlers?.length}`);
  unregisterA();
  const afterA = await scheduler.workflowTick({ now: at('10:02'), includeSignals: false });
  check('hook: unregister quita el handler', afterA.handlers === undefined && calls === 1);
  unregisterA();
  unregisterB();
  const afterB = await scheduler.workflowTick({ now: at('10:03'), includeSignals: false });
  check('hook: unregister idempotente', afterB.handlers === undefined && calls === 1);

  // Paridad: mismo tick con y sin handler (solo difiere la clave `handlers`).
  await prepare();
  await scheduler.ensureSeededNow();
  const without = await scheduler.workflowTick({ now: at('10:00'), includeSignals: false });
  await prepare();
  await scheduler.ensureSeededNow();
  const unregisterParity = scheduler.registerTickHandler(() => {});
  const withHandler = await scheduler.workflowTick({ now: at('10:00'), includeSignals: false });
  unregisterParity();
  check('hook: tick sin handlers es idéntico (paridad)',
    stableJobs(without) === stableJobs(withHandler)
      && !Object.prototype.hasOwnProperty.call(without, 'handlers')
      && Array.isArray(withHandler.handlers),
    `jobs=${without.jobs?.length}`);

  // Un handler que lanza no rompe el tick ni los workflows.
  await prepare();
  await scheduler.ensureSeededNow();
  const unregisterThrowing = scheduler.registerTickHandler(() => { throw new Error('boom de prueba'); });
  const throwTick = await scheduler.workflowTick({ now: at('10:00'), includeSignals: false });
  unregisterThrowing();
  check('hook: handler que lanza no rompe el tick',
    throwTick.ok === true && throwTick.handlers?.[0]?.ok === false && (throwTick.jobs || []).length > 0,
    `handlerError=${throwTick.handlers?.[0]?.error}`);

  // Un handler lento se corta a los 5 s.
  await prepare();
  await scheduler.ensureSeededNow();
  const unregisterSlow = scheduler.registerTickHandler(() => new Promise((resolve) => setTimeout(resolve, 6500)));
  const slowStart = Date.now();
  const slowTick = await scheduler.workflowTick({ now: at('10:00'), includeSignals: false });
  const slowElapsed = Date.now() - slowStart;
  unregisterSlow();
  check('hook: handler lento se corta a 5 s',
    slowTick.ok === true
      && slowTick.handlers?.[0]?.ok === false
      && slowTick.handlers?.[0]?.code === 'TICK_HANDLER_TIMEOUT'
      && slowElapsed >= 4500 && slowElapsed <= 7500,
    `elapsed=${slowElapsed}ms`);
}

/* ------------------------------------------------------------------ */
/* 2. Dry-run priorizado, sin enviar ni mutar                          */
/* ------------------------------------------------------------------ */

{
  await prepare({ cooldownMin: 0, dedupeTtlMin: 0, maxItems: 3 });
  await setAgenda([overdueEvent('AG-OVERDUE')]);
  await store.mutate((data) => {
    data.inbox = [{ id: 'IN-1', capturedAt: new Date().toISOString(), source: 'test', type: 'Idea', input: 'Pendiente sin fecha', actionable: true, processed: false, priority: 'P2' }];
  });
  const before = JSON.stringify(store.get());
  let deliverCalls = 0;
  const fakeDeliver = async () => { deliverCalls += 1; return [{ channel: 'telegram', ok: true, id: 'fake' }]; };
  const result = await engine.evaluateNudges({ now: at('10:00'), dryRun: true, force: true, deliver: fakeDeliver });
  const after = JSON.stringify(store.get());
  const items = result.nudges?.[0]?.items || [];
  check('evaluate dry-run devuelve aviso priorizado sin enviar',
    result.ok === true && result.dryRun === true && result.nudges?.length === 1
      && items.length <= 3 && items[0]?.type === 'overdue' && result.nudges[0].dryRun === true,
    `items=${items.map((item) => item.type).join(',')}`);
  check('dry-run no muta el store ni llama a deliver', before === after && deliverCalls === 0);
}

/* ------------------------------------------------------------------ */
/* 3. Cooldown y descarte                                              */
/* ------------------------------------------------------------------ */

{
  await prepare({ cooldownMin: 90, dedupeTtlMin: 360, maxItems: 3 });
  await setAgenda([overdueEvent('AG-COOL')]);
  const first = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true });
  const second = await engine.evaluateNudges({ now: at('10:05'), dryRun: false, force: true });
  check('cooldown: dos evaluaciones seguidas no repiten el aviso',
    first.nudges?.length === 1 && (second.nudges?.length || 0) === 0,
    `secondSkipped=${second.skipped}`);

  await prepare({ cooldownMin: 0, dedupeTtlMin: 0, maxItems: 3 });
  await setAgenda([overdueEvent('AG-DISMISS')]);
  const emitted = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true });
  const dismissTarget = emitted.nudges?.[0]?.id;
  const dismissed = await engine.dismissNudge(dismissTarget);
  const third = await engine.evaluateNudges({ now: at('10:02'), dryRun: false, force: true });
  check('dismiss excluye el aviso en la siguiente evaluación',
    dismissed?.dismissed === true && (third.nudges?.length || 0) === 0,
    `id=${dismissTarget} skipped=${third.skipped}`);
  const feed = engine.listFeed({ limit: 10, includeDismissed: true });
  const hidden = engine.listFeed({ limit: 10 });
  check('feed conserva el descartado pero lo oculta por defecto',
    feed.items.some((item) => item.id === dismissTarget && item.dismissed === true)
      && !hidden.items.some((item) => item.id === dismissTarget));
}

/* ------------------------------------------------------------------ */
/* 4. Límites por hora y por día                                       */
/* ------------------------------------------------------------------ */

{
  await prepare({ cooldownMin: 0, dedupeTtlMin: 0, maxItems: 1, maxPerHour: 2, maxPerDay: 10 });
  const emittedIds = [];
  let third = null;
  for (const id of ['AG-H1', 'AG-H2', 'AG-H3']) {
    await setAgenda([overdueEvent(id)]);
    const result = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true });
    if (result.nudges?.length) emittedIds.push(id);
    else third = result;
  }
  check('máximo 2 avisos por hora', emittedIds.length === 2 && third?.skipped === 'max-per-hour',
    `emitidos=${emittedIds.length} third=${third?.skipped}`);

  await prepare({ cooldownMin: 0, dedupeTtlMin: 0, maxItems: 1, maxPerHour: 5, maxPerDay: 1 });
  await setAgenda([overdueEvent('AG-D1')]);
  const dayFirst = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true });
  await setAgenda([overdueEvent('AG-D2')]);
  const daySecond = await engine.evaluateNudges({ now: at('10:01'), dryRun: false, force: true });
  check('máximo diario configurable', dayFirst.nudges?.length === 1 && daySecond.skipped === 'max-per-day',
    `second=${daySecond.skipped}`);
}

/* ------------------------------------------------------------------ */
/* 5. Silencio nocturno                                                */
/* ------------------------------------------------------------------ */

{
  await prepare({ silence: { enabled: true, from: '21:30', to: '07:00' } });
  await setAgenda([overdueEvent('AG-NIGHT')]);
  const before = JSON.stringify(store.get());
  const night = await engine.evaluateNudges({ now: at('23:00'), dryRun: true, force: true });
  const after = JSON.stringify(store.get());
  check('de noche no genera avisos', night.skipped === 'silence' && (night.nudges?.length || 0) === 0 && before === after,
    `skipped=${night.skipped}`);
}

/* ------------------------------------------------------------------ */
/* 6. Sin canales configurados no intenta enviar                       */
/* ------------------------------------------------------------------ */

{
  await prepare({ cooldownMin: 0, dedupeTtlMin: 0 });
  await setAgenda([overdueEvent('AG-NOCH')]);
  let deliverCalls = 0;
  const fakeDeliver = async () => { deliverCalls += 1; return [{ channel: 'telegram', ok: true, id: 'fake' }]; };
  const result = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true, deliver: fakeDeliver });
  const delivery = result.nudges?.[0]?.delivery;
  check('sin canales no se intenta enviar',
    delivery?.attempted === false && delivery?.reason === 'no-channels' && deliverCalls === 0,
    `reason=${delivery?.reason}`);
}

/* ------------------------------------------------------------------ */
/* 7. Reporte diario                                                   */
/* ------------------------------------------------------------------ */

{
  await prepare({ reportAt: '00:00', cooldownMin: 0 });
  await setAgenda([]);
  const result = await engine.evaluateNudges({ now: at('10:00'), dryRun: false, force: true });
  const report = engine.getDailyReport(TEST_DATE);
  check('reporte diario generado al cierre',
    result.dailyReport?.kind === 'daily_report' && report?.text && /Hoy/.test(report.text),
    `report=${report?.text?.slice(0, 60)}`);
}

/* ------------------------------------------------------------------ */
/* 8. Integración real con el tick + dryRun propagado                  */
/* ------------------------------------------------------------------ */

{
  await prepare({ cooldownMin: 0, dedupeTtlMin: 0, maxItems: 1 });
  await setAgenda([overdueEvent('AG-TICK')]);
  await scheduler.ensureSeededNow();
  const handler = ({ now, dryRun }) => engine.nudgesTick({ now, dryRun });
  const unregister = scheduler.registerTickHandler(handler);

  const before = JSON.stringify(store.get());
  const dryTick = await scheduler.workflowTick({ now: at('10:00'), dryRun: true, includeSignals: false });
  const afterDry = JSON.stringify(store.get());
  const dryHandler = dryTick.handlers?.[0];
  check('nudges en tick dryRun no envían ni mutan',
    dryHandler?.ok === true && dryHandler.result?.dryRun === true && before === afterDry,
    `dryRun=${dryHandler?.result?.dryRun} skipped=${dryHandler?.result?.skipped}`);

  const realTick = await scheduler.workflowTick({ now: at('10:01'), includeSignals: false });
  const realHandler = realTick.handlers?.[0];
  const feed = engine.listFeed({ limit: 10 });
  check('nudges se ejecutan dentro del tick real y quedan en el feed',
    realHandler?.ok === true && realHandler.result?.nudges?.length === 1
      && feed.items.some((item) => item.kind === 'nudge'),
    `nudges=${realHandler?.result?.nudges?.length} feed=${feed.total}`);
  unregister();
}

/* ------------------------------------------------------------------ */

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter((entry) => !entry.pass);
console.log(`\nAUTOCHECK t16: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
  process.exitCode = 1;
}
