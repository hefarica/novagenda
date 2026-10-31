# Contratos congelados y rollback (Wave 0)

> Estos contratos son **solo aditivos**. Una feature nueva puede envolverlos,
> pero no renombrar, borrar, cambiar el status de error ni alterar la forma de
> una respuesta existente. Cualquier cambio de firma requiere una versión nueva
> y una migración explícita; no se hace dentro de Wave 0.

## Firmas intocables

| Área | Firma / ruta congelada | Qué no puede cambiar |
|---|---|---|
| Gate de Oficina | `POST /api/office/proposals/:id/approve` y `/execute` | aprobación firmada, código N3, TTL, ejecución única, errores `ALREADY_APPROVED`, `ALREADY_EXECUTED`, `NOT_APPROVED`, `SHADOW_MODE` |
| Gate de features | `getMode(id)`, `isOn(id)`, `isShadow(id)`, `assertOn(id)`, `runShadow(id, fn, compare)` | semántica off/shadow/on, `FEATURE_PAUSED`, `FEATURE_OFF`, shadow sin efectos |
| Ledger | `appendLedger(data, {actor, action, payload})` | cadena `seq/prevHash/hash`, payload sanitizado, append-only; `/api/office/ledger`, `/verify`, `/export` |
| Identidad | `/api/identity/people`, `/resolve`, `/expand`, `/contacts` | normalización de claves, deduplicación, respuesta de resolución y contactos |
| Hilos | `/api/thread/context`, `/api/thread/ack`, `/api/thread/summary` | contexto/ack/summary y su relación con `data.channelState` |
| Voz | `settings.office.voiceThreshold`, `computeVoice(opinions)` y el input `voice` de la política | escala 0…1, default 0.75, uso en la decisión de modo autónomo |
| Envío | `POST /api/channels/:id/send`, `/api/channels/send-document`, `/api/docs/:id/send-email`, `/api/gmail/send` | a terceros = propuesta 202; override Gmail solo con `allowDirectSend` y auditoría; autonomía de canal solo con flag/condiciones; 403/503 documentados |
| Envío verificado | `/api/office/proposals/:id/execute` + ejecutores de canal | una sola ejecución, aprobación/código previos, ledger `proposal.executed`/`outbound.autonomous` |
| Auth/CSRF | `auth:'default'`, `auth:'none'` solo para salud/webhooks/callbacks | ninguna ruta nueva puede quedar pública por accidente |
| Contrato HTTP | `docs/CONTRATO_API.md` | forma de `{error,code,field?,details?,requestId}` y códigos existentes |

## Regla de cambios aditivos

Permitido:

- Añadir rutas nuevas bajo `/api/features/*` y campos **opcionales** en
  respuestas existentes (p. ej. `health.features`).
- Añadir features al catálogo con `defaultMode:'off'`.
- Añadir consumidores que usen `assertOn`/`isOn`/`isShadow` y respeten la pausa.
- Añadir acciones de ledger nuevas (p. ej. `feature.change`,
  `feature.paused`) sin cambiar entradas históricas.

Prohibido sin versión nueva:

- Renombrar/eliminar rutas, campos obligatorios, códigos de error o estados.
- Cambiar el significado de `off/shadow/on` o el orden de precedencia
  (`FEATURES_KILLSWITCH=all` > `FEATURE_<ID>` > settings > default).
- Hacer que una feature pausada siga consumiéndose.
- Introducir escrituras o envíos desde `runShadow`.
- Modificar `docs/CONTRATO_API.md` para “hacer que coincida” con una regresión.

## Set dorado mínimo

Antes de pasar una feature a `on`:

1. `npm test` (incluye integración y selfchecks).
2. `node lib/office/selfcheck.mjs` y el selfcheck del canal afectado.
3. `node scripts/smoke.mjs` contra una instancia local temporal.
4. `GET /api/features` y `GET /api/features/status`: estado esperado y
   `globalPaused:false`.
5. `runShadow` con la implementación nueva y `compare` contra la actual; revisar
   `shadowLog()`/logs y confirmar que no hubo escrituras ni envíos.
6. Verificar `GET /api/office/ledger/verify` y que el cambio quedó auditado.

## Rollback

### Antes del despliegue

1. `GET /api/backup` (incluye secretos si corresponde) o copiar el archivo
   `data/agenda-data.json` con marca de tiempo; guardar el journal de restore.
2. Confirmar `GET /api/health` y `GET /api/office/ledger/verify` verdes.

### Incidente

1. **Apagado inmediato:** `POST /api/features/pause-all` o, si la API no
   responde, definir `FEATURES_KILLSWITCH=all` y reiniciar el proceso. También
   `POST /api/features/:id {mode:"off"}` para la feature concreta.
2. Si la feature ya escribió datos, restaurar el backup con
   `POST /api/backup/restore` (crea copia pre-restore y journal) o restaurar el
   archivo copiado con el proceso detenido.
3. Verificar:
   - `GET /api/health` (`ok:true`, features esperadas off),
   - `GET /api/office/ledger/verify` (`ok:true`, sin `broken`),
   - `GET /api/features/status`,
   - el set dorado de la sección anterior.
4. No borrar entradas del ledger para “arreglar” la cadena: el ledger es
   append-only. Si hay corrupción, restaurar el backup completo y documentar el
   incidente.

### Después

- Dejar la feature en `off` (default) hasta nueva validación shadow.
- Registrar la causa y el rollback en el runbook/incidente; no reutilizar el
  mismo flag para una semántica distinta.
- Si el rollback tocó un contrato congelado, abrir versión nueva; no reescribir
  el contrato anterior.
