/**
 * Identidad multicorreo: grafo de personas con evidencia y confianza.
 *
 * Fuentes LOCALES primero:
 *   - `data.identity.contacts` (mapeos manuales/importados, máxima confianza)
 *   - `data.identity.metadata` (metadatos importados)
 *   - agenda (título + attendees + notas), inbox (texto + hilos), OKR, reuniones,
 *     rutinas y firmas de las muestras de estilo.
 *   - Gmail SOLO si hay una conexión de Google: se usan la cuenta conectada y,
 *     si el importador dejó `data.identity.gmailMessages`, sus cabeceras. Este
 *     módulo no hace red ni lee cuerpos de Gmail.
 *
 * Cada vínculo nombre↔correo aporta evidencia con peso; la confianza combina
 * las evidencias (1 - Π(1-w)). Si la confianza < 0.8 se marca
 * `requiresConfirmation`.
 */
import { fold, normalizeText, extractClosingAndSignature } from '../style/features.mjs';

const EMAIL_SOURCE = '[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';
const NAME_SOURCE = "[A-ZÁÉÍÓÚÑ][\\p{L}.'’-]+(?:\\s+(?:de|del|la|las|los|y)?\\s*[A-ZÁÉÍÓÚÑ][\\p{L}.'’-]+){0,3}";
const EMAIL_RE = new RegExp(EMAIL_SOURCE, 'gu');
const PAIR_NAME_EMAIL_RE = new RegExp(`(${NAME_SOURCE})\\s*[<(\\[]\\s*(${EMAIL_SOURCE})\\s*[>)\\]]`, 'gu');
const PAIR_EMAIL_NAME_RE = new RegExp(`(${EMAIL_SOURCE})\\s*[(\\[]\\s*(${NAME_SOURCE})\\s*[)\\]]`, 'gu');
const PAIR_NAME_SEP_EMAIL_RE = new RegExp(`(${NAME_SOURCE})\\s*[-–—:|]\\s*(${EMAIL_SOURCE})`, 'gu');
const TITLE_NAME_RE = new RegExp(`\\b(?:con|para|de)\\s+(${NAME_SOURCE})`, 'u');
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos']);
const GENERIC_NAMES = new Set([
  'equipo', 'equipos', 'cliente', 'clientes', 'proveedor', 'proveedores', 'yo', 'tu', 'usted',
  'todos', 'todas', 'companeros', 'companeras', 'reunion', 'google', 'meet', 'zoom', 'teams',
  'oficina', 'contacto', 'sin nombre', 'soporte', 'ventas', 'administracion', 'rrhh'
]);
const GREETING_WORDS = /^(hola|buen dia|buenos dias|buenas tardes|buenas noches|estimad[oa]|apreciad[oa]|querid[oa]|hola de nuevo)\s+/i;

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const round3 = (value) => Math.round(clamp01(value) * 1000) / 1000;

/** Combina pesos de evidencia de forma monótona (1 - Π(1-w)). */
export function combineEvidence(weights) {
  let missing = 1;
  for (const weight of weights) missing *= 1 - clamp01(weight);
  return clamp01(1 - missing);
}

