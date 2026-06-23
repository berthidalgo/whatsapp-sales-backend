# Hidata — WhatsApp Sales OS (backend)

Sales Operating System WhatsApp-native para edtech LATAM. Un agente conversacional ("el cerebro") califica leads con un flujo consultivo de 6 momentos y agenda la llamada donde el humano cierra.

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js · Fastify · Prisma |
| Base de datos | PostgreSQL (Supabase) |
| Transporte WhatsApp | Evolution API v2.3.7 (Baileys) |
| IA (cerebro) | Vertex AI — Gemini 2.5 Pro · fallback Cerebras (gpt-oss-120b) |
| Audio entrante | Whisper (Groq) |
| Observabilidad | Sentry (errores + scrubber de PII) |
| Hosting | Render (auto-deploy desde `main`) |

---

## Arquitectura — el cerebro

El núcleo es un **único cerebro LLM** (`src/brain/`) que reemplaza el pipeline determinista anterior. Cada mensaje recorre:

```
1. POST /webhook              → handler
2. Idempotency check          → idempotency.js
3. Event router               → event-router.js  (audio → Whisper; imagen → visión)
4. Debounce                   → debounce.js      (agrupa ráfagas de mensajes)
5. Lead resolver              → lead-resolver.js  (upsert atómico)
6. Cerebro                    → brain-pipeline.js → agent-brain.js
                                 (historial + estado + factSheet + memoria episódica
                                  → LLM → guardrails deterministas → persistir + enviar)
7. Sender                     → Evolution API → WhatsApp
```

Resiliencia: si el LLM primario falla, hay **failover automático** al proveedor secundario (nunca queda mudo). Si un humano toma la conversación, el cerebro entra en silencio (compuerta de modo) y reanuda solo si la conversación queda abandonada.

---

## Estado del lead

**Modos** (quién maneja la conversación): `AUTO_CONSULTIVO` · `HUMAN_ACTIVE` · `PAUSED`

**Stages** (momento del flujo): `first_contact` → `discovery` → `qualifying_empresa` → `presenting` → `call_scheduling` → `call_confirmed` → `post_close`

**Slots:** nombre, producto, empresa, experiencia, país destino, fecha/hora, monto.

---

## Variables de entorno

Se configuran en el hosting (nombres, sin valores):

```
DATABASE_URL · DIRECT_URL
BRAIN_MODEL · BRAIN_PROVIDER            # selección de modelo/proveedor del cerebro
GOOGLE_APPLICATION_CREDENTIALS · GOOGLE_CLOUD_PROJECT · GOOGLE_CLOUD_LOCATION
EVOLUTION_API_URL · EVOLUTION_API_KEY · EVOLUTION_INSTANCE_NAME
GROQ_API_KEY · CEREBRAS_API_KEY         # audio (Whisper) + fallback LLM
SENTRY_DSN                              # observabilidad (inerte si ausente)
CRON_SECRET                             # protege /cron/followup
NUMERO_JOAN                             # notificación al vendedor
WHATSAPP_PROVIDER                       # evolution (default) | cloud
```

---

## Endpoints

```
POST /webhook            recibe eventos de Evolution
GET  /health             health check
GET/POST /cron/followup  motor de followups (requiere ?secret=)
```

CRM API: `/leads`, `/leads/:id/mensaje`, `/leads/:id/mensajes`, `/reportes`, `/campaigns`, `/config/*`, `/auth/login`.

Debug: `/debug/gemini-check`, `/debug/brain-test`, `/debug/brain-evals`, `/debug/brain-replay`.

---

## Desarrollo

```bash
npm install
npm test          # node --test (plomería determinista; cero deps de test)
npm run dev       # node --watch src/server.js
```

Deploy: commit a `main` → Render auto-deploya (~3-5 min) → verificar `/health`.

---

## Notas de Evolution API

- Imagen fija **v2.3.7** (Baileys). No cambiar de versión.
- Buttons/lists/polls están bloqueados por Meta para Baileys desde 2024 → usar texto numerado (1️⃣ 2️⃣ 3️⃣).
- Payload v2.3.7: `data.messages[]` es array, no `data.key` directo.

---

## Multitenant

Todas las tablas llevan `tenant_id` desde el día 1 → la arquitectura soporta múltiples clientes sin cambios de schema.
