/**
 * Consulta interna al equipo de la oficina.
 *
 * Antes de responder a una instrucción con efectos (correo, WhatsApp, Telegram,
 * documento, cita o reunión), el agente reúne la opinión breve de los roles
 * especializados. Es determinista y rápido: usa el mismo motor de riesgo y la
 * misma rúbrica que la bandeja de propuestas, así que lo que el chat dice es
 * exactamente lo que la Oficina evaluará.
 */

import { assessRisk } from '../office/risk.mjs';
import { rubricOpinions } from '../office/opinions.mjs';

const OUTBOUND = new Set(['enviar_correo', 'enviar_whatsapp', 'enviar_telegram', 'enviar_documento']);
const MEETING = new Set(['crear_cita', 'mover_cita', 'cancelar_cita', 'completar_cita', 'crear_meet', 'buscar_huecos']);
const TASKING = new Set(['crear_tarea', 'cerrar_tarea']);
const RESEARCH_HINT = /acta|predio|lote|escritura|catastro|normativa|contrato|licencia|matr[ií]cula|antecedente/i;

const CHANNEL_BY_ACTION = {
  enviar_correo: 'email',
  enviar_whatsapp: 'whatsapp',
  enviar_telegram: 'telegram',
  enviar_documento: 'email'
};

function flatRecipients(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((item) => String(item || '').split(/[,;]/)).map((item) => item.trim()).filter(Boolean);
}

/** ¿Conviene que el equipo opine antes de responder? */
export function shouldConsult(action) {
  return OUTBOUND.has(action) || MEETING.has(action) || TASKING.has(action);
}

function pickRoles(action, text, risk, opinions) {
  const ids = new Set(['chief_of_staff', 'qa']);
  if (OUTBOUND.has(action)) ids.add('correspondencia');
  if (action === 'enviar_documento') ids.add('documentos');
  if (MEETING.has(action)) ids.add('agenda');
  if (RESEARCH_HINT.test(String(text || ''))) ids.add('research');
  if (Number(risk?.score) >= 6) ids.add('auditoria');
  return opinions
    .filter((opinion) => ids.has(opinion.role))
    .slice(0, 4)
    .map((opinion) => ({
      role: opinion.role,
      nombre: opinion.nombre,
      verdict: opinion.verdict,
      score: opinion.score,
      note: opinion.note || ''
    }));
}

/**
 * Consulta al equipo para una acción concreta.
 * @param {{action:string,args?:object,text?:string,data?:object}} input
 * @returns {{consulted:boolean,risk:object,level:string,roles:object[],summary:string}}
 */
export function consultTeam({ action, args = {}, text = '', data = null } = {}) {
  if (!shouldConsult(action)) {
    return { consulted: false, risk: null, level: null, roles: [], summary: '' };
  }

  const channel = CHANNEL_BY_ACTION[action] || 'none';
  const recipients = action === 'enviar_correo'
    ? flatRecipients(args.to)
    : action === 'enviar_documento'
      ? flatRecipients(args.to)
      : [];
  const attachments = args.docId ? [{ id: args.docId }] : [];
  const body = [args.subject, args.body, args.text, text].filter(Boolean).join('\n');

  const risk = assessRisk({
    kind: action,
    channel,
    recipients,
    subject: args.subject,
    body,
    attachments,
    meta: { notes: text }
  }, { data });

  const level = risk.score >= 7 ? 'N3' : risk.score >= 3 ? 'N2' : 'N1';
  const opinions = rubricOpinions({ risk, level });
  const roles = pickRoles(action, text, risk, opinions);
  const notes = roles.filter((role) => role.note).map((role) => `${role.nombre}: ${role.note}`);
  const summary = notes.join(' · ');

  return {
    consulted: roles.length > 0,
    risk: { score: risk.score, flags: (risk.flags || []).map((flag) => flag.code) },
    level,
    roles,
    summary
  };
}

