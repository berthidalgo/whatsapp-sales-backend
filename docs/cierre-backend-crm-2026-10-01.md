# Cierre de auditoría y preparación del backend del CRM

Revisión del 1 de octubre de 2026 (America/Lima). El backend comprende identidad/roles, tenants, campañas y fichas, leads, conversaciones, medios, operadores, seguimiento y canales. El cerebro del bot es un componente principal.

## Estado comprobado

| Componente | Evidencia |
| --- | --- |
| Código corregido | Working tree de `codex/crm-prep`, base Git `8e53906`; conserva el trabajo de Muse/Bunny y reintegra los seguros de `76616fe`. Sin commit/push de este conjunto. |
| BD real | `ready: true`, 19 modelos; 34 cambios estructurales aplicados en una transacción; segunda ejecución con cero cambios. [Evidencia](estado-db-aplicacion.json). |
| Backup | Dump privado tomado antes de aplicar; restaurado y migrado en PostgreSQL local, conservando los registros y huellas de fichas/slots del ensayo. Sin conversión ni relleno comercial de datos. |
| Backend offline | `npm run test:offline`: **611/611**, cero fallos y cero omitidos. |
| PostgreSQL + servidor HTTP | `npm run test:db`: **11/11**, cero fallos y cero omitidos; bases temporales y HTTP local reales. |
| Frontend | `npm run build`: TypeScript/Vite OK; historial: **5/5**. No se realizó una prueba visual interactiva. |
| Prisma sobre BD real | Gate de schema en lectura aprobado; lectura de UUID y fechas nativas comprobada sin mostrar datos reales. |
| Render | `/health` respondió 200 el `2026-10-02T01:48:35.083Z` UTC y sirvió **`76616fe`**. Las correcciones locales de este conjunto **no están desplegadas**. |
| Proveedores de IA | **0 solicitudes, 0 tokens de OpenRouter, US$0.00** durante esta reparación. Los fallbacks se comprobaron con dobles; no se midió disponibilidad nueva de modelos vivos. |

El PostgreSQL temporal de las pruebas se detuvo al terminar. El backup y los checkpoints de código están fuera del repositorio; no contienen material para adjuntar públicamente.

## Correcciones entregadas

| Área | Resultado |
| --- | --- |
| Ficha comercial | CRM → API autenticada → merge recursivo validado → versión optimista → BD → contexto del cerebro. Precios/productos/promesas son datos; las reglas de protocolo y seguridad permanecen en código. |
| Campañas | Activación válida, default sin trigger cuando corresponde, selección del vendedor y escrituras acotadas al tenant. Precio exacto, protección de prototipo y conflictos explícitos. |
| Cerebro | Restauradas reglas deterministas C022/C023/H07 y defensas de slots, precios y assets; vulnerabilidad grave escala antes del modelo. |
| Aislamiento | JWT/roles/IDs explícitos, lectura y envío por tenant/canal, ownership de medios y credenciales; sin fallback a un cliente ajeno. |
| Meta | Persistencia de envíos confirmados, recibos tempranos durables, conciliación tras reinicio y estados sin regresión; toma de control humano y plantillas por canal. |
| Inbox/editor | Cursor conjunto con desempate, historial incremental y IDs estables; conserva borradores, versión base y ediciones realizadas durante un guardado. |
| BD | Contrato SQL/JSON versionado; preparación aditiva, verificación de relaciones por tenant, rollback y gate de arranque en lectura. Respeta tipos nativos y PK históricas. |
| CI/documentación | Suites offline y PostgreSQL separadas, build del consumidor TS, documentación Meta y ejemplos de entorno actuales sin claves. CI remoto aún no ejecutado para este conjunto. |

## Contratos para continuar el CRM

- [Contrato API ↔ CRM](contrato-crm.md): permisos, ficha/versiones, borrados confirmados, campañas, inbox, medios, reply/reapertura y recibos.
- [Preparación y mantenimiento de BD](db-readiness.md): scripts, contrato de 19 modelos, ensayo/backup y compatibilidad Prisma 5.22.
- [Prompt mejorado ejecutado](prompt-ejecucion-backend-crm.txt): alcance y criterios de esta reparación.

No desplegar un cherry-pick parcial: schema, contrato, módulos Cloud, verificadores, tipos compartidos y sus consumidores forman un conjunto. La rama de trabajo partió de una base anterior a `origin/main`; su integración debe conservar las correcciones remotas y los archivos nuevos necesarios, sin incluir secretos ni dumps.

## Límites y siguiente hito

1. **Entrega del código:** integrar y publicar el conjunto revisado; ejecutar CI remoto y verificar el commit nuevo, `/health` y `/ready`. El estado de BD ya preparado no sustituye ese despliegue.
2. **Frontend:** integrar confirmación visual de borrados (`force`) y comprobar con interacción real conflictos, cambios de campaña durante save, scroll/historial y plantilla enviada sin ventana de texto libre abierta.
3. **Escala:** deduplicación general, debounce y candado de reapertura siguen en memoria de proceso. No hay garantía distribuida ni reproceso durable de todos los turnos; resolverlo antes de multi-instancia. La durabilidad implementada aquí corresponde a recibos.
4. **Funciones futuras:** PDFs/videos se conservan sin OCR; reasignaciones no tienen una tabla de auditoría dedicada; recibos antiguos fuera de la página reciente no se refrescan todos con el polling; el baseline de `_prisma_migrations` no se registra automáticamente.

Los límites anteriores no se presentan como funciones terminadas. La base de datos y los contratos comprobados permiten continuar la integración del CRM.

## Recuperación

La producción sigue sirviendo el commit anterior; no hace falta rollback de código por estas correcciones locales. Los cambios de BD añadieron estructura/integridad y preservaron los datos; no ejecutar un rollback destructivo para eliminar tablas o constraints como parte de un rollback de aplicación. Si se necesita restaurar datos, usar el backup privado previamente ensayado y coordinar las escrituras posteriores al dump.
