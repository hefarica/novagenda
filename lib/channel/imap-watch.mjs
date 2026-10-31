/**
 * Vigilancia de bandejas IMAP: revisa si hay correo nuevo sin leer cuerpos ni
 * responder nada. Solo actualiza `lastUid`, `newCount` y `lastCheckAt`; los
 * avisos los genera el motor de nudges (`imap_new`).
 *
 * Se apaga con `IMAP_WATCH=off` o `CHANNELS_AUTOSTART=off` (pruebas).
 */
import { checkImapAccount, listImapAccounts } from './imap.mjs';
import { autoDraftNew } from './imap-auto.mjs';

let timer = null;
let running = false;
let lastRunAt = null;

function pollMs() {
  const override = Number(process.env.IMAP_POLL_MS);
  if (Number.isFinite(override) && override >= 1000) return Math.min(override, 86_400_000);
  const minutes = Math.max(1, Number(process.env.IMAP_POLL_MIN) || 5);
  return minutes * 60_000;
}

async function tick(registry = null) {
  if (running) return { skipped: true };
  running = true;
  const results = [];
  try {
    for (const account of listImapAccounts()) {
      try {
        const check = await checkImapAccount(account.id);
        let drafted = null;
        if (account.autoDraft && registry && Array.isArray(check.newUids) && check.newUids.length) {
          drafted = await autoDraftNew(account.id, { registry, uids: check.newUids }).catch((error) => ({
            error: String(error?.message || error).slice(0, 160)
          }));
        }
        results.push({ id: account.id, ...check, ...(drafted ? { drafted } : {}) });
      } catch (error) {
        results.push({ id: account.id, error: String(error?.message || error).slice(0, 200) });
      }
    }
    lastRunAt = new Date().toISOString();
    return { checked: results.length, results };
  } finally {
    running = false;
  }
}

export function startImapWatch({ registry = null } = {}) {
  if (timer) return { started: false, reason: 'already' };
  if (process.env.IMAP_WATCH === 'off' || process.env.CHANNELS_AUTOSTART === 'off') {
    return { started: false, reason: 'disabled' };
  }
  const ms = pollMs();
  timer = setInterval(() => { tick(registry).catch(() => {}); }, ms);
  timer.unref?.();
  tick(registry).catch(() => {});
  return { started: true, everyMs: ms };
}

export function stopImapWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function imapWatchStatus() {
  return { running: !!timer, busy: running, lastRunAt, everyMs: timer ? pollMs() : null };
}

