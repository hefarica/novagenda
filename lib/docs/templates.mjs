/**
 * Plantillas de marca y plantilla integrada «acta».
 *
 * Las plantillas guardan únicamente la marca (fuente, color, logotipo textual,
 * firma y pie) en `DATA_DIR/docs/templates.json`. Se aplican a cualquier DOCX,
 * XLSX o PPTX generado. La plantilla `acta` es integrada, no se puede sobrescribir
 * y compone un acta formal con resumen de cuatro líneas y anexo privado.
 */
import fs from 'node:fs';
import { HttpError } from '../http/errors.mjs';
import {
  DEFAULT_BRAND, normalizeBrand, cleanText, parseDateInput, dateKey,
  formatDateLongEs
} from './ooxml.mjs';
import { templatesFile, writeFileAtomic } from './paths.mjs';
import { LIMITS, validateTemplateInput } from './schema.mjs';

const BUILTIN_ACTA = Object.freeze({
  name: 'acta',
  type: 'docx',
  builtin: true,
  description: 'Acta formal con datos, asistentes, acuerdos, resumen de 4 líneas y anexo privado.',
  brand: DEFAULT_BRAND
});

let cache = null;

function emptyStore() {
  return { version: 1, items: [] };
}

function readStore() {
  if (cache) return cache;
  const file = templatesFile();
  if (!fs.existsSync(file)) {
    cache = emptyStore();
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('estructura inválida');
    cache = {
      version: 1,
      items: parsed.items.filter((item) => item && typeof item.name === 'string').map((item) => ({
        name: item.name,
        type: item.type || 'any',
        brand: { ...DEFAULT_BRAND, ...(item.brand || {}) },
        description: item.description || '',
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
      }))
    };
    return cache;
  } catch (error) {
    // No se borra nada: se conserva el archivo original para inspección y se
    // empieza con un almacén vacío.
    const backup = `${file}.corrupt-${dateKey(new Date())}-${Date.now()}.json`;
    try { fs.renameSync(file, backup); } catch { /* sin permisos: se ignora */ }
    cache = emptyStore();
    return cache;
  }
}

function persistStore(store) {
  const file = templatesFile();
  writeFileAtomic(file, `${JSON.stringify({ version: 1, items: store.items }, null, 2)}\n`);
  cache = store;
}

function publicTemplate(template) {
  return {
    name: template.name,
    type: template.type,
    brand: { ...template.brand },
    description: template.description || '',
    builtin: template.builtin === true,
    createdAt: template.createdAt || null,
    updatedAt: template.updatedAt || null
  };
}

/** Lista plantillas integradas + guardadas. */
export async function listTemplates() {
  const store = readStore();
  const items = [BUILTIN_ACTA, ...store.items].map(publicTemplate);
  return { items, count: items.length, total: items.length };
}

/**
 * Recupera una plantilla por nombre.
 * @param {string} name
 * @returns {Promise<any|null>}
 */
export async function getTemplate(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (key === BUILTIN_ACTA.name) return publicTemplate(BUILTIN_ACTA);
  const store = readStore();
  const found = store.items.find((item) => item.name === key);
  return found ? publicTemplate(found) : null;
}

/**
 * Crea o actualiza una plantilla de marca.
 * @param {any} body
 */
export async function saveTemplate(body) {
  const input = validateTemplateInput(body);
  if (input.name === BUILTIN_ACTA.name) {
    throw new HttpError(409, 'TEMPLATE_RESERVED', 'La plantilla "acta" es integrada y no se puede sobrescribir.', { field: 'name' });
  }
  const brand = normalizeBrand(input.brand, { strict: true });
  const store = readStore();
  const existing = store.items.findIndex((item) => item.name === input.name);
  if (existing < 0 && store.items.length >= LIMITS.templates) {
    throw new HttpError(409, 'TEMPLATE_LIMIT', `Máximo ${LIMITS.templates} plantillas guardadas.`, { field: 'name' });
  }
  const now = new Date().toISOString();
  const record = {
    name: input.name,
    type: input.type,
    brand,
    description: input.description,
    createdAt: existing >= 0 ? store.items[existing].createdAt : now,
    updatedAt: now
  };
  const items = store.items.slice();
  if (existing >= 0) items.splice(existing, 1, record);
  else items.push(record);
  persistStore({ version: 1, items });
  return { item: publicTemplate(record), created: existing < 0 };
}

