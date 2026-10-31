/**
 * Momentos: resumen semanal determinista de la oficina.
 *
 * No guarda estado ni llama al modelo. Cruza agenda, tareas, documentos,
 * aprobaciones, OKR y salas para responder: qué pasó, qué avanzó y qué te
 * espera esta semana.
 */
import { listDocuments } from '../docs/documents.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function time(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return new Date(value).toISOString();
}

export function weeklyMoments(data, { now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error('Fecha inválida');
  const from = current.getTime() - 7 * DAY_MS;
  const to = current.getTime();
  const upcomingEnd = to + 7 * DAY_MS;
  const today = dateKey(current);

  const events = Array.isArray(data?.agenda) ? data.agenda : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const proposals = Array.isArray(data?.office?.proposals) ? data.office.proposals : [];
  const okrObjectives = Array.isArray(data?.okr?.objectives) ? data.okr.objectives : [];
  const reservations = Array.isArray(data?.rooms?.reservations) ? data.rooms.reservations : [];
  const documents = (() => {
    try { return listDocuments({ limit: 200 }).items; } catch { return []; }
  })();

  const inWindow = (value) => {
    const parsed = time(value);
    return parsed !== null && parsed >= from && parsed <= to;
  };
  const eventStart = (event) => time(event.start || event.startAt || `${event.date || ''}T00:00:00`);
  const upcomingEvents = events
    .map((event) => ({ event, start: eventStart(event) }))
    .filter((row) => row.start !== null && row.start >= to && row.start <= upcomingEnd)
    .sort((a, b) => a.start - b.start)
    .slice(0, 6);
  const pastEvents = events.filter((event) => {
    const start = eventStart(event);
    return start !== null && start >= from && start < to;
  });
  const tasksCreated = tasks.filter((task) => inWindow(task.createdAt));
  const tasksDone = tasks.filter((task) => inWindow(task.closedAt));
  const docsCreated = documents.filter((doc) => inWindow(doc.createdAt));
  const approved = proposals.filter((proposal) => inWindow(proposal.approvedAt));
  const executed = proposals.filter((proposal) => inWindow(proposal.executedAt));
  const pending = proposals.filter((proposal) => proposal.status === 'pending' || proposal.status === 'held');
  const overdue = tasks
    .filter((task) => task.status === 'open' && task.due && task.due < today)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const progressOf = (objective) => {
    const results = Array.isArray(objective.keyResults) ? objective.keyResults : [];
    if (!results.length) return 0;
    return Math.round(results.reduce((sum, kr) => {
      const target = Number(kr.target) || 0;
      return sum + (target > 0 ? Math.min(100, (Number(kr.current) || 0) / target * 100) : 0);
    }, 0) / results.length);
  };
  const activeOkr = okrObjectives
    .filter((objective) => objective.status === 'active')
    .map((objective) => ({ ...objective, progress: progressOf(objective) }));
  const okrProgress = activeOkr.length
    ? Math.round(activeOkr.reduce((sum, objective) => sum + objective.progress, 0) / activeOkr.length)
    : 0;
  const atRisk = activeOkr.filter((objective) => objective.progress < 40);
  const weekReservations = reservations
    .filter((reservation) => reservation.status === 'active' && reservation.date >= today
      && reservation.date <= dateKey(new Date(upcomingEnd)))
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));

  return {
    from: iso(from),
    to: iso(to),
    today,
    counts: {
      eventsPast: pastEvents.length,
      eventsNext: upcomingEvents.length,
      tasksCreated: tasksCreated.length,
      tasksDone: tasksDone.length,
      docsCreated: docsCreated.length,
      proposalsApproved: approved.length,
      proposalsExecuted: executed.length,
      reservationsNext: weekReservations.length
    },
    needsYou: {
      approvals: pending.slice(0, 5).map((proposal) => ({
        id: proposal.id, subject: proposal.subject, level: proposal.level, createdAt: proposal.createdAt
      })),
      overdueTasks: overdue.slice(0, 5).map((task) => ({
        id: task.id, title: task.title, due: task.due, priority: task.priority
      })),
      atRisk: atRisk.slice(0, 5).map((objective) => ({
        id: objective.id, title: objective.title, progress: Number(objective.progress || 0)
      }))
    },
    wins: {
      tasks: tasksDone.slice(0, 6).map((task) => ({ id: task.id, title: task.title, closedAt: task.closedAt })),
      documents: docsCreated.slice(0, 6).map((doc) => ({ id: doc.id, title: doc.title, type: doc.type })),
      approvals: executed.slice(0, 5).map((proposal) => ({ id: proposal.id, subject: proposal.subject })),
      okrProgress
    },
    next: upcomingEvents.map(({ event, start }) => ({
      id: event.id, title: event.title, start: event.start, end: event.end, location: event.location || ''
    })),
    reservations: weekReservations.slice(0, 6).map((reservation) => ({
      id: reservation.id, title: reservation.title, date: reservation.date, start: reservation.start, end: reservation.end
    }))
  };
}

export function momentsText(moments) {
  const lines = [
    `Momentos · ${moments.today}`,
    `Esta semana: ${moments.counts.tasksDone} tarea(s) cerrada(s), ${moments.counts.eventsPast} evento(s) y ${moments.counts.docsCreated} documento(s).`,
    `Te espera: ${moments.needsYou.approvals.length} aprobación(es), ${moments.needsYou.overdueTasks.length} tarea(s) vencida(s).`
  ];
  if (moments.next.length) lines.push(`Próximo: ${moments.next[0].title}${moments.next[0].start ? ` · ${String(moments.next[0].start).slice(0, 16).replace('T', ' ')}` : ''}`);
  return lines.join('\n');
}

