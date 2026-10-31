/**
 * Punto de entrada de research web (t25).
 *
 * Uso:
 *   import { fetchSafe, extractFromFetch, createResearchReport } from './lib/research/index.mjs';
 */

export {
  RESEARCH_LIMITS, ResearchError, fetchSafe, assertUrlAllowed, isBlockedIp,
  isBlockedHostname, setResearchTransport, resetResearchTransport,
  setResearchDnsResolver, resetResearchDnsResolver
} from './fetchSafe.mjs';

export {
  MAX_TEXT_CHARS, extractContent, extractFromFetch, htmlToText, extractLinks,
  stripTags, decodeEntities
} from './extract.mjs';

export {
  REPORT_LIMITS, collectResearchSources, createResearchReport, fetchResearchSource,
  deterministicAnswer, validateCitations, normalizeRecipients, publicSource
} from './report.mjs';

export {
  ensureResearchState, researchState, saveSource, listSources, getSource, deleteSource,
  saveReport, getReport, listReports
} from './state.mjs';
