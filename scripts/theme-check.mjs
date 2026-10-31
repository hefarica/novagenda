#!/usr/bin/env node
/**
 * Verificación del tema claro con Chrome headless (t48).
 *
 * Requiere una app temporal y un Chrome con CDP:
 *   node start.mjs (PORT=3459, DATA_DIR temporal)
 *   chrome --headless=new --remote-debugging-port=9333
 *
 * Uso: node scripts/theme-check.mjs --base=http://127.0.0.1:3459 --cdp=http://127.0.0.1:9333
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:3459');
const CDP = arg('cdp', 'http://127.0.0.1:9333');
const CAPTURES = path.join(ROOT, 'docs', 'capturas');
const STORAGE_KEY = 'agenda-p95.theme.v1';
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
};

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.code} ${message.error.message}`));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  takeEvents() { const taken = this.events.slice(); this.events = []; return taken; }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate exception');
  return result.result.value;
}

function errorsFrom(events) {
  const errors = [];
  for (const event of events) {
    if (event.method === 'Runtime.exceptionThrown') {
      errors.push(`exception: ${event.params.exceptionDetails?.text || 'unknown'}`);
    } else if (event.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params.type)) {
      errors.push(`console.${event.params.type}: ${(event.params.args || []).map((item) => item.value ?? item.description ?? '').join(' ').slice(0, 200)}`);
    } else if (event.method === 'Log.entryAdded' && event.params.entry?.level === 'error') {
      errors.push(`log: ${event.params.entry.text.slice(0, 200)}`);
    }
  }
  return errors;
}

// 12 combinaciones de texto/fondo sólidos representativos del tema claro.
const CONTRAST_KEYS = [
  ['cuerpo', 'body'],
  ['titular', '#hello'],
  ['tarjeta', '.card p, .card li, .card dd'],
  ['muted', '.muted'],
  ['hint', '.hint'],
  ['menu-lateral', '#drawer [data-nav="home"]'],
  ['enlace', 'a[href]'],
  ['input', 'input[type="text"], input[type="search"], textarea'],
  ['drawer', '#drawer'],
  ['chip', '.chip:not(.active):not([aria-pressed="true"])'],
  ['boton-secundario', 'button.secondary'],
  ['badge', '.badge.P2']
];

const CONTRAST_SCRIPT = `(() => {
  const pairs = ${JSON.stringify(Object.fromEntries(CONTRAST_KEYS))};
  const parse = (value) => {
    const match = String(value || '').match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(',').map((item) => parseFloat(item.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, bg) => fg.a >= 1 ? fg : ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });
  const lum = (c) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (element) => {
    let node = element;
    const stack = [];
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) stack.push(color);
      node = node.parentElement;
    }
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const base = (body && body.a > 0) ? body : ((html && html.a > 0) ? html : { r: 255, g: 255, b: 255, a: 1 });
    let result = { ...base, a: 1 };
    for (let index = stack.length - 1; index >= 0; index -= 1) result = blend(stack[index], result);
    return result;
  };
  const rows = [];
  for (const [key, selector] of Object.entries(pairs)) {
    const element = document.querySelector(selector);
    if (!element) { rows.push({ key, found: false }); continue; }
    const style = getComputedStyle(element);
    const fg = parse(style.color);
    if (!fg) { rows.push({ key, found: false }); continue; }
    const bg = bgOf(element);
    rows.push({ key, found: true, ratio: Number(ratio(blend(fg, bg), bg).toFixed(2)), text: (element.textContent || '').trim().slice(0, 40) });
  }
  return rows;
})()`;

const PRIMARY_OBSERVATION = `(() => {
  const element = document.querySelector('button.primary, .primary');
  if (!element) return { found: false };
  const style = getComputedStyle(element);
  const parse = (value) => {
    const match = String(value || '').match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(',').map((item) => parseFloat(item.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = (c) => {
    const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2)); };
  const background = style.backgroundImage || '';
  const colors = [...background.matchAll(/rgb\\(([^)]+)\\)/g)].map((match) => parse('rgb(' + match[1] + ')')).filter(Boolean);
  const fg = parse(style.color) || { r: 255, g: 255, b: 255, a: 1 };
  if (!colors.length) {
    const bg = parse(style.backgroundColor);
    return { found: true, gradient: false, ratio: bg ? ratio(fg, bg) : null };
  }
  const ratios = colors.map((color) => ratio(fg, color));
  return { found: true, gradient: true, stops: colors.length, worst: Math.min(...ratios), best: Math.max(...ratios) };
})()`;

const VIEWS = ['home', 'agenda', 'routines', 'office', 'docs', 'style', 'assistant', 'integrations', 'system'];
const SHOT_VIEWS = ['home', 'agenda', 'office'];

async function setTheme(cdp, choice) {
  return evaluate(cdp, `(() => {
    const select = document.querySelector('[data-theme-select]');
    if (!select) return null;
    select.value = ${JSON.stringify(choice)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { choice: select.value, theme: document.documentElement.dataset.theme, stored: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) };
  })()`);
}

async function readTheme(cdp) {
  return evaluate(cdp, `({
    theme: document.documentElement.dataset.theme,
    choice: document.documentElement.dataset.themeChoice,
    select: (document.querySelector('[data-theme-select]') || {}).value || null,
    stored: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
    colorScheme: document.documentElement.style.colorScheme || null
  })`);
}

async function navigateView(cdp, view) {
  return evaluate(cdp, `(() => {
    const button = document.querySelector('[data-nav="${view}"]');
    if (!button) return { ok: false, error: 'sin botón ${view}' };
    button.click();
    return { ok: true };
  })()`);
}

async function main() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && !String(target.url).startsWith('chrome-extension://'));
  if (!page) throw new Error('No hay pestaña CDP disponible');
  const cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // Carga inicial en oscuro (el default es "Sistema"; con emulación dark resuelve oscuro).
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  cdp.takeEvents();
  const initial = await readTheme(cdp);
  record('Tema inicial oscuro (choice sistema por defecto)',
    initial.theme === 'dark' && ['system', 'dark'].includes(initial.select),
    JSON.stringify(initial));

  fs.mkdirSync(CAPTURES, { recursive: true });
  const darkHomeShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(CAPTURES, 'tema-oscuro-home.png'), Buffer.from(darkHomeShot.data, 'base64'));

  // Selector Claro
  const light = await setTheme(cdp, 'light');
  await sleep(300);
  record('Selector Claro aplica data-theme=light y persiste', light.theme === 'light' && light.stored === 'light', JSON.stringify(light));
  await cdp.send('Page.reload');
  await sleep(1200);
  const persisted = await readTheme(cdp);
  record('Tema claro persiste tras recargar', persisted.theme === 'light' && persisted.stored === 'light' && persisted.select === 'light', JSON.stringify(persisted));

  // 9 vistas en claro sin errores + contraste en 3 vistas para cubrir 12 combos
  const lightErrors = [];
  const measured = new Map();
  for (const view of VIEWS) {
    cdp.takeEvents();
    await navigateView(cdp, view);
    await sleep(400);
    const active = await evaluate(cdp, `document.querySelector('#view-${view}')?.classList.contains('active') === true && (document.querySelector('#view-${view}')?.innerText || '').trim().length > 30`);
    if (!active) lightErrors.push(`vista ${view} no activa o vacía`);
    lightErrors.push(...errorsFrom(cdp.takeEvents()));
    if (['home', 'agenda', 'office'].includes(view)) {
      const rows = await evaluate(cdp, CONTRAST_SCRIPT);
      for (const row of rows) {
        if (row.found && !measured.has(row.key)) measured.set(row.key, { ...row, view });
      }
    }
  }
  record('9 vistas en tema claro sin errores de consola', lightErrors.length === 0, lightErrors.slice(0, 3).join(' | ') || '0 errores');

  const contrastRows = [...measured.values()];
  const contrastFailures = contrastRows.filter((row) => !(row.ratio >= 4.5));
  record('Contraste AA (≥4.5) en 12 combinaciones del tema claro',
    contrastRows.length >= 12 && contrastFailures.length === 0,
    `medidos=${contrastRows.length} fallos=${contrastFailures.map((row) => `${row.key}:${row.ratio}`).join(',') || 'ninguno'} min=${Math.min(...contrastRows.map((row) => row.ratio))}`);
  const primary = await evaluate(cdp, PRIMARY_OBSERVATION);
  console.log(`INFO botón primario (degradado): ${JSON.stringify(primary)}`);

  // Capturas claras (home, agenda, office)
  for (const view of SHOT_VIEWS) {
    await navigateView(cdp, view);
    await sleep(350);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(CAPTURES, `tema-claro-${view}.png`), Buffer.from(shot.data, 'base64'));
  }

  // Vistas en oscuro + capturas
  await setTheme(cdp, 'dark');
  await sleep(300);
  const darkErrors = [];
  for (const view of VIEWS) {
    cdp.takeEvents();
    await navigateView(cdp, view);
    await sleep(350);
    const active = await evaluate(cdp, `document.querySelector('#view-${view}')?.classList.contains('active') === true && (document.querySelector('#view-${view}')?.innerText || '').trim().length > 30`);
    if (!active) darkErrors.push(`vista ${view} no activa o vacía`);
    darkErrors.push(...errorsFrom(cdp.takeEvents()));
  }
  record('9 vistas en tema oscuro sin errores de consola', darkErrors.length === 0, darkErrors.slice(0, 3).join(' | ') || '0 errores');
  for (const view of SHOT_VIEWS) {
    await navigateView(cdp, view);
    await sleep(350);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(CAPTURES, `tema-oscuro-${view}.png`), Buffer.from(shot.data, 'base64'));
  }

  // Oscuro idéntico al inicial (DOM de estilos)
  const darkSignature = `(() => {
    const pick = (selector) => { const el = document.querySelector(selector); if (!el) return null; const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderColor].join('|'); };
    return { theme: document.documentElement.dataset.theme, style: ['body', '#hello', '.card', '#drawer', 'button.primary', '.muted'].map(pick) };
  })()`;
  const darkAfter = await evaluate(cdp, darkSignature);
  await navigateView(cdp, 'home');
  await sleep(400);
  const darkHomeAgain = await evaluate(cdp, darkSignature);
  record('Oscuro idéntico al actual (DOM de estilos)', JSON.stringify(darkAfter) === JSON.stringify(darkHomeAgain), JSON.stringify(darkHomeAgain.style));
  const darkHomeShot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  console.log(`INFO captura oscura inicial vs final idéntica=${darkHomeShot.data === darkHomeShot2.data}`);

  // Sistema: emular prefers-color-scheme
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const sysDark = await setTheme(cdp, 'system');
  await sleep(250);
  const sysDarkRead = await readTheme(cdp);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const sysLight = await setTheme(cdp, 'system');
  await sleep(250);
  const sysLightRead = await readTheme(cdp);
  record('Sistema respeta prefers-color-scheme (oscuro/claro)',
    sysDarkRead.theme === 'dark' && sysLightRead.theme === 'light',
    `${JSON.stringify(sysDark)} → ${JSON.stringify(sysDarkRead)} | ${JSON.stringify(sysLight)} → ${JSON.stringify(sysLightRead)}`);

  // Restaurar oscuro para no dejar la sesión visual en claro.
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await setTheme(cdp, 'dark');
  await sleep(200);

  const failures = results.filter((row) => !row.ok);
  console.log(`\nTEMA CLARO: ${results.length - failures.length}/${results.length} PASS`);
  fs.writeFileSync(path.join(process.env.TEMP || '.', 'agenda-t48-theme-report.json'), JSON.stringify({ base: BASE, results, contrast: contrastRows, primary }, null, 2));
  cdp.close();
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error('ERROR theme-check:', error.message);
  process.exitCode = 1;
});

