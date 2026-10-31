/**
 * Motor de propuestas de la Oficina: creación con riesgo/opiniones, aprobación
 * firmada (HMAC-SHA256 + nonce + TTL 30 min), rechazo, ejecución única delegada
 * a un ejecutor inyectable y deshacer de borradores N1.
 *
 * Invariante central: nada sale al exterior sin que la política lo permita y,
 * cuando exige aprobación, sin una aprobación firmada válida para ese payload.
 */
import { store } from '../store.mjs';
import { isPlainObject, text, enumValue, arrayOf, pickFields, assertObject } from '../validate.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import {
  nowIso, randomNonce, randomCode, hashCode, hmacHex, hmacVerify, sha256Hex,
  signedToken, safeEqual, sanitizeValue
} from './canonical.mjs';
import {
  ensureOffice, officeState, nextProposalId, publicProposal, publicApproval,
  findRawProposal, pruneProposals
} from './state.mjs';
import {
  DEFAULT_MODE, normalizeMode, isMode, modeInfo, levelInfo, deriveLevel, decidePolicy,
  policyCatalog, DEFAULT_VOICE_THRESHOLD
} from './policy.mjs';
import { collectKnownContacts, collectOwnDomains, learnContacts } from './contacts.mjs';
import { assessRisk } from './risk.mjs';
import { rubricOpinions, computeVoice, maybeLlmOpinion } from './opinions.mjs';
import { appendLedger } from './ledger.mjs';
import { resolveExecutor } from './executors.mjs';

export const PROPOSAL_FIELDS = Object.freeze(['kind', 'channel', 'recipients', 'subject', 'body', 'attachments', 'meta']);
export const CHANNELS = Object.freeze(['email', 'whatsapp', 'telegram', 'document', 'note', 'read', 'webhook', 'none', 'internal']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'held', 'approved', 'rejected', 'executing', 'executed', 'failed', 'reverted']);
const APPROVAL_AUDIENCE = 'office-approval';

/* ------------------------------------------------------------------ */
/* Validación de cuerpos                                               */
/* ------------------------------------------------------------------ */

/** @param {unknown} body */
export function validateProposalInput(body) {
  const input = pickFields(body, PROPOSAL_FIELDS);
  const kind = text(input.kind, {
    field: 'kind', required: true, max: 40, allowEmpty: false,
    pattern: /^[a-z][a-z0-9_-]{1,39}$/,
    patternMessage: 'kind debe ser un slug en minúsculas (letras, números, _ o -).'
  });
  const channel = enumValue(input.channel, CHANNELS, { field: 'channel', required: true });
  const recipients = arrayOf(
    input.recipients,
    (item, index) => text(item, { field: `recipients[${index}]`, required: true, max: 200, allowEmpty: false }),
    { field: 'recipients', max: 50, defaultValue: [] }
  );
  if (['email', 'whatsapp', 'telegram'].includes(channel) && recipients.length === 0) {
    throw new ValidationError('recipients', 'REQUIRED', `El canal ${channel} requiere al menos un destinatario.`);
  }
  const subject = text(input.subject, { field: 'subject', max: 300, defaultValue: '' });
  const bodyText = text(input.body, { field: 'body', required: true, max: 20_000, allowEmpty: false });
  const attachments = arrayOf(
    input.attachments,
    (item, index) => text(item, { field: `attachments[${index}]`, required: true, max: 500, allowEmpty: false }),
    { field: 'attachments', max: 10, defaultValue: [] }
  );
  const meta = input.meta === undefined ? {} : assertObject(input.meta, 'meta');
  const metaSize = Buffer.byteLength(JSON.stringify(meta), 'utf8');
  if (metaSize > 4_000) throw new ValidationError('meta', 'TOO_LONG', 'meta supera 4000 bytes serializados.');
  return { kind, channel, recipients, subject, body: bodyText, attachments, meta };
}

/** @param {unknown} body */
export function validateApproveInput(body) {
  const input = pickFields(body, ['by', 'note']);
  return {
    by: text(input.by, { field: 'by', required: true, max: 80, allowEmpty: false }),
    note: text(input.note, { field: 'note', max: 300, defaultValue: '' })
  };
}

/** @param {unknown} body */
export function validateRejectInput(body) {
  const input = pickFields(body, ['by', 'reason']);
  return {
    by: text(input.by, { field: 'by', required: true, max: 80, allowEmpty: false }),
    reason: text(input.reason, { field: 'reason', max: 500, defaultValue: '' })
  };
}

/** @param {unknown} body */
export function validateExecuteInput(body) {
  const input = pickFields(body, ['code'], { allowEmpty: true });
  if (input.code === undefined || input.code === null || String(input.code).trim() === '') {
    return { code: null };
  }
  return { code: text(input.code, { field: 'code', required: true, max: 12, allowEmpty: false }).toUpperCase() };
}

