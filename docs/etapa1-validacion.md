# Etapa 1: reglas y evidencia de validación

Fecha de revisión: 1 de octubre de 2026. Base: `81c45fe`.

## Comportamiento corregido

- Vulnerabilidad económica grave: comprobación antes de cualquier retorno temprano en Perú Exporta, BIOAYUR e Hidata. Respuesta empática sin añadir hechos; deriva al humano sin LLM, tokens ni costo.
- No derivar por «no estoy endeudado», venta normal de inventario, o «no tengo dinero ahora mismo». Venta de bienes o deuda requieren también una señal explícita de angustia; la falta de alimento o pérdida personal total se atiende directamente.
- Perú Exporta: una petición de llamada pasa a coordinación sin cuestionario. Una petición inmediata deriva al humano. Un horario propuesto por el bot no se guarda como aceptación; se conserva el día solicitado y el equipo confirma disponibilidad.
- Rechazo de llamada: respetarlo también cuando el modelo devuelve JSON válido o corrige un precio. Borrar la cita anterior al cancelar y avisar al equipo por chat cuando corresponda. Guardar la preferencia de contacto aunque se recorte el historial; una nueva solicitud expresa puede cambiarla.
- Hidata H07: pedido explícito con producto de campaña, cantidad, nombre, ubicación y dirección va al equipo. La referencia no es obligatoria. No asumir datos faltantes ni convertir otro producto en el de la ficha.
- C010: compartir evidencia literal de la ficha; neutralizar el aval estatal y el caso «don Luis» si no están documentados. Este control cubre los fallos observados, no valida cualquier afirmación factual imaginable.

Las reglas de solicitudes de llamada y evidencia se limitan a exportación; la regla de pedido se limita a tienda. La vulnerabilidad se aplica a los tres verticales.

## Pruebas locales

Desde `apps/api`: `npm run test:offline`.

Resultado: 393/393 pruebas aprobadas, incluidas 72 nuevas pruebas de integración. El guard de pruebas bloquea HTTP, HTTPS y fetch externos; permite servidores simulados locales. No se repitió el banco de modelos ni se enviaron mensajes de WhatsApp.

## Qué muestran los bancos anteriores

Los JSON de 52 casos guardan disponibilidad técnica (`ok`), mensaje, flags y latencia. No contienen una puntuación de rúbrica ni un resultado de veto por caso. Los tres casos H08/H09/H11 fueron respuestas deterministas, no llamadas al modelo.

| Modelo | Respuestas LLM válidas | Respuestas por regla | p50 LLM | p95 LLM | Observación previa |
|---|---:|---:|---:|---:|---|
| GPT-6 Luna | 49/49 | 3 | 7.27 s | 11.85 s | Sin flags de precio; B03 neutralizado por guardrail |
| GPT-4o-mini | 49/49 | 3 | 3.44 s | 5.66 s | C023/C052 débiles según revisión de mensajes |
| Gemini 3.1 Flash Lite | 49/49 | 3 | 2.46 s | 7.39 s | H07 no escalaba; C023 volvía al cuestionario |
| Laguna S 2.1 | 48/49 | 3 | 4.60 s | 15.65 s | C037 JSON inválido |
| Gemma 4 31B | 49/49 | 3 | 4.94 s | 11.04 s | H07 no escalaba |

Estos resultados pertenecen al banco anterior a las correcciones. Las nuevas reglas hacen que algunos casos dejen de llamar al LLM; no atribuir esa mejora al modelo ni convertir «52 respuestas recibidas» en «52 casos aprobados con rúbrica».

En cada banco faltan costos medidos para las 49 llamadas al LLM. US$0.40/día a 300 mensajes y el gasto total de auditoría son estimaciones comunicadas, no valores verificados con recibos o saldo. Los reintentos y la longitud real de cada conversación cambian el costo.

## Configuración de modelos

Primario: `openrouter:openai/gpt-6-luna` (se necesita el prefijo `openai/`).

Respaldos actuales: `openrouter:google/gemini-3.1-flash-lite,openrouter:poolside/laguna-s-2.1,mistral:ministral-14b-latest`.

Los fallbacks responden a fallos técnicos o JSON inválido. Las reglas de negocio anteriores evitan que los casos cubiertos dependan de una respuesta semántica de esos modelos. La disponibilidad 4/4 del health no sustituye las pruebas de negocio.

## Ciclo de vida de Google

La fecha «16 de octubre de 2026 para toda la familia 2.5» no coincide con la documentación vigente consultada el 1 de octubre:

- [Vertex / Gemini Enterprise Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions): 20 de octubre de 2026 para Gemini 2.5 Pro, Flash y Flash-Lite de texto.
- [Gemini Developer API](https://ai.google.dev/gemini-api/docs/deprecations): sin fecha anunciada para esos tres modelos de texto; el acceso está limitado a usuarios previos. Los modelos de imagen y previews tienen calendarios distintos.

## Aplicación a producción

Este cambio no necesita migraciones ni variables nuevas. Al fusionarlo en `main`, Render debe desplegar el commit aprobado. Verificar commit `live` y health, conservando la cadena de modelos actual. El rollback de código y el cambio de proveedor son decisiones separadas; volver a Mistral no corrige por sí solo los fallos de negocio.