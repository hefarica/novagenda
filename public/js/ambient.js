/**
 * Fondo vivo de la app: un objeto 3D wireframe distinto por vista.
 *
 * Es Canvas 2D puro (sin librerías): geometría procedural, proyección en
 * perspectiva, ~30 fps, DPR limitado y pausa cuando la pestaña está oculta.
 * Lee los colores de los tokens CSS para sincronizarse con el tema claro u
 * oscuro. Respeta prefers-reduced-motion.
 */

const PRESETS = {
  home: { shape: 'ico', tint: 'led', speed: 0.55, scale: 0.34, x: 0.72, y: 0.40, edges: 0.30, dots: 0.55, aura: 0.12 },
  agenda: { shape: 'rings', tint: 'blue', speed: 0.42, scale: 0.36, x: 0.78, y: 0.36, edges: 0.26, dots: 0.45, aura: 0.10 },
  routines: { shape: 'helix', tint: 'cyan', speed: 0.35, scale: 0.38, x: 0.24, y: 0.45, edges: 0.24, dots: 0.50, aura: 0.10 },
  tasks: { shape: 'cubes', tint: 'blue', speed: 0.30, scale: 0.34, x: 0.80, y: 0.60, edges: 0.22, dots: 0.38, aura: 0.08 },
  rooms: { shape: 'grid', tint: 'cyan', speed: 0.22, scale: 0.42, x: 0.50, y: 0.55, edges: 0.20, dots: 0.22, aura: 0.09 },
  attendance: { shape: 'wave', tint: 'violet', speed: 0.38, scale: 0.38, x: 0.75, y: 0.52, edges: 0.22, dots: 0.28, aura: 0.09 },
  okr: { shape: 'pyramid', tint: 'led', speed: 0.32, scale: 0.32, x: 0.28, y: 0.40, edges: 0.24, dots: 0.42, aura: 0.10 },
  office: { shape: 'network', tint: 'blue', speed: 0.26, scale: 0.36, x: 0.76, y: 0.38, edges: 0.18, dots: 0.48, aura: 0.10 },
  approvals: { shape: 'shield', tint: 'cyan', speed: 0.28, scale: 0.30, x: 0.80, y: 0.30, edges: 0.26, dots: 0.40, aura: 0.08 },
  moments: { shape: 'stars', tint: 'violet', speed: 0.18, scale: 0.40, x: 0.70, y: 0.35, edges: 0.08, dots: 0.52, aura: 0.08 },
  docs: { shape: 'pages', tint: 'blue', speed: 0.25, scale: 0.32, x: 0.26, y: 0.46, edges: 0.20, dots: 0.30, aura: 0.08 },
  wiki: { shape: 'lattice', tint: 'cyan', speed: 0.30, scale: 0.34, x: 0.76, y: 0.46, edges: 0.18, dots: 0.38, aura: 0.08 },
  base: { shape: 'grid', tint: 'blue', speed: 0.20, scale: 0.36, x: 0.70, y: 0.52, edges: 0.18, dots: 0.22, aura: 0.07 },
  lingo: { shape: 'glyphs', tint: 'violet', speed: 0.24, scale: 0.32, x: 0.26, y: 0.42, edges: 0.18, dots: 0.34, aura: 0.08 },
  identity: { shape: 'sphere', tint: 'led', speed: 0.28, scale: 0.30, x: 0.78, y: 0.40, edges: 0.20, dots: 0.36, aura: 0.08 },
  style: { shape: 'ribbon', tint: 'violet', speed: 0.36, scale: 0.36, x: 0.30, y: 0.50, edges: 0.22, dots: 0.30, aura: 0.09 },
  nudges: { shape: 'pulse', tint: 'cyan', speed: 0.40, scale: 0.34, x: 0.74, y: 0.42, edges: 0.22, dots: 0.32, aura: 0.10 },
  audit: { shape: 'scan', tint: 'blue', speed: 0.26, scale: 0.34, x: 0.74, y: 0.46, edges: 0.18, dots: 0.26, aura: 0.07 },
  assistant: { shape: 'sphere', tint: 'led', speed: 0.34, scale: 0.36, x: 0.74, y: 0.38, edges: 0.24, dots: 0.46, aura: 0.12 },
  workflows: { shape: 'flow', tint: 'cyan', speed: 0.24, scale: 0.38, x: 0.26, y: 0.44, edges: 0.18, dots: 0.42, aura: 0.08 },
  setup: { shape: 'orbit', tint: 'led', speed: 0.30, scale: 0.34, x: 0.78, y: 0.42, edges: 0.22, dots: 0.38, aura: 0.09 },
  integrations: { shape: 'network', tint: 'blue', speed: 0.22, scale: 0.36, x: 0.76, y: 0.40, edges: 0.18, dots: 0.48, aura: 0.09 },
  system: { shape: 'torus', tint: 'cyan', speed: 0.28, scale: 0.36, x: 0.76, y: 0.44, edges: 0.20, dots: 0.30, aura: 0.08 }
};

