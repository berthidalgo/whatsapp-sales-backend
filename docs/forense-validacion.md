# Corrección forense del refactor comercial

Fecha: 2026-10-01. Base desplegada: 7150220. Refactor revisado: 8e53906, integrado sin reemplazar los seguros de Etapa 1.

## Fuentes de datos

- Identidad, producto, precio, oferta, ingredientes, dosis, respaldo, garantías y logística: campaigns.config.agente/factSheet en BD.
- Altas y compatibilidad: apps/api/data/tenants/*.json; imágenes legacy registradas por dueño en assets-legacy.json.
- Sitio público completo (contenido comercial y política), seguimiento genérico, catálogo de plantillas y defaults del deploy: JSON en apps/api/data.
- Casos de evaluación y personas del harness: JSON de fixtures históricos; no constituyen una oferta vigente.
- Branding y claves de sesión del frontend: apps/web/src/config/producto.json.

El código conserva contratos, etapas, validaciones, guardrails y límites operativos. Los datos de cada cliente no se colocan en prompts, seeds ni fallbacks de código.

## Hallazgos corregidos

1. Dependencias faltantes de arranque: catálogo mínimo incluido; retirados recibos de envío no soportados por el esquema desplegado. No hay migración de Message. Se retiró también el endpoint incompleto reabrirV2, introducido sin su implementación; se conserva el contrato desplegado. Una prueba ejecuta todo server.js hasta la conexión ficticia.
2. Assets: validación del dueño, namespace por tenant, ruta real dentro de assets, rechazo de traversal/symlinks, firma de imagen y MIME coherente. Un fallo de lectura no se cachea permanentemente. Una campaña con ficha no hereda una imagen que omitió.
3. Contrato: precios completos y moneda; no coincidencia por prefijo ni cantidades usadas como precios. Prototipos y claves peligrosas rechazados. Merge recursivo conserva los campos del precio.
4. Escrituras: ficha requerida en altas activas; borrador explícito permitido. Borrado de datos existentes exige force=true. Ambas APIs usan versión en el predicado de escritura e incrementan version; un cambio simultáneo devuelve 409. Edición comercial sin versión devuelve 428.
5. Triggers: misma normalización para guardar, probar y atribuir; listas vacías solo para default con descubrimiento o borrador.
6. Prompts: retiradas fórmula, sabor, peso, dosis, duración, certificados y envío/pago fijos. Solo se afirman los hechos de la ficha. Anti-curar, vulnerabilidad, llamada y pedido siguen protegidos.
7. Seguimientos: config/vertical/producto de la campaña del lead; canal del dueño; no instancia global cuando falta su canal. Plantillas e idioma por canal. Las variables usan el producto configurado. Un template desconocido se registra con nombre/variables, sin atribuirle un cuerpo de otra plantilla.
8. Evaluaciones: tenant del token en el cerebro y el juez; rúbrica orientada al objetivo del negocio. Una escalada legítima al equipo no es un fallo de identidad.
9. Seeds: un solo motor validado antes de escribir; teléfonos/triggers normalizados; roles, referencias, duplicados y tipos comprobados; transacción y versiones. La fuente dashboard conserva la ficha existente.
10. Gates: AST para JS/CJS/MJS/TS/TSX, concatenaciones, templates y JSX; cubre API, scripts, seeds, frontend y shared sin exenciones de archivos. Marcas y alias salen de los JSON. CI usa test:offline con BD ficticia.

## Compatibilidad y operación

- GET /v2/agent-config entrega version; PUT debe devolver esa versión. El editor conserva la versión del borrador y no borra cambios locales al refrescar una ficha en conflicto.
- No se ejecutaron seeds contra producción. Las fichas históricas de Perú Exporta no incluyen toda la información comercial vigente; el JSON lo declara y conserva la fuente dashboard. No se reutilizaron fechas antiguas como vigentes.
- storageKey sin espejo local se rechaza hasta que exista un backend de almacenamiento implementado.
- Se conserva la cadena de modelos configurada en Render. No se usó inferencia real en la verificación.

## Evidencia de verificación

- Suite completa con guard de red externa y DATABASE_URL ficticia: 460/460.
- 100 variantes de montos parciales rechazadas, dentro de las pruebas.
- Repros de concurrentes, borrado, prototipos, rutas/symlinks, firma/MIME, metadatos entre tenants y plantillas personalizadas incluidos en tests/forense-config.test.js.
- Mutaciones de hardcode (comentario falso dentro de string, concatenación, templates, JSX y moneda numérica) detectadas por tests/forense-ast.test.js.
- Build del frontend: TypeScript + Vite aprobado.
- Los tres seeds se validaron en simulación, sin conectar a la BD.
- git diff --check y sintaxis de server/seed aprobados.

La extracción final de inicio y privacidad a JSON conservó sus HTML idénticos (SHA-256 comprobado antes/después).
