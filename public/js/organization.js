/**
 * Organización: 24 perfiles base, equipos editables y jerarquía declarativa.
 */
import { api } from './api.js';
import { $, esc, toast } from './core.js';

let initialized = false;
let cache = null;
let busy = false;

function closeDialog(id) {
  const dialog = document.getElementById(id);
  try { dialog?.close(); } catch { /* nada */ }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function teamOptions(selected = '') {
  return (cache?.teams || [])
    .map((team) => `<option value="${esc(team.id)}" ${team.id === selected ? 'selected' : ''}>${esc(team.name)}</option>`)
    .join('');
}

function managerOptions(selected = '', excludeId = '') {
  const options = ['<option value="">Sin jefe directo (Owner)</option>'];
  for (const member of cache?.members || []) {
    if (member.id === excludeId) continue;
    options.push(`<option value="${esc(member.id)}" ${member.id === selected ? 'selected' : ''}>${esc(member.name)} · ${esc(member.title || member.id)}</option>`);
  }
  return options.join('');
}

function renderSummary() {
  const box = $('#orgSummary');
  if (!box) return;
  if (!cache) { box.innerHTML = '<p class="muted">Cargando organización…</p>'; return; }
  const active = cache.members.filter((member) => member.status !== 'paused').length;
  box.innerHTML = `
    <article class="org-stat"><strong>${cache.members.length}</strong><span>perfiles</span><small>${active} activos</small></article>
    <article class="org-stat"><strong>${cache.teams.length}</strong><span>equipos</span><small>con mando declarado</small></article>
    <article class="org-stat"><strong>${cache.jobs?.length || 0}</strong><span>encargos</span><small>en el Estudio</small></article>
    <article class="org-stat org-stat-note"><strong>${esc(cache.source || 'Agenda Copilot')}</strong><span>origen</span><small>Los permisos reales pasan por aprobación.</small></article>`;
}

function renderTeams() {
  const box = $('#orgTeams');
  if (!box) return;
  if (!cache) { box.innerHTML = ''; return; }
  box.innerHTML = cache.teams.map((team) => {
    const members = cache.members.filter((member) => member.team === team.id);
    return `<article class="org-team">
      <div class="org-team-head"><div><p class="ha-eyebrow">EQUIPO</p><h3>${esc(team.name)}</h3></div>
        <div class="org-team-actions"><button type="button" class="org-delete" data-org-team-edit="${esc(team.id)}" title="Editar equipo">✎</button><button type="button" class="org-delete" data-org-team-delete="${esc(team.id)}" title="Eliminar equipo">×</button></div></div>
      <p class="muted small">${esc(team.mission || 'Sin misión declarada.')}</p>
      <div class="org-team-members">${members.map((member) => `<button type="button" class="org-mini" data-org-edit="${esc(member.id)}"><span>${esc(member.name)}</span><small>${esc(member.title || 'Agente')}</small></button>`).join('') || '<span class="muted small">Sin agentes. Añade uno desde “＋ Agente”.</span>'}</div>
    </article>`;
  }).join('');
}

function renderMembers() {
  const box = $('#orgMembers');
  const meta = $('#orgMembersMeta');
  if (meta) meta.textContent = cache ? `${cache.members.length} perfiles · ${cache.members.filter((m) => m.status !== 'paused').length} activos` : '';
  if (!box) return;
  if (!cache) { box.innerHTML = ''; return; }
  box.innerHTML = cache.members.map((member) => {
    const team = cache.teams.find((item) => item.id === member.team);
    const manager = cache.members.find((item) => item.id === member.reportsTo);
    return `<article class="org-member">
      <div class="org-member-top"><div><h4>${esc(member.name)}</h4><p>${esc(member.title || 'Agente')}${team ? ` · ${esc(team.name)}` : ''}</p></div>
        <span class="tag ${member.status === 'paused' ? 'off' : 'ok'}">${member.status === 'paused' ? 'pausado' : 'activo'}</span></div>
      <p class="org-member-mission">${esc(member.mission || 'Sin misión declarada.')}</p>
      <div class="caps">${(member.capabilities || []).slice(0, 6).map((cap) => `<span>${esc(cap)}</span>`).join('')}</div>
      <footer><small>Reporta a: ${esc(manager?.name || 'Owner')}</small>
        <div class="row-actions"><button type="button" class="ghost small" data-org-edit="${esc(member.id)}">Editar</button><button type="button" class="textbutton danger" data-org-delete="${esc(member.id)}">Eliminar</button></div></footer>
    </article>`;
  }).join('');
}

export function renderOrganization() {
  renderSummary();
  renderTeams();
  renderMembers();
}

export async function loadOrganization({ force = false } = {}) {
  if (cache && !force) return cache;
  const data = await api.get('/api/studio/org', { timeoutMs: 20000 });
  cache = data?.organization || null;
  if (cache) {
    cache.jobs = Array.isArray(cache.jobs) ? cache.jobs : [];
    cache.teams = Array.isArray(cache.teams) ? cache.teams : [];
    cache.members = Array.isArray(cache.members) ? cache.members : [];
  }
  renderOrganization();
  return cache;
}

function fillAgentDialog(member = null) {
  if (!cache) return;
  const teamSelect = $('#orgAgentTeam');
  const reportSelect = $('#orgAgentReports');
  if (teamSelect) teamSelect.innerHTML = teamOptions(member?.team || cache.teams[0]?.id || '');
  if (reportSelect) reportSelect.innerHTML = managerOptions(member?.reportsTo || '', member?.id || '');
  $('#orgAgentId').value = member?.id || '';
  $('#orgAgentName').value = member?.name || '';
  $('#orgAgentTitle').value = member?.title || '';
  $('#orgAgentMission').value = member?.mission || '';
  $('#orgAgentCaps').value = (member?.capabilities || []).join(', ');
  $('#orgAgentTools').value = (member?.tools || []).join(', ');
  $('#orgAgentDialogTitle').textContent = member ? `Editar ${member.name}` : 'Nuevo agente';
}

function fillTeamDialog(team = null) {
  $('#orgTeamId').value = team?.id || '';
  $('#orgTeamName').value = team?.name || '';
  $('#orgTeamMission').value = team?.mission || '';
  $('#orgTeamDialogTitle').textContent = team ? `Editar ${team.name}` : 'Nuevo equipo';
}

async function saveMember(event) {
  event.preventDefault();
  if (busy) return;
  const id = $('#orgAgentId').value.trim()
    || $('#orgAgentName').value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const payload = {
    id,
    name: $('#orgAgentName').value.trim(),
    title: $('#orgAgentTitle').value.trim(),
    team: $('#orgAgentTeam').value,
    reportsTo: $('#orgAgentReports').value || null,
    mission: $('#orgAgentMission').value.trim(),
    capabilities: splitList($('#orgAgentCaps').value),
    tools: splitList($('#orgAgentTools').value)
  };
  if (!payload.id || !payload.name) { toast('El agente necesita nombre.', 'warn'); return; }
  busy = true;
  try {
    await api.post('/api/studio/members', payload, { timeoutMs: 20000 });
    closeDialog('dlg-org-agent');
    await loadOrganization({ force: true });
    toast('Agente guardado.', 'ok');
  } catch (error) {
    toast(error?.message || 'No pude guardar el agente.', 'bad');
  } finally { busy = false; }
}

async function saveTeam(event) {
  event.preventDefault();
  if (busy) return;
  const name = $('#orgTeamName').value.trim();
  if (!name) return;
  const existing = $('#orgTeamId').value.trim();
  const id = existing || name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  busy = true;
  try {
    await api.post('/api/studio/teams', { id, name, mission: $('#orgTeamMission').value.trim() }, { timeoutMs: 20000 });
    closeDialog('dlg-org-team');
    await loadOrganization({ force: true });
    toast(existing ? 'Equipo actualizado.' : 'Equipo creado.', 'ok');
  } catch (error) {
    toast(error?.message || 'No pude guardar el equipo.', 'bad');
  } finally { busy = false; }
}

async function deleteMember(id) {
  const member = cache?.members.find((item) => item.id === id);
  if (!member || !window.confirm(`¿Eliminar a ${member.name} de la organización?`)) return;
  try {
    await api.del(`/api/studio/members/${encodeURIComponent(id)}`, { timeoutMs: 20000 });
    await loadOrganization({ force: true });
    toast('Agente eliminado.', 'ok');
  } catch (error) { toast(error?.message || 'No pude eliminar el agente.', 'bad'); }
}

async function deleteTeam(id) {
  const team = cache?.teams.find((item) => item.id === id);
  if (!team || !window.confirm(`¿Eliminar el equipo ${team.name}?`)) return;
  try {
    await api.del(`/api/studio/teams/${encodeURIComponent(id)}`, { timeoutMs: 20000 });
    await loadOrganization({ force: true });
    toast('Equipo eliminado.', 'ok');
  } catch (error) { toast(error?.message || 'No pude eliminar el equipo.', 'bad'); }
}

async function importOrgDna(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await api.post('/api/studio/import', data, { timeoutMs: 30000 });
    await loadOrganization({ force: true });
    toast(`Importados ${result.imported || 0} perfiles de OrgDNA.`, 'ok');
  } catch (error) {
    toast(error?.message || 'No pude importar el JSON de OrgDNA.', 'bad');
  } finally {
    const input = $('#orgImportFile');
    if (input) input.value = '';
  }
}

