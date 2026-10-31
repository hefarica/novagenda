/**
 * Opiniones por rol: rúbrica determinista + opinión breve opcional del LLM.
 *
 * La rúbrica es la fuente de verdad (sin red, reproducible). Si hay una API key
 * configurada en la bóveda de t1 se intenta una frase adicional con presupuesto
 * corto; si falla o está en fallback, se ignora sin afectar la propuesta.
 */
import { ROLES } from './roster.mjs';
import { getSecret } from '../security/vault.mjs';

const VERDICT_APPROVE = 0.70;
const VERDICT_REVIEW = 0.52;

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function verdictFor(score) {
  if (score >= VERDICT_APPROVE) return 'aprobar';
  if (score >= VERDICT_REVIEW) return 'revisar';
  return 'rechazar';
}

function flagSet(risk) {
  return new Set((risk?.flags || []).map((flag) => flag.code));
}

function scoreFor(roleId, ctx) {
  const { riskScore, flags, level, externalRecipients, newContacts, attachments } = ctx;
  const base = clamp(1 - riskScore * 0.04);
  const external = externalRecipients > 0;
  switch (roleId) {
    case 'chief_of_staff':
      return clamp(base - (level === 'N3' ? 0.05 : 0));
    case 'agenda':
      return clamp(base - (flags.has('DEADLINE') ? 0.15 : 0) - (level === 'N3' ? 0.05 : 0));
    case 'correspondencia':
      return clamp((external ? 0.72 : 0.9) - (flags.has('MONEY') ? 0.12 : 0) - (flags.has('LEGAL') ? 0.18 : 0));
    case 'documentos':
      return clamp((attachments ? 0.75 : 0.88) - (flags.has('LEGAL') ? 0.18 : 0));
    case 'research':
      return clamp(base - 0.05 - (flags.has('LEGAL') ? 0.1 : 0));
    case 'qa': {
      const penalty = Math.min(0.3, flags.size * 0.05) + (newContacts > 2 ? 0.05 : 0);
      return clamp(base - penalty);
    }
    case 'auditoria':
      return clamp((flags.has('MONEY') || flags.has('LEGAL') ? 0.45 : 0.85) - (riskScore >= 7 ? 0.1 : 0));
    default:
      return base;
  }
}

function noteFor(roleId, ctx) {
  const { riskScore, flags, externalRecipients, newContacts, attachments } = ctx;
  const list = [];
  if (flags.has('MONEY')) list.push('hay dinero de por medio');
  if (flags.has('LEGAL')) list.push('hay términos legales');
  if (flags.has('DEADLINE')) list.push('el plazo aprieta');
  if (externalRecipients > 0) list.push(`${externalRecipients} destinatario(s) externo(s)`);
  if (newContacts > 0) list.push(`${newContacts} contacto(s) nuevo(s)`);
  if (attachments > 0) list.push(`${attachments} adjunto(s)`);
  const summary = list.length ? list.join(', ') : 'sin señales de riesgo relevantes';
  const notes = {
    chief_of_staff: `Riesgo ${riskScore}/10; ${summary}.`,
    agenda: flags.has('DEADLINE') ? 'Conviene confirmar disponibilidad antes de comprometer una hora.' : 'No detecto choque de agenda en esta propuesta.',
    correspondencia: externalRecipients > 0 ? 'El mensaje sale a destinatarios externos; cuidaría tono y datos personales.' : 'Comunicación interna: riesgo bajo.',
    documentos: attachments > 0 ? 'Revisaría los adjuntos antes de enviarlos.' : 'Borrador sin adjuntos; listo para revisión rápida.',
    research: `Contexto revisado; ${summary}.`,
    qa: flags.size ? `Encontré ${flags.size} señal(es) a revisar: ${summary}.` : 'Sin objeciones de calidad.',
    auditoria: flags.has('MONEY') || flags.has('LEGAL') ? 'Requiere trazabilidad reforzada y aprobación explícita.' : 'Trazable en el ledger; sin alertas de cumplimiento.'
  };
  return notes[roleId] || `Riesgo ${riskScore}/10.`;
}

/**
 * @param {{risk:object, level:string, channel:string, recipients:string[]}} input
 * @returns {object[]} opiniones en el orden del organigrama
 */
export function rubricOpinions({ risk, level }) {
  const flags = flagSet(risk);
  const ctx = {
    riskScore: Number(risk?.score) || 0,
    flags,
    level,
    externalRecipients: Number(risk?.externalRecipients) || 0,
    newContacts: Number(risk?.newContacts) || 0,
    attachments: Number(risk?.signals?.attachments) || 0
  };
  return ROLES.map((role) => {
    const score = Number(scoreFor(role.id, ctx).toFixed(3));
    return {
      role: role.id,
      nombre: role.nombre,
      score,
      verdict: verdictFor(score),
      note: noteFor(role.id, ctx),
      source: 'rubric'
    };
  });
}

/** @param {object[]} opinions */
export function computeVoice(opinions) {
  const list = Array.isArray(opinions) ? opinions : [];
  if (!list.length) return 0;
  const total = list.reduce((sum, opinion) => sum + clamp(opinion.score), 0);
  return Number((total / list.length).toFixed(3));
}

/** ¿Hay proveedor LLM configurado por clave? (Ollama se prueba en t3, aquí no.) */
function llmConfigured() {
  return !!String(getSecret('llm.openai.apiKey') || '').trim();
}

/**
 * Opinión breve opcional del LLM. Nunca lanza y nunca bloquea más de ~2,2 s.
 * @param {{proposal:object, risk:object, level:string}} input
 * @returns {Promise<{text:string,provider:string|null,model:string|null,latencyMs:number|null,source:'llm'}|null>}
 */
export async function maybeLlmOpinion({ proposal, risk, level }) {
  if (!llmConfigured()) return null;
  try {
    const module = await import('../llm/client.mjs');
    if (typeof module.llmChat !== 'function') return null;
    const recipients = Array.isArray(proposal.recipients) ? proposal.recipients.slice(0, 6) : [];
    const flags = (risk?.flags || []).map((flag) => flag.label).join(', ') || 'ninguna';
    const messages = [
      { role: 'system', content: 'Eres el jefe de gabinete de una oficina personal. En UNA frase (máximo 220 caracteres) di si esta propuesta es segura o requiere cuidado, sin inventar datos.' },
      { role: 'user', content: `Nivel ${level}; riesgo ${risk?.score}/10; señales: ${flags}. Canal: ${proposal.channel}. Destinatarios: ${recipients.join(', ') || 'ninguno'}. Asunto: ${String(proposal.subject || '').slice(0, 160)}. Cuerpo: ${String(proposal.body || '').slice(0, 700)}` }
    ];
    const result = await module.llmChat({
      messages,
      profile: 'chat',
      temperature: 0.2,
      maxTokens: 90,
      cache: false,
      deadlineMs: 2000,
      scope: 'office:proposal'
    });
    if (!result || result.fallback === true || !result.reply) return null;
    const text = String(result.reply).replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!text) return null;
    return {
      text,
      provider: result.provider || null,
      model: result.model || null,
      latencyMs: result.latencyMs ?? null,
      source: 'llm'
    };
  } catch {
    return null;
  }
}
