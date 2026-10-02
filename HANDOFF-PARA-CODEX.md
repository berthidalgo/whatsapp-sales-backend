# HANDOFF PARA CODEX — CRM v1 cerrado y **publicado**

**Fecha:** 2 de octubre de 2026 · **Producción:** `a42df23` (PR #1, deploy `dep-davkl9eq1p3s73dd5rrg`, `live`)
**Esquema en producción:** `20261002`, 22 modelos · **Antes:** `298b32b` / `20261001`
**Rama de trabajo:** `codex/crm-v1-cierre` (6 commits, fusionados por squash)

> **Estado real:** el **backend** está publicado y verificado contra la base de producción. El
> **frontend del CRM no está desplegado en ningún sitio**: el workspace de Render solo tiene la
> API, no hay static site ni workflow de despliegue del front, y la API no sirve el CRM. Las
> mejoras de interfaz (login por tenant, bandeja paginada, borradores, campañas, métricas) están
> en el repo y comprobadas, pero **nadie las ve todavía**. Ver §5.1.

---

## 0. Qué se hizo al publicar

1. **Backup** de la base de producción antes de tocar nada:
   `C:\Users\HP\Documents\crm-backups\antes-de-20261002-2026-10-02T05-53-11.dump` (3.08 MB, 588
   objetos, verificado legible con `pg_restore -l`). Segundo punto de restauración tras migrar:
   `...-05-55-01.dump` (3.09 MB, 609 objetos).
2. **Migración** `20261001 → 20261002`: 19 sentencias aditivas, atómicas y con candado.
   **624 filas antes, 624 después.** Las tres tablas nuevas nacieron vacías. Cero borrados.
3. **Publicación** por PR #1 con los tres jobs de CI en verde, fusionado a `main` (Render despliega
   solo al fusionar).
4. **Verificación** contra el servicio real: todo correcto, 0 fallos (§5).

> Dos defectos **solo de CI** aparecieron al publicar y quedaron corregidos antes de fusionar:
> el ensayo de migración usaba `git show` sobre el commit base (el checkout de CI es superficial)
> y derivaba una ruta POSIX como si fuera de Windows. Los dos pasaban en local. El ensayo ahora
> fija el esquema anterior como archivo del repo y resuelve rutas con `fileURLToPath`.

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
| **B4** Gestión y aprendizaje | Resultado comercial desde `call_events` (pendiente, contactado, llamada, venta confirmada) separado de la etapa inferida, con «no disponible» cuando nadie registró nada. `GET /v2/metricas` con **definición y fuente por métrica** y «no disponible» con motivo. Pantalla de métricas. |

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
| **Ensayo de migración desde el esquema antiguo** | `npm run migracion:ensayo` | **35 / 35** |
| Web: lógica | `node --test "tests/*.test.mjs"` (apps/web) | **19 / 19** |
| Web: tipos + build | `npm run build` (apps/web) | aprobado |
| Capturas con navegador | `npm run capturas` | 9 PNG en `docs/capturas/` |

PostgreSQL local: instalación efímera, puerto no estándar, bases desechables `crm_*` creadas y
destruidas por cada suite. **La base real no se tocó.**

### El ensayo que importa antes de publicar

Un plan de migración generado sobre una base vacía no dice nada sobre una base con historia.
`npm run migracion:ensayo` hace lo contrario: levanta el esquema **anterior** (`20261001`, el que
corre hoy en producción), lo puebla con las 19 tablas llena de datos con forma de los reales
(vendedores, campañas con ficha, leads de dos empresas, mensajes con `wamid` y recibos de Meta,
`lead_state` con `_pedido` dentro de los slots, compromisos, followups, `turn_trace`,
notificaciones, media, canales, ajustes de tenant), aplica la migración y comprueba:

| Comprobación | Resultado |
| --- | --- |
| El plan no borra ni reconvierte nada | ✓ solo `CREATE` / `ADD COLUMN` / `INDEX` / FK |
| Ninguna tabla o columna nueva nace sin acotar por tenant | ✓ |
| Se aplica con candado y es idempotente | ✓ 19 sentencias; **la segunda pasada escribe 0** |
| Verificación completa del contrato | ✓ sin incidencias |
| Filas intactas en las 19 tablas | ✓ |
| La ficha comercial del cliente sigue idéntica | ✓ |
| Los slots siguen idénticos, incluido `_pedido` | ✓ |
| Los recibos de Meta no se pierden | ✓ 5/5 |
| Ninguna relación cruza empresas después de migrar | ✓ |
| **El cliente de Prisma viejo lee el estado igual** | ✓ |
| La bandeja rechaza el `wamid` repetido | ✓ `P2002` |

