/**
 * Tests de aprobaciones por canal (t18): tarjeta al simulador, aprobación con
 * "1", rechazo de remitente no autorizado, propuesta ya decidida y entrega de
 * documentos como adjunto por el simulador.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-approvals-');
const { store } = await importLib('lib/store.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

/** Mensajes salientes reales asociados a una propuesta ejecutada (efectos, no logs). */
function approvalMessages(proposalId) {
  return (store.get().channelState?.messages || []).filter(
    (message) => message?.direction === 'outbound' && message?.meta?.proposalId === proposalId
  );
}

async function createN2Proposal(subject) {
  const created = await api(app.base, 'POST', '/api/office/proposals', {
    kind: 'email',
    channel: 'email',
    recipients: ['cliente@externo.com'],
    subject,
    body: 'Cuerpo de la propuesta de prueba.',
    attachments: ['adjunto.pdf']
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  return created.json.item.id;
}

test('aprobaciones: configurar simulador, enviar tarjeta y aprobar con "1"', async () => {
  const config = await api(app.base, 'POST', '/api/channels/approvals/config', {
    preferredChannel: 'simulator',
    simulatorTarget: 'demo-owner',
    owners: { simulator: ['demo-owner'] }
  });
  assert.equal(config.status, 200, config.text.slice(0, 300));

  const proposalId = await createN2Proposal('Aprobación simulador');
  const sent = await api(app.base, 'POST', `/api/channels/approvals/${proposalId}/send`, { channel: 'simulator' });
  assert.equal(sent.status, 200, sent.text.slice(0, 300));
  assert.equal(sent.json.ok, true);
  assert.equal(sent.json.proposalId, proposalId);

  const approve = await api(app.base, 'POST', '/api/channels/simulate', { text: '1', userId: 'demo-owner' });
  assert.equal(approve.status, 200, approve.text.slice(0, 300));
  const item = (await api(app.base, 'GET', `/api/office/proposals/${proposalId}`)).json.item;
  assert.equal(item.status, 'approved', JSON.stringify(item).slice(0, 300));

  const decided = await api(app.base, 'POST', '/api/channels/simulate', { text: '1', userId: 'demo-owner' });
  assert.equal(decided.status, 200, decided.text.slice(0, 200));
  const still = (await api(app.base, 'GET', `/api/office/proposals/${proposalId}`)).json.item;
  assert.equal(still.status, 'approved');
});

test('aprobaciones: remitente no autorizado no decide y queda auditado', async () => {
  const proposalId = await createN2Proposal('Aprobación no autorizada');
  const sent = await api(app.base, 'POST', `/api/channels/approvals/${proposalId}/send`, { channel: 'simulator' });
  assert.equal(sent.status, 200, sent.text.slice(0, 200));
  const denied = await api(app.base, 'POST', '/api/channels/simulate', { text: `ok ${proposalId}`, userId: 'intruso' });
  assert.equal(denied.status, 200, denied.text.slice(0, 200));
  assert.match(String(denied.json.reply || ''), /no autorizado/i, denied.text.slice(0, 200));
  const item = (await api(app.base, 'GET', `/api/office/proposals/${proposalId}`)).json.item;
  assert.equal(item.status, 'pending');

  const ledger = await api(app.base, 'GET', '/api/office/ledger?limit=100');
  assert.equal(ledger.status, 200);
  assert.ok((ledger.json.items || []).some((entry) => String(entry.type || entry.action || '').includes('approval_denied')), 'sin evento approval_denied');
});

test('aprobaciones: documento DOCX como adjunto crea propuesta y se envía una vez al ejecutar', async () => {
  const doc = await api(app.base, 'POST', '/api/docs', {
    type: 'docx',
    title: 'Adjunto QA',
    sections: [{ heading: 'Resumen', paragraphs: ['Documento enviado por el simulador.'] }]
  });
  assert.equal(doc.status, 201, doc.text.slice(0, 300));
  const docId = doc.json.item?.id || doc.json.id;
  const sent = await api(app.base, 'POST', '/api/channels/send-document', {
    docId,
    channel: 'simulator',
    to: 'demo-owner'
  });
  assert.equal(sent.status, 202, sent.text.slice(0, 300));
  assert.equal(sent.json.status, 'pending_approval');
  const proposalId = sent.json.proposal.id;
  assert.ok(proposalId, JSON.stringify(sent.json).slice(0, 200));
  assert.equal(approvalMessages(proposalId).length, 0, 'no debe enviar antes de aprobar/ejecutar');

  const approve = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  const execute = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
  assert.equal(execute.status, 200, execute.text.slice(0, 300));
  assert.equal(approvalMessages(proposalId).length, 1, 'debe enviarse exactamente una vez');
  assert.ok(approvalMessages(proposalId)[0].meta?.document === true, 'el adjunto no se registró');

  const again = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
  assert.equal(again.status, 409, again.text.slice(0, 200));
  assert.equal(again.json.code, 'ALREADY_EXECUTED');
  assert.equal(approvalMessages(proposalId).length, 1);
  await api(app.base, 'DELETE', `/api/docs/${docId}`);
});

test('aprobaciones: canal /send crea propuesta 202 y ejecuta un solo envío', async () => {
  const sent = await api(app.base, 'POST', '/api/channels/simulator/send', {
    to: 'demo-owner',
    body: 'Mensaje aprobado de prueba'
  });
  assert.equal(sent.status, 202, sent.text.slice(0, 300));
  assert.equal(sent.json.status, 'pending_approval');
  assert.equal(sent.json.approvalRequired, true);
  const proposalId = sent.json.proposal.id;
  assert.equal(approvalMessages(proposalId).length, 0);

  const approve = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  const execute = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
  assert.equal(execute.status, 200, execute.text.slice(0, 300));
  assert.equal(approvalMessages(proposalId).length, 1);
  assert.equal(approvalMessages(proposalId)[0].text, 'Mensaje aprobado de prueba');
});

test('aprobaciones: test de canal limita a dueño/simulador y tercero es 403 NOT_OWNER', async () => {
  const owners = await api(app.base, 'POST', '/api/channels/approvals/config', {
    owners: { telegram: ['owner-chat'], simulator: ['demo-owner'] }
  });
  assert.equal(owners.status, 200, owners.text.slice(0, 200));

  const simulator = await api(app.base, 'POST', '/api/channels/simulator/test', { to: 'tercero' });
  assert.equal(simulator.status, 200, simulator.text.slice(0, 200));

  const thirdParty = await api(app.base, 'POST', '/api/channels/telegram/test', { chatId: 'tercero-999' });
  assert.equal(thirdParty.status, 403, thirdParty.text.slice(0, 200));
  assert.equal(thirdParty.json.code, 'NOT_OWNER');
  assert.ok(thirdParty.json.details?.listField, 'sin details.listField');

  const owner = await api(app.base, 'POST', '/api/channels/telegram/test', { chatId: 'owner-chat' });
  assert.notEqual(owner.status, 403, owner.text.slice(0, 200));
});

