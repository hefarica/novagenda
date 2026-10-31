/**
 * Tema de la interfaz: Oscuro / Claro / Sistema.
 * - Persiste la elección en localStorage.
 * - Sin elección previa respeta prefers-color-scheme.
 * - Aplica `data-theme` y `data-theme-choice` en <html>.
 * - Mantiene sincronizados los selectores de la barra superior y del menú.
 */

const STORAGE_KEY = 'agenda-p95.theme.v1';
const CHOICES = ['dark', 'light', 'system'];
const DEFAULT_COLOR = { dark: '#061426', light: '#FFFFFF' };

let media = null;
let initialized = false;
let currentChoice = 'system';

function storedChoice() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return CHOICES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark() {
  return Boolean(media && media.matches);
}

function resolve(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return systemPrefersDark() ? 'dark' : 'light';
}

function syncSelectors(choice) {
  for (const select of document.querySelectorAll('[data-theme-select]')) {
    if (select.value !== choice) select.value = choice;
  }
}

function paint(choice) {
  currentChoice = choice;
  const resolved = resolve(choice);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeChoice = choice;
  const meta = document.getElementById('metaThemeColor');
  if (meta) meta.setAttribute('content', DEFAULT_COLOR[resolved] || DEFAULT_COLOR.dark);
  syncSelectors(choice);
}

export function setTheme(choice, { persist = true } = {}) {
  const next = CHOICES.includes(choice) ? choice : 'system';
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* modo privado */ }
  }
  paint(next);
  return next;
}

export function themeChoice() {
  return currentChoice;
}

export function initTheme() {
  if (initialized) return;
  initialized = true;
  media = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  currentChoice = storedChoice();
  paint(currentChoice);

  for (const select of document.querySelectorAll('[data-theme-select]')) {
    select.value = currentChoice;
    select.addEventListener('change', (event) => {
      const choice = CHOICES.includes(event.currentTarget.value) ? event.currentTarget.value : 'system';
      setTheme(choice);
    });
  }

  if (media) {
    const onChange = () => {
      if (currentChoice === 'system') paint('system');
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if (typeof media.addListener === 'function') media.addListener(onChange);
  }
}


