# Features, flags y kill switch (Wave 0)

> **Estado inicial:** todas las features del catálogo están en `off`.
> Nada nuevo pasa a `on` sin haber corrido antes en `shadow` y sin el set
> dorado de pruebas descrito en [CONTRATOS_CONGELADOS.md](CONTRATOS_CONGELADOS.md).

El registro vive en `lib/features/registry.mjs` y la API en
`lib/routes/features.mjs` (auto-descubierta, sin editar `server.mjs` ni módulos
existentes). El estado se persiste en `settings.features` y se completa al leer;
no hay migración ni escritura por una simple consulta.

## Catálogo inicial

| id | Nombre | Default | Owner | Consumers |
|---|---|---|---:|---|
| `lingo` | Lingo | `off` | backend-core | asistente |
| `acl` | ACL | `off` | backend-core | channels, office |
| `theme_light` | Tema claro | `off` | frontend | frontend |
| `approvals_center` | Centro de aprobaciones | `off` | backend-core | office, frontend |
| `meeting_capture` | Captura de reuniones | `off` | backend-core | assistant, docs |
| `mail_rules` | Reglas de correo | `off` | backend-core | channels |
| `base` | Base de conocimiento | `off` | backend-core | assistant, research |
| `wiki` | Wiki | `off` | frontend | docs, frontend |
| `translate` | Traducción | `off` | backend-core | assistant, channels |
| `loop_guard` | Loop guard | `off` | backend-core | channels |
| `audit` | Auditoría extendida | `off` | backend-core | office, frontend |
| `connectors` | Conectores | `off` | backend-core | channels, mcp |

Cada entrada del catálogo tiene `{id, name, description, defaultMode:'off',
status, consumers[], owner}`. `status` es el estado **efectivo** (`off`,
`shadow` u `on`); `mode`/`configuredMode` es el configurado sin pausa y
`effectiveMode` es el que deben consumir los gates.

## Estado persistido

```json
{
  "settings": {
    "features": {
      "modes": {"lingo": "shadow"},
      "paused": ["connectors"],
      "globalPaused": false,
      "updatedAt": "2026-10-28T…"
    }
  }
}
```

`settings.features` es opcional. Al leer se interpretan `modes` vacío, `paused`
vacío y `globalPaused:false`; no se escribe nada. `enforceOutbound` y otros flags
de Oficina no se mezclan con este bloque.

## Precedencia

1. **Kill switch de entorno:** `FEATURES_KILLSWITCH=all` fuerza estado efectivo
   `off` para todas las features no-core. No se persiste; se refleja en health
   como `globalPaused:true`.
2. **Override de entorno:** `FEATURE_<ID>=off|shadow|on` (ID en mayúsculas, `-`
   y `.` se convierten en `_`; p. ej. `FEATURE_THEME_LIGHT=shadow`) gana a
   `settings.features.modes`.
3. **Settings:** `POST /api/features/:id {mode}`.
4. **Default:** `off`.

Una pausa individual (`settings.features.paused[]`) o global
(`settings.features.globalPaused`) deja el estado efectivo en `off` **aunque**
settings o el entorno digan `on`/`shadow`.

## Helpers de consumo

```js
import {
  getMode, isOn, isShadow, assertOn, runShadow,
  pause, resume, pauseAll, resumeAll
} from '../features/registry.mjs';
```

- `getMode(id)` → `off|shadow|on` efectivo (pausa/killswitch incluidos).
- `isOn(id)` / `isShadow(id)` → booleanos efectivos.
- `assertOn(id)` → lanza `409 FEATURE_PAUSED` si está pausada y
  `409 FEATURE_OFF` si no está `on`; devuelve la vista de la feature.
- Un feature pausado **nunca** debe consumirse: el consumidor debe llamar a
  `assertOn` (o comprobar `isOn`) al entrar.

Errores de consumo:

| code | status | cuándo |
|---|---:|---|
| `FEATURE_UNKNOWN` | 404 | id fuera del catálogo |
| `FEATURE_PAUSED` | 409 | pausa individual/global/killswitch |
| `FEATURE_OFF` | 409 | modo efectivo off o shadow |
| `FEATURE_NOT_SHADOW` | 409 | `runShadow` fuera de shadow |
| `FEATURE_INVALID_MODE` | 400 | mode distinto de off/shadow/on |

## `runShadow(id, fn, compare)`

Ejecuta una comparación en modo shadow **sin efectos de negocio**:

```js
const { result, diff } = await runShadow(
  'lingo',
  async (shadow) => {
    // shadow.send() es no-op; shadow.store.get() devuelve una copia.
    const sent = await shadow.send({ to: 'x@example.com', body: 'no sale' });
    return { text: normalizar('texto'), sent };
  },
  (result) => (result.text === esperado ? null : { esperado, obtenido: result.text })
);
```

