/**
 * Estilo propio: importar muestras por registro, ver perfiles, puntuar un
 * borrador con motivos y redactar «como yo» para proponer el envío.
 */
import { api, formatError } from './api.js';
import { state } from './state.js';
import { loadStyle as fetchStyle, capability } from './data.js';
import { $, $$, esc, toast, setBusy, emptyState, unavailableState } from './core.js';
import { openCompose } from './compose.js';

let initialized = false;

export function initStyle() {
  if (initialized) return;
  initialized = true;

  $('#styleSampleForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await addSamples(event.currentTarget);
  });

  $('#styleScoreForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await scoreDraft(event.currentTarget);
  });

  $('#styleComposeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await composeDraft(event.currentTarget);
  });

  $('#styleComposeBox')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-style-act]');
    if (!button) return;
    if (button.dataset.styleAct === 'propose') proposeCompose();
    else if (button.dataset.styleAct === 'email') emailCompose();
    else if (button.dataset.styleAct === 'copy') {
      const draft = $('#styleDraft')?.value || '';
      try { await navigator.clipboard.writeText(draft); toast('Borrador copiado', 'ok'); }
      catch { toast('No se pudo copiar al portapapeles', 'warn'); }
    }
  });
}

export async function refreshStyle() {
  const result = await fetchStyle({ force: true }).catch(() => ({ ok: false }));
  renderStyle();
  return result;
}

export function renderStyle() {
  const box = $('#styleProfiles');
  if (!box) return;
  if (!capability('style')) {
    box.innerHTML = unavailableState({ title: 'Estilo no disponible en este servidor', detail: 'El módulo de estilo no está montado.' });
    return;
  }
  const profiles = state.style.profiles;
  const registers = profiles?.registers || ['cliente', 'proveedor', 'entidad', 'colega', 'familiar'];
  fillRegisters(registers);
  const meta = $('#styleMeta');
  if (meta) meta.textContent = profiles ? `${profiles.totalSamples || 0} muestras · mínimo ${profiles.minSamples || 10} por registro` : '';
  const items = Array.isArray(profiles?.items) ? profiles.items : [];
  if (!items.length) {
    box.innerHTML = emptyState('Aún no hay perfiles. Importa muestras para empezar.', '✎');
    return;
  }
  box.innerHTML = items.map((entry) => profileCard(entry)).join('') + (profiles?.global ? `
    <div class="profile-card">
      <div class="p-top"><b>Global (respaldo)</b><span class="tag off">${esc(profiles.global.source || 'global')}</span></div>
      <dl>${profileFacts(profiles.global).map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    </div>` : '');
}

function fillRegisters(registers) {
  const selects = ['#styleSampleRegister', '#styleScoreRegister', '#styleComposeRegister'];
  for (const selector of selects) {
    const select = $(selector);
    if (!select) continue;
    const current = select.value;
    select.innerHTML = registers.map((register) => `<option value="${esc(register)}">${esc(register)}</option>`).join('');
    if (current && registers.includes(current)) select.value = current;
  }
}

function profileFacts(profile) {
  const facts = [
    ['Muestras', profile.sampleCount ?? 0],
    ['Origen', profile.source || 'default'],
    ['Saludo', profile.greeting || '—'],
    ['Despedida', profile.closing || '—'],
    ['Firma', profile.signature || '—'],
    ['Formalidad', profile.formality || '—'],
    ['Frase media', `${Number(profile.sentenceMean || 0).toFixed(1)} palabras`],
    ['Párrafos', profile.paragraphs ?? '—'],
    ['Emojis', Number(profile.emojiRate || 0).toFixed(2)],
    ['Preguntas', Number(profile.questionRate || 0).toFixed(2)],
    ['Frases delatoras', (profile.blacklistHits || []).length],
    ['Actualizado', profile.updatedAt ? String(profile.updatedAt).slice(0, 10) : '—']
  ];
  return facts;
}

function profileCard(entry) {
  const profile = entry.profile || {};
  const samples = entry.samples ?? profile.sampleCount ?? 0;
  return `
    <div class="profile-card">
      <div class="p-top"><b>${esc(entry.register)}</b><span class="tag ${samples >= 10 ? 'ok' : 'warn'}">${samples} muestras · ${esc(entry.source || profile.source || 'default')}</span></div>
      <dl>${profileFacts({ ...profile, sampleCount: samples }).map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    </div>`;
}

