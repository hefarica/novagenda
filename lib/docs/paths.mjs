/**
 * Rutas de almacenamiento de documentos y plantillas.
 *
 * Los archivos viven en `DATA_DIR/docs` (nunca dentro de `public/` ni del
 * repositorio). `DATA_DIR` se toma del store para respetar exactamente el mismo
 * directorio de datos que el resto de la aplicación.
 */
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.mjs';

/** Directorio de datos activo. */
export function dataDir() {
  const status = store.status();
  if (status && status.dataDir) return path.resolve(status.dataDir);
  return path.resolve(process.env.DATA_DIR || './data');
}

/** Directorio de documentos generados. */
export function docsDir() {
  return path.join(dataDir(), 'docs');
}

export function docsIndexFile() {
  return path.join(docsDir(), 'index.json');
}

export function templatesFile() {
  return path.join(docsDir(), 'templates.json');
}

/** Crea el directorio (idempotente). */
export function ensureDocsDir() {
  const dir = docsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Comprueba que un nombre de archivo resuelto está dentro del directorio.
 * @param {string} dir
 * @param {string} filename
 */
export function resolveInside(dir, filename) {
  const base = path.resolve(dir);
  const resolved = path.resolve(base, filename);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Ruta fuera del directorio permitido: ${filename}`);
  }
  return resolved;
}

/**
 * Escritura atómica: archivo temporal en el mismo directorio + rename.
 * @param {string} target
 * @param {Buffer|string} contents
 */
export function writeFileAtomic(target, contents) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  let handle;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, buffer);
    try { fs.fsyncSync(handle); } catch { /* algunos sistemas de archivos no lo soportan */ }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
    throw error;
  }
}

export default { dataDir, docsDir, docsIndexFile, templatesFile, ensureDocsDir, resolveInside, writeFileAtomic };
