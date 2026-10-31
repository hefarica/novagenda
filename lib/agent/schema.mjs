/**
 * Protocolo de intención del agente: catálogo de acciones, validación estricta
 * del JSON propuesto por el LLM y saneado del autocompletado de campos.
 *
 * El LLM NUNCA ejecuta nada: propone `{action, args, reply, confidence}` y este
 * módulo lo valida. Si falta un dato obligatorio o el LLM inventa una fecha,
 * la intención se convierte en `preguntar` (el agente pide aclaración).
 */
import { isValidDateKey, normalizeWeekdays, isoAtLocal } from '../agenda/time.mjs';
import {
  deriveTitle, deriveTaskTitle, parseTaskOwner, parseDateHint, parseDurationHint, parseEnergyHint, parsePriorityHint,
  parseReminderHint, parseTimeHint, parseTypeHint, foldText, todayKeyOf
} from './context.mjs';
import { canonicalizeAgentArgs } from './lingo.mjs';

/** Catálogo de herramientas deterministas del agente. */
export const ACTION_CATALOG = Object.freeze({
  crear_cita: { label: 'Crear cita', destructive: false, requiresConfirmation: false, args: ['title', 'date', 'time', 'durationMin', 'type', 'priority', 'impact', 'urgency', 'energy', 'context', 'location', 'reminderMin', 'notes', 'attendees', 'deepFocus'] },
  buscar_huecos: { label: 'Buscar huecos', destructive: false, requiresConfirmation: false, args: ['durationMin', 'from', 'date', 'days'] },
  mover_cita: { label: 'Mover cita', destructive: true, requiresConfirmation: true, args: ['id', 'query', 'date', 'time', 'durationMin', 'shiftMinutes'] },
  cancelar_cita: { label: 'Cancelar cita', destructive: true, requiresConfirmation: true, args: ['id', 'query'] },
  completar_cita: { label: 'Completar cita', destructive: true, requiresConfirmation: true, args: ['id', 'query', 'actualMin'] },
  capturar: { label: 'Capturar en inbox', destructive: false, requiresConfirmation: false, args: ['text', 'due', 'priority', 'type', 'notes'] },
  crear_tarea: { label: 'Crear tarea', destructive: false, requiresConfirmation: false, args: ['title', 'due', 'dueTime', 'priority', 'owner', 'notes', 'person'] },
  cerrar_tarea: { label: 'Cerrar tarea', destructive: false, requiresConfirmation: false, args: ['id', 'taskId', 'query', 'result'] },
  reabrir_tarea: { label: 'Reabrir tarea', destructive: false, requiresConfirmation: false, args: ['id', 'taskId', 'query'] },
  crear_meet: { label: 'Crear reunión con Meet', destructive: false, requiresConfirmation: false, args: ['eventId', 'query', 'title', 'date', 'time', 'durationMin', 'attendees', 'type', 'notes'] },
  listar_tareas: { label: 'Listar tareas', destructive: false, requiresConfirmation: false, args: ['status', 'owner', 'limit'] },
  convertir_inbox: { label: 'Convertir inbox en cita', destructive: true, requiresConfirmation: true, args: ['id', 'query', 'title', 'date', 'time', 'durationMin', 'priority'] },
  crear_rutina: { label: 'Crear rutina', destructive: false, requiresConfirmation: false, args: ['title', 'kind', 'frequency', 'rule', 'time', 'durationMin', 'type', 'priority', 'impact', 'urgency', 'energy', 'active', 'startDate', 'endDate', 'notes', 'skipHolidays', 'purpose', 'requiredOutput', 'participants'] },
  editar_rutina: { label: 'Editar rutina', destructive: true, requiresConfirmation: true, args: ['id', 'query', 'title', 'frequency', 'rule', 'time', 'durationMin', 'type', 'priority', 'active', 'notes', 'skipHolidays'] },
  activar_rutina: { label: 'Activar o pausar rutina', destructive: true, requiresConfirmation: true, args: ['id', 'query', 'active'] },
  listar_dia: { label: 'Listar el día', destructive: false, requiresConfirmation: false, args: ['date'] },
  resumen_semana: { label: 'Resumen semanal', destructive: false, requiresConfirmation: false, args: [] },
  balance: { label: 'Balance del día', destructive: false, requiresConfirmation: false, args: [] },
  enviar_correo: { label: 'Proponer correo (Oficina)', destructive: false, requiresConfirmation: false, args: ['to', 'subject', 'body'] },
  enviar_whatsapp: { label: 'Proponer WhatsApp (Oficina)', destructive: false, requiresConfirmation: false, args: ['to', 'text'] },
  enviar_telegram: { label: 'Proponer Telegram (Oficina)', destructive: false, requiresConfirmation: false, args: ['chatId', 'text'] },
  enviar_documento: { label: 'Proponer documento (Oficina)', destructive: false, requiresConfirmation: false, args: ['docId', 'to', 'subject', 'body', 'channel'] },
  preguntar: { label: 'Pedir aclaración', destructive: false, requiresConfirmation: false, args: ['question'] }
});

