# Contrato backend ↔ CRM — versión 20261002

Contrato vivo entre `apps/api` (Fastify + Prisma) y `apps/web` (React + TypeScript).
Tipos en [packages/shared/types.ts](../packages/shared/types.ts); esquema en
[apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma); DDL y contrato de base
en [prisma/sql/20261002_crm_schema.sql](../apps/api/prisma/sql/20261002_crm_schema.sql) y
`…_contract.json`.

**Estado del código:** probado en local (636 pruebas offline, 14 de PostgreSQL/HTTP, 15 de
durabilidad, 55 comprobaciones de recorrido, 19 de web). **No desplegado** en este momento:
lo que corre en producción sigue siendo `298b32b` con el esquema `20261001`. Ver
[estado-despliegue-crm.json](estado-despliegue-crm.json) y el checklist de publicación.

## Autenticación y alcance

Todo `/v2/*` requiere `Authorization: Bearer <JWT>` válido, con `tenantId` explícito. Token
ausente, inválido o sin tenant: **401**. `ADMIN` y `SUPERVISOR` operan dentro de su tenant;
`VENDOR` accede a sus leads. Lecturas fuera del alcance: **404**, sin confirmar que el
recurso ajeno exista.

**Hito B2 — el tenant se declara en el login.** El login es el único punto sin token del que
no se puede derivar el tenant, así que el navegador lo manda:

| Petición | Parámetro | Efecto |
| --- | --- | --- |
| `GET /auth/vendors` | `?tenant=<slug>` | Lista solo los perfiles de esa empresa. Sin él, el tenant por defecto del despliegue. |
| `POST /auth/login` | `?tenant=<slug>` | El PIN se valida contra el vendedor de ESE tenant (con homónimos y PIN de 4 dígitos, sin esto había sesiones cruzadas). |

El front lo resuelve con `resolverTenant()` en [apps/web/src/api.ts](../apps/web/src/api.ts):
`?tenant=` en la URL → valor guardado en `localStorage` → `VITE_TENANT` del build.

La ficha del agente, el detalle/alta de campañas, la vista de métricasAmpliadas y el copiloto
requieren `ADMIN` o `SUPERVISOR` (**403** para vendedor). Reasignar también. Las imágenes y
medios siguen el alcance del lead y del tenant.

Un **401 cierra la sesión de verdad**: el front borra el token, avisa a la app (vuelve al
login), cancela consultas en vuelo y limpia la caché. Las claves de React Query llevan
`tenant:usuario` (`claveDeCache`), así que ninguna respuesta tardía de una sesión puede
pintar datos de otra.

## Entrada y salida durables (Hito A)

Tres tablas nuevas, aditivas, sin tocar las 19 existentes.

### `inbound_events` — bandeja de entrada

| Columna | Para qué |
| --- | --- |
| `tenant_id`, `provider`, `event_key` | **Clave única**: identidad estable del evento en el proveedor (para Cloud, el `wamid`). Es la deduplicación real: un replay devuelve la fila existente. |
| `payload` | Lo necesario para reintentar el turno sin volver a llamar a Meta (remitente, tipo, texto, `media_id`, anuncio, interactivo). |
| `estado` | `PENDING` → `PROCESSING` → `DONE` · `DISCARDED` · `FAILED`. Solo `PENDING` es recuperable. |
| `disponible_en` | Ventana de ráfaga (6 s) como **dato**, no como temporizador en memoria. |
| `claim_id`, `claimed_at` | Reclamo atómico del turno; si caduca, la recuperación devuelve la fila a `PENDING`. |

**Contrato con Meta:** `POST /webhook/cloud` persiste la entrada **antes** de responder. Si esa
escritura falla, responde **500** y Meta reintenta. Firma inválida o ausente: **401**,
fail-closed.

Reclamo del turno:
`UPDATE inbound_events SET estado='PROCESSING' … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`
sobre las filas `PENDING` de un lead ya vencidas. Dos workers no toman la misma fila.

### `outbound_messages` — outbox con resultado incierto

| Columna | Para qué |
| --- | --- |
| `estado` | `PENDING` (intención durable) · `SENDING` · `SENT` · `REJECTED` · `UNCERTAIN`. |
| `wa_message_id` | Identificador que devolvió Meta. Único en `messages`: es lo que permite reconciliar **sin reenviar**. |
| `message_id` | Fila de historial creada. Si Meta aceptó y este insert falla, la recuperación la crea por `wamid`. |
| `resuelto_por`, `resuelto_at` | Resolución manual de un incierto, con auditoría. |

Clasificación del resultado (`clasificarEnvio`), que decide qué se reintenta:

| Clase | Cuándo | Tratamiento |
| --- | --- | --- |
| `aceptado` | Meta devuelve `messages[0].id` | `SENT` + historial. |
| `rechazado` | 4xx o error de negocio de Meta | **Nunca** marcado como enviado, **nunca** reintentado solo. Queda con su código. |
| `no_enviado` | No se construyó la petición (sin credenciales, sin canal, parámetros) | Reintentable sin riesgo: vuelve a `PENDING`. |
| `incierto` | Timeout, caída, 5xx | **Nunca** se reenvía. Qeda visible para decisión humana. |

