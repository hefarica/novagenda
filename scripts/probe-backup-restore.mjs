import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-restore-'));
process.env.DATA_DIR = dir;
const { store } = await import('../lib/store.mjs');
const { validateBackupRestore } = await import('../lib/validate.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
await store.mutate((data) => { data.tasks = [{ id: 'T-UNO', title: 'Primera', done: false }]; }, { label: 'seed' });
const before = store.backupPayload({ includeSecrets: false });
check('La copia completa incluye datos y ajustes', Array.isArray(before.data?.agenda) && Boolean(before.data?.settings));
check('La copia sin secretos no expone vault', JSON.stringify(before.data?.secrets || {}) === '{}');
await store.mutate((data) => { data.secrets = { probe: 'vault-actual' }; data.googleConnections = [{ id: 'conexion-actual' }]; }, { label: 'secretos' });
await store.mutate((data) => { data.tasks.push({ id: 'T-DOS', title: 'Segunda', done: false }); }, { label: 'add' });
check('Antes de restaurar hay dos tareas', store.get().tasks.length === 2, String(store.get().tasks.length));
const result = await store.restore(before);
check('Restaura la copia', result.restored === true && store.get().tasks.length === 1, String(store.get().tasks.length));
check('Restaura el contenido exacto', store.get().tasks[0]?.title === 'Primera');
check('Conserva el vault si la copia no trae secretos', store.get().secrets?.probe === 'vault-actual' && result.preservedSecrets === true);
check('Conserva las conexiones Google actuales', store.get().googleConnections?.[0]?.id === 'conexion-actual');
const withSecrets = store.backupPayload();
await store.mutate((data) => { data.secrets = { probe: 'temporal' }; }, { label: 'temporal' });
const replaced = await store.restore(withSecrets);
check('Una copia con secretos sí los reemplaza', store.get().secrets?.probe === 'vault-actual' && replaced.preservedSecrets === false, String(replaced.preservedSecrets));
let invalid = null;
try { validateBackupRestore({ data: before.data }); } catch (error) { invalid = error; }
check('Exige confirmación RESTORE', invalid?.field === 'confirm');
let malformed = null;
try { await store.restore({ agenda: [] }); } catch (error) { malformed = error; }
check('Rechaza copia sin settings', malformed?.code === 'INVALID_BACKUP');
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;



