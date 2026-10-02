# Hidata — WhatsApp Sales OS (backend)

Backend multitenant del CRM: vendedores y roles, campañas, fichas comerciales, leads, inbox, medios, estado, seguimiento y canales. Un componente principal es el agente conversacional ("el cerebro"), que atiende con la ficha almacenada en BD y las reglas de su vertical. El canal operativo es la API oficial de Meta. Según el vertical, agenda una llamada con un humano o toma un pedido por chat.

---

## Stack

| Capa | Tecnología |
|---|---|
| API | Node 24+ · Fastify 5 · Prisma 5.22 |
| Base de datos | PostgreSQL (Supabase). Contrato versionado, preparación aditiva y gate de arranque; no usar `prisma db push` contra la BD existente |
| Transporte WhatsApp | API oficial de Meta (Cloud API), con canal y credenciales por tenant; adaptador legacy aislado |
| Cerebro | Cadena de proveedores LLM configurable: Gemini (Vertex / Developer API), Groq, Cerebras y cualquier OpenAI-compatible (Mistral, OpenRouter, DeepSeek, NVIDIA o una URL propia) |
| Audio entrante | Whisper (Groq) · Imágenes/comprobantes: proveedor de visión configurable |
| Observabilidad | Sentry (con scrubber de PII) · `turn_trace` (una fila por turno del cerebro) · `/health` y `/ready` |
| Hosting | Render (auto-deploy desde `main`, root `apps/api`) |

---

## Recorrido de un mensaje

```
Meta ─POST /webhook/cloud─▶ router ── firma HMAC + parser + control de canal
                             │
                             ▼
                        event-router ── canal → TENANT (channels) · corte por suscripción
                             │           audio → Whisper · foto → proveedor de visión
                             ▼
                        lead-resolver ── upsert por (tenant, teléfono) · campaña por trigger
                             │
                             ▼
                         debounce 6 s ── agrupa ráfagas · lock por lead · kill-stale
                             │
                             ▼
                       brain-pipeline ── compuerta de modo (HUMAN_ACTIVE/PAUSED = silencio)
                             │            historial + estado + memoria episódica + ficha
                             ▼
                        agent-brain ─── vertical (prompt + schema) → CADENA LLM → guardrails
                             │            (precio fantasma, "curar", re-saludo, vocativo…)
                             ▼
               estado + turn_trace + aviso al vendedor si escala + marca de venta cerrada
                             │
                             ▼
                          sender ─────▶ canal propio ─▶ Meta ─▶ WhatsApp
```

Los callbacks de entrega se persisten como recibos pendientes si el mensaje aún no existe, y se concilian por tenant/número sin degradar estados. La deduplicación general y el debounce todavía son de memoria de proceso, no una garantía distribuida.

Motores de fondo (`/cron/followup`): rescate de escalados sin atender, seguimientos y recordatorios de compromisos. Excluyen a quien ya compró (marca `_pedido`); el contenido comercial y los intervalos configurables se obtienen de datos/configuración.

---

## El cerebro

- **Verticales** (`src/brain/verticals/`): el manual de venta de cada negocio. Componen las reglas comunes de `nucleo-comun.js` y declaran lo propio: momentos, schema de slots, guardrails del rubro, briefing al vendedor y cómo reconocer una venta cerrada. `tests/contrato-vertical.test.js` falla si un vertical pierde una regla común.
- **Cadena de proveedores** (`src/lib/llm-cadena.js`): el primario sale de `BRAIN_PROVIDER`/`BRAIN_MODEL`; los seguros, de `BRAIN_FALLBACKS` o, si está vacío, de las llaves presentes. Los errores de configuración o de plan (401/402/403/404/413) no se reintentan y apartan ese proveedor 10 min; los transitorios (429/5xx/JSON roto) sí se reintentan. El estado de cada paso se ve en `/health` (resumen) y `/debug/brain-health` (detalle). El ping solo prueba la llave; para saber si un proveedor aguanta el turno REAL (~11K tokens, JSON), correr `node scripts/probar-cerebro.js` (lee la campaña de la base y no envía nada).
- **Trampas conocidas**, resueltas en `normalizarPaso`: Gemini 3 solo existe en la location `global` y usa `thinkingLevel`; Gemini 2.x usa `thinkingBudget`; `gpt-oss` necesita `reasoning_effort` o devuelve JSON vacío.

