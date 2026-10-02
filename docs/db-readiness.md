# Preparación y verificación de la BD del CRM

Documento operativo para el trabajo local revisado el 1 de octubre de 2026 (America/Lima). **La BD real está preparada y verificada; el código todavía no está desplegado ni pusheado.** [Contrato del CRM](contrato-crm.md).

## Resultado final verificado

La evidencia vigente es [estado-db-aplicacion.json](estado-db-aplicacion.json), con `checkedAt: 2026-10-02T01:36:05.733Z` (UTC):

| Comprobación | Resultado |
| --- | --- |
| Readiness de la BD real | `ready: true`, 19 modelos verificados. |
| Aplicación | 34 DDL aplicados atómicamente (`productionWrites: true`). |
| Segunda aplicación | Cero sentencias pendientes/aplicadas. |
| Backup | Restaurado y verificado en una base local aislada. |
| Datos | Sin migración/conversión de datos; contenido comercial, mensajes y slots preservados en la copia de ensayo. |
| Proveedores de modelos | Cero llamadas API en esta operación. |
| Despliegue del código | No realizado; push también pendiente. |

El [plan-db-existente.sql](plan-db-existente.sql) conserva las 34 DDL como **plan histórico revisado**, no como script para volver a ejecutar a ciegas. Para otro destino se debe leer su catálogo y generar/verificar su propio plan. El backup real se mantiene privado, fuera del repositorio; no versionarlo ni compartirlo, porque contiene datos y credenciales.

### Lectura anterior, conservada como histórico

[estado-db-lectura.json](estado-db-lectura.json), fechado `2026-10-02T01:21:52.091Z` (UTC), fue la lectura previa sin escrituras: `ready: false`, 18/19 tablas y ausencia de `pending_cloud_receipts` y `messages.cloud_phone_number_id`, junto con diferencias de tipos/nulabilidad/defaults y objetos de integridad. **Ese resultado no es el estado actual**; la aplicación y verificación posterior lo reemplazan como evidencia vigente.

El schema Prisma se alineó con los tipos existentes mediante `@db.Timestamp(6)` y `@db.Timestamptz(6)`, `TurnTrace.turnId @db.Uuid` y el default de `mesActualInicio` con `date_trunc('month', now())`. Se preservaron los tipos y valores de datos. La PK histórica de leads (`leads_v2`) se reconoce por su estructura válida, sin renombrarla ni recrearla. Para `messages.createdAt` se aplicó `SET NOT NULL` después de comprobar cero valores NULL preexistentes. Los arrays existentes `NOT NULL` se aceptan sin relajar esa restricción.

## Contrato versionado

| Fuente | Función |
| --- | --- |
| [schema.prisma](../apps/api/prisma/schema.prisma) | Modelos del cliente instalado. |
| [20261001_crm_schema.sql](../apps/api/prisma/sql/20261001_crm_schema.sql) | DDL generado para un esquema vacío, calificado en `public`. |
| [20261001_crm_contract.json](../apps/api/prisma/sql/20261001_crm_contract.json) | Tablas, columnas, defaults, PK, índices, FK y hashes de schema/SQL. |
| [db-readiness-lib.js](../apps/api/scripts/db-readiness-lib.js) | Comparación del catálogo, plan aditivo, controles de tenant y transacción. |

El contrato actual contiene **19 modelos/tablas, 17 índices y 25 foreign keys: 61 sentencias DDL** para la base vacía. Las PK van dentro del `CREATE TABLE`. Un upgrade puede necesitar menos sentencias; una segunda aplicación compatible debe necesitar cero.

Incluye vendedores, campañas/triggers/pasos, leads/conversaciones/mensajes, pendientes Cloud, medios, configuración/estado/trazas, llamadas/compromisos/seguimientos/notificaciones, teléfonos de prueba, ajustes de tenant y canales. No incluye datos comerciales de prueba ni rellena configuraciones de clientes.

La instalación comprobada es **Prisma y `@prisma/client` 5.22.0**. Si el schema cambia, regenerar y revisar el SQL/JSON con la CLI local; no copiar opciones de una documentación de otra versión. `loadContract` rechaza hashes desactualizados (normaliza CRLF para esta comprobación).

## Scripts y modos

Ejecutar desde `apps/api`. Los scripts de preparación **no cargan `.env`** ni utilizan `DATABASE_URL` como fallback. Todo acceso a una BD exige `CRM_DATABASE_URL` explícita.

