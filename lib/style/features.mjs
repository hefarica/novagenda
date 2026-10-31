/**
 * Extracción determinista de rasgos de estilo a partir de muestras reales.
 *
 * No usa LLM ni red: analiza saludo, despedida, firma, longitud de frase,
 * párrafos, formalidad, emojis, preguntas, matices y viñetas, y detecta
 * "frases delatoras de IA" (lista negra).
 *
 * Todo el módulo es puro (entra texto, salen números/estructuras) para poder
 * probarlo sin arrancar el servidor.
 */

/** Frases que delatan texto generado (comparación sin acentos ni mayúsculas). */
export const AI_BLACKLIST = Object.freeze([
  'en el mundo actual',
  'en la era digital',
  'es importante destacar',
  'es importante señalar',
  'cabe destacar',
  'cabe mencionar',
  'es fundamental',
  'no dudes en contactarme',
  'no dudes en escribirme',
  'no dudes en ponerte en contacto',
  'en resumen',
  'en conclusión',
  'en este sentido',
  'por otro lado',
  'en primer lugar',
  'en segundo lugar',
  'como modelo de lenguaje',
  'como asistente',
  'estoy aquí para ayudarte',
  'espero que te encuentres bien',
  'espero que se encuentre bien',
  'quedo atento a cualquier consulta',
  'sin más por el momento',
  'sin lugar a dudas',
  'en el vertiginoso mundo'
]);

const CLOSING_RE = /^(un abrazo( fuerte)?|abrazos?|saludos( cordiales)?|cordialmente|atentamente|un saludo|muchas gracias|gracias|bendiciones|besos|cuidate|nos vemos|nos hablamos|quedo pendiente|buen dia)[,.]?$/i;
const GREETING_STEMS = [
  'hola', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches',
  'estimado', 'estimada', 'apreciado', 'apreciada', 'querido', 'querida', 'saludos'
];
const HEDGES = Object.freeze([
  'quizá', 'quizas', 'tal vez', 'creo que', 'me parece', 'parece que', 'podría', 'podria',
  'podríamos', 'podriamos', 'a lo mejor', 'si te parece', 'si le parece', 'cuando puedas',
  'cuando pueda', 'sin problema', 'por favor', 'si acaso', 'probablemente'
]);

const TITLE_HONORIFICS = /\b(sr|sra|srta|dr|dra|ing|lic|prof|don|doña|dona)\.?\s+/gi;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Normaliza saltos de línea y espacios sin perder párrafos. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Minúsculas sin acentos, para comparar. */
export function fold(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Lista de líneas no vacías con su índice original. */
function linesOf(text) {
  return normalizeText(text).split('\n');
}

/** Divide en frases (sin incluir saludo/despedida/firma). */
export function splitSentences(text) {
  const clean = normalizeText(text)
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…])\s+/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 1);
}

function wordsOf(text) {
  return normalizeText(text).split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1));
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** ¿La línea parece un saludo? */
export function extractGreeting(text) {
  const lines = linesOf(text).filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0];
  if (first.length > 90) return null;
  const folded = fold(first).replace(/[¡!]/g, '').trim();
  const stem = GREETING_STEMS.find((candidate) => folded === candidate || folded.startsWith(`${candidate} `) || folded.startsWith(`${candidate},`) || folded.startsWith(`${candidate}:`));
  if (!stem) return null;
  const punctuationMatch = first.match(/([:,])\s*$/);
  const punctuation = punctuationMatch ? punctuationMatch[1] : '';
  const afterStem = first.slice(first.toLowerCase().indexOf(stem) + stem.length).replace(/[:,]\s*$/, '').trim();
  const hasName = /[A-ZÁÉÍÓÚÑ][\p{L}.'-]+/u.test(afterStem);
  const template = hasName
    ? `${capitalizeStem(stem)} {nombre}${punctuation}`
    : `${capitalizeStem(stem)}${punctuation}`;
  return { text: first, stem, punctuation, template, hasName };
}

