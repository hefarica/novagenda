/**
 * Rutas del ACL y etiquetas de seguridad.
 *
 *   GET  /api/acl/status
 *   GET  /api/acl/documents/:docId
 *   PUT  /api/acl/documents/:docId     {label, owner?, by?}
 *   GET  /api/acl/documents?limit=     (listado)
 *   POST /api/acl/check                {docId|label, channel, recipients, confirmedReserved, kind?}
 *   GET  /api/acl/policy
 *   POST /api/acl/defaults             {document?, proposal?}
 */

import { store } from '../store.mjs';
import {
  bodyOf, badRequest, listEnvelope, paramOf, queryInt, respond, route, sendError
} from '../agenda/http.mjs';
import { ACL_VERSION, AclError, LABELS } from '../acl/constants.mjs';
import { contextFromData, serializeContext } from '../acl/context.mjs';
import { guardOutbound } from '../acl/guard.mjs';
import { policyMatrix } from '../acl/policy.mjs';
import {
  aclLedger, defaultsOf, ensureAclState, listDocumentLabels, publicDocument,
  setDefaults, setDocumentLabel
} from '../acl/state.mjs';

export const name = 'acl';
export const priority = 110;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function statusRoute(ctx) {
  const data = store.get();
  const acl = ensureAclState(data);
  const context = contextFromData(data);
  return respond(ctx, 200, {
    item: {
      version: ACL_VERSION,
      labels: [...LABELS],
      defaults: defaultsOf(data),
      documents: Object.keys(acl.documents).length,
      ledger: aclLedger(data).length,
      officeLedger: Array.isArray(data.office?.ledger) ? data.office.ledger.length : 0,
      classification: serializeContext(context),
      reservedPolicy: {
        externalRequiresConfirmation: true,
        externalRequiresCode: true,
        internalLevel: 'N2'
      }
    }
  });
}

function documentsListRoute(ctx) {
  const data = store.get();
  const limit = queryInt(ctx, 'limit', 200, { min: 1, max: 5000 });
  return respond(ctx, 200, listEnvelope(listDocumentLabels(data, { limit }), {
    defaults: defaultsOf(data)
  }));
}

function documentGetRoute(ctx) {
  const docId = paramOf(ctx, 'docId');
  if (!docId) return badRequest(ctx, 'docId es requerido', { field: 'docId' });
  return respond(ctx, 200, { item: publicDocument(store.get(), docId) });
}

async function documentPutRoute(ctx) {
  const docId = paramOf(ctx, 'docId');
  if (!docId) return badRequest(ctx, 'docId es requerido', { field: 'docId' });
  const body = asObject(await bodyOf(ctx));
  try {
    let item = null;
    await store.mutate((data) => {
      item = setDocumentLabel(data, docId, {
        label: body.label,
        owner: body.owner,
        by: body.by || 'api'
      });
    });
    return respond(ctx, 200, { item });
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function checkRoute(ctx) {
  const body = asObject(await bodyOf(ctx));
  const docId = body.docId !== undefined && body.docId !== null ? String(body.docId).trim() : null;
  const label = body.label;
  try {
    const decision = guardOutbound({
      docId: docId || null,
      label,
      channel: body.channel || 'email',
      recipients: body.recipients || [],
      confirmedReserved: body.confirmedReserved,
      kind: body.kind,
      data: store.get()
    });
    return respond(ctx, 200, decision);
  } catch (error) {
    return sendError(ctx, error);
  }
}

function policyRoute(ctx) {
  const data = store.get();
  const matrix = policyMatrix();
  const context = contextFromData(data);
  return respond(ctx, 200, {
    item: {
      ...matrix,
      defaults: defaultsOf(data),
      classification: serializeContext(context),
      channels: ['email', 'whatsapp', 'telegram', 'document', 'webhook', 'none'],
      enforcement: {
        guard: 'guardOutbound({docId,label,channel,recipients,confirmedReserved})',
        integration: 'channel/docs/office deben llamarlo antes de enviar; follow-up de los dueños de esos módulos.',
        hardBlock: 'reservado + externo + confirmedReserved:false → allowed:false'
      }
    }
  });
}

async function defaultsRoute(ctx) {
  const body = asObject(await bodyOf(ctx));
  const patch = asObject(body.defaults) && Object.keys(asObject(body.defaults)).length ? asObject(body.defaults) : body;
  try {
    let defaults = null;
    await store.mutate((data) => {
      defaults = setDefaults(data, { document: patch.document, proposal: patch.proposal }, { by: body.by || 'api' });
    });
    return respond(ctx, 200, { item: defaults });
  } catch (error) {
    return sendError(ctx, error);
  }
}

export const routes = [
  { method: 'GET', path: '/api/acl/status', name: 'acl.status', handler: route(statusRoute) },
  { method: 'GET', path: '/api/acl/documents', name: 'acl.documents.list', handler: route(documentsListRoute) },
  { method: 'GET', path: '/api/acl/documents/:docId', name: 'acl.documents.get', handler: route(documentGetRoute) },
  { method: 'PUT', path: '/api/acl/documents/:docId', name: 'acl.documents.put', handler: route(documentPutRoute) },
  { method: 'POST', path: '/api/acl/check', name: 'acl.check', handler: route(checkRoute) },
  { method: 'GET', path: '/api/acl/policy', name: 'acl.policy', handler: route(policyRoute) },
  { method: 'POST', path: '/api/acl/defaults', name: 'acl.defaults', handler: route(defaultsRoute) }
];

export default { name, priority, routes };
