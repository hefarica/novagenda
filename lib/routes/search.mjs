/**
 * Búsqueda global de la oficina.
 *
 *   GET /api/search?q=texto&limit=8
 *
 * Devuelve grupos con resultados ligeros (título, subtítulo y vista de
 * destino). No expone cuerpos completos ni secretos; el cliente solo navega.
 */
import { queryInt, queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { listPeople } from '../identity/resolve.mjs';
import { listProposals } from '../office/proposals.mjs';

export const name = 'search';
export const priority = 90;

const GROUP_LABELS = {
  agenda: 'Agenda',
  tasks: 'Tareas',
  routines: 'Rutinas',
  docs: 'Documentos',
  wiki: 'Wiki',
  base: 'Tablas',
  people: 'Personas',
  approvals: 'Aprobaciones'
};

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function textOf(item, keys) {
  return keys.map((key) => clean(item?.[key], 240)).filter(Boolean).join(' · ');
}

function snippet(value, max = 140) {
  const text = clean(value, max + 40);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function matches(haystack, needle) {
  if (!needle) return false;
  return normalize(haystack).includes(needle);
}

function scoreResult(title, subtitle, needle) {
  const t = normalize(title);
  if (t === needle) return 100;
  if (t.startsWith(needle)) return 80;
  if (t.includes(needle)) return 60;
  return normalize(subtitle).includes(needle) ? 30 : 10;
}

function pushGroup(groups, key, items, limit, needle) {
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    const title = item.title;
    if (!title || seen.has(normalize(title))) continue;
    const subtitle = item.subtitle || '';
    if (!matches(`${title} ${subtitle}`, needle)) continue;
    seen.add(normalize(title));
    rows.push({
      id: item.id || null,
      title,
      subtitle: snippet(subtitle),
      view: item.view || key,
      meta: item.meta || '',
      score: scoreResult(title, subtitle, needle)
    });
  }
  rows.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'es'));
  if (!rows.length) return;
  groups.push({ key, label: GROUP_LABELS[key] || key, items: rows.slice(0, limit) });
}

function buildGroups(data, q, limit) {
  const needle = normalize(q);
  const groups = [];

  const events = Array.isArray(data?.agenda) ? data.agenda : [];
  pushGroup(groups, 'agenda', events.map((event) => {
    const date = event?.start ? clean(event.start, 16).replace('T', ' ') : '';
    return {
      id: event?.id,
      title: clean(event?.title || event?.name, 160),
      subtitle: [date, clean(event?.location || event?.place, 120), clean(event?.status, 40)].filter(Boolean).join(' · '),
      view: 'agenda',
      meta: 'Cita'
    };
  }), limit, needle);

  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  pushGroup(groups, 'tasks', tasks.map((task) => ({
    id: task?.id,
    title: clean(task?.title, 160),
    subtitle: [clean(task?.status, 20), clean(task?.due, 20), clean(task?.owner, 80), clean(task?.notes, 160)].filter(Boolean).join(' · '),
    view: 'tasks',
    meta: 'Tarea'
  })), limit, needle);

  const routines = [
    ...(Array.isArray(data?.recurrences) ? data.recurrences : []),
    ...(Array.isArray(data?.meetings) ? data.meetings : [])
  ];
  pushGroup(groups, 'routines', routines.map((routine) => ({
    id: routine?.id,
    title: clean(routine?.title || routine?.name, 160),
    subtitle: [
      clean(routine?.frequency || routine?.cadence, 30),
      clean(routine?.time, 10),
      clean(routine?.purpose || routine?.notes || routine?.result, 160)
    ].filter(Boolean).join(' · '),
    view: 'routines',
    meta: routine?.kind === 'meeting' ? 'Reunión fija' : 'Rutina'
  })), limit, needle);

  const docs = Array.isArray(data?.docs) ? data.docs : [];
  pushGroup(groups, 'docs', docs.map((doc) => ({
    id: doc?.id,
    title: clean(doc?.title || doc?.name || doc?.originalName, 160),
    subtitle: [clean(doc?.type || doc?.docType, 30), clean(doc?.version, 20), clean(doc?.updatedAt, 24)].filter(Boolean).join(' · '),
    view: 'docs',
    meta: 'Documento'
  })), limit, needle);

  const pages = Array.isArray(data?.wiki?.pages) ? data.wiki.pages : [];
  pushGroup(groups, 'wiki', pages.map((page) => ({
    id: page?.id,
    title: clean(page?.title, 160),
    subtitle: [clean(page?.space, 60), clean(page?.content || page?.body, 160)].filter(Boolean).join(' · '),
    view: 'wiki',
    meta: 'Wiki'
  })), limit, needle);

  let people = [];
  try { people = listPeople({ q: '', limit: 100 }, { data }).items || []; } catch { people = []; }
  pushGroup(groups, 'people', people.map((person) => ({
    id: person?.id,
    title: clean(person?.name, 160),
    subtitle: [
      Array.isArray(person?.emails) ? person.emails.slice(0, 4).join(', ') : '',
      Array.isArray(person?.aliases) ? person.aliases.slice(0, 3).join(', ') : ''
    ].filter(Boolean).join(' · '),
    view: 'identity',
    meta: 'Persona'
  })), limit, needle);

  let proposals = [];
  try { proposals = listProposals({ limit: 200 }).items || []; } catch { proposals = []; }
  pushGroup(groups, 'approvals', proposals.map((proposal) => ({
    id: proposal?.id,
    title: clean(proposal?.subject || proposal?.title || proposal?.kind || proposal?.id, 160),
    subtitle: [
      clean(proposal?.channel, 30),
      clean(proposal?.status, 30),
      Array.isArray(proposal?.recipients) ? proposal.recipients.slice(0, 4).join(', ') : '',
      clean(proposal?.body, 140)
    ].filter(Boolean).join(' · '),
    view: 'approvals',
    meta: 'Aprobación'
  })), limit, needle);

  const tables = Array.isArray(data?.base?.tables) ? data.base.tables : [];
  pushGroup(groups, 'base', tables.map((table) => ({
    id: table?.id,
    title: clean(table?.name || table?.title, 160),
    subtitle: [clean(table?.description, 120), `${Array.isArray(table?.rows) ? table.rows.length : 0} fila(s)`].filter(Boolean).join(' · '),
    view: 'base',
    meta: 'Tabla'
  })), limit, needle);

  return groups;
}

function searchRoute(ctx) {
  const q = String(queryString(ctx, 'q') || '').trim();
  if (q.length < 2) {
    return respond(ctx, 200, { query: q, groups: [], total: 0, hint: 'Escribe al menos 2 letras.' });
  }
  const limit = Math.max(3, Math.min(12, queryInt(ctx, 'limit', 8, { min: 3, max: 12 })));
  const data = store.get();
  const groups = buildGroups(data, q.slice(0, 80), limit);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return respond(ctx, 200, {
    query: q,
    groups,
    total,
    generatedAt: new Date().toISOString()
  });
}

export const routes = [
  { method: 'GET', path: '/api/search', name: 'search.global', handler: route(searchRoute) }
];
