/**
 * Auto-borrador de respuestas para correo nuevo.
 *
 * Opt-in por bandeja (`autoDraft`). Por pasada redacta como máximo 3 correos,
 * omite remitentes automáticos y boletines, y **solo crea propuestas N2** en la
 * Oficina: nada se envía solo. Cada UID se marca para no duplicar la propuesta.
 */
import { getImapMessage, imapAccountById, markAutoDrafted } from './imap.mjs';
import { buildReplyProposal } from './imap-reply.mjs';
import { evaluateMessage, holdMessage } from './mail-guard.mjs';

const MAX_PER_PASS = 3;

const SKIP_SENDER = /(no-?reply|mailer-daemon|postmaster|notifications?@|newsletter@|bounce)/i;
const SKIP_SUBJECT = /(newsletter|bolet[ií]n|unsubscribe|darse de baja)/i;

export function skipReason(message) {
  const sender = String(message?.from?.email || '').toLowerCase();
  if (!sender) return 'sin remitente';
  if (SKIP_SENDER.test(sender)) return 'remitente automático';
  if (SKIP_SUBJECT.test(String(message?.subject || ''))) return 'boletín o suscripción';
  return null;
}

export async function autoDraftNew(accountId, { registry, uids = [] } = {}) {
  const account = imapAccountById(accountId);
  if (!account) return { accountId, attempted: 0, created: 0, results: [] };
  if (!registry) throw new Error('Registro de canales no disponible para redactar.');
  const done = new Set(Array.isArray(account.autoDrafted) ? account.autoDrafted.map(Number) : []);
  const candidates = Array.isArray(uids) && uids.length ? uids : (Array.isArray(account.pendingUids) ? account.pendingUids : []);
  const fresh = [...new Set(candidates.map(Number))]
    .filter((uid) => Number.isInteger(uid) && uid > 0 && !done.has(uid))
    .slice(-MAX_PER_PASS);
  const results = [];
  for (const uid of fresh) {
    try {
      const message = await getImapMessage(accountId, uid);
      const skip = skipReason(message);
      if (skip) {
        results.push({ uid, skipped: skip });
        await markAutoDrafted(accountId, [uid]);
        continue;
      }
      const verdict = evaluateMessage(message);
      if (verdict.action === 'quarantine') {
        const held = await holdMessage(accountId, message, verdict.reason);
        results.push({ uid, quarantined: true, quarantineId: held.id, reason: verdict.reason });
        await markAutoDrafted(accountId, [uid]);
        continue;
      }
      if (verdict.action === 'skip') {
        results.push({ uid, skipped: verdict.reason });
        await markAutoDrafted(accountId, [uid]);
        continue;
      }
      const proposal = await buildReplyProposal(accountId, uid, { registry, instructions: '' });
      results.push({
        uid,
        proposalId: proposal.proposal?.id || null,
        subject: proposal.draft?.subject || null,
        engine: proposal.draft?.engine || null
      });
      await markAutoDrafted(accountId, [uid]);
    } catch (error) {
      results.push({ uid, error: String(error?.message || error).slice(0, 160) });
      await markAutoDrafted(accountId, [uid]).catch(() => {});
    }
  }
  return {
    accountId,
    attempted: fresh.length,
    created: results.filter((item) => item.proposalId).length,
    results
  };
}


