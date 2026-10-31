/**
 * Escritor y lector ZIP sin dependencias externas.
 *
 * Se usa para empaquetar los documentos OOXML (DOCX/XLSX/PPTX), que no son más
 * que archivos ZIP con una estructura concreta de partes XML.
 *
 * - Escritura: entradas almacenadas (método 0) o deflate (método 8) con
 *   `node:zlib`, CRC32 propio y cabeceras locales + directorio central + EOCD.
 * - Lectura: se usa en `selfcheck.mjs` y en las verificaciones para desempaquetar
 *   y comprobar que todas las partes XML son recuperables y su CRC coincide.
 * - Nombres UTF-8 (flag general purpose bit 11) y fechas DOS.
 *
 * Formato de referencia: PKWARE APPNOTE 6.3.4 (estructuras 4.3.7, 4.3.12, 4.3.16).
 */
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20; // 2.0: soporta deflate
const VERSION_MADE_BY = 0x0014; // MS-DOS, 2.0
const MAX_UINT32 = 0xffffffff;

/** Tabla CRC32 (polinomio IEEE 802.3, reflejado 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC32 de un Buffer (compatible con ZIP).
 * @param {Buffer|Uint8Array|string} input
 * @param {number} [seed]
 * @returns {number} entero sin signo de 32 bits
 */
export function crc32(input, seed = 0) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '', 'utf8');
  let value = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < buffer.length; index += 1) {
    value = (CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)) >>> 0;
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Normaliza el nombre de una entrada y rechaza rutas peligrosas.
 * @param {string} name
 * @returns {string}
 */
export function normalizeEntryName(name) {
  const raw = String(name ?? '').replace(/\\/g, '/').replace(/\u0000/g, '');
  if (!raw) throw new Error('El nombre de la entrada ZIP no puede estar vacío.');
  if (raw.startsWith('/')) throw new Error(`Nombre de entrada absoluto no permitido: ${raw}`);
  const clean = raw.replace(/\/{2,}/g, '/');
  if (clean.split('/').some((segment) => segment === '..')) {
    throw new Error(`Nombre de entrada con ".." no permitido: ${raw}`);
  }
  return clean;
}

/**
 * Convierte una fecha al formato MS-DOS (hora local, resolución 2 s).
 * @param {Date} [date]
 */
function dosDateTime(date = new Date()) {
  let value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (value.getFullYear() < 1980) value = new Date(1980, 0, 1, 0, 0, 0);
  if (value.getFullYear() > 2107) value = new Date(2107, 11, 31, 23, 59, 58);
  const time = ((value.getHours() & 0x1f) << 11) | ((value.getMinutes() & 0x3f) << 5) | ((value.getSeconds() >> 1) & 0x1f);
  const day = ((value.getFullYear() - 1980) << 9) | (((value.getMonth() + 1) & 0x0f) << 5) | (value.getDate() & 0x1f);
  return { time: time & 0xffff, date: day & 0xffff };
}

function deflateBuffer(buffer, level) {
  const safeLevel = Number.isInteger(level) && level >= 0 && level <= 9 ? level : 6;
  return zlib.deflateRawSync(buffer, { level: safeLevel });
}

export class ZipWriter {
  /**
   * @param {{comment?:string, level?:number, date?:Date}} [options]
   */
  constructor(options = {}) {
    /** @type {Array<any>} */
    this.entries = [];
    this.names = new Set();
    this.comment = String(options.comment ?? '');
    this.level = Number.isInteger(options.level) ? options.level : 6;
    this.date = options.date instanceof Date ? options.date : new Date();
  }

