/**
 * Ejecutor de acciones de un workflow.
 *
 * Es deliberadamente defensivo: cada acción se aísla en try/catch, los datos
 * corruptos (una cita con `start` inválido) se ignoran, y el resultado queda
 * como pasos auditables (`steps`) con texto, entrega y consumo LLM.
 *
 * `dryRun: true` NO escribe en el store, NO envía mensajes y NO llama a Google:
 * solo describe lo que haría.
 */
import { store } from '../store.mjs';
import { log, logError } from '../http/logger.mjs';
import { materializeRoutines } from '../assistant.mjs';
import { reconcileGoogle } from '../google.mjs';
import { snapshotDailyMetrics } from '../metrics/metrics.mjs';
import {
  claimNotificationKey, hasNotificationKey, legacyDailyKey, nowIso
} from './state.mjs';
import { buildTemplateMessage, reminderMessage } from './messages.mjs';
import { deliverNotification } from './notify.mjs';
import { emptyUsage, enrichWorkflowText } from './llm.mjs';
import { localParts, workflowTimezone } from './time.mjs';

const REMINDER_GRACE_MS = 60_000;

function errorText(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 400);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`Tiempo máximo excedido en ${label} (${ms} ms)`), { code: 'WORKFLOW_TIMEOUT' }));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function clampReminder(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1440, Math.max(0, Math.round(number)));
}

/**
 * Envía los recordatorios de citas que vencen en esta ventana.
 * Usa las MISMAS claves históricas de `notificationLog` (`<eventId>:<ISO start>`)
 * para que una instalación existente no reenvíe nada al actualizar.
 *
 * @param {{now?:Date, dryRun?:boolean}} [options]
 */
