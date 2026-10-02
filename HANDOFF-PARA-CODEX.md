# HANDOFF PARA CODEX — CRM v1 cerrado (código local, sin publicar)

**Fecha:** 2 de octubre de 2026 · **Rama:** `codex/crm-v1-cierre` · **Base:** `298b32b`
**Commits:** `853af4d` (Hito A + B1–B3), `6990585` (métricas, tenant en login, recorrido)

> **Nada de esto está desplegado.** Lo que corre en producción sigue siendo `298b32b` con el
> esquema `20261001`. Este handoff describe código **probado en local** contra PostgreSQL real.

---

## 1. Qué queda cerrado

### Backend operativo v1 (Hito A)

| Punto | Qué se implementó | Dónde |
| --- | --- | --- |
| **A1** Recepción recuperable | La entrada autenticada y routeada se escribe en `inbound_events` **antes** de responder el webhook; si falla, **500** y Meta reintenta. Identidad estable `(tenant, provider, wamid)` con índice único → el replay no crea una segunda fila. La ráfaga se agrupa con la columna `disponible_en` (6 s), no con un `setTimeout`. El reclamo del turno es atómico (`FOR UPDATE SKIP LOCKED`) → dos workers no lo procesan dos veces. Estados `PENDING/PROCESSING/DONE/DISCARDED/FAILED`, reintentos con backoff y recuperación de reclamos caducados al arrancar y cada 60 s. | `src/webhook/inbox.js`, `src/whatsapp/cloud/router.js`, `src/server.js` |
| **A2** Envío y registro recuperables | La intención se persiste **antes** de llamar a Meta. El resultado se guarda en la misma fila: `SENT` (con `wamid`), `REJECTED` (con el código de Meta, nunca marcado como enviado, nunca reintentado solo) o `UNCERTAIN` (timeout/caída/5xx: **nunca** se reenvía, queda visible). Si Meta acepta y falla el insert, la recuperación crea el historial por `wamid` **sin reenviar**. | `src/whatsapp/outbox.js`, `src/webhook/handler.js`, `src/api/inbox-actions.js` |
| **A3** Estado comercial coherente | Los **hechos** que dijo el lead (nombre, distrito, producto, dirección) se guardan siempre. Los **avances** que dependen de que el cliente reciba la respuesta (subir de etapa, registrar el pedido, avisar al vendedor, crear el compromiso) viven en `lead_state.turno_pendiente` y se confirman con `confirmarTurno` solo tras la aceptación de Meta. Un descarte limpia solo su `turnoId`. | `src/brain/brain-pipeline.js`, `src/webhook/handler.js` |
| **A4** Defensas y consumo | Media conservada pero **no transcrita ni descrita** con humano delante o pausa; `PAUSED` ya no se reescribe por un comprobante ni recibe acuse. `followupEngine` filtra elegibilidad **antes** del `LIMIT`, reserva el trabajo con candado atómico en BD y revalida modo/pedido/archivo antes de enviar (también en recordatorios de compromiso). Las promesas prohibidas se **neutralizan o escalan** en vez de solo registrarse. Turnos atendidos y turnos con IA se cuentan por separado (`turnos_ia_mes_actual`). El copiloto ya no inventa un costo: muestra los tokens que devolvió el proveedor. | `src/motor/followupEngine.js`, `src/webhook/comprobante.js`, `src/brain/agent-brain.js`, `src/api/inbox-actions.js` |
| **A5** Contrato y cierre | Migración aditiva `20261001 → 20261002` (22 modelos), contrato regenerado, dos comprobaciones nuevas de aislamiento tenant (entrada y salida), `/ready` publica el trabajo pendiente real. | `prisma/`, `scripts/db-readiness-lib.js`, `src/server.js` |

### CRM v1 utilizable (Hito B)

| Punto | Qué se implementó |
| --- | --- |
| **B1** Riesgos de integración | El 401 cierra la sesión de verdad (vuelve al login, cancela consultas, limpia caché). Las claves de React Query llevan `tenant:usuario`. El borrador **pertenece a su lead** (`drafts.ts`) y el envío se amarra al lead con el que arrancó: escribir para A y enviar a B ya no puede ocurrir. El editor guarda borrador por campaña, ignora respuestas obsoletas del copiloto (campaña + revisión) y conserva lo escrito durante un guardado. |
| **B2** Recorrido principal | Inbox paginado con **filtros en el servidor** y `total` real (antes se filtraba en el navegador la página cargada y se rotulaba «ningún lead coincide» siendo falso). Conversación con cursor, medios privados y recibos. Tomar/devolver control, etiquetas, reasignación, debrief. Estados de carga/error. Ventana de Meta cerrada: conserva texto, ofrece plantilla y muestra «esperando respuesta». **Login por empresa** (`?tenant=` / `VITE_TENANT`). |
| **B3** Configurar el bot desde el CRM | Crear campaña borrador, editar ficha desde BD, **validar con el servidor** (reemplaza al preview ficticio), disparadores, guion, activar. 409/428 sin perder borrador; el borrado exige confirmación y `force` solo en esa petición. Copiloto opcional: la edición manual funciona sin créditos de IA. |
| **B4** Gestión y aprendizaje | Resultado comercial desde `call_events` (pendiente, contactado, llamada, venta confirmada) separado de la etapa inferida, con «no disponible» cuando nadie registró nada. `GET /v2/metrics` con **definición y fuente por métrica** y «no disponible» con motivo. Pantalla de métricas. |