export const TEAM_ACTIONS = Object.freeze({
  outbound: [...OUTBOUND],
  meeting: [...MEETING],
  tasking: [...TASKING]
});

/* ------------------------------------------------------------------ */
/* Consulta profunda: cada especialista opina con el LLM               */
/* ------------------------------------------------------------------ */

import { llmComplete } from '../llm/client.mjs';

const ROLE_BRIEF = {
  chief_of_staff: 'Coordinas la oficina. Di en una frase si la tarea está bien planteada y qué falta.',
  agenda: 'Revisas calendario, conflictos, desplazamientos y horas. Señala el riesgo de agenda en una frase.',
  correspondencia: 'Revisas tono, destinatarios y datos personales de un mensaje. Señala el cuidado necesario en una frase.',
  documentos: 'Revisas adjuntos, versiones y formato del documento. Señala qué falta en una frase.',
  research: 'Aportas contexto verificable. Si falta una fuente o un dato clave, dilo en una frase.',
  qa: 'Haces control de calidad. Señala en una frase los errores o señales que deben revisarse antes de aprobar.',
  auditoria: 'Vigilas riesgo, dinero y términos legales. Resume el riesgo en una frase.'
};

async function specialistNote({ role, action, args = {}, text = '', risk = null }) {
  const brief = ROLE_BRIEF[role.role];
  if (!brief) return null;
  const facts = {
    accion: action,
    destinatarios: args.to || null,
    asunto: args.subject || null,
    fecha: args.date || null,
    hora: args.time || null,
    texto: String(args.body || args.text || text || '').slice(0, 260),
    riesgo: risk || null
  };
  try {
    const result = await llmComplete({
      profile: 'chat',
      messages: [
        {
          role: 'system',
          content: `Eres ${role.nombre} en la oficina de Héctor Fabio Riascos C. ${brief}
Responde UNA sola frase en español, máximo 22 palabras, concreta y útil. No inventes datos, cifras, fechas ni compromisos; si falta algo, dilo. No repitas la tarea completa ni saludes.`
        },
        { role: 'user', content: JSON.stringify(facts) }
      ],
      json: false,
      fallback: null,
      deadlineMs: 6_000,
      workflow: 'chat'
    });
    if (result.ok && result.text && result.text.trim()) {
      return String(result.text).trim().replace(/\s+/g, ' ').slice(0, 180);
    }
  } catch {
    /* se queda la rúbrica */
  }
  return null;
}

/**
 * Consulta al equipo con opiniones del LLM (en paralelo) y respaldo determinista.
 * @param {{action:string,args?:object,text?:string,data?:object,deadlineMs?:number}} input
 */
export async function consultTeamDeep(input = {}) {
  const base = consultTeam(input);
  if (!base.consulted || !base.roles.length) {
    return { ...base, source: 'rubric' };
  }
  const PRIORITY = { correspondencia: 1, agenda: 1, documentos: 1, qa: 2, chief_of_staff: 3, research: 4, auditoria: 4 };
  const ordered = [...base.roles].sort((a, b) => (PRIORITY[a.role] ?? 9) - (PRIORITY[b.role] ?? 9));
  const roles = ordered.slice(0, 3);
  const results = await Promise.allSettled(roles.map((role) => specialistNote({
    role,
    action: input.action,
    args: input.args || {},
    text: input.text || '',
    risk: base.risk
  })));
  let llmCount = 0;
  const enriched = base.roles.map((role) => {
    const index = roles.findIndex((item) => item.role === role.role);
    if (index >= 0 && results[index].status === 'fulfilled' && results[index].value) {
      llmCount += 1;
      return { ...role, note: results[index].value, source: 'llm' };
    }
    return { ...role, source: 'rubric' };
  });
  const summary = enriched.filter((role) => role.note).map((role) => `${role.nombre}: ${role.note}`).join(' · ');
  return {
    ...base,
    roles: enriched,
    summary,
    source: llmCount === 0 ? 'rubric' : llmCount === roles.length ? 'llm' : 'mixed'
  };
}
