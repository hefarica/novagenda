/**
 * Identidades multicorreo: unir personas con varios correos y probar la
 * expansión de destinatarios que usa la redacción.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, emptyState } from './core.js';

let initialized = false;
let current = { items: [], total: 0, query: '' };
let searchTimer = null;

export function initIdentity() {
  if (initialized) return;
  initialized = true;

  $('#identityForm')?.addEventListener('submit', savePerson);
  $('#identityExpandForm')?.addEventListener('submit', expand);
  $('#identityRefresh')?.addEventListener('click', () => refresh());
  $('#identitySearch')?.addEventListener('input', (event) => {
    current.query = String(event.target.value || '').trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 250);
  });
}

export function renderIdentity() {
  if (!initialized) initIdentity();
  refresh().catch(() => {});
}

async function refresh() {
  const params = new URLSearchParams({ limit: '100' });
  if (current.query) params.set('q', current.query);
  const result = await api.get(`/api/identity/people?${params.toString()}`);
  // Los alias sin correo son pistas del grafo, no personas para la lista.
  current.items = (Array.isArray(result?.items) ? result.items : [])
    .filter((person) => Array.isArray(person.emails) && person.emails.length > 0);
  current.total = current.items.length;
  const stats = $('#identityStats');
  if (stats) stats.textContent = `${current.total} persona(s)`;
  const count = $('#identityCount');
  if (count) count.textContent = `${current.items.length} de ${current.total}`;
  renderPeople();
}

function renderPeople() {
  const list = $('#identityPeople');
  if (!list) return;
  if (!current.items.length) {
    list.innerHTML = emptyState(current.query ? 'No hay personas que coincidan.' : 'Aún no hay personas. Añade la primera con el formulario.', '◉');
    return;
  }
  list.innerHTML = current.items.map((person) => {
    const confidence = Number(person.confidence) || 0;
    const tag = confidence >= 0.8 ? 'ok' : 'warn';
    const label = confidence >= 0.8 ? 'Confianza alta' : 'Revisar';
    return `
      <div class="doc-row" data-id="${esc(person.id)}">
        <div class="doc-icon" aria-hidden="true">ID</div>
        <div>
          <b>${esc(person.name)}</b>
          <small>${person.aliases?.length ? `Alias: ${esc(person.aliases.join(', '))}` : 'Sin alias'} · ${person.evidenceCount || 0} evidencia(s)</small>
          <div class="identity-emails">${(person.emails || []).map((email) => `<span>${esc(email)}</span>`).join('')}</div>
        </div>
        <div class="doc-actions"><span class="tag ${tag}">${label} ${Math.round(confidence * 100)}%</span></div>
      </div>`;
  }).join('');
}

async function savePerson(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#identityCreate');
  const name = String(form.elements.name.value || '').trim();
  const emails = String(form.elements.emails.value || '')
    .split(/[,;\n]/).map((email) => email.trim().toLowerCase()).filter(Boolean);
  const aliases = String(form.elements.aliases.value || '')
    .split(',').map((alias) => alias.trim()).filter(Boolean);
  const note = String(form.elements.note.value || '').trim();
  if (!name) { toast('El nombre es obligatorio', 'err'); return; }
  if (!emails.length) { toast('Añade al menos un correo', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/identity/contacts', {
      name, emails, ...(aliases.length ? { aliases } : {}), ...(note ? { note } : {})
    });
    form.elements.name.value = '';
    form.elements.emails.value = '';
    form.elements.aliases.value = '';
    form.elements.note.value = '';
    toast(`${result?.contact?.name || name}: ${result?.contact?.emails?.length || emails.length} correo(s)`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function expand(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const box = $('#identityExpandResult');
  const button = $('#identityExpandBtn');
  const query = String(form.elements.query.value || '').trim();
  if (!query) { toast('Escribe un nombre o correo', 'err'); return; }
  setBusy(button, true);
  if (box) { box.className = 'muted small'; box.textContent = 'Resolviendo…'; }
  try {
    const result = await api.post('/api/identity/expand', { query });
    if (!box) return;
    const people = result?.people || [];
    const recipients = result?.recipients || [];
    box.className = 'small';
    box.innerHTML = `
      <p><b>${recipients.length}</b> destinatario(s)${result?.duplicatesRemoved ? ` · ${result.duplicatesRemoved} duplicado(s) eliminado(s)` : ''}</p>
      ${recipients.length ? `<ul class="identity-recipients">${recipients.map((email) => `<li>${esc(email)}</li>`).join('')}</ul>` : '<p class="muted small">Sin coincidencias.</p>'}
      ${people.length ? `<p class="muted small">Personas: ${people.map((person) => `${esc(person.name)} (${Math.round((person.confidence || 0) * 100)}%)`).join(' · ')}</p>` : ''}
      ${result?.requiresConfirmation ? '<p class="hint bad">Hay ambigüedad o confianza baja: confirma antes de enviar.</p>' : ''}`;
  } catch (error) {
    if (box) { box.className = 'hint bad'; box.textContent = formatError(error); }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

