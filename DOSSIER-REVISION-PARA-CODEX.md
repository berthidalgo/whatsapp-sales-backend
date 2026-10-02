# DOSSIER DE REVISIÓN PARA CODEX

**Qué es esto:** el resumen completo de una tanda de trabajo sobre
`berthidalgo/whatsapp-sales-backend`, pensado para que otra persona (o otro agente) lo revise
sin tener que reconstruir el contexto desde el historial de chat.

**Fecha de la tanda:** 2 de octubre de 2026 · **Autor:** socio fundador, vía Codex CLI
**Rama de trabajo:** `codex/crm-v1-cierre` · **Producción:** `a42df23`

> **Advertencia de honestidad:** este documento incluye una sección (§7) con los defectos y
> riesgos que **saben**, no solo los que se arreglaron. Léela antes de dar el visto bueno.
> También hay una corrección de una afirmación previa mia: dije que un typo de ruta ya estaba
> arreglado y no lo estaba. Está corregido ahora (`/v2/metrics` → `/v2/metricas`).

---

## 1. Tesis del trabajo en una frase

El backend contestaba rápido pero **podía perder mensajes y mentir sobre el estado comercial**, y
el CRM no era operable por un vendedor real. La tanda cierra esas dos brechas: **todo mensaje
que entra se persiste antes de responder 200** y **el estado comercial distingue lo que el
cliente dijo de lo que la empresa hará**, y encima hace operable el CRM.

---

## 2. Estado final, en una tabla

