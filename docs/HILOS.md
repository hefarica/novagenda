# Hilos por canal y acuses variados

El agente no debe responder «al último mensaje» como si no existiera nada antes.
Este módulo reconstruye el hilo de una conversación por `{channel, userId}`,
detecta qué queda pendiente y redacta acuses de gestión que no parezcan de bot.

Archivos:

```
lib/thread/context.mjs   contexto determinista + resumen opcional con LLM
lib/thread/ack.mjs       acuses 1–2 frases con variación de 7 días
lib/routes/thread.mjs    API /api/thread/*
lib/thread/selfcheck.mjs autocheck sin servidor
```

No se modifica `lib/channel/**`: el módulo solo **lee** el almacén persistido de
canales y expone funciones para que el pipeline y el agente lo importen.

---

## 1. De dónde sale el hilo

Fuente principal: `store.channelState.messages`, la bandeja normalizada que ya
escribe el subsistema de canales (máximo 300 mensajes, el más reciente primero).
Cada mensaje tiene:

```json
{
  "id": "MSG-0007",
  "channel": "simulator",
  "userId": "demo-hilo",
  "direction": "inbound|outbound",
  "text": "¿Me confirmas el total?",
  "timestamp": "2026-10-28T15:30:00.000Z",
  "status": "received|sent",
  "replyTo": null
}
```

Reglas de lectura:

- Se filtra por `channel` **y** `userId` exactos. Otra persona del mismo canal no
  contamina el hilo.
- Se ordena cronológicamente (del más antiguo al más reciente) y se toman los
  últimos `N` (por defecto 20, máximo 50).
- Si no existe `channelState.messages`, se intenta `channelState.inbox`; si
  tampoco, se degrada a **lista vacía** sin romper.
- `inbound` = habla el usuario/contacto; `outbound` = habla la oficina/agente.

Cada mensaje se devuelve como `{id, channel, userId, direction, who, text,
timestamp, status, replyTo}`, con `who` = `usuario` u `oficina`.

---

## 2. Estado del hilo

El estado es **determinista** (no depende del LLM):

| Estado | Cuándo |
|---|---|
| `pendiente_mío` | El último mensaje es del usuario y no hay respuesta nuestra después. Nos toca. |
| `pendiente_suyo` | El último mensaje es nuestro; esperamos su respuesta o confirmación. |
| `cerrado` | El último mensaje cierra el tema: «quedó resuelto», «damos por cerrado», «gracias, listo»… |
| `sin_historial` | No hay mensajes de ese contacto en ese canal dentro de la app. |

Notas:

- Una despedida con una petición nueva («gracias, pero necesito otra cosa») **no**
  cierra el hilo: queda `pendiente_mío`.
- «Gracias» solo, sin frase de cierre, no se considera cierre.
- Si el último mensaje nuestro hace una pregunta o pide algo, el estado es
  `pendiente_suyo` aunque no haya un cierre explícito.
- `sin_historial` es el cuarto estado de degradación; la API lo devuelve con
  `hasHistory: false` y un acuse neutro.

También se devuelve `stateReason` con la explicación legible y
`stateLabel` listo para UI.

---

## 3. Compromisos, temas y última intención

### Compromisos

Se detectan frases con verbos de compromiso en primera persona:

- «te envío», «te paso», «te confirmo», «te aviso», «te comparto», «te llamo»
- «lo reviso», «lo hago», «me encargo», «me ocupo», «quedo pendiente»
- «prometo», «me comprometo», «voy a», «haré», «entregaré»

Cada compromiso devuelve:

```json
{
  "text": "Te envío el contrato mañana a primera hora.",
  "who": "mío|suyo",
  "direction": "outbound|inbound",
  "messageId": "MSG-0004",
  "at": "2026-10-28T15:15:00.000Z",
  "due": "2026-10-29",
  "dueTime": null,
  "dueLabel": "mañana"
}
```

- `who: "mío"` = lo prometió la oficina (mensaje `outbound`).
- `who: "suyo"` = lo prometió el contacto (mensaje `inbound`).
- El plazo se extrae del texto con el mismo parser de fechas/horas del agente
  («mañana», «viernes», «3 de noviembre», «a las 9»). Si no aparece, `due` es
  `null`.
