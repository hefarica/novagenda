/**
 * Ledger append-only con cadena SHA-256.
 *
 * Cada entrada:
 *   {seq, ts, actor, action, payloadHash, prevHash, hash, payload}
 *
 * `payloadHash = SHA256(canonical(payload))`
 * `hash = SHA256(canonical({seq,ts,actor,action,payloadHash,prevHash}))`
 * `prevHash` es el hash de la entrada anterior (genesis = 64 ceros).
 *
 * La verificación recalcula ambos hashes y la continuidad de la cadena; también
 * detecta payloads alterados porque el payload sanitizado se guarda en la entrada.
 */
import { GENESIS_HASH, nowIso, sanitizeValue, sha256Hex, stableStringify } from './canonical.mjs';
import { ensureOffice } from './state.mjs';

/**
 * Construye y añade una entrada al ledger (muta `data.office`).
 * @param {any} data
 * @param {{actor?:string, action:string, payload?:object}} input
 * @returns {object} entrada creada
 */
export function appendLedger(data, input = {}) {
  const office = ensureOffice(data);
  const ledger = office.ledger;
  const previous = ledger.length ? ledger[ledger.length - 1] : null;
  const seq = ledger.length + 1;
  const ts = nowIso();
  const actor = String(input.actor || 'sistema').slice(0, 80);
  const action = String(input.action || 'evento').slice(0, 60);
  const payload = sanitizeValue(input.payload || {});
  const payloadHash = sha256Hex(payload);
  const prevHash = previous ? previous.hash : GENESIS_HASH;
  const hash = sha256Hex(stableStringify({ seq, ts, actor, action, payloadHash, prevHash }));
  const entry = { seq, ts, actor, action, payloadHash, prevHash, hash, payload };
  ledger.push(entry);
  office.ledgerUpdatedAt = ts;
  return entry;
}

/**
 * @param {any} data
 * @param {{limit?:number, offset?:number}} [options]
 * @returns {{items:object[], count:number, total:number, head:string, genesis:string}}
 */
export function listLedger(data, { limit = 100, offset = 0 } = {}) {
  const office = ensureOffice(data);
  const ledger = office.ledger;
  const size = Math.max(1, Math.min(1000, Math.round(Number(limit) || 100)));
  const skip = Math.max(0, Math.round(Number(offset) || 0));
  // Más recientes primero para la UI.
  const ordered = [...ledger].reverse();
  const items = ordered.slice(skip, skip + size).map((entry) => ({ ...entry }));
  return {
    items,
    count: items.length,
    total: ledger.length,
    head: ledger.length ? ledger[ledger.length - 1].hash : GENESIS_HASH,
    genesis: GENESIS_HASH
  };
}

/**
 * Verifica toda la cadena.
 * @param {any} data
 * @returns {{ok:boolean, entries:number, broken:{seq:number,reason:string}[], head:string, genesis:string}}
 */
export function verifyLedger(data) {
  const office = ensureOffice(data);
  const ledger = office.ledger;
  const broken = [];
  let expectedPrev = GENESIS_HASH;
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index] || {};
    const expectedSeq = index + 1;
    if (Number(entry.seq) !== expectedSeq) broken.push({ seq: expectedSeq, reason: `seq ${entry.seq} ≠ ${expectedSeq}` });
    if (String(entry.prevHash || '') !== expectedPrev) broken.push({ seq: expectedSeq, reason: 'prevHash no coincide con la entrada anterior' });
    if (entry.payload === undefined) {
      broken.push({ seq: expectedSeq, reason: 'payload ausente: no se puede verificar payloadHash' });
    } else {
      const expectedPayloadHash = sha256Hex(entry.payload);
      if (String(entry.payloadHash || '') !== expectedPayloadHash) broken.push({ seq: expectedSeq, reason: 'payloadHash no coincide con el payload' });
    }
    const expectedHash = sha256Hex(stableStringify({
      seq: entry.seq,
      ts: entry.ts,
      actor: entry.actor,
      action: entry.action,
      payloadHash: entry.payloadHash,
      prevHash: entry.prevHash
    }));
    if (String(entry.hash || '') !== expectedHash) broken.push({ seq: expectedSeq, reason: 'hash de la entrada no coincide' });
    expectedPrev = entry.hash || expectedPrev;
  }
  return {
    ok: broken.length === 0,
    entries: ledger.length,
    broken,
    head: ledger.length ? ledger[ledger.length - 1].hash : GENESIS_HASH,
    genesis: GENESIS_HASH
  };
}

/**
 * Export JSON completo del ledger (para auditoría externa).
 * @param {any} data
 */
export function exportLedger(data) {
  const office = ensureOffice(data);
  const verification = verifyLedger(data);
  return {
    app: 'Agenda Copilot P95',
    document: 'office-ledger',
    exportedAt: nowIso(),
    mode: office.mode,
    genesis: GENESIS_HASH,
    verification,
    entries: office.ledger.map((entry) => ({ ...entry }))
  };
}