function capitalizeStem(stem) {
  return stem.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

/** ¿La línea es una despedida? */
function isClosingLine(line) {
  return CLOSING_RE.test(fold(line).trim());
}

/** Extrae despedida (línea completa) y firma (líneas posteriores). */
export function extractClosingAndSignature(text) {
  const lines = linesOf(text);
  const trimmed = lines.map((line) => line.trim());
  let closingIndex = -1;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] && isClosingLine(trimmed[index])) {
      closingIndex = index;
      break;
    }
  }
  let closing = null;
  let signature = '';
  if (closingIndex >= 0) {
    closing = trimmed[closingIndex];
    const signatureLines = trimmed
      .slice(closingIndex + 1)
      .filter(Boolean)
      .slice(0, 4);
    signature = signatureLines.join('\n').trim();
  }
  if (!signature) {
    // Sin despedida: intenta detectar una firma al final (nombre corto, cargo, contacto).
    const tail = trimmed.filter(Boolean).slice(-3);
    const candidates = [];
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const line = tail[index];
      if (!line || line.length > 90) break;
      if (/[.!?…]$/.test(line) && line.split(/\s+/).length > 6) break;
      candidates.unshift(line);
      if (candidates.length >= 3) break;
    }
    if (candidates.length && /^[A-ZÁÉÍÓÚÑ][\p{L}.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}.'-]+){0,3}$/u.test(candidates[0])) {
      signature = candidates.join('\n');
      if (closingIndex >= 0) closing = trimmed[closingIndex];
    }
  }
  return { closing, signature: signature.slice(0, 400) };
}

/** Cuerpo sin saludo, despedida ni firma (para métricas). */
export function bodyOf(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  const trimmed = lines.map((line) => line.trim());
  const greeting = extractGreeting(normalized);
  const { closing, signature } = extractClosingAndSignature(normalized);
  let start = 0;
  let end = trimmed.length;
  if (greeting) {
    const firstIndex = trimmed.findIndex((line) => line === greeting.text);
    if (firstIndex >= 0) start = firstIndex + 1;
  }
  if (closing) {
    const lastClosingIndex = trimmed.lastIndexOf(closing);
    if (lastClosingIndex >= 0) end = lastClosingIndex;
  } else if (signature) {
    const signatureFirstLine = signature.split('\n')[0];
    const sigIndex = trimmed.lastIndexOf(signatureFirstLine);
    if (sigIndex >= 0) end = sigIndex;
  }
  const body = trimmed.slice(start, end).join('\n').trim();
  return body || normalized;
}

/** Párrafos del cuerpo (separados por línea en blanco). */
export function paragraphsOf(text) {
  const body = bodyOf(text);
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function bulletsOf(text) {
  const lines = normalizeText(text).split('\n');
  return lines.filter((line) => /^\s*(?:[-*•·]|\d+[.)])\s+\S/.test(line)).length;
}

function emojiCount(text) {
  try {
    return (String(text).match(/\p{Extended_Pictographic}/gu) || []).length;
  } catch {
    return 0;
  }
}

/** Formalidad dominante: 'usted' | 'tú' | 'mixto' | null. */
export function detectFormality(text) {
  const folded = fold(text);
  const ustedMatches = folded.match(/\b(usted|ustedes|le agradezco|le envio|le comento|le adjunto|quedo atento|su respuesta|su amable|les agradezco|les envio|por su atencion)\b/g) || [];
  const tuMatches = folded.match(/\b(tu|tus|te|ti|contigo|te agradezco|te envio|te comento|te adjunto|te dejo|te cuento|podemos|avísame|avisame|cuando puedas)\b/g) || [];
  const usted = ustedMatches.length;
  const tu = tuMatches.length;
  if (!usted && !tu) return null;
  if (usted > tu * 1.5) return 'usted';
  if (tu > usted * 1.5) return 'tú';
  if (usted > 0 && tu > 0) return 'mixto';
  return tu > 0 ? 'tú' : 'usted';
}

/** Frases de la lista negra presentes en el texto. */
export function blacklistHits(text) {
  const folded = fold(text);
  return AI_BLACKLIST.filter((phrase) => folded.includes(phrase));
}

