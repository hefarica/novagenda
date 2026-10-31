/* Verificación real del tema claro/oscuro en Chrome headless vía CDP.
   Uso: node scripts/verify-theme.mjs [url]
   Requiere que la app responda en la URL (por defecto http://127.0.0.1:3000).
   No modifica datos: solo lee, alterna tema y hace capturas de estado. */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'espera' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timeout en ${label}${last ? `: ${last.message}` : ''}`);
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'agenda-theme-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return res.ok;
    }, { label: 'CDP /json/version' });

    let target;
    try {
      const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      target = await created.json();
    } catch {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Sin target CDP');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WS error')), { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];
    const failedRequests = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params?.exceptionDetails?.text || 'exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(msg.params.entry.text || 'log error');
      }
      if (msg.method === 'Network.loadingFailed') {
        failedRequests.push(msg.params?.errorText || 'failed');
      }
      if (msg.method === 'Network.responseReceived') {
        const s = msg.params?.response?.status || 0;
        if (s >= 400) failedRequests.push(`${s} ${msg.params.response.url}`);
      }
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 20000);
    });

    const evaluate = async (expression) => {
      const out = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture: true
      });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'eval error');
      return out.result?.value;
    };

    const waitLoad = async () => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 12000);
        const onMsg = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.method === 'Page.loadEventFired') {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await sleep(700);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');

    await send('Page.navigate', { url: URL_APP });
    await waitLoad();

    // A. Estructura y carga de recursos
    check('Carga el CSS del tema claro', await evaluate(
      `[...document.styleSheets].some(s => (s.href||'').includes('/theme-light.css'))`));
    check('Existen los dos selectores de tema', await evaluate(
      `document.querySelectorAll('[data-theme-select]').length === 2`));
    check('Script de arranque sin destello presente', await evaluate(
      `[...document.scripts].some(s => (s.src||'').includes('theme-boot.js'))`));
    check('Atributo data-theme aplicado', await evaluate(
      `['dark','light'].includes(document.documentElement.dataset.theme)`),
      await evaluate(`document.documentElement.dataset.theme`));

    // B. Tema claro
    await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
    await send('Page.reload');
    await waitLoad();
    const light = await evaluate(`(() => {
      const cs = getComputedStyle(document.body);
      const card = document.querySelector('.card.glass, .glass');
      return {
        theme: document.documentElement.dataset.theme,
        choice: document.documentElement.dataset.themeChoice,
        bodyBg: cs.backgroundColor + ' | ' + cs.backgroundImage.slice(0, 90),
        bodyColor: cs.color,
        cardBg: card ? (getComputedStyle(card).backgroundColor + ' | ' + getComputedStyle(card).backgroundImage.slice(0, 60)) : '',
        select: (document.querySelector('#themeSelectTop')||{}).value,
        meta: (document.querySelector('#metaThemeColor')||{}).content,
        bgToken: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      };
    })()`);
    check('Tema claro activo', light.theme === 'light' && light.choice === 'light', JSON.stringify(light));
    check('Fondo blanco perla plano', /rgb\((255,\s*255,\s*255|250,\s*249,\s*246)\)/i.test(light.bodyBg), light.bodyBg);
    check('Texto oscuro legible', /rgb\((6,\s*23,\s*46|11,\s*31,\s*58|24,\s*40,\s*43|21,\s*34,\s*56)\)/.test(light.bodyColor), light.bodyColor);
    check('Tarjeta blanca traslúcida', /rgba?\(255,\s*255,\s*255/.test(light.cardBg), light.cardBg);
    check('Selector sincronizado en claro', light.select === 'light');
    check('theme-color claro', light.meta === '#FFFFFF', light.meta);

    // C. Contraste WCAG del tema claro
    const contrast = await evaluate(`(() => {
      const parse = (c) => (c.match(/\\d+(\\.\\d+)?/g)||[]).slice(0,3).map(Number);
      const lum = ([r,g,b]) => { const f = (v) => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
        return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
      const ratio = (a,b) => { const l1=lum(parse(a)), l2=lum(parse(b)); const [hi,lo]=l1>l2?[l1,l2]:[l2,l1]; return +( (hi+0.05)/(lo+0.05) ).toFixed(2); };
      const fg = getComputedStyle(document.body).color;
      const rawBg = getComputedStyle(document.body).backgroundColor;
      const transparent = /rgba?\\(0,\\s*0,\\s*0,\\s*0\\)/.test(rawBg);
      const bg = transparent ? 'rgb(252,251,248)' : rawBg; // fondo perla efectivo bajo el degradado
      const mutedEl = document.querySelector('.muted') || document.body;
      const muted = getComputedStyle(mutedEl).color;
      return { body: ratio(fg,bg), muted: ratio(muted,bg) };
    })()`);
    check('Contraste cuerpo >= 4.5', contrast.body >= 4.5, `ratio ${contrast.body}`);
    check('Contraste secundario >= 4.5', contrast.muted >= 4.5, `ratio ${contrast.muted}`);

    // Componentes con relleno propio: botón primario y badge P1.
    const components = await evaluate(`(() => {
      const parse = (c) => (c.match(/\\d+(\\.\\d+)?/g)||[]).slice(0,3).map(Number);
      const lum = ([r,g,b]) => { const f = (v) => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
        return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
      const ratio = (a,b) => { const l1=lum(parse(a)), l2=lum(parse(b)); const [hi,lo]=l1>l2?[l1,l2]:[l2,l1]; return +( (hi+0.05)/(lo+0.05) ).toFixed(2); };
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:0';
      document.body.appendChild(host);
      host.innerHTML = '<button class="primary" type="button">Enviar</button><span class="badge P1">P1</span>';
      const btn = host.querySelector('.primary');
      const badge = host.querySelector('.badge.P1');
      const bcs = getComputedStyle(btn);
      const stops = (bcs.backgroundImage.match(/rgba?\\([^)]+\\)/g) || [])
        .map((c) => 'rgb(' + parse(c).join(',') + ')');
      const btnRatio = Math.min(...stops.map((s) => ratio(bcs.color, s)));
      const badgeRatio = ratio(getComputedStyle(badge).color, getComputedStyle(badge).backgroundColor);
      host.remove();
      return { btnRatio, badgeRatio, stops, color: bcs.color };
    })()`);
    check('Botón primario AA (>=4.5)', components.btnRatio >= 4.5, `min ${components.btnRatio} · ${(components.stops || []).join(' | ')}`);
    check('Badge P1 AA (>=4.5)', components.badgeRatio >= 4.5, `ratio ${components.badgeRatio}`);

    // D. Oscuro intacto
    await evaluate(`localStorage.setItem('agenda-p95.theme.v1','dark')`);
    await send('Page.reload');
    await waitLoad();
    const dark = await evaluate(`(() => {
      const cs = getComputedStyle(document.body);
      return {
        theme: document.documentElement.dataset.theme,
        bg: cs.backgroundImage.slice(0, 90),
        color: cs.color,
        bgToken: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        select: (document.querySelector('#themeSelectTop')||{}).value
      };
    })()`);
    check('Tema oscuro activo', dark.theme === 'dark', JSON.stringify(dark));
    check('Fondo oscuro plano actualizado', dark.bgToken === '#061426', dark.bgToken);
    check('Texto claro en oscuro', /rgb\(238,\s*245,\s*255\)/.test(dark.color), dark.color);
    check('Selector sincronizado en oscuro', dark.select === 'dark');

    // D2. Rejilla de tarjetas: bordes alineados y separación uniforme.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1335, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await send('Page.reload');
    await waitLoad();
    const cardGrid = await evaluate(`(() => {
      const round = (n) => Math.round(n * 10) / 10;
      const grids = [...document.querySelectorAll('#view-home > .grid')];
      const rows = grids.map((grid) => [...grid.children]
        .filter((el) => el.classList.contains('card'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
        }));
      const vgaps = grids.slice(1).map((grid, i) =>
        round(grid.getBoundingClientRect().top - grids[i].getBoundingClientRect().bottom));
      const hgaps = rows.filter((r) => r.length > 1)
        .map((r) => round(r[1].x - (r[0].x + r[0].w)));
      const widths = rows.flat().map((r) => r.w);
      const aligned = rows.every((r) => r.length === 2)
        && Math.max(...widths) - Math.min(...widths) < 0.6
        && rows.every((r) => r[0].x === rows[0][0].x && r[1].x === rows[0][1].x);
      const styles = [...document.querySelectorAll('#view-home .card')].map((el) => {
        const s = getComputedStyle(el);
        return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth,
          s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor,
          s.borderTopLeftRadius, s.padding].join('|');
      });
      return {
        vgaps, hgaps, aligned, widths,
        uniform: styles.length > 0 && styles.every((s) => s === styles[0]),
        sample: styles[0] || '',
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
      };
    })()`);
    check('Columnas de tarjetas alineadas entre filas', cardGrid.aligned,
      `anchos ${cardGrid.widths.join('/')} · separación ${cardGrid.hgaps.join('/')}`);
    check('Separación vertical y horizontal uniforme (16px)',
      [...cardGrid.vgaps, ...cardGrid.hgaps].length > 0
        && [...cardGrid.vgaps, ...cardGrid.hgaps].every((g) => Math.abs(g - 16) < 0.6),
      `vertical ${cardGrid.vgaps.join('/')} · horizontal ${cardGrid.hgaps.join('/')}`);
    check('Bordes, radios y relleno homogéneos', cardGrid.uniform, cardGrid.sample);
    check('Sin desbordamiento horizontal a 1335px', cardGrid.overflow);

    // D3. Apilado: conserva 16px dentro y entre bloques.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 960, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await send('Page.reload');
    await waitLoad();
    const stacked = await evaluate(`(() => {
      const round = (n) => Math.round(n * 10) / 10;
      const grids = [...document.querySelectorAll('#view-home > .grid')];
      const rows = grids.map((grid) => [...grid.children]
        .filter((el) => el.classList.contains('card'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: round(r.x), w: round(r.width), y: round(r.y), h: round(r.height) };
        }));
      const vgaps = grids.slice(1).map((grid, i) =>
        round(grid.getBoundingClientRect().top - grids[i].getBoundingClientRect().bottom));
      const inner = rows.filter((r) => r.length > 1)
        .map((r) => round(r[1].y - (r[0].y + r[0].h)));
      const oneColumn = rows.every((r) => r.length > 0)
        && rows.every((r) => r.every((c) => c.x === rows[0][0].x && c.w === rows[0][0].w));
      return {
        vgaps, inner, oneColumn,
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
      };
    })()`);
    check('Apilado a una columna sin perder el ancho', stacked.oneColumn);
    check('Apilado conserva 16px dentro y entre tarjetas',
      stacked.oneColumn
        && [...stacked.vgaps, ...stacked.inner].every((g) => Math.abs(g - 16) < 0.6),
      `vertical ${stacked.vgaps.join('/')} · interno ${stacked.inner.join('/')}`);
    check('Sin desbordamiento horizontal a 960px', stacked.overflow);

    // E. Cambio desde el selector de la UI
    await evaluate(`(() => {
      const s = document.querySelector('#themeSelectTop');
      s.value = 'light';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
    check('Cambio por selector funciona', await evaluate(
      `document.documentElement.dataset.theme === 'light' && localStorage.getItem('agenda-p95.theme.v1') === 'light'`));

    // F. Modo sistema con prefers-color-scheme
    await evaluate(`localStorage.setItem('agenda-p95.theme.v1','system')`);
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    });
    await send('Page.reload');
    await waitLoad();
    check('Sistema + prefers light => claro', await evaluate(
      `document.documentElement.dataset.theme === 'light'`),
      await evaluate(`document.documentElement.dataset.theme`));
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    });
    await send('Page.reload');
    await waitLoad();
    check('Sistema + prefers dark => oscuro', await evaluate(
      `document.documentElement.dataset.theme === 'dark'`),
      await evaluate(`document.documentElement.dataset.theme`));

    // G. Móvil: selector del menú
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await send('Page.reload');
    await waitLoad();
    const mobile = await evaluate(`(() => {
      const top = document.querySelector('.top-actions .theme-picker');
      const drawer = document.querySelector('#themeSelectDrawer');
      return {
        topHidden: !top || getComputedStyle(top).display === 'none',
        drawerExists: Boolean(drawer),
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
      };
    })()`);
    check('Selector superior oculto en móvil', mobile.topHidden);
    check('Selector del menú disponible en móvil', mobile.drawerExists);
    check('Sin desbordamiento horizontal a 390px', mobile.overflow);

    // H. Errores de consola en todo el recorrido
    const realErrors = consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
    check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
    const badRequests = failedRequests.filter((r) => !/favicon|manifest/i.test(r));
    check('Sin peticiones fallidas', badRequests.length === 0, badRequests.slice(0, 3).join(' | '));

    // Restaurar vista de escritorio
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setEmulatedMedia', { features: [] });
  } finally {
    try { ws?.close(); } catch { /* ignorar */ }
    try { chrome.kill(); } catch { /* ignorar */ }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignorar */ }
  }

  const total = results.length;
  console.log(`\nRESUMEN: ${total - failures}/${total} PASS`);
  if (failures) {
    console.log('FALLOS:');
    for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name} ${r.detail}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('ERROR FATAL:', error.message);
  process.exit(2);
});