- Se descartan preguntas y negaciones («¿te envío…?», «no prometo…»).
- `pendingMine` y `pendingTheirs` separan los compromisos por quién los debe.

### Temas

Se calculan por frecuencia de palabras significativas (sin fechas, IDs,
números ni palabras vacías). Se devuelven `topics` (array de etiquetas) y
`topicDetails` (con conteo), máximo 5.

### Última intención

Se toma el último mensaje **del usuario** (o el último si no hay inbound):

- `lastIntent`: `pregunta | solicitud | confirmación | compromiso | mensaje`
- `lastIntentText`: extracto de hasta 180 caracteres
- `lastIntentDetail`: `{type, text, direction, who, at}`

---

## 4. Resumen

Siempre se construye un **resumen determinista**:

> Hilo de 8 mensajes con demo-hilo en simulator. El hilo queda pendiente de su
> respuesta. Temas: anexo, contrato, precios. Última intención (pregunta):
> «¿Me confirmas el total?».

Si hay un proveedor LLM configurado, se intenta un resumen de 2–3 frases con
`llmComplete` (perfil `chat`, workflow `thread-summary`, deadline 6 s). Si falla
o no hay proveedor, se usa el determinista. En la respuesta:

- `summary`: el texto elegido
- `summarySource`: `llm` o `determinista`
- `summaryFallback`: el extracto determinista, siempre disponible
- `usedLlm`: booleano

Privacidad: al LLM solo se envían los mensajes del hilo, el estado y los
compromisos detectados; nunca secretos ni credenciales. Sin proveedor no hay
ninguna llamada de red.

---

## 5. Acuses variados

`composeAck()` devuelve 1–2 frases de «gestión en curso», sin detalle del
asunto, con un plazo **procesal** creíble («hoy mismo», «en el transcurso del
día», «en el próximo rato»). No promete la entrega del trabajo.

Reglas duras:

1. Nunca repite la misma fórmula con el mismo contacto en **7 días**.
2. Nunca copia fechas, horas, días de la semana ni plazos de la intención del
   usuario. Si el jefe dice «prometo entregar el viernes», el acuse **no**
   repite «viernes» ni una fecha.
3. Nunca revela IDs internos (`AG-…`, `TK-…`, `IN-…`, `MSG-…`), enlaces ni
   datos del store.
4. Sin historial usa fórmulas neutras («Gracias por escribir; lo estoy
   gestionando…»), no fórmulas que presupongan un hilo previo.
5. Urgencia `baja|normal|alta|urgente` cambia el tono sin cambiar las reglas.

La ventana anti-repetición reutiliza `lib/style/variation.mjs` (tipo `acuse`) y
persiste en `data.style.variations` con `contact = userId`, `register = channel`.
Si el store está en solo lectura, el acuse se devuelve igual (`recorded:false`).

Ejemplos de tres acuses seguidos al mismo contacto:

1. «Recibí tu mensaje; lo estoy gestionando y te confirmo el estado hoy mismo.»
2. «Quedo con esto. En el transcurso del día te paso una actualización.»
3. «Lo tengo en cuenta; te aviso en cuanto tenga novedades, hoy si es posible.»

---

## 6. API

Todas las rutas usan la autenticación normal de la app (`auth: 'default'`) y se
auto-descubren desde `lib/routes/thread.mjs` (priority 120).

### `POST /api/thread/context`

```bash
curl -s -X POST http://127.0.0.1:3000/api/thread/context \
  -H 'content-type: application/json' \
  -d '{"channel":"simulator","userId":"demo-hilo","limit":20}'
```

```json
{
  "context": {
    "channel": "simulator",
    "userId": "demo-hilo",
    "messages": [ ... 8 mensajes ... ],
    "messageCount": 8,
    "hasHistory": true,
    "state": "pendiente_suyo",
    "stateLabel": "Pendiente de su respuesta",
    "stateReason": "nuestro último mensaje pide algo o hace una pregunta",
    "commitments": [ ... ],
    "pendingMine": [ ... ],
    "pendingTheirs": [ ... ],
    "topics": ["anexo", "contrato", "precios"],
    "lastIntent": "pregunta",
    "lastIntentText": "Buenísimo. ¿Me confirmas el total?",
    "summary": "Hilo de 8 mensajes…",
    "summarySource": "determinista",
    "summaryFallback": "…",
    "usedLlm": false,
    "sources": [ ... ]
  },
  "summary": "…",
  "usedLlm": false,
  "sources": [ ... ]
}
```