Ese penúltimo punto es la **vuelta atrás**: como la migración es aditiva, el código anterior
sigue funcionando contra el esquema nuevo. Volver atrás es revertir el código, no restaurar
la base. En CI es puerta obligatoria (`migracion:ensayo`).

**Consumo de modelos: 0 llamadas generativas, 0 USD.** Todo se probó con mocks, PostgreSQL
local y un proveedor de Meta ficticio en `localhost`. Las cadenas quedan sin tocar
(Luna → Laguna → Gemini → Mistral directo). `/health` usa salud almacenada: no es una prueba
de IA.

**Capturas** (`docs/capturas/`): login, inbox y conversación en escritorio (1440×900) y móvil
(390×844), sesión caducada (vuelve al login), configuración de campaña, métricas y
configuración en móvil.

---

## 5. Publicación: qué se ejecutó y cómo repetirla

> **Ya está hecho.** Esta sección queda como registro y como procedimiento reproducible para la
> próxima versión. Render despliega `main` automáticamente: revisar el diff y esperar CI en verde
> **antes** de tocar `main`.

### Lo que se ejecutó (2-oct-2026)

1. [x] **Revisión del diff**: 63 archivos. Barrido de secretos sobre el diff (no sobre el árbol):
       limpio; lo único detectado son credenciales de CI en `localhost` y el PIN `1234` de las
       bases desechables.
2. [x] **Backup** de la base de producción y punto de restauración anotado (§0.1).
3. [x] **Plan de migración** contra la base real (`--revisar`, solo lectura): 19 sentencias
       aditivas. El SQL no contiene `DROP`, `TRUNCATE`, `DELETE` ni `UPDATE`.
4. [x] **Migración aplicada** (`--aplicar`): `22 modelos; 19 sentencias aplicadas atómicamente`.
5. [x] **Verificación** (`--verificar`): `22 modelos; solo lectura`, sin incidencias.
6. [x] **Conteo de filas antes y después**: 624 → 624. Ninguna tabla previa cambió.
7. [x] **PR #1** con CI en verde (3 jobs) → fusionado a `main` como `a42df23`.
8. [x] **Despliegue** en Render: `dep-davkl9eq1p3s73dd5rrg`, estado `live`.
9. [x] **Verificación post-despliegue** contra el servicio real (abajo).

### Verificación post-despliegue (resultado real)

| Comprobación | Resultado |
| --- | --- |
| `GET /health` | ✓ 200, commit `a42df23`, versión `7.1.0` |
| `GET /ready` | ✓ 200, `status: ready` |
| `database.schemaVersion` | ✓ `20261002` |
| `database.models` | ✓ 22 |
| Durabilidad en `/ready` | ✓ `inbox` y `outbox` presentes, ambas en 0 filas |
| `POST /webhook/cloud` sin firma | ✓ 401 |
| `GET /v2/metricas` sin token | ✓ 401 |
| `GET /v2/leads` sin token | ✓ 401 (ruta presente) |
| `GET /v2/metricas` **con** token ADMIN | ⏳ **pendiente**: requiere entrar con un vendedor real. Los PIN están hasheados y no se recuperan. No se saltó la autenticación. |

### 5.1 Lo que falta para que el CRM se vea: el frontend

El backend está vivo; **la interfaz no está alojada en ninguna parte**. Concretamente:

- El workspace de Render tiene **un solo servicio** (la API). No hay static site.
- No hay workflow de despliegue del front en `.github/workflows`, ni configuración de Vercel,
  Netlify o Cloudflare Pages en el repo.
- La API no sirve el CRM: en `/` responde la web pública del negocio.

Para ponerlo en pie hace falta, en este orden:

1. **Elegir dónde alojar el front** y crear ese servicio (Render static site sirve y deja todo en
   el mismo sitio y en el mismo panel).
2. Definir en el build del front: `VITE_API_URL=https://whatsapp-sales-backend.onrender.com` y
   `VITE_TENANT` con la empresa por defecto (hoy `ACTIVE_TENANT=bioayur` en la API).
3. **Configurar `CORS_ORIGINS` en el servicio de la API** con el dominio del front. **Hoy no
   existe esa variable** y en producción localhost no se permite: sin ella el navegador bloquea
   la API y la pantalla dice «no se pudo conectar».