| Comando | Efecto |
| --- | --- |
| `node scripts/preparar-db-crm.js` | Plan offline del contrato; no conecta, escribe ni verifica una BD. `--sql` muestra el DDL completo. |
| `node scripts/preparar-db-crm.js --revisar` | Lee el catálogo y calcula el plan aditivo; no escribe. Una incompatibilidad detiene el plan. |
| `node scripts/preparar-db-crm.js --aplicar` | Aplica adiciones faltantes y el `SET NOT NULL` expresamente admitido para `messages.createdAt`, dentro de una transacción; verifica antes del commit. |
| `node scripts/preparar-db-crm.js --verificar` | Comprueba estructura y relaciones de tenant, sin escrituras. |
| `node scripts/verificar-db-crm.js` | Atajo siempre de verificación en lectura. |
| `node scripts/generar-contrato-db.js --actualizar` | Regenera SQL/JSON en archivos locales con Prisma 5.22; sin DB, `.env` ni API. |

`--revisar`, `--aplicar` y `--verificar` son excluyentes; `--sql` es opcional. El wrapper `verificar-db-crm.js` ya aporta `--verificar`: no agregar otro modo. Los wrappers `migrar-recibos.js` y `migrar-modo-canal.js` usan el mismo motor para sus perfiles; preparar solo un perfil no verifica el CRM completo.

```powershell
# Sustituir por credenciales de una base local de ensayo, no una base compartida.
$env:CRM_DATABASE_URL = 'postgresql://usuario_local:clave_local@127.0.0.1:55439/crm_ensayo'
node scripts/preparar-db-crm.js --revisar --sql
# Solo después de revisar el plan y verificar backup/restauración de la base destino:
node scripts/preparar-db-crm.js --aplicar
node scripts/verificar-db-crm.js
```

Los aliases actuales son `npm run db:plan`, `db:prepare`, `db:verify` y `db:contract`. No sustituir esta revisión de una base existente por `db:push`, un seed o ejecutar el SQL completo a ciegas.

## Controles antes de confirmar cambios

La comparación comprueba tipos, nulabilidad, defaults/secuencias, PK válidas, índices válidos/unicidad/columnas y FK válidas con destino y acciones de actualización/borrado. Una PK histórica se reconoce estructuralmente por columnas e índice válido/único aunque tenga otro nombre; índices secundarios y FK conservan los controles de definición del contrato. Las incompatibilidades existentes detienen el proceso: **no hay conversión de tipos, renombrado, DROP ni backfill comercial automático**. Una columna `NOT NULL` nueva sin default sobre una tabla ocupada requiere resolver sus datos explícitamente. La excepción explícita para reforzar `messages.createdAt` usa `SET NOT NULL`, que no modifica valores y falla si existen NULL.

`--aplicar` toma un advisory lock de transacción (`20261001, 1701`), configura `lock_timeout` de 10 segundos y `statement_timeout` de 60 segundos, aplica el plan y vuelve a leer el catálogo. Si falta algo, es incompatible o aparecen relaciones entre tenants/canales no resolubles, hace rollback. El lock coordina a estos scripts; no reemplaza la coordinación con otros operadores ni evita cualquier DDL externo.

`--revisar` calcula el plan, pero no sustituye la verificación completa de asociaciones de tenant. `--verificar` y `--aplicar` comprueban esas asociaciones y fallan sin declarar éxito. Los errores de conexión se sanitizan para no imprimir URLs/credenciales ni filas; código de salida distinto de cero significa que la preparación no está confirmada.

El gate [readiness.js](../apps/api/src/db/readiness.js) comprueba el schema antes de que el servidor escuche y falla con `CRM_SCHEMA_NOT_READY` si está incompleto/incompatible. Es de lectura, no una migración automática. `/ready` comprueba conectividad y muestra el estado de la base sin PII; un proceso vivo o un `/health` exitoso no equivale a readiness del CRM. El gate de arranque no sustituye la verificación de datos/tenant del script ni vuelve a inspeccionar todo el catálogo en cada `/ready`.

Las FK y sus acciones protegen integridad referencial; el tenant también requiere los controles de aplicación y la revisión de asociaciones. Referencia: [PostgreSQL 17: constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).

## Backup real antes de aplicar sobre datos existentes

Antes de autorizar una aplicación en una base con datos, identificar la base destino, tomar un **backup real**, comprobarlo y ensayar la restauración en otra base aislada. Guardar evidencia de fecha, destino, resultado y restauración sin credenciales. Un dump con tamaño positivo o `pg_restore --list` exitoso por sí solo no demuestra que restaure correctamente.

Ejemplo con herramientas PostgreSQL instaladas; apunta a la misma `CRM_DATABASE_URL` revisada:

