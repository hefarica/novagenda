/**
 * Rutas de la Oficina (auto-descubiertas por `lib/routes/*.mjs`).
 *
 *   GET  /api/office/roster
 *   GET  /api/office/mode              POST /api/office/mode
 *   GET  /api/office/status
 *   GET  /api/office/proposals         POST /api/office/proposals
 *   GET  /api/office/proposals/:id
 *   POST /api/office/proposals/:id/approve
 *   POST /api/office/proposals/:id/reject
 *   POST /api/office/proposals/:id/execute
 *   POST /api/office/proposals/:id/undo
 *   POST /api/office/parse
 *   GET  /api/office/ledger            GET /api/office/ledger/verify
 *   GET  /api/office/ledger/export
 *   GET  /api/office/executors
 *
 * Todas usan la autenticación normal de la app (`auth:'default'`): en modo local
 * sin login no piden sesión; con HOST≠loopback o APP_AUTH=on, sí.
 */
import {
  bodyOf, paramOf, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { pickFields, text, enumValue } from '../validate.mjs';
import { rosterPayload } from '../office/roster.mjs';
import { policyCatalog } from '../office/policy.mjs';
import {
  officeStatus, modeView, changeMode, validateModeInput,
  createProposal, validateProposalInput, listProposals, getProposal,
  approveProposal, validateApproveInput, rejectProposal, validateRejectInput,
  executeProposal, validateExecuteInput, undoProposal, validateUndoInput,
  reviseProposal, PROPOSAL_STATUSES
} from '../office/proposals.mjs';
import { listLedger, verifyLedger, exportLedger } from '../office/ledger.mjs';
import { parseDecision } from '../office/parse.mjs';
import { executorStatus } from '../office/executors.mjs';
import { outboundSettingsView } from '../office/outbound.mjs';
import { HttpError } from '../http/errors.mjs';

export const name = 'office';
export const priority = 130;

/** Clona para no repetir referencias (el serializador marca duplicados como "[circular]"). */
function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}

/** @param {any} ctx */
function actorOf(ctx) {
  const user = ctx?.auth?.user;
  return user && user !== 'local' ? String(user) : 'api';
}

function rosterRoute(ctx) {
  const roster = rosterPayload();
  const mode = modeView();
  return respond(ctx, 200, {
    ok: true,
    ...roster,
    mode: mode.mode,
    levels: policyCatalog().levels,
    modes: policyCatalog().modes,
    voiceThreshold: mode.voiceThreshold,
    undoWindowSec: mode.undoWindowSec,
    approvalTtlSec: mode.approvalTtlSec
  });
}

function modeGet(ctx) {
  return respond(ctx, 200, { ok: true, ...modeView() });
}

async function modePost(ctx) {
  const input = validateModeInput(await bodyOf(ctx));
  const result = await changeMode({ mode: input.mode, by: input.by || actorOf(ctx) });
  return respond(ctx, 200, { ok: true, ...result });
}

function statusRoute(ctx) {
  const outbound = outboundSettingsView();
  return respond(ctx, 200, {
    ok: true,
    ...officeStatus(),
    ...outbound,
    office: outbound
  });
}

function proposalsList(ctx) {
  const rawStatus = queryString(ctx, 'status');
  let status = null;
  if (rawStatus) {
    const normalized = String(rawStatus).trim().toLowerCase();
    status = enumValue(normalized, PROPOSAL_STATUSES, { field: 'status', required: true });
  }
  const limit = queryInt(ctx, 'limit', 50, { min: 1, max: 500 });
  const offset = queryInt(ctx, 'offset', 0, { min: 0, max: 100000 });
  const result = listProposals({ status, limit, offset });
  return respond(ctx, 200, { ok: true, ...result, proposals: clone(result.items) });
}

async function proposalsCreate(ctx) {
  const input = validateProposalInput(await bodyOf(ctx));
  const result = await createProposal({ input, actor: actorOf(ctx) });
  return respond(ctx, 201, {
    ok: true,
    item: result.proposal,
    id: result.proposal?.id || null,
    level: result.proposal?.level || null,
    status: result.proposal?.status || null,
    risk: clone(result.proposal?.risk || null),
    flags: clone(result.proposal?.flags || []),
    card: clone(result.proposal?.card || null),
    code: result.code || null,
    auto: result.auto === true,
    executed: result.executed === true,
    error: result.error || null
  });
}

function proposalGet(ctx) {
  const id = paramOf(ctx, 'id');
  return respond(ctx, 200, { ok: true, item: getProposal(id) });
}

async function proposalApprove(ctx) {
  const input = validateApproveInput(await bodyOf(ctx));
  const result = await approveProposal({ id: paramOf(ctx, 'id'), by: input.by, note: input.note });
  return respond(ctx, 200, {
    ok: true,
    item: result.proposal,
    approval: clone(result.approval),
    signature: result.approval?.signature || null,
    nonce: result.approval?.nonce || null,
    expiresAt: result.approval?.expiresAt || null,
    token: result.approval?.token || null,
    code: result.code || null,
    card: clone(result.card || null)
  });
}

