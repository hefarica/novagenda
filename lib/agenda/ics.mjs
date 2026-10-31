/**
 * Exportación de la agenda a iCalendar (RFC 5545).
 *
 * Es un archivo de solo lectura para importar en Google Calendar, Outlook o
 * Apple Calendario. No sustituye la sincronización con Google: es una copia.
 */

const CRLF = '\r\n';

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function icsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldLine(line) {
  const buffer = Buffer.from(line, 'utf8');
  if (buffer.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < buffer.length) {
    let end = Math.min(start + limit, buffer.length);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
    if (end <= start) end = Math.min(start + limit, buffer.length);
    parts.push(buffer.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // la línea de continuación empieza con un espacio
  }
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join(CRLF);
}

function eventLines(event, stamp) {
  const start = icsDate(event.start);
  if (!start) return [];
  const end = icsDate(event.end) || icsDate(new Date(new Date(event.start).getTime() + 60 * 60 * 1000).toISOString());
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeText(event.id || 'sin-id')}@agenda-copilot.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`
  ];
  lines.push(`SUMMARY:${escapeText(event.title || 'Compromiso')}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  const description = [event.context, event.result].filter(Boolean).join(' · ');
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (event.type) lines.push(`CATEGORIES:${escapeText(event.type)}`);
  if (event.priority) lines.push(`PRIORITY:${event.priority === 'P1' ? 1 : event.priority === 'P2' ? 5 : 9}`);
  lines.push(`STATUS:${event.status === 'Cancelada' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('END:VEVENT');
  return lines;
}

export function buildAgendaIcs(data, { now = new Date(), calendarName = 'Agenda' } = {}) {
  const stamp = icsDate(now) || icsDate(new Date());
  const events = (Array.isArray(data?.agenda) ? data.agenda : [])
    .filter((event) => event && event.status !== 'Cancelada' && icsDate(event.start))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agenda Copilot P95//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'X-WR-TIMEZONE:America/Bogota'
  ];
  for (const event of events) lines.push(...eventLines(event, stamp));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

export function agendaIcsFilename(data, { now = new Date() } = {}) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const base = String(data?.settings?.ownerName || 'agenda').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'agenda'}-${day}.ics`;
}
