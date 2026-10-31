/**
 * Documentos: generación real de DOCX/XLSX/PPTX, listado, descarga y envío
 * por correo o canales, con expansión de destinatarios por identidad.
 */
import { api, formatError } from './api.js';
import { state } from './state.js';
import { loadDocs as fetchDocs, capability } from './data.js';
import {
  $, $$, esc, toast, setBusy, emptyState, unavailableState, confirmDialog, openDialog, closeDialog, debounce, promptDialog,
  approvalNoticeHTML, autonomousNoticeHTML, isAutonomousSend, isPendingApproval
} from './core.js';

let initialized = false;
let pendingDocId = null;
let docLabels = new Map();

const HINTS = {
  docx: {
    label: 'Contenido (bloques)',
    hint: 'Usa «# Título», «## Subtítulo», «- viñeta», «> cita» y líneas sueltas para párrafos. Con la plantilla «acta» se añaden asistentes y compromisos.',
    placeholder: '# Acta de reunión\n## Asistentes\n- Ana Ruiz\n- Luis Pérez\n\nConclusiones del proyecto y próximos pasos.'
  },
  xlsx: {
    label: 'Filas (TSV: pestaña entre columnas)',
    hint: 'Primera fila = cabeceras. Separa columnas con TAB o «|». Los números se convierten solos y se añaden totales.',
    placeholder: 'Concepto\tEnero\tFebrero\nLicencias\t1200\t1200\nViajes\t450\t380'
  },
  pptx: {
    label: 'Diapositivas',
    hint: 'Primera línea «# Subtítulo» para la portada. Cada «## Título» abre una diapositiva; «- viñeta» añade puntos.',
    placeholder: '# Propuesta comercial 2026\n## Contexto\n- Tres frentes abiertos\n- Necesitamos foco\n## Plan\n- Cerrar alcance\n- Medir resultados'
  }
};

export function initDocs() {
  if (initialized) return;
  initialized = true;

  $('#docTypeChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-doc-type]');
    if (!chip) return;
    setDocType(chip.dataset.docType);
  });
  setDocType(state.docs.type || 'docx');

  $('#docForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    createDoc();
  });

  $('#docsRefresh')?.addEventListener('click', async () => { await refreshDocs(); toast('Documentos actualizados', 'ok'); });
  $('#docsExportZip')?.addEventListener('click', () => downloadUrl('/api/docs/export.zip'));
  $('#docsSearch') && ($('#docsSearch').addEventListener('input', debounce(async (event) => {
    state.docs.query = event.target.value.trim();
    await refreshDocs();
  }, 180)));

  $('#docsList')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-doc-label]');
    if (select) changeDocLabel(select.dataset.docLabel, select.value);
  });

  $('#docsList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-doc-act]');
    if (!button) return;
    const item = state.docs.items.find((doc) => doc.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.docAct === 'send') openSendDialog(item);
    else if (button.dataset.docAct === 'rename') renameDoc(item);
    else if (button.dataset.docAct === 'duplicate') duplicateDoc(item);
    else if (button.dataset.docAct === 'delete') deleteDoc(item);
    else if (button.dataset.docAct === 'download') downloadDoc(item);
    else if (button.dataset.docAct === 'versions') toggleDocVersions(item);
  });

  $('#docsTemplates')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-template-act]');
    if (!button) return;
    const name = button.dataset.name;
    if (button.dataset.templateAct === 'use') {
      const select = $('#docForm')?.elements.template;
      if (select) select.value = name;
      toast(`Plantilla «${name}» seleccionada`, 'ok');
    } else if (button.dataset.templateAct === 'delete') {
      deleteTemplate(name);
    }
  });

  $('#sendDocForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendDoc();
  });
  $('#sendDocChannel')?.addEventListener('change', updateSendHint);
  $('#sendDocExpand')?.addEventListener('click', expandDocRecipients);
  $('#sendDocPeople')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-doc-email]');
    if (!chip) return;
    const field = $('#sendDocForm')?.elements.to;
    const current = field.value.split(/[,;]+/).map((value) => value.trim()).filter(Boolean);
    if (!current.includes(chip.dataset.docEmail)) current.push(chip.dataset.docEmail);
    field.value = current.join(', ');
  });
}

