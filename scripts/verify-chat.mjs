/* Prueba el chat del agente de verdad: conversación natural + comandos intactos.
   Uso: node --env-file=.env scripts/verify-chat.mjs
   Usa DATA_DIR temporal (nunca toca data/ real) y no abre puerto. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-chat-'));
process.env.DATA_DIR = dir;
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.NODE_ENV = 'test';

const { handleAgentChat } = await import('../lib/agent/agent.mjs');

let failures = 0;
const rows = [];
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  rows.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const ask = (text) => handleAgentChat({ text, channel: 'web', userId: 'verify-chat' });
const flat = (r) => `${r.reply || ''} ${r.source || ''} ${r.provider || ''}`.toLowerCase();

try {
  // 1. Saludo + hora: respuesta natural, no un volcado de agenda.
  const greeting = await ask('hola que hora es?');
  const gText = String(greeting.reply || '');
  check('Saludo/hora responde en lenguaje natural', gText.length >= 25 && /son las|hoy es|hola|buenas/i.test(gText), gText.slice(0, 140));
  check('Saludo/hora NO vuelca la agenda', !/carga:|foco:|riesgos:|traza|list_day/i.test(gText), gText.slice(0, 140));
  check('Saludo/hora reporta fuente y proveedor', greeting.source === 'llm' ? Boolean(greeting.provider) : greeting.source === 'deterministic', `source=${greeting.source} provider=${greeting.provider || '-'}`);

  // 2. Capacidades.
  const caps = await ask('¿qué puedes hacer?');
  check('Capacidades responde con lenguaje natural', /puedo|agendar|ayud/i.test(String(caps.reply || '')), String(caps.reply || '').slice(0, 140));

  // 3. Fecha.
  const date = await ask('¿qué día es hoy?');
  check('Fecha responde sin inventar', /hoy es|mié|jue|vie|lun|mar|sáb|dom|oct|nov/i.test(String(date.reply || '')), String(date.reply || '').slice(0, 120));

  // 4. Comando determinista intacto: HOY.
  const hoy = await ask('HOY');
  check('Comando HOY sigue siendo determinista', /agenda copilot|hoy|top 3/i.test(String(hoy.reply || '')) && hoy.source === 'deterministic', String(hoy.reply || '').slice(0, 100));

  // 5. Agendar sigue funcionando (confirmación, sin ejecutar a ciegas).
  const booking = await ask('agenda una reunión mañana a las 10:00 con Ana');
  check('Instrucción de agenda entra al motor (no charla)', booking.intent?.action !== undefined || booking.pending !== null || /agenda|reunión|reunion|confirm/i.test(String(booking.reply || '')), `action=${booking.intent?.action || '-'} pending=${Boolean(booking.pending)}`);

  // 6. Gracias.
  const thanks = await ask('muchas gracias');
  check('Agradecimiento responde natural', /gusto|con gusto|de nada|a la orden/i.test(String(thanks.reply || '')), String(thanks.reply || '').slice(0, 120));

  // 7. No se confunde: consulta del día sigue dando resumen.
  const day = await ask('¿qué tengo hoy?');
  check('Consulta del día responde con el plan', String(day.reply || '').length > 20, String(day.reply || '').slice(0, 120));

  // 8. Equipo interno: un correo reúne a Correspondencia y QA.
  const email = await ask('prepara un correo a ana@empresa.com con asunto Acta y texto: adjunto el acta del predio para su revisión');
  const teamRoles = (email.meta?.team?.roles || []).map((role) => role.role);
  check('Correo consulta al equipo', Boolean(email.meta?.team?.consulted), JSON.stringify(email.meta?.team?.risk || null));
  check('Equipo incluye Correspondencia y QA', teamRoles.includes('correspondencia') && teamRoles.includes('qa'), teamRoles.join(','));
  check('La respuesta menciona al equipo', /equipo:/i.test(String(email.reply || '')), String(email.reply || '').slice(-90));

  // 9. Equipo interno: una cita reúne a Agenda (franja distinta para no chocar).
  const meet = await ask('agenda una reunión pasado mañana a las 15:00 con Ana');
  const meetRoles = (meet.meta?.team?.roles || []).map((role) => role.role);
  check('Cita consulta a Agenda', meetRoles.includes('agenda'), meetRoles.join(',') || 'sin equipo');

  // 10. Charla simple no añade ruido de equipo.
  check('Charla simple sin ruido de equipo', !greeting.meta?.team, 'sin meta.team');
} finally {
  console.log(`\nRESUMEN: ${rows.length - failures}/${rows.length} PASS`);
  if (failures) console.log('FALLOS:', rows.filter((r) => !r.ok).map((r) => r.name).join(' | '));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignorar */ }
  process.exit(failures ? 1 : 0);
}
