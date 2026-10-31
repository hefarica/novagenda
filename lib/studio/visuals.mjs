/**
 * Presets visuales y arte abstracto local para el Estudio de presentaciones.
 *
 * Nada de APIs externas ni activos propietarios: cada portada se pinta píxel a
 * píxel con Node y se codifica como PNG propio (zlib + CRC32). El PPTX recibe
 * el PNG como `ppt/media/...` y el generador de `lib/docs/pptx.mjs` añade la
 * relación, el `p:pic` y el tipo de contenido correspondiente.
 *
 * Los presets no son etiquetas: cambian paleta, tipografías, composición de la
 * portada y de las secciones. `resolvePreset` tolera alias con/sin tilde y
 * devuelve `null` para valores desconocidos, de modo que un PPTX sin preset
 * conserva exactamente el diseño clásico anterior.
 */
import zlib from 'node:zlib';
import { crc32 } from '../docs/zip.mjs';

export const PRESET_IDS = Object.freeze(['ejecutivo', 'creativo', 'datos', 'academico']);

const RAW_PRESETS = {
  ejecutivo: {
    id: 'ejecutivo',
    label: 'Ejecutivo',
    description: 'Sobrio, institucional y orientado a decisión.',
    llmStyle: 'sobrio, directivo y orientado a decisión',
    fonts: { heading: 'Calibri Light', body: 'Calibri' },
    palette: {
      primary: '1F3864',
      accent: '2E74B5',
      secondary: '4472C4',
      surface: 'F4F7FB',
      ink: '132238',
      muted: '5B6B7E',
      coverInk: '132238',
      coverMuted: '4C5B6B',
      coverBackground: 'F4F7FB',
      deep: '0F2440'
    },
    cover: {
      variant: 'executive',
      align: 'left',
      eyebrow: 'INFORME EJECUTIVO',
      titleSize: 4200,
      titleY: 2250000,
      subtitleY: 3900000,
      titleWidth: 9000000,
      footerInk: '4C5B6B'
    },
    section: { variant: 'executive', eyebrow: 'SECCIÓN', align: 'left' },
    art: { style: 'waves', background: 'F4F7FB', colors: ['1F3864', '2E74B5', '9DC3E6'] }
  },
  creativo: {
    id: 'creativo',
    label: 'Creativo',
    description: 'Cálido, editorial y con energía visual.',
    llmStyle: 'creativo, cercano y con energía',
    fonts: { heading: 'Trebuchet MS', body: 'Calibri' },
    palette: {
      primary: 'C2410C',
      accent: '0F766E',
      secondary: 'EAB308',
      surface: 'FFF7ED',
      ink: '2B1D16',
      muted: '7C5C49',
      coverInk: '2B1D16',
      coverMuted: '6B4C3E',
      coverBackground: 'FFF4E6',
      deep: '3B1D0F'
    },
    cover: {
      variant: 'creative',
      align: 'left',
      eyebrow: 'IDEAS / PROPUESTA',
      titleSize: 4600,
      titleY: 2150000,
      subtitleY: 4050000,
      titleWidth: 9300000,
      footerInk: '6B4C3E'
    },
    section: { variant: 'creative', eyebrow: 'BLOQUE', align: 'left' },
    art: { style: 'blobs', background: 'FFF4E6', colors: ['D9480F', '0F766E', 'F2B705'] }
  },
  datos: {
    id: 'datos',
    label: 'Datos y KPIs',
    description: 'Analítico, con rejilla y acentos de medición.',
    llmStyle: 'analítico, basado en evidencia y con foco en KPIs',
    fonts: { heading: 'Consolas', body: 'Segoe UI' },
    palette: {
      primary: '0B3B4A',
      accent: 'E0A100',
      secondary: '1B7A8C',
      surface: 'F2F7F8',
      ink: '0B1F2A',
      muted: '4E6B73',
      coverInk: 'F7FBFC',
      coverMuted: 'A9C6CE',
      coverBackground: '08222C',
      deep: '061A22'
    },
    cover: {
      variant: 'data',
      align: 'left',
      eyebrow: 'PANEL DE DATOS',
      titleSize: 4000,
      titleY: 2220000,
      subtitleY: 3900000,
      titleWidth: 9500000,
      footerInk: 'A9C6CE'
    },
    section: { variant: 'data', eyebrow: 'SECCIÓN / DATOS', align: 'left' },
    art: { style: 'grid', background: '08222C', colors: ['1B7A8C', 'E0A100', '6FD3E0'] }
  },
  academico: {
    id: 'academico',
    label: 'Académico',
    description: 'Serif, riguroso y con jerarquía de ponencia.',
    llmStyle: 'académico, riguroso y con estructura argumental',
    fonts: { heading: 'Georgia', body: 'Cambria' },
    palette: {
      primary: '6B1D2A',
      accent: 'B08D3F',
      secondary: '3F2A2E',
      surface: 'FBF7EE',
      ink: '2A1A1C',
      muted: '6B5A50',
      coverInk: '3A141B',
      coverMuted: '6B5344',
      coverBackground: 'FAF4E4',
      deep: '3A141B'
    },
    cover: {
      variant: 'academic',
      align: 'center',
      eyebrow: 'PONENCIA ACADÉMICA',
      titleSize: 4000,
      titleY: 1980000,
      subtitleY: 3880000,
      titleWidth: 10500000,
      footerInk: '6B5344'
    },
    section: { variant: 'academic', eyebrow: 'CAPÍTULO', align: 'center' },
    art: { style: 'arcs', background: 'FAF4E4', colors: ['6B1D2A', 'B08D3F', 'D8C79B'] }
  }
};

