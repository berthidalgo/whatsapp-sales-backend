# Hidata — WhatsApp Sales OS (backend)

Backend multitenant de un vendedor por WhatsApp. Un agente conversacional ("el cerebro") atiende a cada lead con el manual de venta de su negocio (**vertical**): califica, presenta, maneja objeciones y cierra. Según el vertical, cierra agendando una llamada con un humano (exportación) o tomando el pedido por chat con contraentrega (colágeno).

---

## Stack

| Capa | Tecnología |
|---|---|
| API | Node 20+ · Fastify 4 · Prisma 5 |
| Base de datos | PostgreSQL (Supabase). Esquema aplicado con **SQL quirúrgico**, nunca `prisma db push` (ver abajo) |
| Transporte WhatsApp | Evolution API v2 (Baileys) por defecto · adaptador de WhatsApp Cloud API listo (apagado) |
| Cerebro | Cadena de proveedores LLM configurable: Gemini (Vertex) → Gemini Developer API → Groq → Cerebras |
| Audio entrante | Whisper (Groq) · Imágenes/comprobantes: Gemini multimodal |
| Observabilidad | Sentry (con scrubber de PII) · `turn_trace` (una fila por turno del cerebro) · `/health` |
| Hosting | Render (auto-deploy desde `main`, root `apps/api`) |

---

## Recorrido de un mensaje

```
Evolution ─POST /webhook─▶ handler ── secreto (WEBHOOK_SECRET) + idempotencia
                             │
                             ▼
                        event-router ── canal → TENANT (channels) · corte por suscripción
                             │           audio → Whisper · foto → descripción (Gemini)
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
                          sender ─────▶ Evolution ─▶ WhatsApp
```

Motores de fondo (`/cron/followup`, cada ~5 min): rescate de escalados sin atender → followups 2 h / 24 h → recordatorios de compromisos. Excluyen a quien ya compró (marca `_pedido`).

---

## El cerebro

- **Verticales** (`src/brain/verticals/`): el manual de venta de cada negocio. Componen las reglas comunes de `nucleo-comun.js` y declaran lo propio: momentos, schema de slots, guardrails del rubro, briefing al vendedor y cómo reconocer una venta cerrada. `tests/contrato-vertical.test.js` falla si un vertical pierde una regla común.
- **Cadena de proveedores** (`src/lib/llm-cadena.js`): el primario sale de `BRAIN_PROVIDER`/`BRAIN_MODEL`; los seguros, de `BRAIN_FALLBACKS` o, si está vacío, de las llaves presentes. Los errores de configuración o de plan (401/402/403/404/413) no se reintentan y apartan ese proveedor 10 min; los transitorios (429/5xx/JSON roto) sí se reintentan. El estado de cada paso se ve en `/health` (resumen) y `/debug/brain-health` (detalle).
- **Trampas conocidas**, resueltas en `normalizarPaso`: Gemini 3 solo existe en la location `global` y usa `thinkingLevel`; Gemini 2.x usa `thinkingBudget`; `gpt-oss` necesita `reasoning_effort` o devuelve JSON vacío.

---

## Variables de entorno

Ver [`.env.example`](.env.example). Las imprescindibles en producción: `DATABASE_URL`, `JWT_SECRET`, `WEBHOOK_SECRET`, `CRON_SECRET`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, credenciales de Vertex y al menos **un seguro LLM con plan que aguante el prompt** (~10K tokens de entrada por turno).

---

## Endpoints

| Ruta | Auth |
|---|---|
| `GET /health` | pública — versión, commit y estado del cerebro |
| `POST /webhook` | `WEBHOOK_SECRET` (header `x-webhook-secret`, `Bearer` o `?secret=`) |
| `POST /webhook/cloud` | firma HMAC de Meta (solo si `WHATSAPP_PROVIDER=cloud`) |
| `GET/POST /cron/followup` | `CRON_SECRET` |
| `GET /auth/vendors`, `POST /auth/login` | públicas (login por PIN, hasheado con scrypt) |
| `/v2/*` (Inbox, agente, copiloto, debrief, `POST /v2/me/pin`) | JWT, acotado al tenant y al vendedor |
| Escrituras de `/config/*` y `/campaigns/*`, todo `/debug/*` | JWT + rol ADMIN/SUPERVISOR |

`tests/rutas-protegidas.test.js` falla si una ruta nueva queda sin token o si una de administración acepta el token de cualquier vendedor.

---

## Operación

```bash
npm install
npm test                                   # 220+ tests, sin BD ni LLM
npm run dev

node scripts/evolution.js estado bioayur   # ¿API arriba? ¿instancia conectada?
node scripts/evolution.js qr bioayur       # QR al Escritorio para vincular el número
node scripts/evolution.js webhook bioayur  # webhook de la instancia → este backend, con el secreto
```

**Esquema de BD:** la base de producción tiene tablas fuera del schema de Prisma (`conversaciones_archivadas`, backups) y drift histórico de tipos. `prisma db push` las **borraría**. Los cambios de esquema se aplican con SQL escrito a mano (modo sesión, puerto 5432) y se verifican con `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma --script` antes de tocar nada.

**Deploy:** push a `main` → Render construye (`npm install && npx prisma generate`) y arranca. Al arrancar, el log muestra la cadena del cerebro y su salud (`[LLM] salud al arrancar: …`). Verificar `/health`.

**Evolution (Baileys):** si la instancia se desconecta, el bot recibe nada y envía nada. Estado → QR → webhook con los tres comandos de arriba. Baileys no es la API oficial: para volumen, el adaptador de Cloud API (`src/whatsapp/cloud/`) está listo pero apagado.
