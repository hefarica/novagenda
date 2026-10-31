/**
 * Puesta en marcha asistida: estado real de las conexiones, presets por
 * proveedor y ayuda contextual de Camila (la jefa de gabinete).
 *
 *   GET  /api/setup/overview  → checklist, score, presets y equipo
 *   POST /api/setup/assist    → respuesta en lenguaje natural + siguiente paso
 *
 * No crea cuentas ni envía nada: la UI usa las APIs existentes de cada canal
 * después de que el usuario apruebe la conexión. Tampoco devuelve secretos.
 */
import { bodyOf, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { publicConnections } from '../google.mjs';
import { channelStatus } from '../channels.mjs';
import { listAccounts } from '../channel/smtp.mjs';
import { listImapAccounts } from '../channel/imap.mjs';
import { listServers } from '../mcp/state.mjs';
import { readConfig } from '../nudges/config.mjs';
import { styleProfilesSnapshot } from '../style/profile.mjs';
import { resolveLlmConfig } from '../llm/config.mjs';
import { llmComplete, sanitizeText, wrapUserData } from '../llm/client.mjs';
import { secretStatus } from '../security/vault.mjs';
import { HttpError } from '../http/errors.mjs';

export const name = 'setup';
export const priority = 120;

const MAX_MESSAGE = 1200;

const EMAIL_PRESETS = Object.freeze([
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    note: 'Gmail exige una contraseña de aplicación de 16 caracteres (sin espacios), no tu contraseña normal. Actívala en Cuenta de Google → Seguridad → Verificación en dos pasos → Contraseñas de aplicaciones. Si no aparece esa opción, tu cuenta es de empresa o tiene Protección Avanzada: usa Google OAuth.'
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    imap: { host: 'imap-mail.outlook.com', port: 993, secure: true },
    note: 'Microsoft puede bloquear la contraseña básica; si falla, conecta por Google OAuth si es una cuenta Workspace o usa una contraseña de aplicación.'
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.es', 'ymail.com'],
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    note: 'Yahoo también requiere contraseña de aplicación.'
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    note: 'iCloud requiere una contraseña de aplicación específica de la app.'
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    note: 'Usa contraseña de aplicación si tu cuenta tiene 2FA.'
  },
  {
    id: 'custom',
    label: 'Otro proveedor',
    domains: [],
    smtp: { host: '', port: 465, secure: true },
    imap: { host: '', port: 993, secure: true },
    note: 'Escribe el servidor SMTP/IMAP de tu proveedor. Si no los conoces, pregúntale a Camila o a soporte del proveedor.'
  }
]);

const LLM_PRESETS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: 'Compatible con OpenAI. Suele ser la opción más económica para esta oficina.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: 'Usa una clave de API, no la contraseña de tu cuenta.'
  },
  {
    id: 'ollama',
    label: 'Ollama local (sin costo por token)',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2:3b',
    note: 'Requiere Ollama instalado y el modelo descargado en tu equipo. No necesita clave.'
  }
]);

const MCP_PRESETS = Object.freeze([
  {
    id: 'desktop-commander',
    label: 'Desktop Commander',
    description: 'Terminal, archivos y procesos de tu equipo.',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@wonderwhy-er/desktop-commander'],
    note: 'Da acceso real a tu equipo. Empieza desactivado y actívalo cuando lo entiendas.'
  },
  {
    id: 'playwright',
    label: 'Playwright / Chromium',
    description: 'Navegar y operar webs con una sesión de Chromium.',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', '@playwright/mcp@latest'],
    note: 'Puede abrir un Chromium propio; no reutiliza tus sesiones por defecto.'
  }
]);

const TEAM = Object.freeze([
  { name: 'Camila', role: 'Jefa de gabinete', initials: 'CA', tone: 'coordina y te pregunta lo mínimo' },
  { name: 'Tomás', role: 'Agenda y viajes', initials: 'TO', tone: 'convierte fechas en planes reales' },
  { name: 'Lucía', role: 'Documentos', initials: 'LU', tone: 'Word, Excel, PowerPoint y actas' },
  { name: 'Diego', role: 'QA', initials: 'DI', tone: 'revisa datos y estilo antes de enviar' },
  { name: 'Inés', role: 'Auditoría', initials: 'IN', tone: 'deja todo en el ledger' }
]);

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function emailProviderFor(address) {
  const domain = clean(address, 254).toLowerCase().split('@')[1] || '';
  return EMAIL_PRESETS.find((preset) => preset.domains.includes(domain)) || EMAIL_PRESETS[EMAIL_PRESETS.length - 1];
}

