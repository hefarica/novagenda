/**
 * Puente con el router LLM de t3 (`lib/llm/workflows.mjs`).
 *
 * Objetivo: que CADA workflow y CADA señal puedan enriquecerse con su perfil,
 * pero que la app funcione igual si el LLM está apagado, sin proveedor, con el
 * kill-switch activo o con el presupuesto agotado. En todos esos casos se usa el
 * texto determinista (los textos históricos del modelo).
 *
 * El import es perezoso: si el módulo LLM no estuviera disponible, el motor
 * sigue vivo y simplemente devuelve el fallback.
 */

let modulePromise = null;

async function loadWorkflowModule() {
  if (!modulePromise) {
    modulePromise = import('../llm/workflows.mjs').catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return emptyUsage();
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.completionTokens ?? usage.completion_tokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? (prompt + completion)) || 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/**
 * Ejecuta un perfil LLM y devuelve el texto enriquecido o el fallback.
 * @param {{profile:string, input?:object, legacyText:string, deadlineMs?:number,
 *          scope?:string, label?:string}} options
 */
export async function enrichText(options) {
  const profile = String(options.profile || 'signals');
  const legacyText = String(options.legacyText ?? '');
  const deadlineMs = Math.min(60_000, Math.max(2_000, Number(options.deadlineMs) || 25_000));

  try {
    const module = await loadWorkflowModule();
    if (typeof module.runWorkflow !== 'function') throw new Error('runWorkflow no disponible');
    const result = await module.runWorkflow(profile, {
      input: options.input || {},
      scope: options.scope || 'workflow',
      deadlineMs
    });
    const usage = normalizeUsage(result?.usage);
    if (result && result.fallback !== true && typeof result.text === 'string' && result.text.trim()) {
      return {
        text: result.text.trim(),
        used: true,
        fallback: false,
        provider: result.provider || null,
        model: result.model || null,
        cached: result.cached === true,
        latencyMs: result.latencyMs ?? null,
        usage,
        error: null,
        reason: null
      };
    }
    return {
      text: legacyText,
      used: false,
      fallback: true,
      provider: result?.provider || null,
      model: result?.model || null,
      cached: result?.cached === true,
      latencyMs: result?.latencyMs ?? null,
      usage,
      error: result?.error || null,
      reason: result?.errorCode || 'llm-fallback'
    };
  } catch (error) {
    return {
      text: legacyText,
      used: false,
      fallback: true,
      provider: null,
      model: null,
      cached: false,
      latencyMs: null,
      usage: emptyUsage(),
      error: error?.message || 'LLM no disponible',
      reason: 'llm-unavailable'
    };
  }
}

/**
 * Enriquecimiento de un workflow declarativo.
 * `workflow.llm.enabled === false` corta antes de llamar al LLM (on/off por workflow).
 * @param {{workflow:any, profile?:string, input?:object, legacyText:string, deadlineMs?:number}} options
 */
export async function enrichWorkflowText(options) {
  const workflow = options.workflow || {};
  const llm = workflow.llm && typeof workflow.llm === 'object' ? workflow.llm : {};
  if (llm.enabled === false) {
    return {
      text: options.legacyText,
      used: false,
      fallback: true,
      provider: null,
      model: null,
      cached: false,
      latencyMs: null,
      usage: emptyUsage(),
      error: null,
      reason: 'llm-disabled'
    };
  }
  return enrichText({
    profile: options.profile || llm.profile || 'signals',
    input: options.input || {},
    legacyText: options.legacyText,
    deadlineMs: options.deadlineMs || llm.deadlineMs,
    scope: `workflow:${workflow.id || 'signal'}`
  });
}
