/* Prueba determinista de visibilidad de módulos. */
import { listModules, setModule, MODULE_KEYS } from '../lib/settings/modules.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const data = {};
const initial = listModules(data);
check('Todos visibles por defecto', initial.items.length === MODULE_KEYS.length && initial.items.every((item) => item.enabled));
const off = setModule(data, 'okr', false);
check('Oculta un módulo', off.enabled === false && listModules(data).modules.okr === false);
const ledger = data.office?.ledger || [];
check('Registra el cambio', ledger.some((entry) => entry.action === 'settings.change' && entry.payload?.key === 'okr'));
const on = setModule(data, 'okr', true);
check('Vuelve a mostrarlo', on.enabled === true && listModules(data).modules.okr === true);
let invalidKey = null;
try { setModule(data, 'noexiste', true); } catch (error) { invalidKey = error; }
check('Rechaza módulo inválido', invalidKey?.status === 400);
let invalidValue = null;
try { setModule(data, 'docs', 'sí'); } catch (error) { invalidValue = error; }
check('Rechaza enabled no booleano', invalidValue?.status === 400);
check('No toca otros módulos', listModules(data).modules.approvals === true && listModules(data).modules.base === true);
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
