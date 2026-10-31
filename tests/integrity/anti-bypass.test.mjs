/**
 * Test anti-bypass (t30): la app no puede enviar directamente a terceros por
 * Gmail/WhatsApp/Telegram. Los únicos puntos autorizados son los ejecutores de
 * la Oficina (tras aprobación), los adaptadores internos de canal y el override
 * de Gmail explícitamente auditado.
 *
 * Falla si aparece una llamada/import de `sendGmail`, `sendWhatsApp` o
 * `sendTelegram` en un módulo no autorizado (por ejemplo, herramientas del
 * agente o una ruta nueva).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../helpers/env.mjs';

const LIB = path.join(repoRoot, 'lib');
const DIRECT_CALL = /\b(sendGmail|sendWhatsApp|sendTelegram)\s*\(/g;
const DIRECT_IMPORT = /import\s*\{[^}]*\b(sendGmail|sendWhatsApp|sendTelegram)\b[^}]*\}\s*from/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function scan(file, source) {
  const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
  const calls = [...source.matchAll(DIRECT_CALL)].map((match) => match[1]);
  const imports = [...source.matchAll(DIRECT_IMPORT)].map((match) => match[1]);
  return { relative, calls, imports };
}

/**
 * Archivos donde una llamada directa está justificada + marcadores que deben
 * estar presentes para considerar el archivo seguro:
 *  - google.mjs: definición de sendGmail.
 *  - channels.mjs: wrappers históricos.
 *  - channel/email.mjs y channel/executors.mjs: adaptador interno y ejecutores
 *    aprobados por la Oficina (solo invocados desde /execute).
 *  - office/executors.mjs: ejecutores nativos de la Oficina (post-aprobación).
 *  - routes/core.mjs: override directo de Gmail auditado (allowDirectSend +
 *    email.direct_override).
 *  - routes/channels.mjs: rutas heredadas de prueba, siempre con assertTestOwner.
 */
const ALLOWED = new Map([
  ['lib/google.mjs', []],
  ['lib/channels.mjs', []],
  ['lib/channel/email.mjs', []],
  ['lib/channel/executors.mjs', []],
  ['lib/office/executors.mjs', []],
  ['lib/routes/core.mjs', ['allowDirectSend()', 'auditDirectOverride(']],
  ['lib/routes/channels.mjs', ['assertTestOwner(', 'legacy.whatsapp-test', 'legacy.telegram-test']]
]);

test('anti-bypass: solo los módulos autorizados llaman a sendGmail/sendWhatsApp/sendTelegram', () => {
  const violations = [];
  const findings = [];
  for (const file of walk(LIB)) {
    const source = fs.readFileSync(file, 'utf8');
    const result = scan(file, source);
    if (!result.calls.length && !result.imports.length) continue;
    findings.push(result.relative);
    const markers = ALLOWED.get(result.relative);
    if (!markers) {
      violations.push(`${result.relative}: ${[...result.calls, ...result.imports].join(',')}`);
      continue;
    }
    for (const marker of markers) {
      if (!source.includes(marker)) violations.push(`${result.relative}: falta el marcador de seguridad «${marker}»`);
    }
  }
  assert.deepEqual(violations, [], `envíos directos fuera de los módulos aprobados: ${violations.join(' | ')}`);
  // Sanity: el escaneo ve al menos la definición y los ejecutores.
  assert.ok(findings.includes('lib/google.mjs'), 'el escáner no encontró la definición de sendGmail');
  assert.ok(findings.includes('lib/office/executors.mjs'), 'el escáner no encontró los ejecutores de la Oficina');
});

test('anti-bypass: el escáner detecta un módulo nuevo con envío directo (control negativo)', () => {
  const fakeFile = path.join(LIB, 'routes', 'bad-example.mjs');
  const fakeSource = "import { sendGmail } from '../google.mjs';\nawait sendGmail({ to: 'tercero@externo.com', subject: 'x', body: 'y' });\n";
  const result = scan(fakeFile, fakeSource);
  assert.ok(result.calls.includes('sendGmail'));
  assert.equal(ALLOWED.has('lib/routes/bad-example.mjs'), false);
});

test('anti-bypass: las rutas de canales/Gmail usan propuestas, no envíos directos', () => {
  const channels = fs.readFileSync(path.join(LIB, 'routes', 'channels.mjs'), 'utf8');
  assert.ok(channels.includes('createSendProposal'), 'la ruta /send debe crear propuesta');
  assert.ok(channels.includes('createSendDocumentProposal') || channels.includes('send-document'), 'send-document debe crear propuesta');
  // Las únicas llamadas directas permitidas son las rutas heredadas de prueba,
  // siempre precedidas de assertTestOwner (dueño/simulador).
  assert.ok(channels.includes('assertTestOwner('), 'las rutas legacy deben validar dueño');
  const legacyBlocks = channels.split(/path: '\/api\/(?:whatsapp|telegram)\/test'/).slice(1);
  assert.ok(legacyBlocks.length >= 2, 'faltan las rutas legacy de prueba');
  for (const block of legacyBlocks) {
    assert.ok(block.slice(0, 500).includes('assertTestOwner('), 'ruta legacy sin assertTestOwner');
  }

  const core = fs.readFileSync(path.join(LIB, 'routes', 'core.mjs'), 'utf8');
  assert.ok(core.includes('allowDirectSend()'), 'el override de Gmail debe comprobar allowDirectSend');
  assert.ok(core.includes('auditDirectOverride('), 'el override debe auditarse en el ledger');
  const outbound = fs.readFileSync(path.join(LIB, 'office', 'outbound.mjs'), 'utf8');
  assert.ok(outbound.includes("action: 'email.direct_override'"), 'falta la acción email.direct_override');
  // El correo normal responde 202 con propuesta.
  assert.match(core, /createOutboundEmailProposal/, 'gmail/send debe crear propuesta');
});

test('anti-bypass: las herramientas del agente no importan ni llaman a envíos directos', () => {
  const toolsDir = path.join(LIB, 'agent');
  for (const file of walk(toolsDir)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!DIRECT_CALL.test(source), `${path.basename(file)} llama a un envío directo`);
    DIRECT_CALL.lastIndex = 0;
    assert.ok(!DIRECT_IMPORT.test(source), `${path.basename(file)} importa un envío directo`);
    DIRECT_IMPORT.lastIndex = 0;
  }
});