let canvas = null;
let context = null;
let frame = 0;
let last = 0;
let current = 'home';
let geometry = null;
let palette = null;
let reduced = false;
let running = false;
let width = 0;
let height = 0;
let dpr = 1;
let pointerX = 0;
let pointerY = 0;
let startedAt = 0;

function parseColor(value, fallback) {
  const raw = String(value || '').trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((part) => Number(part.trim()));
    return [r || 0, g || 0, b || 0];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (!hex) return fallback;
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readPalette() {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    dark,
    led: parseColor(styles.getPropertyValue('--led'), [55, 209, 255]),
    blue: parseColor(styles.getPropertyValue('--blue'), [59, 140, 255]),
    violet: parseColor(styles.getPropertyValue('--violet'), [155, 123, 255]),
    text: parseColor(styles.getPropertyValue('--text'), dark ? [238, 245, 255] : [21, 34, 56]),
    bg: parseColor(styles.getPropertyValue('--bg'), dark ? [6, 20, 38] : [255, 255, 255])
  };
}

function tintColor(tint, alpha) {
  const color = palette?.[tint] || palette?.led || [55, 209, 255];
  const boost = palette?.dark ? 1 : 0.72;
  return `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(0.95, alpha * boost))})`;
}

function mixColor(tint, alpha) {
  return tintColor(tint, alpha);
}

/* ------------------------------------------------------------------ */
/* Geometría procedural                                                */
/* ------------------------------------------------------------------ */
function makeIco() {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ];
  const points = raw.map(([x, y, z]) => {
    const length = Math.hypot(x, y, z) || 1;
    return { x: x / length, y: y / length, z: z / length };
  });
  const edges = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const distance = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y, points[i].z - points[j].z);
      if (distance < 1.16) edges.push([i, j]);
    }
  }
  return { points, edges };
}

function makeTorus() {
  const points = [];
  const edges = [];
  const rings = 7;
  const segments = 44;
  for (let r = 0; r < rings; r += 1) {
    const phi = (r / rings) * Math.PI * 2;
    for (let s = 0; s < segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      points.push({
        x: (1 + 0.32 * Math.cos(theta)) * Math.cos(phi),
        y: 0.32 * Math.sin(theta),
        z: (1 + 0.32 * Math.cos(theta)) * Math.sin(phi)
      });
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const i = r * segments + s;
      edges.push([i, r * segments + ((s + 1) % segments)]);
      edges.push([i, ((r + 1) % rings) * segments + s]);
    }
  }
  return { points, edges };
}

function makeHelix() {
  const points = [];
  const edges = [];
  const turns = 4;
  const n = 90;
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1)) * Math.PI * 2 * turns;
    points.push({ x: Math.cos(t) * 0.72, y: (i / (n - 1) - 0.5) * 1.8, z: Math.sin(t) * 0.72 });
    if (i) edges.push([i - 1, i]);
    if (i % 5 === 0) {
      const twin = i + n;
      points.push({ x: Math.cos(t + Math.PI) * 0.72, y: (i / (n - 1) - 0.5) * 1.8, z: Math.sin(t + Math.PI) * 0.72 });
      edges.push([i, twin]);
      if (i > 5) edges.push([twin - n - 1, twin]);
    }
  }
  return { points, edges };
}

