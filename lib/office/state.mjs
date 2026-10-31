/**
 * Estado persistente de la Oficina dentro del store de la app.
 *
 * Se guarda en `data.office` (el store conserva claves desconocidas al cargar y
 * migrar, así que no hace falta tocar `lib/store.mjs`). Estructura:
 *
 *   {
 *     version: 1,
 *     mode: 'sombra'|'asistido'|'autonomo'|'total',
 *     proposals: [ … ],
 *     ledger: [ … ],
 *     contacts: ['email:…', 'phone:…'],
 *     undoWindowSec, approvalTtlSec, voiceThreshold,
 *     createdAt, updatedAt, modeUpdatedAt, modeUpdatedBy
 *   }
 */
import { store, nextId } from '../store.mjs';
import { isPlainObject } from '../validate.mjs';
import { DEFAULT_MODE, isMode } from './policy.mjs';

export const OFFICE_VERSION = 1;
export const DEFAULT_UNDO_WINDOW_SEC = 300;
export const DEFAULT_APPROVAL_TTL_SEC = 30 * 60;
export const DEFAULT_VOICE_THRESHOLD = 0.75;
export const MAX_CONTACTS = 500;
export const MAX_PROPOSALS = 2000;

/**
 * Garantiza la forma del estado de la oficina (idempotente).
 * @param {any} data
 * @returns {any} office
 */
export function ensureOffice(data = store.get()) {
  if (!isPlainObject(data.office)) data.office = {};
  const office = data.office;
  if (!Number.isFinite(Number(office.version))) office.version = OFFICE_VERSION;
  if (!isMode(office.mode)) office.mode = DEFAULT_MODE;
  if (!Array.isArray(office.proposals)) office.proposals = [];
  if (!Array.isArray(office.ledger)) office.ledger = [];
  if (!Array.isArray(office.contacts)) office.contacts = [];
  if (!Number.isFinite(Number(office.undoWindowSec))) office.undoWindowSec = DEFAULT_UNDO_WINDOW_SEC;
  if (!Number.isFinite(Number(office.approvalTtlSec))) office.approvalTtlSec = DEFAULT_APPROVAL_TTL_SEC;
  if (!Number.isFinite(Number(office.voiceThreshold))) office.voiceThreshold = DEFAULT_VOICE_THRESHOLD;
  if (!office.createdAt) office.createdAt = new Date().toISOString();
  office.updatedAt = office.updatedAt || office.createdAt;
  return office;
}

/** @param {any} [data] */
export function officeState(data = store.get()) {
  return ensureOffice(data);
}

/** @param {any} [data] */
export function modeOf(data = store.get()) {
  return ensureOffice(data).mode;
}

/**
 * Ejecuta una mutación con el estado de la oficina garantizado y persiste.
 * @template T
 * @param {(office:any, data:any)=>T} fn
 * @param {{label?:string}} [options]
 * @returns {Promise<T>}
 */
export async function withOffice(fn, options = {}) {
  let result;
  await store.mutate((data) => {
    const office = ensureOffice(data);
    result = fn(office, data);
    office.updatedAt = new Date().toISOString();
  }, { label: options.label || 'office' });
  return result;
}

/** @param {any} office */
export function nextProposalId(office) {
  return nextId('OF', office.proposals || []);
}

/** @param {any} proposal */
export function findRawProposal(proposalId, data = store.get()) {
  const office = ensureOffice(data);
  return office.proposals.find((item) => item && item.id === proposalId) || null;
}

/**
 * Copia pública de una propuesta: elimina hashes internos del código N3.
 * @param {any} proposal
 */
export function publicProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(proposal));
  if (copy.approval && typeof copy.approval === 'object') {
    delete copy.approval.codeHash;
    delete copy.approval.codeExpiresAt;
    delete copy.approval.codeUsedAt;
    // El payload firmado y la firma son auditables; el código nunca.
    delete copy.approval.signedPayload?.code;
  }
  return copy;
}

/** Copia pública de la aprobación (sin hash del código). */
export function publicApproval(approval) {
  if (!approval || typeof approval !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(approval));
  delete copy.codeHash;
  delete copy.codeExpiresAt;
  delete copy.codeUsedAt;
  return copy;
}

/** @param {any} office */
export function pruneProposals(office) {
  if (!Array.isArray(office.proposals)) return;
  if (office.proposals.length <= MAX_PROPOSALS) return;
  const keep = office.proposals.slice(0, MAX_PROPOSALS);
  const dropped = office.proposals.slice(MAX_PROPOSALS);
  office.proposals = keep;
  office.proposalsPruned = (Number(office.proposalsPruned) || 0) + dropped.length;
}
