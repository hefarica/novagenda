/**
 * Persistencia segura de Agenda Copilot P95.
 *
 * Garantías:
 *   - Escritura atómica: temporal + fsync + rename + fsync de directorio.
 *   - Rotación de backups: agenda-data.json.bak (último), .bak.1, .bak.2.
 *   - Journal append-only con cadena de hashes (journal.jsonl) por mutación.
 *   - Migración por `version` con backup previo obligatorio.
 *   - JSON corrupto: NO se sobrescribe con el seed; se renombra a `.corrupt`
 *     y la app arranca en SOLO LECTURA con el error visible en /api/health.
 *   - Backup/restore con validación estructural y copia pre-restore.
 *
 * Exporta la misma API histórica (`store`, `nextId`, `addActivity`,
 * `localDateKey`, `isoAtLocal`, `encryptJSON`, `decryptJSON`) más utilidades
 * nuevas, para no romper los módulos existentes (assistant/google/channels).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveKey } from './security/keys.mjs';
import { HttpError } from './http/errors.mjs';

export const STORE_SCHEMA_VERSION = 2;
const TZ = process.env.TIMEZONE || 'America/Bogota';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DATA_FILE = path.join(DATA_DIR, 'agenda-data.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.jsonl');
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
export const APP_BUILD_VERSION = '1.1.0';

/* ------------------------------------------------------------------ */
/* Fechas locales                                                      */
/* ------------------------------------------------------------------ */

function localParts(date = new Date(), timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
}