function makeCubes() {
  const points = [];
  const edges = [];
  const positions = [[-1, 0, 0], [0.35, 0.75, -0.6], [1.1, -0.5, 0.4], [-0.2, -0.8, 0.8]];
  const base = [[-0.4, -0.4, -0.4], [0.4, -0.4, -0.4], [0.4, 0.4, -0.4], [-0.4, 0.4, -0.4], [-0.4, -0.4, 0.4], [0.4, -0.4, 0.4], [0.4, 0.4, 0.4], [-0.4, 0.4, 0.4]];
  const links = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [ox, oy, oz] of positions) {
    const offset = points.length;
    for (const [x, y, z] of base) points.push({ x: x + ox, y: y + oy, z: z + oz });
    for (const [a, b] of links) edges.push([offset + a, offset + b]);
  }
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i + 1]) edges.push([i * 8, (i + 1) * 8 + 6]);
  }
  return { points, edges };
}

function makeGrid() {
  const points = [];
  const edges = [];
  const size = 5;
  const spacing = 0.42;
  for (let i = 0; i <= size; i += 1) {
    const coord = (i - size / 2) * spacing;
    points.push({ x: coord, y: -0.55, z: -1.2 }, { x: coord, y: -0.55, z: 1.2 });
    edges.push([points.length - 2, points.length - 1]);
    points.push({ x: -1.2, y: -0.55, z: coord }, { x: 1.2, y: -0.55, z: coord });
    edges.push([points.length - 2, points.length - 1]);
  }
  return { points, edges };
}

function makePyramid() {
  const points = [
    { x: 0, y: -0.8, z: 0 },
    { x: -0.9, y: 0.65, z: -0.9 }, { x: 0.9, y: 0.65, z: -0.9 },
    { x: 0.9, y: 0.65, z: 0.9 }, { x: -0.9, y: 0.65, z: 0.9 }
  ];
  const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1], [1, 3], [2, 4]];
  return { points, edges };
}

function makeNetwork() {
  const points = [];
  const edges = [];
  let seed = 17;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < 16; i += 1) {
    points.push({ x: random() * 2 - 1, y: random() * 1.6 - 0.8, z: random() * 1.4 - 0.7 });
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y, points[i].z - points[j].z) < 0.72) edges.push([i, j]);
    }
  }
  return { points, edges };
}

function makeShield() {
  const points = [
    { x: 0, y: -1, z: 0 }, { x: -0.8, y: -0.2, z: 0 }, { x: -0.6, y: 0.7, z: 0 }, { x: 0, y: 1, z: 0 },
    { x: 0.6, y: 0.7, z: 0 }, { x: 0.8, y: -0.2, z: 0 }, { x: 0, y: 0, z: 0.3 }
  ];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [3, 6], [1, 6], [5, 6]];
  return { points, edges };
}

function makeStars() {
  const points = [];
  const edges = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 110; i += 1) points.push({ x: random() * 3 - 1.5, y: random() * 2.4 - 1.2, z: random() * 2 - 1 });
  return { points, edges };
}

function makePages() {
  const points = [];
  const edges = [];
  for (let layer = 0; layer < 4; layer += 1) {
    const z = layer * 0.18 - 0.27;
    const y = layer * 0.12 - 0.18;
    const offset = points.length;
    points.push({ x: -0.62, y: -0.3 + y, z }, { x: 0.62, y: -0.3 + y, z }, { x: 0.62, y: 0.3 + y, z }, { x: -0.62, y: 0.3 + y, z });
    edges.push([offset, offset + 1], [offset + 1, offset + 2], [offset + 2, offset + 3], [offset + 3, offset]);
  }
  return { points, edges };
}

function makeLattice() {
  const points = [];
  const edges = [];
  const n = 3;
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) points.push({ x: x * 0.55, y: y * 0.55, z: z * 0.55 });
    }
  }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y, points[i].z - points[j].z);
      if (Math.abs(d - 0.55) < 0.02) edges.push([i, j]);
    }
  }
  return { points: points.slice(0, n * n * n), edges };
}

function makeSphere() {
  const points = [];
  const edges = [];
  const rows = 9;
  const cols = 22;
  for (let r = 0; r < rows; r += 1) {
    const phi = (r / (rows - 1)) * Math.PI;
    for (let c = 0; c < cols; c += 1) {
      const theta = (c / cols) * Math.PI * 2;
      points.push({ x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) });
    }
  }
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      edges.push([i, r * cols + ((c + 1) % cols)]);
      if (r < rows - 1) edges.push([i, (r + 1) * cols + c]);
    }
  }
  return { points, edges };
}

