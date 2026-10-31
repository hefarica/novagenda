/** Categoría A: aprobaciones (10 casos). */
import { prepare, runCategory, assert, equal, expectHttpError } from './harness.mjs';

prepare('golden-approvals-');
const { store } = await import(new URL('../../lib/store.mjs', import.meta.url));
const office = await import(new URL('../../lib/office/index.mjs', import.meta.url));
const { verifyLedger } = await import(new URL('../../lib/office/ledger.mjs', import.meta.url));

const create = (input) => office.createProposal({ input, useLlm: false });

const emailProposal = () => create({
  kind: 'email', channel: 'email', recipients: ['cliente@externo.com'],
  subject: 'Golden email', body: 'Cuerpo del correo de prueba.'
});
const docProposal = () => create({
  kind: 'document', channel: 'document', subject: 'Golden doc',
  body: 'Borrador interno.', attachments: ['golden.pdf']
});
const n3Proposal = () => create({
  kind: 'document', channel: 'document', subject: 'Contrato y pago',
  body: 'Pago de $5.000.000 según contrato legal.', attachments: ['contrato.pdf', 'anexo.pdf']
});

const cases = [
  {
    id: 'AP-01', name: 'Propuesta email externa nace N2 pending',
    run: async () => {
      const result = await emailProposal();
      equal(result.proposal.level, 'N2', 'level');
      equal(result.proposal.status, 'pending', 'status');
      assert(result.proposal.id, 'sin id');
    }
  },
  {
    id: 'AP-02', name: 'Execute sin aprobar → 409 NOT_APPROVED',
    run: async () => {
      const result = await emailProposal();
      await expectHttpError(() => office.executeProposal({ id: result.proposal.id }), { status: 409, code: 'NOT_APPROVED' });
    }
  },
  {
    id: 'AP-03', name: 'Aprobar N2 cambia a approved',
    run: async () => {
      const result = await emailProposal();
      const approved = await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      equal(approved.proposal.status, 'approved', 'status');
      assert(approved.approval, 'sin approval');
    }
  },
  {
    id: 'AP-04', name: 'Email sin Gmail → 503 EXECUTOR_UNAVAILABLE y sigue approved',
    run: async () => {
      const result = await emailProposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      await expectHttpError(() => office.executeProposal({ id: result.proposal.id }), { status: 503, code: 'EXECUTOR_UNAVAILABLE' });
      const proposal = (store.get().office.proposals || []).find((item) => item.id === result.proposal.id);
      equal(proposal.status, 'approved', 'status tras 503');
    }
  },
  {
    id: 'AP-05', name: 'Documento N2: approve + execute ejecuta una vez',
    run: async () => {
      const result = await docProposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      const executed = await office.executeProposal({ id: result.proposal.id });
      equal(executed.proposal.status, 'executed', 'status');
    }
  },
  {
    id: 'AP-06', name: 'Segundo execute → 409 ALREADY_EXECUTED',
    run: async () => {
      const result = await docProposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      await office.executeProposal({ id: result.proposal.id });
      await expectHttpError(() => office.executeProposal({ id: result.proposal.id }), { status: 409, code: 'ALREADY_EXECUTED' });
    }
  },
  {
    id: 'AP-07', name: 'N3 nace pending y approve devuelve código de 6',
    run: async () => {
      const result = await n3Proposal();
      equal(result.proposal.level, 'N3', 'level');
      const approved = await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      assert(typeof approved.code === 'string' && approved.code.length === 6, `code=${approved.code}`);
    }
  },
  {
    id: 'AP-08', name: 'N3 execute sin código → 400 CODE_REQUIRED',
    run: async () => {
      const result = await n3Proposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      await expectHttpError(() => office.executeProposal({ id: result.proposal.id }), { status: 400, code: 'CODE_REQUIRED' });
    }
  },
  {
    id: 'AP-09', name: 'N3 código incorrecto → 409 INVALID_CODE',
    run: async () => {
      const result = await n3Proposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      await expectHttpError(() => office.executeProposal({ id: result.proposal.id, code: 'AAAAAA' }), { status: 409, code: 'INVALID_CODE' });
    }
  },
  {
    id: 'AP-10', name: 'Ledger íntegro con created/approved/executed',
    run: async () => {
      const result = await docProposal();
      await office.approveProposal({ id: result.proposal.id, by: 'golden' });
      await office.executeProposal({ id: result.proposal.id });
      const ledger = store.get().office.ledger || [];
      const actions = ledger.map((entry) => entry.action);
      for (const expected of ['proposal.created', 'proposal.approved', 'proposal.executed']) {
        assert(actions.includes(expected), `falta ${expected}`);
      }
      equal(verifyLedger(store.get()).ok, true, 'ledger verify');
    }
  }
];

await runCategory('approvals', cases);
