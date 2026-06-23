# Hidata — Sales OS (monorepo)

WhatsApp Sales OS para edtech LATAM. Monorepo: backend (cerebro + API), frontend (CRM) y el contrato compartido.

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

## ⚠️ Pendientes operativos
- **Poner el repo en PRIVADO** (hoy es público → expone el código del cerebro, que es el moat).
- Setear `JWT_SECRET` en Render antes de producción.