/** Limpia un nombre detectado (honoríficos, saludos, genéricos). */
export function cleanName(value) {
  let name = normalizeText(value)
    .replace(/[<>()[\]{}"“”'`,;:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^(sr|sra|srta|dr|dra|ing|lic|prof)\.?\s+/i, '');
  while (GREETING_WORDS.test(name)) name = name.replace(GREETING_WORDS, '');
  name = name.replace(/\s+(jr|sr)\.?$/i, '').replace(/[.\s]+$/, '').trim();
  if (!name || name.length > 80) return null;
  if (/[0-9@/\\]/.test(name)) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (!/^[\p{L}\p{M}.'’\-\s]+$/u.test(name)) return null;
  if (GENERIC_NAMES.has(fold(name))) return null;
  return name;
}

/** Tokens del nombre sin partículas (para agrupar/comparar). */
export function nameTokens(value) {
  return fold(value)
    .replace(/[.'’]/g, ' ')
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token && !PARTICLES.has(token));
}

export function nameKey(value) {
  return nameTokens(value).join(' ');
}

function compatible(a, b) {
  if (!a.length || !b.length) return false;
  if (a[0] !== b[0]) return false;
  const aLast = a[a.length - 1];
  const bLast = b[b.length - 1];
  if (a.length === 1 || b.length === 1) {
    return aLast === bLast || aLast.startsWith(bLast) || bLast.startsWith(aLast);
  }
  if (aLast === bLast) return true;
  if (aLast.length === 1 && bLast.startsWith(aLast)) return true;
  if (bLast.length === 1 && aLast.startsWith(bLast)) return true;
  return false;
}

function mergeNameGroups(variants) {
  const groups = [];
  for (const variant of variants) {
    const existing = groups.find((group) => group.some((row) => compatible(row.tokens, variant.tokens)));
    if (existing) existing.push(variant);
    else groups.push([variant]);
  }
  // Fusión iterativa (una fusión puede hacer compatibles dos grupos).
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        if (groups[i].some((a) => groups[j].some((b) => compatible(a.tokens, b.tokens)))) {
          groups[i] = [...groups[i], ...groups[j]];
          groups.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

function canonicalOf(group) {
  const sorted = [...group].sort((a, b) => (b.tokens.length - a.tokens.length) || (b.name.length - a.name.length) || a.name.localeCompare(b.name));
  const canonical = sorted[0];
  return {
    name: canonical.name,
    tokens: canonical.tokens,
    aliases: [...new Set(group.map((row) => row.name).filter((name) => name !== canonical.name))]
  };
}

/** Extrae pares nombre+email y correos sueltos de un texto. */
export function extractContactsFromText(value) {
  const textValue = normalizeText(value);
  const pairs = [];
  const emails = new Set();
  const names = new Set();
  const take = (nameRaw, emailRaw) => {
    const email = String(emailRaw || '').trim().toLowerCase();
    const name = cleanName(nameRaw);
    if (!email) return;
    emails.add(email);
    if (name) {
      names.add(name);
      pairs.push({ name, email });
    }
  };
  PAIR_NAME_EMAIL_RE.lastIndex = 0;
  for (const match of textValue.matchAll(PAIR_NAME_EMAIL_RE)) take(match[1], match[2]);
  PAIR_EMAIL_NAME_RE.lastIndex = 0;
  for (const match of textValue.matchAll(PAIR_EMAIL_NAME_RE)) take(match[2], match[1]);
  PAIR_NAME_SEP_EMAIL_RE.lastIndex = 0;
  for (const match of textValue.matchAll(PAIR_NAME_SEP_EMAIL_RE)) take(match[1], match[2]);
  EMAIL_RE.lastIndex = 0;
  for (const match of textValue.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase();
    emails.add(email);
  }
  return { pairs, emails: [...emails], names: [...names] };
}

function nameFromTitle(title) {
  const match = normalizeText(title).match(TITLE_NAME_RE);
  if (!match) return null;
  return cleanName(match[1]);
}

/** Construye el grafo de personas desde las fuentes del store. */
export function buildIdentityGraph(data = {}) {
  const evidenceRows = []; // {name, email, weight, type, detail}
  const nameOnly = []; // {name, weight, type, detail}
  const contextRows = []; // {emails:[], names:[], detail, weight}
  const addPair = (name, email, weight, type, detail) => {
    const clean = cleanName(name);
    const mail = String(email || '').trim().toLowerCase();
    if (!clean || !new RegExp(`^${EMAIL_SOURCE}$`, 'i').test(mail)) return;
    evidenceRows.push({ name: clean, email: mail, weight: clamp01(weight), type, detail: String(detail || '').slice(0, 180) });
  };
  const addEmailOnly = (email, weight, type, detail) => {
    const mail = String(email || '').trim().toLowerCase();
    if (!new RegExp(`^${EMAIL_SOURCE}$`, 'i').test(mail)) return;
    evidenceRows.push({ name: null, email: mail, weight: clamp01(weight), type, detail: String(detail || '').slice(0, 180) });
  };
  const addName = (name, weight, type, detail) => {
    const clean = cleanName(name);
    if (!clean) return;
    nameOnly.push({ name: clean, weight: clamp01(weight), type, detail: String(detail || '').slice(0, 180) });
  };
  const addContext = (context) => {
    if (!context.emails.length) return;
    contextRows.push({ ...context, weight: clamp01(context.weight) });
  };

  const identity = data.identity && typeof data.identity === 'object' ? data.identity : {};

  // 1) Metadatos/mapeos manuales (máxima confianza).
  for (const entry of Array.isArray(identity.contacts) ? identity.contacts : []) {
    if (!entry || typeof entry !== 'object') continue;
    const emails = Array.isArray(entry.emails) ? entry.emails : [entry.email].filter(Boolean);
    for (const email of emails) addPair(entry.name, email, 0.9, 'manual', entry.note || 'contacto manual');
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) addName(alias, 0.3, 'manual', `alias de ${entry.name || ''}`);
  }
  for (const entry of Array.isArray(identity.metadata) ? identity.metadata : []) {
    if (!entry || typeof entry !== 'object') continue;
    const emails = Array.isArray(entry.emails) ? entry.emails : [entry.email].filter(Boolean);
    for (const email of emails) addPair(entry.name, email, 0.85, 'metadata', entry.source || 'metadatos importados');
  }

  // 2) Gmail solo si la cuenta está conectada (sin red).
  const googleConnections = Array.isArray(data.googleConnections) ? data.googleConnections : [];
  if (googleConnections.length) {
    for (const connection of googleConnections) {
      if (connection?.email) addEmailOnly(connection.email, 0.35, 'gmail_account', 'cuenta de Gmail conectada');
    }
    for (const message of Array.isArray(identity.gmailMessages) ? identity.gmailMessages : []) {
      if (!message || typeof message !== 'object') continue;
      const subject = String(message.subject || '').slice(0, 80);
      const detail = `Gmail: ${subject || 'mensaje'}`;
      const from = message.from || {};
      if (from.email) addPair(from.name, from.email, 0.55, 'gmail_message', detail);
      const to = Array.isArray(message.to) ? message.to : [message.to].filter(Boolean);
      const toEmails = [];
      for (const recipient of to) {
        const email = typeof recipient === 'string' ? recipient : recipient?.email;
        const name = typeof recipient === 'string' ? null : recipient?.name;
        if (email) {
          toEmails.push(String(email).toLowerCase());
          addPair(name, email, 0.55, 'gmail_message', detail);
        }
      }
      if (from.email) toEmails.unshift(String(from.email).toLowerCase());
      addContext({ emails: [...new Set(toEmails)], names: from.name ? [from.name] : [], detail, weight: 0.15 });
    }
  }

  // 3) Agenda (títulos, attendees y notas).
  for (const event of Array.isArray(data.agenda) ? data.agenda : []) {
    if (!event || typeof event !== 'object') continue;
    const detail = `${event.id || 'cita'} «${String(event.title || '').slice(0, 70)}»`;
    const titleName = nameFromTitle(event.title || '');
    const attendees = Array.isArray(event.attendees) ? event.attendees.map((email) => String(email).trim().toLowerCase()).filter(Boolean) : [];
    if (titleName && attendees.length === 1) addPair(titleName, attendees[0], 0.6, 'agenda_attendee', detail);
    else if (titleName && attendees.length > 1) addName(titleName, 0.2, 'agenda_title', detail);
    for (const email of attendees) addEmailOnly(email, 0.3, 'agenda_attendee', detail);
    const textContacts = extractContactsFromText([event.notes, event.context, event.result].filter(Boolean).join(' '));
    for (const pair of textContacts.pairs) addPair(pair.name, pair.email, 0.6, 'agenda_note', detail);
    for (const email of textContacts.emails) addEmailOnly(email, 0.25, 'agenda_note', detail);
    if (textContacts.names.length === 1 && textContacts.emails.length >= 2) {
      addContext({ emails: textContacts.emails, names: textContacts.names, detail, weight: 0.3 });
    }
  }

  // 4) Inbox y capturas.
  for (const item of Array.isArray(data.inbox) ? data.inbox : []) {
    if (!item || typeof item !== 'object') continue;
    const detail = `${item.id || 'captura'}: ${String(item.input || '').slice(0, 60)}`;
    const textContacts = extractContactsFromText([item.input, item.notes, item.title].filter(Boolean).join(' '));
    for (const pair of textContacts.pairs) addPair(pair.name, pair.email, 0.6, 'inbox_text', detail);
    for (const email of textContacts.emails) addEmailOnly(email, 0.25, 'inbox_text', detail);
    if (textContacts.names.length === 1 && textContacts.emails.length >= 2) {
      addContext({ emails: textContacts.emails, names: textContacts.names, detail, weight: 0.35 });
    }
  }

  // 5) Reuniones, rutinas y OKR (nombres y correos mencionados).
  for (const meeting of Array.isArray(data.meetings) ? data.meetings : []) {
    if (!meeting || typeof meeting !== 'object') continue;
    const detail = `${meeting.id || 'reunión'} ${String(meeting.name || '').slice(0, 50)}`;
    const contacts = extractContactsFromText([meeting.participants, meeting.purpose, meeting.notes].filter(Boolean).join(' '));
    for (const pair of contacts.pairs) addPair(pair.name, pair.email, 0.5, 'meeting', detail);
    for (const email of contacts.emails) addEmailOnly(email, 0.2, 'meeting', detail);
    if (meeting.owner && !/^yo$/i.test(String(meeting.owner))) addName(meeting.owner, 0.15, 'meeting_owner', detail);
  }
  for (const routine of Array.isArray(data.recurrences) ? data.recurrences : []) {
    if (!routine || typeof routine !== 'object') continue;
    const detail = `${routine.id || 'rutina'} ${String(routine.title || '').slice(0, 50)}`;
    const contacts = extractContactsFromText([routine.notes, routine.owner].filter(Boolean).join(' '));
    for (const pair of contacts.pairs) addPair(pair.name, pair.email, 0.45, 'routine', detail);
  }
  for (const okr of Array.isArray(data.okrs) ? data.okrs : []) {
    if (!okr || typeof okr !== 'object') continue;
    const detail = `${okr.id || 'OKR'} ${String(okr.objective || '').slice(0, 50)}`;
    const contacts = extractContactsFromText([okr.owner, okr.nextAction, okr.notes].filter(Boolean).join(' '));
    for (const pair of contacts.pairs) addPair(pair.name, pair.email, 0.45, 'okr', detail);
    if (okr.owner && !/^yo$/i.test(String(okr.owner))) addName(okr.owner, 0.1, 'okr_owner', detail);
  }

  // 6) Firmas de las muestras de estilo (solo nombre; correo si aparece).
  const styleSamples = data.style && typeof data.style.samples === 'object' ? data.style.samples : {};
  for (const [register, rows] of Object.entries(styleSamples)) {
    for (const row of Array.isArray(rows) ? rows.slice(-3) : []) {
      const textValue = typeof row === 'string' ? row : row?.text;
      if (!textValue) continue;
      const { signature } = extractClosingAndSignature(textValue);
      if (!signature) continue;
      const signatureContacts = extractContactsFromText(signature);
      for (const pair of signatureContacts.pairs) addPair(pair.name, pair.email, 0.5, 'signature', `firma (${register})`);
      for (const email of signatureContacts.emails) addEmailOnly(email, 0.2, 'signature', `firma (${register})`);
      const firstLine = signature.split('\n').map((line) => cleanName(line)).find(Boolean);
      if (firstLine) addName(firstLine, 0.2, 'signature_name', `firma (${register})`);
    }
  }

  // 7) Coapariciones: correos que aparecen juntos con un solo nombre.
  for (const context of contextRows) {
    if (context.names.length !== 1 || context.emails.length < 2) continue;
    for (const email of context.emails) {
      addPair(context.names[0], email, context.weight, 'cooccurrence', `${context.detail} (${context.emails.length} correos en el mismo hilo)`);
    }
  }

  // 8) Agrupar nombres (exactos + compatibles por inicial/apellido).
  const variants = [];
  const seenVariant = new Set();
  for (const row of [...evidenceRows.filter((item) => item.name), ...nameOnly]) {
    const tokens = nameTokens(row.name);
    if (!tokens.length) continue;
    const key = `${tokens.join(' ')}|${row.name}`;
    if (seenVariant.has(key)) continue;
    seenVariant.add(key);
    variants.push({ name: row.name, tokens });
  }
  const groups = mergeNameGroups(variants).map(canonicalOf);

  const findGroup = (name) => {
    const tokens = nameTokens(name);
    return groups.find((group) => group.tokens.join(' ') === tokens.join(' ') || group.aliases.some((alias) => nameTokens(alias).join(' ') === tokens.join(' ')) || compatible(group.tokens, tokens));
  };

  // Asignar evidencias nombre↔correo a grupos; correos sueltos quedan aparte.
  const emailGroups = new Map(); // email -> group
  const pendingPairs = new Map(); // group -> {email -> rows[]}
  for (const row of evidenceRows) {
    if (!row.name) continue;
    const group = findGroup(row.name);
    if (!group) continue;
    if (!pendingPairs.has(group)) pendingPairs.set(group, new Map());
    const perEmail = pendingPairs.get(group);
    if (!perEmail.has(row.email)) perEmail.set(row.email, []);
    perEmail.get(row.email).push(row);
  }
  // Resolver conflictos: un email se asigna al grupo con más peso.
  const emailCandidates = new Map();
  for (const [group, perEmail] of pendingPairs) {
    for (const [email, rows] of perEmail) {
      const weight = combineEvidence(rows.map((row) => row.weight));
      if (!emailCandidates.has(email)) emailCandidates.set(email, []);
      emailCandidates.get(email).push({ group, rows, weight });
    }
  }
  for (const [email, candidates] of emailCandidates) {
    candidates.sort((a, b) => b.weight - a.weight);
    const winner = candidates[0];
    if (!winner) continue;
    if (!emailGroups.has(email)) emailGroups.set(email, winner.group);
    if (candidates.length > 1) {
      winner.group.evidence.push({
        type: 'conflict',
        detail: `el correo ${email} también aparece con otro nombre`,
        weight: 0.05,
        email
      });
    }
  }
  const emailOnlyRows = evidenceRows.filter((row) => !row.name);
  for (const row of emailOnlyRows) {
    if (emailGroups.has(row.email)) continue;
    // Correos sin nombre: persona propia (se resolverá por email).
    const local = row.email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    const display = local.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    const group = { name: display || row.email, tokens: nameTokens(display || row.email), aliases: [], emailsOnly: true };
    groups.push(group);
    emailGroups.set(row.email, group);
  }

  // Construir personas.
  const people = [];
  for (const group of groups) {
    const emails = [];
    for (const [email, owner] of emailGroups) {
      if (owner !== group) continue;
      const rows = (pendingPairs.get(group)?.get(email)) || [];
      const emailEvidence = [
        ...rows.map((row) => ({ type: row.type, detail: row.detail, weight: row.weight, email })),
        ...emailOnlyRows.filter((row) => row.email === email).map((row) => ({ type: row.type, detail: row.detail, weight: row.weight, email }))
      ];
      if (!emailEvidence.length) continue;
      emails.push({ email, domain: email.split('@')[1] || '', evidence: emailEvidence });
    }
    const evidence = [];
    for (const row of evidenceRows) {
      if (row.name && findGroup(row.name) === group) evidence.push({ type: row.type, detail: row.detail, weight: row.weight, email: row.email });
    }
    for (const row of nameOnly) {
      if (findGroup(row.name) === group) evidence.push({ type: row.type, detail: row.detail, weight: row.weight, email: null });
    }
    for (const [email, owner] of emailGroups) {
      if (owner !== group) continue;
      const rows = pendingPairs.get(group)?.get(email) || [];
      for (const row of rows) evidence.push({ type: row.type, detail: row.detail, weight: row.weight, email });
      for (const row of emailOnlyRows.filter((item) => item.email === email)) {
        evidence.push({ type: row.type, detail: row.detail, weight: row.weight, email });
      }
    }
    // Evidencia de dominio (débil; solo informativa y para confianza baja).
    const domains = [...new Set(emails.map((row) => row.domain).filter(Boolean))];
    for (const domain of domains) evidence.push({ type: 'domain', detail: `dominio ${domain}`, weight: 0.05, email: null });

    const uniqueEvidence = [];
    const seenEvidence = new Set();
    for (const row of evidence) {
      const key = `${row.type}|${row.detail}|${row.email || ''}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      uniqueEvidence.push(row);
    }
    const confidence = round3(combineEvidence(uniqueEvidence.filter((row) => row.type !== 'name_match').map((row) => row.weight)));
    if (!emails.length && !uniqueEvidence.length) continue;
    people.push({
      id: `P-${Math.abs(hashString(`${group.name}|${emails.map((row) => row.email).join(',')}`)).toString(36).slice(0, 8)}`,
      name: group.name,
      aliases: group.aliases,
      tokens: group.tokens,
      emails,
      domains,
      evidence: uniqueEvidence.slice(0, 16),
      confidence,
      requiresConfirmation: confidence < 0.8
    });
  }
  return { people, evidenceCount: evidenceRows.length + nameOnly.length };
}

function hashString(value) {
  let hash = 2166136261;
  const textValue = String(value);
  for (let index = 0; index < textValue.length; index += 1) {
    hash ^= textValue.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function matchScore(query, person) {
  const queryTokens = nameTokens(query);
  if (!queryTokens.length) return 0;
  const names = [person.name, ...(person.aliases || [])];
  let best = 0;
  for (const name of names) {
    if (!name) continue;
    if (fold(name) === fold(query)) { best = 1; continue; }
    const tokens = nameTokens(name);
    let matched = 0;
    for (const token of queryTokens) {
      if (tokens.includes(token)) matched += 1;
      else if (token.length === 1 && tokens.some((candidate) => candidate.startsWith(token))) matched += 1;
      else if (token.length >= 3 && tokens.some((candidate) => candidate.startsWith(token))) matched += 0.85;
    }
    best = Math.max(best, matched / queryTokens.length);
  }
  return clamp01(best);
}

function publicCandidate(person, confidence, extraEvidence = []) {
  return {
    id: person.id,
    name: person.name,
    aliases: person.aliases,
    emails: person.emails.map((row) => row.email),
    domains: person.domains,
    confidence: round3(confidence),
    requiresConfirmation: round3(confidence) < 0.8,
    evidence: [...extraEvidence, ...person.evidence].slice(0, 16),
    evidenceCount: person.evidence.length
  };
}

/**
 * Resuelve una persona por nombre o correo.
 * @param {{name?:string, email?:string}} query
 * @param {{data?:object}} [options]
 */
export function resolveIdentity(query = {}, { data = {} } = {}) {
  const graph = buildIdentityGraph(data);
  const email = query.email ? String(query.email).trim().toLowerCase() : '';
  const name = query.name ? String(query.name).trim() : '';
  let candidates = [];
  if (email) {
    candidates = graph.people
      .filter((person) => person.emails.some((row) => row.email === email))
      .map((person) => publicCandidate(person, person.confidence, [{ type: 'email_match', detail: `correo ${email}`, weight: 1 }]));
  } else if (name) {
    candidates = graph.people
      .map((person) => {
        const score = matchScore(name, person);
        if (!score) return null;
        const confidence = round3(person.confidence * (0.6 + 0.4 * score));
        return publicCandidate(person, confidence, [{ type: 'name_match', detail: `coincidencia «${name}» (${Math.round(score * 100)}%)`, weight: score }]);
      })
      .filter(Boolean);
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  candidates = candidates.slice(0, 5);
  const ambiguous = candidates.length > 1 && candidates[0].confidence - candidates[1].confidence < 0.1;
  const requiresConfirmation = candidates.length === 0 || candidates[0].confidence < 0.8 || ambiguous;
  return {
    query: { name: name || null, email: email || null },
    candidates,
    matched: candidates.length,
    requiresConfirmation,
    reason: candidates.length === 0
      ? 'sin coincidencias'
      : candidates[0].confidence < 0.8
        ? 'confianza menor que 0.8'
        : ambiguous
          ? 'varias personas con confianza parecida'
          : null
  };
}

/**
 * Expande una consulta a destinatarios (multi-correo, sin duplicados).
 * @param {{query:string}} input
 * @param {{data?:object}} [options]
 */
export function expandRecipients({ query } = {}, { data = {} } = {}) {
  const value = String(query || '').trim();
  const isEmail = /@/.test(value);
  const resolved = resolveIdentity(isEmail ? { email: value } : { name: value }, { data });
  const candidates = resolved.candidates;
  let selected = [];
  let ambiguous = false;
  if (candidates.length) {
    const strong = candidates.filter((candidate) => candidate.confidence >= 0.8);
    if (!strong.length) {
      selected = [candidates[0]];
    } else if (strong.length === 1) {
      selected = strong;
    } else if (candidates[0].confidence - (candidates[1]?.confidence || 0) > 0.1) {
      selected = [candidates[0]];
    } else {
      selected = strong;
      ambiguous = true;
    }
  }
  const people = selected.map((candidate) => ({
    name: candidate.name,
    emails: candidate.emails,
    confidence: candidate.confidence,
    requiresConfirmation: candidate.requiresConfirmation,
    evidence: candidate.evidence.slice(0, 8)
  }));
  const seen = new Set();
  const recipients = [];
  let duplicatesRemoved = 0;
  for (const person of people) {
    for (const email of person.emails) {
      const key = email.toLowerCase();
      if (seen.has(key)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(key);
      recipients.push(email);
    }
  }
  const requiresConfirmation = resolved.requiresConfirmation || ambiguous || people.length === 0 || people.some((person) => person.requiresConfirmation);
  return {
    query: value,
    people,
    recipients,
    duplicatesRemoved,
    requiresConfirmation,
    matched: candidates.length,
    resolution: {
      reason: resolved.reason,
      candidates: candidates.slice(0, 5).map((candidate) => ({
        name: candidate.name,
        emails: [...candidate.emails],
        confidence: candidate.confidence,
        requiresConfirmation: candidate.requiresConfirmation
      }))
    }
  };
}

/** Lista/busca personas del grafo (para la UI). */
export function listPeople({ q = '', limit = 50 } = {}, { data = {} } = {}) {
  const graph = buildIdentityGraph(data);
  const query = String(q || '').trim();
  const rows = graph.people
    .filter((person) => {
      if (!query) return true;
      const haystack = [person.name, ...person.aliases, ...person.emails.map((row) => row.email)].join(' ');
      if (/@/.test(query)) return person.emails.some((row) => row.email.includes(query.toLowerCase()));
      return nameTokens(query).every((token) => nameTokens(haystack).some((candidate) => candidate === token || candidate.startsWith(token)));
    })
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, Math.min(100, Math.max(1, Number(limit) || 50)));
  return {
    items: rows.map((person) => ({
      id: person.id,
      name: person.name,
      aliases: person.aliases,
      emails: person.emails.map((row) => row.email),
      domains: person.domains,
      confidence: person.confidence,
      requiresConfirmation: person.requiresConfirmation,
      evidenceCount: person.evidence.length
    })),
    count: rows.length,
    total: graph.people.length,
    evidenceCount: graph.evidenceCount
  };
}
