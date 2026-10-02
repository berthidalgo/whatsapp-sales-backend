# Hidata — Sales OS (monorepo)

Backend multitenant para el CRM de Perú Exporta, BIOAYUR e Hidata. El cerebro del bot es uno de sus componentes principales. Monorepo: API y cerebro, frontend del CRM y contrato compartido. El canal operativo es la API oficial de Meta.

## Estructura
```
hidata/
├── apps/
│   ├── api/        ← Backend: cerebro conversacional + API (Node/Fastify + Prisma). Deploy → Render.
│   └── web/        ← Frontend: CRM / Inbox (React + Vite + TypeScript). Deploy → Vercel.
├── packages/
│   └── shared/     ← Contrato de API v2 (tipos TS) = una sola fuente de verdad back↔front.
└── contexto/       ← Documentación interna privada (gitignored).
```

## Por qué monorepo (decisión de arquitectura — 2026-06-23)
- Equipo chico + contract-first → cambiar back y front en un solo PR sin desincronizar; tipos compartidos en `packages/shared`.
- Estructura estándar de la industria 2026 (`apps/` + `packages/`). Detalle y trade-offs en `contexto/05-DISEÑO-FRONTEND.md`.
- **Tooling lean (deliberado):** sin Turborepo/Nx ni npm workspaces por ahora — 2 apps, `node_modules` separados → cero "phantom dependencies". Se sumará tooling solo si la orquestación de builds lo justifica (mismo criterio anti-sobreingeniería que con LangChain).

## Desarrollo (local-first)
- **Backend:** `cd apps/api && npm install && npm run dev` (necesita env: `DATABASE_URL`, `JWT_SECRET`, etc.).
- **Frontend:** `cd apps/web && npm install && npm run dev` → http://localhost:5173
- El front apunta al backend vía `VITE_API_URL` (default `http://localhost:3999`).

## Deploy (por hito, no por cada cambio)
- **Render (backend):** *Root Directory* = `apps/api`. AutoDeploy desde `main` → **cada push redeploya PROD** (pierde estado en memoria; no pushear a mitad de una prueba en vivo).
- **Vercel (frontend):** *Root Directory* = `apps/web`. Previews automáticos por rama; producción solo en merge a `main`.
- Cada target **ignora cambios fuera de su Root Directory** (mecanismo oficial de monorepo de Render/Vercel) → un push solo-front NO redespliega el backend.

## Estado de la preparación del CRM

La BD real quedó preparada y verificada con 19 modelos y 34 cambios estructurales. Las correcciones de esta revisión están locales; ese estado de BD no confirma su despliegue en Render.

- [Contrato API ↔ CRM](docs/contrato-crm.md): autenticación, ficha editable, versiones, inbox, medios y Meta.
- [Preparación de BD](docs/db-readiness.md): contrato versionado, migración aditiva, backup/restauración y pruebas.
- [Evidencia de aplicación](docs/estado-db-aplicacion.json): resultado de la BD real sin credenciales.
- [Cierre de auditoría](docs/cierre-backend-crm-2026-10-01.md): resultados de pruebas, correcciones y límites pendientes.
- El arranque exige `JWT_SECRET` y un esquema compatible. Los scripts de preparación no aplican cambios automáticamente al arrancar.
