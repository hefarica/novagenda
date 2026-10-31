/**
 * Registro de ejecutores inyectables de la Oficina.
 *
 * Una propuesta aprobada se delega al ejecutor de su canal (o de su kind):
 *   - `document` / `draft` / `note`: escribe un borrador local en DATA_DIR.
 *   - `read` / `none` / `internal`: no-op de solo lectura.
 *   - `email`: Gmail a través de `lib/google.mjs` (requiere cuenta conectada).
 *   - `whatsapp` / `telegram`: adaptadores de `lib/channels.mjs` (requieren canal activo).
 *
 * Cualquier módulo puede inyectar su propio ejecutor con `registerExecutor`.
 * Interfaz: `{ name, available():boolean|Promise<boolean>, execute(proposal), revert?(proposal) }`.
 * Si no hay ejecutor disponible, `execute` responde 503 EXECUTOR_UNAVAILABLE y
 * la propuesta NO se marca como ejecutada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.mjs';

const registry = new Map();
let builtinsInstalled = false;

const ALIASES = Object.freeze({
  draft: 'document',
  note: 'document',
  documento: 'document',
  internal: 'read',
  none: 'read',
  lectura: 'read'
});

function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

function safeFileId(value) {
  return String(value || 'propuesta').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function documentPath(proposal) {
  return path.join(dataDir(), 'office-documents', `${safeFileId(proposal.id)}.md`);
}

function renderDocument(proposal) {
  const recipients = Array.isArray(proposal.recipients) && proposal.recipients.length ? proposal.recipients.join(', ') : 'interno';
  return [
    `# ${proposal.subject || 'Borrador de la oficina'}`,
    '',
    `- Propuesta: ${proposal.id}`,
    `- Nivel: ${proposal.level}`,
    `- Canal: ${proposal.channel}`,
    `- Destinatarios: ${recipients}`,
    `- Creada: ${proposal.createdAt || ''}`,
    '',
    '---',
    '',
    proposal.body || ''
  ].join('\n');
}

const documentExecutor = {
  name: 'document',
  async available() {
    return true;
  },
  async execute(proposal) {
    const file = documentPath(proposal);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const content = renderDocument(proposal);
    await fs.promises.writeFile(file, content, 'utf8');
    return {
      ok: true,
      executor: 'document',
      detail: 'Borrador guardado en la carpeta de documentos de la oficina.',
      artifacts: [{ type: 'document', path: file, bytes: Buffer.byteLength(content, 'utf8') }]
    };
  },
  async revert(proposal) {
    const file = documentPath(proposal);
    try {
      await fs.promises.unlink(file);
      return { ok: true, detail: 'Borrador eliminado.' };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, detail: 'El borrador ya no existía.' };
      throw error;
    }
  }
};

const readExecutor = {
  name: 'read-only',
  async available() {
    return true;
  },
  async execute() {
    return { ok: true, executor: 'read-only', detail: 'Operación de lectura sin efectos externos.', artifacts: [] };
  }
};

const emailExecutor = {
  name: 'email-gmail',
  async available() {
    return Array.isArray(store.get().googleConnections) && store.get().googleConnections.length > 0;
  },
  async execute(proposal) {
    const recipients = (Array.isArray(proposal.recipients) ? proposal.recipients : [])
      .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim()));
    if (!recipients.length) throw new Error('La propuesta no tiene destinatarios de correo válidos.');
    const gmail = await import('../google.mjs');
    const sent = [];
    for (const to of recipients) {
      const result = await gmail.sendGmail({ to, subject: proposal.subject, body: proposal.body });
      sent.push({ to, id: result?.id || null });
    }
    return { ok: true, executor: 'email-gmail', detail: `Correo enviado a ${sent.length} destinatario(s).`, artifacts: sent };
  }
};

const whatsappExecutor = {
  name: 'whatsapp-cloud',
  async available() {
    try {
      const channels = await import('../channels.mjs');
      return channels.channelStatus().whatsapp.configured === true;
    } catch {
      return false;
    }
  },
  async execute(proposal) {
    const recipients = (Array.isArray(proposal.recipients) ? proposal.recipients : []).filter(Boolean);
    if (!recipients.length) throw new Error('La propuesta no tiene destinatarios de WhatsApp.');
    const channels = await import('../channels.mjs');
    const sent = [];
    for (const to of recipients) {
      const result = await channels.sendWhatsApp(to, proposal.body);
      sent.push({ to, id: result?.messages?.[0]?.id || null });
    }
    return { ok: true, executor: 'whatsapp-cloud', detail: `WhatsApp enviado a ${sent.length} destinatario(s).`, artifacts: sent };
  }
};

const telegramExecutor = {
  name: 'telegram-bot',
  async available() {
    try {
      const channels = await import('../channels.mjs');
      return channels.channelStatus().telegram.configured === true;
    } catch {
      return false;
    }
  },
  async execute(proposal) {
    const recipients = (Array.isArray(proposal.recipients) ? proposal.recipients : []).filter(Boolean);
    if (!recipients.length) throw new Error('La propuesta no tiene destinatarios de Telegram.');
    const channels = await import('../channels.mjs');
    const sent = [];
    for (const chatId of recipients) {
      const result = await channels.sendTelegram(chatId, proposal.body);
      sent.push({ to: chatId, id: result?.result?.message_id || null });
    }
    return { ok: true, executor: 'telegram-bot', detail: `Telegram enviado a ${sent.length} destinatario(s).`, artifacts: sent };
  }
};

function validateExecutor(channel, executor) {
  const id = String(channel || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) throw new Error(`Canal de ejecutor inválido: ${channel}`);
  if (!executor || typeof executor !== 'object') throw new Error('El ejecutor debe ser un objeto.');
  if (typeof executor.execute !== 'function') throw new Error('El ejecutor necesita execute(proposal).');
  if (executor.available !== undefined && typeof executor.available !== 'function') throw new Error('available debe ser función.');
  if (executor.revert !== undefined && typeof executor.revert !== 'function') throw new Error('revert debe ser función.');
  return id;
}

/**
 * Inyecta/sobrescribe un ejecutor.
 * @param {string} channel
 * @param {{name?:string, available?:Function, execute:Function, revert?:Function}} executor
 */
