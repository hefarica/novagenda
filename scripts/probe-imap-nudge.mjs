/* Prueba: una bandeja IMAP con correo nuevo genera aviso; sin nuevos, no. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-imap-nudge-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';

const { collectCandidates } = await import('../lib/nudges/detect.mjs');
const { DEFAULT_CONFIG } = await import('../lib/nudges/config.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const now = new Date('2026-10-28T15:00:00.000Z');
const settings = { timezone: 'America/Bogota' };
const base = {
  settings, agenda: [], inbox: [], recurrences: [], meetings: [], metrics: [],
  office: { proposals: [] }, tasks: []
};

const conNuevos = await collectCandidates({
  data: { ...base, imapAccounts: [{ id: 'IMAP-1', label: 'Bandeja de Héctor', email: 'hector@test.local', newCount: 2 }] },
  settings, now, config: DEFAULT_CONFIG
});
const items = conNuevos.items.filter((item) => item.type === 'imap_new');
check('Detecta correo nuevo en una bandeja IMAP', items.length === 1 && items[0].count === 2, JSON.stringify(items[0] || {}).slice(0, 120));
check('El aviso nombra la bandeja', /Bandeja de Héctor/.test(items[0]?.title || ''), items[0]?.title);
check('El aviso conserva la cuenta', items[0]?.accountId === 'IMAP-1' && items[0]?.email === 'hector@test.local');

const sinNuevos = await collectCandidates({
  data: { ...base, imapAccounts: [{ id: 'IMAP-1', label: 'Bandeja', email: 'x@y.com', newCount: 0 }] },
  settings, now, config: DEFAULT_CONFIG
});
check('Sin correo nuevo no genera aviso', !sinNuevos.items.some((item) => item.type === 'imap_new'));

const sinCuentas = await collectCandidates({ data: base, settings, now, config: DEFAULT_CONFIG });
check('Sin bandejas no hay falsos avisos', !sinCuentas.items.some((item) => item.type === 'imap_new'));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
