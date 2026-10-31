/**
 * Guardia de correo: reglas por remitente/asunto y cuarentena revisable.
 *
 * - Las reglas viven en `data.mailRules.rules` y se evalúan antes de que el
 *   auto-borrador redacte una respuesta.
 * - Los mensajes retenidos viven en `data.quarantine.items` con estado
 *   `held` → `released` | `discarded`.
 * - Este módulo no envía nada: solo clasifica y guarda.
 */
import { store } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';

export const RULE_FIELDS = Object.freeze(['from', 'subject']);
export const RULE_MATCHES = Object.freeze(['contains', 'equals', 'domain']);
export const RULE_ACTIONS = Object.freeze(['quarantine', 'skip']);

function nowIso() {
  return new Date().toISOString();
}

export function ensureMailRules(data) {
  if (!data.mailRules || typeof data.mailRules !== 'object' || !Array.isArray(data.mailRules.rules)) {
    data.mailRules = { version: 1, rules: [], updatedAt: nowIso() };
  }
  return data.mailRules;
}

export function ensureQuarantine(data) {
  if (!data.quarantine || typeof data.quarantine !== 'object' || !Array.isArray(data.quarantine.items)) {
    data.quarantine = { version: 1, items: [], updatedAt: nowIso() };
  }
  return data.quarantine;
}

function normalizeAction(value) {
  const action = String(value || '').toLowerCase();
  if (!RULE_ACTIONS.includes(action)) {
    throw new ValidationError('action', 'INVALID_VALUE', `action debe ser: ${RULE_ACTIONS.join(', ')}.`);
  }
  return action;
}

function normalizeField(value) {
  const field = String(value || '').toLowerCase();
  if (!RULE_FIELDS.includes(field)) {
    throw new ValidationError('field', 'INVALID_VALUE', `field debe ser: ${RULE_FIELDS.join(', ')}.`);
  }
  return field;
}

function normalizeMatch(value) {
  const match = String(value || 'contains').toLowerCase();
  if (!RULE_MATCHES.includes(match)) {
    throw new ValidationError('match', 'INVALID_VALUE', `match debe ser: ${RULE_MATCHES.join(', ')}.`);
  }
  return match;
}

function normalizeValue(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new ValidationError('value', 'REQUIRED', 'El texto de la regla es obligatorio.');
  if (text.length > 120) throw new ValidationError('value', 'TOO_LONG', 'El texto supera 120 caracteres.');
  return text;
}