export function registerExecutor(channel, executor) {
  const id = validateExecutor(channel, executor);
  registry.set(id, {
    name: String(executor.name || `executor:${id}`),
    available: executor.available || (async () => true),
    execute: executor.execute,
    revert: executor.revert || null
  });
  return id;
}

/** @param {string} channel */
export function unregisterExecutor(channel) {
  return registry.delete(String(channel || '').toLowerCase());
}

/** @returns {string[]} */
export function listExecutorIds() {
  ensureBuiltins();
  return [...registry.keys()].sort();
}

/** Instala los ejecutores nativos una sola vez (sin pisar inyecciones). */
export function ensureBuiltins() {
  if (builtinsInstalled) return;
  builtinsInstalled = true;
  const registerIfMissing = (channel, executor) => {
    if (!registry.has(channel)) registerExecutor(channel, executor);
  };
  registerIfMissing('document', documentExecutor);
  registerIfMissing('draft', documentExecutor);
  registerIfMissing('note', documentExecutor);
  registerIfMissing('read', readExecutor);
  registerIfMissing('none', readExecutor);
  registerIfMissing('internal', readExecutor);
  registerIfMissing('email', emailExecutor);
  registerIfMissing('whatsapp', whatsappExecutor);
  registerIfMissing('telegram', telegramExecutor);
}

/**
 * Resuelve el ejecutor de una propuesta (canal primero, luego kind, luego alias).
 * @param {any} proposal
 * @returns {Promise<{id:string, executor:object, available:boolean}|null>}
 */
export async function resolveExecutor(proposal) {
  ensureBuiltins();
  const candidates = [];
  const channel = String(proposal?.channel || '').toLowerCase();
  const kind = String(proposal?.kind || '').toLowerCase();
  for (const value of [channel, kind]) {
    if (!value) continue;
    const canonical = ALIASES[value] || value;
    for (const candidate of [canonical, value]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    const executor = registry.get(candidate);
    if (!executor) continue;
    let available = false;
    try {
      available = (await executor.available()) === true;
    } catch {
      available = false;
    }
    return { id: candidate, executor, available };
  }
  return null;
}

/**
 * Estado de ejecutores para la UI (sin secretos).
 * @returns {Promise<{items:object[], count:number}>}
 */
export async function executorStatus() {
  ensureBuiltins();
  const items = [];
  for (const [id, executor] of registry.entries()) {
    let available = false;
    try {
      available = (await executor.available()) === true;
    } catch {
      available = false;
    }
    items.push({ id, name: executor.name, available, revert: !!executor.revert });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, count: items.length };
}
