# Hidata v20 — WhatsApp Sales ERP

> WhatsApp-native Sales Operating System para edtech LATAM  
> Cliente piloto: **Peru Exporta TV (ESCEX)**

---

## Stack de producción

| Capa | Tecnología | URL |
|---|---|---|
| Backend | Node.js / Fastify / Prisma | `whatsapp-sales-backend.onrender.com` |
| Base de datos | Supabase PostgreSQL | `whatsapp-sales-db` |
| WhatsApp | Evolution API v2.3.7 (Baileys) | Railway |
| Evolution DB | Supabase separado + Redis | Railway |
| Cache | Upstash Redis | `hidata-redis` |
| IA — Perception | Vertex AI — Gemini 2.5 Flash | GCP `graceful-envoy-493005-m7` |
| IA — Response | Vertex AI — Gemini 2.5 Flash Lite | GCP `graceful-envoy-493005-m7` |
| Frontend CRM | React / Vite | `testing1-crm.vercel.app` |
| Repositorio | GitHub | `github.com/berthidalgo/whatsapp-sales-backend` |

---

## Arquitectura del pipeline cognitivo

Cada mensaje de WhatsApp recorre 11 pasos en secuencia:

```
1. Webhook POST /webhook           → handler.js v21
2. Idempotency check               → idempotency.js (Map con TTL 5min)
3. Event Router dispatch           → event-router.js v2
4. Debounce 9 segundos             → debounce.js (acumula mensajes consecutivos)
5. Lead Resolver                   → lead-resolver.js (upsert atómico)
6. Perception — Gemini 2.5 Flash   → perception.js (intents + entities + sentiment)
7. State Layer + FSM               → state.js v5
8. Mode Router                     → mode-router.js (guards operacionales)
9. Policy Layer + Guardrails       → policy.js (acción determinística)
10. Response Layer — Flash Lite    → response.js (template o LLM)
11. Sender → Evolution → WhatsApp  → sender.js
```

---

## Modelo de datos — Lead State FSM

**Modos (quién maneja la conversación):**
- `AUTO_CONSULTIVO` — bot calificando
- `AUTO_CLOSING` — bot cerrando
- `HUMAN_ACTIVE` — vendedor humano activo, bot en silencio
- `PAUSED` — lead pausado o cerrado

**Stages (momento del flujo):**
- `first_contact` → `discovery` → `qualifying_empresa` → `presenting`
- `presenting` → `call_scheduling` → `call_confirmed` → `post_close`
- `returning_recognition` — lead reactivado tras 30+ días

**Slots tracked:** `nombre`, `producto`, `empresa`, `experiencia`, `pais_destino`, `fecha_hora`, `cantidad`, `monto`

---

## Equipo de ventas (instancias Evolution)

| Vendedor | Rol | Instancia Evolution | Número |
|---|---|---|---|
| Joan | ADMIN | `peru-exporta-test` | `51924104066` |
| Cristina | VENDOR | pendiente conectar | — |
| Francisco | VENDOR | pendiente conectar | — |

> ⚠️ Antes de conectar Cristina o Francisco: verificar guard de lead ownership en `lead-resolver.js` y que `instanciaEvolution` esté configurado en Supabase para ese vendor.

---

## Variables de entorno requeridas

```env
DATABASE_URL=                    # Supabase PostgreSQL connection string
EVOLUTION_API_URL=               # https://evolution-api-production-a9499.up.railway.app
EVOLUTION_API_KEY=               # API key de Evolution
EVOLUTION_INSTANCE_NAME=         # peru-exporta-test
GOOGLE_APPLICATION_CREDENTIALS= # Path al JSON del Service Account GCP
GOOGLE_CLOUD_PROJECT=            # graceful-envoy-493005-m7
GOOGLE_CLOUD_LOCATION=           # us-central1
UPSTASH_REDIS_REST_URL=          # Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN=        # Upstash Redis token
CRON_SECRET=                     # Secret para el endpoint /cron/followup
```

---

## Endpoints principales

