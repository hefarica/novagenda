/**
 * Métricas de aprobaciones: tiempos, cola y SLA sobre las propuestas de Oficina.
 *
 * No guarda nada; calcula sobre `data.office.proposals` y la cuarentena.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function average(values) {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * @param {any} data
 * @param {{now?:number, slaHours?:number, windowDays?:number}} [options]
 */
export function approvalMetrics(data, { now = Date.now(), slaHours = 24, windowDays = 7 } = {}) {
  const proposals = Array.isArray(data?.office?.proposals) ? data.office.proposals : [];
  const pending = proposals.filter((item) => item.status === 'pending' || item.status === 'held');
  const approved = proposals.filter((item) => item.status === 'approved');
  const executed = proposals.filter((item) => item.status === 'executed');
  const rejected = proposals.filter((item) => item.status === 'rejected');
  const pendingAges = pending
    .map((item) => {
      const created = toMs(item.createdAt);
      return created === null ? null : Math.max(0, (now - created) / 3_600_000);
    })
    .filter((value) => value !== null);
  const approvalHours = proposals
    .filter((item) => item.approvedAt)
    .map((item) => {
      const created = toMs(item.createdAt);
      const approvedAt = toMs(item.approvedAt);
      return created === null || approvedAt === null ? null : Math.max(0, (approvedAt - created) / 3_600_000);
    })
    .filter((value) => value !== null);
  const executionHours = proposals
    .filter((item) => item.executedAt && item.approvedAt)
    .map((item) => {
      const approvedAt = toMs(item.approvedAt);
      const executedAt = toMs(item.executedAt);
      return approvedAt === null || executedAt === null ? null : Math.max(0, (executedAt - approvedAt) / 3_600_000);
    })
    .filter((value) => value !== null);
  const since = now - windowDays * DAY_MS;
  const within = (value) => {
    const time = toMs(value);
    return time !== null && time >= since;
  };
  const quarantineItems = Array.isArray(data?.quarantine?.items) ? data.quarantine.items : [];
  const quarantine = quarantineItems.filter((item) => item.status === 'held').length;
  return {
    total: proposals.length,
    pending: pending.filter((item) => item.status === 'pending').length,
    held: pending.filter((item) => item.status === 'held').length,
    approved: approved.length,
    executed: executed.length,
    rejected: rejected.length,
    executing: proposals.filter((item) => item.status === 'executing').length,
    oldestPendingHours: pendingAges.length ? round(Math.max(...pendingAges)) : null,
    averagePendingHours: average(pendingAges),
    slaHours,
    slaBreaches: pendingAges.filter((hours) => hours > slaHours).length,
    averageApprovalHours: average(approvalHours),
    medianApprovalHours: median(approvalHours),
    averageExecutionHours: average(executionHours),
    windowDays,
    recent: {
      approved: proposals.filter((item) => within(item.approvedAt)).length,
      rejected: proposals.filter((item) => within(item.rejectedAt)).length,
      executed: proposals.filter((item) => within(item.executedAt)).length
    },
    byLevel: ['N1', 'N2', 'N3'].reduce((acc, level) => {
      acc[level] = pending.filter((item) => item.level === level).length;
      return acc;
    }, {}),
    quarantine,
    at: new Date(now).toISOString()
  };
}
