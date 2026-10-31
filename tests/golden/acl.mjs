/** Categoría F: ACL (10 casos). */
import { prepare, runCategory, assert, equal } from './harness.mjs';

prepare('golden-acl-');
const { store } = await import(new URL('../../lib/store.mjs', import.meta.url));
const acl = await import(new URL('../../lib/acl/index.mjs', import.meta.url));
const contextMod = await import(new URL('../../lib/acl/context.mjs', import.meta.url));

contextMod.setAclConfig({ ownDomains: ['empresa.com'] });
const data = () => store.get();
const docId = 'DOC-GOLDEN-1';

const cases = [
  {
    id: 'ACL-01', name: 'Etiquetar documento reservado y auditar',
    run: async () => {
      acl.setDocumentLabel(data(), docId, { label: 'reservado', by: 'golden' });
      equal(acl.effectiveLabel(data(), docId, 'document').label, 'reservado', 'label');
      const ledger = (data().acl?.ledger || []).map((entry) => entry.action);
      assert(ledger.includes('acl.change'), `ledger=${ledger.join(',')}`);
    }
  },
  {
    id: 'ACL-02', name: 'Público → N0 permitido',
    run: async () => {
      const decision = acl.decide({ label: 'público', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document' });
      equal(decision.allowed, true, 'allowed');
      equal(decision.level, 'N0', 'level');
      equal(decision.requiresConfirmation, false, 'requiresConfirmation');
    }
  },
  {
    id: 'ACL-03', name: 'Interno a externo → N2 con confirmación',
    run: async () => {
      const decision = acl.decide({ label: 'interno', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document' });
      equal(decision.allowed, true, 'allowed');
      equal(decision.level, 'N2', 'level');
      equal(decision.requiresConfirmation, true, 'requiresConfirmation');
    }
  },
  {
    id: 'ACL-04', name: 'Interno a interno → N1',
    run: async () => {
      const decision = acl.decide({ label: 'interno', channel: 'email', recipients: ['ana@empresa.com'], kind: 'document' });
      equal(decision.allowed, true, 'allowed');
      equal(decision.level, 'N1', 'level');
    }
  },
  {
    id: 'ACL-05', name: 'Reservado a externo sin confirmar → bloqueado N3',
    run: async () => {
      const decision = acl.decide({ label: 'reservado', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document' });
      equal(decision.allowed, false, 'allowed');
      equal(decision.level, 'N3', 'level');
      equal(decision.requiresConfirmation, true, 'requiresConfirmation');
    }
  },
  {
    id: 'ACL-06', name: 'Reservado a externo confirmado → permitido N3 con código',
    run: async () => {
      const decision = acl.decide({ label: 'reservado', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document', confirmedReserved: true });
      equal(decision.allowed, true, 'allowed');
      equal(decision.level, 'N3', 'level');
      equal(decision.requiresCode, true, 'requiresCode');
    }
  },
  {
    id: 'ACL-07', name: 'guardOutbound de documento reservado bloquea',
    run: async () => {
      const decision = acl.guardOutbound({ docId, channel: 'email', recipients: ['cliente@externo.com'], kind: 'document', data: data() });
      equal(decision.allowed, false, 'allowed');
      equal(decision.label, 'reservado', 'label');
    }
  },
  {
    id: 'ACL-08', name: 'docId manda sobre label explícito (anti-bypass)',
    run: async () => {
      const decision = acl.guardOutbound({ docId, label: 'público', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document', data: data() });
      equal(decision.label, 'reservado', 'label');
      equal(decision.labelSource, 'document', 'labelSource');
      equal(decision.allowed, false, 'allowed');
    }
  },
  {
    id: 'ACL-09', name: 'Defaults aplican a documentos sin etiqueta',
    run: async () => {
      acl.setDefaults(data(), { document: 'público' }, { by: 'golden' });
      const decision = acl.guardOutbound({ docId: 'DOC-SIN-ETIQUETA', channel: 'email', recipients: ['cliente@externo.com'], kind: 'document', data: data() });
      equal(decision.label, 'público', 'label por defecto');
      equal(decision.allowed, true, 'allowed');
      acl.setDefaults(data(), { document: 'interno' }, { by: 'golden' });
    }
  },
  {
    id: 'ACL-10', name: 'Matriz de política sin fugas reservado→externo',
    run: async () => {
      const matrix = acl.policyMatrix();
      equal(matrix.rules.length, 6, 'reglas');
      const leak = matrix.rules.find((rule) => rule.audience.includes('sin confirmar'));
      assert(leak && leak.allowed === false && leak.level === 'N3' && leak.requiresCode === true, JSON.stringify(leak));
    }
  }
];

await runCategory('acl', cases);