### Operacionales
```
POST /webhook          → recibe eventos de Evolution API
GET  /health           → health check (version, timestamp)
GET  /cron/followup    → ejecuta followup engine (requiere ?secret=)
```

### CRM API
```
GET    /leads                    → lista leads
PUT    /leads/:id                → actualiza estado
POST   /leads/:id/mensaje        → envía mensaje manual
POST   /leads/:id/accion         → ejecuta acción CRM
GET    /leads/:id/mensajes       → historial de mensajes
GET    /reportes                 → métricas de conversión
GET    /vendors                  → lista vendedores activos
GET    /campaigns                → lista campañas
POST   /campaigns                → crea campaña
GET    /auth/vendors             → nombres para pantalla de login
POST   /auth/login               → login con PIN
```

### Debug (desarrollo)
```
GET  /debug/gemini-check         → verifica conexión Vertex AI
POST /debug/perception-test      → test de Perception Layer
POST /debug/state-test           → test pipeline completo
POST /debug/policy-test          → test Policy Layer
POST /debug/response-test        → test Response Layer con texto generado
POST /debug/run-perception-evals → corre eval set contra Perception
```

---

## Reglas críticas de Evolution API

- **Imagen correcta:** `evoapicloud/evolution-api:v2.3.7` (Baileys `1030415680`)
- **Nunca usar imagen `atendai`** en ninguna versión
- **Buttons, lists y polls bloqueados por Meta** para conexiones Baileys desde 2024 — usar texto numerado con emojis (1️⃣ 2️⃣ 3️⃣)
- **Payload real de Evolution v2.3.7:** `data.messages[]` es array, no `data.key` directo

---

## Comandos PowerShell — diagnóstico rápido

```powershell
# Health del backend
Invoke-RestMethod -Uri "https://whatsapp-sales-backend.onrender.com/health"

# Estado de la instancia Evolution
$headers = @{ "apikey" = $env:EVOLUTION_API_KEY }
Invoke-RestMethod -Uri "https://evolution-api-production-a9499.up.railway.app/instance/connectionState/peru-exporta-test" -Headers $headers

# Reiniciar instancia Evolution
Invoke-RestMethod -Uri "https://evolution-api-production-a9499.up.railway.app/instance/restart/peru-exporta-test" -Method POST -Headers $headers
```

---

## Queries Supabase útiles

```sql
-- Reset lead a estado inicial
UPDATE lead_state
SET current_mode='AUTO_CONSULTIVO', current_stage='greeting',
    slots_filled='{}', slots_pending='{}', intentos_por_slot='{}',
    mode_entered_at=NOW(), last_message_at=NOW(),
    returning_lead_flag=false, updated_at=NOW()
WHERE lead_id=<ID>;

-- Ver último turn_trace de un lead
SELECT turn_id, guardrails_evaluated,
       state_after->>'stage' as stage,
       bot_response, created_at
FROM turn_trace
WHERE lead_id=<ID>
ORDER BY created_at DESC LIMIT 1;

-- Listar columnas de una tabla
SELECT column_name FROM information_schema.columns
WHERE table_name = 'leads'
ORDER BY ordinal_position;
```

---

## Status pages a verificar antes de debuggear código

| Servicio | URL |
|---|---|
| Railway | https://status.railway.com |
| Render | https://status.render.com |
| Supabase | https://status.supabase.com |
| Vertex AI | https://status.cloud.google.com |

> Siempre verificar status pages PRIMERO antes de asumir bug en código.

---

## Workflow de deploy

1. Editar archivo localmente o en GitHub web interface
2. Commit directo a `main`
3. Render auto-deploya en 3-5 minutos
4. Verificar `/health` para confirmar nueva versión

Para audits grandes: descargar ZIP del repo desde GitHub y subirlo completo.

---

## Multitenant

Todas las tablas tienen `tenant_id` desde el día 1. El tenant piloto es `peru_exporta`. La arquitectura soporta múltiples clientes sin cambios de schema.

---

## Versión actual

`v7.0.0` — Día 8 Sprint 1  
Pipeline cognitivo completo: Perception → State → Mode Router → Policy → Response → Sender
