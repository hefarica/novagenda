/**
 * Redacción de borradores "como yo".
 *
 * Flujo:
 *   1. Perfil efectivo del registro (registro → global → default).
 *   2. Apertura/cierre anti-repetición (7 días por contacto y tipo).
 *   3. Borrador determinista con el saludo, ritmo de frase, párrafos,
 *      formalidad y firma del perfil.
 *   4. Si hay proveedor LLM configurado, se pide UNA alternativa con 3 muestras
 *      reales y prohibiciones explícitas; solo se usa si mejora el score y
 *      conserva la firma del perfil. Sin LLM funciona igual.
 *   5. Se registran las fórmulas elegidas para la ventana anti-repetición.
 */
import { store } from '../store.mjs';
import { llmComplete } from '../llm/client.mjs';
import { buildProviderChain, resolveLlmConfig } from '../llm/config.mjs';
import { traceLlm } from '../llm/trace.mjs';
import { fold, normalizeText } from './features.mjs';
import { profileForRegister, samplesForPrompt } from './profile.mjs';
import { pickVariant, recordComposeVariations, contactKey } from './variation.mjs';
import { scoreText, scrubAiPhrases } from './score.mjs';
import { canonicalFacts, canonicalRecipient, canonicalText, canonicalThread } from './lingo.mjs';

const MAX_INTENT = 2_000;
const MAX_FACTS_LINES = 6;
const MAX_FACT_LINE = 220;

function words(value) {
  return normalizeText(value).split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function capitalize(value) {
  const textValue = String(value || '').trim();
  if (!textValue) return '';
  return textValue.charAt(0).toUpperCase() + textValue.slice(1);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = normalizeText(value);
    const key = fold(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Nombre de pila del destinatario, o null. */
export function recipientFirstName(recipient) {
  if (!recipient) return null;
  if (typeof recipient === 'string') {
    if (/@/.test(recipient)) return null;
    return capitalize(recipient.trim().split(/\s+/)[0]);
  }
  const name = recipient.name ? String(recipient.name).trim() : '';
  if (name && !/^yo$/i.test(name)) return capitalize(name.split(/\s+/)[0]);
  const email = recipient.email || (Array.isArray(recipient.emails) ? recipient.emails[0] : '');
  if (email && /@/.test(email)) {
    const local = String(email).split('@')[0].split(/[._-]+/).filter(Boolean)[0];
    return local ? capitalize(local) : null;
  }
  return null;
}

function renderTemplate(template, name) {
  const value = normalizeText(template || '');
  const rendered = value.includes('{nombre}')
    ? value.replace(/\{nombre\}/g, name || '')
    : value;
  return normalizeText(rendered.replace(/\s{2,}/g, ' ')).replace(/([,:])\s*$/, '$1');
}

/** Alternativas de apertura, priorizando las que conservan el saludo del perfil. */
export function greetingPool(profile, name, formality = 'tú') {
  const base = profile?.greetingTemplate || 'Hola {nombre}:';
  const sameStem = profile?.greetingStem === 'hola'
    ? ['Hola {nombre},', 'Hola {nombre}:', 'Hola de nuevo {nombre}:', 'Hola {nombre}, ¿cómo estás?']
    : ['Buen día {nombre}:', 'Buen día {nombre},', 'Buenos días {nombre},', 'Hola {nombre},'];
  const formal = formality === 'usted'
    ? ['Estimado {nombre}:', 'Estimada {nombre}:', 'Buen día {nombre}:', 'Apreciado {nombre}:']
    : ['Hola {nombre}:', 'Buen día {nombre}:', 'Hola {nombre},', 'Buenos días {nombre},'];
  const templates = unique([base, ...sameStem, ...formal, 'Hola {nombre}:', 'Buen día {nombre}:']);
  return unique(templates.map((template) => renderTemplate(template, name)).filter((value) => value.length <= 90));
}

/** Alternativas de cierre, primero la del perfil. */
export function closingPool(profile, formality = 'tú') {
  const base = profile?.closing || 'Saludos,';
  const common = ['Saludos,', 'Un abrazo,', 'Gracias,', 'Un saludo,', 'Cordialmente,', 'Nos hablamos,', 'Quedo pendiente,'];
  const formal = ['Cordialmente,', 'Atentamente,', 'Saludos cordiales,', 'Gracias por su tiempo,'];
  const casual = ['Un abrazo,', 'Abrazos,', 'Nos hablamos,', 'Gracias,'];
  return unique([base, ...(formality === 'usted' ? formal : casual), ...common]).filter((value) => value.length <= 50);
}

/** Convierte facts (objeto/array/string) en líneas breves. */
export function factsToLines(facts, limit = MAX_FACTS_LINES) {
  const lines = [];
  const push = (value) => {
    const clean = scrubAiPhrases(String(value ?? '')).replace(/\s+/g, ' ').trim();
    if (clean) lines.push(clean.slice(0, MAX_FACT_LINE));
  };
  if (Array.isArray(facts)) {
    for (const item of facts) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const [key, value] of Object.entries(item)) push(`${prettifyKey(key)}: ${value}`);
      } else if (item !== undefined && item !== null) {
        push(item);
      }
      if (lines.length >= limit) break;
    }
  } else if (facts && typeof facts === 'object') {
    for (const [key, value] of Object.entries(facts)) {
      push(`${prettifyKey(key)}: ${value}`);
      if (lines.length >= limit) break;
    }
  } else if (typeof facts === 'string' && facts.trim()) {
    push(facts);
  }
  return lines.slice(0, limit);
}