```powershell
New-Item -ItemType Directory -Force -Path './backups' | Out-Null
$crmBackupPath = Join-Path './backups' ('crm-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
pg_dump --format=custom --dbname="$env:CRM_DATABASE_URL" --file="$crmBackupPath"
if ($LASTEXITCODE -ne 0) { throw 'Backup falló; detener preparación' }
pg_restore --list "$crmBackupPath"
if ($LASTEXITCODE -ne 0) { throw 'Backup no verificable; detener preparación' }
# Restaurar y validar en otra base aislada antes de la aplicación real.
```

El backup de esta aplicación sí se tomó y restauró localmente; su resultado y hash están en la evidencia final sin publicar su ubicación privada. Proteger el dump como dato sensible y mantenerlo fuera de Git. Preservar precios, fichas, slots, leads, mensajes, compromisos e historial; no ejecutar un seed de desarrollo contra la base existente. Un cambio necesario de datos/constraints fuera del plan admitido debe diseñarse y revisarse por separado.

### Historial de migraciones Prisma

Estos scripts preparan/comparan el catálogo; **no crean automáticamente un baseline en `_prisma_migrations`**. Para una BD existente con datos, el concepto de baselining consiste en registrar el punto inicial como ya aplicado para que las migraciones futuras no intenten recrearlo. Debe corresponder al catálogo real, al schema revisado y al backup.

Referencia conceptual: [Prisma: baselining](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/baselining). Esa página es de **v7**; aquí está instalada **5.22.0**. No ejecutar sus comandos o APIs sin comprobar compatibilidad con la CLI local y revisar el historial existente.

## Pruebas reales PostgreSQL, aisladas

[tests/integration/crm-postgres.mjs](../apps/api/tests/integration/crm-postgres.mjs) exige `CRM_TEST_DATABASE_URL` en `localhost`, `127.0.0.1` o `::1`. La URL administrativa puede apuntar a la base local `postgres`; el usuario necesita permisos para crear/eliminar las bases temporales.

El test crea nombres aleatorios `crm_smoke_*`, valida ese prefijo antes de crearlos/eliminarlos y termina sesiones solo de esas bases para limpiarlas. **No elimina la base administrativa `postgres`.** Los datos de prueba y el servidor HTTP quedan en esas bases aisladas; los clientes Prisma reciben la URL temporal explícita. El entorno de prueba excluye `.env` real y tokens de proveedores; el guard offline bloquea HTTP externo.

```powershell
# Desde apps/api. No usar una URL de producción ni una base comercial.
$env:CRM_TEST_DATABASE_URL = 'postgresql://usuario_local:clave_local@127.0.0.1:55439/postgres'
$env:DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:1/offline?connect_timeout=1'
$env:DOTENV_CONFIG_PATH = Join-Path (Get-Location) 'tests/fixture-no-env-file'
npm run test:db
# Equivalente:
# node --import ./tests/helpers/offline-guard.mjs --test tests/integration/crm-postgres.mjs
```

La suite verifica bootstrap de 61 DDL y segunda aplicación sin cambios, upgrade que preserva datos comerciales de prueba, rollback por incompatibilidad/tenant, gate de schema incompleto, autenticación y aislamiento HTTP, merge/null/versiones, activación, timeline con fechas idénticas/medios sin texto y recibos antes/después del mensaje. CI tiene PostgreSQL 17 y Node 24; se debe conservar el resultado de la ejecución concreta, no asumir que configurar CI implica haberla pasado.

Sin `CRM_TEST_DATABASE_URL` el test se omite: **skip no equivale a una prueba PostgreSQL aprobada**. Anotar fecha, versión PostgreSQL/Node y salida TAP sin publicar la URL. Un resultado local no certifica la preparación o disponibilidad de producción.

## Entrega para la siguiente etapa frontend

1. Tomar [estado-db-aplicacion.json](estado-db-aplicacion.json) como evidencia final y conservar la lectura/plan previos como histórico; la BD real ya tiene 19 modelos verificados y la segunda aplicación fue cero.
2. Generar el cliente Prisma con la versión local y conservar schema/SQL/contrato juntos. Para un destino diferente o un cambio posterior, repetir backup/restauración y `--verificar` sobre esa base.
3. Probar scopes por tenant/canal y una ficha real sin modificar sus datos comerciales: faltas de permisos no deben caer en un tenant por defecto.
4. Integrar merge recursivo, confirmación de `force`, conflictos de versión y respuestas tardías de otra campaña; paginar con `page.cursor`, IDs y `texto: null`.
5. Conservar los resultados de cada ejecución. El [cierre de esta revisión](cierre-backend-crm-2026-10-01.md) registra 611 pruebas offline, 11 de PostgreSQL/HTTP y 5 de historial, todas aprobadas, además del build web. La preparación de la BD está verificada; el código sigue pendiente de push y despliegue. Readiness del esquema no demuestra que la nueva versión de la aplicación ya esté operativa.
