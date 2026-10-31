# Matriz de integración del modelo Excel → App

| Hoja del modelo | Implementación en Agenda Copilot |
|---|---|
| `00_HOME` | Dashboard ejecutivo, Top 3, ejecución, foco, vencidas, actividad reciente e integraciones. |
| `01_INBOX` | Inbox Universal, captura rápida desde App/WhatsApp/Telegram y estado procesado. |
| `02_AGENDA` | Agenda Maestra CRUD, prioridad, foco, contexto, recordatorio, estado y sincronización Google. |
| `03_RECURRENCIAS` | Motor de materialización automática diaria/semanal/mensual/trimestral/laborables. |
| `04_REUNIONES` | Cadencias activables; una reunión recurrente genera compromisos con propósito y salida. |
| `05_OKR` | Vista OKR con progreso, confianza, prioridad y próxima acción. |
| `06_METRICAS_DIARIAS` | Snapshot diario: foco plan/real, agenda plan/hecho, reuniones, plan/cierre/revisión. |
| `07_REPORTES` | Resumen semanal y mensual P95 generado por el backend. |
| `08_DASHBOARD` | Home crystal-glass responsive con KPIs del día. |
| `09_MOBILE` | Comandos HOY, CAPTURA, HECHO, POSPONER, FOCO, CIERRE, SEMANA + lenguaje natural. |
| `10_AUTOMATIZACION` | Recordatorios, brief 06:30, chequeo 12:00, cierre 17:30 y reporte viernes 17:45. |
| `11_APPS_SCRIPT` | Reemplazado por backend Node.js con webhooks, APIs y persistencia segura. |
| `12_CONFIG` | Ajustes de jornada, duración, recordatorios y metas internas P95. |
| `13_DOCUMENTACION` | README, seguridad, instalación, OAuth, webhooks, despliegue y límites externos. |

## Regla canónica de agenda

1. Toda nueva cita pasa por detección de conflictos.
2. La detección combina Agenda Maestra local + Free/Busy de todos los calendarios Google seleccionados.
3. Si existe choque, el asistente no crea la cita: propone hasta 3 alternativas.
4. En WhatsApp/Telegram el usuario puede responder `1`, `2` o `3` para confirmar.
5. Si no hay choque, la cita se crea y, si Google está conectado, se sincroniza al calendario configurado.
6. Las agendas Google externas se muestran juntas en Agenda Maestra, identificadas como `EXT`.

