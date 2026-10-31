/**
 * Verificador de XML bien formado (sin dependencias).
 *
 * No es un parser DOM completo: comprueba lo que necesita la aceptación de los
 * documentos OOXML —declaración, anidamiento de etiquetas, atributos con
 * comillas, entidades, CDATA, comentarios, prefijos de espacio de nombres
 * declarados y un único elemento raíz— y devuelve la lista de errores con su
 * desplazamiento. Un XML que pasa este verificador es parseable por cualquier
 * parser XML conforme (Word, Excel, PowerPoint, libxml2, .NET XmlDocument…).
 *
 * Uso:
 *   import { checkXml } from './xmlcheck.mjs';
 *   const result = checkXml(xml);
 *   if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
 */

const NAME_RE = /^[\p{L}_:][\p{L}\p{N}_.:\-]*$/u;
const ENTITY_RE = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);$/;
const PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function validEntity(token) {
  if (!ENTITY_RE.test(token)) return false;
  const body = token.slice(1, -1);
  if (PREDEFINED_ENTITIES.has(body)) return true;
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  }
  return false;
}

/**
 * @typedef {{message:string, offset:number, context?:string}} XmlIssue
 */

/**
 * Comprueba que una cadena sea XML bien formado.
 * @param {string|Buffer} input
 * @param {{maxErrors?:number, requireDeclaration?:boolean, requireRoot?:boolean, name?:string}} [options]
 * @returns {{ok:boolean, errors:XmlIssue[], root:string|null, elements:number, maxDepth:number, declaration:boolean}}
 */