function makeRibbon() {
  const points = [];
  const edges = [];
  const n = 72;
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * Math.PI * 2;
    const r = 0.55 + 0.22 * Math.cos(3 * t);
    points.push({ x: r * Math.cos(2 * t), y: 0.35 * Math.sin(3 * t), z: r * Math.sin(2 * t) });
    if (i) edges.push([i - 1, i]);
    if (i % 8 === 0) {
      points.push({ x: r * Math.cos(2 * t) * 0.88, y: 0.35 * Math.sin(3 * t) + 0.12, z: r * Math.sin(2 * t) * 0.88 });
      edges.push([i, points.length - 1]);
    }
  }
  return { points, edges };
}

function makeWave() {
  const points = [];
  const edges = [];
  const rows = 8;
  const cols = 18;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = (c / (cols - 1) - 0.5) * 2;
      const z = (r / (rows - 1) - 0.5) * 1.2;
      points.push({ x, y: Math.sin(x * 4 + z * 2) * 0.22, z });
      const i = r * cols + c;
      if (c) edges.push([i - 1, i]);
      if (r) edges.push([i - cols, i]);
    }
  }
  return { points, edges };
}

function makePulse() {
  const points = [];
  const edges = [];
  for (let ring = 0; ring < 4; ring += 1) {
    const radius = 0.45 + ring * 0.26;
    const count = 28 + ring * 8;
    for (let i = 0; i < count; i += 1) {
      const t = (i / count) * Math.PI * 2;
      points.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius * 0.58, z: 0 });
      if (i) edges.push([points.length - 2, points.length - 1]);
    }
  }
  return { points, edges };
}

function makeScan() {
  const points = [];
  const edges = [];
  for (let i = 0; i < 7; i += 1) {
    const y = (i / 6 - 0.5) * 1.4;
    points.push({ x: -1, y, z: -0.6 }, { x: 1, y, z: -0.6 });
    edges.push([points.length - 2, points.length - 1]);
  }
  for (let i = 0; i < 4; i += 1) {
    const z = (i / 3 - 0.5) * 0.8;
    points.push({ x: 0, y: -0.75, z }, { x: 0, y: 0.75, z });
    edges.push([points.length - 2, points.length - 1]);
  }
  return { points, edges };
}

function makeFlow() {
  const points = [];
  const edges = [];
  const nodes = [[-1, 0.2, 0], [-0.35, -0.5, 0.2], [0.2, 0.45, -0.2], [0.8, -0.1, 0.1]];
  for (const [x, y, z] of nodes) points.push({ x, y, z });
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (i !== 1 || j !== 3) edges.push([i, j]);
    }
  }
  return { points, edges };
}

function makeOrbit() {
  const points = [];
  const edges = [];
  for (let ring = 0; ring < 3; ring += 1) {
    const radius = 0.55 + ring * 0.25;
    const offset = points.length;
    for (let i = 0; i < 36; i += 1) {
      const t = (i / 36) * Math.PI * 2;
      points.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius * 0.4, z: Math.sin(t + ring) * 0.25 });
      if (i) edges.push([offset + i - 1, offset + i]);
    }
    edges.push([offset + 35, offset]);
  }
  return { points, edges };
}

const BUILDERS = {
  ico: makeIco, torus: makeTorus, rings: makeOrbit, helix: makeHelix, cubes: makeCubes,
  grid: makeGrid, pyramid: makePyramid, network: makeNetwork, shield: makeShield,
  stars: makeStars, pages: makePages, lattice: makeLattice, sphere: makeSphere,
  ribbon: makeRibbon, wave: makeWave, pulse: makePulse, scan: makeScan, flow: makeFlow,
  orbit: makeOrbit, glyphs: makePages
};

