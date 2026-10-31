/**
 * Puntuación determinista de un texto contra un perfil de voz (0..1) con
 * explicación (`why`) de lo que suma y lo que resta.
 *
 * Pesos (suman 1):
 *   firma .22 · saludo .14 · despedida .14 · longitud de frase .14 ·
 *   palabras .05 · párrafos .06 · formalidad .09 · emojis .05 ·
 *   preguntas .05 · viñetas .06
 *
 * Penalizaciones: frases delatoras de IA (-0.25 cada una, tope -0.6),
 * markdown (-0.05) y listas artificiales cuando el perfil no usa viñetas.
 */
import { analyzeSample, fold, normalizeText } from './features.mjs';

export const SCORE_WEIGHTS = Object.freeze({
  signature: 0.22,
  greeting: 0.14,
  closing: 0.14,
  sentence: 0.14,
  words: 0.05,
  paragraphs: 0.06,
  formality: 0.09,
  emoji: 0.05,
  question: 0.05,
  bullets: 0.06
});

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const round3 = (value) => Math.round(clamp01(value) * 1000) / 1000;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function foldSignature(text) {
  return fold(text).replace(/\s+/g, ' ').trim();
}

function near(value, target, tolerance) {
  const diff = Math.abs(Number(value) - Number(target));
  return clamp01(1 - diff / Math.max(0.001, tolerance));
}

function greetingComponent(analysis, profile) {
  if (!profile.greetingStem) return 0.5;
  if (!analysis.greeting) return 0;
  const sameStem = fold(analysis.greeting.stem) === fold(profile.greetingStem);
  if (!sameStem) return 0;
  const expectedPunctuation = profile.greetingPunctuation || '';
  return analysis.greeting.punctuation === expectedPunctuation ? 1 : 0.7;
}

function closingComponent(analysis, profile) {
  if (!profile.closing) return 0.5;
  if (!analysis.closing) return 0;
  const expected = fold(profile.closing).replace(/[.,]$/, '').trim();
  const actual = fold(analysis.closing).replace(/[.,]$/, '').trim();
  if (actual === expected) return 1;
  if (actual.includes(expected) || expected.includes(actual)) return 0.7;
  return 0.35;
}

function signatureComponent(rawText, profile) {
  if (!profile.signature) return 0.5;
  const expected = foldSignature(profile.signature);
  const actual = foldSignature(rawText);
  if (!expected) return 0.5;
  if (actual.endsWith(expected)) return 1;
  if (actual.includes(expected)) return 0.65;
  return 0;
}

function formalityComponent(detected, expected) {
  if (!expected) return 0.8;
  if (!detected) return 0.55;
  if (detected === expected) return 1;
  if (detected === 'mixto' || expected === 'mixto') return 0.55;
  return 0.1;
}

function rateComponent(actual, expected, base = 0.5) {
  if (!(expected > 0) && !(actual > 0)) return 1;
  return 1 - Math.min(1, Math.abs(actual - expected) / Math.max(base, expected + 0.5));
}

/**
 * Puntúa `text` contra `profile`.
 * @param {object} profile
 * @param {string} text
 * @returns {{score:number, why:string[], components:object, penalties:object}}
 */