export function initOrganization() {
  if (initialized) return;
  initialized = true;
  $('#orgNewAgent')?.addEventListener('click', () => { fillAgentDialog(); openDialog('dlg-org-agent'); });
  $('#orgNewTeam')?.addEventListener('click', () => { fillTeamDialog(); openDialog('dlg-org-team'); });
  $('#orgAgentForm')?.addEventListener('submit', saveMember);
  $('#orgTeamForm')?.addEventListener('submit', saveTeam);
  $('#orgImportBtn')?.addEventListener('click', () => $('#orgImportFile')?.click());
  $('#orgImportFile')?.addEventListener('change', (event) => importOrgDna(event.target.files?.[0]));
  $('#view-organization')?.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-org-edit]');
    if (edit) {
      const member = cache?.members.find((item) => item.id === edit.dataset.orgEdit);
      if (member) { fillAgentDialog(member); openDialog('dlg-org-agent'); }
      return;
    }
    const teamEdit = event.target.closest('[data-org-team-edit]');
    if (teamEdit) {
      const team = cache?.teams.find((item) => item.id === teamEdit.dataset.orgTeamEdit);
      if (team) { fillTeamDialog(team); openDialog('dlg-org-team'); }
      return;
    }
    const remove = event.target.closest('[data-org-delete]');
    if (remove) { deleteMember(remove.dataset.orgDelete); return; }
    const teamRemove = event.target.closest('[data-org-team-delete]');
    if (teamRemove) { deleteTeam(teamRemove.dataset.orgTeamDelete); return; }
  });
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-dialog]');
    if (close) closeDialog(close.dataset.closeDialog);
  });
  loadOrganization().catch((error) => {
    const box = $('#orgSummary');
    if (box) box.innerHTML = `<p class="muted">No pude cargar la organización: ${esc(error?.message || 'error')}</p>`;
  });
}