---

## 2. Qué ya permite vender

- Entrar → ver la bandeja paginada → buscar y filtrar sobre **toda** la lista → abrir una
  conversación con su historial, sus medios y los recibos de Meta.
- Responder (toma el control del bot), tomar/devolver control, etiquetar, reasignar, registrar
  el resultado de una llamada.
- Crear una campaña desde cero (borrador), darle su ficha comercial, decidir cuándo aplica,
  escribir su guion y **activarla**. La ficha queda en la base y la usa el cerebro.
- Ante una ventana de Meta cerrada: conserva el texto, ofrece la plantilla del tenant y
  espera la respuesta antes de habilitar texto libre.
- Ver qué se respondió, qué se rechazó, qué quedó incierto y qué resultado confirmó una persona.

## 3. Límites vigentes

- **Una instancia.** La coordinación por lead usa la BD (el reclamo es atómico), pero el
  flag de cron, el rate-limit del login y la deduplicación rápida siguen en memoria. Con
  varias réplicas hay que pasar esos tres a BD/Redis. Documentado, no implementado.
- **No hay exactly-once.** Meta no ofrece clave de idempotencia para `POST /messages`. Un
  envío con resultado incierto **no se reenvía solo**: requiere decisión humana.
- **Cuota sin cortar.** Los turnos siguen contando como antes (no se corta la atención); lo
  que se separó es la métrica de consumo real. Sin cambio de política comercial.
- **Fuera de esta versión:** inventario, facturación, cobros automáticos, marketplace,
  onboarding SaaS, plantillas en catálogo, canales y assets completos. Backlog en §6.

---

## 4. Evidencia de esta tanda

| Qué | Comando | Resultado |
| --- | --- | --- |
| Backend offline | `npm run test:offline` (apps/api) | **636 / 636** |
| PostgreSQL + HTTP + migraciones | `npm run test:db` | **14 / 14** |
| Durabilidad sobre PostgreSQL | `npm run test:db:hitoa` (`RUN_POSTGRES_TESTS=1`) | **15 / 15** |
| Recorrido completo | `npm run recorrido` | **55 / 55** |
| Web: lógica | `node --test "tests/*.test.mjs"` (apps/web) | **19 / 19** |
| Web: tipos + build | `npm run build` (apps/web) | aprobado |
| Capturas con navegador | `npm run capturas` | 9 PNG en `docs/capturas/` |

PostgreSQL local: instalación efímera, puerto no estándar, bases desechables `crm_*` creadas y
destruidas por cada suite. **La base real no se tocó.**

**Consumo de modelos: 0 llamadas generativas, 0 USD.** Todo se probó con mocks, PostgreSQL
local y un proveedor de Meta ficticio en `localhost`. Las cadenas quedan sin tocar
(Luna → Laguna → Gemini → Mistral directo). `/health` usa salud almacenada: no es una prueba
de IA.

**Capturas** (`docs/capturas/`): login, inbox y conversación en escritorio (1440×900) y móvil
(390×844), sesión caducada (vuelve al login), configuración de campaña, métricas y
configuración en móvil.

---

## 5. Checklist de publicación

### Antes

1. [ ] **Backup de la base de producción** y anotar el punto de restauración.
2. [ ] Confirmar que `DATABASE_URL` apunta a la base real y que `CRM_DATABASE_URL` está
       definida **solo** para el comando de migración.
3. [ ] `npm run db:plan` (revisión offline, sin conectar) y revisar que solo hay `CREATE TABLE`,
       `ALTER TABLE … ADD COLUMN`, `CREATE INDEX` y claves foráneas. **Nada** de `DROP`,
       `INSERT` ni `TRUNCATE`.
4. [ ] `CRM_DATABASE_URL=… node scripts/preparar-db-crm.js --aplicar` (aditivo, atómico, con
       candado de concurrencia).
5. [ ] `CRM_DATABASE_URL=… node scripts/verificar-db-crm.js --verificar` → sin incidencias,
       incluidas las comprobaciones nuevas de tenant de entrada y salida.
6. [ ] Fijar el candidato: `git rev-parse HEAD` y anotar el commit.

### Variables de entorno (por nombre, sin valores)

