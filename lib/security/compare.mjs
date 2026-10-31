import crypto from 'node:crypto';

/**
 * Comparación de cadenas en tiempo constante.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Comparación señuelo para no filtrar la longitud por tiempo.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifica una firma HMAC-SHA256 con el formato que usan varios proveedores
 * (`sha256=<hex>`). Acepta también el hex desnudo.
 * @param {Buffer|string} rawBody
 * @param {string|undefined} header
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyHmacSha256(rawBody, header, secret) {
  if (!secret || typeof header !== 'string' || header.length === 0) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = header.trim().replace(/^sha256=/i, '').toLowerCase();
  return safeEqual(provided, expected);
}