/**
 * Elimina una plantilla guardada.
 * @param {string} name
 */
export async function deleteTemplate(name) {
  const key = String(name || '').trim().toLowerCase();
  if (key === BUILTIN_ACTA.name) {
    throw new HttpError(409, 'TEMPLATE_RESERVED', 'La plantilla "acta" es integrada y no se puede eliminar.', { field: 'name' });
  }
  const store = readStore();
  const next = store.items.filter((item) => item.name !== key);
  if (next.length === store.items.length) {
    throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `No existe la plantilla "${key}".`, { field: 'name' });
  }
  persistStore({ version: 1, items: next });
  return { ok: true, name: key, removed: true };
}

/**
 * Resuelve la marca efectiva combinando la plantilla elegida y la marca inline.
 * @param {{template?:string, type:string, brand?:any}} input
 * @returns {Promise<{template:any|null, brand:any}>}
 */
export async function resolveBrand(input) {
  const name = cleanText(input.template || '');
  let template = null;
  if (name) {
    template = await getTemplate(name);
    if (!template) {
      throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `No existe la plantilla "${name}".`, { field: 'template' });
    }
    if (template.type !== 'any' && template.type !== input.type) {
      throw new HttpError(400, 'TEMPLATE_TYPE_MISMATCH', `La plantilla "${name}" es para ${template.type}, no para ${input.type}.`, {
        field: 'template'
      });
    }
  }
  const inlineBrand = input.brand ? normalizeBrand(input.brand, { strict: true }) : {};
  const brand = {
    ...DEFAULT_BRAND,
    ...(template ? template.brand : {}),
    ...inlineBrand
  };
  return { template, brand };
}

/* ------------------------------------------------------------------ */
/* Plantilla «acta»                                                    */
/* ------------------------------------------------------------------ */

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + Number(days || 0));
  return copy;
}