---

## Variables de entorno

Ver [`.env.example`](.env.example). Para la operación Meta del despliegue: `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, `WHATSAPP_PROVIDER=cloud`, `CLOUD_APP_SECRET`, `CLOUD_VERIFY_TOKEN` y las credenciales del número/canal. El cerebro usa `BRAIN_PROVIDER` y `BRAIN_FALLBACKS` con las llaves correspondientes; las llaves de Vertex/Evolution no son necesarias para una cadena OpenRouter/Mistral y un canal Meta.

La ficha se edita desde el CRM y se guarda en BD mediante la API autenticada con tenant y control de versión. Los JSON son fuentes de datos iniciales/políticas; no se deben sustituir cambios de ficha en BD por constantes comerciales dentro del ejecutable. Ver [contrato CRM](../../docs/contrato-crm.md).

---

## Endpoints

| Ruta | Auth |
|---|---|
| `GET /health` | pública — versión, commit y estado del cerebro |
| `GET /ready` | pública — conectividad y readiness de BD, sin datos comerciales |
| `POST /webhook` | adaptador legacy: `WEBHOOK_SECRET` (header `x-webhook-secret`, `Bearer` o `?secret=`) |
| `GET /webhook/cloud` | handshake con `CLOUD_VERIFY_TOKEN` |
| `POST /webhook/cloud` | firma HMAC de Meta; habilitado con `CLOUD_APP_SECRET`, independiente del proveedor global |
| `GET/POST /cron/followup` | `CRON_SECRET` |
| `GET /auth/vendors`, `POST /auth/login` | públicas (login por PIN, hasheado con scrypt) |
| `/v2/*` (Inbox, agente, copiloto, debrief, `POST /v2/me/pin`) | JWT, acotado al tenant y al vendedor |
| Escrituras de `/config/*` y `/campaigns/*`, todo `/debug/*` | JWT + rol ADMIN/SUPERVISOR |

`tests/rutas-protegidas.test.js` falla si una ruta nueva queda sin token o si una de administración acepta el token de cualquier vendedor.

---

## Operación

```bash
npm install
npm run build                             # genera el cliente Prisma, sin migrar la BD
npm run test:offline                      # bloquea llamadas externas; no consume proveedores
npm run dev
```

**Esquema de BD:** la BD real tiene 19 modelos verificados y conserva sus tipos nativos/datos históricos. El contrato SQL/JSON y los scripts comparan el catálogo y aplican solo cambios estructurales admitidos, dentro de una transacción, después de backup y ensayo de restauración. No usan `.env` ni `DATABASE_URL`: exigen `CRM_DATABASE_URL` explícita. No ejecutar seeds, resets ni `db:push` contra la base comercial. [Preparación de BD y evidencia](../../docs/db-readiness.md).

**Pruebas PostgreSQL:** `npm run test:db` exige `CRM_TEST_DATABASE_URL` local y crea/elimina únicamente bases temporales `crm_smoke_*`. Una omisión por variable ausente no constituye una prueba aprobada. CI dispone de PostgreSQL 17 para esta suite; sus resultados remotos solo se conocen después de ejecutarla.

**Deploy:** un push a `main` inicia el despliegue de Render según su configuración. El código corregido de esta revisión sigue local: la preparación de la BD no lo despliega. Antes de escuchar, el servidor verifica el schema sin ejecutar DDL; una incompatibilidad aborta con `CRM_SCHEMA_NOT_READY`. Después de un despliegue, comprobar el commit servido, `/health` y `/ready`; un HTTP 200 antiguo no confirma la nueva versión.

**Meta:** la recepción requiere firma válida, canal conocido y tenant correspondiente. Texto libre exige una ventana abierta por un mensaje del lead; enviar una plantilla no abre esa ventana por sí solo. Las plantillas y credenciales pertenecen al canal de cada tenant. Los scripts de gestión/envío pueden modificar Meta o enviar mensajes reales; no forman parte de las pruebas offline.