/** @param {unknown} body */
export function validateUndoInput(body) {
  const input = pickFields(body, ['by'], { allowEmpty: true });
  return { by: text(input.by, { field: 'by', max: 80, defaultValue: 'api' }) };
}

/** @param {unknown} body */
export function validateModeInput(body) {
  const input = pickFields(body, ['mode', 'by']);
  const mode = normalizeMode(input.mode);
  if (!mode) throw new ValidationError('mode', 'INVALID_VALUE', `mode debe ser uno de: ${policyCatalog().modes.map((item) => item.id).join(', ')}.`);
  return { mode, by: text(input.by, { field: 'by', max: 80, defaultValue: 'api' }) };
}

/**
 * @param {unknown} body
 * @param {string} field
 * @param {readonly string[]} allowed
 */
export function validateEnumField(body, field, allowed) {
  const value = text(body?.[field], { field, max: 40, defaultValue: null });
  if (value === null) return null;
  return enumValue(value.toLowerCase(), allowed, { field, required: true });
}

/* ------------------------------------------------------------------ */
/* Payload firmado y hash de contenido                                 */
/* ------------------------------------------------------------------ */

/**
 * Contenido inmutable que queda ligado a la aprobación. Si algo cambia después
 * de aprobar (body, destinatarios, adjuntos…), el hash ya no coincide y la
 * ejecución se rechaza con SIGNATURE_INVALID.
 * @param {any} proposal
 */
export function proposalContent(proposal) {
  return {
    id: proposal.id,
    kind: proposal.kind,
    channel: proposal.channel,
    recipients: Array.isArray(proposal.recipients) ? proposal.recipients : [],
    subject: proposal.subject || '',
    body: proposal.body || '',
    attachments: Array.isArray(proposal.attachments) ? proposal.attachments : [],
    meta: proposal.meta || {},
    level: proposal.level,
    risk: {
      score: Number(proposal.risk?.score) || 0,
      flags: (proposal.risk?.flags || []).map((flag) => (typeof flag === 'string' ? flag : flag.code))
    }
  };
}

/** @param {any} proposal */
export function proposalPayloadHash(proposal) {
  return sha256Hex(proposalContent(proposal));
}

function signedApprovalPayload(proposal, approval) {
  return {
    v: 1,
    aud: APPROVAL_AUDIENCE,
    proposalId: proposal.id,
    payloadHash: approval.payloadHash,
    level: proposal.level,
    by: approval.by,
    nonce: approval.nonce,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt
  };
}

function buildApproval(proposal, { by, note = '', auto = false, ttlSec = 1800 } = {}) {
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + Math.max(60, Number(ttlSec) || 1800) * 1000).toISOString();
  const nonce = randomNonce(16);
  const payloadHash = proposalPayloadHash(proposal);
  const approval = {
    by: String(by || 'jefe').slice(0, 80),
    at: issuedAt,
    note: String(note || '').slice(0, 300),
    auto: auto === true,
    alg: 'HMAC-SHA256',
    nonce,
    issuedAt,
    expiresAt,
    ttlSec: Math.max(60, Number(ttlSec) || 1800),
    payloadHash
  };
  approval.signedPayload = signedApprovalPayload(proposal, approval);
  approval.signature = hmacHex(approval.signedPayload);
  approval.token = signedToken(approval.signedPayload, approval.signature);
  return approval;
}

/**
 * Verifica firma, TTL y (si aplica) código N3. No muta nada.
 * @param {any} proposal
 * @param {string|null} code
 */