export function localDateKey(date = new Date()) {
  const parts = localParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isoAtLocal(dateKey, hhmm = '00:00') {
  // America/Bogota es UTC-5 todo el año; para otras zonas se aproxima con Intl.
  // Los eventos externos de Google conservan su propio offset RFC3339.
  if (TZ === 'America/Bogota') return `${dateKey}T${hhmm}:00-05:00`;
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const probe = localParts(guess, TZ);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const seen = Date.UTC(Number(probe.year), Number(probe.month) - 1, Number(probe.day), Number(probe.hour), Number(probe.minute));
  return new Date(guess.getTime() + (target - seen)).toISOString();
}

function addDaysKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Estructura por defecto                                              */
/* ------------------------------------------------------------------ */

function defaultAuth() {
  return {
    configured: false,
    username: null,
    password: null,
    epoch: 0,
    createdAt: null,
    updatedAt: null,
    lastLoginAt: null
  };
}

function defaultData() {
  const today = localDateKey();
  const tomorrow = addDaysKey(today, 1);
  return {
    version: STORE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    settings: {
      timezone: TZ,
      workdayStart: '07:00',
      workdayEnd: '19:00',
      defaultDurationMin: 60,
      reminderMin: 10,
      autoSyncGoogle: true,
      selectedCalendars: {},
      defaultGoogle: null,
      syncIntervalMin: 60,
      googleSyncEnabled: true,
      holidays: [],
      holidayCalendar: null,
      workdays: ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'],
      slotStepMin: 30,
      slotIncludeWeekend: false,
      routineBackfillDays: 7,
      metricRoles: null,
      p95: {
        agendaExecution: 0.85,
        deepFocusDailyMin: 120,
        overdueOpen: 2,
        meetingEffectiveness: 4,
        okrProgress: 0.7,
        weeklyExecution: 0.8,
        weeklyReview: 1
      }
    },
    agenda: [
      { id: 'AG-0001', start: isoAtLocal(today, '07:00'), end: isoAtLocal(today, '07:15'), type: 'Administrativo', title: 'Plan diario + Top 3', result: 'Top 3 definidos y agenda saneada', priority: 'P1', impact: 5, urgency: 5, energy: 'Alta', status: 'Hecho', owner: 'Yo', recurrentId: 'R-001', reminderMin: 10, whatsapp: true, calendar: true, due: today, plannedMin: 15, actualMin: 15, score: 96, deepFocus: false, context: 'Oficina', notes: 'Plantilla P95' },
      { id: 'AG-0002', start: isoAtLocal(today, '07:30'), end: isoAtLocal(today, '09:00'), type: 'Foco', title: 'Bloque de foco #1', result: 'Avance verificable del objetivo principal', priority: 'P1', impact: 5, urgency: 4, energy: 'Alta', status: 'En curso', owner: 'Yo', recurrentId: 'R-002', reminderMin: 10, whatsapp: true, calendar: true, due: today, plannedMin: 90, actualMin: 0, score: 82, deepFocus: true, context: 'Sin interrupciones', notes: 'Proteger de reuniones' },
      { id: 'AG-0003', start: isoAtLocal(today, '11:45'), end: isoAtLocal(today, '12:00'), type: 'Administrativo', title: 'Procesar INBOX', result: 'Inbox procesado/delegado/agendado', priority: 'P2', impact: 4, urgency: 3, energy: 'Media', status: 'Pendiente', owner: 'Yo', recurrentId: 'R-003', reminderMin: 5, whatsapp: true, calendar: true, due: today, plannedMin: 15, actualMin: 0, score: 64, deepFocus: false, context: 'Móvil/Oficina', notes: '' },
      { id: 'AG-0004', start: isoAtLocal(today, '17:30'), end: isoAtLocal(today, '17:45'), type: 'Administrativo', title: 'Cierre diario', result: 'Pendientes cerrados o reprogramados', priority: 'P1', impact: 5, urgency: 4, energy: 'Media', status: 'Pendiente', owner: 'Yo', recurrentId: 'R-004', reminderMin: 10, whatsapp: true, calendar: true, due: today, plannedMin: 15, actualMin: 0, score: 78, deepFocus: false, context: 'Móvil', notes: '' },
      { id: 'AG-0005', start: isoAtLocal(tomorrow, '09:00'), end: isoAtLocal(tomorrow, '09:45'), type: 'Reunión', title: 'Planeación semanal', result: 'Prioridades y responsables definidos', priority: 'P1', impact: 4, urgency: 3, energy: 'Media', status: 'Pendiente', owner: 'Yo', reminderMin: 15, whatsapp: true, calendar: true, due: tomorrow, plannedMin: 45, actualMin: 0, score: 74, deepFocus: false, context: 'Google Meet', notes: '' }
    ],
    inbox: [
      { id: 'IN-0001', capturedAt: new Date().toISOString(), source: 'WhatsApp', type: 'Idea', input: 'Ejemplo: preparar propuesta comercial', context: 'Oficina', actionable: true, due: today, estimatedMin: 30, priority: 'P2', processed: false, agendaId: null, notes: 'Fila ejemplo; puede borrarse' }
    ],
    recurrences: [
      { id: 'R-001', active: true, frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '07:00', durationMin: 15, type: 'Administrativo', title: 'Plan diario + Top 3', result: 'Top 3 definidos', priority: 'P1', impact: 5, urgency: 5, deepFocus: false, reminderMin: 10, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: 'Arranque' },
      { id: 'R-002', active: true, frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '07:30', durationMin: 90, type: 'Foco', title: 'Bloque de foco #1', result: 'Avance principal', priority: 'P1', impact: 5, urgency: 4, deepFocus: true, reminderMin: 10, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: 'Proteger de reuniones' },
      { id: 'R-003', active: true, frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '11:45', durationMin: 15, type: 'Administrativo', title: 'Procesar INBOX', result: 'Inbox a cero ambiguo', priority: 'P2', impact: 4, urgency: 3, deepFocus: false, reminderMin: 5, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: 'Batching' },
      { id: 'R-004', active: true, frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '17:30', durationMin: 15, type: 'Administrativo', title: 'Cierre diario', result: 'Todo cerrado/reprogramado', priority: 'P1', impact: 5, urgency: 4, deepFocus: false, reminderMin: 10, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: 'Cierre cognitivo' },
      { id: 'R-005', active: true, frequency: 'SEMANAL', rule: 'VIE', time: '16:30', durationMin: 45, type: 'Reporte', title: 'Revisión semanal P95', result: 'Informe y plan siguiente semana', priority: 'P1', impact: 5, urgency: 4, deepFocus: false, reminderMin: 30, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: '100% cumplimiento' },
      { id: 'R-006', active: true, frequency: 'MENSUAL', rule: '1', time: '08:00', durationMin: 60, type: 'Reporte', title: 'Revisión mensual y OKR', result: 'Objetivos actualizados', priority: 'P1', impact: 5, urgency: 4, deepFocus: true, reminderMin: 60, whatsapp: true, calendar: true, owner: 'Yo', start: today, end: null, notes: 'Día 1' }
    ],
    meetings: [
      { id: 'MT-001', active: false, name: 'Daily de operación', cadence: 'DIARIA', rule: 'LABORABLES', time: '08:00', durationMin: 15, purpose: 'Alinear bloqueos y prioridades', requiredOutput: '3 prioridades + bloqueos + responsables', owner: 'Yo', participants: 'Equipo', effectiveness: null, whatsappReminder: true, calendar: true, notes: 'Activar solo si agrega valor' },
      { id: 'MT-002', active: false, name: 'Weekly de resultados', cadence: 'SEMANAL', rule: 'VIE', time: '15:30', durationMin: 45, purpose: 'Revisar resultados y decisiones', requiredOutput: 'Decisiones, owners y fechas', owner: 'Yo', participants: 'Equipo', effectiveness: null, whatsappReminder: true, calendar: true, notes: '' },
      { id: 'MT-003', active: false, name: '1:1', cadence: 'SEMANAL', rule: 'MAR', time: '14:00', durationMin: 30, purpose: 'Coaching y desbloqueo', requiredOutput: '1 compromiso concreto', owner: 'Yo', participants: 'Colaborador', effectiveness: null, whatsappReminder: true, calendar: true, notes: '' },
      { id: 'MT-004', active: false, name: 'Revisión estratégica mensual', cadence: 'MENSUAL', rule: '1', time: '09:00', durationMin: 60, purpose: 'Revisar OKR, riesgos y recursos', requiredOutput: 'Cambios de prioridad aprobados', owner: 'Yo', participants: 'Equipo clave', effectiveness: null, whatsappReminder: true, calendar: true, notes: '' }
    ],
    okrs: [
      { id: 'OKR-001', objective: 'Elevar ejecución personal', keyResult: 'Completar ≥85% de compromisos planificados', owner: 'Yo', period: 'Q3 2026', baseline: 0.6, target: 0.85, current: 0.7, unit: '%', progress: 0.8235, confidence: 4, due: addDaysKey(today, 40), priority: 'P1', status: 'En curso', nextAction: 'Cerrar Top 3 diario', notes: 'Modelo P95' },
      { id: 'OKR-002', objective: 'Proteger concentración', keyResult: 'Lograr ≥600 min de foco profundo/semana', owner: 'Yo', period: 'Q3 2026', baseline: 300, target: 600, current: 420, unit: 'min/sem', progress: 0.7, confidence: 3, due: addDaysKey(today, 40), priority: 'P1', status: 'En curso', nextAction: 'Blindar bloques AM', notes: '' }
    ],
    metrics: [],
    googleConnections: [],
    oauthStates: {},
    pendingActions: {},
    notificationLog: {},
    signals: [],
    workflows: [],
    llm: {},
    channelState: {},
    auth: defaultAuth(),
    secrets: {},
    activity: [
      { at: new Date().toISOString(), type: 'system', text: 'Agenda P95 inicializada desde el modelo Excel.' }
    ]
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureShape(target) {
  for (const key of ['agenda', 'inbox', 'recurrences', 'meetings', 'okrs', 'metrics', 'googleConnections', 'activity', 'signals', 'workflows']) {
    if (!Array.isArray(target[key])) target[key] = [];
  }
  for (const key of ['oauthStates', 'pendingActions', 'notificationLog', 'secrets', 'llm', 'channelState']) {
    if (!isPlainObject(target[key])) target[key] = {};
  }
  if (!isPlainObject(target.settings)) {
    target.settings = defaultData().settings;
  } else {
    const defaults = defaultData().settings;
    for (const [key, value] of Object.entries(defaults)) {
      if (target.settings[key] === undefined) target.settings[key] = value;
    }
    if (!isPlainObject(target.settings.p95)) target.settings.p95 = defaults.p95;
  }
  if (!isPlainObject(target.auth)) {
    target.auth = defaultAuth();
  } else {
    const defaults = defaultAuth();
    for (const [key, value] of Object.entries(defaults)) {
      if (target.auth[key] === undefined) target.auth[key] = value;
    }
  }
  if (!Number.isFinite(Number(target.version))) target.version = 1;
  return target;
}

function migrate(target) {
  let version = Number(target.version) || 1;
  if (version > STORE_SCHEMA_VERSION) {
    throw new Error(`El archivo declara version ${version} y esta app soporta ${STORE_SCHEMA_VERSION}.`);
  }
  while (version < STORE_SCHEMA_VERSION) {
    if (version === 1) {
      const now = new Date().toISOString();
      target.auth = isPlainObject(target.auth) ? target.auth : defaultAuth();
      target.secrets = isPlainObject(target.secrets) ? target.secrets : {};
      if (!Array.isArray(target.signals)) target.signals = [];
      if (!Array.isArray(target.workflows)) target.workflows = [];
      if (!isPlainObject(target.llm)) target.llm = {};
      if (!isPlainObject(target.channelState)) target.channelState = {};
      if (!Array.isArray(target.activity)) target.activity = [];
      target.activity.unshift({ at: now, type: 'system', text: `Migración de esquema v1 → v${STORE_SCHEMA_VERSION} completada (backup previo conservado).` });
      target.activity = target.activity.slice(0, 100);
      target.version = 2;
      version = 2;
      continue;
    }
    throw new Error(`No existe migración desde la versión ${version}.`);
  }
  target.version = STORE_SCHEMA_VERSION;
  return target;
}

/* ------------------------------------------------------------------ */
/* Estado en memoria                                                   */
/* ------------------------------------------------------------------ */

const BOOT_AT = new Date().toISOString();
let data = null;
let readOnly = false;
let loadError = null;
let loadWarning = null;
let persistError = null;
let lastSavedAt = null;
let restoreInfo = null;
let writeChain = Promise.resolve();
const journal = { seq: 0, digest: 'GENESIS', entries: 0, lastAt: null };

/* ------------------------------------------------------------------ */
/* Utilidades de disco                                                 */
/* ------------------------------------------------------------------ */

function timestampCompact() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function serialize(value = data) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fsyncDirSync(dir) {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}

async function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.promises.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* best-effort */ }
}

function rotateBackupsSync() {
  if (!fs.existsSync(DATA_FILE)) return;
  const bak = `${DATA_FILE}.bak`;
  try {
    if (fs.existsSync(`${bak}.2`)) fs.unlinkSync(`${bak}.2`);
    if (fs.existsSync(`${bak}.1`)) fs.renameSync(`${bak}.1`, `${bak}.2`);
    if (fs.existsSync(bak)) fs.renameSync(bak, `${bak}.1`);
    fs.renameSync(DATA_FILE, bak);
  } catch {
    /* La rotación es best-effort: el rename final mantiene la integridad. */
  }
}

async function rotateBackupsAsync() {
  if (!fs.existsSync(DATA_FILE)) return;
  const bak = `${DATA_FILE}.bak`;
  try {
    if (fs.existsSync(`${bak}.2`)) await fs.promises.unlink(`${bak}.2`);
    if (fs.existsSync(`${bak}.1`)) await fs.promises.rename(`${bak}.1`, `${bak}.2`);
    if (fs.existsSync(bak)) await fs.promises.rename(bak, `${bak}.1`);
    await fs.promises.rename(DATA_FILE, bak);
  } catch {
    /* Best-effort. */
  }
}

function writeAtomicSync(snapshot) {
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, snapshot, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  rotateBackupsSync();
  fs.renameSync(tmp, DATA_FILE);
  fsyncDirSync(DATA_DIR);
}

async function writeAtomicAsync(snapshot, label) {
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(snapshot, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rotateBackupsAsync();
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
  await fsyncDir(DATA_DIR);
  lastSavedAt = new Date().toISOString();
  await appendJournal(label);
}

function pruneTmpFiles() {
  try {
    const cutoff = Date.now() - 60 * 60_000;
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.endsWith('.tmp')) continue;
      const full = path.join(DATA_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Journal                                                            */
/* ------------------------------------------------------------------ */

function initJournal() {
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    journal.entries = lines.length;
    const last = lines[lines.length - 1];
    if (last) {
      const parsed = JSON.parse(last);
      journal.seq = Number(parsed.seq) || 0;
      journal.digest = String(parsed.digest || 'GENESIS');
      journal.lastAt = parsed.at || null;
    }
  } catch {
    /* Journal nuevo o ilegible: se reinicia la cadena de forma segura. */
  }
}

async function rotateJournalIfNeeded() {
  try {
    const stat = await fs.promises.stat(JOURNAL_FILE);
    if (stat.size <= JOURNAL_MAX_BYTES) return;
    const target = path.join(DATA_DIR, 'journal.1.jsonl');
    try { await fs.promises.unlink(target); } catch { /* ignore */ }
    await fs.promises.rename(JOURNAL_FILE, target);
    journal.entries = 0;
  } catch { /* ignore */ }
}

async function appendJournal(label) {
  try {
    const entry = {
      seq: journal.seq + 1,
      at: new Date().toISOString(),
      label: String(label || 'mutate').slice(0, 120),
      version: data?.version ?? null,
      counts: {
        agenda: Array.isArray(data?.agenda) ? data.agenda.length : 0,
        inbox: Array.isArray(data?.inbox) ? data.inbox.length : 0,
        recurrences: Array.isArray(data?.recurrences) ? data.recurrences.length : 0,
        okrs: Array.isArray(data?.okrs) ? data.okrs.length : 0
      },
      prev: journal.digest
    };
    entry.digest = crypto.createHash('sha256')
      .update(JSON.stringify({ seq: entry.seq, at: entry.at, label: entry.label, counts: entry.counts, prev: entry.prev }))
      .digest('hex');
    const handle = await fs.promises.open(JOURNAL_FILE, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    journal.seq = entry.seq;
    journal.digest = entry.digest;
    journal.lastAt = entry.at;
    journal.entries += 1;
    await rotateJournalIfNeeded();
  } catch {
    /* El journal nunca debe impedir guardar los datos. */
  }
}

/* ------------------------------------------------------------------ */
/* Carga inicial y recuperación                                        */
/* ------------------------------------------------------------------ */

function recoverMissingFile() {
  if (fs.existsSync(DATA_FILE)) return null;
  const bak = `${DATA_FILE}.bak`;
  if (fs.existsSync(bak)) {
    try {
      fs.renameSync(bak, DATA_FILE);
      return 'Datos restaurados desde agenda-data.json.bak (la ejecución anterior no terminó de guardar).';
    } catch { /* sigue con temporales */ }
  }
  try {
    const prefix = `${path.basename(DATA_FILE)}.`;
    const candidates = fs.readdirSync(DATA_DIR).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort().reverse();
    for (const candidate of candidates) {
      const full = path.join(DATA_DIR, candidate);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        JSON.parse(raw);
        fs.writeFileSync(DATA_FILE, raw);
        fs.unlinkSync(full);
        return 'Datos restaurados desde un archivo temporal íntegro.';
      } catch { /* siguiente */ }
    }
  } catch { /* ignore */ }
  return null;
}

function quarantineCorrupt(reason) {
  readOnly = true;
  const base = `${DATA_FILE}.corrupt`;
  const target = fs.existsSync(base) ? `${base}-${timestampCompact()}` : base;
  try {
    fs.renameSync(DATA_FILE, target);
    loadError = `${reason}. El archivo original se conservó como ${path.basename(target)} y la app arranca en SOLO LECTURA.`;
  } catch (err) {
    loadError = `${reason}. No se pudo mover el archivo (${err.code || err.message}); la app arranca en SOLO LECTURA.`;
  }
}

function backupBeforeMigration(version) {
  const target = `${DATA_FILE}.pre-v${version}-${timestampCompact()}.json`;
  fs.copyFileSync(DATA_FILE, target);
  return target;
}

function loadData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    readOnly = true;
    loadError = `No se pudo crear el directorio de datos (${DATA_DIR}): ${err.message}`;
    return defaultData();
  }
  pruneTmpFiles();
  const recovered = recoverMissingFile();
  if (recovered) loadWarning = recovered;

  if (!fs.existsSync(DATA_FILE)) {
    const seed = defaultData();
    try {
      writeAtomicSync(serialize(seed));
      lastSavedAt = new Date().toISOString();
    } catch (err) {
      readOnly = true;
      loadError = `No se pudo crear ${path.basename(DATA_FILE)}: ${err.message}. La app arranca en SOLO LECTURA.`;
    }
    return seed;
  }

  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    readOnly = true;
    loadError = `No se pudo leer ${path.basename(DATA_FILE)}: ${err.message}`;
    return defaultData();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantineCorrupt(`JSON corrupto en ${path.basename(DATA_FILE)} (${err.message})`);
    return defaultData();
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.agenda) || !isPlainObject(parsed.settings)) {
    quarantineCorrupt('Estructura no reconocida (faltan agenda o settings)');
    return defaultData();
  }

  ensureShape(parsed);
  const originalVersion = Number(parsed.version) || 1;
  if (originalVersion > STORE_SCHEMA_VERSION) {
    readOnly = true;
    loadError = `El archivo declara version ${originalVersion} y esta app soporta ${STORE_SCHEMA_VERSION}. Arrancando en SOLO LECTURA para no dañar datos.`;
    return parsed;
  }
  if (originalVersion < STORE_SCHEMA_VERSION) {
    let backupPath = null;
    try {
      backupPath = backupBeforeMigration(originalVersion);
    } catch (err) {
      readOnly = true;
      loadError = `No se pudo crear el backup previo a la migración: ${err.message}. Arrancando en SOLO LECTURA.`;
      return parsed;
    }
    try {
      const migrated = migrate(parsed);
      writeAtomicSync(serialize(migrated));
      lastSavedAt = new Date().toISOString();
      loadWarning = `Migración v${originalVersion} → v${STORE_SCHEMA_VERSION} aplicada. Backup previo: ${path.basename(backupPath)}.`;
      return migrated;
    } catch (err) {
      readOnly = true;
      loadError = `Falló la migración desde v${originalVersion}: ${err.message}. Arrancando en SOLO LECTURA (backup en ${path.basename(String(backupPath))}).`;
      return parsed;
    }
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

function readOnlyError() {
  return new HttpError(503, 'STORE_READ_ONLY', readOnlyDetailForClients());
}

export function readOnlyDetailForClients() {
  const detail = loadError || 'El almacén está en modo solo lectura.';
  return `No se pueden guardar cambios: ${detail} Restaura un backup con POST /api/backup/restore.`;
}

function persist(label = 'mutate') {
  if (readOnly) throw readOnlyError();
  const snapshot = serialize(data);
  const run = async () => {
    try {
      await writeAtomicAsync(snapshot, label);
      persistError = null;
    } catch (err) {
      persistError = `${err.code ? `${err.code}: ` : ''}${err.message}`;
      throw err;
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

export const store = {
  get() {
    return data;
  },

  /**
   * Aplica una mutación síncrona y persiste de forma atómica.
   * @param {(data:any)=>any} fn
   * @param {{label?:string}} [options]
   */
  async mutate(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('store.mutate requiere una función');
    if (readOnly) throw readOnlyError();
    const result = await fn(data);
    await persist(options.label || 'mutate');
    return result;
  },

  /**
   * Reset de demo: conserva autenticación, secretos, conexiones Google y ajustes.
   */
  async reset() {
    if (readOnly) throw readOnlyError();
    const previous = data;
    const fresh = defaultData();
    fresh.auth = previous.auth || fresh.auth;
    fresh.secrets = previous.secrets || {};
    fresh.googleConnections = Array.isArray(previous.googleConnections) ? previous.googleConnections : [];
    fresh.settings = {
      ...fresh.settings,
      ...(previous.settings || {}),
      p95: { ...fresh.settings.p95, ...((previous.settings && previous.settings.p95) || {}) }
    };
    fresh.activity.unshift({ at: new Date().toISOString(), type: 'system', text: 'Reset de demo ejecutado (agenda, inbox, rutinas, reuniones, OKR y métricas reiniciados; auth, secretos, Google y ajustes conservados).' });
    fresh.activity = fresh.activity.slice(0, 100);
    data = fresh;
    await persist('reset-demo');
    return data;
  },

  /** Payload de backup descargable. */
  backupPayload({ includeSecrets = true } = {}) {
    const snapshot = JSON.parse(JSON.stringify(data));
    if (!includeSecrets && snapshot.secrets) snapshot.secrets = {};
    return {
      app: 'Agenda Copilot P95',
      appVersion: APP_BUILD_VERSION,
      schemaVersion: snapshot.version,
      exportedAt: new Date().toISOString(),
      timezone: TZ,
      includesSecrets: includeSecrets,
      data: snapshot
    };
  },

  /**
   * Restaura un backup validado. Funciona incluso en modo solo lectura (es la
   * vía de recuperación). Crea una copia pre-restore en DATA_DIR.
   * @param {object} payload
   */
  async restore(payload) {
    const raw = payload && isPlainObject(payload) && isPlainObject(payload.data) ? payload.data : payload;
    if (!isPlainObject(raw)) throw new HttpError(400, 'INVALID_BACKUP', 'El backup debe ser un objeto JSON.', { field: 'data' });
    if (!Array.isArray(raw.agenda) || !isPlainObject(raw.settings)) {
      throw new HttpError(400, 'INVALID_BACKUP', 'El backup no contiene agenda/settings válidos.', { field: 'data' });
    }
    // Una copia sin secretos no debe borrar el vault ni las conexiones de esta
    // instalación: se conservan los actuales. Una copia con secretos sí los
    // reemplaza, que es el comportamiento de una restauración completa.
    const preserveSecrets = !isPlainObject(raw.secrets) || Object.keys(raw.secrets).length === 0;
    const previousSecrets = data?.secrets && isPlainObject(data.secrets) ? data.secrets : {};
    const previousGoogleConnections = Array.isArray(data?.googleConnections) ? data.googleConnections : null;
    const clone = JSON.parse(JSON.stringify(raw));
    ensureShape(clone);
    if (Number(clone.version) > STORE_SCHEMA_VERSION) {
      throw new HttpError(400, 'INVALID_BACKUP', `El backup es de una versión más nueva (${clone.version} > ${STORE_SCHEMA_VERSION}).`, { field: 'data.version' });
    }
    const migrated = migrate(clone);
    if (fs.existsSync(DATA_FILE)) {
      const pre = `${DATA_FILE}.pre-restore-${timestampCompact()}.json`;
      try { fs.copyFileSync(DATA_FILE, pre); } catch { /* no bloquea la restauración */ }
      prunePreRestoreFiles();
    }
    const wasReadOnly = readOnly;
    readOnly = false;
    loadError = null;
    try {
      data = migrated;
      if (preserveSecrets) {
        data.secrets = previousSecrets;
        if (previousGoogleConnections) data.googleConnections = previousGoogleConnections;
      }
      await persist('backup-restore');
    } catch (err) {
      readOnly = wasReadOnly;
      throw err;
    }
    restoreInfo = { at: new Date().toISOString(), counts: { agenda: data.agenda.length, inbox: data.inbox.length, recurrences: data.recurrences.length, okrs: data.okrs.length } };
    return { restored: true, version: data.version, counts: restoreInfo.counts, restoredAt: restoreInfo.at, preservedSecrets: preserveSecrets };
  },

  status() {
    return {
      readOnly,
      version: data?.version ?? null,
      schemaVersion: STORE_SCHEMA_VERSION,
      file: DATA_FILE,
      dataDir: DATA_DIR,
      loadError,
      loadWarning,
      persistError,
      lastSavedAt,
      bootAt: BOOT_AT,
      restoredAt: restoreInfo?.at || null,
      journal: { seq: journal.seq, digest: journal.digest, entries: journal.entries, lastAt: journal.lastAt, file: JOURNAL_FILE },
      counts: {
        agenda: Array.isArray(data?.agenda) ? data.agenda.length : 0,
        inbox: Array.isArray(data?.inbox) ? data.inbox.length : 0,
        recurrences: Array.isArray(data?.recurrences) ? data.recurrences.length : 0,
        meetings: Array.isArray(data?.meetings) ? data.meetings.length : 0,
        okrs: Array.isArray(data?.okrs) ? data.okrs.length : 0,
        metrics: Array.isArray(data?.metrics) ? data.metrics.length : 0,
        activity: Array.isArray(data?.activity) ? data.activity.length : 0
      }
    };
  },

  isReadOnly() {
    return readOnly;
  },

  /** Espera a que se completen las escrituras pendientes. */
  async flush() {
    try {
      await writeChain;
    } catch { /* el error ya quedó registrado en persistError */ }
    return { lastSavedAt, persistError };
  },

  /** Últimas entradas del journal (más recientes al final). */
  journalTail(limit = 50) {
    const max = Math.min(Math.max(Number(limit) || 50, 1), 500);
    try {
      const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      return lines.slice(-max).map((line) => {
        try { return JSON.parse(line); } catch { return { corrupt: true, raw: line.slice(0, 200) }; }
      });
    } catch {
      return [];
    }
  }
};

function prunePreRestoreFiles() {
  try {
    const prefix = `${path.basename(DATA_FILE)}.pre-restore-`;
    const files = fs.readdirSync(DATA_DIR).filter((name) => name.startsWith(prefix)).sort();
    while (files.length > 3) {
      const oldest = files.shift();
      if (oldest) fs.unlinkSync(path.join(DATA_DIR, oldest));
    }
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Helpers de dominio compartidos con los módulos heredados            */
/* ------------------------------------------------------------------ */

export function nextId(prefix, items) {
  const max = items.reduce((acc, item) => Math.max(acc, Number(String(item.id || '').match(/(\d+)$/)?.[1] || 0)), 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

export function addActivity(type, text, meta = {}) {
  const current = store.get();
  if (!Array.isArray(current.activity)) current.activity = [];
  current.activity.unshift({ at: new Date().toISOString(), type, text, ...meta });
  current.activity = current.activity.slice(0, 100);
}

function legacyEncryptionKey() {
  return crypto.createHash('sha256').update(process.env.APP_SECRET || 'dev-only-change-me').digest();
}

export function encryptJSON(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('json-v1'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 2,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url')
  };
}

export function decryptJSON(box) {
  if (!box || typeof box !== 'object') throw new Error('Formato cifrado inválido.');
  const keys = [deriveKey('json-v1'), legacyEncryptionKey()];
  let lastError = null;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No se pudo descifrar el valor (¿cambió la clave maestra?): ${lastError ? lastError.message : 'error desconocido'}`);
}

/* ------------------------------------------------------------------ */
/* Arranque del módulo                                                 */
/* ------------------------------------------------------------------ */

data = loadData();
initJournal();
if (loadWarning) console.warn(`[store] ${loadWarning}`);
if (loadError) console.error(`[store] ${loadError}`);