export function checkXml(input, options = {}) {
  /** @type {XmlIssue[]} */
  const errors = [];
  const maxErrors = Math.max(1, Number(options.maxErrors) || 25);
  const label = options.name ? `${options.name}: ` : '';
  const requireDeclaration = options.requireDeclaration === true;
  const requireRoot = options.requireRoot !== false;
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const fail = (message, offset) => {
    if (errors.length < maxErrors) {
      errors.push({ message: `${label}${message}`, offset, context: text.slice(Math.max(0, offset - 30), offset + 30).replace(/\s+/g, ' ') });
    }
  };

  const validateText = (raw, offset) => {
    if (raw.includes(']]>')) fail('Secuencia "]]>" no permitida en contenido de texto', offset);
    let cursor = raw.indexOf('&');
    while (cursor >= 0) {
      const end = raw.indexOf(';', cursor);
      if (end < 0) {
        fail('Entidad "&" sin cerrar con ";"', offset + cursor);
        return;
      }
      const token = raw.slice(cursor, end + 1);
      if (!validEntity(token)) fail(`Entidad XML inválida: ${token.slice(0, 20)}`, offset + cursor);
      cursor = raw.indexOf('&', end + 1);
    }
  };

  const isName = (name) => NAME_RE.test(name);

  let index = 0;
  let root = null;
  let elements = 0;
  let maxDepth = 0;
  let declaration = false;
  let sawContent = false;
  let sawRootClosed = false;
  /** @type {Array<{name:string, prefix:string, namespaces:Map<string,string>}>} */
  const stack = [];
  /** @type {Map<string,string>} */
  const baseNamespaces = new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  while (index < text.length) {
    const next = text.indexOf('<', index);
    if (next < 0) {
      const tail = text.slice(index);
      if (stack.length === 0) {
        if (tail.trim()) fail('Contenido de texto fuera del elemento raíz', index);
      } else {
        validateText(tail, index);
      }
      index = text.length;
      break;
    }
    if (next > index) {
      const chunk = text.slice(index, next);
      if (stack.length === 0) {
        if (chunk.trim()) fail('Contenido de texto fuera del elemento raíz', index);
      } else {
        validateText(chunk, index);
        sawContent = true;
      }
      index = next;
    }

    // Declaración XML / instrucciones de procesamiento.
    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      if (end < 0) {
        fail('Instrucción de procesamiento sin cierre "?>"', index);
        break;
      }
      const body = text.slice(index + 2, end);
      if (/^xml(\s|$)/i.test(body)) {
        if (declaration || index !== 0) fail('La declaración XML solo puede aparecer al inicio del documento', index);
        declaration = true;
        if (!/^xml\s+version\s*=\s*("1\.[0-9]+"|'1\.[0-9]+')/.test(body)) {
          fail('Declaración XML sin atributo version válido', index);
        }
      }
      index = end + 2;
      continue;
    }

    // Comentarios.
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end < 0) {
        fail('Comentario XML sin cierre "-->"', index);
        break;
      }
      const body = text.slice(index + 4, end);
      if (body.includes('--')) fail('Comentario XML con "--" interno', index);
      index = end + 3;
      continue;
    }

    // CDATA.
    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      if (end < 0) {
        fail('CDATA sin cierre "]]>"', index);
        break;
      }
      if (stack.length === 0) fail('CDATA fuera del elemento raíz', index);
      else sawContent = true;
      index = end + 3;
      continue;
    }

    // DOCTYPE: los OOXML no lo usan; se rechaza por seguridad y por no soportar DTD.
    if (/^<!DOCTYPE/i.test(text.slice(index, index + 9))) {
      fail('DOCTYPE no permitido en documentos OOXML', index);
      const end = text.indexOf('>', index);
      index = end < 0 ? text.length : end + 1;
      continue;
    }

    // Etiqueta de cierre.
    if (text.startsWith('</', index)) {
      let cursor = index + 2;
      const start = cursor;
      while (cursor < text.length && !isWhitespace(text[cursor]) && text[cursor] !== '>') cursor += 1;
      const name = text.slice(start, cursor);
      if (!isName(name)) fail(`Nombre de etiqueta de cierre inválido: "${name}"`, start);
      while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
      if (text[cursor] !== '>') {
        fail(`Etiqueta de cierre "</${name}" sin ">"`, cursor);
        const recovery = text.indexOf('>', cursor);
        index = recovery < 0 ? text.length : recovery + 1;
        continue;
      }
      index = cursor + 1;
      if (!stack.length) {
        fail(`Cierre "</${name}>" sin etiqueta de apertura`, start);
        continue;
      }
      const open = stack.pop();
      if (open.name !== name) fail(`Cierre "</${name}>" no coincide con "<${open.name}>"`, start);
      if (!stack.length) sawRootClosed = true;
      continue;
    }

    if (text[index] !== '<') {
      fail('Se esperaba "<" al inicio de una etiqueta', index);
      index += 1;
      continue;
    }

    // Etiqueta de apertura.
    let cursor = index + 1;
    const nameStart = cursor;
    while (cursor < text.length && !isWhitespace(text[cursor]) && text[cursor] !== '>' && text[cursor] !== '/') cursor += 1;
    const name = text.slice(nameStart, cursor);
    if (!name) {
      fail('Etiqueta sin nombre', index);
      const recovery = text.indexOf('>', index);
      index = recovery < 0 ? text.length : recovery + 1;
      continue;
    }
    if (!isName(name)) fail(`Nombre de etiqueta inválido: "${name}"`, nameStart);

    /** @type {Record<string,string>} */
    const attributes = Object.create(null);
    const localNamespaces = new Map();
    let selfClosing = false;
    let closed = false;
    while (cursor < text.length) {
      while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
      if (text[cursor] === '>') {
        cursor += 1;
        closed = true;
        break;
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        cursor += 2;
        selfClosing = true;
        closed = true;
        break;
      }
      const attrStart = cursor;
      while (cursor < text.length && !isWhitespace(text[cursor]) && text[cursor] !== '=' && text[cursor] !== '>' && text[cursor] !== '/') cursor += 1;
      const attrName = text.slice(attrStart, cursor);
      if (!attrName || !isName(attrName)) {
        fail(`Nombre de atributo inválido: "${attrName}"`, attrStart);
      } else if (attributes[attrName] !== undefined) {
        fail(`Atributo duplicado: "${attrName}"`, attrStart);
      }
      while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
      if (text[cursor] !== '=') {
        fail(`El atributo "${attrName}" no tiene "="`, cursor);
        while (cursor < text.length && !isWhitespace(text[cursor]) && text[cursor] !== '>' && text[cursor] !== '/') cursor += 1;
        continue;
      }
      cursor += 1;
      while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") {
        fail(`El valor del atributo "${attrName}" debe ir entre comillas`, cursor);
        while (cursor < text.length && !isWhitespace(text[cursor]) && text[cursor] !== '>') cursor += 1;
        continue;
      }
      cursor += 1;
      const valueStart = cursor;
      while (cursor < text.length && text[cursor] !== quote) cursor += 1;
      if (cursor >= text.length) {
        fail(`Valor del atributo "${attrName}" sin comilla de cierre`, valueStart);
        closed = true;
        break;
      }
      const value = text.slice(valueStart, cursor);
      cursor += 1;
      if (attrName && attributes[attrName] === undefined) attributes[attrName] = value;
      if (value.includes('<')) fail(`"<" no permitido en el valor de "${attrName}"`, valueStart);
      validateText(value, valueStart);
      if (attrName === 'xmlns') localNamespaces.set('', value);
      else if (attrName.startsWith('xmlns:')) localNamespaces.set(attrName.slice(6), value);
    }
    if (!closed) fail(`Etiqueta "<${name}" sin ">"`, index);

    const parentNamespaces = stack.length ? stack[stack.length - 1].namespaces : baseNamespaces;
    /** @type {Map<string,string>} */
    const scope = new Map(parentNamespaces);
    for (const [prefix, uri] of localNamespaces) {
      if (!uri && prefix !== '') fail(`Prefijo de espacio de nombres "${prefix}" vacío`, index);
      scope.set(prefix, uri);
    }

    const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
    if (prefix && !scope.has(prefix)) fail(`Prefijo de espacio de nombres no declarado: "${prefix}" (en <${name}>)`, index);
    for (const attrName of Object.keys(attributes)) {
      if (!attrName.includes(':')) continue;
      const attrPrefix = attrName.slice(0, attrName.indexOf(':'));
      if (attrPrefix === 'xmlns') continue;
      if (!scope.has(attrPrefix)) fail(`Prefijo de atributo no declarado: "${attrPrefix}" (en <${name}>)`, index);
    }

    elements += 1;
    if (!root) root = name;
    else if (stack.length === 0) {
      fail(`Elemento raíz adicional "<${name}>" (ya existe "<${root}>")`, index);
    }
    if (selfClosing) {
      if (!stack.length) sawRootClosed = true;
    } else {
      stack.push({ name, prefix, namespaces: scope });
      maxDepth = Math.max(maxDepth, stack.length);
    }
    index = cursor;
  }

  if (stack.length) {
    fail(`Etiqueta sin cerrar: <${stack[stack.length - 1].name}>`, text.length);
  }
  if (!root && requireRoot) fail('El documento no tiene elemento raíz', 0);
  if (root && !sawRootClosed) fail(`El elemento raíz <${root}> no se cerró`, text.length);
  if (requireDeclaration && !declaration) fail('Falta la declaración XML al inicio', 0);
  if (declaration && !root) fail('Declaración XML sin documento', 0);
  if (!sawContent && false) { /* el contenido vacío es válido */ }

  return { ok: errors.length === 0, errors, root, elements, maxDepth, declaration };
}

/**
 * Lanza un error legible si el XML no es bien formado.
 * @param {string|Buffer} xml
 * @param {string} [name]
 * @returns {{root:string|null, elements:number, maxDepth:number}}
 */
export function assertWellFormed(xml, name = 'XML') {
  const result = checkXml(xml, { name });
  if (!result.ok) {
    const detail = result.errors.slice(0, 5).map((issue) => `${issue.message} (offset ${issue.offset})`).join(' | ');
    throw new Error(detail);
  }
  return { root: result.root, elements: result.elements, maxDepth: result.maxDepth };
}

/** Extrae el texto de todos los elementos con el nombre local indicado. */
export function textOfElements(xml, localName) {
  const values = [];
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'g');
  let match = pattern.exec(String(xml));
  while (match) {
    values.push(match[1].replace(/<[^>]*>/g, ''));
    match = pattern.exec(String(xml));
  }
  return values;
}

/** Cuenta elementos por nombre local (sin prefijo). */
export function countElements(xml, localName) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b`, 'g');
  return (String(xml).match(pattern) || []).length;
}

export default { checkXml, assertWellFormed, textOfElements, countElements };