const ALIASES = Object.freeze({
  ejecutivo: ['ejecutivo', 'executive', 'exec', 'sobrio', 'corporativo'],
  creativo: ['creativo', 'creative', 'creativa', 'ideas', 'editorial'],
  datos: ['datos', 'data', 'kpi', 'kpis', 'analitico', 'analitica', 'dashboard'],
  academico: ['academico', 'academic', 'academia', 'ponencia', 'universidad']
});

function ascii(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function normalizePresetName(value) {
  if (value === undefined || value === null) return null;
  const key = ascii(value).replace(/[\s_]+/g, '-');
  if (!key) return null;
  for (const [id, names] of Object.entries(ALIASES)) {
    if (names.includes(key) || key.startsWith(`${id}-`) || key.endsWith(`-${id}`)) return id;
  }
  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function listPresets() {
  return PRESET_IDS.map((id) => publicPreset(RAW_PRESETS[id]));
}

function publicPreset(preset) {
  return clone(preset);
}

/**
 * Resuelve un preset por id o alias. Devuelve `null` si no se reconoce.
 * @param {string} value
 */
export function resolvePreset(value) {
  const id = normalizePresetName(value);
  return id ? publicPreset(RAW_PRESETS[id]) : null;
}

export function presetBrand(value) {
  const preset = value && typeof value === 'object' ? value : resolvePreset(value);
  if (!preset) return null;
  return {
    font: preset.fonts.heading,
    color: preset.palette.primary,
    accent: preset.palette.accent
  };
}

/* ------------------------------------------------------------------ */
/* Codificación PNG (RGBA, sin dependencias)                           */
/* ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Codifica una imagen RGBA como PNG (color type 6, 8 bits).
 * @param {Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) {
    throw new Error('encodePng: búfer RGBA con dimensiones incorrectas.');
  }
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (stride + 1)] = 0; // filtro None
    rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profundidad
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function parseHex(hex) {
  const value = String(hex || '').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  return [
    Number.parseInt(normalized.slice(0, 2), 16) || 0,
    Number.parseInt(normalized.slice(2, 4), 16) || 0,
    Number.parseInt(normalized.slice(4, 6), 16) || 0
  ];
}

function mix(a, b, amount) {
  const t = Math.max(0, Math.min(1, Number(amount) || 0));
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

function setPixel(rgba, width, x, y, rgb, alpha = 1) {
  const a = Math.max(0, Math.min(1, alpha));
  if (a <= 0) return;
  const offset = (y * width + x) * 4;
  const inv = 1 - a;
  rgba[offset] = Math.round(rgb[0] * a + rgba[offset] * inv);
  rgba[offset + 1] = Math.round(rgb[1] * a + rgba[offset + 1] * inv);
  rgba[offset + 2] = Math.round(rgb[2] * a + rgba[offset + 2] * inv);
  rgba[offset + 3] = 255;
}

/* ------------------------------------------------------------------ */
/* Arte abstracto determinista                                         */
/* ------------------------------------------------------------------ */

function paintWaves(rgba, width, height, preset) {
  const bg = parseHex(preset.art.background);
  const colors = preset.art.colors.map(parseHex);
  const soft = parseHex(preset.palette.surface);
  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / Math.max(1, width - 1);
      const leftLight = mix(soft, bg, smoothstep(0.1, 0.62, u));
      const waveA = Math.sin((u * 2.1 + v * 1.35) * Math.PI * 2 + 0.4);
      const waveB = Math.sin((u * 3.4 - v * 1.1) * Math.PI * 2 + 1.7);
      const band = (waveA + waveB) * 0.5;
      let color = leftLight;
      if (u > 0.28) {
        const strength = smoothstep(0.28, 0.72, u) * smoothstep(-0.2, 0.85, band);
        color = mix(color, colors[0], strength * 0.22);
        if (band > 0.55) color = mix(color, colors[1], smoothstep(0.55, 0.95, band) * 0.45);
        if (band > 0.82 && u > 0.55) color = mix(color, colors[2], 0.55);
      }
      const halo = Math.exp(-((u - 0.82) ** 2 * 5 + (v - 0.3) ** 2 * 7));
      color = mix(color, colors[2], halo * 0.18);
      setPixel(rgba, width, x, y, color, 1);
    }
  }
}

