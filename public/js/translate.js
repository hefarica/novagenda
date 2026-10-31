/**
 * Traducción de textos con el LLM configurado.
 *
 * El backend ya validaba idioma, longitud y prompt-injection; esta capa solo
 * expone el panel y nunca guarda el texto.
 */
import { api, formatError } from './api.js';
import { $, toast, setBusy } from './core.js';

let initialized = false;

export function initTranslate() {
  if (initialized) return;
  if (!$('#translateForm')) return;
  initialized = true;
  $('#translateForm')?.addEventListener('submit', run);
  $('#translateCopy')?.addEventListener('click', copy);
  $('#translateClear')?.addEventListener('click', clear);
  loadLanguages();
}

async function loadLanguages() {
  try {
    const data = await api.get('/api/translate/languages');
    const select = $('#translateTo');
    if (!select || !Array.isArray(data?.items) || !data.items.length) return;
    const current = select.value;
    select.innerHTML = data.items.map((language) => `<option value="${language.code}">${language.label}</option>`).join('');
    if (data.items.some((language) => language.code === current)) select.value = current;
  } catch {
    /* Deja las opciones locales; el POST sigue validando. */
  }
}

async function run(event) {
  event.preventDefault();
  const button = $('#translateRun');
  const input = $('#translateInput');
  const output = $('#translateOutput');
  const status = $('#translateStatus');
  const text = input?.value?.trim() || '';
  if (!text) {
    if (status) status.textContent = 'Escribe o pega el texto a traducir.';
    input?.focus();
    return;
  }
  setBusy(button, true);
  if (status) status.textContent = 'Traduciendo…';
  try {
    const result = await api.post('/api/translate', { text, to: $('#translateTo')?.value || 'en' }, { timeoutMs: 45000 });
    if (output) output.value = result.translation || '';
    if (status) {
      status.textContent = `${result.provider || 'modelo'}${result.model ? ` · ${result.model}` : ''} · ${result.to}`;
    }
    toast('Traducción lista', 'ok');
  } catch (error) {
    if (status) status.textContent = formatError(error);
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function copy() {
  const value = $('#translateOutput')?.value || '';
  if (!value) {
    toast('Todavía no hay traducción', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast('Traducción copiada', 'ok');
  } catch {
    const output = $('#translateOutput');
    output?.select();
    toast('Selecciona y copia con Ctrl+C', 'warn');
  }
}

function clear() {
  const input = $('#translateInput');
  const output = $('#translateOutput');
  const status = $('#translateStatus');
  if (input) input.value = '';
  if (output) output.value = '';
  if (status) status.textContent = '';
  input?.focus();
}