export function verifyApproval(proposal, code = null) {
  const approval = proposal?.approval;
  if (!approval || typeof approval !== 'object') throw new HttpError(409, 'NOT_APPROVED', 'La propuesta no tiene una aprobación válida.');
  const expiresMs = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) throw new HttpError(409, 'APPROVAL_EXPIRED', 'La aprobación caducó (TTL 30 min). Vuelve a aprobar la propuesta.');
  const currentHash = proposalPayloadHash(proposal);
  if (currentHash !== approval.payloadHash) {
    throw new HttpError(409, 'SIGNATURE_INVALID', 'El payload de la propuesta cambió después de aprobarse: firma inválida.');
  }
  const signed = approval.signedPayload || signedApprovalPayload(proposal, approval);
  if (!hmacVerify(signed, approval.signature)) {
    throw new HttpError(409, 'SIGNATURE_INVALID', 'La firma HMAC de la aprobación no es válida.');
  }
  if (proposal.level === 'N3') {
    if (approval.codeUsedAt) throw new HttpError(409, 'CODE_USED', 'El código N3 ya se usó para ejecutar esta propuesta.');
    if (!code) throw new HttpError(400, 'CODE_REQUIRED', 'La propuesta N3 exige el código de 6 caracteres entregado al aprobar.');
    const expected = String(approval.codeHash || '');
    const provided = hashCode(String(code).trim().toUpperCase(), approval.nonce);
    if (!expected || !safeEqual(provided, expected)) throw new HttpError(409, 'INVALID_CODE', 'Código N3 incorrecto.');
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Tarjeta de aprobación                                               */
/* ------------------------------------------------------------------ */

const STATUS_LABELS = Object.freeze({
  pending: 'Pendiente de aprobación',
  held: 'Retenida (modo sombra)',
  approved: 'Aprobada, lista para ejecutar',
  rejected: 'Rechazada',
  executing: 'Ejecutando…',
  executed: 'Ejecutada',
  failed: 'Fallo de ejecución',
  reverted: 'Deshecha'
});

/** @param {any} proposal */
export function buildCard(proposal) {
  const flags = (proposal.risk?.flags || []).map((flag) => (typeof flag === 'string' ? flag : flag.code));
  const opinions = Array.isArray(proposal.opinions) ? proposal.opinions : [];
  const approvals = opinions.filter((opinion) => opinion.verdict === 'aprobar').length;
  const status = proposal.status || 'pending';
  const actions = [];
  if (status === 'pending' || status === 'held') actions.push('approve', 'reject');
  else if (status === 'approved') actions.push('execute', 'reject');
  else if (status === 'executed' && proposal.level === 'N1' && proposal.undoUntil && Date.parse(proposal.undoUntil) > Date.now()) actions.push('undo');
  const summary = `Riesgo ${proposal.risk?.score ?? 0}/10 · voz ${Number(proposal.voice || 0).toFixed(2)} · ${approvals}/${opinions.length} roles a favor`;
  const text = [
    `${proposal.level} · ${String(proposal.channel || '').toUpperCase()} · ${STATUS_LABELS[status] || status}`,
    `Para: ${Array.isArray(proposal.recipients) && proposal.recipients.length ? proposal.recipients.join(', ') : 'interno'}`,
    `Asunto: ${proposal.subject || '(sin asunto)'}`,
    `Riesgo: ${proposal.risk?.score ?? 0}/10 · Flags: ${flags.length ? flags.join(', ') : 'ninguno'}`,
    summary,
    proposal.policy?.reason ? `Política: ${proposal.policy.reason}` : ''
  ].filter(Boolean).join('\n');
  return {
    title: `${proposal.level} · ${proposal.channel} · ${proposal.id}`,
    subtitle: proposal.subject || '(sin asunto)',
    summary,
    level: proposal.level,
    channel: proposal.channel,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    recipients: (Array.isArray(proposal.recipients) ? proposal.recipients : []).slice(0, 5),
    riskScore: proposal.risk?.score ?? 0,
    flags,
    voice: Number(proposal.voice || 0),
    approvals,
    opinions: opinions.length,
    requiresApproval: proposal.policy?.requiresApproval === true,
    requiresCode: proposal.policy?.requiresCode === true,
    actions,
    text
  };
}

/* ------------------------------------------------------------------ */
/* Creación                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{input:object, actor?:string, useLlm?:boolean, forceApproval?:boolean}} options
 */
export async function createProposal({ input, actor = 'api', useLlm = true, forceApproval = false }) {
  // La ruta valida y normaliza; el módulo también acepta llamadas directas y
  // aplica los mismos defaults para no romperse con campos ausentes.
  const normalizedInput = {
    ...input,
    recipients: Array.isArray(input?.recipients) ? [...input.recipients] : [],
    attachments: Array.isArray(input?.attachments) ? [...input.attachments] : [],
    subject: typeof input?.subject === 'string' ? input.subject : '',
    body: typeof input?.body === 'string' ? input.body : '',
    meta: isPlainObject(input?.meta) ? input.meta : {}
  };
  const data = store.get();
  const knownContacts = collectKnownContacts(data);
  const ownDomains = collectOwnDomains(data);
  const risk = assessRisk(normalizedInput, { knownContacts, ownDomains, data });
  const level = deriveLevel({ kind: normalizedInput.kind, channel: normalizedInput.channel, risk, meta: normalizedInput.meta });
  const opinions = rubricOpinions({ risk, level, channel: normalizedInput.channel, recipients: normalizedInput.recipients });
  const voice = computeVoice(opinions);
  const llmOpinion = useLlm ? await maybeLlmOpinion({ proposal: normalizedInput, risk, level }) : null;
  const knownContact = risk.knownContact;

  let created = null;
  let autoFailed = null;

  await store.mutate((current) => {
    const office = ensureOffice(current);
    const decision = decidePolicy({
      level,
      mode: office.mode,
      riskScore: risk.score,
      knownContact,
      voice,
      voiceThreshold: office.voiceThreshold || DEFAULT_VOICE_THRESHOLD
    });
    // Gate explícito para correo saliente: aunque el modo sea total/autónomo,
    // una propuesta marcada `forceApproval` nunca se ejecuta al crearse.
    const effectiveDecision = forceApproval === true && decision.action === 'auto'
      ? {
          ...decision,
          action: 'approve',
          autoExecute: false,
          requiresApproval: true,
          requiresCode: false,
          reason: 'Aprobación obligatoria: correo saliente con gate de Oficina.'
        }
      : decision;
    const proposal = {
      id: nextProposalId(office),
      kind: normalizedInput.kind,
      channel: normalizedInput.channel,
      recipients: [...normalizedInput.recipients],
      subject: normalizedInput.subject,
      body: normalizedInput.body,
      attachments: [...normalizedInput.attachments],
      meta: normalizedInput.meta,
      level,
      risk: {
        score: risk.score,
        maxScore: risk.maxScore,
        flags: risk.flags.map((flag) => ({ ...flag })),
        signals: { ...risk.signals }
      },
      flags: risk.flags.map((flag) => flag.code),
      opinions,
      voice,
      llmOpinion,
      knownContact,
      modeAtCreation: office.mode,
      policy: effectiveDecision,
      status: effectiveDecision.action === 'hold' ? 'held' : effectiveDecision.action === 'auto' ? 'approved' : 'pending',
      createdBy: String(actor || 'api').slice(0, 80),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approval: null,
      execution: null,
      autoError: null,
      card: null
    };
    if (effectiveDecision.action === 'auto') {
      proposal.approval = buildApproval(proposal, {
        by: 'policy:auto',
        note: effectiveDecision.reason,
        auto: true,
        ttlSec: office.approvalTtlSec
      });
      proposal.approvedAt = proposal.approval.at;
      proposal.approvedBy = 'policy:auto';
    }
    proposal.card = buildCard(proposal);
    office.proposals.unshift(proposal);
    pruneProposals(office);
    appendLedger(current, {
      actor: proposal.createdBy,
      action: 'proposal.created',
      payload: {
        proposalId: proposal.id,
        kind: proposal.kind,
        channel: proposal.channel,
        level: proposal.level,
        riskScore: proposal.risk.score,
        flags: proposal.flags,
        recipients: proposal.recipients.length,
        mode: office.mode,
        status: proposal.status
      }
    });
    if (effectiveDecision.action === 'auto') {
      appendLedger(current, {
        actor: 'policy:auto',
        action: 'proposal.approved',
        payload: { proposalId: proposal.id, by: 'policy:auto', auto: true, payloadHash: proposal.approval.payloadHash, mode: office.mode }
      });
    }
    office.updatedAt = nowIso();
    created = proposal;
  }, { label: 'office-proposal-create' });

  if (created?.status === 'approved' && created.policy?.autoExecute === true) {
    try {
      const executed = await executeProposal({ id: created.id, actor: 'policy:auto', auto: true });
      return { proposal: executed.proposal, code: null, auto: true, executed: true };
    } catch (error) {
      autoFailed = error;
      const blocked = await markAutoBlocked(created.id, error);
      return { proposal: blocked, code: null, auto: true, executed: false, error: { code: error.code || 'EXECUTOR_FAILED', message: error.message } };
    }
  }
  return { proposal: publicProposal(findRawProposal(created.id)), code: null, auto: false, executed: false, autoFailed: autoFailed ? { code: autoFailed.code, message: autoFailed.message } : null };
}

async function markAutoBlocked(proposalId, error) {
  let output = null;
  const status = error?.code === 'SHADOW_MODE' ? 'held' : 'approved';
  await store.mutate((current) => {
    const office = ensureOffice(current);
    const proposal = office.proposals.find((item) => item.id === proposalId);
    if (!proposal) return;
    proposal.status = status;
    proposal.autoError = { code: error?.code || 'EXECUTOR_FAILED', message: String(error?.message || 'Error de ejecución automática').slice(0, 300), at: nowIso() };
    proposal.updatedAt = nowIso();
    proposal.card = buildCard(proposal);
    appendLedger(current, {
      actor: 'policy:auto',
      action: 'proposal.execution_blocked',
      payload: { proposalId, code: proposal.autoError.code, mode: office.mode }
    });
    office.updatedAt = nowIso();
    output = publicProposal(proposal);
  }, { label: 'office-proposal-auto-blocked' });
  return output;
}

/* ------------------------------------------------------------------ */
/* Consulta                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{status?:string|null, limit?:number, offset?:number}} [options]
 */
/**
 * Revisa una propuesta pendiente: recalcula riesgo y nivel con el texto nuevo,
 * guarda historial y exige una nueva aprobación. Nunca edita una ya aprobada.
 * @param {{id:string, subject?:string, body?:string, by?:string}} options
 */
export async function reviseProposal({ id, subject = undefined, body = undefined, by = 'owner' } = {}) {
  const data = store.get();
  const current = findRawProposal(id);
  if (!current) throw new HttpError(404, 'NOT_FOUND', `No existe la propuesta ${id}.`);
  if (current.status !== 'pending' && current.status !== 'held') {
    throw new HttpError(409, 'INVALID_STATE', `No se puede editar una propuesta en estado ${current.status}.`, {
      details: { status: current.status }
    });
  }
  const nextSubject = subject === undefined ? String(current.subject || '') : String(subject).trim();
  const nextBody = body === undefined ? String(current.body || '') : String(body);
  if (!nextBody.trim()) throw new ValidationError('body', 'REQUIRED', 'El cuerpo no puede quedar vacío.');
  if (nextBody.length > 20000) throw new ValidationError('body', 'TOO_LONG', 'El cuerpo supera 20.000 caracteres.');
  if (nextSubject.length > 250) throw new ValidationError('subject', 'TOO_LONG', 'El asunto supera 250 caracteres.');

  const knownContacts = collectKnownContacts(data);
  const ownDomains = collectOwnDomains(data);
  const risk = assessRisk({
    kind: current.kind,
    channel: current.channel,
    recipients: current.recipients,
    subject: nextSubject,
    body: nextBody,
    attachments: current.attachments,
    meta: current.meta
  }, { knownContacts, ownDomains, data });
  const level = deriveLevel({ kind: current.kind, channel: current.channel, risk, meta: current.meta });

  let output = null;
  await store.mutate((currentData) => {
    const office = ensureOffice(currentData);
    const target = (office.proposals || []).find((proposal) => proposal.id === id);
    if (!target) throw new HttpError(404, 'NOT_FOUND', `No existe la propuesta ${id}.`);
    if (target.status !== 'pending' && target.status !== 'held') {
      throw new HttpError(409, 'INVALID_STATE', `No se puede editar una propuesta en estado ${target.status}.`);
    }
    const previous = {
      at: nowIso(),
      by: String(by || 'owner').slice(0, 80),
      subject: target.subject,
      bodyHash: sha256Hex({ body: target.body || '' }),
      level: target.level,
      riskScore: Number(target.risk?.score) || 0
    };
    target.revisions = [...(Array.isArray(target.revisions) ? target.revisions : []), previous].slice(-20);
    target.subject = nextSubject;
    target.body = nextBody;
    target.level = level;
    target.risk = {
      score: risk.score,
      maxScore: risk.maxScore,
      flags: risk.flags.map((flag) => ({ ...flag })),
      signals: { ...risk.signals }
    };
    target.flags = risk.flags.map((flag) => flag.code);
    target.updatedAt = nowIso();
    appendLedger(currentData, {
      actor: `revision:${String(by || 'owner').slice(0, 60)}`,
      action: 'propuesta.revisada',
      payload: {
        proposalId: id,
        previousLevel: previous.level,
        newLevel: level,
        previousRisk: previous.riskScore,
        newRisk: risk.score,
        previousBodyHash: previous.bodyHash,
        newBodyHash: sha256Hex({ body: nextBody })
      }
    });
    output = publicProposal(target);
  }, { label: 'office-proposal-revise' });
  return output;
}
export function listProposals({ status = null, limit = 50, offset = 0 } = {}) {
  const office = officeState(store.get());
  const filtered = status ? office.proposals.filter((proposal) => proposal.status === status) : office.proposals;
  const size = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)));
  const skip = Math.max(0, Math.round(Number(offset) || 0));
  const page = filtered.slice(skip, skip + size).map((proposal) => publicProposal(proposal));
  return { items: page, count: page.length, total: filtered.length, status: status || null };
}

