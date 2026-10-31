# Equipo interno del agente

Cuando pides algo con efectos —un correo, un WhatsApp, un Telegram, un documento,
una cita o una reunión— el agente **no responde solo**: antes consulta al equipo
de la oficina y te dice qué opina cada rol.

## Cómo funciona

```
tu instrucción
  → el agente interpreta la intención (LLM)
  → consulta interna: riesgo + rúbrica de los roles
  → ejecuta o crea la propuesta en la Oficina
  → te responde en lenguaje natural + una línea «Equipo: …»
```

- El riesgo se calcula con el **mismo motor** que usa la bandeja de propuestas
  (`lib/office/risk.mjs`): destinatarios externos, contactos nuevos, dinero,
  plazos, términos legales, adjuntos y canal.
- Cada rol opina con la **misma rúbrica** que verás en la propuesta
  (`lib/office/opinions.mjs`), así que el chat no promete nada distinto de lo que
  la Oficina evaluará al aprobar.
- Se consultan entre 2 y 4 roles según la tarea:

| Tarea | Roles que opinan |
|---|---|
| Correo / WhatsApp / Telegram | Jefe de Gabinete, Correspondencia, QA (+ Research si hay predios o actas) |
| Documento adjunto | Jefe de Gabinete, Correspondencia, Documentos, QA |
| Cita, reunión o Meet | Jefe de Gabinete, Agenda, QA |
| Tarea | Jefe de Gabinete, QA |
| Riesgo ≥ 6 | se añade Auditoría |

## Qué ves

En la respuesta del chat aparece una línea breve, por ejemplo:

> _Equipo: Jefe de Gabinete: Riesgo 5/10; 1 destinatario externo, 1 contacto nuevo. · Correspondencia: el correo va a un externo. · QA: 3 señales a revisar._

Y en la API, el campo `meta.team`:

```json
{
  "consulted": true,
  "level": "N2",
  "risk": { "score": 5, "flags": ["EXTERNAL_RECIPIENT", "NEW_CONTACT", "EXTERNAL_CHANNEL"] },
  "roles": [
    { "role": "correspondencia", "nombre": "Correspondencia", "verdict": "aprobar", "note": "…" }
  ]
}
```

## Límites honestos

- **Opiniones reales del modelo**: para tareas con efectos, hasta **3 especialistas**
  responden con el LLM en paralelo (una frase breve cada uno, con presupuesto de 6 s).
  Si el modelo no está disponible o se agota el tiempo, ese rol cae a la rúbrica
  determinista; nunca bloquea la tarea. `meta.team.source` indica `llm`, `mixed` o `rubric`.
- Coste/latencia: ~3 llamadas cortas por acción con efectos (≈5–9 s en total). Las
  conversaciones y las consultas de lectura no gastan estas llamadas.
- El lenguaje natural de la respuesta lo pone el LLM; la política la pone el
  motor. Si el LLM no está disponible, la respuesta baja a texto natural
  determinista y la consulta al equipo sigue funcionando.
- Nada sale sin aprobación: si la tarea produce un envío, se crea una propuesta
  en la Oficina y el chat te informa del ID.

## Prueba

```bash
node --env-file=.env scripts/verify-chat.mjs
```

Cubre 14 casos: charla natural, hora/fecha, comandos históricos, correo con
equipo, cita con Agenda y que una charla simple no añada ruido de equipo.