/** Matices/palabras de cautela presentes. */
export function hedgeHits(text) {
  const folded = fold(text);
  return HEDGES.filter((hedge) => new RegExp(`(^|[^a-z])${escapeRegExp(hedge)}([^a-z]|$)`).test(folded));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Analiza una muestra y devuelve sus rasgos.
 * @param {string} text
 */
export function analyzeSample(text) {
  const normalized = normalizeText(text);
  const greeting = extractGreeting(normalized);
  const { closing, signature } = extractClosingAndSignature(normalized);
  const body = bodyOf(normalized);
  const sentences = splitSentences(body);
  const sentenceLengths = sentences.map((sentence) => wordsOf(sentence).length).filter((length) => length > 0);
  const paragraphs = paragraphsOf(normalized);
  const words = wordsOf(body);
  const bullets = bulletsOf(body);
  const emojis = emojiCount(normalized);
  const questions = (body.match(/[¿?]/g) || []).length > 0 ? (body.match(/\?/g) || []).length : 0;
  return {
    text: normalized,
    greeting,
    closing,
    signature,
    body,
    sentences: sentences.length,
    sentenceLengths,
    sentenceMean: round(mean(sentenceLengths), 2),
    sentenceStd: round(stdDev(sentenceLengths), 2),
    paragraphs: paragraphs.length,
    words: words.length,
    emojiRate: round(words.length ? (emojis / words.length) * 100 : 0, 2),
    questionRate: round(sentences.length ? questions / sentences.length : 0, 3),
    bulletRate: round(paragraphs.length ? bullets / paragraphs.length : 0, 3),
    bullets,
    formality: detectFormality(normalized),
    hedges: hedgeHits(normalized),
    blacklist: blacklistHits(normalized)
  };
}

/**
 * Agrega varios análisis en un perfil de voz.
 * @param {Array<object>} analyses
 * @param {{register?:string, updatedAt?:string}} [options]
 */
export function aggregateProfile(analyses, { register = null, updatedAt = new Date().toISOString() } = {}) {
  const valid = (Array.isArray(analyses) ? analyses : []).filter((row) => row && row.text);
  if (!valid.length) return null;

  const counter = (values) => {
    const map = new Map();
    for (const value of values.filter(Boolean)) map.set(value, (map.get(value) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const top = (values, fallback = null) => {
    const ordered = counter(values);
    return ordered.length ? ordered[0][0] : fallback;
  };
  const uniqueOrdered = (values) => [...new Set(values.filter(Boolean))];

  const greetingTemplates = uniqueOrdered(valid.map((row) => row.greeting?.template));
  const greeterStem = top(valid.map((row) => row.greeting?.stem), null);
  const greetingPunct = top(valid.map((row) => row.greeting?.punctuation), '');
  const closingTexts = uniqueOrdered(valid.map((row) => row.closing));
  const signatures = uniqueOrdered(valid.map((row) => row.signature));
  const formalityCounts = counter(valid.map((row) => row.formality));
  const formality = formalityCounts.length ? formalityCounts[0][0] : null;

  const sentenceMeans = valid.map((row) => row.sentenceMean).filter((value) => value > 0);
  const overallSentenceMean = round(mean(sentenceMeans), 2);
  const overallSentenceStd = round(sqrtPooled(valid, overallSentenceMean), 2);
  const paragraphMeans = valid.map((row) => row.paragraphs).filter((value) => value > 0);
  const wordMeans = valid.map((row) => row.words).filter((value) => value > 0);

  return {
    register,
    sampleCount: valid.length,
    updatedAt,
    source: 'register',
    greeting: top(valid.map((row) => row.greeting?.text), null),
    greetingTemplate: greetingTemplates[0] || null,
    greetingStem: greeterStem,
    greetingPunctuation: greetingPunct,
    greetingVariants: greetingTemplates.slice(0, 8),
    closing: closingTexts[0] || null,
    closingVariants: closingTexts.slice(0, 8),
    signature: signatures[0] || '',
    signatureVariants: signatures.slice(0, 5),
    sentenceMean: overallSentenceMean || 14,
    sentenceStd: overallSentenceStd || 4,
    paragraphs: Math.max(1, Math.round(mean(paragraphMeans) || 2)),
    meanWords: Math.max(10, Math.round(mean(wordMeans) || 50)),
    formality,
    emojiRate: round(mean(valid.map((row) => row.emojiRate)), 2),
    questionRate: round(mean(valid.map((row) => row.questionRate)), 3),
    bulletRate: round(mean(valid.map((row) => row.bulletRate)), 3),
    hedges: uniqueOrdered(valid.flatMap((row) => row.hedges)).slice(0, 12),
    blacklistHits: uniqueOrdered(valid.flatMap((row) => row.blacklist)).slice(0, 12)
  };
}

function sqrtPooled(valid, overallMean) {
  if (valid.length < 2) return valid[0]?.sentenceStd || 0;
  const variance = valid.reduce((acc, row) => {
    const local = Number(row.sentenceStd) ** 2 || 0;
    return acc + local + (row.sentenceMean - overallMean) ** 2;
  }, 0) / valid.length;
  return Math.sqrt(variance);
}

/** Perfil neutro de respaldo cuando no hay ninguna muestra. */
export function defaultProfile() {
  return {
    register: null,
    sampleCount: 0,
    updatedAt: null,
    source: 'default',
    greeting: 'Hola:',
    greetingTemplate: 'Hola {nombre}:',
    greetingStem: 'hola',
    greetingPunctuation: ':',
    greetingVariants: ['Hola {nombre}:', 'Hola {nombre},', 'Buen día {nombre}:'],
    closing: 'Saludos,',
    closingVariants: ['Saludos,', 'Un saludo,', 'Gracias,'],
    signature: 'Héctor',
    signatureVariants: ['Héctor'],
    sentenceMean: 14,
    sentenceStd: 4,
    paragraphs: 2,
    meanWords: 50,
    formality: 'tú',
    emojiRate: 0,
    questionRate: 0.1,
    bulletRate: 0,
    hedges: [],
    blacklistHits: [],
    isDefault: true
  };
}