export function scoreText(profile, text) {
  const safeProfile = profile && typeof profile === 'object' ? profile : {};
  const analysis = analyzeSample(String(text ?? ''));
  const why = [];
  const penalties = { blacklist: 0, markdown: 0, artificialList: 0 };

  const components = {
    signature: signatureComponent(text, safeProfile),
    greeting: greetingComponent(analysis, safeProfile),
    closing: closingComponent(analysis, safeProfile),
    sentence: analysis.sentenceMean > 0
      ? near(analysis.sentenceMean, safeProfile.sentenceMean || 14, Math.max(5, (safeProfile.sentenceMean || 14) * 0.5 + (safeProfile.sentenceStd || 4)))
      : 0,
    words: analysis.words > 0
      ? near(analysis.words, safeProfile.meanWords || 50, Math.max(25, safeProfile.meanWords || 50))
      : 0,
    paragraphs: near(analysis.paragraphs || 1, safeProfile.paragraphs || 2, Math.max(1, safeProfile.paragraphs || 2)),
    formality: formalityComponent(analysis.formality, safeProfile.formality),
    emoji: rateComponent(analysis.emojiRate, safeProfile.emojiRate || 0, 0.4),
    question: rateComponent(analysis.questionRate, safeProfile.questionRate || 0, 0.2),
    bullets: (safeProfile.bulletRate || 0) < 0.05 && analysis.bullets > 0
      ? 0
      : rateComponent(analysis.bulletRate, safeProfile.bulletRate || 0, 0.2)
  };

  let total = 0;
  for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) {
    total += weight * clamp01(components[key]);
  }

  // Frases delatoras de IA.
  const hits = analysis.blacklist;
  if (hits.length) {
    penalties.blacklist = Math.min(0.6, hits.length * 0.25);
    total -= penalties.blacklist;
    for (const phrase of hits) why.push(`frase delatora de IA: «${phrase}» (-0.25)`);
  }
  // Markdown artificial.
  if (/(\*\*|^#{1,4}\s|^\s*```)/m.test(String(text))) {
    penalties.markdown = 0.05;
    total -= penalties.markdown;
    why.push('formato markdown artificial (-0.05)');
  }
  // Listas artificiales cuando el perfil apenas usa viñetas.
  if (analysis.bullets >= 2 && (safeProfile.bulletRate || 0) < 0.05) {
    why.push('lista de viñetas que el perfil no usa (0 en viñetas)');
  }

  // Explicaciones positivas/negativas de los componentes principales.
  if (components.signature >= 1) why.push('firma idéntica a la muestra');
  else if (components.signature >= 0.6) why.push('firma parcialmente presente');
  else why.push('falta la firma habitual (-0.22)');

  if (components.greeting >= 1) why.push('saludo igual al perfil');
  else if (components.greeting >= 0.6) why.push('saludo con puntuación distinta');
  else why.push('saludo ausente o distinto (-0.14)');

  if (components.closing >= 1) why.push('despedida igual al perfil');
  else if (components.closing >= 0.6) why.push('despedida parecida');
  else why.push('despedida ausente o distinta (-0.14)');

  if (components.sentence >= 0.8) why.push(`longitud de frase similar (${analysis.sentenceMean} palabras de media)`);
  else why.push(`longitud de frase lejos del perfil (${analysis.sentenceMean} vs ${safeProfile.sentenceMean})`);

  if (components.formality >= 1) why.push(`formalidad ${analysis.formality || 'neutra'} como el perfil`);
  else if (components.formality <= 0.2) why.push(`formalidad ${analysis.formality || 'neutra'} distinta a ${safeProfile.formality || 'neutra'} (-0.09)`);

  if (components.emoji >= 0.8) why.push('uso de emojis como el perfil');
  if (components.question >= 0.8 && analysis.questionRate > 0) why.push('preguntas en la proporción del perfil');
  if (components.paragraphs >= 0.8) why.push(`párrafos: ${analysis.paragraphs}`);
  if (components.bullets >= 0.8 && (safeProfile.bulletRate || 0) > 0.1) why.push('viñetas en la proporción del perfil');

  return {
    score: round3(total),
    why: why.slice(0, 14),
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(clamp01(value) * 1000) / 1000])),
    penalties
  };
}

/** Reemplazos neutros para quitar frases delatoras sin romper el sentido. */
const NEUTRAL_REPLACEMENTS = Object.freeze([
  ['en el mundo actual', 'hoy'],
  ['en la era digital', 'hoy'],
  ['en el vertiginoso mundo', 'hoy'],
  ['es importante destacar', 'conviene señalar'],
  ['es importante señalar', 'conviene señalar'],
  ['cabe destacar', 'conviene señalar'],
  ['cabe mencionar', 'conviene señalar'],
  ['es fundamental', 'es clave'],
  ['no dudes en contactarme', 'escríbeme'],
  ['no dudes en escribirme', 'escríbeme'],
  ['no dudes en ponerte en contacto', 'escríbeme'],
  ['en resumen', 'en síntesis'],
  ['en conclusión', 'para cerrar'],
  ['en este sentido', 'sobre esto'],
  ['por otro lado', 'además'],
  ['en primer lugar', 'primero'],
  ['en segundo lugar', 'después'],
  ['como modelo de lenguaje', ''],
  ['como asistente', ''],
  ['estoy aquí para ayudarte', ''],
  ['espero que te encuentres bien', ''],
  ['espero que se encuentre bien', ''],
  ['quedo atento a cualquier consulta', 'quedo pendiente'],
  ['sin más por el momento', ''],
  ['sin lugar a dudas', 'sin duda']
]);

/**
 * Elimina/sustituye frases delatoras de IA de un texto.
 * @param {string} text
 */
export function scrubAiPhrases(text) {
  let out = String(text ?? '');
  for (const [phrase, replacement] of NEUTRAL_REPLACEMENTS) {
    const regex = new RegExp(escapeRegExp(phrase), 'gi');
    out = out.replace(regex, replacement);
  }
  return normalizeText(out)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}