function paintBlobs(rgba, width, height, preset) {
  const bg = parseHex(preset.art.background);
  const colors = preset.art.colors.map(parseHex);
  const blobs = [
    { x: 0.68, y: 0.26, r: 0.34, color: colors[0] },
    { x: 0.9, y: 0.62, r: 0.3, color: colors[1] },
    { x: 0.56, y: 0.82, r: 0.27, color: colors[2] },
    { x: 0.78, y: 0.08, r: 0.2, color: colors[1] }
  ];
  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / Math.max(1, width - 1);
      let best = { weight: 0, color: bg };
      for (const blob of blobs) {
        const dx = (u - blob.x) * 1.45;
        const dy = v - blob.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const weight = Math.max(0, 1 - distance / blob.r);
        if (weight > best.weight) best = { weight, color: blob.color };
      }
      const leftWash = smoothstep(0.18, 0.58, u);
      let color = mix(bg, best.color, best.weight * 0.78 * leftWash);
      const grain = (Math.sin((u * 41 + v * 17) * 12.9898) * 0.5 + 0.5) * 0.015;
      color = mix(color, colors[2], grain);
      setPixel(rgba, width, x, y, color, 1);
    }
  }
}

function paintGrid(rgba, width, height, preset) {
  const bg = parseHex(preset.art.background);
  const colors = preset.art.colors.map(parseHex);
  const deep = parseHex(preset.palette.deep);
  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / Math.max(1, width - 1);
      let color = mix(deep, bg, smoothstep(0, 0.9, u));
      const gridX = Math.abs(((u * 12) % 1) - 0.5);
      const gridY = Math.abs(((v * 7) % 1) - 0.5);
      const grid = Math.max(smoothstep(0.485, 0.5, gridX), smoothstep(0.485, 0.5, gridY));
      color = mix(color, colors[0], grid * 0.32);
      const curve = 0.88 - Math.sin(u * Math.PI * 1.4 + 0.9) * 0.055 - v;
      const curveStrength = smoothstep(0.012, 0, Math.abs(curve));
      color = mix(color, colors[1], curveStrength * 0.85);
      const dot = Math.exp(-(((u - 0.72) ** 2) * 900 + ((v - 0.28) ** 2) * 900));
      color = mix(color, colors[2], dot * 0.7);
      setPixel(rgba, width, x, y, color, 1);
    }
  }
}

