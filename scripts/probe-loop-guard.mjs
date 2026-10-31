/* Prueba: loop guard (modos, duplicados, límite por destino y wrapper). */
import {
  evaluateOutbound, guardAdapter, loopGuardError, loopGuardStats, recordOutbound, resetLoopGuard
} from '../lib/guard/loop.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

resetLoopGuard();
const clean = evaluateOutbound({ channel: 'email', to: 'a@x.test', subject: 'Hola', text: 'Hola', mode: 'on' });
check('Sin historial no bloquea', clean.detected === false && clean.blocked === false);

recordOutbound({ channel: 'email', to: 'a@x.test', subject: 'Hola', text: 'Hola' });
recordOutbound({ channel: 'email', to: 'a@x.test', subject: 'Hola', text: 'Hola' });
const duplicate = evaluateOutbound({ channel: 'email', to: 'a@x.test', subject: 'Re: Hola', text: 'Hola', mode: 'on' });
check('Tercer idéntico se detecta', duplicate.detected === true && duplicate.blocked === true && duplicate.reason.code === 'DUPLICATE', JSON.stringify(duplicate.reason));
const shadow = evaluateOutbound({ channel: 'email', to: 'a@x.test', subject: 'Hola', text: 'Hola', mode: 'shadow' });
check('En sombra avisa pero no bloquea', shadow.wouldBlock === true && shadow.blocked === false);
const off = evaluateOutbound({ channel: 'email', to: 'a@x.test', subject: 'Hola', text: 'Hola', mode: 'off' });
check('En off solo observa', off.detected === true && off.blocked === false && off.wouldBlock === false);

resetLoopGuard();
const sent = [];
const adapter = {
  id: 'email',
  async send(input) { sent.push(input); return { id: `m${sent.length}` }; }
};
guardAdapter(adapter, { getMode: () => 'on' });
await adapter.send({ to: 'b@x.test', subject: 'Hola', text: 'Mismo cuerpo' });
await adapter.send({ to: 'b@x.test', subject: 'Hola', text: 'Mismo cuerpo' });
let blockedError = null;
try { await adapter.send({ to: 'b@x.test', subject: 'Hola', text: 'Mismo cuerpo' }); } catch (error) { blockedError = error; }
check('El wrapper bloquea el tercer envío', blockedError?.code === 'LOOP_GUARD' && sent.length === 2, `${blockedError?.code} · enviados ${sent.length}`);
await adapter.send({ to: 'c@x.test', subject: 'Hola', text: 'Mismo cuerpo' });
check('Otro destino no se bloquea', sent.length === 3);

const failed = { id: 'email', async send() { throw new Error('fallo de red'); } };
guardAdapter(failed, { getMode: () => 'on' });
try { await failed.send({ to: 'd@x.test', text: 'Hola' }); } catch { /* esperado */ }
const afterFailure = loopGuardStats();
check('Un fallo no se registra', afterFailure.recorded === 3, `registrados ${afterFailure.recorded}`);

resetLoopGuard();
const skipped = { id: 'telegram', async send() { return { skipped: true }; } };
guardAdapter(skipped, { getMode: () => 'on' });
await skipped.send({ to: 'chat', text: 'Hola' });
check('Un omitido no se registra', loopGuardStats().recorded === 0);

resetLoopGuard();
for (let index = 0; index < 20; index += 1) {
  recordOutbound({ channel: 'telegram', to: 'chat-1', subject: `Aviso ${index}`, text: `Cuerpo distinto ${index}` });
}
const rate = evaluateOutbound({ channel: 'telegram', to: 'chat-1', subject: 'Nuevo', text: 'Otro', mode: 'on' });
check('Limita el volumen por destino', rate.detected === true && rate.reason.code === 'RATE', JSON.stringify(rate.reason));
const error = loopGuardError(rate);
check('El error explica el motivo', error.status === 429 && /Loop guard/.test(error.message), error.message);

const failedTests = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failedTests.length ? `${failedTests.length} fallo(s)` : 'PASS'}`);
process.exitCode = failedTests.length ? 1 : 0;
