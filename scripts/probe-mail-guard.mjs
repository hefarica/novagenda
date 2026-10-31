/* Prueba: reglas de correo y cuarentena revisable (sin enviar nada). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-mail-guard-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';

const {
  addRule, deleteRule, discardQuarantine, evaluateMessage, getQuarantine, holdMessage,
  listQuarantine, listRules, releaseQuarantine
} = await import('../lib/channel/mail-guard.mjs');
const { store } = await import('../lib/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const spamRule = await addRule({ field: 'from', match: 'domain', value: 'spam.test', action: 'quarantine' });
const invoiceRule = await addRule({ field: 'subject', match: 'contains', value: 'factura', action: 'skip' });
check('Crea reglas con ID estable', spamRule.id === 'MR-0001' && invoiceRule.id === 'MR-0002', `${spamRule.id} · ${invoiceRule.id}`);
check('Lista las reglas', listRules().length === 2);

const spamMessage = { uid: 21, from: { email: 'promo@spam.test' }, subject: 'Gana dinero' };
const verdict = evaluateMessage(spamMessage);
check('Retiene por dominio', verdict.action === 'quarantine' && verdict.ruleId === 'MR-0001', JSON.stringify(verdict));

const subdomain = evaluateMessage({ uid: 22, from: { email: 'x@sub.spam.test' }, subject: 'Hola' });
check('El dominio cubre subdominios', subdomain.action === 'quarantine', JSON.stringify(subdomain));

const invoice = evaluateMessage({ uid: 23, from: { email: 'proveedor@ok.test' }, subject: 'Factura 445 de octubre' });
check('Omite por asunto', invoice.action === 'skip' && invoice.ruleId === 'MR-0002', JSON.stringify(invoice));

const clean = evaluateMessage({ uid: 24, from: { email: 'andres@cliente.test' }, subject: 'Acta del predio' });
check('Un correo limpio pasa', clean.action === null);

let invalid = null;
try { await addRule({ field: 'from', match: 'contains', value: 'x', action: 'destruir' }); } catch (error) { invalid = error; }
check('Rechaza acción inválida', !!invalid && Number(invalid.status) === 400, invalid?.message);

const held = await holdMessage('IMAP-0001', spamMessage, verdict.reason);
check('Guarda el mensaje en cuarentena', held.id === 'Q-0001' && held.status === 'held', JSON.stringify(held).slice(0, 140));
const again = await holdMessage('IMAP-0001', spamMessage, verdict.reason);
check('No duplica la retención del mismo UID', again.id === held.id && listQuarantine({ status: 'held' }).total === 1);

const released = await releaseQuarantine(held.id);
check('Libera con marca de tiempo', released.status === 'released' && !!released.releasedAt);
check('Ya no aparece entre los retenidos', listQuarantine({ status: 'held' }).total === 0 && getQuarantine(held.id)?.status === 'released');

const second = await holdMessage('IMAP-0001', { ...spamMessage, uid: 25 }, verdict.reason);
const discarded = await discardQuarantine(second.id);
check('Descarta y conserva el registro', discarded.status === 'discarded' && !!discarded.discardedAt);

await deleteRule(spamRule.id);
check('Borra una regla', listRules().length === 1 && listRules()[0].id === 'MR-0002');
check('La regla borrada ya no retiene', evaluateMessage(spamMessage).action === null);
check('Persiste reglas y cuarentena', (store.get().mailRules?.rules || []).length === 1 && (store.get().quarantine?.items || []).length === 2);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
