/**
 * Organización viva de la oficina.
 *
 * Parte del ADN de 24 roles importado de OrgDNA y se guarda en el store local.
 * Los roles son perfiles declarativos: no conceden permisos por sí mismos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { store } from '../store.mjs';
import { HttpError } from '../http/errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(HERE, 'org-seed.json');
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seed() {
  try {
    return JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  } catch {
    return {
      version: 1, source: 'local', teams: [], members: [], jobs: [],
      error: 'No se pudo leer org-seed.json'
    };
  }
}

function ensureShape(value) {
  const org = value && typeof value === 'object' ? value : {};
  return {
    version: Number(org.version) || 1,
    source: String(org.source || 'local').slice(0, 120),
    teams: Array.isArray(org.teams) ? org.teams : [],
    members: Array.isArray(org.members) ? org.members : [],
    jobs: Array.isArray(org.jobs) ? org.jobs : []
  };
}

export function ensureOrganization() {
  const data = store.get();
  if (!data.organization || !Array.isArray(data.organization.members)) {
    const initial = ensureShape(seed());
    store.mutate((state) => {
      state.organization = initial;
    }, { label: 'org-seed' }).catch(() => {});
    return initial;
  }
  return ensureShape(data.organization);
}

export function getOrganization() {
  return clone(ensureOrganization());
}

function text(value, field, max = 500, { required = false } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new HttpError(400, 'ORG_FIELD_REQUIRED', `Falta ${field}.`);
  return result.slice(0, max);
}

function list(value, field, max = 32, itemMax = 120) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'ORG_BAD_FIELD', `${field} debe ser una lista.`);
  return value.slice(0, max).map((item) => String(item ?? '').trim().slice(0, itemMax)).filter(Boolean);
}

function normalizeTeam(input = {}) {
  const id = text(input.id, 'team.id', 64, { required: true }).toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, 'ORG_BAD_ID', 'team.id inválido.');
  return {
    id,
    name: text(input.name, 'team.name', 120, { required: true }),
    mission: text(input.mission, 'team.mission', 600)
  };
}

function normalizeMember(input = {}) {
  const id = text(input.id, 'member.id', 64, { required: true }).toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, 'ORG_BAD_ID', 'member.id inválido.');
  return {
    id,
    name: text(input.name, 'member.name', 120, { required: true }),
    title: text(input.title, 'member.title', 160),
    team: text(input.team, 'member.team', 64),
    reportsTo: text(input.reportsTo, 'member.reportsTo', 64) || null,
    mission: text(input.mission, 'member.mission', 800),
    capabilities: list(input.capabilities, 'member.capabilities'),
    tools: list(input.tools, 'member.tools'),
    status: ['active', 'paused'].includes(input.status) ? input.status : 'active'
  };
}

export function saveOrganization(input) {
  const org = ensureShape(input);
  const teams = org.teams.map(normalizeTeam);
  const teamIds = new Set(teams.map((team) => team.id));
  const members = org.members.map(normalizeMember);
  const memberIds = new Set(members.map((member) => member.id));
  for (const member of members) {
    if (!teamIds.has(member.team)) throw new HttpError(400, 'ORG_UNKNOWN_TEAM', `Equipo desconocido: ${member.team}.`);
    if (member.reportsTo && !memberIds.has(member.reportsTo)) {
      throw new HttpError(400, 'ORG_UNKNOWN_MANAGER', `Jefe desconocido: ${member.reportsTo}.`);
    }
  }
  const saved = {
    version: Number(org.version) || 1,
    source: text(org.source, 'source', 120) || 'Agenda Copilot',
    teams,
    members,
    jobs: Array.isArray(org.jobs) ? org.jobs.slice(-200) : []
  };
  store.mutate((state) => { state.organization = saved; }, { label: 'org-save' });
  return clone(saved);
}

export function upsertMember(input) {
  const org = getOrganization();
  const member = normalizeMember(input);
  const index = org.members.findIndex((item) => item.id === member.id);
  if (index >= 0) org.members[index] = member;
  else org.members.push(member);
  return saveOrganization(org);
}

export function deleteMember(id) {
  const org = getOrganization();
  const memberId = String(id || '').toLowerCase();
  org.members = org.members.filter((member) => member.id !== memberId);
  for (const member of org.members) {
    if (member.reportsTo === memberId) member.reportsTo = null;
  }
  return saveOrganization(org);
}

export function upsertTeam(input) {
  const org = getOrganization();
  const team = normalizeTeam(input);
  const index = org.teams.findIndex((item) => item.id === team.id);
  if (index >= 0) org.teams[index] = team;
  else org.teams.push(team);
  return saveOrganization(org);
}

export function deleteTeam(id) {
  const org = getOrganization();
  const teamId = String(id || '').toLowerCase();
  if (org.members.some((member) => member.team === teamId)) {
    throw new HttpError(409, 'ORG_TEAM_NOT_EMPTY', 'Mueve o elimina primero los agentes de ese equipo.');
  }
  org.teams = org.teams.filter((team) => team.id !== teamId);
  return saveOrganization(org);
}

export function organizationSummary() {
  const org = getOrganization();
  return {
    teams: org.teams.map((team) => ({
      id: team.id,
      name: team.name,
      members: org.members.filter((member) => member.team === team.id).length
    })),
    members: org.members.map((member) => ({
      id: member.id,
      name: member.name,
      title: member.title,
      team: member.team,
      capabilities: member.capabilities
    })),
    count: org.members.length
  };
}

/** Importa el JSON de OrgDNA (agents/squads) sin tocar la app de origen. */
export function importOrgDna(payload) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  if (!agents.length) throw new HttpError(400, 'ORG_IMPORT_EMPTY', 'El archivo no contiene agents.');
  const current = getOrganization();
  const names = new Map(current.members.map((member) => [member.name.toLowerCase(), member]));
  const teams = [...current.teams];
  const teamId = 'orgdna';
  if (!teams.some((team) => team.id === teamId)) {
    teams.push({ id: teamId, name: 'OrgDNA importado', mission: 'Perfiles importados desde el ADN de la oficina.' });
  }
  let imported = 0;
  for (const agent of agents.slice(0, 120)) {
    const name = String(agent.name || '').trim().slice(0, 120);
    if (!name) continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `agent-${imported}`;
    if (names.has(name.toLowerCase())) continue;
    const member = normalizeMember({
      id,
      name,
      title: String(agent.role || agent.title || 'Agente importado').slice(0, 160),
      team: teamId,
      reportsTo: null,
      mission: String(agent.systemPrompt || '').split('\n')[0].slice(0, 800),
      capabilities: ['perfil OrgDNA'],
      tools: Array.isArray(agent.toolScope?.allow) ? agent.toolScope.allow.slice(0, 12) : []
    });
    current.members.push(member);
    names.set(name.toLowerCase(), member);
    imported += 1;
  }
  saveOrganization({ ...current, teams, source: 'OrgDNA importado' });
  return { imported, members: current.members.length, teams: teams.length };
}
