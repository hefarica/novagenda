/* Prueba: revisar una propuesta pendiente recalcula riesgo y exige nueva aprobación. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-revise-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.APP_SECRET = 'revision-test-secret-0123456789abcdef';

const { createProposal, reviseProposal, approveProposal, getProposal } = await import('../lib/office/proposals.mjs');
const { store } = await import('../lib/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const created = await createProposal({
  input: {
    kind: 'email',
    channel: 'email',
    recipients: ['cliente@externo.test'],
    subject: 'Reunión del jueves',
    body: 'Hola Andrés, te confirmo la reunión del jueves a las 9.',
    attachments: [],
    meta: {}
  },
  actor: 'probe',
  useLlm: false,
  forceApproval: true
});
const id = created?.proposal?.id;
check('Crea propuesta pendiente', !!id && created.proposal.status === 'pending', JSON.stringify(created.proposal || {}).slice(0, 120));

const revised = await reviseProposal({
  id,
  subject: 'Reunión del jueves · confirmación',
  body: 'Hola Andrés, te confirmo la reunión del jueves. Adjunto el contrato y el acta; el anticipo es de $5 millones antes del viernes.',
  by: 'jefe'
});
check('Actualiza asunto y cuerpo', revised?.subject === 'Reunión del jueves · confirmación' && /contrato/.test(revised?.body || ''));
check('Recalcula el riesgo al alza', Number(revised?.risk?.score) > Number(created.proposal.risk?.score) && ['N2', 'N3'].includes(revised?.level), `riesgo ${created.proposal.risk?.score} → ${revised?.risk?.score} · ${revised?.level}`);
check('Guarda historial de la revisión', revised?.revisions?.length === 1 && revised.revisions[0].by === 'jefe', JSON.stringify(revised?.revisions || []).slice(0, 140));
check('Sigue pendiente de aprobación', revised?.status === 'pending' && !revised?.approval);

const ledger = (store.get().office?.ledger || []).filter((entry) => entry.action === 'propuesta.revisada');
check('La revisión queda en el ledger', ledger.length === 1 && ledger[0].payload?.proposalId === id, JSON.stringify(ledger[0]?.payload || {}).slice(0, 140));

let emptyError = null;
try { await reviseProposal({ id, body: '   ' }); } catch (error) { emptyError = error; }
check('Rechaza cuerpo vacío', !!emptyError && /cuerpo/i.test(emptyError.message));

await approveProposal({ id, by: 'jefe' });
let lateError = null;
try { await reviseProposal({ id, body: 'Cambio tardío' }); } catch (error) { lateError = error; }
check('No edita una propuesta ya aprobada', !!lateError && Number(lateError.status) === 409, lateError?.message);
check('La propuesta aprobada conserva su texto', /contrato/.test(getProposal(id)?.body || ''));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
