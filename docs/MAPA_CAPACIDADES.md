# Mapa de capacidades frente a Lark — Agenda Copilot P95

Comparación honesta entre lo que ofrece Lark (planes) y lo que **ya existe en esta app**. No se marca como hecho nada que no esté en el código.

**Leyenda:** **E** existe · **P** parcial · **M** falta.
**Prioridad:** P0 imprescindible · P1 pronto · P2 después.
**Wave:** ola de trabajo prevista (0 contratos y flags, 1 lingo+acl, 2 aprobaciones, 3 correo, 4 reuniones, 5 P1, 6 P2).

---

## 1. Mensajería

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Historial permanente | `thread`, `office.ledger` | E | — | — | Ledger con cadena SHA-256 |
| Hilos y contexto | `/api/thread` | P | P1 | 1 | Contexto y acuse; falta `@agente` |
| Traducción de mensajes | — | M | P1 | 5 | Depende de `lingo` |
| Grupos y supergrupos | — | M | P2 | 6 | — |
| Acuses de lectura | — | M | P2 | 6 | — |
| Modo restringido de grupo | — | M | P1 | 5 | Solo el jefe habla |

## 2. Correo

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Buzones y alias por registro | — | M | P0 | 3 | `facturacion@`, `predios@` |
| Reglas de flujo y enrutado | — | M | P0 | 3 | Condición → acción |
| Cuarentena | — | M | P1 | 3 | Revisión y liberación |
| Sin publicidad | n/a | E | — | — | App propia |
| Etiquetas y carpetas | — | M | P2 | 6 | Sobre API de Gmail |

## 3. Calendario y reuniones

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Reuniones largas y físicas | `/api/meetings`, `/api/travel` | E | — | — | ETA y conflictos Cali/Palmira |
| Meet | `/api/meetings` | E | — | — | Enlace en la reunión |
| Notas de reunión con IA | `docs` (acta) | P | P0 | 4 | Acta manual; falta captura |
| Transcripción con hablantes | — | M | P0 | 4 | — |
| Grabación | — | M | P1 | 4 | Requiere consentimiento |
| Subtítulos en vivo | — | M | P1 | 5 | — |
| Salas paralelas / votación | — | M | P2 | 6 | Meet no lo da nativo |
| Sala de espera | — | M | P1 | 5 | — |
| Reserva de salas físicas | `/api/travel` | P | P1 | 5 | Lugares; falta inventario de salas |
| Interpretación / webinar | — | M | P2 | 6 | Fuera de escala actual |

## 4. Documentos

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Word, Excel, PowerPoint | `/api/docs` | E | — | — | OOXML propio, validado |
| Plantillas y estilos | `/api/docs` | P | P1 | 5 | Plantillas base; falta aprender las tuyas |
| Bloques sincronizados | — | M | P1 | 5 | Referencia, no copia |
| Traducción de documentos | — | M | P1 | 5 | Depende de `lingo` |
| Control de versiones | — | M | P1 | 5 | `docver` sobre git |
| Tableros / mapas mentales | — | M | P2 | 6 | — |

## 5. Base de datos

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Tablas con vistas | — | M | P0 | 2 | `base` |
| Permisos por fila/campo | — | M | P0 | 1 | `acl` (diseñado en ACL.md) |
| Automatizaciones | `/api/workflows` | E | — | — | Señales y reglas |
| Límite de bucles y coste | — | M | P0 | 2 | `loop_guard` |
| Sincronía entre bases | — | M | P2 | 6 | — |
| Mini apps | — | M | P2 | 6 | — |
| Consulta en lenguaje natural | — | M | P1 | 5 | `ask-base` |

## 6. Conocimiento

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Lingo (léxico único) | `style`, ASR previsto | P | P0 | 1 | Hoy solo perfil de estilo; falta servicio |
| Wiki con árbol | — | M | P1 | 5 | — |
| Búsqueda con citas | `/api/research` | P | P1 | 5 | Web con citas; falta wiki |

## 7. Aprobaciones

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Centro de aprobaciones | `/api/office/proposals` | P | P0 | 2 | Bandeja real; falta SLA y delegación |
| Tipos sin código | — | M | P0 | 2 | `approval-types` en YAML |
| Panel de métricas | `/api/assistant` | P | P1 | 2 | P95 y métricas; faltan de aprobación |

## 8. Personas y cultura

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Tareas y compromisos | `/api/inbox`, `/api/agenda` | E | — | — | Captura → tarea |
| OKR | `data.okrs` | P | P2 | 6 | Datos presentes; falta vista |
| Asistencia y horario | — | M | P2 | 6 | — |
| Resumen semanal | `/api/assistant` | P | P2 | 6 | Métricas; falta narrativa |

## 9. Seguridad y organización

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| Log de administración | `office.ledger` | E | — | — | Append-only verificable |
| Auditoría consultable | `/api/office/ledger` | P | P0 | 2 | Lectura; faltan filtros y exportación |
| Etiquetas de seguridad | — | M | P0 | 1 | `público/interno/reservado` (ACL.md) |
| Permisos por registro | — | M | P0 | 1 | `acl` |
| Marca de agua | — | M | P1 | 5 | PDF y Office |
| Roles y separación jefe/operador | `/api/auth` | P | P0 | 2 | Sesión y modo; faltan roles |
| SSO | — | M | P2 | 6 | Keycloak/OIDC |
| Cifrado en móvil | — | M | P2 | 6 | — |
| Terceros de confianza | `/api/identity` | P | P2 | 6 | Contactos; falta política |
| Grupos dinámicos | — | M | P2 | 6 | — |
| Organigrama formal | `/api/office/roster` | P | P2 | 6 | 7 roles definidos |

## 10. Integración

| Capacidad | Dónde | Estado | Pri | Wave | Nota |
|---|---|---|---|---|---|
| API documentada | `docs/CONTRATO_API.md` | E | — | — | 28 secciones, 83 rutas |
| Conectores y webhooks | `/api/mcp`, `/api/channels` | P | P1 | 5 | MCP stdio/HTTP y webhook genérico |
| Proxy local | — | M | P1 | 5 | — |
| Proveedor de identidad propio | — | M | P2 | 6 | — |

---

## Resumen

- **Existe (E):** documentos Office, agenda y viajes, tareas, ledger, automatizaciones, API documentada, tema claro/oscuro.
- **Parcial (P):** hilos, aprobaciones, auditoría, identidad, plantillas, OKR, roles, conectores.
- **Falta (M):** lingo como servicio, acl, base, reglas de correo, captura de reuniones, wiki, SSO, grupos.

Ninguna fila marcada **E** es una promesa: cada una corresponde a un endpoint o módulo real de este repositorio. Las **M** se abordan en las olas descritas en [ESQUEMA.md](ESQUEMA.md) y en el plan de waves, siempre con flag, en sombra y con set dorado antes de activar.
