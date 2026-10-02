# Contrato backend ↔ CRM

Snapshot del trabajo local de `codex/crm-prep`, revisado el 1 de octubre de 2026 (America/Lima). La BD real quedó verificada con `ready: true`, 19 modelos y 34 DDL aplicados atómicamente; una segunda aplicación necesitó cero sentencias. Evidencia: [estado-db-aplicacion.json](estado-db-aplicacion.json). El código todavía no está desplegado ni pusheado.

Fuente de tipos: [packages/shared/types.ts](../packages/shared/types.ts). Preparación y evidencia de la BD: [db-readiness.md](db-readiness.md).

## Autenticación y alcance

Todo `/v2/*` requiere `Authorization: Bearer <JWT>` válido, con `tenantId` explícito. Token ausente, inválido o sin tenant: **401**. `ADMIN` y `SUPERVISOR` operan dentro de su tenant; `VENDOR` accede a sus leads. Las lecturas fuera del alcance devuelven **404**, sin confirmar la existencia del recurso ajeno.

La ficha del agente, detalle/alta de campañas y copiloto requieren `ADMIN` o `SUPERVISOR` (**403** para vendedor). Reasignar también exige ese rol. Las imágenes y medios siguen el mismo alcance del lead y del tenant; conocer un ID o una ruta no concede acceso.

Implementación: [auth-guard.js](../apps/api/src/lib/auth-guard.js), rutas en [server.js](../apps/api/src/server.js).

## Ficha comercial y control de versión

| Operación | Contrato |
| --- | --- |
| `GET /v2/agent-config?campaignId=` | `{ campaignId, nombrePrograma, factSheet, agente, version }`. `campaignId` y `version` pueden ser `null` cuando no hay campaña seleccionable. Un ID explícito debe ser entero positivo. |
| `PUT /v2/agent-config` | `{ campaignId, version, factSheet?, agente?, force? }` → `{ ok, campaignId, version }`. `version` es la del GET; `force` es booleano opcional. |
| `POST /v2/agent-config/preview` | Valida el mismo borrador combinado que el guardado, sin escribir. Devuelve resultado, errores de contrato y configuración/precio cuando corresponde. |

El merge es **recursivo**: omitir conserva; objetos combinan sus campos; arrays y escalares reemplazan su valor completo. `undefined` no cambia nada. `null` solicita borrar el campo, no almacenar un valor comercial nulo.

```json
{
  "campaignId": 12,
  "version": 4,
  "factSheet": { "precio": { "monto": 90 } }
}
```

Ese parche conserva los otros campos de `precio` y de `factSheet`. Para borrar un dato existente se exige `force: true`; sin confirmación devuelve **409** con `codigo: "BORRADO_REQUIERE_CONFIRMACION"`. Un `null` sobre un campo ya ausente no representa una pérdida de datos. La confirmación no elimina la validación: borrar un campo obligatorio, incluso con `force`, devuelve **400**. Un borrador sin cambios aplicables también se rechaza.

- Sin `version`: **428**. Versión no entera: **400**.
- Versión desactualizada: **409** con `{ error, version, factSheet, agente }` vigentes. Es distinto del 409 que exige confirmar una eliminación.
- La actualización usa un predicado atómico `id + tenantId + version` e incrementa la versión. No basta comparar versiones antes de escribir.
- Tanto preview como guardado rechazan claves `__proto__`, `constructor`, `prototype`, objetos no planos y anidamiento excesivo. El precio se valida como valor completo, sin aceptar un número parcial dentro de texto inválido.

Implementación: [flow.js](../apps/api/src/api/flow.js), [campaign-schema.js](../apps/api/src/config/campaign-schema.js).

### Requisitos para el editor

Conservar el borrador ante 400/409/428 y mostrar el error del servidor. El 409 de versión permite recargar y combinar; no debe reintentar automáticamente con la versión nueva y sobrescribir cambios de otro operador. La eliminación requiere una confirmación específica y enviar `force: true` solo para esa solicitud.

Capturar `campaignId`, versión y revisión del borrador al guardar. Una respuesta tardía de otra campaña no debe reemplazar la campaña seleccionada; una edición hecha durante el guardado debe seguir marcada como pendiente. El editor actual protege esas condiciones y evita guardados duplicados; la interfaz de confirmación de borrados debe integrarse con el contrato `force` antes de ofrecer esa acción.

## Campañas y flujos