async function addSamples(form) {
  const status = $('#styleSampleStatus');
  const register = form.elements.register.value;
  const samples = String(form.elements.text.value || '').split(/\n\s*\n/).map((sample) => sample.trim()).filter(Boolean);
  if (!samples.length) { if (status) { status.textContent = 'Pega al menos una muestra de correo.'; status.className = 'hint bad'; } return; }
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Añadiendo');
  try {
    const result = await api.post('/api/style/samples', { register, samples });
    if (status) {
      status.textContent = `Añadidas ${result.added ?? samples.length} muestras a ${register}. Total: ${result.totalSamples ?? '—'}.`;
      status.className = 'hint ok';
    }
    form.elements.text.value = '';
    toast('Muestras guardadas', 'ok');
    await refreshStyle();
  } catch (error) {
    if (status) { status.textContent = formatError(error); status.className = 'hint bad'; }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function scoreDraft(form) {
  const box = $('#styleScoreBox');
  if (!box) return;
  const text = form.elements.text.value.trim();
  if (!text) { box.innerHTML = '<p class="hint bad">Escribe un borrador para puntuarlo.</p>'; return; }
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Puntuando');
  try {
    const result = await api.post('/api/style/score', { register: form.elements.register.value, text });
    state.style.lastScore = result;
    box.innerHTML = scoreHTML(result);
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  } finally {
    setBusy(button, false);
  }
}

function scoreHTML(result) {
  const score = Number(result.score || 0);
  const components = result.components || {};
  const labels = {
    signature: 'Firma', greeting: 'Saludo', closing: 'Despedida', sentence: 'Frases', words: 'Longitud',
    paragraphs: 'Párrafos', formality: 'Formalidad', emoji: 'Emojis', question: 'Preguntas', bullets: 'Viñetas'
  };
  const bars = Object.entries(labels).map(([key, label]) => {
    const value = Math.max(0, Math.min(1, Number(components[key] ?? 0)));
    return `<div class="component-bar"><span>${esc(label)}</span><span class="bar"><i style="width:${(value * 100).toFixed(0)}%"></i></span><span>${(value * 100).toFixed(0)}%</span></div>`;
  }).join('');
  const why = Array.isArray(result.why) && result.why.length
    ? `<ul class="why-list">${result.why.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`
    : '<p class="muted small">Sin observaciones: encaja con tu perfil.</p>';
  return `
    <div class="score-big">${(score * 100).toFixed(0)}<small>/100 · ${esc(result.register || 'global')} (${esc(result.profileSource || 'default')})</small></div>
    <div class="component-bars">${bars}</div>
    ${why}`;
}

let lastCompose = null;

async function composeDraft(form) {
  const box = $('#styleComposeBox');
  if (!box) return;
  const intent = form.elements.intent.value.trim();
  if (!intent) { box.innerHTML = '<p class="hint bad">Cuéntame qué quieres decir.</p>'; return; }
  const recipientRaw = form.elements.recipient.value.trim();
  const recipient = recipientRaw
    ? (/@/.test(recipientRaw) ? { email: recipientRaw } : { name: recipientRaw })
    : undefined;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Redactando');
  try {
    const result = await api.post('/api/style/compose', {
      register: form.elements.register.value,
      intent,
      ...(recipient ? { recipient } : {})
    });
    lastCompose = result;
    state.style.lastCompose = result;
    box.innerHTML = `
      <div class="score-big">${(Number(result.score || 0) * 100).toFixed(0)}<small>/100 · motor ${esc(result.engine || 'determinista')}</small></div>
      <label class="field"><span>Borrador (editable)</span><textarea id="styleDraft" rows="10" maxlength="20000">${esc(result.draft || '')}</textarea></label>
      <p class="hint">${esc((result.why || []).slice(0, 4).join(' · '))}</p>
      <div class="head-actions">
        <button type="button" class="primary small" data-style-act="propose">Proponer a la Oficina</button>
        <button type="button" class="secondary small" data-style-act="email">Abrir en correo</button>
        <button type="button" class="ghost small" data-style-act="copy">Copiar</button>
      </div>
      <p class="hint" id="styleProposeStatus" role="status"></p>`;
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  } finally {
    setBusy(button, false);
  }
}

function currentDraft() {
  return $('#styleDraft')?.value || lastCompose?.draft || '';
}

async function proposeCompose() {
  const status = $('#styleProposeStatus');
  const draft = currentDraft();
  if (!draft.trim()) { toast('El borrador está vacío', 'warn'); return; }
  if (!capability('office')) {
    toast('La Oficina no está disponible en este servidor', 'warn');
    return;
  }
  const recipientField = $('#styleComposeForm')?.elements.recipient;
  const raw = recipientField?.value.trim() || '';
  let recipients = [];
  if (raw && /@/.test(raw)) recipients = [raw];
  else if (raw) {
    try {
      const expanded = await api.post('/api/identity/expand', { query: raw });
      recipients = Array.isArray(expanded?.recipients) ? expanded.recipients : [];
      if (!recipients.length) {
        toast('No encontré correo para ese nombre. Escribe el correo directamente.', 'warn');
        return;
      }
    } catch {
      toast('Escribe el correo del destinatario para proponer el envío.', 'warn');
      return;
    }
  } else {
    toast('Añade un destinatario (nombre o correo) para proponer el envío.', 'warn');
    return;
  }
  const intent = $('#styleComposeForm')?.elements.intent.value.trim() || 'Mensaje redactado con tu estilo';
  try {
    const result = await api.post('/api/office/proposals', {
      kind: 'email',
      channel: 'email',
      recipients,
      subject: intent.slice(0, 120),
      body: draft
    });
    const level = result?.level || result?.item?.level || '';
    if (status) {
      status.textContent = `Propuesta ${result?.id || ''} creada (${level}). Apruébala en Oficina.`;
      status.className = 'hint ok';
    }
    toast(`Propuesta ${result?.id || ''} en la Oficina`, 'ok');
  } catch (error) {
    if (status) { status.textContent = formatError(error); status.className = 'hint bad'; }
    toast(formatError(error), 'err');
  }
}

function emailCompose() {
  const draft = currentDraft();
  const raw = $('#styleComposeForm')?.elements.recipient?.value.trim() || '';
  const subject = ($('#styleComposeForm')?.elements.intent.value.trim() || 'Mensaje').slice(0, 120);
  openCompose({ to: /@/.test(raw) ? raw : '', subject, body: draft });
}