| | Antes | Ahora |
|---|---|---|
| Commit en producción | `298b32b` | **`a42df23`** (PR #1, deploy `dep-davkl9eq1p3s73dd5rrg`, `live`) |
| Esquema | `20261001`, 19 modelos | **`20261002`, 22 modelos** |
| Pérdida de mensajes | posible (ráfaga en memoria, sin rastro) | **entrada durable con recuperación** |
| Estado comercial | etapa inferida como si fuera verdad | **hecho vs. avance, separados** |
| Login del CRM | sin tenant → siempre el del despliegue | **tenant explícito y validado** |
| Filtros de bandeja | en el navegador sobre la página cargada | **en el servidor, con `total` real** |
| Coste del copiloto | inventado (tokens × precio fijo) | **eliminado** |
| Interface del CRM | no alojada en ningún sitio | **sigue sin alojarse** (§7.1) |

---

## 3. Qué se construyó, por bloques

### 3.1 A1 — Entrada durable (lo que evita perder mensajes)

El flujo anterior era: recibir webhook → agrupar ráfaga en un temporizador **de memoria** →
contestar 200. Si el proceso moría entre medio, el mensaje se perdía y nadie se enteraba.

Ahora (`apps/api/src/webhook/inbox.js`, `apps/api/src/whatsapp/cloud/router.js`):

- **`inbound_events`**: todo webhook de Cloud API se persiste con una **identidad estable**
  `(tenant_id, provider, event_key)`, donde `event_key` es el `wamid` de Meta. Índice único.
- **La escritura ocurre antes del 200.** Si la base está caída, Meta recibe un error y reintenta;
  si el proceso muere después, el mensaje ya está en la base y el barrido lo encuentra.
- **La ráfaga es una columna, no un temporizador**: `disponible_en` agrupa mensajes cercanos en
  el tiempo y el deMenudo. El temporizador en memoria solo es una optimización.
- **Reclamo atómico**: `FOR UPDATE SKIP LOCKED` con `lease_hasta`. Varios workers pueden
  consumir la bandeja sin pisarse y un worker muerto libera su trabajo solo.
- **Recuperación**: `recuperarEntradas()` rescata lo que quedó `PROCESSING` con el lease vencido,
  y `leadsListosParaTurno()` devuelve leads cuyo `disponible_en` ya pasó.

**Decisión de diseño que conviene discutir:** el `event_key` es el `wamid` de Meta. Para
mensajes de Evolution (canal heredado) el identificador es distinto, y por eso el índice es
compuesto por proveedor y no único a secas. Si someday se mete un tercer proveedor, hay que
volver a mirar esto.

### 3.2 A2 — Salida durable (parcial; ver §7.2)

`apps/api/src/whatsapp/outbox.js` + tabla `outbound_messages`:

- La **intención se registra antes de enviar**, no después. Si el proceso muere entre enviar y
  guardar, queda una fila `PENDING` que se puede reconciliar, no un hueco mudo.
- Tres desenlaces: `SENT` (Meta aceptó, con `wamid`), `REJECTED` (error conocido, no se
  reintenta) y `UNCERTAIN` (tiempo de espera agotado: **no se reenvía nunca**, porque no hay
  forma de saber si llegó).
- **No hay exactly-once y no se promete.** Verifiqué la documentación de Meta antes de asumirlo:
  `POST /messages` **no ofrece clave de idempotencia**. Reenviar un mensaje a un cliente real
  puede duplicarlo, y para este negocio duplicar es peor que tardar. La política es
  *registrar la duda y que la resuelva una persona*.

**Cobertura real: parcial.** Solo el camino principal del bot y la respuesta del vendedor pasan
por la outbox. Está detallado en §7.2 porque es el hallazgo más importante para la revisión.

### 3.3 A3 — Estado comercial honesto

Este es el cambio de fondo, y el que más me importa conceptualmente.

Antes, `lead_state.current_stage` mezclaba dos cosas distintas:
- **Hechos**: lo que el lead dijo. «Quiero el de 3 packs», «vivo en Surco», «me llamas el viernes».
- **Avances**: lo que la empresa hizo o decidió. Etapa del guion, pedido enviado, aviso dado.

El problema: si el proceso se muere **después** de enviar a Meta pero **antes** de confirmar, el
estado local podía quedar atrás mientras el cliente ya había recibido el mensaje. El sistema
decía «el cliente no está listo» cuando en realidad sí lo estaba.

Ahora (`apps/api/prisma/schema.prisma`, `lead_state.turno_pendiente`, `turno_id`, `state_version`):

- `slots_filled` guarda **solo hechos del lead**. Nunca se toca por código de la empresa.
- `turno_pendiente` guarda el **avance**: `{etapa, pedido, aviso, compromiso}`. Avanza
  **después** de que Meta acepte el envío.
- `turno_id` es un identificador de intento. Al reconfirmar, el turno se descarta con un
  `WHERE turno_id = <el que se envió>`: si llegó otro turno mientras tanto, el antiguo se
  descarta en vez de pisar el nuevo.
- `state_version` para que un turno viejo no pueda escribir sobre un estado más nuevo.

**La regla que lo sostiene:** los hechos se escriben antes de responder a Meta; los avances,
después. En el medio puede haber un corte de luz, y el sistema sabe distinguirlo.

### 3.4 A4 — Media, promises, followups, turnos IA

- **No se transcribe** un audio o una imagen si hay un humano en la conversación o una pausa
  activa. Antes se transcribía y el bot podía hablar «en nombre» del vendedor.
- `PAUSED` es intocable: nada del bot lo puede cambiar.
- **Followups**: el filtro de elegibilidad se aplica **antes** del `LIMIT` de la consulta. Antes
  se pedían N leads y se descartaba después, con lo cual casi nunca salía ninguno válido.
- **Candado de followups** (`followup_reservations`): reserva atómica antes de enviar, para que
  dos workers no manden el mismo followup. Se libera si el envío falla y se marca el resultado
  si se completa.
- **Promesas prohibidas** (descuentos, plazos, garantías de stock) se neutralizan y escalan a humano
  en vez de inventarse.
- **Turnos IA** van en un contador aparte: un turno atendido por humano ya no consume cupo de IA.
  Por eso `tenant_settings.turnos_ia_mes_actual` es una columna nueva.
- **Se borró el «costo» del copiloto**: multiplicaba tokens por un precio fijo que ningún
  proveedor informaba. Era fiction presented as billing.

### 3.5 A5 — Contrato y verificación

- `apps/api/prisma/sql/20261002_crm_schema.sql`: migración **aditiva**. Cero `DROP`, cero
  `TRUNCATE`, cero `DELETE`, cero `UPDATE`, cero columnas renombradas.
- `db-readiness-lib.js` verifica catálogo, restricciones de unicidad correctas, FKs dentro de
  `public` y que **ninguna tabla con datos de cliente nazca sin `tenant_id`**.
- `/ready` expone `database.schemaVersion`, `database.models` y el detalle de `durabilidad`.
  El arranque **falla** (`CRM_SCHEMA_NOT_READY`) si el esquema no corresponde, en vez de
  atender con un contrato incompatible.

### 3.6 B1–B4 — CRM utilizable

- **B1**: un 401 ahora **cierra la sesión de verdad**; la caché de sesión está indexada por
  tenant+usuario+instante; los borradores pertenecen a su lead (`apps/web/src/drafts.ts`); el
  envío del copiloto se amarra al lead con el que arrancó la conversación.
- **B2**: login por tenant (URL → `localStorage` → `VITE_TENANT`), bandeja paginada con filtros
  de servidor y `total` real, conversación con medios y recibos, control humano, etiquetas,
  reasignación y debrief.
- **B3**: alta de campaña con validación del servidor, ficha persistida, disparadores, guion y
  activación. **El preview ficticio se sustituyó por validación real del servidor**: antes
  mentía, mostrando los valores del formulario como si fueran lo que diría el bot.
- **B4**: resultados humanos desde `call_events`, separados de la etapa inferida, con «no
  disponible»; `GET /v2/metricas` con **definición y fuente por métrica**.

---

## 4. Evidencia

| Qué | Comando | Resultado |
|---|---|---|
| Backend offline | `npm run test:offline` | 636 discovered · **635 pasan** · 0 fallan · 1 omitida |
| PostgreSQL + HTTP + migraciones | `npm run test:db` | 14 / 14 |
| Durabilidad sobre PostgreSQL | `npm run test:db:hitoa` | 15 / 15 |
| Recorrido completo del CRM | `npm run recorrido` | 55 / 55 |
| Front: lógica | `node --test "tests/*.test.mjs"` | 19 / 19 |
| Front: tipos + build | `npm run build` | aprobado |
| **Ensayo de migración** | `npm run migracion:ensayo` | **35 / 35** |
| Capturas con navegador | `npm run capturas` | 9 PNG |

La 1 omitida es la suite de PostgreSQL, que necesita opt-in explícito (`RUN_POSTGRES_TESTS=1`);
corre aparte y pasa 15/15. No es una prueba escondida: está marcada como omitida a propósito.

### 4.1 El ensayo de migración (lo más útil que se construyó)

`apps/api/scripts/ensayo-migracion.mjs`. Un plan de migración sobre una base vacía no demuestra
nada. Este ensayo:

1. Levanta el esquema **anterior** (`20261001`, fijado como archivo en
   `apps/api/tests/fixtures/esquema-20261001.sql`).
2. Lo puebla con **las 19 tablas llenas** de datos con la forma de los reales: dos empresas que
   no se cruzan, campañas con ficha comercial, leads, mensajes con `wamid` y recibos de Meta,
   `lead_state` con `_pedido` dentro de los slots, compromisos, followups, `turn_trace`,
   notificaciones, media, canales y ajustes de tenant.
3. Aplica la migración y comprueba: nada destructivo · nada nuevo sin acotar por tenant ·
   **19 sentencias y 0 en la segunda pasada** (idempotente) · filas, ficha y slots intactos ·
   recibos de Meta intactos · aislamiento por empresa limpio.
4. **Que el cliente de Prisma viejo lea igual contra el esquema nuevo.**

El punto 4 es el que hace posible volver atrás: la migración es aditiva, así que revertir es
revertir código, no restaurar la base.

Es puerta obligatoria en CI (`migracion:ensayo`).

### 4.2 Capturas

`docs/capturas/`, 9 PNG en escritorio (1440×900) y móvil (390×844): login, inbox, conversación,
**sesión caducada volviendo al login**, configuración de campaña, métricas y configuración
móvil. Reproducibles con `npm run capturas` (necesita `playwright-core`, ver §7.5).

---

## 5. La publicación (qué se hizo contra producción)

Todo esto ocurrió con autorización explícita del socio fundador.

1. **Diff revisado** y barrido de secretos **sobre el diff** (no sobre el árbol): limpio. Lo
   único detectado son credenciales de CI en `localhost` y el PIN `1234` de bases desechables.
2. **Backup** antes de tocar la base:
   `C:\Users\HP\Documents\crm-backups\antes-de-20261002-2026-10-02T05-53-11.dump`
   (3.08 MB, 588 objetos, verificado legible con `pg_restore -l`).
   Segundo punto de restauración tras migrar: `...-05-55-01.dump` (3.09 MB, 609 objetos).
3. **Plan en solo lectura** contra la base real: 19 sentencias aditivas.
4. **Migración aplicada**: `22 modelos; 19 sentencias aplicadas atómicamente`.
5. **Verificación**: `22 modelos; solo lectura`, sin incidencias.
6. **Conteo de filas antes y después: 624 → 624.** Las tres tablas nuevas nacieron vacías.
7. **PR #1** con los tres jobs de CI en verde → fusionado a `main` (`a42df23`) → Render
   desplegó `dep-davkl9eq1p3s73dd5rrg`, estado `live`.

### 5.1 Verificación post-despliegue (resultado real)

| Comprobación | Resultado |
|---|---|
| `GET /health` | ✓ 200, commit `a42df23`, versión `7.1.0` |
| `GET /ready` | ✓ 200, `status: ready` |
| `database.schemaVersion` | ✓ `20261002` |
| `database.models` | ✓ `22` |
| `durabilidad.inbox` / `.outbox` | ✓ presentes, ambas en 0 filas |
| `POST /webhook/cloud` sin firma | ✓ 401 |
| `GET /v2/metricas` sin token | ✓ 401 |
| `GET /v2/leads` sin token | ✓ 401 (ruta presente) |
| Web pública del negocio | ✓ 200 |
| **`GET /v2/metricas` con token ADMIN → 200** | ⏳ **pendiente**: requiere entrar con un vendedor real; los PIN están hasheados. **No se saltó la autenticación para marcar la casilla.** |

### 5.2 Dos defectos que solo aparecieron en CI

Ambos pasaban en local. Ninguno llegó a producción.

1. El ensayo usaba `git show <commit-base>:…`, pero `actions/checkout` hace un clon **superficial**
   → `fatal: invalid object name`. Arreglo: **fijar el esquema anterior como archivo del repo**,
   no profundizar el clon. Un ensayo que depende del historial es un ensayo que falla un día sin
   que cambie el código.
2. La ruta del fixture se derivaba de `new URL('.').pathname` quitando la barra inicial: en
   Windows eso da una ruta absoluta y en Linux convierte una ruta POSIX **absoluta** en relativa.
   Arreglo: `fileURLToPath`. El mensaje de error ahora dice qué ruta falló.

---

## 6. Historial de commits

| Commit | Qué |
|---|---|
| `853af4d` | A1–A5 + B1–B3: entrada/salida durables, estado comercial, CRM utilizable |
| `6990585` | Métricas con definición y fuente, tenant en el login, recorrido verificable |
| `86a8229` | Contrato `20261002`, estado del candidato, handoff, guía actualizada |
| `353a4fa` | Ensayo de migración desde el esquema que corre en producción |
| `e0a4236` | Fijar el esquema anterior como archivo (arreglo de CI) |
| `fd8ecd7` | `fileURLToPath` para el fixture (arreglo de CI) |
| `a42df23` | **Fusión a `main` por squash (lo que está en producción)** |
| `17d58bf` | Registro de la publicación real — **en la rama, sin fusionar a propósito** (fusionar reiniciaría producción por un archivo de texto) |

---

## 7. Lo que hay que saber antes de dar el visto bueno

### 7.1 El frontend del CRM no está alojado en ninguna parte — **bloqueante para vender**

El backend está vivo y con la base migrada, pero **nadie ve la interfaz**:

- El workspace de Render tiene **un solo servicio** (la API, `web_service`). No hay static site.
- No hay workflow de despliegue del front en `.github/workflows`, ni configuración de Vercel,
  Netlify o Cloudflare Pages.
- La API **no sirve el CRM**: en `/` responde la web pública del negocio.

Las mejoras de interfaz (login por tenant, bandeja paginada, borradores, campañas, métricas)
están escritas, tipadas, probadas y capturadas, pero **sin hosting son código muerto para el
usuario**.

**Para ponerlo en pie, en este orden:**
1. Elegir dónde alojarlo. Render static site lo deja en el mismo panel y Simplifica el operativo.
2. En el build del front: `VITE_API_URL=https://whatsapp-sales-backend.onrender.com` y
   `VITE_TENANT` con la empresa por defecto (hoy `ACTIVE_TENANT=bioayur` en la API).
3. **Crear `CORS_ORIGINS` en el servicio de la API.** **Hoy no existe esa variable.** En
   producción localhost no se permite, así que sin ella el navegador bloquea la API y la
   pantalla dice «no se pudo conectar». Este es el paso que más se olvida.
4. Publicar y repetir la verificación de §5.1 entrando con un vendedor de cada empresa: las
   bandejas deben verse distintas.

### 7.2 La outbox cubre solo dos de los caminos de envío — **el hallazgo más serio**

En la misión pedía «envío y registro recuperables». Se implementó bien, pero **parcial**.

**Sí pasan por la outbox** (`intentarEnviar` + estado): el camino principal de respuesta del bot
(`apps/api/src/webhook/handler.js`) y la respuesta del vendedor
(`apps/api/src/api/inbox-actions.js`).

**Siguen enviando directamente, sin outbox:**
- `apps/api/src/motor/followupEngine.js` — 7 envíos directos (sí tiene candado de reserva, pero
  no registra la intención antes de enviar).
- `apps/api/src/whatsapp/cloud/router.js` — 7 envíos directos (reapertura, avisos, plantillas).
- `apps/api/src/webhook/notifications.js` — 3 (avisos al vendedor).
- `apps/api/src/whatsapp/interactivo.js`, `cloud/plantillas.js` — envíos sueltos.

**Qué significa en la práctica:** para esos caminos, un corte de luz **entre** el envío a Meta y
el guardado del mensaje deja un hueco mudo. No es pérdida de mensaje hacia el cliente (Meta ya lo
recibió), es **pérdida de trazabilidad**: el CRM puede no mostrar un mensaje que el cliente sí
recibió, y no queda ni `wamid` ni estado para reconciliar. El riesgo es de auditoría, no de
entrega.

**Mitigación parcial ya existente:** los followups no se duplican (candado atómico), y los
rechazos de Meta en los caminos con outbox sí dejan rastro estructurado.

**Trabajo pendiente:** enrutarlos por la misma outbox, o documentar explícitamente por qué se
decide no hacerlo. Yo prefiero enrutarlos.

### 7.3 La cadencia de envío depende de memoria

El agrupado durable garantiza que el mensaje **no se pierde**; no garantiza que se procese al
segundo exacto. La cadencia fina (ráfaga, temporizador del comprador) sigue en memoria de
proceso. Consecuencia: un redeploy puede retrasar el turno unos segundos. Es aceptable para este
negocio, pero es una decisión, no un descuido.

### 7.4 No hay exactly-once, y no puede haberlo

Meta no ofrece clave de idempotencia en `POST /messages` (verificado en su documentación). El
sistema es **at-least-once en la entrada** y **sin reenvío automático en la salida incierta**.
Cualquier propuesta de «garantizar entrega única» necesita resolverse por otro lado (deduplicar
por contenido en la entrada, o aceptar el duplicado y que lo revise una persona).

### 7.5 Menores, pero abiertas

- **`capturas-crm.mjs` depende de `playwright-core` instalado con `npm install --no-save` en
  `apps/web`.** No está declarado como dependencia, así que en una máquina limpia el script
  falla. Decisión: documentarlo o declararlo `devDependency`.
- **`GET /v2/metricas` sin token ADMIN no está verificado en producción** (§5.1).
- **Backlog ya identificado** (no bloquea operar): réplicas del CRM, resolución asistida de
  `UNCERTAIN`, vista de compromisos, correcciones del operador, plantillas/canales por scripts,
  desfase de zona horaria. Detalle en `HANDOFF-PARA-CODEX.md` §6.

---

## 8. Dónde mirar primero

| Si te interesa… | Empieza por |
|---|---|
| Que no se pierdan mensajes | `apps/api/src/webhook/inbox.js`, `apps/api/src/whatsapp/cloud/router.js` |
| Que el estado no mienta | `apps/api/prisma/schema.prisma` (`turno_pendiente`), `apps/api/src/brain/brain-pipeline.js` |
| Qué se envía y con qué garantía | `apps/api/src/whatsapp/outbox.js` **y** §7.2 |
| Que la migración sea segura | `apps/api/scripts/ensayo-migracion.mjs`, `prisma/sql/20261002_crm_schema.sql` |
| Que el CRM sea operable | `apps/web/src/api.ts`, `Inbox.tsx`, `Conversation.tsx`, `drafts.ts`, `editor-estado.ts` |
| Qué se probó | `apps/api/scripts/recorrido-crm.mjs` (55 comprobaciones) |
| Qué falta por hacer | este dossier §7, y `HANDOFF-PARA-CODEX.md` §5.1 |

---

## 9. Promesas que este trabajo **no** hace

Para que nadie las asuma por error:

- **No hay exactly-once** (§7.4).
- **No se probó ninguna llamada a un modelo generativo.** 0 llamadas, 0 USD. Las cadenas quedan
  sin tocar (Luna → Laguna → Gemini → Mistral directo). `/health` muestra salud almacenada del
  arranque: **no es una prueba de IA**.
- **No se envió ni un mensaje a un cliente real.**
- **No se garantiza nada sobre la disponibilidad del servicio** de Render.
- **El frontend no está en línea** (§7.1).
- **La verificación con token de administrador está pendiente** (§5.1).