- Requiere modo efectivo `shadow`; si está pausada lanza `FEATURE_PAUSED`.
- `shadow.send()` devuelve `{ok:true,skipped:true,shadow:true}` y no toca canales.
- `shadow.store` es una copia de solo lectura; no expone `mutate`.
- No escribe el store ni el ledger. Si `compare` devuelve algo distinto de
  `null`/`undefined`, la diferencia se guarda en el log en memoria
  (`shadowLog()`, máximo 100) y se registra con `log('warn', …)`.
- El retorno es `{feature, mode:'shadow', result, diff, effects:false}`.
- La función de shadow debe usar el contexto entregado; si llama a un emisor
  global por fuera del contexto, el registro no puede impedirlo. El set dorado
  debe verificar que no haya envíos/escrituras externos.

## API

Todas las rutas usan `auth:'default'`. `health` es público y conserva el health
de core, añadiendo `features`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/features` | lista `{items,count,summary}` con estado, override y pausa |
| GET | `/api/features/status` | resumen `{count,on,shadow,off,paused,globalPaused}` |
| POST | `/api/features/:id` | `{mode:"off\|shadow\|on"}`; validación estricta |
| POST | `/api/features/:id/pause` | pausa individual; `FEATURE_PAUSED` al consumir |
| POST | `/api/features/:id/resume` | reactiva la pausa individual |
| POST | `/api/features/pause-all` | kill switch lógico global |
| POST | `/api/features/resume-all` | quita pausa global e individuales |
| GET | `/api/health` | health de core + `features` |

`GET /api/features`:

```json
{
  "ok": true,
  "items": [
    {"id":"lingo","name":"Lingo","status":"off","mode":"off",
     "effectiveMode":"off","override":null,"paused":false,
     "pausedBy":null,"defaultMode":"off","consumers":["asistente"],
     "owner":"backend-core","description":"…"}
  ],
  "count": 12,
  "summary": {"count":12,"on":0,"shadow":0,"off":12,"paused":0,"globalPaused":false}
}
```

`GET /api/health` añade el mismo `summary` bajo `features`.

> **Nota de integración:** para no editar `core.mjs`, el módulo `features`
> registra una ruta wrapper `/api/health` con prioridad 300, captura el payload
> de core y lo reemite añadiendo `features`. Esto conserva la forma histórica de
> health, pero añade una entrada en `health.conflicts` y aumenta `health.routes`;
> el contrato de inventario de rutas debe sincronizarse en la tarea de contrato
> correspondiente.

Un `POST` de modo responde `{ok,item,summary}`; pausa/resume responde además
`paused`; pause-all/resume-all responde `{ok,paused,...summary}`.

Validación:

- `mode` es obligatorio y debe ser exactamente `off`, `shadow` u `on`
  (`FEATURE_INVALID_MODE`, 400).
- Cuerpo distinto de objeto o campo extra → 400.
- Feature desconocida → `404 FEATURE_UNKNOWN`.
- `allowAutonomousOutbound`/`allowDirectSend` **no** se administran aquí; viven
  en `settings.office` y tienen su propia auditoría (`office.settings`).

## Auditoría

Cada cambio real escribe en el ledger de la Oficina **antes** de persistir:

| acción | cuándo | payload |
|---|---|---|
| `feature.change` | cambio de modo | `{id,from,to,by}` |
| `feature.paused` | pausa/resume individual | `{id,paused,scope:"feature",by}` |
| `feature.paused` | pause-all/resume-all | `{scope:"all",paused,by}` |

Si el ledger no está disponible (`FEATURES_UNAVAILABLE`, 503) o falla el
append, `settings.features` no cambia. Un cambio al mismo valor no genera
entrada. Actor por defecto: `user` (o el usuario autenticado).

## Flujo de activación (obligatorio)

1. **Off:** la feature no se importa en el camino crítico o el consumidor
   devuelve `FEATURE_OFF`.
2. **Shadow:** se activa con `POST /api/features/:id {mode:"shadow"}` y se corre
   `runShadow` con la implementación nueva y `compare` contra la actual. La
   diferencia queda en `shadowLog`/logs; no hay escrituras ni envíos.
3. **Set dorado:** tests + selfchecks + smoke + contrato congelado; revisar el
   log de diferencias y el ledger.
4. **On:** solo entonces `{mode:"on"}`. Cualquier regresión → pausa individual o
   `pause-all` inmediato, luego `off`/rollback.

## Kill switch y pausa

- `POST /api/features/:id/pause`: pausa una feature `on`; su consumidor recibe
  `FEATURE_PAUSED`.
- `POST /api/features/:id/resume`: la reactiva (si no hay pausa global).
- `POST /api/features/pause-all`: pausa todas (globalPaused **y** `paused[]`
  completo, para que el estado sea observable).
- `POST /api/features/resume-all`: limpia pausa global e individuales.
- `FEATURES_KILLSWITCH=all`: apagado de emergencia por entorno; no requiere
  escritura y gana a todo. Al quitarlo, vuelve el estado persistido.

`settings.features.paused[]` es la fuente de pausa individual;
`settings.features.globalPaused` la pausa global. `health.features.globalPaused`
refleja ambas (incluido el kill switch de entorno).
