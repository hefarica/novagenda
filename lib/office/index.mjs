/**
 * API pública del módulo Oficina (re-exporta los submódulos).
 *
 * Uso desde rutas, scheduler o tests:
 *   import { createProposal, approveProposal, executeProposal } from '../office/index.mjs';
 */
export * from './canonical.mjs';
export * from './contacts.mjs';
export * from './executors.mjs';
export * from './ledger.mjs';
export * from './opinions.mjs';
export * from './parse.mjs';
export * from './policy.mjs';
export * from './proposals.mjs';
export * from './risk.mjs';
export * from './roster.mjs';
export * from './state.mjs';