export const ACTIONS = Object.freeze(Object.keys(ACTION_CATALOG));

/** Alias aceptados (español/inglés y nombres de herramienta). */
export const ACTION_ALIASES = Object.freeze({
  crear_cita: 'crear_cita', agendar: 'crear_cita', agenda: 'crear_cita', schedule: 'crear_cita',
  crear: 'crear_cita', nueva_cita: 'crear_cita', nuevo_evento: 'crear_cita', crear_evento: 'crear_cita',
  add_event: 'crear_cita', create_event: 'crear_cita',
  buscar_huecos: 'buscar_huecos', huecos: 'buscar_huecos', disponibilidad: 'buscar_huecos',
  buscar_disponibilidad: 'buscar_huecos', slots: 'buscar_huecos', find_slots: 'buscar_huecos',
  mover_cita: 'mover_cita', mover: 'mover_cita', mover_evento: 'mover_cita', reprogramar: 'mover_cita',
  posponer: 'mover_cita', cambiar_hora: 'mover_cita', reschedule: 'mover_cita', move_event: 'mover_cita',
  cancelar_cita: 'cancelar_cita', cancelar: 'cancelar_cita', eliminar_cita: 'cancelar_cita',
  borrar_cita: 'cancelar_cita', cancel_event: 'cancelar_cita', delete_event: 'cancelar_cita',
  completar_cita: 'completar_cita', completar: 'completar_cita', marcar_hecho: 'completar_cita',
  hecho: 'completar_cita', terminar: 'completar_cita', complete_event: 'completar_cita',
  capturar: 'capturar', captura: 'capturar', inbox: 'capturar', anotar: 'capturar',
  recordar: 'capturar', capture: 'capturar',
  crear_tarea: 'crear_tarea', nueva_tarea: 'crear_tarea', anadir_tarea: 'crear_tarea',
  añadir_tarea: 'crear_tarea', agregar_tarea: 'crear_tarea', asignar_tarea: 'crear_tarea',
  create_task: 'crear_tarea', add_task: 'crear_tarea', tarea: 'crear_tarea',
  cerrar_tarea: 'cerrar_tarea', cerrar: 'cerrar_tarea', completar_tarea: 'cerrar_tarea',
  terminar_tarea: 'cerrar_tarea', tachar_tarea: 'cerrar_tarea', close_task: 'cerrar_tarea',
  reabrir_tarea: 'reabrir_tarea', reabrir: 'reabrir_tarea', abrir_tarea: 'reabrir_tarea',
  reopen_task: 'reabrir_tarea',
  crear_meet: 'crear_meet', meet: 'crear_meet', reunion_virtual: 'crear_meet',
  reunión_virtual: 'crear_meet', videollamada: 'crear_meet', video_llamada: 'crear_meet',
  crear_videollamada: 'crear_meet', enlace_meet: 'crear_meet', google_meet: 'crear_meet',
  create_meet: 'crear_meet',
  listar_tareas: 'listar_tareas', tareas: 'listar_tareas', mis_tareas: 'listar_tareas',
  pendientes: 'listar_tareas', lista_tareas: 'listar_tareas', list_tasks: 'listar_tareas',
  convertir_inbox: 'convertir_inbox', convertir: 'convertir_inbox', pasar_a_agenda: 'convertir_inbox',
  convertir_captura: 'convertir_inbox', convert_inbox: 'convertir_inbox',
  crear_rutina: 'crear_rutina', nueva_rutina: 'crear_rutina', crear_recurrencia: 'crear_rutina',
  rutina: 'crear_rutina', create_routine: 'crear_rutina',
  editar_rutina: 'editar_rutina', cambiar_rutina: 'editar_rutina', modificar_rutina: 'editar_rutina',
  actualizar_rutina: 'editar_rutina', edit_routine: 'editar_rutina',
  activar_rutina: 'activar_rutina', pausar_rutina: 'activar_rutina', activar: 'activar_rutina',
  pausar: 'activar_rutina', toggle_rutina: 'activar_rutina',
  listar_dia: 'listar_dia', listar: 'listar_dia', mi_dia: 'listar_dia', agenda_del_dia: 'listar_dia',
  hoy: 'listar_dia', today: 'listar_dia', list_day: 'listar_dia',
  resumen_semana: 'resumen_semana', semana: 'resumen_semana', reporte_semanal: 'resumen_semana',
  weekly: 'resumen_semana', week: 'resumen_semana',
  balance: 'balance', resumen: 'balance', estado: 'balance', como_voy: 'balance', check: 'balance',
  enviar_correo: 'enviar_correo', correo: 'enviar_correo', email: 'enviar_correo', mail: 'enviar_correo',
  enviar_email: 'enviar_correo', send_email: 'enviar_correo',
  enviar_whatsapp: 'enviar_whatsapp', whatsapp: 'enviar_whatsapp', wa: 'enviar_whatsapp',
  send_whatsapp: 'enviar_whatsapp',
  enviar_telegram: 'enviar_telegram', telegram: 'enviar_telegram', send_telegram: 'enviar_telegram',
  enviar_documento: 'enviar_documento', mandar_documento: 'enviar_documento', documento: 'enviar_documento',
  enviar_doc: 'enviar_documento', send_document: 'enviar_documento',
  preguntar: 'preguntar', aclarar: 'preguntar', pregunta: 'preguntar', ask: 'preguntar',
  unknown: 'preguntar', desconocido: 'preguntar', ninguno: 'preguntar', none: 'preguntar', other: 'preguntar'
});