function buildGeometry(shape) {
  try {
    return (BUILDERS[shape] || makeIco)();
  } catch {
    return makeIco();
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */
function resize() {
  if (!canvas) return;
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context = canvas.getContext('2d');
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.id = 'ambientCanvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);
  resize();
}

function drawAura(time) {
  if (!context) return;
  const dark = palette?.dark;
  const alpha = dark ? 0.13 : 0.055;
  const base = palette?.blue || [59, 140, 255];
  const led = palette?.led || [55, 209, 255];
  const blobs = [
    { x: 0.18 + Math.sin(time * 0.00008) * 0.06, y: 0.24, r: 0.42, color: base, a: alpha },
    { x: 0.82 + Math.cos(time * 0.00007) * 0.05, y: 0.36, r: 0.38, color: led, a: alpha * 0.8 },
    { x: 0.55, y: 0.86 + Math.sin(time * 0.00006) * 0.03, r: 0.45, color: palette?.violet || [155, 123, 255], a: alpha * 0.55 }
  ];
  for (const blob of blobs) {
    const gradient = context.createRadialGradient(
      blob.x * width, blob.y * height, 0,
      blob.x * width, blob.y * height, Math.max(width, height) * blob.r
    );
    gradient.addColorStop(0, `rgba(${blob.color[0]},${blob.color[1]},${blob.color[2]},${blob.a})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }
}

function drawFlow(time) {
  if (!context || !palette) return;
  const dark = palette.dark;
  const index = Math.max(0, Object.keys(PRESETS).indexOf(current));
  const phase = time * 0.00018 * (1 + (index % 5) * 0.14) + index * 0.53;
  const frequency = 0.82 + (index % 6) * 0.09;
  const blue = palette.blue || [59, 140, 255];
  const led = palette.led || [55, 209, 255];
  context.save();
  context.globalCompositeOperation = dark ? 'lighter' : 'source-over';
  for (let band = 0; band < 4; band += 1) {
    const baseline = height * (0.55 + band * 0.075);
    const amplitude = height * (0.045 + band * 0.012);
    const gradient = context.createLinearGradient(0, baseline - amplitude, width, baseline + amplitude * 1.4);
    gradient.addColorStop(0, `rgba(${blue[0]},${blue[1]},${blue[2]},${dark ? 0.03 : 0.015})`);
    gradient.addColorStop(0.38, `rgba(${blue[0]},${blue[1]},${blue[2]},${dark ? 0.13 : 0.035})`);
    gradient.addColorStop(0.68, `rgba(${led[0]},${led[1]},${led[2]},${dark ? 0.15 : 0.04})`);
    gradient.addColorStop(1, `rgba(${blue[0]},${blue[1]},${blue[2]},${dark ? 0.01 : 0.005})`);
    const points = [];
    const step = Math.max(24, width / 34);
    for (let x = -step; x <= width + step; x += step) {
      const angle = (x / Math.max(1, width)) * Math.PI * 2 * frequency + phase + band * 0.72;
      const y = baseline
        + Math.sin(angle) * amplitude
        + Math.sin(angle * 1.9 + phase * 0.8) * amplitude * 0.36;
      points.push([x, y]);
    }
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(-step, height);
    context.lineTo(points[0]?.[0] || -step, points[0]?.[1] || baseline);
    for (const [x, y] of points) context.lineTo(x, y);
    context.lineTo(width + step, height);
    context.closePath();
    context.fill();
    context.strokeStyle = `rgba(${led[0]},${led[1]},${led[2]},${dark ? 0.18 : 0.055})`;
    context.lineWidth = dark ? 1.1 : 0.8;
    context.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      const [x, y] = points[i];
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
  context.restore();
}

function project(point, rotation, scale, centerX, centerY) {
  const cosY = Math.cos(rotation.y);
  const sinY = Math.sin(rotation.y);
  const cosX = Math.cos(rotation.x);
  const sinX = Math.sin(rotation.x);
  const x1 = point.x * cosY - point.z * sinY;
  const z1 = point.x * sinY + point.z * cosY;
  const y1 = point.y * cosX - z1 * sinX;
  const z2 = point.y * sinX + z1 * cosX;
  const distance = 3.4;
  const perspective = distance / (distance + z2 * 0.75);
  return {
    x: centerX + x1 * scale * perspective,
    y: centerY + y1 * scale * perspective,
    z: z2,
    perspective
  };
}

function render(time = 0) {
  if (!context) return;
  const preset = PRESETS[current] || PRESETS.home;
  if (!geometry || geometry.shape !== preset.shape) {
    geometry = { ...buildGeometry(preset.shape), shape: preset.shape };
  }
  context.clearRect(0, 0, width, height);
  drawAura(time);
  drawFlow(time);
  const mobile = width < 720;
  const centerX = width * (mobile ? 0.5 : preset.x) + pointerX * 18;
  const centerY = height * (mobile ? 0.38 : preset.y) + pointerY * 14;
  const scale = Math.min(width, height) * (mobile ? preset.scale * 0.78 : preset.scale);
  const rotation = reduced
    ? { x: 0.28, y: 0.5 }
    : { x: Math.sin(time * 0.00018) * 0.22 + 0.3, y: time * 0.00022 * (preset.speed || 0.3) };
  const projected = geometry.points.map((point) => project(point, rotation, scale, centerX, centerY));
  const dotAlpha = (palette?.dark ? 0.95 : 0.34) * (preset.dots || 0.4) * 1.45;
  const edgeAlpha = (palette?.dark ? 0.82 : 0.28) * (preset.edges || 0.24) * 1.8;
  context.save();
  context.globalCompositeOperation = palette?.dark ? 'lighter' : 'source-over';
  context.lineWidth = palette?.dark ? 1.35 : 1;
  for (const [a, b] of geometry.edges) {
    const p1 = projected[a];
    const p2 = projected[b];
    if (!p1 || !p2) continue;
    const depth = Math.min(1, Math.max(0.15, (p1.perspective + p2.perspective) / 2));
    context.strokeStyle = tintColor(preset.tint, edgeAlpha * depth);
    context.beginPath();
    context.moveTo(p1.x, p1.y);
    context.lineTo(p2.x, p2.y);
    context.stroke();
  }
  for (let index = 0; index < projected.length; index += 1) {
    const point = projected[index];
    const depth = Math.min(1, Math.max(0.2, point.perspective));
    const radius = (index % 7 === 0 ? 2.1 : 1.25) * depth;
    if (index % 5 === 0) {
      context.fillStyle = tintColor(preset.tint, dotAlpha * depth * 0.20);
      context.beginPath();
      context.arc(point.x, point.y, radius * 3.4, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = mixColor(preset.tint, dotAlpha * depth);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
  // Anillo orbital tenue, distinto por vista.
  if (!['stars', 'grid', 'scan'].includes(preset.shape)) {
    context.save();
    context.globalCompositeOperation = palette?.dark ? 'lighter' : 'source-over';
    context.strokeStyle = tintColor(preset.tint, palette?.dark ? 0.18 : 0.08);
    context.lineWidth = palette?.dark ? 1.2 : 1;
    context.beginPath();
    context.ellipse(centerX, centerY, scale * 1.45, scale * 0.52, rotation.y * 0.5, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

function loop(now) {
  if (!running) return;
  frame = requestAnimationFrame(loop);
  if (document.hidden) return;
  if (now - last < 32) return;
  last = now;
  render(now - startedAt);
}

function start() {
  if (running) return;
  running = true;
  startedAt = performance.now();
  last = 0;
  if (reduced) {
    render(0);
    running = false;
    return;
  }
  frame = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  cancelAnimationFrame(frame);
}

function applyPreset(name) {
  current = PRESETS[name] ? name : 'home';
  if (canvas) canvas.dataset.view = current;
  geometry = null;
  render(0);
}

export function initAmbient() {
  ensureCanvas();
  if (!canvas || !context) return;
  palette = readPalette();
  const active = document.querySelector('.view.active')?.id?.replace(/^view-/, '') || 'home';
  applyPreset(active);
  reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  start();
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); render(0); }, 120);
  }, { passive: true });
  window.addEventListener('pointermove', (event) => {
    pointerX = (event.clientX / Math.max(1, width) - 0.5) * 2;
    pointerY = (event.clientY / Math.max(1, height) - 0.5) * 2;
  }, { passive: true });
  document.addEventListener('agenda:view', (event) => {
    applyPreset(event.detail?.view || 'home');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  new MutationObserver(() => {
    palette = readPalette();
    render(0);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', (event) => {
    reduced = event.matches;
    if (reduced) { stop(); render(0); } else start();
  });
}