`GET /v2/campaigns` lista programas del tenant; `GET /v2/campaigns/:id` entrega el detalle para el editor. `POST /v2/campaigns` permite crear un borrador parcial. La activación exige ficha válida y pasos válidos; una campaña normal requiere al menos un trigger. **La campaña default puede activarse sin triggers** si tiene `atribucion.esCampanaDefault: true` y su mensaje de descubrimiento válido.

La activación se limita al vendedor seleccionado. No cambia silenciosamente las campañas activas de otros vendedores. Los cambios de ficha usan versión; un cambio de metadatos no debe tratarse como si hubiera guardado la ficha comercial.

Los pasos admitidos son `MSG`, `FOLLOWUP` y `NOTIFY`, con un máximo de 50. Los mensajes tienen máximo de 2000 caracteres y `followupHrs`, cuando se proporciona, debe ser entero positivo. Los endpoints legacy de campañas siguen protegidos y aplican validación/versionado donde corresponde. Borrar una campaña con historial o default requiere la confirmación explícita prevista por ese endpoint; no reutilizar `force` de la ficha como permiso general de borrado.

## Inbox y timeline

| Operación | Respuesta / uso |
| --- | --- |
| `GET /v2/vendors` | Vendedores del mismo tenant para asignación. |
| `GET /v2/leads` | Array compatible; al usar `limit`/`offset`, `{ items, page: { limit, offset, hasMore } }`. Límite por defecto 50 en ese modo, máximo 200. |
| `GET /v2/leads/:id` | Detalle del lead dentro del alcance del usuario. |
| `GET /v2/leads/:id/conversation?limit=300&before=...` | `{ leadId, eventos, page }`, siempre paginado. |
| `GET /v2/leads/:id/media/:mediaId` | Medio autorizado para ese lead; no una URL pública general. |

La conversación tiene límite **300 por defecto**, incluso sin parámetros. Un límite positivo válido puede ampliarse hasta 1000. `page` contiene `{ limit, hayMas, cursorAntesDe, cursor }`; `cursor` es el nuevo cursor opaco y `cursorAntesDe` conserva compatibilidad ISO.

Los eventos se presentan en orden cronológico. El cursor nuevo desempata por fecha, tipo e ID, para que varios mensajes, estados o medios con la misma fecha no desaparezcan entre páginas. Pasar **`page.cursor` intacto** como `before`; no decodificarlo, reconstruirlo ni sustituirlo por el timestamp. Un `before` inválido devuelve **400**. El ISO legacy sigue aceptado, pero no aporta el desempate del cursor opaco.

Cada evento actual tiene ID estable con prefijo (`message:`, `media:` o `state:`). El tipo compartido conserva `id?` por compatibilidad. `kind: "message"` usa `texto: string | null`: un medio huérfano puede generar un evento sin texto. Renderizar `media` aunque `texto` sea `null`, sin mostrar la palabra «null» ni descartar el evento.

El Inbox actual carga historial anterior, deduplica por ID y conserva el cursor más antiguo al refrescar la página reciente. Al combinar páginas, una página antigua no debe sobrescribir un recibo actualizado (`estado`, `estadoDetalle`). El polling reciente conserva los eventos ya cargados; no equivale a volver a consultar todos los recibos del historial antiguo. Las respuestas de un lead no pueden incorporarse a la caché de otro. Conservar el anclaje de scroll al insertar eventos anteriores.

Implementación: [inbox.js](../apps/api/src/api/inbox.js), [Conversation.tsx](../apps/web/src/Conversation.tsx), [conversation-history.ts](../apps/web/src/conversation-history.ts).

## Responder, reabrir y controlar el lead

`POST /v2/leads/:id/reply { texto }` exige texto no vacío y máximo 4096 caracteres. La respuesta se envía por el canal propio del tenant; si falta o no corresponde, devuelve **409**. Solo un envío exitoso persiste el mensaje y toma control `HUMAN_ACTIVE`; un fallo de envío no debe presentarse como mensaje enviado ni borrar el borrador.

Para Cloud, una ventana cerrada devuelve **409** con `ventanaCerrada: true`, `plantilla` y `textoPendiente`. `POST /v2/leads/:id/reabrir` envía la plantilla configurada para ese canal y tenant. **Enviar la plantilla no abre por sí solo la ventana de texto libre: se espera la respuesta del lead.** La UI debe indicar «plantilla enviada; esperando respuesta» y conservar el texto pendiente.

