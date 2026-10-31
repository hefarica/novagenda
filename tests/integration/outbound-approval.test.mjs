/**
 * Contrato de salida con aprobación (t30): Gmail, canales y herramientas del
 * agente crean propuestas pending 202; nunca envían directo a terceros.
 * Incluye el ledger (created/approved/executed/email.direct_override).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-outbound-');
const { store } = await importLib('lib/store.mjs');
const { runTool } = await importLib('lib/agent/tools.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

function proposalCount() {
  return (store.get().office?.proposals || []).length;
}
function ledgerActions() {
  return (store.get().office?.ledger || []).map((entry) => String(entry.action || entry.type || ''));
}
function outboundMessages() {
  return (store.get().channelState?.messages || []).filter((message) => message?.direction === 'outbound');
}

test('gmail/send: 202 pending, nunca envía, y directo exige aprobación (403)', async () => {
  const before = proposalCount();
  const normal = await api(app.base, 'POST', '/api/gmail/send', {
    to: 'cliente@externo.com',
    subject: 'Propuesta QA',
    body: 'Cuerpo del correo de prueba.'
  });
  assert.equal(normal.status, 202, normal.text.slice(0, 300));
  assert.equal(normal.json.status, 'pending_approval');
  assert.equal(normal.json.message.includes('aprobación'), true, normal.text.slice(0, 200));
  assert.ok(normal.json.proposal?.id, normal.text.slice(0, 200));
  assert.ok(normal.json.proposal.level === 'N2' || normal.json.proposal.level === 'N3', `level=${normal.json.proposal.level}`);
  assert.ok(normal.json.approvalUrl.includes(normal.json.proposal.id));
  assert.equal(proposalCount(), before + 1);
  const proposal = await api(app.base, 'GET', `/api/office/proposals/${normal.json.proposal.id}`);
  assert.equal(proposal.json.item.status, 'pending');

  const direct = await api(app.base, 'POST', '/api/gmail/send', {
    to: 'cliente@externo.com', subject: 'Directo', body: 'No debe salir.', direct: true
  });
  assert.equal(direct.status, 403, direct.text.slice(0, 200));
  assert.equal(direct.json.code, 'APPROVAL_REQUIRED');
  assert.equal(proposalCount(), before + 1, 'el intento directo no debe crear propuesta');
  assert.equal(outboundMessages().length, 0, 'no debe haber ningún mensaje saliente');
});

test('gmail/send en modo total sigue naciendo pending (el gate manda)', async () => {
  const mode = await api(app.base, 'POST', '/api/office/mode', { mode: 'total' });
  assert.equal(mode.status, 200, mode.text.slice(0, 200));
  const sent = await api(app.base, 'POST', '/api/gmail/send', {
    to: 'cliente@externo.com', subject: 'Modo total', body: 'Debe quedar pendiente.'
  });
  assert.equal(sent.status, 202, sent.text.slice(0, 300));
  assert.equal(sent.json.status, 'pending_approval');
  const proposal = await api(app.base, 'GET', `/api/office/proposals/${sent.json.proposal.id}`);
  assert.equal(proposal.json.item.status, 'pending');
  await api(app.base, 'POST', '/api/office/mode', { mode: 'asistido' });
});

test('gmail/send: override directo permitido se audita como email.direct_override', async () => {
  await store.mutate((data) => {
    data.settings.office = { ...(data.settings.office || {}), allowDirectSend: true };
  });
  try {
    const direct = await api(app.base, 'POST', '/api/gmail/send', {
      to: 'cliente@externo.com', subject: 'Override', body: 'Auditado antes de enviar.', direct: true
    });
    // Sin Gmail conectado el envío falla, pero el override queda auditado ANTES.
    assert.ok([200, 502].includes(direct.status), direct.text.slice(0, 200));
    assert.ok(ledgerActions().includes('email.direct_override'), `ledger=${ledgerActions().slice(-5).join(',')}`);
  } finally {
    await store.mutate((data) => {
      data.settings.office = { ...(data.settings.office || {}), allowDirectSend: false };
    });
  }
});

test('canales: /send a email crea propuesta 202; sin Gmail el execute da 503 y sigue aprobada', async () => {
  const sent = await api(app.base, 'POST', '/api/channels/email/send', {
    to: 'cliente@externo.com',
    subject: 'Correo por canal',
    body: 'Mensaje que requiere aprobación.'
  });
  assert.equal(sent.status, 202, sent.text.slice(0, 300));
  const proposalId = sent.json.proposal.id;
  const approve = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  const execute = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
  assert.equal(execute.status, 503, execute.text.slice(0, 300));
  assert.equal(execute.json.code, 'EXECUTOR_UNAVAILABLE');
  const proposal = await api(app.base, 'GET', `/api/office/proposals/${proposalId}`);
  assert.equal(proposal.json.item.status, 'approved');
  assert.notEqual(proposal.json.item.executed, true);
});

test('herramientas del agente: crean propuesta pending y deniegan sin Oficina', async () => {
  const before = proposalCount();
  const tool = await runTool('enviar_correo', {
    to: 'cliente@externo.com',
    subject: 'Desde el agente',
    body: 'El agente no envía: propone.'
  }, { channel: 'web', userId: 'qa' });
  assert.equal(tool.ok, true, JSON.stringify(tool).slice(0, 400));
  assert.ok(tool.proposalId, JSON.stringify(tool).slice(0, 400));
  assert.equal(tool.proposal.status, 'pending', JSON.stringify(tool.proposal));
  assert.equal(proposalCount(), before + 1);

  const previous = process.env.OFFICE_ENABLED;
  process.env.OFFICE_ENABLED = 'off';
  try {
    const denied = await runTool('enviar_whatsapp', { to: '+573001112233', text: 'No debe salir' }, { channel: 'web', userId: 'qa' });
    assert.equal(denied.ok, false, JSON.stringify(denied).slice(0, 300));
    assert.match(String(denied.code || ''), /OFFICE_GATE_UNAVAILABLE|OFFICE_UNAVAILABLE/);
    assert.equal(proposalCount(), before + 1, 'no debe crear propuesta sin Oficina');
  } finally {
    if (previous === undefined) delete process.env.OFFICE_ENABLED;
    else process.env.OFFICE_ENABLED = previous;
  }
});

test('ledger: la propuesta ejecutada deja created/approved/executed', async () => {
  const sent = await api(app.base, 'POST', '/api/channels/simulator/send', {
    to: 'demo-owner', body: 'Ledger QA'
  });
  assert.equal(sent.status, 202, sent.text.slice(0, 200));
  const proposalId = sent.json.proposal.id;
  await api(app.base, 'POST', `/api/office/proposals/${proposalId}/approve`, { by: 'qa' });
  const execute = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
  assert.equal(execute.status, 200, execute.text.slice(0, 200));
  const actions = (store.get().office?.ledger || [])
    .filter((entry) => String(entry.payload?.proposalId || entry.proposalId || '') === proposalId || JSON.stringify(entry).includes(proposalId))
    .map((entry) => String(entry.action || ''));
  for (const expected of ['proposal.created', 'proposal.approved', 'proposal.executed']) {
    assert.ok(actions.includes(expected), `falta ${expected} para ${proposalId}: ${actions.join(',')}`);
  }
});

test('docs/:id/send-email sin Gmail: 503 EMAIL_NOT_CONFIGURED y no envía', async () => {
  const doc = await api(app.base, 'POST', '/api/docs', {
    type: 'docx', title: 'Correo QA', sections: [{ heading: 'X', paragraphs: ['Y'] }]
  });
  assert.equal(doc.status, 201, doc.text.slice(0, 200));
  const docId = doc.json.item?.id || doc.json.id;
  const outboundBefore = outboundMessages().length;
  const sent = await api(app.base, 'POST', `/api/docs/${docId}/send-email`, {
    to: 'cliente@externo.com', subject: 'Documento', body: 'Adjunto'
  });
  assert.equal(sent.status, 503, sent.text.slice(0, 200));
  assert.equal(sent.json.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal(outboundMessages().length, outboundBefore);
  await api(app.base, 'DELETE', `/api/docs/${docId}`);
});
