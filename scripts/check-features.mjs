#!/usr/bin/env node
/**
 * Autocheque de features (t48): Wave 0 en off por defecto, cambio auditado,
 * pausa/reanudación, kill switch y overrides por entorno.
 *
 * Usa DATA_DIR temporal siempre; nunca el dato real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-features-check-'));
}
process.env.NODE_ENV = 'test';
process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';

const { store } = await import('../lib/store.mjs');
const registry = await import('../lib/features/registry.mjs');

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`✖ ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const features = registry.listFeatures(store.get());
check('catálogo con 12 features', features.length === 12, `count=${features.length}`);
check('todas off por defecto', features.every((feature) => feature.mode === 'off' && feature.effectiveMode === 'off'), features.filter((feature) => feature.mode !== 'off').map((feature) => feature.id).join(','));

await registry.setMode('lingo', 'shadow', { by: 'selfcheck' });
check('setMode shadow persiste', registry.getMode('lingo', store.get()) === 'shadow', registry.getMode('lingo', store.get()));
const ledger = (store.get().office?.ledger || []).map((entry) => entry.action);
check('cambio auditado feature.change', ledger.includes('feature.change'), ledger.slice(-4).join(','));

await registry.pause('lingo', { by: 'selfcheck' });
let pausedCode = null;
try { registry.assertOn('lingo', store.get()); } catch (error) { pausedCode = error.code; }
check('pausa bloquea con FEATURE_PAUSED', pausedCode === 'FEATURE_PAUSED', String(pausedCode));
await registry.resume('lingo', { by: 'selfcheck' });
check('resume reactiva', registry.getMode('lingo', store.get()) === 'shadow', registry.getMode('lingo', store.get()));

await registry.pauseAll({ by: 'selfcheck' });
check('pause-all activa globalPaused', registry.featureSummary(store.get()).globalPaused === true, JSON.stringify(registry.featureSummary(store.get())));
await registry.resumeAll({ by: 'selfcheck' });
check('resume-all desactiva globalPaused', registry.featureSummary(store.get()).globalPaused === false);

process.env.FEATURE_LINGO = 'on';
check('override FEATURE_LINGO=on', registry.getMode('lingo', store.get()) === 'on', registry.getMode('lingo', store.get()));
delete process.env.FEATURE_LINGO;
process.env.FEATURES_KILLSWITCH = 'all';
check('kill switch global fuerza off', registry.getMode('lingo', store.get()) === 'off', registry.getMode('lingo', store.get()));
delete process.env.FEATURES_KILLSWITCH;

await registry.setMode('lingo', 'off', { by: 'selfcheck' });
check('restaurado a off', registry.getMode('lingo', store.get()) === 'off');

const total = passed + failures.length;
console.log(`\nSELFCHECK FEATURES: ${passed}/${total}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exitCode = failures.length ? 1 : 0;
