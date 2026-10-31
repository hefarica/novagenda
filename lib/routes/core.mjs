/**
 * Módulo de rutas del núcleo (Agenda Copilot P95).
 *
 * Prioridad 0: cualquier módulo de `lib/routes/*.mjs` (priority ≥ 1) puede
 * sobrescribir estas rutas. Aquí viven:
 *   - health, auth, secrets, backup, reset-demo
 *   - bootstrap/dashboard/assistant y reportes
 *   - CRUD base de agenda, inbox, recurrencias, reuniones, OKR y ajustes
 *   - Google OAuth/eventos y canales heredados (WhatsApp/Telegram/Gmail)
 *   - Sin programación propia: los intervalos, recordatorios y envíos viven en
 *     `lib/workflows/scheduler.mjs` (t8). Aquí no se usan setInterval ni timers.
 */
import crypto from 'node:crypto';
import { store, nextId, addActivity, APP_BUILD_VERSION } from '../store.mjs';
import {
  dashboard, handleAssistant, collectBusy, weeklySummary, monthlySummary
} from '../assistant.mjs';
import {
  googleOAuthUrl, finishGoogleOAuth, publicConnections, refreshCalendars,
  disconnectGoogle, listGoogleEvents, createGoogleEvent, updateGoogleEvent, sendGmail
} from '../google.mjs';
import { channelStatus, sendWhatsApp, sendTelegram, setTelegramWebhook } from '../channels.mjs';
import {
  LIMITS, validateAgendaCreate, validateAgendaPatch, validateInboxCreate, validateInboxPatch,
  validateRecurrencePatch, validateMeetingPatch, validateOkrPatch, validateSettingsPatch,
  validateAuthSetup, validateLogin, validatePasswordChange, validateSecretPayload,
  validateAssistantRequest, validateBackupRestore, isoDateTime, validateRange, integer,
  enumValue, text, boolean, email, AGENDA_STATUSES, PRIORITIES
} from '../validate.mjs';
import { HttpError, Errors } from '../http/errors.mjs';
import {
  authSnapshot, setupPolicy, setupAccount, loginAccount, changePassword,
  issueSession, destroySession, requestAuth, hostConfig
} from '../security/session.mjs';
import {
  publicSecretStatus, groupedSecretStatus, setSecret, deleteSecret, getSecret,
  vaultDiagnostics, refreshRedactionIndex
} from '../security/vault.mjs';
import {
  verifyWhatsAppWebhook, verifyTelegramWebhook, verifyWhatsAppHandshake, webhookStrictMode
} from '../http/middleware.mjs';
import { clientIp } from '../http/middleware.mjs';
import { logError } from '../http/logger.mjs';
import { redactString } from '../security/redact.mjs';
import { safeEqual } from '../security/compare.mjs';

export const name = 'core';
export const priority = 0;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function timezone() {
  return store.get().settings?.timezone || process.env.TIMEZONE || 'America/Bogota';
}

function findById(list, id) {
  return (Array.isArray(list) ? list : []).find((item) => item && item.id === id) || null;
}

function appOrigin(ctx) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(ctx.req.headers['x-forwarded-proto'] || (ctx.req.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = String(ctx.req.headers.host || `${hostConfig().host}:${process.env.PORT || 3000}`);
  return `${proto}://${host}`;
}

async function channelCall(channel, promise) {
  try {
    return await promise;
  } catch (err) {
    throw new HttpError(502, 'CHANNEL_ERROR', `${channel}: ${redactString(err?.message || 'error desconocido')}`);
  }
}

/**
 * Vista normalizada de `settings.office` (defaults seguros, sin migración).
 * `enforceOutbound` es derivado y no se persiste.
 * @param {any} [data]
 */
function officeSettingsView(data = store.get()) {
  const office = data?.settings?.office;
  return {
    enforceOutbound: true,
    allowDirectSend: office?.allowDirectSend === true,
    allowAutonomousOutbound: office?.allowAutonomousOutbound === true
  };
}

/**
 * Extrae `office` del body de ajustes (no está en `SETTINGS_FIELDS` para no
 * tocar el validador compartido). Solo se admiten los dos flags booleanos;
 * `enforceOutbound` es derivado y cualquier campo desconocido se rechaza.
 * @param {any} body
 * @returns {object|null}
 */
function takeOfficeSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.office === undefined) return null;
  const value = body.office;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_TYPE', 'office debe ser un objeto.', { field: 'office' });
  }
  const allowed = new Set(['allowDirectSend', 'allowAutonomousOutbound']);
  const patch = {};
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, 'UNKNOWN_FIELD', `Campo no permitido en office: ${key}.`, { field: `office.${key}` });
    }
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') {
      throw new HttpError(400, 'INVALID_TYPE', `office.${key} debe ser booleano.`, { field: `office.${key}` });
    }
    patch[key] = value[key];
  }
  delete body.office;
  return patch;
}

