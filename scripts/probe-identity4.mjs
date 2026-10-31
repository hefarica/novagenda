/* Prueba: 2 personas × 2 correos → 4 destinos en la propuesta (sin enviar). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-4dest-'));
process.env.WORKFLOWS_AUTOSTART = '0';
const results = [];

const { store } = await import('../lib/store.mjs');
const { createDocument } = await import('../lib/docs/index.mjs');
const { createOutboundService } = await import('../lib/channel/outbound.mjs');

await store.mutate((data) => {
  data.identity = {
    contacts: [
      { name: 'Ana Torres', emails: ['ana.torres@example.com', 'atorres@empresa.com'], note: 'prueba' },
      { name: 'Luis Gómez', emails: ['luis.gomez@example.com', 'lgomez@empresa.com'], note: 'prueba' }
    ]
  };
  data.settings = { ...(data.settings || {}), office: { ...(data.settings?.office || {}), mode: 'asistido' } };
});

const registry = {
  get(channel) {
    if (!['email', 'whatsapp', 'telegram', 'simulator'].includes(channel)) return null;
    return { id: channel, status: () => ({ configured: true }), send: async () => ({ ok: true }) };
  }
};
const svc = createOutboundService({ registry });
const doc = await createDocument({
  type: 'docx',
  template: 'acta',
  title: 'Acta de liberación',
  date: '2026-10-28',
  author: 'Héctor Fabio Riascos C.',
  attendees: ['Ana Torres', 'Luis Gómez'],
  agenda: ['Revisar el predio', 'Firmar el acta'],
  agreements: [{ text: 'Entregar el acta', owner: 'Héctor', due: '2026-10-30', status: 'Pendiente' }],
  summary: ['Resumen uno.', 'Resumen dos.', 'Resumen tres.', 'Resumen cuatro.'],
  annexNotes: ['Nota privada.'],
  body: 'Se revisó el estado del predio.'
});
console.log('doc:', doc.id, doc.filename);

const result = await svc.createDocumentProposal({
  docId: doc.id,
  channel: 'email',
  to: ['Ana Torres', 'Luis Gómez'],
  subject: 'Acta de liberación',
  caption: 'Adjunto el acta para su revisión.'
});
const recipients = result.proposal?.recipients || [];
console.log('estado:', result.proposal?.status);
console.log('destinatarios(', recipients.length, '):', recipients.join(', '));
const unique = new Set(recipients.map((email) => email.toLowerCase()));
const ok4 = recipients.length === 4 && unique.size === 4;
results.push(['4 destinos únicos', ok4]);
console.log('únicos:', unique.size, '| 4 esperados:', ok4 ? 'PASS' : 'FAIL');

// Nombre ambiguo: debe pedir confirmación (409), no adivinar.
await store.mutate((data) => {
  data.identity.contacts.push({ name: 'Ana María Ruiz', emails: ['ana.ruiz@example.com'], note: 'prueba' });
});
try {
  await svc.createDocumentProposal({ docId: doc.id, channel: 'email', to: ['Ana'], subject: 'x', caption: 'y' });
  results.push(['ambiguo pide confirmación', false]);
  console.log('ambiguo: FAIL (creó propuesta)');
} catch (error) {
  const ok = error.status === 409 && error.code === 'IDENTITY_CONFIRMATION_REQUIRED';
  results.push(['ambiguo pide confirmación', ok]);
  console.log('ambiguo:', ok ? 'PASS' : `FAIL (${error.code || error.message})`);
}

// WhatsApp no expande teléfonos/nombres como correo.
try {
  const wa = await svc.createSendProposal({ channel: 'whatsapp', to: ['+573001112233'], body: 'hola' });
  const ok = wa.proposal?.recipients?.join(',') === '+573001112233';
  results.push(['whatsapp no expande', ok]);
  console.log('whatsapp:', ok ? 'PASS' : 'FAIL');
} catch (error) {
  results.push(['whatsapp no expande', false]);
  console.log('whatsapp:', `FAIL (${error.code || error.message})`);
}




const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