**No hay exactly-once y no se promete.** Meta **no ofrece clave de idempotencia** para
`POST /messages` (verificado en su documentación: la respuesta es siempre un envío nuevo; el
`wamid` sirve para terminar una conversación, no para deduplicar). Lo único que hace el
sistema es no empeorar la ambigüedad: lo dudoso queda `UNCERTAIN`, nunca duplicado a ciegas.

`GET /ready` publica el trabajo pendiente real: `{ status, database, durabilidad: { inbox, outbox } }`.

## Estado comercial: qué es hecho y qué es promesa (Hito A3)

`lead_state` gana `state_version`, `turno_id` y `turno_pendiente`.

| Momento | Qué se escribe |
| --- | --- |
| Recibe el mensaje | **HECHOS**: los slots sin prefijo `_` (nombre, distrito, producto, dirección, su horario). Se guardan siempre. |
| Antes de enviar | **AVANCE**: `turno_pendiente = { turnoId, stage, slots, pedido, cierre, escalado, compromiso, aviso }`. El `current_stage` **no** avanza. |
| Meta acepta el envío | `confirmarTurno`: aplica stage, pedido, cierre y dispara aviso al vendedor y compromiso. |
| Respuesta obsoleta, takeover o envío fallido | `descartarTurno`: limpia **solo** su `turnoId`. Los hechos se conservan. |

Concurrencia: `confirmarTurno` y `descartarTurno` exigen `where leadId + turnoId` y releen el
estado; un turno viejo que termina tarde no escribe nada (`turno_superado`) y no dispara
efectos.

**Lo que sigue exigiendo una persona:** pago, llamada confirmada (`call_confirmed`), cierre
(`post_close`) y el resultado comercial. El bot nunca los marca; se registran con el debrief
del vendedor (`call_events.outcome_tag`) y se leen de ahí.

## Bandeja de leads

| Operación | Respuesta |
| --- | --- |
| `GET /v2/leads` | Array legacy `LeadListItem[]` (compat). |
| `GET /v2/leads?limit&offset&q&stage&label` | `{ items, page: { limit, offset, hasMore, total } }`. |

`q`, `stage` y `label` se resuelven **en el servidor sobre toda la bandeja** y siempre
encima de `scopeWhere(user)`: un filtro nunca amplía el alcance. `total` es el número de leads
que cumplen el filtro, no el de la página, para que la interfaz pueda decir «3 de 412» con
verdad en vez de «ningún lead coincide». Una etiqueta fuera de `ETIQUETAS_VALIDAS` se ignora
(no se consulta un valor arbitrario). Límite por defecto 50, máximo 200.

## Campañas y ficha comercial

Sin cambios en el contrato de `PUT /v2/agent-config`, salvo que `force` queda explícito:
se envía **solo** en la petición que borra un dato existente y el operador confirmó, y no
desactiva la validación (un campo obligatorio sigue dando **400** con `force`).

Nueva ruta de métricas:

| Operación | Contrato |
| --- | --- |
| `GET /v2/metricas?dias=30` | `{ periodo, alcance, metricas[], resultadosConfirmados[], nota }`. Cada métrica: `clave, valor, unidad, definicion, fuente, disponible?, motivoSiNo?`. Alcance `tenant` para ADMIN/SUPERVISOR y `propio` para VENDOR. |

## Inbox de pantalla y bordes

`POST /v2/leads/:id/reply` sigue siendo `409` con `{ ventanaCerrada: true, plantilla, textoPendiente }`
fuera de la ventana de 24 h; ahora la intención de envío queda en `PENDING` (nada salió) en
lugar de una fila de historial. `sent`/`delivered`/`read`/`failed` siguen siendo estados
distintos; un rechazo nunca se registra como `sent`.

## Verificación

| Suite | Comando | Resultado local |
| --- | --- | --- |
| Backend offline | `npm run test:offline` (desde `apps/api`) | 636 / 636 |
| PostgreSQL + HTTP + migraciones | `npm run test:db` con `CRM_TEST_DATABASE_URL` | 14 / 14 |
| Durabilidad sobre PostgreSQL | `npm run test:db:hitoa` con `RUN_POSTGRES_TESTS=1` | 15 / 15 |
| Recorrido completo | `npm run recorrido` | 55 / 55 |
| Front tipos + build | `npm run build` (desde `apps/web`) | aprobado |
| Front lógica | `node --test "tests/*.test.mjs"` (desde `apps/web`) | 19 / 19 |
| Capturas | `npm run capturas` | 9 PNG en `docs/capturas/` |

`CRM_TEST_DATABASE_URL` debe ser **local**: las pruebas se niegan a ejecutar contra una base
que no sea `localhost`/`127.0.0.1`, y cada una crea y destruye su propia base.