| Variable | Dónde | Para qué | Estado |
| --- | --- | --- | --- |
| `CORS_ORIGINS` | API | Dominios del front autorizados. **Sin esto el navegador bloquea la API y la pantalla dice «no se pudo conectar».** | probablemente ya exista; **verificar** que incluye el dominio del CRM |
| `VITE_API_URL` | build del front | URL de la API | ya existe |
| `VITE_TENANT` | build del front | Empresa del CRM cuando el enlace no trae `?tenant=` | **nueva** |
| `CLOUD_GRAPH_BASE` | API | Solo pruebas locales (Graph falso). **En producción se deja sin valor.** | **nueva, opcional** |
| `DATABASE_URL`, `JWT_SECRET`, `CLOUD_APP_SECRET`, `CRON_SECRET`, `WEBHOOK_SECRET`, `BRAIN_PROVIDER`, `BRAIN_FALLBACKS` | API | Sin cambios | no tocar |

El tenant del login se toma de `?tenant=` en la URL → `localStorage` → `VITE_TENANT`. Si se
publica un enlace por cliente, incluir el parámetro: `https://…/?tenant=<slug>`.

### Después

7. [ ] `GET /health` → `ok` con el commit nuevo.
8. [ ] `GET /ready` → `status: ready`, `database.schemaVersion: "20261002"`,
       `database.models: 22` y `durabilidad` con `inbox` y `outbox`.
9. [ ] `POST /webhook/cloud` sin firma → **401**.
10. [ ] `GET /v2/metricas` con token ADMIN → **200**, cada métrica con `definicion` y `fuente`.
11. [ ] Entrar por el CRM con un vendedor de cada empresa: las bandejas deben verse distintas.
12. [ ] Enviar **un** mensaje de prueba a un número de pruebas: la entrada debe aparecer en
       `inbound_events` y el historial con su `wamid`. No enviar a clientes reales sin
       autorización explícita.

### Rollback

- **Código:** volver al commit anterior en Render. La aplicación es aditiva: el backend viejo
  ignora las tablas nuevas (no las lee).
- **Base:** las tablas y columnas nuevas **no afectan** al código viejo, así que la reversión
  de datos solo es necesaria si se decide retirar la funcionalidad. Restaurar el backup solo
  si hay que deshacer contenido escrito por el CRM nuevo.
- `/ready` es el gate: si el esquema no corresponde al código, el arranque falla con
  `CRM_SCHEMA_NOT_READY` en lugar de atender con un contrato incompatible.

---

## 6. Backlog (no impide operar este CRM v1)

1. **Varias réplicas:** mover a BD el flag de cron, el rate-limit del login y la deduplicación
   rápida. El resto ya coordina en BD.
2. **Resolución asistida de envíos inciertos:** hoy se ven y se cuentan; falta una pantalla
   para que el operador marque uno como enviado o descartado (la tabla ya tiene
   `resuelto_por`/`resuelto_at`).
3. **Compromisos y seguimientos:** los modelos existen (`Commitment`, `FollowupReservation`)
   y el motor funciona, pero no hay vista de trabajo del vendedor; solo se ven por métrica.
4. **Correcciones del operador para revisión:** no hay registro de "el bot dijo mal esto" que
   permita revisar después. La política de reentrenamiento **no** está definida y no se ha
   tocado ningún prompt en producción.
5. **Plantillas en catálogo:** se administran por scripts (`scripts/meta-plantillas.js`), no
   desde el CRM.
6. **Canales y assets:** `scripts/canal-cloud.js`; sin interfaz de administración.
7. **Paneles avanzados, billing SaaS, catálogo, canales y assets completos** quedan fuera de
   esta versión por decisión de alcance.
8. **Corrección de zona horaria:** los sellos de `messages.createdAt` son timestamp sin zona
   (desfase de ~5 h en cálculos en JS). El motor de followups lo hace en SQL a propósito, pero
   cualquier cálculo nuevo en JS debe hacerse en SQL o con cuidado.

---

## 7. Siguientes pasos concretos

1. **Revisión del diff** de `853af4d` y `6990585` (dos commits, sin historial reescrito).
2. **Backup y migración** siguiendo §5, con `db:plan` revisado a mano antes de aplicar.
3. **Despliegue** a un entorno de previsualización si existe; si no, directo con el checklist.
4. **Verificación post-despliegue** completa (§5, pasos 7–12).
5. **Decisión de negocio:** si el gasto de IA se quiere facturar por consumption real, hace
   falta leer la facturación del proveedor (OpenRouter) y guardarla; esta versión **no la
   inventa**.
6. **Prueba generativa real** (opcional, con autorización): máximo 3 turnos con Laguna S 2.1 y
   presupuesto ≤ USD 0.05, con estimación antes y registro después. Esta tanda **no la hizo**.