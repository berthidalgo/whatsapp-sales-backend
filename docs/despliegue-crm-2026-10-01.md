# Backend del CRM desplegado

Verificado el 1 de octubre de 2026, 21:18 (America/Lima).

- **Render:** `whatsapp-sales-backend`, despliegue `dep-davh78mgekts73e23qm0`, estado `live`.
- **Commit publicado en main y servido:** [`298b32b`](https://github.com/berthidalgo/whatsapp-sales-backend/commit/298b32bcec8338082de8405baaa678a26fac4dcb).
- **CI en main:** los tres trabajos aprobados. [Ejecución](https://github.com/berthidalgo/whatsapp-sales-backend/actions/runs/36954630704).
- **Salud:** [/health](https://whatsapp-sales-backend.onrender.com/health) respondió 200 y confirmó el commit; [/ready](https://whatsapp-sales-backend.onrender.com/ready) respondió 200, `ready: true` y 19 modelos.
- **Seguros:** Luna → Laguna S 2.1 → Gemini 3.1 Flash Lite → Ministral 14B directo. La verificación del arranque confirmó 4/4 proveedores disponibles.
- **Meta:** proveedor global `cloud`; webhook sin firma rechazado con 401.
- **CRM:** leads y ficha leídos con una sesión administrativa corta; sin token, ambas rutas devolvieron 401. Sin modificar registros comerciales ni enviar mensajes de prueba.

## Publicación y configuración

Se construyó una rama desde el `main` remoto vigente y se incorporó el conjunto revisado, conservando las defensas existentes. El push a `main` fue fast-forward, sin force. Se realizó un despliegue manual del commit exacto después de CI y se dejó el despliegue automático configurado como `checksPass`.

Render usa Node 24, `npm ci --include=dev && npm run build`, `npm start` y healthcheck `/ready`. Prisma se genera durante el build. La base y las claves existentes se conservaron; la URL de aplicación corresponde a la BD previamente preparada.

Pruebas locales del conjunto publicado: **619/619 backend**, **11/11 PostgreSQL/HTTP**, **5/5 historial web**, builds API y web aprobados. El PostgreSQL temporal se detuvo. El arranque de producción hizo sus comprobaciones mínimas de proveedores; no se midió su costo. Los probes posteriores no llamaron al modelo ni enviaron WhatsApp.

## Continuidad local

El checkout principal está en `codex/crm-ready`, basado en el commit publicado. El trabajo anterior de `codex/crm-prep` se preservó mediante checkpoints y un stash; los archivos de investigación quedaron fuera de la publicación. No aplicar ese stash a ciegas sobre la versión nueva: el código de ese trabajo ya está integrado.

Los límites de escala/OCR y la validación visual pendiente del CRM siguen documentados en el [cierre de auditoría](cierre-backend-crm-2026-10-01.md). Evidencia estructurada sin claves ni datos de clientes: [estado-despliegue-crm.json](estado-despliegue-crm.json).