`limit` admite 1–50. Sin historial: `messageCount: 0`, `hasHistory: false`,
`state: "sin_historial"`.

### `POST /api/thread/ack`

```bash
curl -s -X POST http://127.0.0.1:3000/api/thread/ack \
  -H 'content-type: application/json' \
  -d '{"channel":"simulator","userId":"demo-hilo","intent":"prometo entregar el viernes","urgency":"normal"}'
```

```json
{
  "context": { ... },
  "ack": "Recibí tu mensaje; lo estoy gestionando y te confirmo el estado hoy mismo.",
  "ackMeta": {
    "urgency": "normal",
    "neutral": false,
    "replaced": false,
    "synthesized": false,
    "exhausted": false,
    "windowDays": 7,
    "recorded": true
  },
  "usedLlm": false,
  "sources": [ ... ]
}
```

`ack` es el texto listo para enviar. `urgency` acepta `baja|normal|alta|urgente`
(y alias `low/high/urgent`). La ruta no espera al LLM: el contexto se construye
en modo determinista para responder rápido.

### `GET /api/thread/summary?channel=&userId=&limit=`

Mismos datos que `context`, más `summary` y `line` (resumen de una línea para
UI). Ejemplo de `line`:

> 8 mensajes · Pendiente de su respuesta · 3 compromisos nuestros

Errores de validación: `400 REQUIRED`, `400 OUT_OF_RANGE`,
`400 UNKNOWN_FIELD`, `400 INVALID_VALUE`/`INVALID_FORMAT`, con mensajes en
español.

---

## 7. Cómo se engancha (sin tocar `lib/channel/**`)

El agente o el pipeline pueden importar las funciones directamente:

```js
import { buildThreadContext } from '../thread/context.mjs';
import { composeAck } from '../thread/ack.mjs';

const context = await buildThreadContext({ channel, userId });

// 1) Para el prompt del agente: usar context.summary, context.state,
//    context.pendingMine, context.lastIntentText en lugar de solo el último texto.
// 2) Para responder de inmediato mientras se procesa:
const ack = await composeAck({ channel, userId, intent, urgency, context });
await sendChannelMessage(ack.text); // el canal existente, sin cambios
```

- `buildThreadContext({channel, userId, limit?, data?, useLlm?})` es de solo
  lectura.
- `composeAck({channel, userId, intent, urgency?, context?, data?, persist?})`
  persiste la variación salvo `persist:false` (útil en pruebas).
- En el agente, pasar el contexto al prompt y usar `pendingMine` para decidir si
  toca actuar; en el pipeline de canales, enviar `ack.text` como primer acuse y
  luego la respuesta completa.
- No se necesita ninguna modificación en `lib/channel/**` ni en el contrato de
  los mensajes.

---

## 8. Límites conocidos

- Solo hay historial **dentro de la app**: mensajes anteriores a la instalación
  o de conversaciones que nunca pasaron por un canal no existen aquí.
- El almacén conserva como máximo 300 mensajes recientes de todos los canales;
  si se supera, los más antiguos se pierden.
- El hilo se separa por `channel + userId`. La misma persona en WhatsApp y
  Telegram son dos hilos distintos salvo que se unifiquen los `userId` en la
  capa de identidad.
- El estado y los compromisos son heurísticas deterministas: no sustituyen la
  lectura humana cuando hay ambigüedad.
- El resumen LLM es opcional; sin proveedor no hay ninguna llamada de red.
- El acuse no confirma plazos de entrega: solo avisa de que el trabajo está en
  curso y cuándo habrá una actualización.
- La ventana anti-repetición es por contacto (`userId`), no por hilo; el mismo
  contacto en dos canales comparte fórmulas para no repetirse.

---

## 9. Autocheck

```bash
node lib/thread/selfcheck.mjs
```

Comprueba sin servidor ni LLM: contexto de 8 mensajes, estados
`pendiente_suyo`/`pendiente_mío`/`cerrado`, compromisos con plazo, temas,
última intención, tres acuses distintos al mismo contacto, ausencia de fechas
prometidas y de IDs internos, degradación sin historial y rutas montadas.
Salida esperada: `AUTOCHECK PASS 24/24`.
