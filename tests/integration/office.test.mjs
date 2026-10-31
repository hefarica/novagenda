/**
 * Tests de la Oficina (t13/t18): gate N0-N3, firma de aprobación, código N3,
 * ejecución única, 503 sin ejecutor, ejecutor document y ledger auditable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-office-');
const { store } = await importLib('lib/store.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

function proposalBody(overrides = {}) {
  return {
    kind: 'document',
    channel: 'document',
    subject: 'Documento QA',
    body: 'Borrador interno generado por la suite de QA.',
    attachments: ['qa.pdf'],
    meta: { source: 't20' },
    ...overrides
  };
}

async function createProposal(overrides) {
  const response = await api(app.base, 'POST', '/api/office/proposals', proposalBody(overrides));
  assert.equal(response.status, 201, response.text.slice(0, 300));
  return response.json;
}

test('gate: N2 sin aprobación no ejecuta (NOT_APPROVED)', async () => {
  const created = await createProposal();
  const id = created.item.id;
  const execute = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(execute.status, 409, execute.text);
  assert.equal(execute.json.code, 'NOT_APPROVED');
  const item = (await api(app.base, 'GET', `/api/office/proposals/${id}`)).json.item;
  assert.equal(item.status, 'pending');
});

test('gate: N2 aprobada ejecuta por canal document y no se ejecuta dos veces', async () => {
  const created = await createProposal();
  const id = created.item.id;
  const approve = await api(app.base, 'POST', `/api/office/proposals/${id}/approve`, { by: 'qa', note: 'ok' });
  assert.equal(approve.status, 200, approve.text.slice(0, 300));
  const execute = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(execute.status, 200, execute.text.slice(0, 300));
  assert.equal(execute.json.executed, true);
  assert.equal(execute.json.item.status, 'executed');
  const again = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'ALREADY_EXECUTED');
});

test('gate: N2 externa por email sin Gmail → 503 y sigue aprobada (no ejecutada)', async () => {
  const created = await createProposal({
    kind: 'email',
    channel: 'email',
    recipients: ['cliente@externo.com'],
    subject: 'Propuesta QA',
    body: 'Adjunto propuesta comercial.'
  });
  const id = created.item.id;
  assert.equal(created.level, 'N2', JSON.stringify(created.risk));
  const approve = await api(app.base, 'POST', `/api/office/proposals/${id}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  const execute = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(execute.status, 503, execute.text);
  assert.equal(execute.json.code, 'EXECUTOR_UNAVAILABLE');
  const item = (await api(app.base, 'GET', `/api/office/proposals/${id}`)).json.item;
  assert.equal(item.status, 'approved');
  assert.notEqual(item.status, 'executed');
  assert.notEqual(item.executed, true);
});

test('gate: N3 exige código correcto y ejecuta con el código', async () => {
  const created = await createProposal({
    kind: 'document',
    channel: 'document',
    subject: 'Contrato y pago',
    body: 'Pago de $5.000.000 según contrato legal revisado por el abogado.',
    attachments: ['contrato.pdf', 'anexo.pdf']
  });
  const id = created.item.id;
  assert.equal(created.level, 'N3', `level=${created.level} risk=${JSON.stringify(created.risk)}`);
  const approve = await api(app.base, 'POST', `/api/office/proposals/${id}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  const code = approve.json.code;
  assert.equal(typeof code, 'string', JSON.stringify(approve.json).slice(0, 200));
  const withoutCode = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(withoutCode.status, 400, withoutCode.text);
  assert.equal(withoutCode.json.code, 'CODE_REQUIRED');
  const wrong = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, { code: 'AAAAAA' });
  assert.equal(wrong.status, 409, wrong.text);
  assert.equal(wrong.json.code, 'INVALID_CODE');
  const execute = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, { code });
  assert.equal(execute.status, 200, execute.text.slice(0, 300));
  assert.equal(execute.json.item.status, 'executed');
});

test('gate: firma alterada → SIGNATURE_INVALID', async () => {
  const created = await createProposal();
  const id = created.item.id;
  const approve = await api(app.base, 'POST', `/api/office/proposals/${id}/approve`, { by: 'qa' });
  assert.equal(approve.status, 200, approve.text.slice(0, 200));
  await store.mutate((data) => {
    const proposal = (data.office?.proposals || []).find((item) => item.id === id);
    if (proposal) proposal.subject = 'Payload alterado tras la aprobación';
  });
  const execute = await api(app.base, 'POST', `/api/office/proposals/${id}/execute`, {});
  assert.equal(execute.status, 409, execute.text);
  assert.equal(execute.json.code, 'SIGNATURE_INVALID');
});

test('ledger: cadena verificada y manipulación detectada', async () => {
  const verify = await api(app.base, 'GET', '/api/office/ledger/verify');
  assert.equal(verify.status, 200, verify.text.slice(0, 200));
  assert.equal(verify.json.ok, true, JSON.stringify(verify.json).slice(0, 300));
  await store.mutate((data) => {
    const ledger = data.office?.ledger || [];
    if (ledger.length) ledger[0].hash = '0'.repeat(64);
  });
  const tampered = await api(app.base, 'GET', '/api/office/ledger/verify');
  assert.equal(tampered.status, 200);
  assert.equal(tampered.json.ok, false, JSON.stringify(tampered.json).slice(0, 300));
});
