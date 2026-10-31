/**
 * Clasificación de herramientas MCP por efecto y política de allowlist.
 *
 * Una herramienta se considera **con efectos** si declara
 * `annotations.readOnlyHint === false` o `annotations.destructiveHint === true`,
 * si su nombre/descripción contiene verbos de escritura/ejecución, o si no hay
 * información suficiente (default seguro). Las herramientas claramente de
 * lectura (`echo`, `read`, `list`, `search`…) se ejecutan directas.
 */

const EFFECT_RE = /\b(write|writefile|create|delete|remove|rm|unlink|exec|execute|run|shell|command|cmd|powershell|bash|sh|edit|modify|move|rename|copy|mkdir|mkfile|upload|download|send|post|put|patch|install|uninstall|spawn|kill|stop|start|restart|navigate|click|type|fill|press|drag|drop|screenshot|save|append|truncate|chmod|chown|git|deploy|publish|commit|push|apply|patch_file|replace|insert|update)\b/i;
const READ_RE = /\b(read|readfile|get|list|search|find|query|echo|add|sum|count|status|ping|info|describe|help|inspect|lookup|fetch|preview|diff|stat|head|tail|grep|glob|tree|show|view|open)\b/i;

/**
 * @param {any} tool descriptor MCP
 * @returns {{effect:boolean, readOnly:boolean, reason:string, source:'annotation'|'name'|'default'}}
 */
export function classifyTool(tool) {
  const annotations = tool && typeof tool === 'object' && tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const name = String(tool?.name || '');
  const description = String(tool?.description || '');
  const text = `${name} ${description}`.replace(/[_-]+/g, ' ');

  if (annotations.destructiveHint === true) {
    return { effect: true, readOnly: false, reason: 'La herramienta declara destructiveHint=true.', source: 'annotation' };
  }
  if (annotations.readOnlyHint === false) {
    return { effect: true, readOnly: false, reason: 'La herramienta declara readOnlyHint=false.', source: 'annotation' };
  }
  // Un nombre con verbo de efecto manda incluso si el servidor se declara read-only:
  // ante la duda, la seguridad gana.
  if (EFFECT_RE.test(text)) {
    return { effect: true, readOnly: false, reason: 'El nombre/descripción indica escritura o ejecución.', source: 'name' };
  }
  if (annotations.readOnlyHint === true) {
    return { effect: false, readOnly: true, reason: 'La herramienta declara readOnlyHint=true.', source: 'annotation' };
  }
  if (READ_RE.test(text)) {
    return { effect: false, readOnly: true, reason: 'El nombre/descripción indica consulta de solo lectura.', source: 'name' };
  }
  return { effect: true, readOnly: false, reason: 'Sin información de solo lectura: se trata como efecto por seguridad.', source: 'default' };
}

/**
 * Allowlist:
 *   - `['*']` permite todo.
 *   - Lista con nombres permite solo esos.
 *   - Lista vacía = sin restricción explícita. Las herramientas con efectos
 *     siguen pasando por el gate de Oficina; nunca se ejecutan directas.
 * @param {string[]} allowlist
 * @param {string} toolName
 * @param {{effect:boolean}} classification
 */
export function isToolAllowed(allowlist, toolName, classification) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (list.length === 0) return true;
  if (list.includes('*')) return true;
  if (list.includes(toolName)) return true;
  return false;
}

/**
 * Proyección pública de una herramienta (sin campos gigantes ni secretos).
 * @param {any} tool
 */
export function publicTool(tool) {
  const classification = classifyTool(tool);
  return {
    name: String(tool?.name || ''),
    description: String(tool?.description || '').slice(0, 1000),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null,
    annotations: tool?.annotations && typeof tool.annotations === 'object' ? { ...tool.annotations } : null,
    effect: classification.effect,
    readOnly: classification.readOnly,
    reason: classification.reason
  };
}