export async function runReminders(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dryRun = options.dryRun === true;
  const nowMs = now.getTime();
  const data = store.get();
  const planned = [];
  const sent = [];
  const errors = [];
  const events = Array.isArray(data.agenda) ? [...data.agenda] : [];

  for (const event of events) {
    try {
      if (!event || typeof event !== 'object') continue;
      if (event.status === 'Hecho' || event.status === 'Cancelada') continue;
      const startMs = Date.parse(event.start);
      if (!Number.isFinite(startMs)) {
        log('warn', `Recordatorio omitido: start inválido en ${event.id || 'evento sin id'}`);
        continue;
      }
      const reminderMin = clampReminder(event.reminderMin ?? data.settings?.reminderMin ?? 10);
      const remindAt = startMs - reminderMin * 60_000;
      if (!(nowMs >= remindAt && nowMs < startMs + REMINDER_GRACE_MS)) continue;
      const key = `${event.id || 'sin-id'}:${new Date(startMs).toISOString()}`;
      if (hasNotificationKey(data, key)) continue;
      const message = reminderMessage(event, reminderMin);
      if (dryRun) {
        planned.push({ key, eventId: event.id || null, title: event.title || null, text: message.text });
        continue;
      }
      let claimed = false;
      await store.mutate((current) => {
        claimed = claimNotificationKey(current, key, nowIso());
      }, { label: 'recordatorio' }).catch((error) => {
        errors.push({ stage: 'claim', eventId: event.id || null, error: errorText(error) });
      });
      if (!claimed) continue;
      const delivered = await deliverNotification(message.text, {
        subject: message.subject,
        channels: []
      });
      if (delivered.error) {
        errors.push({ stage: 'send', eventId: event.id || null, error: delivered.error });
      }
      sent.push({ key, eventId: event.id || null, title: event.title || null, delivery: delivered.results });
    } catch (error) {
      logError('workflow:reminder', error, { eventId: event?.id });
      errors.push({ stage: 'event', eventId: event?.id || null, error: errorText(error) });
    }
  }

  return { planned, sent, errors, checked: events.length };
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

async function actionNotify(workflow, action, context) {
  const now = context.now;
  const template = String(action.template || 'custom');
  const built = buildTemplateMessage(template, {
    now,
    sinceIso: context.sinceIso,
    customText: action.text
  });
  const text = String(built.text || '').trim();
  const subject = action.subject || workflow.subject || built.subject || 'Agenda Copilot — aviso';

  if (!text) {
    return { step: { name: 'notify', template, ok: true, skipped: true, reason: 'empty-message' } };
  }
  const notifyWhenEmpty = workflow.conditions?.notifyWhenEmpty !== false;
  if (built.empty && !notifyWhenEmpty) {
    return { step: { name: 'notify', template, ok: true, skipped: true, reason: 'empty-changes' } };
  }

  const scheduled = context.reason !== 'manual';
  const compatKey = scheduled ? legacyDailyKey(workflow, context.dateKey) : null;
  if (compatKey && hasNotificationKey(store.get(), compatKey)) {
    return {
      step: {
        name: 'notify', template, ok: true, skipped: true, reason: 'already-notified',
        compatKey
      }
    };
  }

  let llmInfo = null;
  let finalText = text;
  if (built.llmProfile && !context.dryRun) {
    llmInfo = await enrichWorkflowText({
      workflow,
      profile: action.llmProfile || workflow.llm?.profile || built.llmProfile,
      input: built.llmInput,
      legacyText: text,
      deadlineMs: workflow.llm?.deadlineMs
    });
    if (llmInfo.used) {
      finalText = built.compose === 'detail_then_summary' && llmInfo.text !== text
        ? `${text}\n\n${llmInfo.text}`.slice(0, 1800)
        : llmInfo.text;
    }
  }

  if (context.dryRun) {
    return {
      step: {
        name: 'notify', template, ok: true, dryRun: true, subject, text: finalText,
        chars: finalText.length,
        channels: Array.isArray(workflow.channels) && workflow.channels.length ? workflow.channels : ['whatsapp', 'telegram', 'email'],
        llm: llmInfo
      },
      text: finalText,
      llm: llmInfo,
      delivery: []
    };
  }

  if (compatKey) {
    await store.mutate((current) => {
      claimNotificationKey(current, compatKey, nowIso());
    }, { label: 'aviso-programado' });
  }

  const delivered = await deliverNotification(finalText, {
    subject,
    channels: Array.isArray(workflow.channels) ? workflow.channels : []
  });
  if (delivered.error) log('warn', `Workflow ${workflow.id}: notificación con error: ${delivered.error}`);

  return {
    step: {
      name: 'notify', template, ok: !delivered.error, subject, chars: finalText.length,
      text: finalText.slice(0, 600),
      delivery: delivered.results, llm: llmInfo,
      warning: delivered.error || null
    },
    text: finalText,
    llm: llmInfo,
    delivery: delivered.results
  };
}

async function actionCaptureMetrics(workflow, action, context) {
  if (context.dryRun) {
    return { step: { name: 'capture_metrics', ok: true, dryRun: true, dateKey: context.dateKey } };
  }
  await store.mutate((current) => {
    snapshotDailyMetrics(current, { dateKey: context.dateKey });
  }, { label: 'metricas-snapshot' });
  return { step: { name: 'capture_metrics', ok: true, dateKey: context.dateKey } };
}

async function actionMaterialize(workflow, action, context) {
  if (context.dryRun) {
    return { step: { name: 'materialize_routines', ok: true, dryRun: true, backfillDays: backfillDays(context) } };
  }
  const summary = await withTimeout(
    materializeRoutines({ backfillDays: backfillDays(context) }),
    60_000,
    'materialize_routines'
  );
  const step = {
    name: 'materialize_routines',
    ok: summary?.ok !== false,
    generated: Number(summary?.generated) || 0,
    created: Array.isArray(summary?.created) ? summary.created.length : Number(summary?.generated) || 0,
    skipped: Number(summary?.skipped) || 0,
    errors: Array.isArray(summary?.errors) ? summary.errors.length : 0,
    from: summary?.from || null,
    to: summary?.to || null,
    fatal: summary?.ok === false
  };
  return { step };
}

function backfillDays(context) {
  const settings = store.get().settings || {};
  const configured = Number(settings.routineBackfillDays);
  const fromContext = Number(context.backfillDays);
  if (Number.isFinite(fromContext) && fromContext >= 0) return Math.min(31, Math.round(fromContext));
  return Number.isFinite(configured) && configured >= 0 ? Math.min(31, Math.round(configured)) : 7;
}

async function actionGoogleReconcile(workflow, action, context) {
  const check = store.get();
  const connections = Array.isArray(check.googleConnections) ? check.googleConnections.length : 0;
  if (check.settings?.googleSyncEnabled === false || connections === 0) {
    return {
      step: {
        name: 'google_reconcile', ok: true, skipped: true,
        reason: check.settings?.googleSyncEnabled === false ? 'google-sync-disabled' : 'no-connections'
      }
    };
  }
  if (context.dryRun) {
    return { step: { name: 'google_reconcile', ok: true, dryRun: true, connections } };
  }
  const report = await withTimeout(
    reconcileGoogle({ data: store.get(), force: true }),
    60_000,
    'reconcile_google'
  );
  return {
    step: {
      name: 'google_reconcile',
      ok: report?.ok !== false,
      optional: true,
      skipped: report?.skipped === true || report?.disabled === true,
      report: {
        pushed: report?.pushed || 0,
        pulled: report?.pulled || 0,
        updated: report?.updated || 0,
        cancelled: report?.cancelled || 0,
        connections: report?.connections || 0,
        calendars: report?.calendars || 0,
        errors: Array.isArray(report?.errors) ? report.errors.slice(0, 5) : [],
        durationMs: report?.durationMs || null,
        disabled: report?.disabled === true,
        skippedReason: report?.reason || null
      }
    }
  };
}

async function actionReminders(workflow, action, context) {
  const result = await runReminders({ now: context.now, dryRun: context.dryRun });
  const step = {
    name: 'reminders',
    ok: result.errors.length === 0,
    checked: result.checked,
    sent: result.sent.length,
    planned: result.planned.length,
    errors: result.errors.slice(0, 5),
    dryRun: context.dryRun === true
  };
  if (result.planned.length) step.plannedItems = result.planned.slice(0, 5).map((item) => ({ key: item.key, text: item.text }));
  return { step, delivery: result.sent.flatMap((item) => item.delivery || []), meta: { reminders: { sent: result.sent.length, planned: result.planned.length } } };
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta todas las acciones de un workflow.
 * @param {any} workflow
 * @param {{now?:Date, reason?:string, windowKey?:string|null, dateKey?:string|null,
 *          sinceIso?:string, dryRun?:boolean}} [context]
 */
export async function executeWorkflow(workflow, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const settings = store.get().settings || {};
  const tz = workflowTimezone(workflow, settings);
  const dateKey = context.dateKey || localParts(now, tz).dateKey;
  const ctx = {
    now,
    dateKey,
    sinceIso: context.sinceIso || null,
    reason: context.reason || 'schedule',
    windowKey: context.windowKey ?? null,
    dryRun: context.dryRun === true
  };

  const actions = Array.isArray(workflow.actions) && workflow.actions.length
    ? workflow.actions
    : [{ type: 'notify', template: 'custom', text: '' }];

  const steps = [];
  let llm = null;
  let delivery = [];
  let lastText = null;
  let fatal = false;
  let meta = null;
  const tokens = emptyUsage();

  for (const action of actions) {
    const type = action && typeof action === 'object' ? String(action.type || '') : '';
    try {
      let result = null;
      if (type === 'notify') result = await withTimeout(actionNotify(workflow, action, ctx), 45_000, 'notify');
      else if (type === 'capture_metrics') result = await withTimeout(actionCaptureMetrics(workflow, action, ctx), 30_000, 'capture_metrics');
      else if (type === 'materialize_routines') result = await actionMaterialize(workflow, action, ctx);
      else if (type === 'google_reconcile') result = await actionGoogleReconcile(workflow, action, ctx);
      else if (type === 'reminders') result = await actionReminders(workflow, action, ctx);
      else {
        steps.push({ name: type || 'unknown', ok: false, fatal: true, error: `Acción desconocida: ${type || '(vacía)'}` });
        fatal = true;
        continue;
      }

      if (result?.step) steps.push(result.step);
      if (result?.llm) {
        llm = result.llm;
        const usage = result.llm.usage || emptyUsage();
        tokens.promptTokens += Number(usage.promptTokens) || 0;
        tokens.completionTokens += Number(usage.completionTokens) || 0;
        tokens.totalTokens += Number(usage.totalTokens) || 0;
      }
      if (result?.text) lastText = result.text;
      if (Array.isArray(result?.delivery) && result.delivery.length) delivery = delivery.concat(result.delivery);
      if (result?.meta && !meta) meta = result.meta;
      if (result?.step?.fatal === true) fatal = true;
      if (result?.step?.ok === false && result.step.optional !== true && result.step.name === 'materialize_routines') fatal = true;
    } catch (error) {
      const failure = { name: type || 'action', ok: false, error: errorText(error), code: error?.code || null };
      if (type === 'materialize_routines' || type === 'capture_metrics') failure.fatal = true;
      steps.push(failure);
      if (failure.fatal) fatal = true;
      logError(`workflow:${workflow.id}:${type}`, error);
    }
  }

  return {
    status: fatal ? 'error' : 'ok',
    steps,
    llm,
    delivery,
    tokens,
    text: lastText,
    dryRun: ctx.dryRun,
    meta
  };
}