function fitSummary(provided = [], context) {
  const lines = [];
  for (const item of Array.isArray(provided) ? provided : []) {
    const text = cleanText(item);
    if (text && !lines.includes(text)) lines.push(text);
    if (lines.length >= 4) break;
  }
  const fallback = [
    `Se revisó el estado de ${context.topic}.`,
    context.attendeeCount
      ? `Participaron ${context.attendeeCount} persona(s) de las convocadas.`
      : 'No se registró una lista formal de asistentes.',
    context.agreementCount
      ? `Se registraron ${context.agreementCount} acuerdo(s) con responsable y seguimiento.`
      : 'No se registraron acuerdos formales en esta sesión.',
    `Siguiente revisión prevista a partir del ${formatDateLongEs(addDays(context.date, 7))}.`
  ];
  for (const line of fallback) {
    if (lines.length >= 4) break;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.slice(0, 4);
}

function attendeesTable(attendees) {
  return {
    table: {
      headers: ['Nombre', 'Rol', 'Asistencia'],
      widths: [46, 30, 24],
      rows: attendees.map((attendee) => [attendee.name, attendee.role || '—', attendee.attendance || 'Asistió'])
    }
  };
}

function agreementsTable(agreements) {
  return {
    table: {
      headers: ['Acuerdo', 'Responsable', 'Fecha límite', 'Estado'],
      widths: [46, 22, 16, 16],
      rows: agreements.map((agreement) => [agreement.text, agreement.owner || 'Por asignar', agreement.due || '—', agreement.status || 'Pendiente'])
    }
  };
}

/**
 * Compone el contenido del acta a partir de los campos validados.
 * @param {any} input documento normalizado (title, date, acta, brand...)
 * @param {any} brand
 * @returns {any} especificación DOCX
 */
export function composeActa(input, brand) {
  const acta = input.acta || {};
  const date = input.date instanceof Date ? input.date : parseDateInput(input.date, new Date());
  const topic = acta.topic || input.title;
  const reference = acta.reference || input.reference || `ACTA-${dateKey(date).replace(/-/g, '')}`;
  const attendees = acta.attendees || [];
  const agreements = acta.agreements || [];
  const agenda = acta.agenda && acta.agenda.length
    ? acta.agenda
    : ['Aprobación del orden del día', 'Seguimiento de compromisos anteriores', 'Varios y próximos pasos'];
  const summary = fitSummary(acta.summary, {
    topic,
    date,
    attendeeCount: attendees.length,
    agreementCount: agreements.length
  });

  const meetingRows = [
    ['Asunto', topic],
    ['Fecha', formatDateLongEs(date)]
  ];
  if (acta.time) meetingRows.push(['Hora', acta.time]);
  if (acta.location) meetingRows.push(['Lugar', acta.location]);
  if (acta.modality) meetingRows.push(['Modalidad', acta.modality]);
  meetingRows.push(['Referencia', reference]);

  const sections = [
    { heading: '1. Datos de la reunión', level: 1 },
    { table: { headers: ['Campo', 'Detalle'], widths: [26, 74], rows: meetingRows } },
    { heading: '2. Asistentes', level: 1 },
    attendees.length
      ? attendeesTable(attendees)
      : { paragraph: 'No se registró una lista formal de asistentes.' },
    { heading: '3. Orden del día', level: 1 },
    { list: { ordered: true, items: agenda } },
    { heading: '4. Desarrollo', level: 1 },
    ...(acta.development && acta.development.length
      ? acta.development
      : input.sections && input.sections.length
        ? input.sections
        : [{ paragraph: 'La reunión se desarrolló conforme al orden del día aprobado. Las intervenciones y decisiones se recogen en los acuerdos de la sección 5.' }]),
    { heading: '5. Acuerdos y compromisos', level: 1 },
    agreements.length
      ? agreementsTable(agreements)
      : { paragraph: 'No se registraron acuerdos formales.' },
    { heading: '6. Resumen ejecutivo', level: 1 },
    { paragraph: 'Síntesis en cuatro líneas:' },
    { list: { ordered: false, items: summary } },
    { heading: '7. Firma', level: 1 },
    { paragraph: `Para constancia, se emite la presente acta ${reference}.` },
    {
      runs: [
        { text: 'Firma: ', bold: true },
        { text: '______________________________', bold: false },
        { text: '     ', bold: false },
        { text: cleanText(input.author) || brand.creator, italic: true }
      ]
    },
    {
      runs: [
        { text: brand.logoText, bold: true, color: brand.color },
        { text: ` · ${formatDateLongEs(date)}`, bold: false }
      ]
    }
  ];

  const extraParagraphs = Array.isArray(input.annex?.paragraphs) ? input.annex.paragraphs : [];
  const extraItems = Array.isArray(input.annex?.items) ? input.annex.items.map((item) => item.text).filter(Boolean) : [];
  const annexNotes = [...(acta.annexNotes || []), ...extraParagraphs];
  const annex = {
    title: cleanText(input.annex?.title) || 'Anexo privado',
    private: true,
    note: `Acta ${reference} · ${topic}. Documento de uso interno.`,
    paragraphs: annexNotes.length
      ? annexNotes
      : ['Este anexo recoge notas internas y no forma parte de la versión distribuible del acta.'],
    items: [
      'Pendiente de revisión interna antes de compartir.',
      'No incluye datos personales adicionales a los acuerdos.',
      'Eliminar este anexo antes de distribuir el acta al comité.',
      ...extraItems
    ]
  };

  return {
    title: `Acta de reunión — ${topic}`,
    subtitle: input.subtitle || `${brand.logoText} · ${formatDateLongEs(date)}`,
    date,
    author: cleanText(input.author) || brand.creator,
    reference,
    headerTitle: `Acta — ${topic}`,
    sections,
    annex,
    brand,
    margins: input.margins
  };
}

export { BUILTIN_ACTA };
export default {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  resolveBrand,
  composeActa
};