export const CREATABLE_TYPES = Object.freeze(['Reunión', 'Foco', 'Compromiso', 'Administrativo', 'Reporte', 'Personal', 'Tarea', 'Desplazamiento', 'Bloqueo']);
const ENERGIES = ['Alta', 'Media', 'Baja'];
const PRIORITIES = ['P1', 'P2', 'P3'];
const TASK_PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const TASK_STATUS_MAP = Object.freeze({
  open: 'open', abierta: 'open', abiertas: 'open', pendiente: 'open', pendientes: 'open',
  done: 'done', cerrada: 'done', cerradas: 'done', hecha: 'done', hechas: 'done', completada: 'done', completadas: 'done',
  cancelled: 'cancelled', cancelada: 'cancelled', canceladas: 'cancelled',
  all: 'all', todas: 'all', todos: 'all', cualquier: 'all'
});
const FREQUENCIES = ['DIARIA', 'LABORABLES', 'SEMANAL', 'MENSUAL', 'TRIMESTRAL'];

/** @param {unknown} raw @returns {string|null} */
export function normalizeAction(raw) {
  const key = foldText(raw).replace(/[\s-]+/g, '_');
  if (!key) return null;
  return ACTION_ALIASES[key] || (ACTION_CATALOG[key] ? key : null);
}

/** ¿La acción requiere confirmación explícita? */
export function isDestructive(action) {
  const entry = ACTION_CATALOG[action];
  return !!(entry && entry.destructive);
}

/** ¿La acción exige confirmación (destructiva o marcada)? */
export function requiresConfirmation(action) {
  const entry = ACTION_CATALOG[action];
  return !!(entry && entry.requiresConfirmation);
}

/* ------------------------------------------------------------------ */
/* Coerción de argumentos                                              */
/* ------------------------------------------------------------------ */

function asText(value, max = 300) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const clean = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.slice(0, max);
}

function asDate(value) {
  const raw = asText(value, 40);
  if (!raw) return undefined;
  const key = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && isValidDateKey(key)) return key;
  const hint = parseDateHint(raw, { todayKey: todayKeyOf() });
  return hint ? hint.date : undefined;
}

function asTime(value) {
  const raw = asText(value, 20);
  if (!raw) return undefined;
  const hint = parseTimeHint(raw);
  return hint ? hint.time : undefined;
}

