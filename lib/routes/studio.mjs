/**
 * Organización y Estudio de trabajo.
 *
 *   GET  /api/studio/org
 *   PUT  /api/studio/org
 *   POST /api/studio/members
 *   DELETE /api/studio/members/:id
 *   POST /api/studio/teams
 *   DELETE /api/studio/teams/:id
 *   POST /api/studio/import
 *   GET  /api/studio/jobs
 *   POST /api/studio/jobs
 *   GET  /api/studio/jobs/:id/download
 */
import { bodyOf, paramOf, respond, route } from '../agenda/http.mjs';
import {
  getOrganization, saveOrganization, upsertMember, deleteMember, upsertTeam, deleteTeam,
  importOrgDna, organizationSummary
} from '../studio/org.mjs';
import { createStudioJob, listStudioJobs, readJobFile, studioWorkerStatus } from '../studio/jobs.mjs';

export const name = 'studio';
export const priority = 117;

async function orgGet(ctx) {
  return respond(ctx, 200, { ok: true, organization: getOrganization(), summary: organizationSummary() });
}

async function orgPut(ctx) {
  const body = await bodyOf(ctx);
  const organization = saveOrganization(body?.organization || body);
  return respond(ctx, 200, { ok: true, organization, summary: organizationSummary() });
}

async function memberPost(ctx) {
  const body = await bodyOf(ctx);
  const organization = upsertMember(body);
  return respond(ctx, 200, { ok: true, organization, summary: organizationSummary() });
}

async function memberDelete(ctx) {
  const organization = deleteMember(paramOf(ctx, 'id'));
  return respond(ctx, 200, { ok: true, organization, summary: organizationSummary() });
}

async function teamPost(ctx) {
  const body = await bodyOf(ctx);
  const organization = upsertTeam(body);
  return respond(ctx, 200, { ok: true, organization, summary: organizationSummary() });
}

async function teamDelete(ctx) {
  const organization = deleteTeam(paramOf(ctx, 'id'));
  return respond(ctx, 200, { ok: true, organization, summary: organizationSummary() });
}

async function importPost(ctx) {
  const body = await bodyOf(ctx);
  const result = importOrgDna(body);
  return respond(ctx, 200, { ok: true, ...result, organization: getOrganization() });
}

async function jobsGet(ctx) {
  return respond(ctx, 200, {
    ok: true,
    items: listStudioJobs(),
    organization: organizationSummary(),
    worker: studioWorkerStatus()
  });
}

async function jobsPost(ctx) {
  const body = await bodyOf(ctx);
  const job = await createStudioJob(body);
  return respond(ctx, 202, { ok: true, job, queued: true, worker: studioWorkerStatus() });
}

async function downloadGet(ctx) {
  const { buffer, filename } = readJobFile(paramOf(ctx, 'id'));
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'application/zip');
  ctx.res.setHeader('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  ctx.res.setHeader('content-length', String(buffer.length));
  ctx.res.end(buffer);
}

export const routes = [
  { method: 'GET', path: '/api/studio/org', name: 'studio.org.get', handler: route(orgGet) },
  { method: 'PUT', path: '/api/studio/org', name: 'studio.org.put', maxBodyBytes: 3_000_000, handler: route(orgPut) },
  { method: 'POST', path: '/api/studio/members', name: 'studio.members.post', handler: route(memberPost) },
  { method: 'DELETE', path: '/api/studio/members/:id', name: 'studio.members.delete', handler: route(memberDelete) },
  { method: 'POST', path: '/api/studio/teams', name: 'studio.teams.post', handler: route(teamPost) },
  { method: 'DELETE', path: '/api/studio/teams/:id', name: 'studio.teams.delete', handler: route(teamDelete) },
  { method: 'POST', path: '/api/studio/import', name: 'studio.import', maxBodyBytes: 3_000_000, handler: route(importPost) },
  { method: 'GET', path: '/api/studio/jobs', name: 'studio.jobs.get', handler: route(jobsGet) },
  { method: 'POST', path: '/api/studio/jobs', name: 'studio.jobs.post', handler: route(jobsPost) },
  { method: 'GET', path: '/api/studio/jobs/:id/download', name: 'studio.jobs.download', handler: route(downloadGet) }
];

export default { name, priority, routes };