function paintArcs(rgba, width, height, preset) {
  const bg = parseHex(preset.art.background);
  const colors = preset.art.colors.map(parseHex);
  const cx = 1.02;
  const cy = 1.12;
  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / Math.max(1, width - 1);
      const distance = Math.sqrt((u - cx) ** 2 + (v - cy) ** 2);
      let color = bg;
      for (const [index, radius] of [0.38, 0.52, 0.68, 0.86, 1.05].entries()) {
        const line = smoothstep(0.004, 0, Math.abs(distance - radius));
        color = mix(color, colors[index % colors.length], line * (0.62 - index * 0.07));
      }
      const ruleY = 0.14;
      const rule = smoothstep(0.002, 0, Math.abs(v - ruleY));
      color = mix(color, colors[1], rule * 0.75);
      const grain = (Math.sin((u * 23 + v * 31) * 78.233) * 0.5 + 0.5) * 0.012;
      color = mix(color, colors[2], grain);
      const leftWash = smoothstep(0.08, 0.42, u);
      color = mix(bg, color, 0.4 + leftWash * 0.6);
      setPixel(rgba, width, x, y, color, 1);
    }
  }
}

const ART_PAINTERS = Object.freeze({
  waves: paintWaves,
  blobs: paintBlobs,
  grid: paintGrid,
  arcs: paintArcs
});

const artCache = new Map();

/**
 * Genera el PNG abstracto de portada. Determinista, sin red y sin activos
 * externos. Cachea como máximo 8 combinaciones preset+tamaño.
 *
 * @param {string} presetId
 * @param {{width?:number, height?:number}} [options]
 * @returns {{buffer:Buffer, width:number, height:number, mimeType:string, filename:string}}
 */
export function buildCoverArt(presetId, options = {}) {
  const preset = resolvePreset(presetId);
  if (!preset) throw new Error(`Preset visual desconocido: ${presetId}`);
  const width = Math.max(320, Math.min(1920, Math.round(Number(options.width) || 1280)));
  const height = Math.max(180, Math.min(1080, Math.round(Number(options.height) || Math.round((width * 9) / 16))));
  const cacheKey = `${preset.id}:${width}x${height}`;
  if (artCache.has(cacheKey)) return { ...artCache.get(cacheKey) };
  const rgba = Buffer.alloc(width * height * 4);
  const background = parseHex(preset.art.background);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = background[0];
    rgba[index + 1] = background[1];
    rgba[index + 2] = background[2];
    rgba[index + 3] = 255;
  }
  const painter = ART_PAINTERS[preset.art.style] || paintWaves;
  painter(rgba, width, height, preset);
  const buffer = encodePng(rgba, width, height);
  const result = {
    buffer,
    width,
    height,
    mimeType: 'image/png',
    filename: `cover-${preset.id}.png`
  };
  if (artCache.size >= 8) artCache.delete(artCache.keys().next().value);
  artCache.set(cacheKey, result);
  return { ...result };
}

/**
 * Vista previa pequeña y coherente para el job del Estudio. No se usa para
 * descargar: el PPTX lleva el PNG a resolución completa.
 *
 * @param {string} presetId
 * @param {{title?:string, subtitle?:string, width?:number, height?:number}} [options]
 */
export function buildCoverPreview(presetId, options = {}) {
  const preset = resolvePreset(presetId);
  if (!preset) return null;
  const art = buildCoverArt(preset.id, {
    width: Math.max(320, Math.min(800, Math.round(Number(options.width) || 320))),
    height: Math.max(180, Math.min(450, Math.round(Number(options.height) || 180)))
  });
  return {
    kind: 'pptx-cover',
    preset: preset.id,
    label: preset.label,
    width: art.width,
    height: art.height,
    mimeType: art.mimeType,
    dataUrl: `data:${art.mimeType};base64,${art.buffer.toString('base64')}`,
    palette: { ...preset.palette },
    fonts: { ...preset.fonts },
    cover: { ...preset.cover },
    section: { ...preset.section },
    title: String(options.title ?? '').slice(0, 200),
    subtitle: String(options.subtitle ?? '').slice(0, 300)
  };
}

/** Resumen sin imagen para guardar en el artefacto del job. */
export function presetSummary(value) {
  const preset = resolvePreset(value);
  if (!preset) return null;
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    palette: { ...preset.palette },
    fonts: { ...preset.fonts },
    cover: { ...preset.cover },
    section: { ...preset.section },
    art: { style: preset.art.style, width: 1280, height: 720, mimeType: 'image/png' }
  };
}

export { RAW_PRESETS };
export default { PRESET_IDS, listPresets, resolvePreset, normalizePresetName, buildCoverArt, buildCoverPreview, presetBrand, presetSummary, encodePng };