4. Publicar el front y repetir la verificación de §5 entrando con un vendedor de cada empresa.

### Procedimiento para la próxima versión

1. [ ] **Revisar el diff completo**: `git log --oneline <base>..HEAD` y
       `git diff <base>..HEAD -- apps/api/src apps/api/prisma`.
2. [ ] **CI en verde** en la rama: incluye el ensayo de migración (§4), que es la única forma
       de saber que la base con historia aguanta el salto.
3. [ ] **Backup** de la base de producción y anotar el punto de restauración.
4. [ ] `npm run db:plan` (revisión offline, sin conectar): solo `CREATE TABLE`,
       `ALTER TABLE … ADD COLUMN`, `CREATE INDEX` y FK. **Nada** de `DROP`, `INSERT` ni `TRUNCATE`.
5. [ ] `CRM_DATABASE_URL=… node scripts/preparar-db-crm.js --aplicar` (aditivo, atómico, con
       candado de concurrencia). Debe reportar el número de sentencias nuevas; si aplicara 0, la
       base ya estaba al día.
6. [ ] `CRM_DATABASE_URL=… node scripts/verificar-db-crm.js --verificar` → sin incidencias.
7. [ ] **Contar filas antes y después** de la migración. Este paso no es opcional: es el que
       detecta que una migración «aditiva» perdió algo.
8. [ ] Fijar el candidato: `git rev-parse HEAD` y anotar el commit.

### Variables de entorno (por nombre, sin valores)

| Variable | Dónde | Para qué | Estado real |
| --- | --- | --- | --- |
| `CORS_ORIGINS` | API | Dominios del front autorizados. **Sin esto el navegador bloquea la API y la pantalla dice «no se pudo conectar».** | **NO EXISTE en el servicio.** Hay que crearla al publicar el front (§5.1) |
| `VITE_TENANT` | build del front | Empresa del CRM cuando el enlace no trae `?tenant=` | **nueva**, al publicar el front |
| `VITE_API_URL` | build del front | URL de la API | al publicar el front |
| `CLOUD_GRAPH_BASE` | API | Solo pruebas locales (Graph falso). **En producción se deja sin valor.** | no definida, correcto |
| `ACTIVE_TENANT` | API | Empresa por defecto del login. Hoy `bioayur`. | ya existía, sin cambios |
| `DATABASE_URL`, `JWT_SECRET`, `CLOUD_APP_SECRET`, `CRON_SECRET`, `WEBHOOK_SECRET`, `BRAIN_PROVIDER`, `BRAIN_FALLBACKS` | API | Sin cambios | no tocar |

El tenant del login se toma de `?tenant=` en la URL → `localStorage` → `VITE_TENANT`. Si se
publica un enlace por cliente, incluir el parámetro: `https://…/?tenant=<slug>`.

### Después

9. [ ] Publicar: abrir PR contra `main`. Render despliega al **fusionar**, no al hacer push.
10. [ ] `GET /health` → `ok` con el commit nuevo.
11. [ ] `GET /ready` → `status: ready`, `database.schemaVersion: "20261002"`,
        `database.models: 22` y `durabilidad` con `inbox` y `outbox`. Si aquí sigue
        `20261001`, el backend no vio la base nueva: no seguir.
12. [ ] `POST /webhook/cloud` sin firma → **401**.
13. [ ] `GET /v2/metricas` con token ADMIN → **200**, cada métrica con `definicion` y `fuente`.
14. [ ] Entrar por el CRM con un vendedor de cada empresa: las bandejas deben verse distintas.
15. [ ] Enviar **un** mensaje de prueba a un número de pruebas: la entrada debe aparecer en
        `inbound_events` y el historial con su `wamid`. No enviar a clientes reales sin
        autorización explícita.
16. [ ] A las 24 h: `inbound_events` sin filas `PENDING` older de 2 min y `outbound_messages`
        sin `UNCERTAIN` sin resolver. Cualquier fila que se quede ahí es una alerta.

### Rollback

- **Código:** volver al commit anterior en Render. Está **probado**: el ensayo de migración
  confirma que el cliente de Prisma viejo lee igual contra el esquema nuevo, porque la
  migración es aditiva y el backend viejo ignora las tablas nuevas.
- **Base:** revertir el código **no** exige restaurar la base. Las tablas y columnas nuevas
  quedan inertes. Restaurar el backup solo si hay que deshacer contenido escrito por el CRM
  nuevo, y solo con el punto de restauración anotado en el paso 3.
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