function prettifyKey(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\p{L}/u, (letter) => letter.toUpperCase());
}

function splitClauses(value) {
  return normalizeText(value)
    .split(/(?<=[.;:])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function punctuate(value) {
  const clean = normalizeText(value).replace(/[,;:]$/, '').trim();
  if (!clean) return '';
  return /[.!?…]$/.test(clean) ? clean : `${clean}.`;
}

function buildSentences(profile, intent, factLines) {
  const target = Math.max(6, Number(profile.sentenceMean) || 14);
  const fragments = [
    ...splitClauses(intent),
    ...factLines.flatMap((line) => splitClauses(line))
  ].map((fragment) => scrubAiPhrases(fragment)).filter(Boolean);
  const sentences = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    sentences.push(punctuate(buffer.join(' ')));
    buffer = [];
  };
  for (const fragment of fragments) {
    // Las frases largas se parten por comas para acercarse a la media.
    const pieces = words(fragment) > target * 1.8
      ? fragment.split(/,\s+/).map((piece) => piece.trim()).filter(Boolean)
      : [fragment];
    for (const piece of pieces) {
      buffer.push(piece);
      if (words(buffer.join(' ')) >= Math.max(4, target * 0.8)) flush();
    }
  }
  flush();
  return sentences;
}

function fillerSentences(formality) {
  return formality === 'usted'
    ? [
      'Le comparto el detalle para que lo revise.',
      'Si algo no cuadra, lo ajustamos sin problema.',
      'Avíseme y lo cierro enseguida.',
      'Quedo pendiente de su confirmación.',
      'Lo revisamos juntos si le parece bien.'
    ]
    : [
      'Te comparto el detalle para que lo revises.',
      'Si algo no cuadra, lo ajustamos sin problema.',
      'Avísame y lo cierro enseguida.',
      'Quedo pendiente de tu confirmación.',
      'Lo revisamos juntos si te parece bien.'
    ];
}

function buildParagraphs(profile, intent, facts, formality) {
  const paragraphsTarget = Math.min(5, Math.max(1, Number(profile.paragraphs) || 2));
  const factLines = factsToLines(facts);
  const useBullets = (profile.bulletRate || 0) > 0.15 && factLines.length > 0;
  const sentences = buildSentences(profile, intent, useBullets ? factLines.slice(0, 1) : factLines);
  const fillers = fillerSentences(formality).filter((sentence) => !sentences.some((row) => fold(row) === fold(sentence)));
  let fillerIndex = 0;
  while (sentences.length < paragraphsTarget * 2 && fillerIndex < fillers.length) {
    sentences.push(fillers[fillerIndex]);
    fillerIndex += 1;
  }
  if ((profile.questionRate || 0) > 0.15 && !sentences.some((sentence) => sentence.includes('?'))) {
    sentences.push(formality === 'usted' ? '¿Le parece si lo revisamos mañana?' : '¿Te parece si lo revisamos mañana?');
  }
  if ((profile.emojiRate || 0) > 0.2 && !sentences.some((sentence) => /\p{Extended_Pictographic}/u.test(sentence))) {
    const index = Math.min(1, sentences.length - 1);
    if (index >= 0) sentences[index] = `${sentences[index].replace(/[.!?]$/, '')} 🙌.`;
  }

  const paragraphs = [];
  if (useBullets) {
    paragraphs.push(sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join(' '));
    paragraphs.push(factLines.map((line) => `- ${line}`).join('\n'));
    const rest = sentences.slice(Math.ceil(sentences.length / 2));
    if (rest.length) paragraphs.push(rest.join(' '));
  } else {
    const chunk = Math.max(1, Math.ceil(sentences.length / paragraphsTarget));
    for (let index = 0; index < sentences.length; index += chunk) {
      paragraphs.push(sentences.slice(index, index + chunk).join(' '));
    }
  }
  return paragraphs.map((paragraph) => scrubAiPhrases(paragraph)).filter(Boolean).slice(0, 6);
}

/** Borrador determinista (sin LLM). */
export function composeDeterministic({ profile, intent, facts, recipient, opening }) {
  const formality = profile.formality || 'tú';
  const name = recipientFirstName(recipient);
  const greeting = opening || greetingPool(profile, name, formality)[0] || 'Hola:';
  const closing = closingPool(profile, formality)[0] || 'Saludos,';
  const signature = normalizeText(profile.signature || 'Héctor');
  const paragraphs = buildParagraphs(profile, intent, facts, formality);
  const draft = [greeting, ...paragraphs, closing, signature]
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { draft, opening: greeting, closing, signature, paragraphs };
}

function llmPrompt({ profile, samples, intent, facts, recipient, thread }) {
  const sampleText = samples.slice(0, 3).map((sample, index) => `--- Muestra ${index + 1} ---\n${sample.slice(0, 1_800)}`).join('\n\n');
  const factsText = factsToLines(facts).map((line) => `- ${line}`).join('\n') || '(sin datos extra)';
  const threadText = Array.isArray(thread)
    ? thread.slice(-3).map((message) => typeof message === 'string' ? message : (message?.text || message?.body || '')).filter(Boolean).join('\n')
    : '';
  const system = `Eres Héctor y escribes correos con SU voz. Imita el saludo, el ritmo de frase, la formalidad y la firma de las muestras.
Reglas estrictas:
- Devuelve SOLO el cuerpo del correo en texto plano, sin markdown, sin explicaciones y sin comillas.
- Incluye saludo al inicio, párrafos y despedida + firma exactamente como en las muestras.
- PROHIBIDO: "en el mundo actual", "en la era digital", "es importante destacar", "cabe destacar", "no dudes en contactarme", "no dudes en escribirme", "en resumen", "en conclusión", "como modelo de lenguaje", "estoy aquí para ayudarte", listas de viñetas artificiales y markdown.
- No inventes datos que no estén en el encargo.
Perfil de voz: ${JSON.stringify({ saludo: profile.greetingTemplate, despedida: profile.closing, firma: profile.signature, fraseMedia: profile.sentenceMean, parrafos: profile.paragraphs, formalidad: profile.formality, emojis: profile.emojiRate, preguntas: profile.questionRate })}`;
  const user = `Muestras reales de Héctor:
${sampleText}

Encargo:
- Destinatario: ${recipient?.name || recipient?.email || '(sin nombre)'}
- Intención: ${intent}
- Datos: ${factsText}${threadText ? `\n- Hilo previo (contexto): ${threadText.slice(0, 800)}` : ''}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * Compone un borrador con el estilo del registro.
 * @param {{register:string, intent:string, facts?:unknown, recipient?:object|string, thread?:Array, opening?:string}} input
 * @param {{data?:object, useLlm?:boolean, now?:number}} [options]
 */
export async function composeEmail(input = {}, { data = null, useLlm = true, now = Date.now() } = {}) {
  const sourceData = data || store.get();
  const register = input.register ? String(input.register) : null;
  const originalIntent = String(input.intent || '').slice(0, MAX_INTENT).trim();
  const canonicalIntent = canonicalText(originalIntent, { data: sourceData });
  const intent = scrubAiPhrases(canonicalIntent).trim();
  if (!intent) {
    const error = new Error('intent es obligatorio para componer.');
    error.status = 400;
    error.code = 'REQUIRED';
    error.field = 'intent';
    throw error;
  }
  const recipient = canonicalRecipient(input.recipient, { data: sourceData });
  const facts = canonicalFacts(input.facts, { data: sourceData });
  const thread = canonicalThread(input.thread, { data: sourceData });
  const { profile, source, samples, requestedRegister } = profileForRegister(sourceData, register);
  const formality = profile.formality || 'tú';
  const name = recipientFirstName(recipient);
  const contact = contactKey(recipient);

  // Apertura y cierre sin repetir en la ventana de 7 días por contacto/tipo.
  const openingChoice = pickVariant(sourceData, contact, 'apertura', greetingPool(profile, name, formality), {
    now,
    prefer: input.opening ? canonicalText(String(input.opening), { data: sourceData }) : null
  });
  const closingChoice = pickVariant(sourceData, contact, 'cierre', closingPool(profile, formality), { now });
  const deterministic = composeDeterministic({
    profile,
    intent,
    facts,
    recipient,
    opening: openingChoice.text || undefined
  });
  deterministic.closing = closingChoice.text || deterministic.closing;
  let draft = `${deterministic.draft.split('\n\n').slice(0, -2).join('\n\n')}\n\n${deterministic.closing}\n\n${deterministic.signature}`.trim();
  // Reconstrucción segura por si el perfil cambió la firma.
  const signature = normalizeText(profile.signature || 'Héctor');
  if (!draft.endsWith(signature)) {
    draft = `${draft.replace(new RegExp(`${escapeRegExp(signature)}$`), '').trim()}\n\n${signature}`.trim();
  }
  let scored = scoreText(profile, draft);
  let engine = 'deterministic';
  let lingoBodyApplied = false;

  if (useLlm && buildProviderChain(resolveLlmConfig()).length > 0) {
    const promptSamples = samplesForPrompt(sourceData, register, { count: 3 });
    try {
      const llm = await llmComplete({
        profile: 'chat',
        messages: llmPrompt({ profile, samples: promptSamples.samples, intent, facts, recipient, thread }),
        temperature: 0.4,
        maxTokens: 600,
        fallback: null,
        cache: false,
        rateLimit: true,
        scope: `style:${contact}`,
        workflow: 'style-compose',
        deadlineMs: 8_000
      });
      traceLlm({
        workflow: 'style-compose',
        provider: llm.provider,
        model: llm.model,
        ok: llm.ok,
        latencyMs: llm.latencyMs,
        tokens: llm.usage ? llm.usage.totalTokens : null,
        chars: intent.length,
        fallback: llm.fallback,
        errorCode: llm.errorCode,
        detail: llm.error
      });
      if (llm.ok && llm.text) {
        let llmDraft = normalizeText(llm.text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, ''));
        llmDraft = scrubAiPhrases(llmDraft).replace(/\*\*/g, '').trim();
        if (!llmDraft.endsWith(signature)) llmDraft = `${llmDraft}\n\n${signature}`;
        const llmScored = scoreText(profile, llmDraft);
        // Solo se usa si mejora y conserva la firma exacta del perfil.
        if (llmScored.components.signature >= 0.99 && llmScored.score >= scored.score && llmScored.score >= 0.8) {
          draft = llmDraft;
          scored = llmScored;
          engine = 'llm';
        }
      }
    } catch {
      /* el borrador determinista es suficiente */
    }
  }

  // Red de seguridad: aunque el LLM no respete el léxico, el cuerpo final usa
  // la forma canónica y la firma del perfil se conserva intacta.
  if (draft.trimEnd().endsWith(signature)) {
    const bodyPart = draft.trimEnd().slice(0, -signature.length).replace(/\s+$/, '');
    const canonicalBody = canonicalText(bodyPart, { data: sourceData });
    if (canonicalBody !== bodyPart) {
      draft = `${canonicalBody}\n\n${signature}`.trim();
      scored = scoreText(profile, draft);
      lingoBodyApplied = true;
    }
  }

  // Registro anti-repetición (apertura + cierre + acuse si aplica).
  const variationEntries = [
    { type: 'apertura', text: deterministic.opening },
    { type: 'cierre', text: deterministic.closing }
  ];
  if (/\b(acuse|acuso|recibido|confirmo recepci[oó]n|confirmo recibo)\b/i.test(intent)) {
    variationEntries.push({ type: 'acuse', text: deterministic.opening });
  }
  let variation = { contact, windowDays: 7, recorded: [] };
  try {
    variation = await recordComposeVariations({ contact: recipient, register: requestedRegister || register, entries: variationEntries, now });
  } catch {
    /* si el store está en solo lectura, el borrador sigue siendo válido */
  }

  const why = [...scored.why];
  if (openingChoice.replaced) why.push('apertura repetida sustituida por otra variante');
  if (openingChoice.exhausted) why.push('apertura sintetizada para no repetir fórmula');
  if (closingChoice.replaced) why.push('cierre repetido sustituido por otra variante');
  if (closingChoice.exhausted) why.push('cierre sintetizado para no repetir fórmula');
  const lingoApplied = canonicalIntent !== originalIntent
    || JSON.stringify(facts) !== JSON.stringify(input.facts || null)
    || JSON.stringify(recipient) !== JSON.stringify(input.recipient || null)
    || lingoBodyApplied;

  return {
    draft,
    score: scored.score,
    why,
    components: scored.components,
    register: requestedRegister || register,
    profileSource: source,
    samplesUsed: Math.min(3, samples.length),
    engine,
    recipient: {
      key: contact,
      name: recipient && typeof recipient === 'object' ? recipient.name || null : null,
      email: recipient && typeof recipient === 'object' ? recipient.email || (Array.isArray(recipient.emails) ? recipient.emails[0] : null) : (/@/.test(String(recipient || '')) ? String(recipient) : null)
    },
    ...(lingoApplied ? { lingo: { applied: true } } : {}),
    variation: {
      contact,
      register,
      windowDays: 7,
      opening: deterministic.opening,
      closing: deterministic.closing,
      openingReplaced: openingChoice.replaced === true,
      openingSynthesized: openingChoice.synthesized === true,
      closingReplaced: closingChoice.replaced === true,
      closingSynthesized: closingChoice.synthesized === true,
      recorded: (variation.recorded || []).map((entry) => ({ type: entry.type, text: entry.text, at: entry.at }))
    }
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
