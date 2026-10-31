/**
 * Fachada pública de documentos.
 *
 * Punto de entrada estable para otros módulos y para `lib/routes/docs.mjs`:
 *   - `createDocument(body)` genera y (por defecto) guarda un DOCX/XLSX/PPTX.
 *   - `renderDocument(type, spec)` genera en memoria.
 *   - `readDocument(id)` / `getDocument(id)` / `listDocuments()` resuelven el
 *     almacén de `DATA_DIR/docs`.
 *   - `emailDocument(id, body)` envía el archivo como adjunto MIME por Gmail.
 *   - Plantillas de marca y plantilla integrada `acta`.
 *
 * El contrato de lectura es estable para el módulo de canales: `readDocument`
 * devuelve `{ item, buffer }` y `getDocument` devuelve metadatos públicos.
 */
import { HttpError } from '../http/errors.mjs';
import { aclDecisionView, auditAclEnforcement, evaluateOutboundAcl } from '../channel/acl.mjs';
import { renderDocx } from './docx.mjs';
import { renderXlsx } from './xlsx.mjs';
import { renderPptx } from './pptx.mjs';
import { validateDocumentInput, validateEmailInput } from './schema.mjs';
import {
  composeActa, deleteTemplate, getTemplate, listTemplates, resolveBrand, saveTemplate
} from './templates.mjs';
import {
  DOC_EXTENSION, DOC_MIME, deleteDocument, documentStats, getDocument, listDocuments,
  readDocument, saveGeneratedDocument
} from './documents.mjs';
import { sendDocumentEmail } from './email.mjs';
import { buildFilename } from './ooxml.mjs';
import { canonicalDocumentTitle } from '../style/lingo.mjs';
import { createTask } from '../travel/tasks.mjs';
import { store } from '../store.mjs';

export const DOC_TYPES = Object.freeze({
  docx: { extension: DOC_EXTENSION.docx, mime: DOC_MIME.docx, label: 'Word' },
  xlsx: { extension: DOC_EXTENSION.xlsx, mime: DOC_MIME.xlsx, label: 'Excel' },
  pptx: { extension: DOC_EXTENSION.pptx, mime: DOC_MIME.pptx, label: 'PowerPoint' }
});

export const DOC_MIME_TYPES = DOC_MIME;

/**
 * Renderiza un documento en memoria.
 * @param {'docx'|'xlsx'|'pptx'} type
 * @param {any} spec
 * @param {{now?:Date}} [options]
 * @returns {Buffer}
 */
export function renderDocument(type, spec = {}, options = {}) {
  const key = String(type || '').toLowerCase();
  if (!DOC_TYPES[key]) throw new Error(`Tipo de documento no soportado: ${type}`);
  if (key === 'docx') return renderDocx(spec, options);
  if (key === 'xlsx') return renderXlsx(spec, options);
  return renderPptx(spec, options);
}

/**
 * Valida, compone (plantilla), renderiza y guarda un documento.
 *
 * @param {any} body cuerpo de `POST /api/docs`
 * @param {{now?:Date}} [options]
 * @returns {Promise<any>} documento público (`{id,type,filename,bytes,createdAt,…}`)
 *   o, con `register:false`, un objeto inline con `base64`.
 */
export async function createDocument(body, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const input = validateDocumentInput(body);
  const templateName = String(input.template || '').trim().toLowerCase();
  const { template, brand } = await resolveBrand({
    template: input.template,
    type: input.type,
    brand: input.brand
  });
  let spec;
  if (input.type === 'docx' && templateName === 'acta') {
    spec = composeActa(input, brand);
  } else {
    spec = { ...input, brand };
  }
  const buffer = renderDocument(input.type, spec, { now });
  const displayTitle = spec.title || input.title;
  const filenameTitle = templateName === 'acta' ? input.title : displayTitle;
  const filename = buildFilename(canonicalDocumentTitle(filenameTitle), DOC_EXTENSION[input.type], { date: input.date || now });

  if (input.register === false) {
    return {
      registered: false,
      inline: true,
      type: input.type,
      title: displayTitle,
      filename,
      mimeType: DOC_MIME[input.type],
      bytes: buffer.length,
      createdAt: now.toISOString(),
      template: template ? template.name : null,
      base64: buffer.toString('base64')
    };
  }

  const item = await saveGeneratedDocument({
    type: input.type,
    title: displayTitle,
    buffer,
    date: input.date,
    template: template ? template.name : null,
    now
  });
  const tasks = await createAgreementTasks(item, input, { templateName, title: displayTitle });
  return { ...item, registered: true, ...(tasks.length ? { tasks } : {}) };
}