async function proposalRevise(ctx) {
  const body = await bodyOf(ctx);
  const input = pickFields(body, ['subject', 'body', 'by']);
  const hasSubject = Object.prototype.hasOwnProperty.call(body, 'subject');
  const hasBody = Object.prototype.hasOwnProperty.call(body, 'body');
  const subject = hasSubject ? text(input.subject, { field: 'subject', max: 250, allowEmpty: false }) : undefined;
  const bodyText = hasBody ? text(input.body, { field: 'body', max: 20000, allowEmpty: false }) : undefined;
  if (hasBody && !String(bodyText || '').trim()) {
    throw new HttpError(400, 'VALIDATION', 'El cuerpo no puede quedar vacío.', { field: 'body' });
  }
  const item = await reviseProposal({
    id: paramOf(ctx, 'id'),
    subject,
    body: bodyText,
    by: text(input.by, { field: 'by', max: 80, defaultValue: actorOf(ctx) })
  });
  return respond(ctx, 200, { ok: true, item });
}

async function proposalReject(ctx) {
  const input = validateRejectInput(await bodyOf(ctx));
  const item = await rejectProposal({ id: paramOf(ctx, 'id'), by: input.by, reason: input.reason });
  return respond(ctx, 200, { ok: true, item });
}

async function proposalExecute(ctx) {
  const input = validateExecuteInput(await bodyOf(ctx));
  const result = await executeProposal({ id: paramOf(ctx, 'id'), code: input.code, actor: actorOf(ctx) });
  return respond(ctx, 200, {
    ok: true,
    item: result.proposal,
    status: result.proposal?.status || null,
    executed: result.proposal?.status === 'executed',
    execution: clone(result.execution)
  });
}

async function proposalUndo(ctx) {
  const input = validateUndoInput(await bodyOf(ctx));
  const item = await undoProposal({ id: paramOf(ctx, 'id'), by: input.by || actorOf(ctx) });
  return respond(ctx, 200, { ok: true, item });
}

async function parseRoute(ctx) {
  const input = pickFields(await bodyOf(ctx), ['text']);
  const value = text(input.text, { field: 'text', required: true, max: 2000, allowEmpty: false });
  return respond(ctx, 200, { ok: true, ...parseDecision(value) });
}

function ledgerRoute(ctx) {
  const limit = queryInt(ctx, 'limit', 100, { min: 1, max: 1000 });
  const offset = queryInt(ctx, 'offset', 0, { min: 0, max: 100000 });
  const result = listLedger(undefined, { limit, offset });
  return respond(ctx, 200, { ok: true, ...result, entries: clone(result.items) });
}

function ledgerVerify(ctx) {
  // `ctx.store` no existe: el ledger vive en el store global; se resuelve dentro.
  return respond(ctx, 200, verifyLedger());
}

function ledgerExport(ctx) {
  const payload = exportLedger();
  return respond(ctx, 200, payload, {
    'content-disposition': 'attachment; filename="office-ledger.json"',
    'x-office-ledger': 'export'
  });
}

async function executorsRoute(ctx) {
  const status = await executorStatus();
  return respond(ctx, 200, { ok: true, ...status });
}

export const routes = [
  { method: 'GET', path: '/api/office/roster', name: 'office.roster', handler: route(rosterRoute) },
  { method: 'GET', path: '/api/office/mode', name: 'office.mode.get', handler: route(modeGet) },
  { method: 'POST', path: '/api/office/mode', name: 'office.mode.set', handler: route(modePost) },
  { method: 'GET', path: '/api/office/status', name: 'office.status', handler: route(statusRoute) },
  { method: 'GET', path: '/api/office/proposals', name: 'office.proposals.list', handler: route(proposalsList) },
  { method: 'POST', path: '/api/office/proposals', name: 'office.proposals.create', handler: route(proposalsCreate) },
  { method: 'GET', path: '/api/office/proposals/:id', name: 'office.proposals.get', handler: route(proposalGet) },
  { method: 'POST', path: '/api/office/proposals/:id/approve', name: 'office.proposals.approve', handler: route(proposalApprove) },
  { method: 'POST', path: '/api/office/proposals/:id/revise', name: 'office.proposals.revise', handler: route(proposalRevise) },
  { method: 'POST', path: '/api/office/proposals/:id/reject', name: 'office.proposals.reject', handler: route(proposalReject) },
  { method: 'POST', path: '/api/office/proposals/:id/execute', name: 'office.proposals.execute', handler: route(proposalExecute) },
  { method: 'POST', path: '/api/office/proposals/:id/undo', name: 'office.proposals.undo', handler: route(proposalUndo) },
  { method: 'POST', path: '/api/office/parse', name: 'office.parse', handler: route(parseRoute) },
  { method: 'GET', path: '/api/office/ledger', name: 'office.ledger.list', handler: route(ledgerRoute) },
  { method: 'GET', path: '/api/office/ledger/verify', name: 'office.ledger.verify', handler: route(ledgerVerify) },
  { method: 'GET', path: '/api/office/ledger/export', name: 'office.ledger.export', handler: route(ledgerExport) },
  { method: 'GET', path: '/api/office/executors', name: 'office.executors', handler: route(executorsRoute) }
];

export default { name, priority, routes };

