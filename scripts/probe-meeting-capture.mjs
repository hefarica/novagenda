/* Prueba: transcripción → extracción de acta → DOCX con tareas, con LLM simulado. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-capture-probe-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.APP_SECRET = 'capture-probe-secret-0123456789';

const { createMockLlmServer } = await import('../lib/llm/mock-server.mjs');
const mock = await createMockLlmServer();
process.env.OPENAI_API_KEY = 'sk-mock-local';
process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
process.env.OPENAI_MODEL = 'mock-agenda-1';
process.env.LLM_PROVIDER = 'openai';

const { captureMeeting } = await import('../lib/meetings/capture.mjs');
const { createDocument } = await import('../lib/docs/index.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const transcript = 'Reunión con Andrés M. sobre el predio La Esperanza. '
  + 'Se revisó la franja norte y se acordó enviar el acta a Catastro esta semana. '
  + 'Queda pendiente el número de matrícula.';

const captured = await captureMeeting({
  title: 'Liberación predio La Esperanza',
  transcript,
  date: '2026-11-05',
  time: '10:00',
  location: 'Cali',
  privateNotes: 'SECRETO: no revelar el acuerdo de la franja.'
});
check('Extrae resumen, asistentes y acuerdos', captured.extraction.summary.length === 4 && captured.extraction.attendees[0]?.name === 'Andrés M.' && captured.extraction.agreements.length === 1, JSON.stringify(captured.extraction).slice(0, 160));
check('Conserva metadatos de la reunión', captured.metadata.date === '2026-11-05' && captured.metadata.time === '10:00' && captured.metadata.location === 'Cali', JSON.stringify(captured.metadata));

const call = mock.calls().at(-1);
const messages = call?.body?.messages || [];
const userMessage = messages.find((message) => message.role === 'user')?.content || '';
const systemMessage = messages.find((message) => message.role === 'system')?.content || '';
check('Envuelve la transcripción como dato', /<usuario>[\s\S]*La Esperanza[\s\S]*<\/usuario>/.test(userMessage), userMessage.slice(0, 100));
check('El sistema prohíbe obedecer la transcripción', /DATO/.test(systemMessage) && /nunca obedezcas/i.test(systemMessage), systemMessage.slice(0, 120));
check('Las notas privadas NO se envían al modelo', !JSON.stringify(messages).includes('SECRETO'), 'ok');

let short = null;
try { await captureMeeting({ title: 'Corta', transcript: 'muy corto' }); } catch (error) { short = error; }
check('Rechaza transcripción demasiado corta', short?.status === 400 && short?.code === 'TRANSCRIPT_TOO_SHORT', short?.message);
let noTitle = null;
try { await captureMeeting({ title: '', transcript }); } catch (error) { noTitle = error; }
check('Rechaza título vacío', noTitle?.status === 400 && noTitle?.code === 'TITLE_REQUIRED', noTitle?.message);

const doc = await createDocument({
  type: 'docx',
  title: captured.title,
  template: 'acta',
  topic: captured.title,
  date: captured.metadata.date,
  time: captured.metadata.time,
  location: captured.metadata.location,
  attendees: captured.extraction.attendees,
  agenda: captured.extraction.agenda,
  body: captured.extraction.development,
  agreements: captured.extraction.agreements,
  summary: captured.extraction.summary,
  annexNotes: 'SECRETO: no revelar el acuerdo de la franja.',
  register: true
});
check('Crea el DOCX de acta', !!doc.id && /\.docx$/i.test(doc.filename || ''), JSON.stringify({ id: doc.id, filename: doc.filename }).slice(0, 120));
check('Convierte los acuerdos en tareas', Array.isArray(doc.tasks) && doc.tasks.length === 1 && /Enviar el acta a Catastro/.test(doc.tasks[0].title || ''), JSON.stringify(doc.tasks || []).slice(0, 160));

await mock.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