export async function refreshDocs() {
  const [result, acl] = await Promise.all([
    fetchDocs({ force: true }).catch(() => ({ ok: false })),
    api.get('/api/acl/documents?limit=500').catch(() => null)
  ]);
  docLabels = new Map((acl?.items || []).map((row) => [row.docId, row.label]));
  renderDocs();
  return result;
}

function setDocType(type) {
  const next = ['docx', 'xlsx', 'pptx'].includes(type) ? type : 'docx';
  state.docs.type = next;
  $$('#docTypeChips [data-doc-type]').forEach((chip) => {
    const active = chip.dataset.docType === next;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  const hint = HINTS[next];
  const label = $('#docContentLabel');
  const hintEl = $('#docContentHint');
  const content = $('#docForm')?.elements.content;
  if (label) label.textContent = hint.label;
  if (hintEl) hintEl.textContent = hint.hint;
  if (content) content.placeholder = hint.placeholder;
  const sheet = $('#docSheetField');
  if (sheet) sheet.hidden = next !== 'xlsx';
  const template = $('#docTemplateField');
  if (template) template.hidden = next === 'pptx';
  renderTemplateOptions();
}

function renderTemplateOptions() {
  const select = $('#docForm')?.elements.template;
  if (!select) return;
  const current = select.value;
  const templates = (state.docs.templates || []).filter((template) => !template.type || template.type === state.docs.type);
  select.innerHTML = '<option value="">Sin plantilla</option>' + templates.map((template) => (
    `<option value="${esc(template.name)}">${esc(template.name)}${template.builtin ? ' (integrada)' : ''}</option>`
  )).join('');
  if (current && templates.some((template) => template.name === current)) select.value = current;
}

export function renderDocs() {
  const list = $('#docsList');
  if (!list) return;
  if (!capability('docs')) {
    list.innerHTML = unavailableState({ title: 'Documentos no disponible en este servidor', detail: 'El módulo de documentos no está montado.' });
    return;
  }
  renderTemplateOptions();
  const stats = state.docs.stats;
  const statsEl = $('#docsStats');
  if (statsEl) statsEl.textContent = stats ? `${stats.total ?? state.docs.items.length} documentos · ${formatBytes(stats.bytes || 0)}` : `${state.docs.items.length} documentos`;
  if (!state.docs.items.length) {
    list.innerHTML = emptyState('Todavía no hay documentos. Genera el primero con el formulario.', '▤');
  } else {
    list.innerHTML = state.docs.items.map((doc) => `
      <div class="doc-row" data-id="${esc(doc.id)}">
        <div class="doc-icon ${esc(doc.type)}">${esc((doc.type || '').toUpperCase())}</div>
        <div>
          <b>${esc(doc.title || doc.filename)}</b>
          <small>${esc(doc.filename)} · ${formatBytes(doc.bytes)} · ${esc(String(doc.createdAt || '').slice(0, 10))}${doc.template ? ` · plantilla ${esc(doc.template)}` : ''}</small>
          <div class="doc-label-line"><span class="tag ${docLabelClass(doc.id)}">${esc(docLabel(doc.id))}</span><select class="doc-label-select" data-doc-label="${esc(doc.id)}" aria-label="Clasificación de ${esc(doc.title || doc.filename)}">${labelOptions(doc.id)}</select></div>
        </div>
        <div class="doc-actions">
          <button type="button" data-doc-act="download" data-id="${esc(doc.id)}" aria-label="Descargar ${esc(doc.title || doc.filename)}">Descargar</button>
          <button type="button" data-doc-act="versions" data-id="${esc(doc.id)}" aria-label="Ver versiones de ${esc(doc.title || doc.filename)}">Versiones</button>
          <button type="button" data-doc-act="duplicate" data-id="${esc(doc.id)}" aria-label="Duplicar ${esc(doc.title || doc.filename)}">Duplicar</button>
          <button type="button" data-doc-act="rename" data-id="${esc(doc.id)}" aria-label="Renombrar ${esc(doc.title || doc.filename)}">Renombrar</button>
          <button type="button" data-doc-act="send" data-id="${esc(doc.id)}" aria-label="Enviar ${esc(doc.title || doc.filename)}">Enviar por…</button>
          <button type="button" data-doc-act="delete" data-id="${esc(doc.id)}" aria-label="Borrar ${esc(doc.title || doc.filename)}">Borrar</button>
        </div>
      </div>
      <div class="doc-versions" id="doc-versions-${esc(doc.id)}" hidden></div>`).join('');
  }
  renderTemplates();
  updateSendHint();
}

function docLabel(id) {
  return docLabels.get(id) || 'interno';
}

function docLabelClass(id) {
  const label = docLabel(id);
  return label === 'reservado' ? 'bad' : label === 'interno' ? 'warn' : 'ok';
}

function labelOptions(id) {
  const current = docLabel(id);
  return ['público', 'interno', 'reservado']
    .map((label) => `<option value="${label}"${label === current ? ' selected' : ''}>${label}</option>`)
    .join('');
}

async function changeDocLabel(id, label) {
  if (!id || !['público', 'interno', 'reservado'].includes(label)) return;
  try {
    await api.put(`/api/acl/documents/${encodeURIComponent(id)}`, { label, by: 'owner' });
    docLabels.set(id, label);
    toast(`Documento marcado como ${label}`, 'ok');
    renderDocs();
  } catch (error) {
    toast(formatError(error), 'err');
    renderDocs();
  }
}

function renderTemplates() {
  const box = $('#docsTemplates');
  if (!box) return;
  const templates = state.docs.templates || [];
  if (!templates.length) { box.innerHTML = '<p class="muted small">No hay plantillas disponibles.</p>'; return; }
  box.innerHTML = templates.map((template) => `
    <div class="template-card">
      <b>${esc(template.name)} ${template.builtin ? '<span class="tag ok">integrada</span>' : ''}</b>
      <small>${esc(template.type || 'docx')} · ${esc(template.description || 'sin descripción')}</small>
      <div class="doc-actions" style="justify-content:flex-start;margin-top:6px">
        <button type="button" data-template-act="use" data-name="${esc(template.name)}">Usar</button>
        ${template.builtin ? '' : `<button type="button" data-template-act="delete" data-name="${esc(template.name)}">Borrar</button>`}
      </div>
    </div>`).join('');
}

/* ------------------------------ generación ------------------------------ */

function parseDocxBlocks(text) {
  const blocks = [];
  let bullets = [];
  const flush = () => { if (bullets.length) { blocks.push({ bullets }); bullets = []; } };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^###\s+/.test(line)) { flush(); blocks.push({ heading: line.replace(/^###\s+/, ''), level: 2 }); }
    else if (/^##\s+/.test(line)) { flush(); blocks.push({ heading: line.replace(/^##\s+/, ''), level: 2 }); }
    else if (/^#\s+/.test(line)) { flush(); blocks.push({ heading: line.replace(/^#\s+/, ''), level: 1 }); }
    else if (/^[-*•]\s+/.test(line)) bullets.push(line.replace(/^[-*•]\s+/, ''));
    else if (/^>\s?/.test(line)) { flush(); blocks.push({ quote: line.replace(/^>\s?/, '') }); }
    else { flush(); blocks.push({ paragraph: line }); }
  }
  flush();
  return blocks;
}

function parseSheets(text, name) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const split = (line) => line.split(/\t|\s*\|\s*/).map((cell) => cell.trim());
  const headers = split(lines[0]);
  const columns = headers.map((header, index) => ({ header: header || `Columna ${index + 1}`, key: `c${index}` }));
  const rows = lines.slice(1).map((line) => split(line).map((cell) => {
    if (!cell) return '';
    if (/^-?\d+(\.\d+)?$/.test(cell.replace(/\./g, '').replace(',', '.'))) {
      const numeric = Number(cell.replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(numeric)) return numeric;
    }
    return cell;
  }));
  return [{ name: name || 'Hoja1', columns, rows, totals: true }];
}

function parseSlides(text, title) {
  const lines = String(text || '').split(/\r?\n/);
  let subtitle = '';
  const content = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s+/.test(line) && !/^##\s+/.test(line)) { subtitle = line.replace(/^#\s+/, ''); continue; }
    if (/^##\s+/.test(line)) { content.push({ title: line.replace(/^##\s+/, ''), bullets: [] }); continue; }
    if (/^[-*•]\s+/.test(line)) {
      const bullet = line.replace(/^[-*•]\s+/, '');
      if (!content.length) content.push({ title: 'Ideas', bullets: [] });
      content[content.length - 1].bullets.push(bullet);
      continue;
    }
    if (!content.length) content.push({ title: 'Ideas', bullets: [] });
    content[content.length - 1].bullets.push(line);
  }
  const slides = [{ layout: 'cover', title: title || 'Presentación', subtitle: subtitle || '' }];
  for (const slide of content) {
    slides.push({ title: slide.title, bullets: slide.bullets.length ? slide.bullets : ['—'] });
  }
  return slides;
}

function buildDocPayload() {
  const form = $('#docForm');
  const elements = form.elements;
  const type = state.docs.type || 'docx';
  const title = elements.title.value.trim();
  if (!title) throw new Error('Ponle un título al documento.');
  const content = elements.content.value;
  const template = elements.template?.value || '';
  const payload = { type, title, register: true, ...(template ? { template } : {}) };
  const watermark = elements.watermark?.value?.trim();
  if (watermark) payload.watermark = watermark;
  if (type === 'docx') {
    const sections = parseDocxBlocks(content);
    if (!sections.length && template !== 'acta') throw new Error('Añade al menos una línea de contenido.');
    payload.sections = sections;
    if (content.includes('>')) {
      const quotes = parseDocxBlocks(content).filter((block) => block.quote).map((block) => block.quote);
      if (quotes.length) payload.notes = quotes.join(' ');
    }
  } else if (type === 'xlsx') {
    const sheets = parseSheets(content, elements.sheetName?.value?.trim());
    if (!sheets.length) throw new Error('Añade al menos una fila de cabeceras.');
    payload.sheets = sheets;
  } else {
    payload.slides = parseSlides(content, title);
  }
  return payload;
}

async function createDoc() {
  const status = $('#docFormStatus');
  const button = $('#docCreateBtn');
  let payload = null;
  try {
    payload = buildDocPayload();
  } catch (error) {
    if (status) { status.textContent = error.message; status.className = 'hint bad'; }
    return;
  }
  setBusy(button, true, 'Generando');
  if (status) { status.textContent = 'Generando documento…'; status.className = 'hint'; }
  try {
    const result = await api.post('/api/docs', payload);
    const item = result?.item || result;
    if (status) { status.textContent = `Listo: ${item.title || item.filename || 'documento'} (${formatBytes(item.bytes)}).`; status.className = 'hint ok'; }
    const madeTasks = Array.isArray(item?.tasks) ? item.tasks.length : 0;
    toast(madeTasks ? `Documento generado · ${madeTasks} tarea(s) creada(s) desde los acuerdos` : 'Documento generado', 'ok');
    await refreshDocs();
    if (item?.downloadUrl && $('#docForm')?.elements.openAfter.checked) downloadUrl(item.downloadUrl);
  } catch (error) {
    if (status) { status.textContent = formatError(error); status.className = 'hint bad'; }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function downloadUrl(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function toggleDocVersions(doc) {
  const box = $(`#doc-versions-${doc.id}`);
  if (!box) return;
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.textContent = 'Buscando versiones…';
  try {
    const result = await api.get(`/api/docs/${encodeURIComponent(doc.id)}/versions`);
    const items = result?.items || [];
    box.innerHTML = items.length
      ? `<p class="muted small">${items.length} versión(es) con el mismo título:</p>${items.map((version) => `
          <div class="doc-version">
            <span>${esc(String(version.createdAt || '').slice(0, 16).replace('T', ' '))}</span>
            <b>${esc(version.filename)}</b>
            <a href="${esc(version.downloadUrl)}" rel="noopener">Descargar</a>
          </div>`).join('')}`
      : '<p class="muted small">No hay otras versiones con este título.</p>';
  } catch (error) {
    box.textContent = formatError(error);
  }
}

function downloadDoc(doc) {
  downloadUrl(doc.downloadUrl || `/api/docs/${encodeURIComponent(doc.id)}/download`);
}

async function renameDoc(doc) {
  const title = await promptDialog({
    title: 'Renombrar documento',
    text: 'El título cambia y las versiones anteriores siguen agrupadas con este documento.',
    label: 'Nuevo título',
    value: doc.title || ''
  });
  if (title === null) return;
  const clean = String(title || '').trim();
  if (!clean || clean === doc.title) return;
  try {
    await api.patch(`/api/docs/${encodeURIComponent(doc.id)}`, { title: clean });
    toast('Documento renombrado', 'ok');
    await refreshDocs();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function duplicateDoc(doc) {
  try {
    await api.post(`/api/docs/${encodeURIComponent(doc.id)}/duplicate`);
    toast('Documento duplicado', 'ok');
    await refreshDocs();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function deleteDoc(doc) {
  const ok = await confirmDialog({
    title: 'Borrar documento',
    text: `Se eliminará «${doc.title || doc.filename}» del almacén. No se puede deshacer.`,
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/docs/${encodeURIComponent(doc.id)}`);
    toast('Documento borrado', 'ok');
    await refreshDocs();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function deleteTemplate(name) {
  const ok = await confirmDialog({ title: 'Borrar plantilla', text: `Se eliminará la plantilla «${name}».`, okLabel: 'Borrar', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/docs/templates/${encodeURIComponent(name)}`);
    toast('Plantilla borrada', 'ok');
    await refreshDocs();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

/* ------------------------------ envío ------------------------------ */

function emailStatus() {
  const items = state.channelCenter?.items || [];
  const email = items.find((item) => /email|correo|gmail/i.test(`${item.id} ${item.label || ''}`));
  if (!email) return { ready: false, text: 'Correo no configurado: conéctalo en Integraciones.' };
  const detail = state.channelDetails?.[email.id] || email;
  const warnings = Array.isArray(detail.warnings) ? detail.warnings : [];
  const enabled = detail.enabled !== false;
  if (!enabled) return { ready: false, text: 'El canal de correo está desactivado en Integraciones.' };
  const runtime = detail.runtime || {};
  if (runtime.ready === false || runtime.readReady === false) {
    return { ready: false, text: `Correo conectado pero sin lectura: ${warnings[0] || 'requiere Gmail con lectura.'}` };
  }
  return { ready: true, text: 'Correo listo para enviar.' };
}

export function openSendDialog(doc) {
  pendingDocId = doc.id;
  const form = $('#sendDocForm');
  if (!form) return;
  form.reset();
  const meta = $('#sendDocMeta');
  if (meta) meta.textContent = `${doc.title || doc.filename} · ${formatBytes(doc.bytes)} · ${doc.filename}`;
  form.elements.subject.value = doc.title || '';
  form.elements.body.value = '';
  const alertBox = $('#sendDocAlert');
  if (alertBox) { alertBox.hidden = true; alertBox.className = 'alert'; alertBox.setAttribute('role', 'alert'); }
  updateSendHint();
  if (docLabel(doc.id) === 'reservado' && alertBox) {
    alertBox.hidden = false;
    alertBox.className = 'alert warn';
    alertBox.setAttribute('role', 'alert');
    alertBox.textContent = 'Documento reservado: el correo directo no sale. Cambia la clasificación o envíalo por un canal de la Oficina, donde el gate N3 pide código.';
  }
  openDialog('#dlg-send-doc');
}

function updateSendHint() {
  const form = $('#sendDocForm');
  if (!form) return;
  const channel = form.elements.channel.value;
  const hint = $('#composeHint');
  const alertBox = $('#sendDocAlert');
  if (channel === 'email') {
    const status = emailStatus();
    if (alertBox) {
      alertBox.hidden = false;
      alertBox.className = `alert ${status.ready ? 'info' : 'warn'}`;
      alertBox.textContent = status.ready ? status.text : `${status.text} Puedes generarlo igualmente y descargarlo.`;
    }

  } else if (alertBox) {
    alertBox.hidden = false;
    alertBox.className = 'alert info';
    alertBox.textContent = 'Se enviará el archivo por el canal elegido. En el simulador no sale nada del equipo.';
  }
}

async function expandDocRecipients() {
  const form = $('#sendDocForm');
  const box = $('#sendDocPeople');
  if (!form || !box) return;
  const query = form.elements.to.value.trim();
  if (!query) { box.textContent = 'Escribe un nombre o correo primero.'; return; }
  box.textContent = 'Buscando…';
  try {
    const result = await api.post('/api/identity/expand', { query });
    if (!result?.people?.length) { box.textContent = 'Sin coincidencias: escribe el correo completo.'; return; }
    box.innerHTML = result.people.map((person) => `<button type="button" class="chip" data-doc-email="${esc((person.emails || [])[0] || '')}" title="${esc((person.evidence || []).map((item) => item.type || '').join(' · '))}">${esc(person.name)}${person.requiresConfirmation ? ' ⚠' : ''}</button>`).join(' ');
  } catch (error) {
    box.textContent = formatError(error);
  }
}

async function sendDoc() {
  const form = $('#sendDocForm');
  if (!form || !pendingDocId) return;
  const channel = form.elements.channel.value;
  const to = form.elements.to.value.trim();
  const subject = form.elements.subject.value.trim();
  const body = form.elements.body.value.trim();
  const button = $('#sendDocBtn');
  const alertBox = $('#sendDocAlert');
  const showAutonomous = (result) => {
    if (alertBox) {
      alertBox.hidden = false;
      alertBox.className = 'alert ok';
      alertBox.setAttribute('role', 'status');
      alertBox.innerHTML = autonomousNoticeHTML(result);
    }
    toast('Enviado automáticamente por autonomía', 'ok');
  };
  const showPendingApproval = (result) => {
    if (alertBox) {
      alertBox.hidden = false;
      alertBox.className = 'alert info';
      alertBox.setAttribute('role', 'status');
      alertBox.innerHTML = approvalNoticeHTML(result);
    }
    toast('Preparado y enviado a la Oficina para tu aprobación', 'ok');
  };
  setBusy(button, true, 'Preparando');
  try {
    if (channel === 'email') {
      const recipients = to.split(/[,;]+/).map((value) => value.trim()).filter(Boolean);
      if (!recipients.length) throw new Error('Escribe al menos un destinatario de correo.');
      const result = await api.post(`/api/docs/${encodeURIComponent(pendingDocId)}/send-email`, {
        to: recipients,
        subject: subject || 'Documento adjunto',
        body: body || 'Te adjunto el documento generado desde Agenda Copilot.'
      });
      if (isAutonomousSend(result)) { showAutonomous(result); return; }
      if (isPendingApproval(result)) { showPendingApproval(result); return; }
      toast('Correo enviado', 'ok');
    } else {
      const result = await api.post('/api/channels/send-document', {
        docId: pendingDocId,
        channel,
        ...(to ? { to } : {}),
        ...(body ? { caption: body } : {})
      });
      if (isAutonomousSend(result)) { showAutonomous(result); return; }
      if (isPendingApproval(result)) { showPendingApproval(result); return; }
      toast(`Documento enviado por ${result?.channel || channel}`, 'ok');
    }
    closeDialog('#dlg-send-doc');
  } catch (error) {
    if (alertBox) alertBox.setAttribute('role', 'alert');
    if (error?.code === 'EMAIL_NOT_CONFIGURED' || error?.status === 503) {
      const message = 'El correo no está configurado. Conecta Gmail en Integraciones (con permiso de lectura) y reintenta.';
      if (alertBox) { alertBox.hidden = false; alertBox.className = 'alert warn'; alertBox.textContent = message; }
      toast(message, 'warn');
    } else if (error?.code === 'CHANNEL_NOT_READY') {
      const message = 'Ese canal aún no está listo. Revisa su configuración en Integraciones y reintenta.';
      if (alertBox) { alertBox.hidden = false; alertBox.className = 'alert warn'; alertBox.textContent = message; }
      toast(message, 'warn');
    } else if (error?.message && /destinatario|to/i.test(error.message) && !error.status) {
      if (alertBox) { alertBox.hidden = false; alertBox.className = 'alert warn'; alertBox.textContent = error.message; }
    } else {
      toast(formatError(error), 'err');
    }
  } finally {
    setBusy(button, false);
  }
}

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}