function asInt(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function asEnum(value, allowed) {
  const raw = asText(value, 40);
  if (!raw) return undefined;
  const found = allowed.find((item) => foldText(item) === foldText(raw));
  return found;
}

function asEmail(value) {
  const raw = asText(value, 254);
  if (!raw) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? raw : undefined;
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  const raw = foldText(value);
  if (['true', '1', 'si', 'sí', 'yes', 'on', 'activar', 'activa'].includes(raw)) return true;
  if (['false', '0', 'no', 'off', 'pausar', 'pausa', 'inactiva'].includes(raw)) return false;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Asistentes: emails válidos vs nombres mencionados                   */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL_ONLY_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function isEmail(value) {
  return typeof value === 'string' && EMAIL_ONLY_RE.test(value.trim());
}

function cleanupAttendeeName(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(EMAIL_RE, ' ')
    .replace(/[()[\]{}<>"'`,;:/\\|]+/g, ' ')
    .replace(/\b(?:sin|correo|email|e-mail|invitad[oa]|asistente|participante|con|y|e)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2 || text.length > 80) return '';
  if (/[0-9@/\\]/.test(text)) return '';
  if (!/\p{L}/u.test(text)) return '';
  if (!/^[\p{L}\p{M}\s.'’-]+$/u.test(text)) return '';
  return text;
}

/**
 * Normaliza asistentes: conserva SOLO emails válidos y devuelve por separado
 * los nombres mencionados sin email, para no perderlos ni bloquear la cita.
 *
 * Acepta arrays, un único string, o elementos `{name, email}` (defensivo ante
 * proveedores que devuelven objetos). Tolera formatos tipo
 * `Ana <ana@empresa.com>` o `ana@empresa.com, Luis`.
 *
 * @param {unknown} value
 * @param {{maxEmails?:number, maxNames?:number}} [options]
 * @returns {{emails:string[], names:string[]}}
 */
export function normalizeAttendees(value, { maxEmails = 20, maxNames = 10 } = {}) {
  const list = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ''
      ? []
      : [value];
  const emails = [];
  const names = [];
  const seenEmails = new Set();
  const seenNames = new Set();

  const addEmail = (candidate) => {
    const email = String(candidate ?? '').trim();
    if (!isEmail(email)) return;
    const key = email.toLowerCase();
    if (seenEmails.has(key) || emails.length >= maxEmails) return;
    seenEmails.add(key);
    emails.push(email);
  };
  const addName = (candidate) => {
    const name = cleanupAttendeeName(String(candidate ?? ''));
    if (!name) return;
    const key = foldText(name);
    if (!key || seenNames.has(key) || names.length >= maxNames) return;
    seenNames.add(key);
    names.push(name);
  };

  for (const entry of list) {
    if (emails.length >= maxEmails && names.length >= maxNames) break;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (typeof entry.email === 'string') addEmail(entry.email);
      if (typeof entry.name === 'string') addName(entry.name);
      continue;
    }
    const clean = String(entry ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (isEmail(clean)) {
      addEmail(clean);
      continue;
    }
    const found = clean.match(EMAIL_RE) || [];
    let rest = clean;
    for (const email of found) {
      rest = rest.split(email).join(' ');
      addEmail(email);
    }
    const name = cleanupAttendeeName(rest);
    if (name) addName(name);
  }
  return { emails, names };
}

/**
 * Sanea los argumentos de una acción según su catálogo.
 * @param {string} action
 * @param {object} rawArgs
 * @returns {{args:object, issues:string[]}}
 */
export function sanitizeArgs(action, rawArgs = {}) {
  const catalog = ACTION_CATALOG[action] || { args: [] };
  const allowed = new Set(catalog.args);
  const source = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = {};
  const issues = [];
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      issues.push(`argumento ignorado: ${key}`);
      continue;
    }
    const value = source[key];
    switch (key) {
      case 'title': args.title = asText(value, 200); break;
      case 'name': args.title = asText(value, 160); break;
      case 'date': args.date = asDate(value); break;
      case 'startDate': args.startDate = asDate(value); break;
      case 'endDate': args.endDate = asDate(value); break;
      case 'due': args.due = asDate(value); break;
      case 'from': args.from = asText(value, 40); break;
      case 'time': args.time = asTime(value); break;
      case 'durationMin': args.durationMin = asInt(value, 5, 720); break;
      case 'actualMin': args.actualMin = asInt(value, 0, 1440); break;
      case 'shiftMinutes': args.shiftMinutes = asInt(value, -1440, 1440); break;
      case 'reminderMin': args.reminderMin = asInt(value, 0, 40320); break;
      case 'days': args.days = asInt(value, 1, 60); break;
      case 'impact': args.impact = asInt(value, 1, 5); break;
      case 'urgency': args.urgency = asInt(value, 1, 5); break;
      case 'priority': args.priority = asEnum(value, action === 'crear_tarea' ? TASK_PRIORITIES : PRIORITIES); break;
      case 'energy': args.energy = asEnum(value, ENERGIES); break;
      case 'type': args.type = asEnum(value, CREATABLE_TYPES) || asText(value, 50); break;
      case 'context': args.context = asText(value, 200); break;
      case 'location': args.location = asText(value, 200); break;
      case 'notes': args.notes = asText(value, 2000); break;
      case 'text': args.text = asText(value, 2000); break;
      case 'body': args.body = asText(value, 4000); break;
      case 'subject': args.subject = asText(value, 200); break;
      case 'question': args.question = asText(value, 400); break;
      case 'query': args.query = asText(value, 200); break;
      case 'id': args.id = asText(value, 20)?.toUpperCase(); break;
      case 'taskId': args.id = asText(value, 20)?.toUpperCase(); args.taskId = args.id; break;
      case 'eventId': args.eventId = asText(value, 20)?.toUpperCase(); break;
      case 'dueTime': args.dueTime = asTime(value); break;
      case 'owner': args.owner = asText(value, 120); break;
      case 'person': args.person = asText(value, 120); break;
      case 'result': args.result = asText(value, 1000); break;
      case 'limit': args.limit = asInt(value, 1, 100); break;
      case 'status': args.status = TASK_STATUS_MAP[foldText(value)]; break;
      case 'to': {
        if (action === 'enviar_documento') {
          const rows = Array.isArray(value) ? value : [value];
          args.to = rows.map((item) => asText(item, 200)).filter(Boolean).slice(0, 20);
        } else {
          args.to = asEmail(value) || asText(value, 60);
        }
        break;
      }
      case 'docId': args.docId = asText(value, 80); break;
      case 'channel': args.channel = asEnum(value, ['email', 'whatsapp', 'telegram']); break;
      case 'chatId': args.chatId = asText(value, 64); break;
      case 'frequency': args.frequency = asEnum(value, FREQUENCIES); break;
      case 'rule': args.rule = Array.isArray(value) ? normalizeWeekdays(value).join('-') : asText(value, 120)?.toUpperCase(); break;
      case 'active': args.active = asBoolean(value); break;
      case 'deepFocus': args.deepFocus = asBoolean(value); break;
      case 'skipHolidays': args.skipHolidays = asBoolean(value); break;
      case 'attendees': {
        const attendeeInfo = normalizeAttendees(value);
        // Nunca se envían nombres al motor (solo emails válidos); si no queda
        // ninguno, se envía [] explícito.
        args.attendees = attendeeInfo.emails;
        if (attendeeInfo.names.length) {
          args.attendeeNames = attendeeInfo.names;
          issues.push(`asistentes sin email: ${attendeeInfo.names.join(', ')} (se conservan en título/notas)`);
        }
        break;
      }
      case 'purpose': args.purpose = asText(value, 500); break;
      case 'requiredOutput': args.requiredOutput = asText(value, 500); break;
      case 'participants': args.participants = asText(value, 300); break;
      case 'kind': {
        const kind = foldText(value);
        if (['meeting', 'reunion', 'reuniones'].includes(kind)) args.kind = 'meeting';
        else if (['recurrence', 'recurrencia', 'rutina', 'recurrente'].includes(kind)) args.kind = 'recurrence';
        break;
      }
      default: break;
    }
    if (args[key] === undefined) issues.push(`valor inválido en ${key}`);
  }
  return { args, issues };
}

/* ------------------------------------------------------------------ */
/* Intención                                                           */
/* ------------------------------------------------------------------ */

function question(text) {
  return { action: 'preguntar', args: { question: text }, issues: [], question: text };
}

/**
 * Valida la intención cruda propuesta por el LLM y aplica las pistas
 * deterministas del texto del usuario (fechas/horas nunca se inventan).
 *
 * @param {object} raw
 * @param {{text:string, todayKey:string, timezone:string, settings?:object}} options
 * @returns {{action:string, args:object, issues:string[], question?:string, originalAction?:string, confidence?:number}}
 */
export function validateIntent(raw, { text = '', todayKey, timezone = 'America/Bogota', settings = {} } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const originalAction = normalizeAction(input.action ?? input.accion ?? input.intent ?? input.tool);
  const confidence = Number.isFinite(Number(input.confidence ?? input.confianza)) ? Math.min(1, Math.max(0, Number(input.confidence ?? input.confianza))) : null;
  const flat = input.args ?? input.arguments ?? input.parametros ?? input.params ?? input;
  const sourceArgs = flat && typeof flat === 'object' && !Array.isArray(flat) ? flat : {};

  if (!originalAction) {
    return { ...question('¿Qué quieres que haga con la agenda? Puedo crear, mover, cancelar o completar citas, capturar ideas, convertir capturas, gestionar rutinas y enviar mensajes.'), originalAction: null, confidence };
  }
  const { args, issues } = sanitizeArgs(originalAction, sourceArgs);

  if (originalAction === 'preguntar') {
    const asked = args.question || asText(input.reply ?? input.respuesta, 400) || '¿Me das un poco más de detalle?';
    return { ...question(asked), originalAction, confidence };
  }

  // Pistas deterministas del texto original (tienen prioridad si son explícitas).
  const dateHint = parseDateHint(text, { todayKey });
  const timeHint = parseTimeHint(text);
  const durationHint = parseDurationHint(text, null);
  const priorityHint = parsePriorityHint(text);
  const typeHint = parseTypeHint(text);
  const energyHint = parseEnergyHint(text);
  const reminderHint = parseReminderHint(text);

  if (dateHint && ['crear_cita', 'mover_cita', 'buscar_huecos', 'convertir_inbox', 'capturar', 'listar_dia', 'crear_tarea', 'crear_meet'].includes(originalAction)) {
    if (originalAction === 'crear_tarea') args.due = dateHint.date;
    else args.date = dateHint.date;
  }
  if (timeHint && ['crear_cita', 'mover_cita', 'convertir_inbox', 'crear_rutina', 'editar_rutina', 'crear_tarea', 'crear_meet'].includes(originalAction)) {
    if (originalAction === 'crear_tarea') args.dueTime = timeHint.time;
    else args.time = timeHint.time;
  }
  if (durationHint && ['crear_cita', 'mover_cita', 'buscar_huecos', 'convertir_inbox', 'crear_rutina', 'editar_rutina', 'crear_meet'].includes(originalAction)) {
    args.durationMin = durationHint;
  }
  if (priorityHint && ['crear_cita', 'capturar', 'convertir_inbox', 'crear_rutina', 'crear_tarea'].includes(originalAction)) {
    args.priority = priorityHint;
  }
  if (typeHint && ['crear_cita', 'crear_rutina', 'convertir_inbox'].includes(originalAction) && !args.type) {
    args.type = typeHint;
  }
  if (energyHint && ['crear_cita', 'crear_rutina'].includes(originalAction) && !args.energy) {
    args.energy = energyHint;
  }
  if (reminderHint !== null && ['crear_cita'].includes(originalAction) && args.reminderMin === undefined) {
    args.reminderMin = reminderHint;
  }
  if (['crear_cita', 'crear_rutina', 'convertir_inbox', 'capturar'].includes(originalAction) && !args.title && !args.text) {
    const derived = deriveTitle(text, { fallback: '' });
    if (derived) args.title = derived;
  }
  if (originalAction === 'crear_tarea' && !args.title) {
    const derived = deriveTaskTitle(text, { fallback: '' });
    if (derived) args.title = derived;
  }
  if (originalAction === 'crear_tarea' && !args.owner) {
    const owner = parseTaskOwner(text);
    if (owner) args.owner = owner;
  }
  if (originalAction === 'crear_meet' && !args.title) {
    const derived = deriveTitle(text, { fallback: '' });
    if (derived) args.title = derived;
  }

  // Reglas de obligatoriedad y guardarraíl "nunca inventar fechas".
  const dateMentioned = !!dateHint || /\b(hoy|mañana|manana|pasado|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})\b/i.test(text);
  const timeMentioned = !!timeHint || /\b\d{1,2}:\d{2}\b/.test(text);

  // Lingo: canonicaliza nombres/entidades antes de validar y ejecutar. Si hay
  // ambigüedad deja el original y guarda meta.lingoWarning; si está vacío, no
  // cambia nada.
  const lingo = canonicalizeAgentArgs(args);
  Object.assign(args, lingo.args);
  if (lingo.warnings.length) issues.push(`lingo ambiguo: ${lingo.warnings.map((row) => row.field).join(', ')}`);

  switch (originalAction) {
    case 'crear_cita': {
      if (!args.title) return { ...question('¿Cómo se llama la cita que quieres agendar?'), originalAction, issues, confidence };
      // Guardarraíl anti-invención: el modelo no puede aportar una fecha que el
      // usuario no haya mencionado (ni explícita ni relativamente).
      if (args.date && !dateMentioned) return { ...question(`No quiero inventar la fecha de «${args.title}». ¿Para qué día la agendo?`), originalAction, issues, confidence };
      if (!args.date && !dateMentioned) return { ...question(`¿Para qué fecha agendo «${args.title}»?`), originalAction, issues, confidence };
      if (!args.date) return { ...question('No logré interpretar la fecha. ¿Me la das como AAAA-MM-DD?'), originalAction, issues, confidence };
      if (!args.time && !timeMentioned) return { ...question(`¿A qué hora agendo «${args.title}» el ${args.date}?`), originalAction, issues, confidence };
      if (!args.time) return { ...question('No logré interpretar la hora. ¿Me la das como HH:MM?'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'mover_cita': {
      if (!args.id && !args.query) return { ...question('¿Cuál cita quieres mover? Dime el título o el ID (AG-0002).'), originalAction, issues, confidence };
      if (args.shiftMinutes !== undefined && !args.date && !args.time) {
        return { action: originalAction, args, issues, confidence };
      }
      if (args.date && !dateMentioned) return { ...question('No quiero inventar la fecha. ¿A qué día muevo la cita?'), originalAction, issues, confidence };
      // Sin fecha pero con hora: se mueve dentro del mismo día de la cita.
      if (!args.date && !args.time) return { ...question('¿A qué hora o fecha la muevo?'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'cancelar_cita':
    case 'completar_cita': {
      if (!args.id && !args.query) return { ...question('¿Cuál cita? Dime el título o el ID (AG-0002).'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'convertir_inbox': {
      if (!args.id && !args.query) return { ...question('¿Cuál captura del inbox convierto? Dime el ID (IN-0002) o parte del texto.'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'crear_rutina': {
      if (!args.title) return { ...question('¿Cómo se llama la rutina?'), originalAction, issues, confidence };
      if (!args.time) return { ...question(`¿A qué hora quieres «${args.title}»?`), originalAction, issues, confidence };
      if (!args.frequency) args.frequency = 'DIARIA';
      if (args.frequency === 'SEMANAL' && !args.rule) return { ...question('¿Qué días de la semana repito la rutina? (ej. LUN,MIE,VIE)'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'editar_rutina': {
      if (!args.id && !args.query) return { ...question('¿Cuál rutina quieres editar? Dime el ID (R-002) o el título.'), originalAction, issues, confidence };
      const patchKeys = Object.keys(args).filter((key) => !['id', 'query'].includes(key));
      if (!patchKeys.length) return { ...question('¿Qué quieres cambiar de la rutina? (hora, duración, días, título…)'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'activar_rutina': {
      if (!args.id && !args.query) return { ...question('¿Cuál rutina activo o pauso? Dime el ID (R-002) o el título.'), originalAction, issues, confidence };
      if (args.active === undefined) {
        args.active = !/pausa|desactiva|apaga/i.test(text);
      }
      return { action: originalAction, args, issues, confidence };
    }
    case 'capturar': {
      if (!args.text && !args.title) return { ...question('¿Qué quieres capturar?'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'enviar_correo': {
      if (!args.to) return { ...question('¿A qué correo propongo el envío?'), originalAction, issues, confidence };
      const body = args.body || args.text;
      if (!body) return { ...question('¿Qué texto quieres que prepare para el correo?'), originalAction, issues, confidence };
      return { action: originalAction, args: { ...args, body }, issues, confidence };
    }
    case 'enviar_whatsapp': {
      if (!args.to) return { ...question('¿A qué número o chat propongo el WhatsApp?'), originalAction, issues, confidence };
      const body = args.text || args.body;
      if (!body) return { ...question('¿Qué mensaje quieres que prepare para WhatsApp?'), originalAction, issues, confidence };
      return { action: originalAction, args: { ...args, text: body }, issues, confidence };
    }
    case 'enviar_telegram': {
      if (!args.chatId) return { ...question('¿A qué chat propongo el mensaje de Telegram?'), originalAction, issues, confidence };
      const body = args.text || args.body;
      if (!body) return { ...question('¿Qué mensaje quieres que prepare para Telegram?'), originalAction, issues, confidence };
      return { action: originalAction, args: { ...args, text: body }, issues, confidence };
    }
    case 'enviar_documento': {
      if (!args.docId) return { ...question('¿Qué documento propongo enviar? Dime el id DOC-…'), originalAction, issues, confidence };
      if (!Array.isArray(args.to) || !args.to.length) return { ...question('¿A quién propongo enviar el documento?'), originalAction, issues, confidence };
      const body = args.body || `Te comparto el documento solicitado.`;
      return { action: originalAction, args: { ...args, body }, issues, confidence };
    }
    case 'crear_tarea': {
      if (!args.title) return { ...question('¿Cuál es la tarea?'), originalAction, issues, confidence };
      // El modelo no puede inventar fecha/hora: solo se aceptan si están en el texto.
      if (args.due && !dateMentioned) {
        delete args.due;
        issues.push('fecha de la tarea descartada: no estaba en el texto');
      }
      if (args.dueTime && !timeMentioned) {
        delete args.dueTime;
        issues.push('hora de la tarea descartada: no estaba en el texto');
      }
      if (args.dueTime && !args.due) delete args.dueTime;
      return { action: originalAction, args, issues, confidence };
    }
    case 'cerrar_tarea':
    case 'reabrir_tarea': {
      if (args.id && !/^TK-\d{1,6}$/i.test(args.id)) {
        args.query = args.query || args.id;
        delete args.id;
        delete args.taskId;
      }
      if (!args.id && !args.query) return { ...question('¿Cuál tarea? Dame el id (TK-0001) o el título.'), originalAction, issues, confidence };
      return { action: originalAction, args, issues, confidence };
    }
    case 'crear_meet': {
      if (args.eventId && !/^AG-\d{1,6}$/i.test(args.eventId)) {
        args.query = args.query || args.eventId;
        delete args.eventId;
      }
      if (!args.eventId && !args.query) {
        if (!args.title) return { ...question('¿Cómo se llama la reunión virtual?'), originalAction, issues, confidence };
        if (args.date && !dateMentioned) return { ...question(`No quiero inventar la fecha de «${args.title}». ¿Para qué día la agendo?`), originalAction, issues, confidence };
        if (!args.date) return { ...question(`¿Para qué fecha agendo «${args.title}»?`), originalAction, issues, confidence };
        if (!args.time && !timeMentioned) return { ...question(`¿A qué hora agendo «${args.title}» el ${args.date}?`), originalAction, issues, confidence };
        if (!args.time) return { ...question('No logré interpretar la hora. ¿Me la das como HH:MM?'), originalAction, issues, confidence };
      }
      return { action: originalAction, args, issues, confidence };
    }
    case 'listar_tareas':
      return { action: originalAction, args, issues, confidence };
    case 'listar_dia':
    case 'buscar_huecos':
    case 'resumen_semana':
    case 'balance':
      return { action: originalAction, args, issues, confidence };
    default:
      return { ...question('No entendí esa instrucción. Puedo crear, mover, cancelar o completar citas, crear/cerrar tareas, agendar reuniones con Meet, capturar ideas, convertir capturas, gestionar rutinas y enviar mensajes.'), originalAction, issues, confidence };
  }
}

/* ------------------------------------------------------------------ */
/* Autocompletado de campos                                            */
/* ------------------------------------------------------------------ */

const PRIORITY_DEFAULTS = Object.freeze({
  P1: { impact: 5, urgency: 5 },
  P2: { impact: 4, urgency: 3 },
  P3: { impact: 3, urgency: 2 }
});

/**
 * Sanea la propuesta de campos del LLM y mezcla las pistas deterministas.
 * Devuelve SIEMPRE campos válidos para el motor de agenda (sin guardar).
 *
 * @param {object} raw
 * @param {{text:string, todayKey:string, timezone:string, settings?:object}} options
 */
export function sanitizeProposal(raw, { text = '', todayKey, timezone = 'America/Bogota', settings = {} } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const camel = input.fields && typeof input.fields === 'object' ? { ...input.fields, ...input } : input;
  const warnings = [];
  const dateHint = parseDateHint(text, { todayKey });
  const timeHint = parseTimeHint(text);
  const durationHint = parseDurationHint(text, null);
  const priorityHint = parsePriorityHint(text);
  const typeHint = parseTypeHint(text);
  const energyHint = parseEnergyHint(text);
  const reminderHint = parseReminderHint(text);

  const date = asDate(camel.date) || (dateHint ? dateHint.date : undefined);
  const time = asTime(camel.time) || (timeHint ? timeHint.time : undefined);
  let title = asText(camel.title, 200) || deriveTitle(text, { fallback: '' });
  if (!title) {
    title = 'Compromiso';
    warnings.push('título deducido por defecto; revísalo antes de guardar');
  }
  const type = asEnum(camel.type, CREATABLE_TYPES) || typeHint || 'Compromiso';
  let priority = asEnum(camel.priority, PRIORITIES) || priorityHint || 'P2';
  // Un P3 propuesto por el modelo no debe degradar una urgencia explícita.
  if (priorityHint === 'P1' && priority !== 'P1') priority = 'P1';
  const defaults = PRIORITY_DEFAULTS[priority] || PRIORITY_DEFAULTS.P2;
  const impact = asInt(camel.impact, 1, 5) ?? defaults.impact;
  const urgency = asInt(camel.urgency, 1, 5) ?? defaults.urgency;
  const energy = asEnum(camel.energy, ENERGIES) || energyHint || (/foco/i.test(type) ? 'Alta' : 'Media');
  const durationFromLlm = asInt(camel.durationMin, 5, 720);
  const durationMin = durationFromLlm ?? durationHint ?? (Number(settings.defaultDurationMin) || 60);
  const reminderMin = asInt(camel.reminderMin, 0, 40320) ?? reminderHint ?? (Number(settings.reminderMin) ?? 10);
  const context = asText(camel.context, 200) || (String(type).toLowerCase() === 'foco' ? 'Sin interrupciones' : '');
  const location = asText(camel.location, 200) || '';
  let notes = asText(camel.notes ?? camel.notas, 2000) || '';
  const attendeeInfo = normalizeAttendees(camel.attendees);
  if (attendeeInfo.names.length) {
    const mention = `${attendeeInfo.names.length > 1 ? 'Asistentes mencionados' : 'Asistente mencionado'}: ${attendeeInfo.names.join(', ')} (sin email)`;
    if (!foldText(notes).includes(foldText(mention))) notes = notes ? `${notes}\n${mention}` : mention;
    warnings.push(`asistente(s) sin email: ${attendeeInfo.names.join(', ')} — guardado en notas`);
  }
  const attendees = attendeeInfo.emails.length ? attendeeInfo.emails : undefined;
  const deepFocus = asBoolean(camel.deepFocus) ?? String(type).toLowerCase() === 'foco';
  if (!durationHint && !durationFromLlm) {
    warnings.push(`duración por defecto (${Math.round(Number(durationMin) || 60)} min)`);
  }
  if (!date) warnings.push('falta la fecha: el usuario debe elegirla antes de guardar');
  if (!time) warnings.push('falta la hora: el usuario debe elegirla antes de guardar');

  const fields = {
    title,
    type: CREATABLE_TYPES.includes(type) ? type : String(type).slice(0, 50),
    priority,
    impact,
    urgency,
    energy,
    context,
    location,
    durationMin: Math.round(Number(durationMin) || 60),
    reminderMin: Math.round(Number(reminderMin) || 0),
    notes,
    deepFocus: !!deepFocus,
    ...(attendees ? { attendees } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {})
  };
  // Instantes listos para el motor (si hay fecha y hora), en la zona configurada.
  if (date && time) {
    try {
      const startIso = isoAtLocal(date, time, timezone);
      fields.start = startIso;
      fields.end = new Date(new Date(startIso).getTime() + fields.durationMin * 60_000).toISOString();
    } catch {
      warnings.push('no se pudo construir el instante local');
    }
  }

  return {
    fields,
    warnings,
    meta: {
      dateSource: dateHint ? dateHint.source : asDate(camel.date) ? 'llm' : 'none',
      timeSource: timeHint ? timeHint.source : asTime(camel.time) ? 'llm' : 'none',
      durationSource: durationHint ? 'hint' : asInt(camel.durationMin, 5, 720) ? 'llm' : 'default',
      timezone
    }
  };
}

/** Pregunta de aclaración por defecto. */
export function clarification(questionText) {
  return question(questionText);
}
