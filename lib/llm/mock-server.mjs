/**
 * Servidor LLM de mentira para desarrollo y pruebas end-to-end.
 *
 * Implementa el mínimo OpenAI-compatible (`GET /v1/models`,
 * `POST /v1/chat/completions`) y también Ollama (`GET /api/tags`,
 * `POST /api/chat`) para poder probar el subsistema completo sin clave real y
 * sin instalar nada.
 *
 * No se usa en producción: solo lo importan `lib/llm/selftest.mjs` y las
 * pruebas del equipo.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TZ = 'America/Bogota';

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

function fold(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseDate(text) {
  const low = fold(text);
  const today = todayKey();
  if (/\bpasado manana\b/.test(low)) return addDays(today, 2);
  if (/\bmanana\b/.test(low)) return addDays(today, 1);
  if (/\bhoy\b/.test(low)) return today;
  const iso = low.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const months = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  for (const [name, month] of Object.entries(months)) {
    const match = low.match(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${name}(?:\\s+de\\s+(20\\d{2}))?`));
    if (match) return `${match[2] || today.slice(0, 4)}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  return null;
}

function parseClock(text) {
  const low = fold(text).replace(/(\d)\s*([ap])\.?\s*m\.?/g, '$1 $2m');
  const meridiem = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] || 0);
    if (meridiem[3] === 'pm' && hour < 12) hour += 12;
    if (meridiem[3] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const colon = low.match(/\b(\d{1,2}):(\d{2})\b/);
  if (colon) return `${colon[1].padStart(2, '0')}:${colon[2]}`;
  const spoken = low.match(/\b(?:a\s+las?|a\s+la|@)\s*(\d{1,2})\b(.*)$/);
  if (spoken) {
    let hour = Number(spoken[1]);
    const tail = spoken[2] || '';
    if (/\bde\s+la\s+(manana|tarde|noche)\b/.test(tail)) {
      if (hour < 12) hour += 12;
    } else if (hour >= 1 && hour <= 5) {
      hour += 12;
    }
    return `${String(hour).padStart(2, '0')}:00`;
  }
  return null;
}

function parseDuration(text) {
  const low = fold(text);
  const minutes = low.match(/(\d{1,3})\s*(?:minutos?|mins?)\b/);
  if (minutes) return Number(minutes[1]);
  const hours = low.match(/(\d{1,2})\s*(?:horas?|hrs?|h)\b/);
  if (hours) return Number(hours[1]) * 60;
  if (/\bmedia hora\b/.test(low)) return 30;
  return null;
}

function cleanTitle(text) {
  let out = String(text || '')
    .replace(/^(agenda|agendar|agéndame|agendame|programa|programar|crea|crear|bloquea|bloquear|reserva|reservar)\s+/i, '')
    .replace(/\b(hoy|mañana|manana|pasado mañana)\b/gi, '')
    .replace(/\b(?:a\s+las?|a\s+la|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b\d{1,3}\s*(?:minutos?|mins?|horas?|hrs?)\b/gi, '')
    .replace(/\b(?:urgente|importante)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '')
    .trim();
  if (!out) out = 'Compromiso';
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Simula lo que hacen algunos LLM reales: devolver un nombre suelto en
 * `attendees` cuando el usuario dice «con Ana», o el email si lo incluye.
 */
function extractAttendees(text) {
  const source = String(text || '');
  const email = source.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/)?.[0];
  if (email) return [email];
  const name = source.match(/\bcon\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/)?.[1];
  return name ? [name] : null;
}