/**
 * Convierte los acuerdos de un acta en tareas/compromisos (origen cta).
 * Idempotente por acta: no duplica si ya existe una tarea con el mismo título
 * y el id del acta en las notas.
 */
async function createAgreementTasks(item, input, { templateName, title }) {
  if (item.type !== 'docx' || templateName !== 'acta') return [];
  const agreements = Array.isArray(input.acta?.agreements)
    ? input.acta.agreements
    : (Array.isArray(input.agreements) ? input.agreements : []);
  if (!agreements.length || !item.id) return [];
  const created = [];
  const stamp = String(item.id);
  await store.mutate((data) => {
    for (const agreement of agreements) {
      const taskTitle = String(agreement?.text || '').trim().slice(0, 160);
      if (!taskTitle) continue;
      const notes = `Acta ${stamp} · ${String(title || 'Reunión').slice(0, 180)}`.slice(0, 500);
      const exists = (Array.isArray(data.tasks) ? data.tasks : []).some((task) =>
        task && task.origin === 'acta' && task.title === taskTitle && String(task.notes || '').includes(stamp));
      if (exists) continue;
      const payload = { title: taskTitle, notes, origin: 'acta', priority: 'P2' };
      const owner = String(agreement?.owner || '').trim();
      if (owner) payload.owner = owner.slice(0, 120);
      const due = String(agreement?.due || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(due)) payload.due = due;
      created.push(createTask(data, payload));
    }
  });
  return created.map((task) => ({ id: task.id, title: task.title, owner: task.owner || null, due: task.due || null }));
}

/**
 * Envía un documento guardado por correo con adjunto MIME.
 * @param {string} id
 * @param {any} body `{to, subject, body, connectionId}`
 * @returns {Promise<any>}
 */
export async function emailDocument(id, body) {
  const email = validateEmailInput(body);
  const { item, buffer } = readDocument(id);
  const acl = await evaluateOutboundAcl({
    docIds: [item.id], channel: 'email', recipients: email.to, kind: 'document'
  });
  if (acl.label === 'reservado') {
    await auditAclEnforcement(acl, { channel: 'email', recipients: email.to });
    throw new HttpError(403, 'ACL_RESERVED_EMAIL', 'El documento está marcado como reservado: no se envía por correo directo. Usa «Enviar por…» con un canal de la Oficina, donde el gate N3 pide código.', {
      field: 'id',
      details: aclDecisionView(acl)
    });
  }
  const result = await sendDocumentEmail({
    document: { id: item.id, filename: item.filename, mimeType: DOC_MIME[item.type], buffer },
    to: email.to,
    subject: email.subject,
    body: email.body,
    connectionId: email.connectionId
  });
  return {
    ...result,
    document: {
      id: item.id,
      filename: item.filename,
      bytes: item.bytes,
      downloadUrl: `/api/docs/${item.id}/download`
    }
  };
}

export function documentDownloadPath(id) {
  return `/api/docs/${encodeURIComponent(String(id || ''))}/download`;
}

export {
  DOC_EXTENSION,
  DOC_MIME,
  composeActa,
  deleteDocument,
  deleteTemplate,
  documentStats,
  getDocument,
  getTemplate,
  listDocuments,
  listTemplates,
  readDocument,
  resolveBrand,
  saveTemplate,
  sendDocumentEmail,
  validateDocumentInput,
  validateEmailInput
};

export default {
  DOC_TYPES,
  createDocument,
  renderDocument,
  readDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  emailDocument,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  documentStats
};