function appOrigin(ctx) {
  const host = String(ctx?.req?.headers?.host || '127.0.0.1:3000');
  const proto = String(ctx?.req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function secretConfigured(name) {
  try { return secretStatus(name).configured === true; } catch { return false; }
}

function buildOverview(origin = 'http://127.0.0.1:3000') {
  const data = store.get();
  const smtp = listAccounts();
  const imap = listImapAccounts();
  const google = publicConnections();
  const channels = channelStatus();
  const mcp = listServers();
  const style = styleProfilesSnapshot(data);
  const nudges = readConfig(data);
  const llm = resolveLlmConfig();
  const googleCreds = secretConfigured('google.clientId') && secretConfigured('google.clientSecret');

  const steps = [
    {
      id: 'llm',
      title: 'Modelo de lenguaje',
      icon: '✦',
      why: 'Para entender lenguaje natural, redactar y coordinar al equipo.',
      status: llm.configured && llm.enabled ? 'done' : secretConfigured('llm.openai.apiKey') ? 'partial' : 'pending',
      detail: llm.configured ? `${clean(llm.kind || 'auto', 40)} · ${clean(llm.model || '', 80) || 'modelo configurado'}` : 'Sin modelo conectado.',
      action: 'Conectar modelo'
    },
    {
      id: 'email',
      title: 'Correo',
      icon: '✉',
      why: 'Enviar y leer correo desde tus cuentas, con aprobación.',
      status: smtp.length && imap.length ? 'done' : smtp.length || imap.length ? 'partial' : 'pending',
      detail: `${smtp.length} cuenta(s) de envío · ${imap.length} bandeja(s)`,
      action: smtp.length && imap.length ? 'Añadir otra cuenta' : 'Conectar correo'
    },
    {
      id: 'google',
      title: 'Google',
      icon: '◉',
      why: 'Calendar, Gmail y Drive con OAuth; reuniones y disponibilidad reales.',
      status: google.length ? 'done' : googleCreds ? 'partial' : 'pending',
      detail: google.length ? `${google.length} cuenta(s) Google conectada(s)` : googleCreds ? 'Credenciales guardadas; falta autorizar la cuenta.' : 'Sin credenciales OAuth.',
      action: google.length ? 'Conectar otra cuenta' : googleCreds ? 'Autorizar cuenta' : 'Configurar Google'
    },
    {
      id: 'telegram',
      title: 'Telegram',
      icon: '✈',
      why: 'Avisos y conversación desde el móvil.',
      status: channels.telegram.configured ? 'done' : 'pending',
      detail: channels.telegram.configured ? 'Bot conectado.' : 'Sin bot conectado.',
      action: 'Conectar Telegram'
    },
    {
      id: 'whatsapp',
      title: 'WhatsApp',
      icon: '◌',
      why: 'Leer hilos y responder con tu aprobación, o avisarte.',
      status: channels.whatsapp.configured ? 'done' : 'pending',
      detail: channels.whatsapp.configured ? 'Canal oficial configurado.' : 'Sin canal de WhatsApp.',
      action: 'Conectar WhatsApp'
    },
    {
      id: 'mcp',
      title: 'Tu equipo y Chromium',
      icon: '⌘',
      why: 'Archivos, terminal y navegación web con Desktop Commander y Playwright.',
      status: mcp.items.some((server) => server.enabled) ? 'done' : mcp.items.length ? 'partial' : 'pending',
      detail: `${mcp.items.length} servidor(es) MCP · ${mcp.items.filter((server) => server.enabled).length} activo(s)`,
      action: mcp.items.length ? 'Revisar servidores' : 'Preparar mi equipo'
    },
    {
      id: 'style',
      title: 'Tu forma de escribir',
      icon: '✎',
      why: 'Para redactar como Héctor, no como un bot genérico.',
      status: style.totalSamples >= style.minSamples ? 'done' : style.totalSamples ? 'partial' : 'pending',
      detail: `${style.totalSamples} muestra(s); mínimo ${style.minSamples} por registro.`,
      action: 'Cargar muestras'
    },
    {
      id: 'nudges',
      title: 'Recordatorios',
      icon: '◔',
      why: 'Que te avise de mensajes y pendientes sin que tengas que preguntar.',
      status: nudges.channels?.length ? 'done' : 'partial',
      detail: nudges.channels?.length ? `Avisos por ${nudges.channels.join(', ')}.` : 'Motor listo, pero sin canal de entrega.',
      action: 'Elegir avisos'
    }
  ];

  const done = steps.filter((step) => step.status === 'done').length;
  const partial = steps.filter((step) => step.status === 'partial').length;
  const score = Math.round(((done + partial * 0.5) / steps.length) * 100);
  const next = steps.find((step) => step.status !== 'done') || null;
  return {
    ok: true,
    score,
    done,
    partial,
    total: steps.length,
    steps,
    next: next ? { id: next.id, title: next.title, action: next.action } : null,
    presets: { email: EMAIL_PRESETS, llm: LLM_PRESETS, mcp: MCP_PRESETS },
    redirects: {
      google: `${origin}/api/auth/google/callback`,
      email: `${origin}/api/channels/email/oauth/callback`
    },
    team: TEAM,
    connections: {
      smtp: smtp.length,
      imap: imap.length,
      google: google.length,
      telegram: Boolean(channels.telegram.configured),
      whatsapp: Boolean(channels.whatsapp.configured),
      mcp: mcp.items.length,
      styleSamples: style.totalSamples,
      nudgeChannels: Array.isArray(nudges.channels) ? nudges.channels : []
    }
  };
}

function fallbackReply(message, overview) {
  const text = clean(message, MAX_MESSAGE).toLowerCase();
  const pending = overview.steps.filter((step) => step.status !== 'done');
  const next = overview.next;
  if (!text) {
    return `Soy Camila. Vamos por partes: ${next ? `lo siguiente es **${next.title}** (${next.action.toLowerCase()})` : 'ya tienes lo esencial conectado'}. Yo te guío; tú solo pones usuario y contraseña cuando haga falta.`;
  }
  if (/correo|gmail|smtp|imap|outlook|bandeja/.test(text)) {
    return 'Abre **Correo** en esta misma página. Elige Gmail, Outlook o “Otro”; yo relleno servidor, puerto y seguridad. Tú solo escribes el correo y la contraseña de aplicación. Si tu proveedor tiene 2FA, la contraseña normal no sirve: usa una contraseña de aplicación.';
  }
  if (/google|calendar|drive|gmail|oauth/.test(text)) {
    return 'Para Google necesitas dos datos del proyecto OAuth: **Client ID** y **Client Secret**. Yo ya dejé listas las URLs de redirección y los permisos. Después pulsa “Guardar y autorizar” y elige tu cuenta. Sin eso no puedo leer Calendar, Gmail ni Drive.';
  }
  if (/telegram|bot/.test(text)) {
    return 'Abre **Telegram** aquí. Pega el token de @BotFather y tu chat ID; el modo local será *polling*, así no necesitas abrir puertos. Yo guardo el token cifrado y hago una prueba de mensaje.';
  }
  if (/whatsapp|whats/.test(text)) {
    return 'Para WhatsApp hay dos caminos. El oficial usa WhatsApp Business API: necesitas Phone Number ID y token de Meta; es el que recomiendo para tu número principal. El no oficial usa tu número y un QR, pero puede caerse o bloquearte. Dime cuál quieres y te guío.';
  }
  if (/mcp|desktop|chromium|playwright|computador|equipo/.test(text)) {
    return 'En **Tu equipo y Chromium** tienes dos presets listos: Desktop Commander (archivos y terminal) y Playwright (navegador). Se crean desactivados para que los revises antes de darles acceso. Actívalos solo cuando quieras que la oficina toque tu equipo.';
  }
  if (/estilo|voz|redact|como yo/.test(text)) {
    return 'En **Tu forma de escribir** pega entre 25 y 50 correos tuyos del mismo tipo (cliente, entidad, colega). Yo extraigo saludo, cierre, longitud de frase y formalidad. Sin muestras reales solo puedo escribir un formal genérico; eso no pasa por tuyo.';
  }
  if (/recordatorio|aviso|nudge/.test(text)) {
    return 'En **Recordatorios** elige por dónde quieres que te hable: correo, Telegram o WhatsApp. El motor ya está activo; si no marcas un canal, no tiene por dónde avisarte.';
  }
  if (/falta|pendiente|siguiente|qué hago|que hago|estado/.test(text)) {
    if (!pending.length) return 'Ya están las ocho piezas. Ahora ábreme **Integraciones** para revisar detalles o pídeme que probemos un envío real contigo delante.';
    return `Nos falta esto: ${pending.map((step) => `**${step.title}**`).join(', ')}. Empezaría por **${next.title}**: ${next.action.toLowerCase()}. Si quieres, te abro ese paso y lo hacemos juntos.`;
  }
  if (/hola|buenas|camila/.test(text)) {
    return `Hola, soy Camila. Estoy contigo en la puesta en marcha. Llevamos ${overview.done} de ${overview.total} conexiones listas. ¿Empezamos por **${next?.title || 'revisar lo que ya está'}**?`;
  }
  return `Te escucho. Puedo guiarte paso a paso por correo, Google, Telegram, WhatsApp, tu equipo o tu estilo. Ahora mismo lo siguiente es **${next?.title || 'revisar las conexiones'}**. Dime qué servicio quieres conectar y te digo exactamente qué poner.`;
}

async function overviewRoute(ctx) {
  return respond(ctx, 200, buildOverview(appOrigin(ctx)));
}

async function assistRoute(ctx) {
  const body = await bodyOf(ctx);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  }
  const message = sanitizeText(clean(body.message, MAX_MESSAGE), MAX_MESSAGE);
  const overview = buildOverview(appOrigin(ctx));
  const fallback = fallbackReply(message, overview);
  const context = {
    score: overview.score,
    next: overview.next,
    steps: overview.steps.map((step) => ({ id: step.id, title: step.title, status: step.status, detail: step.detail }))
  };
  let reply = fallback;
  let source = 'fallback';
  try {
    const result = await llmComplete({
      profile: 'chat',
      maxTokens: 420,
      temperature: 0.25,
      messages: [
        {
          role: 'system',
          content: [
            'Eres Camila, jefa de gabinete de la oficina de Héctor Fabio Riascos C.',
            'Guias la puesta en marcha de la app. Hablas en español claro, cálido y breve.',
            'No pides contraseñas ni tokens por el chat: los campos de la página son los únicos que los reciben.',
            'No inventes estados: usa solo el contexto. Si algo está pendiente, dilo.',
            'Da un solo siguiente paso concreto y, si ayuda, el nombre exacto del botón.',
            'No menciones que eres un modelo ni hables de agentes internos como si fueran una máquina; eres parte del equipo.',
            'Máximo 5 frases. No uses listas largas.'
          ].join(' ')
        },
        {
          role: 'user',
          content: `Contexto real de conexiones (sin secretos):\n${wrapUserData(JSON.stringify(context), 4000)}\n\nMensaje del jefe:\n${wrapUserData(message || '(sin mensaje; saluda y propón el siguiente paso)', MAX_MESSAGE)}`
        }
      ],
      fallback
    });
    if (result?.ok && result.text) {
      reply = sanitizeText(result.text, 2000);
      source = result.fallback ? 'fallback' : 'llm';
    }
  } catch {
    // La app sigue funcionando con la respuesta determinista.
  }
  return respond(ctx, 200, { ok: true, reply, source, overview });
}

export const routes = [
  { method: 'GET', path: '/api/setup/overview', name: 'setup.overview', handler: route(overviewRoute) },
  { method: 'POST', path: '/api/setup/assist', name: 'setup.assist', handler: route(assistRoute) }
];

export default { name, priority, routes };