function eventQuery(text) {
  return String(text || '')
    .replace(/^(mu[eé]veme|mueve|mover|reprograma|cambia|cancela|elimina|borra|completa|marca como hecho)\s+/i, '')
    .replace(/\b(?:a\s+las?|a\s+la|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b(?:para|el|la)\s+(?:mañana|hoy)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || 'cita';
}

/** Construye una intención JSON determinista a partir del texto del usuario. */
export function heuristicIntent(rawText) {
  const text = String(rawText || '');
  const low = fold(text);
  const date = parseDate(text);
  const time = parseClock(text);
  const durationMin = parseDuration(text);
  const base = { confidence: 0.92, reply: '' };

  if (/\bhoy\b|que tengo hoy|mi dia/.test(low) && !/agenda|agendar/.test(low)) {
    return { action: 'listar_dia', args: date ? { date } : {}, ...base };
  }
  if (/\bbalance\b|como voy/.test(low)) return { action: 'balance', args: {}, ...base };
  if (/\bsemana\b/.test(low)) return { action: 'resumen_semana', args: {}, ...base };
  if (/^captura\s+/i.test(text)) return { action: 'capturar', args: { text: text.replace(/^captura\s+/i, '').trim() }, ...base };
  if (/\bconvierte|convertir|pasa a agenda\b/.test(low)) {
    const inboxId = String(text).match(/\b(IN-\d{1,6})\b/i)?.[1]?.toUpperCase();
    return { action: 'convertir_inbox', args: inboxId ? { id: inboxId } : { query: eventQuery(text) }, ...base };
  }

  if (/\brutina\b/.test(low)) {
    if (/\bpausa|desactiva|activa\b/.test(low)) {
      return { action: 'activar_rutina', args: { query: cleanTitle(text), active: !/pausa|desactiva/.test(low) }, ...base };
    }
    return {
      action: 'crear_rutina',
      args: {
        title: cleanTitle(text),
        frequency: /\bsemanal\b/.test(low) ? 'SEMANAL' : 'DIARIA',
        time: time || '08:00',
        durationMin: durationMin || 30,
        type: 'Foco'
      },
      ...base
    };
  }

  if (/\bcorreo\b|\bemail\b/.test(low)) {
    const email = text.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/)?.[0];
    return { action: 'enviar_correo', args: { ...(email ? { to: email } : {}), subject: 'Agenda Copilot', body: eventQuery(text) }, ...base };
  }
  if (/\bwhatsapp\b/.test(low)) return { action: 'enviar_whatsapp', args: { text: eventQuery(text) }, ...base };
  if (/\btelegram\b/.test(low)) return { action: 'enviar_telegram', args: { text: eventQuery(text) }, ...base };

  if (/\b(mueve|mover|mueveme|reprograma|cambia)\b/.test(low)) {
    const args = { query: eventQuery(text) };
    if (date) args.date = date;
    if (time) args.time = time;
    return { action: 'mover_cita', args, ...base };
  }
  if (/\b(cancela|elimina|borra|anula)\b/.test(low)) return { action: 'cancelar_cita', args: { query: eventQuery(text) }, ...base };
  if (/\b(completa|marca como hecho|termina)\b/.test(low)) return { action: 'completar_cita', args: { query: eventQuery(text) }, ...base };

  if (/\b(agenda|agendar|agendame|programa|crea|bloquea|reserva|reunion|cita|llamada)\b/.test(low)) {
    const isFocus = /\bfoco\b/.test(low);
    const attendees = extractAttendees(text);
    return {
      action: 'crear_cita',
      args: {
        title: cleanTitle(text),
        ...(date ? { date } : {}),
        ...(time ? { time } : {}),
        durationMin: durationMin || 60,
        type: isFocus ? 'Foco' : /\bllamada\b/.test(low) ? 'Reunión' : /\breunion\b/.test(low) ? 'Reunión' : 'Compromiso',
        priority: /\burgente\b/.test(low) ? 'P1' : 'P1',
        impact: 5,
        urgency: 4,
        energy: isFocus ? 'Alta' : 'Media',
        context: isFocus ? 'Sin interrupciones' : 'Oficina',
        notes: `Creado desde «${text.slice(0, 120)}»`,
        ...(attendees ? { attendees } : {})
      },
      ...base
    };
  }
  return { action: 'preguntar', args: { question: '¿Me das más detalle de lo que quieres agendar?' }, confidence: 0.3 };
}

/** Propuesta de autocompletado determinista (mock). */
export function heuristicProposal(rawText) {
  const text = String(rawText || '');
  const low = fold(text);
  const isFocus = /\bfoco\b|concentracion/.test(low);
  const attendees = extractAttendees(text);
  return {
    title: cleanTitle(text),
    type: /\breunion\b|llamada/.test(low) ? 'Reunión' : isFocus ? 'Foco' : 'Compromiso',
    priority: /\burgente\b/.test(low) ? 'P1' : /\bimportante\b/.test(low) ? 'P2' : 'P2',
    impact: /\burgente|importante/.test(low) ? 5 : 4,
    urgency: /\burgente\b/.test(low) ? 5 : 3,
    energy: isFocus ? 'Alta' : 'Media',
    context: isFocus ? 'Sin interrupciones' : 'Oficina',
    location: null,
    durationMin: parseDuration(text) || 45,
    reminderMin: 10,
    notes: `Propuesta mock para «${text.slice(0, 100)}»`,
    date: parseDate(text),
    time: parseClock(text),
    deepFocus: isFocus,
    ...(attendees ? { attendees } : {})
  };
}

/**
 * Crea y arranca el servidor mock.
 * @param {{model?:string, ollamaModel?:string, delayMs?:number, failFirst?:number, failStatus?:number, emptyCompletion?:number}} [options]
 */
export async function createMockLlmServer(options = {}) {
  const state = {
    model: options.model || 'mock-agenda-1',
    ollamaModel: options.ollamaModel || 'mock-ollama:3b',
    delayMs: Number(options.delayMs || 0),
    failFirst: Number(options.failFirst || 0),
    failStatus: Number(options.failStatus || 500),
    // Simula proveedores que devuelven 200 con contenido vacío y finish_reason "length".
    emptyCompletion: Number(options.emptyCompletion || 0),
    calls: [],
    startedAt: new Date().toISOString()
  };

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return { _raw: raw };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /v1/models') {
      state.calls.push({ at: new Date().toISOString(), route, authorization: req.headers.authorization || null });
      return send(res, 200, { object: 'list', data: [{ id: state.model, object: 'model', owned_by: 'mock' }] });
    }
    if (route === 'GET /api/tags') {
      state.calls.push({ at: new Date().toISOString(), route });
      return send(res, 200, { models: [{ name: state.ollamaModel, size: 123456, modified_at: new Date().toISOString() }] });
    }
    if (route === 'POST /v1/responses') {
      const body = await readBody(req);
      state.calls.push({ at: new Date().toISOString(), route, authorization: req.headers.authorization || null, body });
      if (state.failFirst > 0) {
        state.failFirst -= 1;
        return send(res, state.failStatus, { error: { message: 'Fallo transitorio simulado', type: 'mock_transient' } });
      }
      const text = 'OK';
      return send(res, 200, {
        id: `resp-mock-${Date.now()}`,
        object: 'response',
        model: state.model,
        status: 'completed',
        output_text: text,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 }
      });
    }
    if (route === 'POST /v1/messages') {
      const body = await readBody(req);
      state.calls.push({
        at: new Date().toISOString(),
        route,
        anthropicKey: req.headers['x-api-key'] || null,
        anthropicVersion: req.headers['anthropic-version'] || null,
        body
      });
      if (state.failFirst > 0) {
        state.failFirst -= 1;
        return send(res, state.failStatus, { error: { message: 'Fallo transitorio simulado', type: 'mock_transient' } });
      }
      return send(res, 200, {
        id: `msg-mock-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 2 }
      });
    }
    if (route === 'POST /v1/chat/completions') {
      const body = await readBody(req);
      state.calls.push({
        at: new Date().toISOString(),
        route,
        authorization: req.headers.authorization || null,
        headers: { 'x-mock-header': req.headers['x-mock-header'] || null, 'x-api-version': req.headers['x-api-version'] || null },
        body
      });
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.failFirst > 0) {
        state.failFirst -= 1;
        return send(res, state.failStatus, { error: { message: 'Fallo transitorio simulado', type: 'mock_transient' } });
      }
      if (state.emptyCompletion > 0) {
        state.emptyCompletion -= 1;
        return send(res, 200, {
          id: `chatcmpl-mock-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 14, completion_tokens: 0, total_tokens: 14 }
        });
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'));
      const lastUser = String(messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'));
      const wrapped = lastUser.match(/<usuario>([\s\S]*?)<\/usuario>/i)?.[1] || lastUser;
      const systemLow = fold(system);
      let content;
      if (systemLow.includes('secretario de actas')) {
        const attendees = /andrés|andres/i.test(wrapped) ? [{ name: 'Andrés M.', role: 'Solicitante' }] : [];
        content = `\`\`\`json\n${JSON.stringify({
          summary: [
            'Se revisó el predio La Esperanza.',
            'Se acordó gestionar la liberación con Catastro.',
            'Queda pendiente el número de matrícula.',
            'Se informará al solicitante del avance.'
          ],
          attendees,
          agenda: ['Predio La Esperanza', 'Liberación con Catastro'],
          development: 'Reunión de seguimiento sobre la liberación del predio. Se revisaron los antecedentes y los pasos pendientes.',
          agreements: [{ text: 'Enviar el acta a Catastro', owner: 'Héctor Fabio Riascos C.', due: 'esta semana' }],
          risks: []
        })}\n\`\`\``;
      } else if (systemLow.includes('traductor')) {
        content = `Traducción (mock): ${wrapped.trim().slice(0, 300)}`;
      } else if (systemLow.includes('asistente de captura')) {
        content = `\`\`\`json\n${JSON.stringify(heuristicProposal(wrapped))}\n\`\`\``;
      } else if (systemLow.includes('agente de agenda')) {
        content = `\`\`\`json\n${JSON.stringify(heuristicIntent(wrapped))}\n\`\`\``;
      } else {
        content = `Resumen del día (mock): ${heuristicIntent(wrapped).action}. Datos procesados correctamente.`;
      }
      const promptChars = messages.reduce((acc, message) => acc + String(message.content || '').length, 0);
      return send(res, 200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
          completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
          total_tokens: Math.max(2, Math.ceil((promptChars + content.length) / 4))
        }
      });
    }
    if (route === 'POST /api/chat') {
      const body = await readBody(req);
      state.calls.push({ at: new Date().toISOString(), route, body });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = String(messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'));
      const wrapped = lastUser.match(/<usuario>([\s\S]*?)<\/usuario>/i)?.[1] || lastUser;
      if (state.failFirst > 0) {
        state.failFirst -= 1;
        return send(res, state.failStatus, { error: 'fallo transitorio simulado' });
      }
      const content = body.format === 'json'
        ? JSON.stringify(heuristicProposal(wrapped))
        : `Resumen local (mock ollama): ${heuristicIntent(wrapped).action}.`;
      return send(res, 200, {
        model: state.ollamaModel,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: Math.max(1, Math.ceil(lastUser.length / 4)),
        eval_count: Math.max(1, Math.ceil(content.length / 4))
      });
    }
    return send(res, 404, { error: { message: `Ruta mock no encontrada: ${route}` } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port || 0), '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    calls: () => state.calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/* ------------------------------------------------------------------ */
/* CLI: `node lib/llm/mock-server.mjs` para pruebas manuales           */
/* ------------------------------------------------------------------ */

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const server = await createMockLlmServer({
    port: Number(process.env.MOCK_PORT || 0),
    failFirst: Number(process.env.MOCK_FAIL_FIRST || 0)
  });
  console.log(`Mock LLM (OpenAI-compatible + Ollama) escuchando en ${server.url}`);
  console.log(`  OPENAI_BASE_URL=${server.url}/v1  OPENAI_MODEL=mock-agenda-1  OPENAI_API_KEY=sk-mock-local`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}