/** @param {string} proposalId */
export function getProposal(proposalId) {
  const proposal = findRawProposal(proposalId);
  if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${proposalId} no encontrada.`);
  return publicProposal(proposal);
}

/** Resumen para el panel de la oficina. */
export function officeStatus() {
  const office = officeState(store.get());
  const counts = {};
  for (const proposal of office.proposals) counts[proposal.status] = (counts[proposal.status] || 0) + 1;
  const ledger = Array.isArray(office.ledger) ? office.ledger : [];
  return {
    mode: office.mode,
    modeInfo: modeInfo(office.mode),
    proposals: office.proposals.length,
    counts,
    pending: (counts.pending || 0) + (counts.held || 0),
    approved: counts.approved || 0,
    executed: counts.executed || 0,
    contacts: office.contacts.length,
    ledger: {
      entries: ledger.length,
      head: ledger.length ? ledger[ledger.length - 1].hash : null,
      lastAt: ledger.length ? ledger[ledger.length - 1].ts : null
    },
    undoWindowSec: office.undoWindowSec,
    approvalTtlSec: office.approvalTtlSec,
    voiceThreshold: office.voiceThreshold,
    updatedAt: office.updatedAt
  };
}

/** Vista del modo actual + catálogo. */
export function modeView() {
  const office = officeState(store.get());
  const catalog = policyCatalog();
  return {
    mode: office.mode,
    info: modeInfo(office.mode),
    levels: catalog.levels,
    modes: catalog.modes,
    defaultMode: DEFAULT_MODE,
    voiceThreshold: office.voiceThreshold,
    undoWindowSec: office.undoWindowSec,
    approvalTtlSec: office.approvalTtlSec,
    updatedAt: office.modeUpdatedAt || office.updatedAt,
    updatedBy: office.modeUpdatedBy || null
  };
}

/**
 * Cambia el modo (persistido en store.office.mode) y lo audita.
 * @param {{mode:string, by?:string}} input
 */
export async function changeMode({ mode, by = 'api' }) {
  const normalized = normalizeMode(mode);
  if (!normalized || !isMode(normalized)) {
    throw new ValidationError('mode', 'INVALID_VALUE', `mode debe ser uno de: ${policyCatalog().modes.map((item) => item.id).join(', ')}.`);
  }
  let result;
  await store.mutate((current) => {
    const office = ensureOffice(current);
    const previous = office.mode;
    office.mode = normalized;
    office.modeUpdatedAt = nowIso();
    office.modeUpdatedBy = String(by || 'api').slice(0, 80);
    office.updatedAt = nowIso();
    appendLedger(current, {
      actor: office.modeUpdatedBy,
      action: 'mode.changed',
      payload: { previous, mode: normalized, by: office.modeUpdatedBy }
    });
    result = { mode: normalized, previous, updatedAt: office.modeUpdatedAt, updatedBy: office.modeUpdatedBy };
  }, { label: 'office-mode-change' });
  return { ...result, ...modeView() };
}

/* ------------------------------------------------------------------ */
/* Aprobación / rechazo                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {{id:string, by:string, note?:string}} input
 */
export async function approveProposal({ id, by, note = '' }) {
  let code = null;
  let output = null;
  await store.mutate((current) => {
    const office = ensureOffice(current);
    const proposal = office.proposals.find((item) => item.id === id);
    if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
    if (proposal.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'La propuesta ya está aprobada.');
    if (proposal.status === 'executed') throw new HttpError(409, 'ALREADY_EXECUTED', 'La propuesta ya fue ejecutada.');
    if (proposal.status === 'executing') throw new HttpError(409, 'EXECUTE_IN_PROGRESS', 'La propuesta se está ejecutando.');
    if (proposal.status === 'rejected') throw new HttpError(409, 'REJECTED', 'La propuesta fue rechazada.');
    if (proposal.status === 'reverted') throw new HttpError(409, 'REVERTED', 'La propuesta fue deshecha.');
    if (!['pending', 'held'].includes(proposal.status)) {
      throw new HttpError(409, 'INVALID_STATE', `No se puede aprobar una propuesta en estado ${proposal.status}.`);
    }
    const approval = buildApproval(proposal, { by, note, auto: false, ttlSec: office.approvalTtlSec });
    if (proposal.level === 'N3') {
      code = randomCode(6);
      approval.codeHash = hashCode(code, approval.nonce);
      approval.codeExpiresAt = approval.expiresAt;
      approval.codeUsedAt = null;
    }
    proposal.approval = approval;
    proposal.status = 'approved';
    proposal.approvedAt = approval.at;
    proposal.approvedBy = approval.by;
    proposal.updatedAt = nowIso();
    proposal.card = buildCard(proposal);
    learnContacts(current, proposal.recipients);
    appendLedger(current, {
      actor: approval.by,
      action: 'proposal.approved',
      payload: {
        proposalId: proposal.id,
        level: proposal.level,
        by: approval.by,
        auto: false,
        payloadHash: approval.payloadHash,
        expiresAt: approval.expiresAt,
        requiresCode: proposal.level === 'N3',
        riskScore: proposal.risk?.score ?? null
      }
    });
    office.updatedAt = nowIso();
    output = { proposal: publicProposal(proposal), approval: publicApproval(approval), code, card: proposal.card };
  }, { label: 'office-proposal-approve' });
  return output;
}

/**
 * @param {{id:string, by:string, reason?:string}} input
 */
export async function rejectProposal({ id, by, reason = '' }) {
  let output = null;
  await store.mutate((current) => {
    const office = ensureOffice(current);
    const proposal = office.proposals.find((item) => item.id === id);
    if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
    if (proposal.status === 'executed') throw new HttpError(409, 'ALREADY_EXECUTED', 'La propuesta ya fue ejecutada.');
    if (proposal.status === 'executing') throw new HttpError(409, 'EXECUTE_IN_PROGRESS', 'La propuesta se está ejecutando.');
    if (proposal.status === 'rejected') throw new HttpError(409, 'ALREADY_REJECTED', 'La propuesta ya fue rechazada.');
    if (proposal.status === 'reverted') throw new HttpError(409, 'REVERTED', 'La propuesta fue deshecha.');
    proposal.status = 'rejected';
    proposal.rejectedAt = nowIso();
    proposal.rejectedBy = String(by || 'jefe').slice(0, 80);
    proposal.rejectReason = String(reason || '').slice(0, 500);
    proposal.updatedAt = nowIso();
    proposal.card = buildCard(proposal);
    appendLedger(current, {
      actor: proposal.rejectedBy,
      action: 'proposal.rejected',
      payload: { proposalId: proposal.id, level: proposal.level, by: proposal.rejectedBy, reason: proposal.rejectReason }
    });
    office.updatedAt = nowIso();
    output = publicProposal(proposal);
  }, { label: 'office-proposal-reject' });
  return output;
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */

const NOT_APPROVED_CODES = Object.freeze({
  pending: 'NOT_APPROVED',
  held: 'NOT_APPROVED',
  rejected: 'REJECTED',
  reverted: 'REVERTED'
});

/**
 * Ejecuta una propuesta aprobada. Verifica modo, estado, firma, TTL, código N3
 * y disponibilidad del ejecutor ANTES de marcarla; la marca `executing` de forma
 * atómica para que un segundo execute concurrente sea rechazado.
 *
 * @param {{id:string, code?:string|null, actor?:string, auto?:boolean}} input
 */
export async function executeProposal({ id, code = null, actor = 'api', auto = false } = {}) {
  const data = store.get();
  const office = ensureOffice(data);
  if (office.mode === 'sombra') {
    throw new HttpError(409, 'SHADOW_MODE', 'Modo sombra: nada sale de la oficina. Cambia de modo para ejecutar.');
  }
  const proposal = findRawProposal(id, data);
  if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
  if (proposal.status === 'executed') throw new HttpError(409, 'ALREADY_EXECUTED', 'La propuesta ya fue ejecutada.');
  if (proposal.status === 'executing') throw new HttpError(409, 'EXECUTE_IN_PROGRESS', 'La propuesta ya se está ejecutando.');
  if (proposal.status !== 'approved') {
    throw new HttpError(409, NOT_APPROVED_CODES[proposal.status] || 'NOT_APPROVED', `La propuesta no está aprobada (estado ${proposal.status}).`);
  }
  verifyApproval(proposal, code);

  const resolved = await resolveExecutor(proposal);
  if (!resolved || resolved.available !== true) {
    throw new HttpError(503, 'EXECUTOR_UNAVAILABLE', `No hay ejecutor disponible para el canal "${proposal.channel}". La propuesta NO se ha marcado como ejecutada.`, {
      details: { channel: proposal.channel, executor: resolved?.id || null }
    });
  }

  // Claim atómico: re-verifica todo y pasa a executing. Un segundo execute falla aquí.
  await store.mutate((current) => {
    const officeNow = ensureOffice(current);
    if (officeNow.mode === 'sombra') throw new HttpError(409, 'SHADOW_MODE', 'Modo sombra: nada sale de la oficina.');
    const currentProposal = officeNow.proposals.find((item) => item.id === id);
    if (!currentProposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
    if (currentProposal.status === 'executed') throw new HttpError(409, 'ALREADY_EXECUTED', 'La propuesta ya fue ejecutada.');
    if (currentProposal.status !== 'approved') throw new HttpError(409, 'NOT_APPROVED', `La propuesta no está aprobada (estado ${currentProposal.status}).`);
    verifyApproval(currentProposal, code);
    currentProposal.status = 'executing';
    currentProposal.executingAt = nowIso();
    currentProposal.updatedAt = nowIso();
    currentProposal.card = buildCard(currentProposal);
    officeNow.updatedAt = nowIso();
  }, { label: 'office-proposal-claim' });

  const executing = findRawProposal(id);
  let result;
  try {
    result = await resolved.executor.execute(executing, { actor, auto });
  } catch (error) {
    const message = String(error?.message || 'Error del ejecutor').slice(0, 500);
    await store.mutate((current) => {
      const officeNow = ensureOffice(current);
      const failed = officeNow.proposals.find((item) => item.id === id);
      if (!failed) return;
      failed.status = 'failed';
      failed.failedAt = nowIso();
      failed.error = message;
      failed.updatedAt = nowIso();
      failed.card = buildCard(failed);
      appendLedger(current, {
        actor: String(actor || 'api').slice(0, 80),
        action: 'proposal.execution_failed',
        payload: { proposalId: id, executor: resolved.id, error: message }
      });
      officeNow.updatedAt = nowIso();
    }, { label: 'office-proposal-execute-failed' });
    throw new HttpError(502, 'EXECUTOR_FAILED', `El ejecutor falló: ${message}`, { details: { executor: resolved.id } });
  }

  const safeResult = sanitizeValue(result, { maxString: 300, maxArray: 10, depth: 4 });
  let finalProposal = null;
  await store.mutate((current) => {
    const officeNow = ensureOffice(current);
    const executed = officeNow.proposals.find((item) => item.id === id);
    if (!executed) return;
    const at = nowIso();
    executed.status = 'executed';
    executed.executedAt = at;
    executed.executedBy = String(actor || 'api').slice(0, 80);
    executed.execution = {
      executor: resolved.id,
      executorName: resolved.executor.name,
      at,
      actor: executed.executedBy,
      auto: auto === true,
      result: safeResult
    };
    if (executed.level === 'N1') {
      executed.undoUntil = new Date(Date.now() + (Number(officeNow.undoWindowSec) || 300) * 1000).toISOString();
    }
    if (executed.level === 'N3' && executed.approval) executed.approval.codeUsedAt = at;
    executed.updatedAt = at;
    executed.card = buildCard(executed);
    appendLedger(current, {
      actor: executed.executedBy,
      action: 'proposal.executed',
      payload: {
        proposalId: id,
        executor: resolved.id,
        level: executed.level,
        auto: auto === true,
        artifacts: Array.isArray(result?.artifacts) ? result.artifacts.length : 0,
        ok: result?.ok !== false
      }
    });
    officeNow.updatedAt = at;
    finalProposal = publicProposal(executed);
  }, { label: 'office-proposal-executed' });

  return { proposal: finalProposal, execution: finalProposal?.execution || null };
}

/**
 * Deshace un borrador N1 dentro de su ventana.
 * @param {{id:string, by?:string}} input
 */
export async function undoProposal({ id, by = 'api' }) {
  const data = store.get();
  const proposal = findRawProposal(id, data);
  if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
  if (proposal.status !== 'executed') throw new HttpError(409, 'NOT_UNDOABLE', `Solo se puede deshacer un borrador ejecutado (estado ${proposal.status}).`);
  if (proposal.level !== 'N1') throw new HttpError(409, 'NOT_UNDOABLE', 'Solo los borradores N1 tienen ventana de deshacer.');
  if (!proposal.undoUntil || Date.parse(proposal.undoUntil) <= Date.now()) {
    throw new HttpError(409, 'UNDO_EXPIRED', 'La ventana de deshacer caducó.');
  }
  const resolved = await resolveExecutor(proposal);
  if (!resolved || !resolved.executor.revert) throw new HttpError(409, 'UNDO_NOT_SUPPORTED', 'El ejecutor no soporta deshacer.');
  let undoResult;
  try {
    undoResult = await resolved.executor.revert(proposal);
  } catch (error) {
    throw new HttpError(502, 'EXECUTOR_FAILED', `No se pudo deshacer: ${String(error?.message || 'error').slice(0, 300)}`);
  }
  let output = null;
  await store.mutate((current) => {
    const office = ensureOffice(current);
    const target = office.proposals.find((item) => item.id === id);
    if (!target) return;
    target.status = 'reverted';
    target.revertedAt = nowIso();
    target.revertedBy = String(by || 'api').slice(0, 80);
    target.undoResult = sanitizeValue(undoResult, { maxString: 300, maxArray: 10, depth: 4 });
    target.updatedAt = nowIso();
    target.card = buildCard(target);
    appendLedger(current, {
      actor: target.revertedBy,
      action: 'proposal.reverted',
      payload: { proposalId: id, level: target.level, executor: resolved.id }
    });
    office.updatedAt = nowIso();
    output = publicProposal(target);
  }, { label: 'office-proposal-undo' });
  return output;
}

/** Vistas para el contrato: niveles + modos. */
export function levelCatalog() {
  return policyCatalog();
}

/** @param {string} levelId */
export function describeLevel(levelId) {
  return levelInfo(levelId);
}