function nextRuleId(rules) {
  let max = 0;
  for (const rule of rules) {
    const match = /^MR-(\d+)$/.exec(String(rule.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `MR-${String(max + 1).padStart(4, '0')}`;
}

function nextQuarantineId(items) {
  let max = 0;
  for (const item of items) {
    const match = /^Q-(\d+)$/.exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Q-${String(max + 1).padStart(4, '0')}`;
}

export function listRules() {
  const data = store.get();
  return ensureMailRules(data).rules.map((rule) => ({ ...rule }));
}

export async function addRule({ field, match, value, action, enabled = true } = {}) {
  const clean = {
    field: normalizeField(field),
    match: normalizeMatch(match),
    value: normalizeValue(value),
    action: normalizeAction(action),
    enabled: enabled !== false
  };
  let created = null;
  await store.mutate((data) => {
    const rules = ensureMailRules(data);
    created = { id: nextRuleId(rules.rules), ...clean, createdAt: nowIso() };
    rules.rules.push(created);
    rules.updatedAt = created.createdAt;
  }, { label: 'mail-rule-add' });
  return { ...created };
}

export async function deleteRule(id) {
  let removed = null;
  await store.mutate((data) => {
    const rules = ensureMailRules(data);
    const index = rules.rules.findIndex((rule) => rule.id === id);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la regla ${id}.`);
    removed = rules.rules.splice(index, 1)[0];
    rules.updatedAt = nowIso();
  }, { label: 'mail-rule-delete' });
  return { ...removed };
}

function valueFor(message, field) {
  if (field === 'subject') return String(message?.subject || '');
  const from = message?.from || {};
  return String(from.email || from.address || from.name || '');
}

export function evaluateMessage(message) {
  const rules = listRules().filter((rule) => rule.enabled);
  for (const rule of rules) {
    const raw = valueFor(message, rule.field);
    const haystack = raw.toLowerCase();
    const needle = rule.value.toLowerCase();
    let hit = false;
    if (rule.match === 'domain') {
      const domain = (haystack.split('@')[1] || '').trim();
      hit = domain === needle || domain.endsWith(`.${needle}`);
    } else if (rule.match === 'equals') {
      hit = haystack.trim() === needle;
    } else {
      hit = haystack.includes(needle);
    }
    if (hit) {
      return {
        action: rule.action,
        ruleId: rule.id,
        reason: `${rule.field} ${rule.match === 'domain' ? 'dominio' : rule.match === 'equals' ? 'igual a' : 'contiene'} «${rule.value}»`
      };
    }
  }
  return { action: null, ruleId: null, reason: null };
}

export function publicQuarantine(item) {
  return {
    id: item.id,
    accountId: item.accountId,
    uid: item.uid,
    from: item.from,
    subject: item.subject,
    date: item.date,
    reason: item.reason,
    status: item.status,
    createdAt: item.createdAt,
    releasedAt: item.releasedAt || null,
    discardedAt: item.discardedAt || null
  };
}

export function listQuarantine({ status = 'held', limit = 50 } = {}) {
  const data = store.get();
  const items = ensureQuarantine(data).items
    .filter((item) => !status || item.status === status)
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 100))
    .map(publicQuarantine);
  return { items, total: items.length };
}

export async function holdMessage(accountId, message, reason) {
  let created = null;
  await store.mutate((data) => {
    const quarantine = ensureQuarantine(data);
    const existing = quarantine.items.find((item) => item.accountId === accountId && Number(item.uid) === Number(message.uid));
    if (existing) {
      if (existing.status !== 'held') {
        existing.status = 'held';
        existing.reason = String(reason || existing.reason || '').slice(0, 240);
        existing.releasedAt = null;
        existing.discardedAt = null;
      }
      created = existing;
      return;
    }
    created = {
      id: nextQuarantineId(quarantine.items),
      accountId,
      uid: Number(message.uid),
      from: message.from || null,
      subject: String(message.subject || '').slice(0, 200),
      date: message.date || null,
      reason: String(reason || 'Retenido por regla').slice(0, 240),
      status: 'held',
      createdAt: nowIso()
    };
    quarantine.items.push(created);
    quarantine.updatedAt = created.createdAt;
  }, { label: 'mail-quarantine-hold' });
  return publicQuarantine(created);
}

export function getQuarantine(id) {
  const data = store.get();
  const item = ensureQuarantine(data).items.find((entry) => entry.id === id);
  return item ? publicQuarantine(item) : null;
}

export async function releaseQuarantine(id) {
  let item = null;
  await store.mutate((data) => {
    const quarantine = ensureQuarantine(data);
    const found = quarantine.items.find((entry) => entry.id === id);
    if (!found) throw new HttpError(404, 'NOT_FOUND', `No existe el elemento ${id}.`);
    if (found.status === 'released') {
      item = found;
      return;
    }
    found.status = 'released';
    found.releasedAt = nowIso();
    quarantine.updatedAt = found.releasedAt;
    item = found;
  }, { label: 'mail-quarantine-release' });
  return publicQuarantine(item);
}

export async function discardQuarantine(id) {
  let item = null;
  await store.mutate((data) => {
    const quarantine = ensureQuarantine(data);
    const found = quarantine.items.find((entry) => entry.id === id);
    if (!found) throw new HttpError(404, 'NOT_FOUND', `No existe el elemento ${id}.`);
    found.status = 'discarded';
    found.discardedAt = nowIso();
    quarantine.updatedAt = found.discardedAt;
    item = found;
  }, { label: 'mail-quarantine-discard' });
  return publicQuarantine(item);
}