function publicState(ctx) {
  const data = store.get();
  const auth = requestAuth(ctx.req);
  const status = store.status();
  return {
    version: APP_BUILD_VERSION,
    apiVersion: 1,
    settings: { ...data.settings, office: officeSettingsView(data) },
    agenda: data.agenda,
    inbox: data.inbox,
    recurrences: data.recurrences,
    meetings: data.meetings,
    okrs: data.okrs,
    activity: (data.activity || []).slice(0, 20),
    dashboard: dashboard(),
    googleConnections: publicConnections(),
    channels: channelStatus(),
    serverTime: new Date().toISOString(),
    timezone: timezone(),
    auth: {
      required: auth.required,
      mode: auth.mode,
      configured: auth.configured,
      authenticated: auth.authenticated,
      user: auth.user,
      sessionExpiresAt: auth.session ? new Date(auth.session.exp * 1000).toISOString() : null
    },
    store: {
      readOnly: status.readOnly,
      version: status.version,
      schemaVersion: status.schemaVersion,
      error: status.loadError || null
    },
    vault: publicSecretStatus().map(({ name: secretName, group, label, configured, source, secret }) => ({ name: secretName, group, label, configured, source, secret }))
  };
}

function overlapFilter(item, fromIso, toIso) {
  if (!fromIso && !toIso) return true;
  const start = Date.parse(item?.start);
  const end = Date.parse(item?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (fromIso && !(end > Date.parse(fromIso))) return false;
  if (toIso && !(start < Date.parse(toIso))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Tareas programadas: propiedad de t8                                 */
/* ------------------------------------------------------------------ */
// Los intervalos, recordatorios y envíos programados viven en
// `lib/workflows/scheduler.mjs` (t8). Ni server.mjs ni este módulo programan
// ticks ni envían avisos. El estado compartido `notificationLog` se conserva
// en el store con las claves `<job>:<YYYY-MM-DD>` y `<eventId>:<startISO>`.

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

export const routes = [
  /* ---------------------------- salud ---------------------------- */
  {
    method: 'GET',
    path: '/api/health',
    name: 'health',
    auth: 'none',
    handler: async (ctx) => {
      const status = store.status();
      const auth = requestAuth(ctx.req);
      const summary = ctx.router ? ctx.router.summary() : { modules: [], routes: 0 };
      return ctx.json(200, {
        ok: !status.readOnly,
        status: status.readOnly ? 'degraded' : 'ok',
        app: 'Agenda Copilot P95',
        version: APP_BUILD_VERSION,
        apiVersion: 1,
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        port: Number(process.env.PORT || 3000),
        host: hostConfig().host,
        auth: { required: auth.required, mode: auth.mode, configured: auth.configured },
        store: {
          readOnly: status.readOnly,
          version: status.version,
          schemaVersion: status.schemaVersion,
          loadError: status.loadError,
          loadWarning: status.loadWarning,
          persistError: status.persistError,
          lastSavedAt: status.lastSavedAt
        },
        vault: vaultDiagnostics(),
        channels: channelStatus(),
        office: officeSettingsView(),
        webhooksStrict: webhookStrictMode(),
        routes: summary.routes,
        modules: summary.modules,
        conflicts: summary.conflicts
      });
    }
  },

  /* ---------------------------- auth ----------------------------- */
  {
    method: 'GET',
    path: '/api/auth/status',
    name: 'auth.status',
    auth: 'none',
    handler: async (ctx) => ctx.json(200, authSnapshot(ctx.req))
  },
  {
    method: 'POST',
    path: '/api/auth/setup',
    name: 'auth.setup',
    auth: 'none',
    handler: async (ctx) => {
      const input = validateAuthSetup(await ctx.body());
      if (store.get().auth?.configured) {
        throw Errors.conflict('AUTH_ALREADY_CONFIGURED', 'La autenticación ya está configurada. Usa POST /api/auth/login.');
      }
      const policy = setupPolicy(ctx.req, input.setupToken);
      if (!policy.allowed) {
        throw Errors.forbidden('SETUP_FORBIDDEN', 'El setup inicial solo está permitido desde 127.0.0.1 o con APP_SETUP_TOKEN válido.', {
          reason: policy.reason,
          requiresToken: policy.requiresToken
        });
      }
      const { username } = await setupAccount({ username: input.username, password: input.password });
      const session = issueSession(ctx.res, ctx.req, username);
      refreshRedactionIndex();
      return ctx.json(201, {
        ok: true,
        user: { username },
        expiresAt: session.expiresAt,
        auth: { required: authSnapshot(ctx.req).authRequired, mode: authSnapshot(ctx.req).mode, configured: true, authenticated: true }
      });
    }
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    name: 'auth.login',
    auth: 'none',
    handler: async (ctx) => {
      const input = validateLogin(await ctx.body());
      const { username } = await loginAccount({ username: input.username, password: input.password, ip: clientIp(ctx.req) });
      const session = issueSession(ctx.res, ctx.req, username);
      return ctx.json(200, { ok: true, user: { username }, expiresAt: session.expiresAt });
    }
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    name: 'auth.logout',
    auth: 'none',
    handler: async (ctx) => {
      const result = destroySession(ctx.res, ctx.req);
      return ctx.json(200, { ok: true, revoked: result.revoked });
    }
  },
  {
    method: 'POST',
    path: '/api/auth/password',
    name: 'auth.password',
    handler: async (ctx) => {
      const input = validatePasswordChange(await ctx.body());
      const { username } = await changePassword(input);
      const session = issueSession(ctx.res, ctx.req, username);
      return ctx.json(200, { ok: true, user: { username }, expiresAt: session.expiresAt });
    }
  },

  /* -------------------------- estado ----------------------------- */
  {
    method: 'GET',
    path: '/api/bootstrap',
    name: 'bootstrap',
    handler: async (ctx) => ctx.json(200, publicState(ctx))
  },
  {
    method: 'GET',
    path: '/api/dashboard',
    name: 'dashboard',
    handler: async (ctx) => ctx.json(200, dashboard())
  },
  {
    method: 'POST',
    path: '/api/assistant',
    name: 'assistant',
    handler: async (ctx) => {
      const input = validateAssistantRequest(await ctx.body());
      const result = await handleAssistant(input.text, { channel: input.channel || 'web', userId: ctx.auth?.user || 'local' });
      return ctx.json(200, result);
    }
  },

  /* -------------------------- agenda ----------------------------- */
  {
    method: 'GET',
    path: '/api/agenda',
    name: 'agenda.list',
    handler: async (ctx) => {
      const query = ctx.query;
      const tz = timezone();
      const fromIso = query.get('from') ? isoDateTime(query.get('from'), { field: 'from', timeZone: tz }) : null;
      const toIso = query.get('to') ? isoDateTime(query.get('to'), { field: 'to', timeZone: tz }) : null;
      if (fromIso && toIso) validateRange(fromIso, toIso, { fieldStart: 'from', fieldEnd: 'to', maxMinutes: 366 * 24 * 60 });
      const limit = integer(query.get('limit'), { field: 'limit', min: 1, max: 2000, defaultValue: 500 });
      const offset = integer(query.get('offset'), { field: 'offset', min: 0, max: 100000, defaultValue: 0 });
      const statusFilter = query.get('status') ? enumValue(query.get('status'), AGENDA_STATUSES, { field: 'status', required: true }) : null;
      const priorityFilter = query.get('priority') ? enumValue(query.get('priority'), PRIORITIES, { field: 'priority', required: true }) : null;
      const search = query.get('q') ? text(query.get('q'), { field: 'q', max: LIMITS.search, required: true }).toLowerCase() : null;
      const typeFilter = query.get('type') ? text(query.get('type'), { field: 'type', max: LIMITS.type, required: true }) : null;

      let items = (store.get().agenda || []).filter((event) => {
        if (!event || typeof event !== 'object') return false;
        if (!overlapFilter(event, fromIso, toIso)) return false;
        if (statusFilter && event.status !== statusFilter) return false;
        if (priorityFilter && event.priority !== priorityFilter) return false;
        if (typeFilter && event.type !== typeFilter) return false;
        if (search) {
          const haystack = [event.title, event.notes, event.context, event.result, event.owner, event.type].join(' ').toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });
      items = items.sort((a, b) => {
        const startA = Date.parse(a.start);
        const startB = Date.parse(b.start);
        if (!Number.isFinite(startA) && !Number.isFinite(startB)) return 0;
        if (!Number.isFinite(startA)) return 1;
        if (!Number.isFinite(startB)) return -1;
        return startA - startB;
      });
      const total = items.length;
      const page = items.slice(offset, offset + limit);
      return ctx.json(200, { items: page, count: page.length, total, limit, offset });
    }
  },
  {
    method: 'POST',
    path: '/api/agenda',
    name: 'agenda.create',
    handler: async (ctx) => {
      const body = await ctx.body();
      const { event, force } = validateAgendaCreate(body, { timeZone: timezone(), settings: store.get().settings });
      let conflicts = [];
      try {
        conflicts = await collectBusy(event.start, event.end);
      } catch (err) {
        logError('agenda:conflictos', err);
      }
      if (conflicts.length && !force) {
        throw Errors.conflict('CONFLICT', 'El horario se cruza con otros compromisos.', { conflicts });
      }
      const data = store.get();
      const created = { id: nextId('AG', data.agenda), ...event };
      if (data.settings?.autoSyncGoogle && data.settings?.defaultGoogle && created.calendar) {
        try {
          const link = await createGoogleEvent(created);
          if (link) created.google = link;
        } catch (err) {
          created.syncError = redactString(err?.message || 'error').slice(0, 200);
        }
      }
      await store.mutate((current) => {
        current.agenda.push(created);
        addActivity('calendar', `Cita creada: ${created.title}`, { agendaId: created.id });
      }, { label: 'agenda-crear' });
      return ctx.json(201, created);
    }
  },
  {
    method: 'GET',
    path: '/api/agenda/:id',
    name: 'agenda.get',
    handler: async (ctx) => {
      const event = findById(store.get().agenda, ctx.params.id);
      if (!event) throw Errors.notFound('Cita');
      return ctx.json(200, event);
    }
  },
  {
    method: 'PATCH',
    path: '/api/agenda/:id',
    name: 'agenda.update',
    handler: async (ctx) => {
      const event = findById(store.get().agenda, ctx.params.id);
      if (!event) throw Errors.notFound('Cita');
      const body = await ctx.body();
      const { patch, touchesRange } = validateAgendaPatch(body, { current: event, timeZone: timezone() });
      const force = boolean(body.force, { field: 'force', defaultValue: false });
      if (touchesRange && !force) {
        let conflicts = [];
        try {
          conflicts = await collectBusy(patch.start || event.start, patch.end || event.end, event.id);
        } catch (err) {
          logError('agenda:conflictos-patch', err);
        }
        if (conflicts.length) throw Errors.conflict('CONFLICT', 'El nuevo horario se cruza con otros compromisos.', { conflicts });
      }
      const merged = { ...event, ...patch };
      if (event.google && touchesRange && event.calendar) {
        try {
          await updateGoogleEvent(event.google, merged);
        } catch (err) {
          patch.syncError = redactString(err?.message || 'error').slice(0, 200);
        }
      }
      await store.mutate((current) => {
        const target = current.agenda.find((item) => item.id === event.id);
        if (!target) return;
        Object.assign(target, patch);
        addActivity('calendar', `Cita actualizada: ${target.title}`, { agendaId: target.id });
      }, { label: 'agenda-actualizar' });
      return ctx.json(200, findById(store.get().agenda, event.id));
    }
  },
  {
    method: 'DELETE',
    path: '/api/agenda/:id',
    name: 'agenda.delete',
    handler: async (ctx) => {
      const event = findById(store.get().agenda, ctx.params.id);
      if (!event) throw Errors.notFound('Cita');
      const purge = ctx.query.get('purge') === '1' || ctx.query.get('purge') === 'true';
      await store.mutate((current) => {
        if (purge) {
          current.agenda = current.agenda.filter((item) => item.id !== event.id);
          addActivity('calendar', `Cita eliminada: ${event.title}`, { agendaId: event.id });
        } else {
          const target = current.agenda.find((item) => item.id === event.id);
          if (target) {
            target.status = 'Cancelada';
            target.cancelledAt = new Date().toISOString();
          }
          addActivity('calendar', `Cita cancelada: ${event.title}`, { agendaId: event.id });
        }
      }, { label: purge ? 'agenda-eliminar' : 'agenda-cancelar' });
      return ctx.json(200, { ok: true, id: event.id, status: purge ? 'Eliminada' : 'Cancelada', purge });
    }
  },

  /* --------------------------- inbox ----------------------------- */
  {
    method: 'GET',
    path: '/api/inbox',
    name: 'inbox.list',
    handler: async (ctx) => {
      const query = ctx.query;
      const processedParam = query.get('processed');
      const processedFilter = processedParam === null ? null : boolean(processedParam, { field: 'processed', required: true });
      const limit = integer(query.get('limit'), { field: 'limit', min: 1, max: 2000, defaultValue: 500 });
      const offset = integer(query.get('offset'), { field: 'offset', min: 0, max: 100000, defaultValue: 0 });
      const search = query.get('q') ? text(query.get('q'), { field: 'q', max: LIMITS.search, required: true }).toLowerCase() : null;
      let items = (store.get().inbox || []).filter((item) => {
        if (!item || typeof item !== 'object') return false;
        if (processedFilter !== null && !!item.processed !== processedFilter) return false;
        if (search && !String(item.input || '').toLowerCase().includes(search)) return false;
        return true;
      });
      const total = items.length;
      const page = items.slice(offset, offset + limit);
      return ctx.json(200, { items: page, count: page.length, total, limit, offset });
    }
  },
  {
    method: 'POST',
    path: '/api/inbox',
    name: 'inbox.create',
    handler: async (ctx) => {
      const input = validateInboxCreate(await ctx.body());
      const data = store.get();
      const item = {
        id: nextId('IN', data.inbox),
        capturedAt: new Date().toISOString(),
        ...input,
        processed: false,
        agendaId: null
      };
      await store.mutate((current) => {
        current.inbox.push(item);
        addActivity('inbox', `Captura: ${item.input}`.slice(0, 160), { inboxId: item.id });
      }, { label: 'inbox-crear' });
      return ctx.json(201, item);
    }
  },
  {
    method: 'PATCH',
    path: '/api/inbox/:id',
    name: 'inbox.update',
    handler: async (ctx) => {
      const item = findById(store.get().inbox, ctx.params.id);
      if (!item) throw Errors.notFound('Inbox');
      const patch = validateInboxPatch(await ctx.body());
      await store.mutate((current) => {
        const target = current.inbox.find((entry) => entry.id === item.id);
        if (target) Object.assign(target, patch);
      }, { label: 'inbox-actualizar' });
      return ctx.json(200, findById(store.get().inbox, item.id));
    }
  },
  {
    method: 'DELETE',
    path: '/api/inbox/:id',
    name: 'inbox.delete',
    handler: async (ctx) => {
      const item = findById(store.get().inbox, ctx.params.id);
      if (!item) throw Errors.notFound('Inbox');
      await store.mutate((current) => {
        current.inbox = current.inbox.filter((entry) => entry.id !== item.id);
      }, { label: 'inbox-eliminar' });
      return ctx.json(200, { ok: true, id: item.id });
    }
  },

  /* ------------------------ recurrencias ------------------------- */
  {
    method: 'GET',
    path: '/api/recurrences',
    name: 'recurrences.list',
    handler: async (ctx) => {
      const items = store.get().recurrences || [];
      return ctx.json(200, { items, count: items.length, total: items.length });
    }
  },
  {
    method: 'PATCH',
    path: '/api/recurrences/:id',
    name: 'recurrences.update',
    handler: async (ctx) => {
      const item = findById(store.get().recurrences, ctx.params.id);
      if (!item) throw Errors.notFound('Recurrencia');
      const patch = validateRecurrencePatch(await ctx.body());
      await store.mutate((current) => {
        const target = current.recurrences.find((entry) => entry.id === item.id);
        if (target) Object.assign(target, patch);
        addActivity('automation', `Rutina actualizada: ${item.title || item.id}`, { recurrentId: item.id });
      }, { label: 'recurrencia-actualizar' });
      return ctx.json(200, findById(store.get().recurrences, item.id));
    }
  },

  /* --------------------------- reuniones ------------------------- */
  {
    method: 'GET',
    path: '/api/meetings',
    name: 'meetings.list',
    handler: async (ctx) => {
      const items = store.get().meetings || [];
      return ctx.json(200, { items, count: items.length, total: items.length });
    }
  },
  {
    method: 'PATCH',
    path: '/api/meetings/:id',
    name: 'meetings.update',
    handler: async (ctx) => {
      const item = findById(store.get().meetings, ctx.params.id);
      if (!item) throw Errors.notFound('Reunión');
      const patch = validateMeetingPatch(await ctx.body());
      await store.mutate((current) => {
        const target = current.meetings.find((entry) => entry.id === item.id);
        if (target) Object.assign(target, patch);
      }, { label: 'reunion-actualizar' });
      return ctx.json(200, findById(store.get().meetings, item.id));
    }
  },

  /* ----------------------------- OKR ----------------------------- */
  {
    method: 'GET',
    path: '/api/okrs',
    name: 'okrs.list',
    handler: async (ctx) => {
      const items = store.get().okrs || [];
      return ctx.json(200, { items, count: items.length, total: items.length });
    }
  },
  {
    method: 'PATCH',
    path: '/api/okrs/:id',
    name: 'okrs.update',
    handler: async (ctx) => {
      const item = findById(store.get().okrs, ctx.params.id);
      if (!item) throw Errors.notFound('OKR');
      const patch = validateOkrPatch(await ctx.body());
      await store.mutate((current) => {
        const target = current.okrs.find((entry) => entry.id === item.id);
        if (target) Object.assign(target, patch);
      }, { label: 'okr-actualizar' });
      return ctx.json(200, findById(store.get().okrs, item.id));
    }
  },

  /* --------------------------- ajustes --------------------------- */
  {
    method: 'GET',
    path: '/api/settings',
    name: 'settings.get',
    handler: async (ctx) => {
      const data = store.get();
      return ctx.json(200, { ...data.settings, office: officeSettingsView(data) });
    }
  },
  {
    method: 'POST',
    path: '/api/settings',
    name: 'settings.update',
    handler: async (ctx) => {
      const raw = await ctx.body();
      const office = takeOfficeSettings(raw);
      const patch = Object.keys(raw || {}).length
        ? validateSettingsPatch(raw)
        : (office ? {} : validateSettingsPatch(raw));
      let ledger = null;
      if (office && Object.keys(office).length) {
        try {
          ledger = await import('../office/ledger.mjs');
          if (typeof ledger.appendLedger !== 'function') throw new Error('sin appendLedger');
        } catch {
          throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'La Oficina no está disponible; no se cambiaron los ajustes.');
        }
      }
      await store.mutate((current) => {
        const changes = {};
        if (office) {
          const currentOffice = current.settings?.office && typeof current.settings.office === 'object'
            ? current.settings.office
            : {};
          for (const key of Object.keys(office)) {
            if (currentOffice[key] !== office[key]) changes[key] = office[key];
          }
          // La auditoría va ANTES de mutar los ajustes; si falla no se persiste
          // ningún cambio de los flags.
          if (Object.keys(changes).length) {
            ledger.appendLedger(current, {
              actor: 'user',
              action: 'office.settings',
              payload: { by: 'user', changes }
            });
          }
        }
        const p95 = patch.p95 ? { ...current.settings.p95, ...patch.p95 } : current.settings.p95;
        current.settings = { ...current.settings, ...patch, p95 };
        if (office) current.settings.office = { ...(current.settings.office || {}), ...office };
        addActivity('settings', 'Ajustes actualizados');
      }, { label: 'ajustes' });
      const data = store.get();
      return ctx.json(200, { ...data.settings, office: officeSettingsView(data) });
    }
  },

  /* --------------------------- reportes -------------------------- */
  {
    method: 'GET',
    path: '/api/report/weekly',
    name: 'report.weekly',
    handler: async (ctx) => ctx.json(200, { text: weeklySummary(), monthly: monthlySummary(), metrics: (store.get().metrics || []).slice(-31) })
  },
  {
    method: 'GET',
    path: '/api/report/monthly',
    name: 'report.monthly',
    handler: async (ctx) => ctx.json(200, { text: monthlySummary(), metrics: (store.get().metrics || []).slice(-31) })
  },
  {
    method: 'GET',
    path: '/api/activity',
    name: 'activity.list',
    handler: async (ctx) => {
      const limit = integer(ctx.query.get('limit'), { field: 'limit', min: 1, max: 100, defaultValue: 30 });
      const items = (store.get().activity || []).slice(0, limit);
      return ctx.json(200, { items, count: items.length });
    }
  },

  /* --------------------------- secretos -------------------------- */
  {
    method: 'GET',
    path: '/api/secrets',
    name: 'secrets.list',
    handler: async (ctx) => ctx.json(200, {
      items: publicSecretStatus(),
      groups: groupedSecretStatus(),
      vault: vaultDiagnostics()
    })
  },
  {
    method: 'PUT',
    path: '/api/secrets/:name',
    name: 'secrets.put',
    handler: async (ctx) => {
      const secretName = text(ctx.params.name, { field: 'name', required: true, max: 80, allowEmpty: false });
      const { value } = validateSecretPayload(await ctx.body());
      const secret = await setSecret(secretName, value);
      refreshRedactionIndex();
      return ctx.json(200, { ok: true, secret });
    }
  },
  {
    method: 'DELETE',
    path: '/api/secrets/:name',
    name: 'secrets.delete',
    handler: async (ctx) => {
      const secretName = text(ctx.params.name, { field: 'name', required: true, max: 80, allowEmpty: false });
      const result = await deleteSecret(secretName);
      refreshRedactionIndex();
      return ctx.json(200, { ok: true, ...result });
    }
  },

  /* ---------------------------- backup --------------------------- */
  {
    method: 'GET',
    path: '/api/backup',
    name: 'backup.download',
    handler: async (ctx) => {
      const includeSecrets = ctx.query.get('secrets') !== 'none';
      const payload = store.backupPayload({ includeSecrets });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      return ctx.json(200, payload, {
        'content-disposition': `attachment; filename="agenda-backup-${stamp}.json"`,
        'x-agenda-backup': '1'
      }, { redact: false });
    }
  },
  {
    method: 'POST',
    path: '/api/backup/restore',
    name: 'backup.restore',
    maxBodyBytes: 16 * 1024 * 1024,
    handler: async (ctx) => {
      const { data } = validateBackupRestore(await ctx.body());
      const result = await store.restore(data);
      await store.mutate(() => {
        addActivity('system', 'Backup restaurado por API.');
      }, { label: 'backup-restaurado' });
      return ctx.json(200, { ok: true, ...result, store: store.status() });
    }
  },
  {
    method: 'GET',
    path: '/api/backup/journal',
    name: 'backup.journal',
    handler: async (ctx) => {
      const limit = integer(ctx.query.get('limit'), { field: 'limit', min: 1, max: 500, defaultValue: 50 });
      return ctx.json(200, { entries: store.journalTail(limit), journal: store.status().journal });
    }
  },

  /* -------------------------- reset demo ------------------------- */
  {
    method: 'POST',
    path: '/api/reset-demo',
    name: 'reset-demo',
    localOnly: true,
    handler: async (ctx) => {
      if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        throw Errors.forbidden('RESET_DISABLED', 'Reset de demo deshabilitado en producción.');
      }
      await store.reset();
      return ctx.json(200, publicState(ctx));
    }
  },

  /* ---------------------------- Google --------------------------- */
  {
    method: 'GET',
    path: '/api/google/events',
    name: 'google.events',
    handler: async (ctx) => {
      const tz = timezone();
      const days = integer(ctx.query.get('days'), { field: 'days', min: 1, max: 365, defaultValue: 14 });
      const timeMin = ctx.query.get('timeMin') ? isoDateTime(ctx.query.get('timeMin'), { field: 'timeMin', timeZone: tz }) : new Date(Date.now() - 86_400_000).toISOString();
      const timeMax = ctx.query.get('timeMax') ? isoDateTime(ctx.query.get('timeMax'), { field: 'timeMax', timeZone: tz }) : new Date(Date.now() + days * 86_400_000).toISOString();
      validateRange(timeMin, timeMax, { fieldStart: 'timeMin', fieldEnd: 'timeMax', maxMinutes: 366 * 24 * 60 });
      return ctx.json(200, { events: await listGoogleEvents(timeMin, timeMax), timeMin, timeMax });
    }
  },
  {
    method: 'GET',
    path: '/api/auth/google/start',
    name: 'google.start',
    handler: async (ctx) => {
      const state = crypto.randomBytes(24).toString('base64url');
      const redirectUri = `${appOrigin(ctx)}/api/auth/google/callback`;
      const label = text(ctx.query.get('label'), { field: 'label', max: LIMITS.label, defaultValue: 'Google' });
      await store.mutate((current) => {
        current.oauthStates[state] = { createdAt: Date.now(), label, userId: ctx.auth?.user || 'local' };
      }, { label: 'oauth-start' });
      let url;
      try {
        url = googleOAuthUrl({ redirectUri, state });
      } catch (err) {
        throw new HttpError(400, 'GOOGLE_NOT_CONFIGURED', redactString(err?.message || 'Google OAuth no configurado.'));
      }
      return ctx.redirect(url);
    }
  },
  {
    method: 'GET',
    path: '/api/auth/google/callback',
    name: 'google.callback',
    auth: 'none',
    handler: async (ctx) => {
      const state = ctx.query.get('state');
      const code = ctx.query.get('code');
      const pending = state ? store.get().oauthStates?.[state] : null;
      if (!state || !code || !pending || Date.now() - Number(pending.createdAt) > 10 * 60_000) {
        throw new HttpError(400, 'OAUTH_STATE_INVALID', 'OAuth state inválido o expirado.');
      }
      const redirectUri = `${appOrigin(ctx)}/api/auth/google/callback`;
      try {
        await finishGoogleOAuth({ code, redirectUri, label: pending.label || 'Google' });
      } catch (err) {
        logError('google:callback', err);
        return ctx.redirect('/?google=error');
      }
      await store.mutate((current) => { delete current.oauthStates[state]; }, { label: 'oauth-finish' });
      return ctx.redirect('/?connected=google');
    }
  },
  {
    method: 'POST',
    path: '/api/google/connections/:id/refresh',
    name: 'google.refresh',
    handler: async (ctx) => {
      try {
        const calendars = await refreshCalendars(ctx.params.id);
        return ctx.json(200, { calendars });
      } catch (err) {
        throw new HttpError(400, 'GOOGLE_ERROR', redactString(err?.message || 'No se pudieron refrescar los calendarios.'));
      }
    }
  },
  {
    method: 'DELETE',
    path: '/api/google/connections/:id',
    name: 'google.disconnect',
    handler: async (ctx) => {
      await disconnectGoogle(ctx.params.id);
      return ctx.json(200, { ok: true });
    }
  },

  /* --------------------------- canales -------------------------- */
  {
    method: 'POST',
    path: '/api/whatsapp/test',
    name: 'whatsapp.test',
    handler: async (ctx) => {
      const body = await ctx.body();
      const to = text(body.to, { field: 'to', max: 40, defaultValue: null });
      const message = text(body.text, { field: 'text', max: 4000, defaultValue: 'Prueba Agenda Copilot' });
      return ctx.json(200, await channelCall('WhatsApp', sendWhatsApp(to, message)));
    }
  },
  {
    method: 'GET',
    path: '/api/whatsapp/webhook',
    name: 'whatsapp.verify',
    auth: 'none',
    webhook: true,
    csrf: false,
    handler: async (ctx) => {
      const mode = ctx.query.get('hub.mode');
      const challenge = ctx.query.get('hub.challenge') || '';
      const token = ctx.query.get('hub.verify_token');
      if (mode !== 'subscribe') throw new HttpError(400, 'INVALID_MODE', 'hub.mode debe ser subscribe.');
      if (!verifyWhatsAppHandshake(token)) throw Errors.forbidden('VERIFY_TOKEN_INVALID', 'verify token inválido.');
      return ctx.text(200, String(challenge || 'OK'));
    }
  },
  {
    method: 'POST',
    path: '/api/whatsapp/webhook',
    name: 'whatsapp.webhook',
    auth: 'none',
    webhook: true,
    csrf: false,
    rawBody: true,
    handler: async (ctx) => {
      const raw = await ctx.rawBody();
      verifyWhatsAppWebhook(ctx.req, raw, ctx);
      let payload = null;
      try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { payload = null; }
      if (!payload) throw Errors.invalidJson('Payload de WhatsApp inválido.');
      void processWhatsAppMessage(payload, ctx);
      return ctx.json(200, { received: true });
    }
  },
  {
    method: 'POST',
    path: '/api/telegram/test',
    name: 'telegram.test',
    handler: async (ctx) => {
      const body = await ctx.body();
      const chatId = text(body.chatId, { field: 'chatId', max: 64, defaultValue: null });
      const message = text(body.text, { field: 'text', max: 4000, defaultValue: 'Prueba Agenda Copilot' });
      return ctx.json(200, await channelCall('Telegram', sendTelegram(chatId, message)));
    }
  },
  {
    method: 'POST',
    path: '/api/telegram/set-webhook',
    name: 'telegram.set-webhook',
    handler: async (ctx) => ctx.json(200, await channelCall('Telegram', setTelegramWebhook(appOrigin(ctx))))
  },
  {
    method: 'POST',
    path: '/api/telegram/webhook',
    name: 'telegram.webhook',
    auth: 'none',
    webhook: true,
    csrf: false,
    handler: async (ctx) => {
      verifyTelegramWebhook(ctx.req, ctx);
      const payload = await ctx.body();
      void processTelegramMessage(payload, ctx);
      return ctx.json(200, { received: true });
    }
  },
  {
    method: 'POST',
    path: '/api/gmail/send',
    name: 'gmail.send',
    handler: async (ctx) => {
      const body = await ctx.body();
      const to = email(body.to, { field: 'to', required: true, max: LIMITS.email });
      const subject = text(body.subject, { field: 'subject', max: 200, defaultValue: 'Agenda Copilot' });
      const content = text(body.body, { field: 'body', required: true, max: 20_000, allowEmpty: false });
      const connectionId = text(body.connectionId, { field: 'connectionId', max: 80, defaultValue: null });
      const direct = body.direct === undefined ? false : boolean(body.direct, { field: 'direct', defaultValue: false });
      const actor = ctx.auth?.user && ctx.auth.user !== 'local' ? String(ctx.auth.user) : 'api';

      let outbound;
      try {
        outbound = await import('../office/outbound.mjs');
      } catch {
        throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'La Oficina no está disponible; el correo no se envía directamente.');
      }

      if (direct && !outbound.allowDirectSend()) {
        throw new HttpError(403, 'APPROVAL_REQUIRED', 'El envío directo está deshabilitado; usa el flujo de aprobación de la Oficina.');
      }

      try {
        if (direct) {
          // Excepción explícita: se audita ANTES de enviar. Si falla la
          // auditoría, no se envía nada.
          await outbound.auditDirectOverride({ to, subject, connectionId, actor, requestId: ctx.requestId });
          const result = await sendGmail({ to, subject, body: content, connectionId });
          return ctx.json(200, { ok: true, id: result?.id || null, direct: true });
        }
        const { proposal } = await outbound.createOutboundEmailProposal({
          to, subject, body: content, connectionId, actor
        });
        return ctx.json(202, {
          status: 'pending_approval',
          proposal: {
            id: proposal.id,
            level: proposal.level,
            risk: proposal.risk,
            flags: proposal.flags
          },
          message: 'Correo pendiente de aprobación. Apruébalo y ejecútalo desde la Oficina.',
          approvalUrl: `/api/office/proposals/${encodeURIComponent(proposal.id)}`
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (direct) throw new HttpError(502, 'CHANNEL_ERROR', `Gmail: ${redactString(err?.message || 'error')}`);
        throw new HttpError(502, 'OFFICE_ERROR', `No se pudo crear la propuesta de correo: ${redactString(err?.message || 'error')}`);
      }
    }
  }
];

/* ------------------------------------------------------------------ */
/* Procesamiento asíncrono de webhooks                                 */
/* ------------------------------------------------------------------ */

async function processWhatsAppMessage(payload, ctx) {
  try {
    const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text' || !message.text?.body) return;
    const answer = await handleAssistant(message.text.body, { channel: 'whatsapp', userId: String(message.from || 'whatsapp') });
    await sendWhatsApp(message.from, answer?.reply || '').catch((err) => logError('whatsapp:reply', err));
  } catch (err) {
    logError('whatsapp:webhook', err, { requestId: ctx?.requestId });
  }
}

async function processTelegramMessage(payload, ctx) {
  try {
    const message = payload?.message || payload?.edited_message;
    if (!message || !message.text || !message.chat?.id) return;
    const answer = await handleAssistant(String(message.text), { channel: 'telegram', userId: String(message.chat.id) });
    await sendTelegram(message.chat.id, answer?.reply || '').catch((err) => logError('telegram:reply', err));
  } catch (err) {
    logError('telegram:webhook', err, { requestId: ctx?.requestId });
  }
}