Las credenciales Cloud se resuelven por número/canal. Un número ajeno no hereda el token del número configurado en el entorno. La plantilla está en `canal.credenciales.templates.reapertura` (nombre o `{ nombre, idioma }`); el idioma puede estar en `templateIdioma`. El fallback de plantilla del entorno solo corresponde al tenant activo del despliegue. Un canal o plantilla no disponible produce un error claro; no usar la plantilla de otro cliente como fallback.

Otras acciones: `POST /v2/leads/:id/mode` admite `HUMAN_ACTIVE` y `AUTO_CONSULTIVO`; `assign` reasigna con rol administrativo; `label` usa la taxonomía compartida; `debrief` y `debrief/save` preparan/guardan el resumen. `POST /v2/leads/:id/preview` describe la decisión del pipeline y el auto-resume. `POST /v2/flow/copilot` propone cambios; una propuesta no es un guardado ni una activación. Los caminos de IA/transcripción pueden depender de proveedores externos y no forman parte de las pruebas offline.

Implementación: [inbox-actions.js](../apps/api/src/api/inbox-actions.js), [config.js](../apps/api/src/whatsapp/cloud/config.js), [transporte.js](../apps/api/src/whatsapp/transporte.js).

## Recibos Cloud durables

Un callback puede llegar antes de que exista el mensaje saliente. Se guarda en `pending_cloud_receipts`, identificado por número de teléfono y `waMessageId`, con tenant y fecha de estado. Al persistir el mensaje se intenta conciliar; si no es posible, el pendiente permanece en BD.

La conciliación comprueba canal/tenant/número del mensaje, respeta el orden temporal y evita degradar `read` por un `delivered` atrasado. La eliminación del pendiente también compara el estado/fecha procesados para no borrar un callback más nuevo. Al arrancar el servidor se recuperan hasta 100 pendientes y se vuelve a intentar cada 60 segundos; `SOLO_LECTURA` omite esa recuperación con escrituras.

Esta durabilidad se refiere a **recibos**. La deduplicación general del webhook, debounce y algunas marcas de acciones siguen en memoria de proceso; no hay garantía distribuida para todo el flujo por disponer de esta tabla.

Implementación: [statuses.js](../apps/api/src/whatsapp/cloud/statuses.js), [server.js](../apps/api/src/server.js), [schema.prisma](../apps/api/prisma/schema.prisma). La tabla y `messages.cloud_phone_number_id` ya forman parte del esquema real verificado; cualquier otro destino debe verificarse antes de arrancar esta versión.

## Medios, validación y fuentes

Los assets comerciales registrados deben pertenecer al espacio del tenant y corresponder a archivos permitidos, con MIME/contenido y rutas válidas. No aceptar traversal ni convertir una ruta arbitraria del filesystem en una imagen comercial. Servir medios del lead requiere comprobar tanto el lead como el asset asociado. Un PDF no implica OCR automático.

Los schemas de transporte y la validación comercial son controles diferentes. Los schemas usados por Fastify deben ser código de la aplicación; la ficha enviada por el operador es **dato**, no un schema ejecutable. Las comprobaciones que dependen de BD/tenant se realizan en los controles del servidor, no convirtiendo contenido comercial en validadores dinámicos. Referencia oficial: [Fastify: validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## Verificación y siguiente etapa

Desde `apps/api`, la suite offline utiliza `tests/helpers/offline-guard.mjs`; el test real PostgreSQL es `tests/integration/crm-postgres.mjs` y requiere `CRM_TEST_DATABASE_URL` local explícita. Su cobertura incluye esquema fresco, upgrade aditivo, rollback, scopes HTTP, versiones/merge, empate de cursores y recibos durables. Omitirlo por falta de variable no constituye prueba de BD.

El frontend se comprueba con `npm run build` desde `apps/web` y `node --test tests/conversation-history.test.mjs` para la unión de páginas/recibos. Registrar el resultado de la ejecución actual; no inferir calidad por una cifra histórica de tests.

Para la siguiente etapa: revisar [db-readiness.md](db-readiness.md) y la evidencia final de aplicación, generar el cliente Prisma local compatible, y comprobar los casos 401/403/404/409/428, borrado confirmado, cambio de campaña durante save, timeline con fechas repetidas, medio sin texto y plantilla enviada sin ventana abierta. El gate de arranque rechaza un esquema incompatible; `/ready` es público, sin datos comerciales, y complementa la comprobación de proceso vivo. La preparación de la BD ya está verificada; el despliegue y push del código siguen pendientes.
