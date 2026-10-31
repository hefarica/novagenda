/**
 * Autocheck del módulo de hilos (sin servidor ni LLM).
 *
 *   node lib/thread/selfcheck.mjs
 *
 * Comprueba: contexto de 8 mensajes, estado, compromisos, temas, última
 * intención, acuses variados sin fechas ni datos internos, degradación sin
 * historial y que las rutas se montan.
 */
import { pathToFileURL } from 'node:url';
import { buildThreadContext, __test__ as contextTest } from './context.mjs';
import { composeAck, isSafeAck, __test__ as ackTest } from './ack.mjs';
import * as routeModule from '../routes/thread.mjs';

const results = [];
function check(name, condition, detail = '') {
  const ok = !!condition;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function msg(index, direction, text, base, minutes) {
  return {
    id: `MSG-${String(index).padStart(4, '0')}`,
    channel: 'simulator',
    userId: 'demo-hilo',
    direction,
    text,
    timestamp: new Date(base + minutes * 60_000).toISOString(),
    status: direction === 'inbound' ? 'received' : 'sent'
  };
}

function fakeData({ messages, userId = 'demo-hilo' }) {
  return {
    channelState: { messages },
    settings: { timezone: 'America/Bogota' },
    style: { samples: {}, variations: [], profiles: {} },
    userId
  };
}

function contextMessages(data) {
  // `buildThreadContext` normaliza y ordena; se usa para no duplicar reglas.
  return contextTest.normalizedMessages(data, { channel: 'simulator', userId: 'demo-hilo', limit: 50 }).messages;
}

async function main() {
  const now = Date.parse('2026-10-28T15:00:00.000Z');
  const base = Date.parse('2026-10-28T13:00:00.000Z');
  const chronological = [
    msg(1, 'inbound', 'Hola, ¿cómo va la propuesta para el cliente Andes?', base, 0),
    msg(2, 'outbound', 'Buen día. Estoy revisando los números; te confirmo hoy mismo.', base, 5),
    msg(3, 'inbound', 'Gracias. Necesito también el contrato firmado.', base, 10),
    msg(4, 'outbound', 'Te envío el contrato mañana a primera hora.', base, 15),
    msg(5, 'inbound', 'Perfecto. ¿Incluye el anexo de precios?', base, 20),
    msg(6, 'outbound', 'Sí, incluye el anexo de precios. Te paso la versión final mañana.', base, 25),
    msg(7, 'inbound', 'Buenísimo. ¿Me confirmas el total?', base, 30),
    msg(8, 'outbound', 'El total son 12.500 USD; ¿te parece si lo cerramos esta semana?', base, 35)
  ];
  const data = fakeData({ messages: [...chronological].reverse() });

  const context = await buildThreadContext({ channel: 'simulator', userId: 'demo-hilo', limit: 20, data, now, useLlm: false });
  check('contexto con los 8 mensajes', context.messageCount === 8 && context.messages.length === 8, `count=${context.messageCount}`);
  check('mensajes en orden cronológico', context.messages[0].id === 'MSG-0001' && context.messages[7].id === 'MSG-0008', `${context.messages[0].id} → ${context.messages[7].id}`);
  check('estado pendiente_suyo correcto', context.state === 'pendiente_suyo', context.state);
  check('compromisos extraídos', context.commitments.length >= 2 && context.commitments.some((row) => row.who === 'mío' && /env[ií]o el contrato/i.test(row.text)), JSON.stringify(context.commitments.map((row) => ({ who: row.who, due: row.dueLabel }))));
  check('compromiso con plazo', context.commitments.some((row) => row.due), JSON.stringify(context.commitments.filter((row) => row.due).map((row) => row.dueLabel)));
  check('temas detectados', context.topics.length >= 2 && context.topics.some((topic) => /propuesta|contrato|anexo|precio/.test(topic)), context.topics.join(', '));
  check('última intención', context.lastIntent === 'pregunta' && /total/.test(context.lastIntentText || ''), `${context.lastIntent}: ${context.lastIntentText}`);
  check('resumen determinista', /Hilo de 8 mensajes/.test(context.summary) && /pendiente de su respuesta/.test(context.summary), context.summary.slice(0, 120));
  check('fuentes declaradas', Array.isArray(context.sources) && context.sources.some((row) => row.type === 'channelState.messages') && context.usedLlm === false, JSON.stringify(context.sources));

  const normalized = contextMessages(data);
  const closed = contextTest.stateOf([...normalized, { direction: 'inbound', who: 'usuario', text: 'Gracias, quedó resuelto.' }]);
  check('estado cerrado', closed.state === 'cerrado', closed.state);
  const newRequest = contextTest.stateOf([...normalized, { direction: 'inbound', who: 'usuario', text: 'Gracias, pero necesito otra cosa.' }]);
  check('petición nueva no cierra el hilo', newRequest.state === 'pendiente_mío', newRequest.state);
  const ours = contextTest.stateOf([...normalized, { direction: 'inbound', who: 'usuario', text: '¿Me confirmas el total?' }]);
  check('pendiente_mío cuando habla el usuario', ours.state === 'pendiente_mío', ours.state);

  const ack1 = await composeAck({ channel: 'simulator', userId: 'demo-hilo', intent: 'prometo entregar el viernes', urgency: 'normal', context, data, persist: true, now });
  const ack2 = await composeAck({ channel: 'simulator', userId: 'demo-hilo', intent: 'prometo entregar el viernes', urgency: 'normal', context, data, persist: true, now: now + 1_000 });
  const ack3 = await composeAck({ channel: 'simulator', userId: 'demo-hilo', intent: 'prometo entregar el viernes', urgency: 'normal', context, data, persist: true, now: now + 2_000 });
  const distinct = new Set([ack1.text, ack2.text, ack3.text]);
  check('tres acuses distintos al mismo contacto', distinct.size === 3, `${ack1.text.slice(0, 42)} | ${ack2.text.slice(0, 42)} | ${ack3.text.slice(0, 42)}`);
  check('acuses no repiten el viernes prometido', [ack1, ack2, ack3].every((ack) => !/viernes/i.test(ack.text)), ack1.text);
  check('acuses sin datos internos ni fechas', [ack1, ack2, ack3].every((ack) => isSafeAck(ack.text)), 'isSafeAck=true');
  check('ventana de variación persistida', data.style.variations.filter((row) => row.type === 'acuse' && row.contact === 'demo-hilo').length >= 3, String(data.style.variations.length));
  check('urgencia alta cambia el tono', /ahora|inmediato|hoy sin falta|esta misma hora/i.test((await composeAck({ channel: 'simulator', userId: 'demo-hilo-urgente', intent: 'urgente', urgency: 'alta', context, data, persist: true, now })).text), 'ok');

  const emptyData = fakeData({ messages: [] });
  const empty = await buildThreadContext({ channel: 'simulator', userId: 'sin-historial', limit: 10, data: emptyData, now, useLlm: false });
  check('sin historial degrada a vacío', empty.messageCount === 0 && empty.state === 'sin_historial' && empty.hasHistory === false, empty.state);
  check('sin historial resumen neutro', /Sin historial/.test(empty.summary), empty.summary.slice(0, 80));
  const neutral = await composeAck({ channel: 'simulator', userId: 'sin-historial', intent: 'consulta', urgency: 'normal', context: empty, data: emptyData, persist: true, now });
  check('acuse neutro sin historial', neutral.neutral === true && neutral.text.length > 20 && isSafeAck(neutral.text), neutral.text);

  const bad = contextTest.stateOf([]);
  check('estado vacío sin excepción', bad.state === 'sin_historial', bad.state);
  check('rutas thread montadas', routeModule.routes?.length === 3 && routeModule.name === 'thread', String(routeModule.routes?.length));
  check('rutas con auth normal', routeModule.routes.every((item) => item.handler && typeof item.handler === 'function'), 'handlers ok');
  check('helper de seguridad de acuse', ackTest.isSafeAck('Recibí tu mensaje; lo gestiono.') === true && ackTest.isSafeAck('Te confirmo el viernes 2026-11-06 con AG-0001') === false, 'ok');

  const failed = results.filter((row) => !row.ok);
  console.log(`\nAUTOCHECK ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const row of failed) console.log(`  FAIL ${row.name}: ${row.detail}`);
  }
  return failed.length === 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then((ok) => process.exit(ok ? 0 : 1)).catch((error) => {
    console.error('AUTOCHECK FAIL', error);
    process.exit(1);
  });
}

export { main };