  /**
   * Añade una entrada. Los nombres repetidos son un error (un ZIP OOXML no
   * puede tener dos partes con la misma ruta).
   *
   * @param {string} name ruta posix relativa (ej. `word/document.xml`)
   * @param {Buffer|Uint8Array|string} data
   * @param {{compress?:boolean, level?:number, date?:Date}} [options]
   * @returns {this}
   */
  add(name, data, options = {}) {
    const entryName = normalizeEntryName(name);
    if (this.names.has(entryName)) throw new Error(`Entrada ZIP duplicada: ${entryName}`);
    this.names.add(entryName);

    const raw = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(String(data ?? ''), 'utf8');
    const isDirectory = entryName.endsWith('/');
    const compress = options.compress !== false && !isDirectory && raw.length > 0;
    let method = 0;
    let payload = raw;
    if (compress) {
      const deflated = deflateBuffer(raw, options.level ?? this.level);
      // Solo merece la pena deflate si reduce el tamaño (mismo criterio que los
      // empaquetadores habituales); si no, se almacena tal cual.
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    if (payload.length > MAX_UINT32 || raw.length > MAX_UINT32) {
      throw new Error(`Entrada ZIP demasiado grande: ${entryName}`);
    }
    const { time, date } = dosDateTime(options.date || this.date);
    this.entries.push({
      name: entryName,
      raw,
      payload,
      method,
      crc: crc32(raw),
      crcSeed: 0,
      size: raw.length,
      compressedSize: payload.length,
      time,
      date,
      flags: FLAG_UTF8,
      isDirectory
    });
    return this;
  }

  /**
   * Añade un texto UTF-8.
   * @param {string} name
   * @param {string} text
   * @param {{compress?:boolean, level?:number, date?:Date}} [options]
   */
  addText(name, text, options = {}) {
    return this.add(name, Buffer.from(String(text ?? ''), 'utf8'), options);
  }

  /** Añade una entrada XML con la declaración ya incluida. */
  addXml(name, xml, options = {}) {
    return this.addText(name, xml, options);
  }

  /**
   * Serializa el ZIP completo.
   * @returns {Buffer}
   */
  toBuffer() {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(VERSION_NEEDED, 4);
      local.writeUInt16LE(entry.flags, 6);
      local.writeUInt16LE(entry.method, 8);
      local.writeUInt16LE(entry.time, 10);
      local.writeUInt16LE(entry.date, 12);
      local.writeUInt32LE(entry.crc, 14);
      local.writeUInt32LE(entry.compressedSize, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      local.writeUInt16LE(0, 28); // extra field
      chunks.push(local, nameBuffer, entry.payload);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIG, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(entry.flags, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(nameBuffer.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk start
      header.writeUInt16LE(0, 36); // internal attrs
      header.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38); // external attrs
      header.writeUInt32LE(offset, 42);
      central.push(header, nameBuffer);

      offset += local.length + nameBuffer.length + entry.payload.length;
    }

    if (this.entries.length > 0xffff) throw new Error('Demasiadas entradas para un ZIP clásico (máx. 65535).');
    if (offset > MAX_UINT32) throw new Error('El ZIP supera 4 GB: usa otro empaquetador.');

    const centralBuffer = Buffer.concat(central);
    const commentBuffer = Buffer.from(this.comment, 'utf8');
    if (commentBuffer.length > 0xffff) throw new Error('Comentario ZIP demasiado largo.');

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // número de disco
    eocd.writeUInt16LE(0, 6); // disco del directorio central
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(commentBuffer.length, 20);

    return Buffer.concat([...chunks, centralBuffer, eocd, commentBuffer]);
  }
}

/**
 * Crea un ZIP a partir de un objeto `{ ruta: contenido }`, conservando el orden
 * de inserción (importante: `[Content_Types].xml` primero).
 * @param {Record<string, Buffer|Uint8Array|string>|Array<{name:string,data:any}>} entries
 * @param {{comment?:string, level?:number, date?:Date}} [options]
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  const writer = new ZipWriter(options);
  if (Array.isArray(entries)) {
    for (const entry of entries) writer.add(entry.name, entry.data, entry.options || {});
  } else {
    for (const [name, data] of Object.entries(entries || {})) writer.add(name, data);
  }
  return writer.toBuffer();
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIG) return index;
  }
  return -1;
}

/**
 * Lee un ZIP completo (entradas de datos + directorio central) y verifica CRC.
 *
 * @param {Buffer|Uint8Array} input
 * @param {{verifyCrc?:boolean, maxEntryBytes?:number, maxTotalBytes?:number}} [options]
 * @returns {{entries:Array<{name:string,data:Buffer,method:number,size:number,compressedSize:number,crc:number,isDirectory:boolean}>, comment:string, map:Record<string,Buffer>}}
 */
export function readZip(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const verifyCrc = options.verifyCrc !== false;
  const maxEntryBytes = Number(options.maxEntryBytes) || 64 * 1024 * 1024;
  const maxTotalBytes = Number(options.maxTotalBytes) || 256 * 1024 * 1024;
  if (buffer.length < 22) throw new Error('ZIP inválido: archivo demasiado corto.');
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('ZIP inválido: no se encontró el registro EOCD.');
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  const comment = commentLength ? buffer.toString('utf8', eocd + 22, eocd + 22 + commentLength) : '';
  if (centralOffset > buffer.length) throw new Error('ZIP inválido: directorio central fuera del archivo.');

  const entries = [];
  const map = Object.create(null);
  let pointer = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (pointer + 46 > buffer.length) throw new Error('ZIP inválido: directorio central truncado.');
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) throw new Error(`ZIP inválido: firma central incorrecta en la entrada ${index}.`);
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const entryCommentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + entryCommentLength;

    if (localOffset + 30 > buffer.length) throw new Error(`ZIP inválido: cabecera local fuera del archivo (${name}).`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`ZIP inválido: firma local incorrecta (${name}).`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP inválido: datos truncados (${name}).`);
    if (size > maxEntryBytes) throw new Error(`ZIP: entrada demasiado grande (${name}, ${size} bytes).`);
    totalUncompressed += size;
    if (totalUncompressed > maxTotalBytes) throw new Error('ZIP: tamaño descomprimido total excesivo.');

    const payload = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(payload);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(payload, { maxOutputLength: Math.max(1024, size + 1024) });
      } catch (error) {
        throw new Error(`ZIP: no se pudo inflar "${name}": ${error.message}`);
      }
    } else {
      throw new Error(`ZIP: método de compresión no soportado (${method}) en "${name}".`);
    }
    if (data.length !== size) throw new Error(`ZIP: tamaño inconsistente en "${name}" (${data.length} != ${size}).`);
    if (verifyCrc) {
      const actual = crc32(data);
      if (actual !== crc) {
        throw new Error(`ZIP: CRC32 incorrecto en "${name}" (${actual.toString(16)} != ${crc.toString(16)}).`);
      }
    }
    const isDirectory = name.endsWith('/');
    entries.push({ name, data, method, size, compressedSize, crc, isDirectory, flags });
    map[name] = data;
  }

  return { entries, comment, map };
}

/**
 * Devuelve una entrada de texto de un ZIP ya leído.
 * @param {ReturnType<typeof readZip>} archive
 * @param {string} name
 * @returns {string}
 */
export function entryText(archive, name) {
  const buffer = archive.map[name];
  if (!buffer) throw new Error(`Falta la entrada ZIP "${name}".`);
  return buffer.toString('utf8');
}

export default { ZipWriter, createZip, readZip, crc32, normalizeEntryName, entryText };
