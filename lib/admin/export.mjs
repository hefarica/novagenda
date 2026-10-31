/**
 * Exportación de la oficina para copia de seguridad.
 *
 * Incluye datos de trabajo (agenda, tareas, documentos, aprobaciones, etc.) y
 * excluye deliberadamente vault, secretos, conexiones, tokens y adjuntos
 * binarios. El archivo se genera en memoria; no escribe nada.
 */
import { listDocuments } from '../docs/documents.mjs';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function buildOfficeExport(data, { now = new Date() } = {}) {
  const documents = (() => {
    try { return listDocuments({ limit: 200 }).items.map((doc) => ({ ...doc })); } catch { return []; }
  })();
  const exportData = {
    agenda: clone(data?.agenda) || [],
    tasks: clone(data?.tasks) || [],
    recurrences: clone(data?.recurrences) || [],
    documents,
    office: {
      proposals: clone(data?.office?.proposals) || [],
      ledger: clone(data?.office?.ledger) || []
    },
    okr: clone(data?.okr) || { objectives: [] },
    rooms: clone(data?.rooms) || { items: [], reservations: [] },
    attendance: clone(data?.attendance) || { entries: [] },
    base: clone(data?.base) || { tables: [] },
    wiki: clone(data?.wiki) || { pages: [] },
    approvals: clone(data?.approvals) || { types: [], requests: [] },
    lingo: clone(data?.lingo) || null,
    identity: clone(data?.identity) || null,
    nudges: clone(data?.nudges) || null
  };
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    format: 'agenda-copilot-export',
    version: 1,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    counts: {
      agenda: count(exportData.agenda),
      tasks: count(exportData.tasks),
      recurrences: count(exportData.recurrences),
      documents: count(documents),
      proposals: count(exportData.office.proposals),
      ledger: count(exportData.office.ledger),
      okr: count(exportData.okr.objectives),
      rooms: count(exportData.rooms.items),
      reservations: count(exportData.rooms.reservations),
      attendance: count(exportData.attendance.entries),
      baseTables: count(exportData.base.tables),
      wikiPages: count(exportData.wiki.pages),
      approvalTypes: count(exportData.approvals.types),
      approvalRequests: count(exportData.approvals.requests)
    },
    notice: 'Copia de datos de trabajo. No incluye contraseñas, tokens, vault, conexiones ni archivos binarios de documentos.',
    data: exportData
  };
}
