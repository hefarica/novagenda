/**
 * Adaptador simulador: SIEMPRE disponible, sin credenciales ni red.
 *
 * Es la vía de aceptación y de demo: `POST /api/channels/simulate` conversa con
 * el asistente real (mismos comandos HOY/CAPTURA/HECHO/…) y la bandeja local
 * (`GET /api/channels/inbox`) muestra entrantes y salientes. Sirve también para
 * probar la UI de integraciones sin dar de alta WhatsApp/Telegram/Gmail.
 */
import crypto from 'node:crypto';
import { sanitizeText } from './message.mjs';

export function createSimulatorAdapter() {
  const startedAt = new Date().toISOString();
  const sent = [];
  const documents = [];

  return {
    id: 'simulator',
    label: 'Simulador local',
    kind: 'local',
    alwaysAvailable: true,
    capabilities: Object.freeze({
      inbound: true, outbound: true, proactive: false,
      buttons: false, typing: false, threads: false, templates: false,
      documents: true, approvals: true
    }),
    configFields: Object.freeze([]),
    instructions: Object.freeze([
      'Abre la app en el Centro de integraciones y elige «Simulador local».',
      'Escribe «HOY» y pulsa Enviar: verás la respuesta real del asistente.',
      'Prueba «CAPTURA llamar a Juan» y luego «HOY» para comprobar que la tarea aparece.',
      'La conversación completa queda en la bandeja local (GET /api/channels/inbox).'
    ]),

    status() {
      return {
        id: 'simulator',
        label: 'Simulador local',
        kind: 'local',
        alwaysAvailable: true,
        configured: true,
        enabled: true,
        ready: true,
        detail: 'Siempre disponible: no necesita credenciales ni conexión.',
        instructions: [...this.instructions],
        warnings: [],
        capabilities: { ...this.capabilities },
        config: [],
        runtime: { startedAt, sentMessages: sent.length, inboundUrl: null, webhookUrl: null },
        stats: { received: null, sent: sent.length, errors: 0, duplicates: 0, ignored: 0 },
        lastError: null,
        webhookUrl: null
      };
    },

    async configure() {
      return { ok: true, changed: [], detail: 'El simulador no requiere configuración.' };
    },

    async test({ text } = {}) {
      const message = sanitizeText(text || 'HOY', 500);
      return {
        ok: true,
        channel: 'simulator',
        detail: 'Prueba local correcta: no se ha llamado a ningún proveedor.',
        result: { echo: message, via: 'simulator' }
      };
    },

    async send({ to, text }) {
      const id = `SIM-${crypto.randomUUID()}`;
      sent.push({ id, to: String(to || 'demo'), text: sanitizeText(text, 500), at: new Date().toISOString() });
      if (sent.length > 50) sent.shift();
      return { id, to: String(to || 'demo'), via: 'simulator', detail: { simulated: true } };
    },

    async sendDocument({ to, filename, buffer, mimeType = 'application/octet-stream', caption = '' }) {
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('El documento no tiene contenido.');
      }
      const id = `SIM-DOC-${crypto.randomUUID()}`;
      documents.push({ id, to: String(to || 'demo'), filename, size: buffer.length, mimeType, caption, at: new Date().toISOString() });
      if (documents.length > 50) documents.shift();
      return { id, to: String(to || 'demo'), via: 'simulator', filename, size: buffer.length, mimeType };
    }
  };
}
