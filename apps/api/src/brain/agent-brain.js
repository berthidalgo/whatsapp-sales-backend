// src/brain/agent-brain.js — Hidata v20 · Sprint 3 (Cerebro unificado)
//
// ════════════════════════════════════════════════════════════════════════
// EL CEREBRO — un solo agente que RAZONA, no un pipeline que clasifica.
//
// QUÉ REEMPLAZA (cuando se cablee): la cadena rígida
// Perception(encajona en intents) → FSM/Policy(elige UNA acción) → Response(rellena plantilla)
// que hacía al bot sonar a autoresponder: ignoraba múltiples preguntas,
// alucinaba slots ("palta"), y solo podía hacer una cosa por turno.
//
// QUÉ HACE EN SU LUGAR (fundado en literatura 2025-2026):
// - RAISE (arXiv 2401.02777, probado en ventas inmobiliarias): scratchpad
//   de razonamiento + memoria + ejemplos sobre ReAct.
// - StateAct (arXiv 2410.02810): el LLM mantiene el ESTADO él mismo vía
//   self-prompting, en vez de una FSM rígida diseñada a mano.
// - SalesLLM (arXiv 2604.07054): el reto medible es la "role inversion"
//   (el bot se confunde de quién es quién) — la combatimos con reglas duras.
//
// PRINCIPIO DE DISEÑO (lo que nos diferencia de Kommo/autoresponders):
// Libertad EN LA GENERACIÓN + control EN LA VALIDACIÓN.
// El cerebro responde LIBRE como un humano (atiende N preguntas, con persona).
// Los guardrails determinísticos validan la SALIDA (que no invente precio,
// que no prometa, que no confirme pago sin evidencia) ANTES de enviar.
// El FSM deja de ser una jaula y pasa a ser una BRÚJULA (le dice al cerebro
// en qué etapa está y cuál es su meta, pero NO le dicta la frase).
//
// SALIDA ESTRUCTURADA EN UN SOLO TURNO (esto mata "una acción por turno"):
// { mensaje, estado_actualizado, acciones, razonamiento }
// → la respuesta natural + qué slots se llenaron + a qué stage pasar +
//   si hay que escalar a humano, TODO de una vez.
//
// ════════════════════════════════════════════════════════════════════════
// AFINAMIENTO Fase A (jun 2026) — destilado de 5 chats de producción + los 3
// chats de éxito REALES de Francisco (Alberto/Rafael/Jean). Cambios v1→v2:
//
//  FIX #1 (placeholder roto): el guardrail de precio borraba la cifra fantasma
//    y la reemplazaba con "el detalle de la inversión (lo vemos juntos en la
//    llamada)" — frase rota que el lead VE y que delata al bot (caso real JH).
//    Ahora reemplaza con una frase humana que fluye, sin frankenstein gramatical.
//
//  FIX #7+#8 (fecha relativa): el cerebro perdía el DÍA acordado cuando el lead
//    cambiaba solo la hora en otro turno ("mañana 11am" → "hoy en unos minutos",
//    caso real nicobtez). Y "ahorita"/"en 15 min" se forzaban al default
//    (caso real Julio). Ahora: regla dura de retención de día + escalado a humano
//    cuando el lead pide llamada INMINENTE (lead caliente, no hacerlo esperar).
//
//  FIX #3 (gate disco rayado): el bot repetía "hoy 4pm o mañana 10am" 15+ veces.
//    Ahora: regla de NO repetir la misma oferta; variar el ángulo y escalar.
//
//  PATRÓN FRANCISCO (dar antes de pedir): los cierres reales muestran que el
//    bot debe DAR info + precio con generosidad (con descuento tachado como
//    gatillo de urgencia) ANTES de gatear la llamada — no evadir todo. El gate
//    de llamada se mantiene, pero el lead recibe valor primero.
//
//  CORRECCIÓN: NO se mete el "ancla de valor café/palta" — esa es de un script
//    de LLAMADA telefónica, nunca aparece en los chats de chat de Francisco.
//
// ════════════════════════════════════════════════════════════════════════
// PROMPT v5 (Sprint A.2, jun 2026) — destilado de la prueba de 9 sesiones:
//  - TERCERA REGLA DE ORO (anti disco rayado): jamás repetir frase del historial;
//    2do esquive = cambiar jugada; 3ro = conceder o escalar; turno de reparación
//    cuando el lead se molesta. (Falla #1, confirmada en S1/S2/6B/S7/S8.)
//  - SLOT ENVENENADO (S7): producto rechazado/redirigido (importación, no peruano)
//    NO entra al slot — el estado debe decir lo mismo que la boca.
//  - Playbook ampliado: proxy ("mi hijo me dijo"), pide temario/material,
//    lead HOT no se encuesta, datos de inscripción completos no se ignoran.
//  - Saludo UNA sola vez (el re-saludo por turno delataba al bot, S7).
//  - M4 con párrafos (\n\n) obligatorios (ladrillo ilegible en S9A).
//  - M5 como micro-compromiso ("llamada corta de 10 minutos").
//  - temperatura_lead conectada al comportamiento (hot=avanza, cold=no persigas).
// ════════════════════════════════════════════════════════════════════════

import { calculateCost } from '../lib/gemini.js'
import { construirCadena, normalizarPaso, parsearPaso, ejecutarCadena, llamarPaso } from '../lib/llm-cadena.js'
import { flattenFactSheet } from '../response/factsheet-loader.js'
import { ACTIVE_TENANT } from '../lib/tenant.js'
import { getVertical } from './verticals/index.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
// El cerebro necesita razonar → tier Flash (no Lite). Configurable por env var
// BRAIN_MODEL en Render (Sprint A.2, primer ladrillo del multi-modelo D.1):
// cambiar de modelo o hacer rollback = editar la env var, sin tocar código.
// Default seguro: gemini-2.5-flash (la línea base validada).
const BRAIN_MODEL = process.env.BRAIN_MODEL || 'gemini-2.5-flash'
// BRAIN_PROVIDER (switch de PRIMARIO, jun 2026): 'gemini' (default) o 'cerebras'.
// Con BRAIN_PROVIDER=cerebras el cerebro PRINCIPAL pasa a gpt-oss-120b (gratis, ~700ms,
// calidad 80 vs pro 84 en el examen completo) y el fallback simétrico cae a Gemini.
// Reversible por env var, sin tocar código → para A/B en vivo (un día pro, otro Cerebras).
// Default sin la var = comportamiento idéntico de hoy (Gemini principal, Cerebras seguro).
// Perillas por env var (Sprint A.2, multi-modelo D.1) — prender el 3.5 en
// producción = setear estas 3 en Render, sin tocar código; rollback = borrarlas.
//   BRAIN_MODEL=gemini-3.5-flash · BRAIN_LOCATION=global · BRAIN_THINKING_LEVEL=low
// El 3.5 vive SOLO en la location 'global' (las regionales dan 404) y usa
// thinkingLevel ('low'|'medium'|'high'), NO presupuesto numérico (con budget
// numérico el 3.5 desvaría y devuelve JSON gigante cortado). Sin estas vars,
// comportamiento vivo idéntico (2.5-flash, us-central1, thinkingBudget).
const BRAIN_LOCATION = process.env.BRAIN_LOCATION || null
const BRAIN_THINKING_LEVEL = process.env.BRAIN_THINKING_LEVEL || null
const TEMPERATURE = 0.6                  // Equilibrio: natural pero no descontrolado
// Presupuesto de salida (8000) y de pensamiento (1024 en 2.x / thinkingLevel en 3.x):
// viven en lib/llm-cadena.js junto con la cadena de proveedores (sep 2026). Siguen
// valiendo los mismos motivos: el thinking consume del MISMO presupuesto que la
// respuesta, y con topes bajos los turnos pesados (M4) devolvían texto vacío.
// Seguros del primario: BRAIN_FALLBACKS (ver llm-cadena.js).

// ════════════════════════════════════════════════════════
// SCHEMA de salida estructurada — AHORA VIVE EN EL VERTICAL (jul 2026)
// Cada vertical define su RESPONSE_SCHEMA (slots y semántica de cierre propios);
// la columna vertebral (mensaje primero, razonamiento al final, campos que el
// motor espera) es el contrato compartido. Ver verticals/exportacion.js (el
// schema histórico, byte-idéntico) y verticals/colageno.js.
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// API PÚBLICA — pensarYResponder()
// ════════════════════════════════════════════════════════
/**
 * El cerebro lee TODA la conversación + contexto y produce respuesta + estado.
 *
 * @param {object} args
 * @param {string} args.mensajeActual - último mensaje del lead (o varios combinados)
 * @param {Array}  args.historial - [{ rol: 'lead'|'agente', texto }] conversación completa
 * @param {object} args.estadoLead - { stage, slots, mode, nombre }
 * @param {object} args.campaignConfig - el config de la campaña (factSheet, agente, comportamiento)
 * @param {string?} args.vendorNombre
 * @returns {Promise<object>} { ok, mensaje, slots_detectados, stage_sugerido, debe_escalar_humano, ... }
 */
export async function pensarYResponder({
  mensajeActual,
  historial = [],
  estadoLead = {},
  campaignConfig = null,
  vendorNombre = 'el equipo',
  // ── overrides SOLO para el banco de pruebas (Sprint A.2) ──
  // En producción NO se pasan → quedan en null y el cerebro corre con las
  // perillas vivas (cadena de proveedores, schema del vertical). Esto permite domar
  // gemini-3.5 EN BANCO (probar thinkingLevel:'low', quitar responseSchema)
  // sin tocar una sola línea del flujo en vivo.
  overrides = null
}) {
  const startTime = Date.now()

  // ── VERTICAL (jul 2026): el manual de venta según campaña/tenant ──
  // exportacion (Perú Exporta, default histórico) | colageno (BIOAYUR).
  // La campaña manda (config.vertical); si no, el default del tenant.
  const vertical = getVertical(campaignConfig, estadoLead?.tenantId)
  const usarSchema = overrides?.sinSchema ? null : vertical.RESPONSE_SCHEMA

  // La campaña general de Hidata describe el negocio, pero no un producto.
  // Una mención vaga o una foto sin analizar no puede convertirse en atributos inventados.
  if (vertical.VERTICAL_ID === 'tienda' && campaignConfig?.atribucion?.esCampanaDefault === true) {
    const yaRespondio = Array.isArray(historial) && historial.some(m => m?.rol === 'agente')
    const saludo = /^(?:hola|buenas(?:\s+(?:tardes|noches|d[ií]as))?|buenos\s+d[ií]as)(?:[!,\.\s]+(?:quiero|deseo|busco)\s+informaci[oó]n)?[!?.\s]*$/i.test(String(mensajeActual).trim())
    const pedirProducto = !yaRespondio && saludo
    const mencionaFoto = /\b(foto|imagen|fotograf[ií]a)\b/i.test(String(mensajeActual))
    const mencionaPdf = /\b(pdf|documento)\b/i.test(String(mensajeActual))
    const pdfEnHistorial = Array.isArray(historial) && historial.some(m => String(m?.texto || '').includes('[📄 el lead envió un documento]'))
    const nombreAgente = campaignConfig?.agente?.nombre || vendorNombre || 'asesor'
    const nombreEmpresa = campaignConfig?.agente?.empresa || 'la tienda'
    return {
      ok: true,
      mensaje: pedirProducto
        ? '¡Hola! Soy ' + nombreAgente + ', de ' + nombreEmpresa + ' 😊 ¿Qué producto viste en el anuncio?'
        : mencionaPdf
          ? pdfEnHistorial
            ? 'Sí, recibimos tu documento 🙌 No puedo leer su contenido automáticamente. ¿Qué necesitas saber sobre él?'
            : 'No tengo confirmado un PDF en este chat. ¿Puedes enviarlo de nuevo?'
          : mencionaFoto
            ? 'Recibí tu mensaje. No puedo confirmar qué muestra la foto ni los detalles del producto sin revisarlos. Dejo tu consulta registrada para que el equipo la revise.'
            : 'Gracias por escribir. Para darte datos exactos del producto, necesito revisar su ficha. Dejo tu consulta registrada para que el equipo la revise.',
      razonamiento: 'Campaña general sin ficha de producto.',
      slots_detectados: {},
      momento_actual: pedirProducto ? 'M1' : 'M2',
      stage_sugerido: pedirProducto ? 'first_contact' : 'discovery',
      debe_escalar_humano: !pedirProducto && !mencionaPdf,
      razon_escalamiento: (pedirProducto || mencionaPdf) ? null : 'consulta de producto sin ficha',
      como_cerrarlo: (pedirProducto || mencionaPdf) ? null : 'Identificar producto y confirmar sus datos antes de responder.',
      temperatura_lead: 'warm',
      compromiso: null,
      cierre: null,
      enviar_imagen: null,
      guardrail_flags: ['campana_general_sin_ficha_producto'],
      via_fallback: false,
      audit: { model: 'regla_tienda_general', fallback: false, proveedor: 'regla', tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime }
    }
  }

  // Guard: si el banco pidió Developer API pero no hay key en ENV, fallar CLARO
  // (no caer en silencio a Vertex y dar números engañosos). La key JAMÁS viaja en el
  // request HTTP — el banco solo manda el flag; el servidor la lee del entorno.
  if (overrides?.useDevApi && !process.env.GEMINI_DEV_API_KEY) {
    return buildError('falta_gemini_dev_api_key', startTime, {
      hint: 'overrides.useDevApi=true pero process.env.GEMINI_DEV_API_KEY no está seteada en el entorno (Render).'
    })
  }

  // ── CADENA DE PROVEEDORES (sep 2026) ──
  // En vivo: la cadena configurada por entorno (ver lib/llm-cadena.js). Antes eran
  // dos proveedores cableados aquí y el seguro llevaba semanas muerto sin que nadie lo
  // supiera. En banco (overrides): UN paso con lo que pide el banco; el resto de la
  // cadena solo si overrides.fallback === true.
  const cadena = overrides ? cadenaDeBanco(overrides) : construirCadena()
  if (!cadena.length) {
    return buildError('sin_proveedores_llm', startTime, { hint: 'Ningún proveedor configurado (revisa BRAIN_PROVIDER y las llaves).' })
  }

  const fs = flattenFactSheet(campaignConfig)
  const systemInstruction = vertical.construirSystemPrompt({ campaignConfig, fs, vendorNombre, estadoLead })
  const userPrompt = construirUserPrompt({ mensajeActual, historial, estadoLead, vertical })
  const llamarCon = (prompt) => (paso) => llamarPaso(paso, {
    systemInstruction, userPrompt: prompt, schema: usarSchema, temperature: TEMPERATURE,
    tenantId: estadoLead?.tenantId || ACTIVE_TENANT
  })

  try {
    // Reintentos, clasificación de errores, circuit breaker y fallback: todo en la
    // cadena. Un JSON roto o sin "mensaje" cuenta como fallo y se reintenta.
    const ejec = await ejecutarCadena({
      cadena,
      llamar: llamarCon(userPrompt),
      parsear: parsearJsonCerebro
    })

    let parsed = ejec.parsed
    const lastRawText = ejec.ultimoTexto
    const modeloFinal = ejec.paso?.model || cadena[0].model
    const usoFallback = ejec.indice > 0

    // Si ningún proveedor entregó JSON válido, rescate final: extraer SOLO el mensaje
    // del texto crudo (el mensaje va PRIMERO en el JSON, así que aunque esté cortado,
    // el campo "mensaje" suele estar completo). Mejor un mensaje sin metadatos que un hueco mudo.
    if (!parsed) {
      const rescatado = rescatarMensaje(lastRawText)
      if (rescatado) {
        console.warn('[AgentBrain] Usando mensaje rescatado de JSON incompleto')
        parsed = { mensaje: rescatado, stage_sugerido: estadoLead?.stage || 'discovery', debe_escalar_humano: false, temperatura_lead: 'warm' }
      } else {
        const ultimo = ejec.errores[ejec.errores.length - 1]
        return buildError('brain_json_parse_failed', startTime, {
          parse_error: ultimo ? `${ultimo.paso}: ${ultimo.status ? 'HTTP ' + ultimo.status + ' ' : ''}${ultimo.error}` : 'desconocido',
          errores: ejec.errores.slice(-8),
          raw_length: lastRawText?.length || 0,
          raw_preview: lastRawText?.slice(0, 300),
          raw_tail: lastRawText?.slice(-150)
        })
      }
    }

    let usage = ejec.result?.usage || null

    // ─── GUARDRAIL DE SALIDA (control determinístico post-generación) ───
    // Aquí está la red de seguridad: validamos lo que el cerebro produjo
    // ANTES de devolverlo. Esto es lo que nos diferencia de un autoresponder.
    const yaSaludo = Array.isArray(historial) && historial.some(m => m?.rol === 'agente')
    const validar = (p) => validarSalida(p, fs, estadoLead?.slots?.nombre, yaSaludo, vertical)
    let validado = validar(parsed)

    // ─── PRECIO QUE NO SALE DE LA FICHA → UNA CORRECCIÓN (sep 2026) ───
    // Con ficha, el guardrail solo MARCABA la cifra inventada y el mensaje salía igual:
    // en la prueba con Ministral el bot dijo "S/ 319" por el pack de 3 (el real es
    // S/ 329), y ese precio lo reclama la clienta al recibir. Borrar la oración no sirve
    // en el Momento 4 (el precio ES el mensaje), así que primero se le devuelve el
    // borrador al modelo con los precios reales para que lo reescriba. Si la corrección
    // también falla, se neutraliza la oración: es preferible omitir el precio a dar uno falso.
    if (validado.preciosMalos.length) {
      const malos = validado.preciosMalos
      const corr = await ejecutarCadena({
        cadena,
        llamar: llamarCon(userPrompt + notaCorreccionPrecio({ borrador: validado.mensaje, malos, fs })),
        parsear: parsearJsonCerebro,
        intentosPrimario: 1,
        intentosSeguro: 1
      })
      usage = sumarUso(usage, corr.result?.usage)
      const v2 = corr.parsed ? validar(corr.parsed) : null
      if (v2 && !v2.preciosMalos.length) {
        parsed = corr.parsed
        validado = { ...v2, flags: [...v2.flags, `precio_corregido_por_reintento:${malos.join('|')}`] }
        console.warn(`[AgentBrain] 💲 precio fuera de la ficha (${malos.join(', ')}) corregido con un reintento`)
      } else {
        const frase = vertical?.FRASE_PRECIO_SIN_FICHA || FRASE_PRECIO_DEFAULT
        validado = {
          ...validado,
          mensaje: neutralizarOraciones(validado.mensaje, (o) => malos.some(t => o.includes(t)), frase),
          flags: [...validado.flags, 'precio_neutralizado_oracion_completa']
        }
        console.warn(`[AgentBrain] 💲 precio fuera de la ficha (${malos.join(', ')}) sin corrección válida → oración neutralizada`)
      }
    }

    return {
      ok: true,
      mensaje: validado.mensaje,
      razonamiento: parsed.razonamiento || '',
      slots_detectados: parsed.slots_detectados || {},
      momento_actual: parsed.momento_actual || null,
      stage_sugerido: parsed.stage_sugerido || estadoLead?.stage || 'discovery',
      debe_escalar_humano: parsed.debe_escalar_humano === true,
      razon_escalamiento: parsed.razon_escalamiento || null,
      como_cerrarlo: parsed.como_cerrarlo || null,
      temperatura_lead: parsed.temperatura_lead || 'warm',
      compromiso: parsed.compromiso || null,   // motor de compromisos (Fase D): {tipo, descripcion, fecha_iso}
      cierre: parsed.cierre || null,           // closer consultivo (v5_5): {ofrecio_llamada, objecion_trabajada, palanca}
      enviar_imagen: parsed.enviar_imagen || null,  // vertical colágeno: 'precios' → el sistema adjunta la foto en M4
      guardrail_flags: validado.flags,
      via_fallback: usoFallback,   // true si respondió un seguro de la cadena (no el primario)
      audit: {
        model: modeloFinal,
        fallback: usoFallback,
        proveedor: ejec.paso?.id || null,
        tokens: usage?.totalTokenCount || 0,
        cost_usd: usage ? calculateCost(modeloFinal, usage) : null,
        latency_ms: Date.now() - startTime
      }
    }

  } catch (err) {
    console.error('[AgentBrain] Error:', err.message)
    return buildError('brain_exception', startTime, { message: err.message })
  }
}

// ════════════════════════════════════════════════════════
// SYSTEM PROMPT — MOVIDO A verticals/ (refactor jul 2026)
// El contenido de exportación (MOMENTOS, construirSystemPrompt, guía del
// supervisor) vive byte-idéntico en verticals/exportacion.js. Se RE-EXPORTA
// desde aquí para no romper a los consumidores históricos (flow-materializer,
// tests de flow-overrides, snapshot) — para ellos nada cambió.
// ════════════════════════════════════════════════════════
export {
  MOMENTOS,
  MOMENTO_SUPERVISOR,
  construirFlujoMomentos,
  flowOverridesEnabled,
  construirGuiaSupervisor,
  construirSystemPrompt
} from './verticals/exportacion.js'

// ════════════════════════════════════════════════════════
// USER PROMPT — la conversación + el estado actual + lo que cambia en cada turno
//
// CACHÉ DE PREFIJO (sep 2026): la hora ("AHORA MISMO"), la memoria del contacto y su
// historial de cierre vivían DENTRO del system prompt, la hora en su segunda línea.
// Los proveedores descuentan la parte del pedido que es idéntica desde el primer
// carácter a un pedido anterior (Gemini y Groq, por ejemplo), y la hora cambia cada
// minuto: de ~11K tokens de manual, solo ~70 se reconocían. Ahora el system prompt es
// fijo por campaña y todo lo variable viaja aquí. El orden sigue la misma idea: la
// memoria (fija para este contacto) y la conversación (crece turno a turno) van
// antes que la hora y el cierre, que cambian siempre.
// ════════════════════════════════════════════════════════
export function bloqueAhoraMismo(ahora = new Date()) {
  const ahoraPeru = ahora.toLocaleString('es-PE', {
    timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  })
  return `# AHORA MISMO
Hoy es ${ahoraPeru} (hora de Perú, zona UTC-05:00). Úsalo para entender "hoy", "mañana", "el viernes", etc., y para fechar cualquier compromiso con la zona -05:00.`
}

export function construirUserPrompt({ mensajeActual, historial = [], estadoLead, vertical = null, ahora = new Date() }) {
  const slots = estadoLead?.slots || {}
  const slotsConocidos = Object.entries(slots)
    // Claves con guion bajo (ej. _cierre) son ESTADO INTERNO del closer, no datos
    // que el lead reveló → no se listan como "datos que conozco del lead".
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || '(ninguno todavía)'

  // Historial en formato legible (la MEMORIA de la conversación)
  const historialTexto = historial.length
    ? historial.map(h => `${h.rol === 'lead' ? 'LEAD' : nombreCorto(estadoLead)}: ${h.texto}`).join('\n')
    : '(esta es la primera interacción)'

  // Memoria episódica (lead que vuelve): la arma brain-pipeline; null si es nuevo.
  const memoria = estadoLead?.memoriaEpisodica ? `${estadoLead.memoriaEpisodica}\n\n` : ''
  // Historial de cierre del closer (v5_5): el texto es del vertical ("la llamada" en
  // exportación, "el pedido" en colágeno). null al inicio → no aparece.
  const cierre = (estadoLead?.cierreResumen && typeof vertical?.textoHistorialCierre === 'function')
    ? `\n\n${vertical.textoHistorialCierre(estadoLead.cierreResumen)}`
    : ''

  return `${memoria}# CONVERSACIÓN HASTA AHORA
${historialTexto}

${bloqueAhoraMismo(ahora)}${cierre}

# ESTADO ACTUAL DEL LEAD
- Etapa del funnel: ${estadoLead?.stage || 'first_contact'}
- Datos que ya conozco del lead: ${slotsConocidos}

# ÚLTIMO MENSAJE DEL LEAD (responde a esto, atendiendo TODAS sus preguntas)
"${mensajeActual}"

Razona primero (qué preguntó, qué le falta, qué conviene), luego responde como la persona que eres. Devuelve el JSON estructurado.`
}

function nombreCorto(estadoLead) {
  return estadoLead?.agenteNombre || 'AGENTE'
}

// ════════════════════════════════════════════════════════
// GUARDRAIL DE SALIDA — control determinístico post-generación
// La red de seguridad: valida lo que el cerebro dijo ANTES de enviarlo.
// ════════════════════════════════════════════════════════
// Guardrail del nombre como función PURA (testeable): quita el vocativo ", Nombre"
// usando SOLO el primer token del nombre → robusto a nombres completos ("Blanca Hidalgo
// Tacas" — bug cazado en el test de Blanca 2026-06-22: el slot guardaba el nombre
// completo, el regex buscaba ", Blanca Hidalgo Tacas" que nunca aparece → no limpiaba,
// Blanca salió 5/9 vs Oscar 1/17). Devuelve { mensaje, limpiado }.
export function limpiarVocativoNombre(mensaje, nombreConocido) {
  const primerNombre = (typeof nombreConocido === 'string' ? nombreConocido : '').trim().split(/\s+/)[0] || ''
  if (primerNombre.length < 2) return { mensaje, limpiado: false }
  const n = primerNombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const limpio = mensaje
    .replace(new RegExp(`\\s*,\\s*${n}\\b(?=[\\s,.!?:;]|$)`, 'gi'), '')  // "..., Oscar." → "..."
    .replace(new RegExp(`(^|¡)\\s*${n}\\s*,\\s*`, 'gi'), '$1')           // "Oscar, ..." → "..."
    .replace(/¡\s*([!.])/g, '$1')                                        // "¡!" residual → limpio
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return { mensaje: limpio, limpiado: limpio !== mensaje }
}

// Guardrail del RE-SALUDO como función PURA (testeable): si el bot YA saludó antes en
// la conversación (yaSaludo), abrir de nuevo con "¡Hola [nombre]!" / "Buenas tardes!" /
// "Un gusto saludarte." es un tic de bot que delata (el prompt lo prohíbe pero el modelo
// reincide). Quita SOLO el saludo de apertura, dejando el resto del mensaje. Conservador:
// si al quitarlo el mensaje queda vacío/casi vacío (era SOLO saludo), NO toca.
export function limpiarReSaludo(mensaje, yaSaludo) {
  if (!yaSaludo || typeof mensaje !== 'string') return { mensaje, limpiado: false }
  let m = mensaje
    .replace(/^\s*[¡!]*\s*hola\b[^.!?\n]*[.!?]+\s*/i, '')                              // "¡Hola [nombre]!"
    .replace(/^\s*[¡!]*\s*buen[oa]s(\s+(d[ií]as|tardes|noches))?\b[^.!?\n]*[.!?]+\s*/i, '') // "Buenas tardes!"
    .replace(/^\s*[¡!]*\s*(un|qué|que)\s+gusto\b[^.!?\n]*[.!?]+\s*/i, '')              // "Un gusto saludarte."
    // Solo un "¡" huérfano: el que abre la frase siguiente se queda ("¡Hola! ¡Perfecto!"
    // → "¡Perfecto!"; antes salía "Perfecto!", sin el signo de apertura).
    .replace(/^\s*¡+(?![\p{L}¿])/u, '')
    .trim()
  if (m.length < 8 || m === mensaje.trim()) return { mensaje, limpiado: false }       // era casi solo saludo → no tocar
  m = m.charAt(0).toUpperCase() + m.slice(1)                                          // capitaliza lo que quedó
  return { mensaje: m, limpiado: true }
}

// ════════════════════════════════════════════════════════
// DINERO EN EL MENSAJE — detector, respaldo en la ficha y neutralizador
// ════════════════════════════════════════════════════════
// Qué cuenta como dinero (AMPLIADO en la auditoría pre-producción, jul 2026: antes solo
// el SÍMBOLO delante, y "cuesta 2500 soles" llegaba al lead sin marcar):
//   · símbolo delante: "S/ 1,500", "$300"
//   · moneda detrás:   "1500 soles", "300 dólares", "2500 PEN"
//   · símbolo pegado:  "S/1500"
// Deliberadamente NO se marcan números sueltos ("12 sesiones", "1,300 alumnos"): eso
// llenaría de falsos positivos y, sin factSheet, NEUTRALIZARÍA mensajes sanos.
export const RX_DINERO = /(?:S\/\.?\s?\d[\d,\.]*)|(?:\$\s?\d[\d,\.]*)|(?:\d[\d,\.]*\s?(?:soles|sol|dólares|dolares|usd|pen|euros?|eur)\b)/gi

const FRASE_PRECIO_DEFAULT = ' El precio exacto te lo confirmo en un momento 😊'

/** "S/ 1,500" → 1500 · "S/ 124.50" → 124.5 · "124,50 soles" → 124.5 · "S/. 139" → 139 */
export function montoDe(texto) {
  const m = String(texto || '').match(/\d[\d.,]*/)
  if (!m) return null
  let s = m[0].replace(/[.,]+$/, '')                                                        // "329." al cerrar la frase
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')                         // 1,500 · 1,500.50
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.') // 1.500 · 1.500,50
  else s = s.replace(',', '.')                                                               // 124,50
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Qué cifras respalda la ficha. Antes se comparaban DÍGITOS concatenados como texto:
// "S/ 24" pasaba porque "24" está dentro de "249", y un precio por envase bien
// calculado (S/ 329 ÷ 3 = S/ 109.67) se marcaba como inventado. Ahora se compara el
// MONTO, y además de las cifras de la ficha cuentan las cuentas que hace un vendedor
// con ella, pero solo si la frase dice que es esa cuenta (sin la frase, "S/ 169" sería
// un precio de pack inventado que casualmente es 339 ÷ 2):
//   · lo que sale cada unidad de un pack ("c/u", "por envase", "al mes"): total ÷ 2..6, ±S/ 1
//   · el ahorro ("ahorras", "descuento", "menos"): diferencia entre dos precios, o N sueltos vs el pack
//   · lo que sale al día o por porción: menor que el precio mayor ÷ 15
const RX_POR_UNIDAD = /c\/u|cada\s+(uno|una|envase|frasco|unidad|caja|pote|mes)|por\s+(envase|unidad|frasco|caja|pote|mes)|la\s+unidad|al\s+mes|mensual/i
const RX_AHORRO = /ahorr|descuento|dscto|rebaja|diferencia|menos/i
const RX_POR_DIA = /\bd[ií]as?\b|diari|porci[oó]n/i

function montosDeLaFicha(fs) {
  const exactos = new Set()
  const precios = new Set()
  const agregar = (set, n) => { if (Number.isFinite(n) && n > 0) set.add(n) }
  const camposPrecio = `${fs?.precioTexto || ''} ${fs?.ofertaHoyTexto || ''}`
  // En los campos de precio cuenta todo número (la ficha puede decir "3 envases: 339").
  for (const m of camposPrecio.matchAll(/\d[\d.,]*/g)) agregar(exactos, montoDe(m[0]))
  // El dinero de toda la ficha (garantía, píldoras, FAQ) es la base de las cuentas.
  for (const m of `${camposPrecio} ${fs?.factSheetBloque || ''}`.matchAll(RX_DINERO)) agregar(precios, montoDe(m[0]))
  agregar(precios, fs?.precioMonto == null ? NaN : Number(fs.precioMonto))
  for (const p of precios) exactos.add(p)
  return { exactos: [...exactos], precios: [...precios] }
}

function montoRespaldado(x, { exactos, precios }, contexto) {
  const cerca = (a, b, tol) => Math.abs(a - b) <= tol
  if (exactos.some(b => cerca(x, b, 0.01))) return true
  if (RX_POR_UNIDAD.test(contexto)) {
    for (const b of precios) for (let n = 2; n <= 6; n++) if (cerca(x, b / n, 1)) return true
  }
  if (RX_AHORRO.test(contexto)) {
    for (const a of precios) for (const b of precios) {
      if (a !== b && cerca(x, Math.abs(a - b), 0.01)) return true
      for (let n = 2; n <= 6; n++) if (n * a > b && cerca(x, n * a - b, 0.01)) return true
    }
  }
  return RX_POR_DIA.test(contexto) && x <= Math.max(0, ...precios) / 15
}

/**
 * Revisa el dinero del mensaje contra la ficha (función pura).
 * @returns {{ detectados: string[], malos: string[], sinFicha: boolean }}
 *   sinFicha=true: la campaña no tiene precio y TODA cifra es inventada.
 */
export function revisarPrecios(mensaje, fs) {
  const texto = String(mensaje || '')
  const hallados = [...texto.matchAll(RX_DINERO)]
  const limpio = (t) => t.trim().replace(/[.,]+$/, '')
  const detectados = hallados.map(m => limpio(m[0]))
  if (!hallados.length) return { detectados, malos: [], sinFicha: false }
  if (!fs?.precioTexto) return { detectados, malos: detectados, sinFicha: true }
  const ficha = montosDeLaFicha(fs)
  const malos = hallados
    .filter(m => {
      const x = montoDe(m[0])
      if (x === null) return false
      const contexto = texto.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
      return !montoRespaldado(x, ficha, contexto)
    })
    .map(m => limpio(m[0]))
  return { detectados, malos, sinFicha: false }
}

/**
 * Parte un mensaje en oraciones sin perder un solo carácter (join('') lo reconstruye).
 * El punto cierra oración solo si le sigue un espacio o el final: así "S/ 124.50" y
 * "S/. 139" quedan enteros. Los saltos de línea van como piezas propias, para que los
 * párrafos del Momento 4 sobrevivan a la neutralización (antes se aplastaban a espacios).
 */
export function partirOraciones(texto) {
  const partes = []
  let inicio = 0
  const rx = /[.!?]+(?=\s|$)|\n+/g
  let m
  while ((m = rx.exec(texto))) {
    if (m[0] === '.' && /S\/$/i.test(texto.slice(0, m.index))) continue   // "S/." es el símbolo del sol
    if (m[0][0] === '\n') {
      if (m.index > inicio) partes.push(texto.slice(inicio, m.index))
      partes.push(m[0])
    } else {
      partes.push(texto.slice(inicio, m.index + m[0].length))
    }
    inicio = m.index + m[0].length
  }
  if (inicio < texto.length) partes.push(texto.slice(inicio))
  return partes
}

/**
 * Cambia la PRIMERA oración que cumple `esMala` por `frase` y borra las demás que la
 * cumplan. Reemplazar solo la cifra rompe la gramática (caso real JH, jun 2026:
 * "tiene una inversión de el detalle de la inversión..."); la oración completa no.
 */
export function neutralizarOraciones(mensaje, esMala, frase) {
  let puesta = false
  const out = partirOraciones(String(mensaje || ''))
    .map(o => {
      if (!esMala(o)) return o
      if (puesta) return ''
      puesta = true
      return frase
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out || frase.trim()
}

/** Lo que se le agrega al pedido cuando el borrador trae un precio que la ficha no respalda. */
export function notaCorreccionPrecio({ borrador, malos, fs }) {
  const oferta = fs?.ofertaHoyTexto ? `\nOferta de hoy: ${fs.ofertaHoyTexto}` : ''
  return `

# ⚠️ CORRIGE TU BORRADOR ANTES DE ENVIARLO
Ibas a responder: "${borrador}"
Ahí escribiste ${malos.join(', ')}, y esa cifra NO sale de la ficha: no existe. Los precios REALES son estos, y ninguno más:
${fs?.precioTexto || ''}${oferta}
Reescribe tu respuesta con esas cifras exactas (si das lo que sale cada unidad, divide el total del pack entre sus unidades). Mismo tono y misma intención: solo corrige el dinero. Devuelve el JSON estructurado completo.`
}

function sumarUso(a, b) {
  if (!a) return b || null
  if (!b) return a
  const s = (k) => (a[k] || 0) + (b[k] || 0)
  return { ...a, promptTokenCount: s('promptTokenCount'), candidatesTokenCount: s('candidatesTokenCount'), totalTokenCount: s('totalTokenCount') }
}


/**
 * Valida el mensaje del cerebro contra el factSheet.
 * Precio sin ficha → neutraliza la oración. Precio que la ficha no respalda → lo marca
 * y lo devuelve en `preciosMalos` (pensarYResponder pide la corrección).
 * El vertical puede aportar validaciones EXTRA de su negocio (ej. colágeno:
 * guardrail anti-"curar" DIGEMID) vía vertical.validarMensajeExtra.
 *
 * @returns {{ mensaje: string, flags: string[], preciosMalos: string[] }}
 */
function validarSalida(parsed, fs, nombreConocido = null, yaSaludo = false, vertical = null) {
  const flags = []
  let mensaje = parsed.mensaje || ''

  // ── Guardrail del VERTICAL (jul 2026): corre PRIMERO — es la red legal del
  //    negocio (ej. anti-"curar" de colágeno) y debe ver el mensaje entero antes
  //    de que los limpiadores genéricos lo recorten. Exportación no añade nada. ──
  if (vertical?.validarMensajeExtra) {
    const rv = vertical.validarMensajeExtra(mensaje)
    if (rv.flags.length) { mensaje = rv.mensaje; flags.push(...rv.flags) }
  }

  // ── Guardrail 0: formato WhatsApp (determinístico) ──
  // El prompt PIDE no usar negrita markdown (**texto**), pero el modelo a veces
  // insiste (sobre todo al listar el temario). En vez de confiar en que obedezca,
  // lo limpiamos sí o sí: ** → * (negrita real de WhatsApp) y se quitan los
  // títulos markdown (#). WhatsApp muestra ** y # literales y eso delata al bot.
  if (/\*\*|^#{1,6}\s|\n#{1,6}\s/m.test(mensaje)) {
    mensaje = mensaje
      .replace(/\*\*+/g, '*')            // **negrita** → *negrita* (WhatsApp bold)
      .replace(/^#{1,6}\s*/gm, '')       // títulos markdown al inicio de línea → fuera
    flags.push('formato_markdown_limpiado')
  }

  // ── Guardrail 3: nombre del lead repetido (tic de bot/telemarketing) ──
  // Gemini tiende a meter el nombre del lead como vocativo en CADA mensaje
  // ("Entendido, Oscar", "¡Genial, Oscar!") → suena a telemarketing y delata al bot.
  // El prompt lo pide moderar pero el modelo no obedece (visto 13/17 en vivo). Lo
  // limpiamos determinísticamente: si el nombre YA era conocido de un turno previo
  // (nombreConocido), quitamos el vocativo con coma. En el turno que RECIÉN lo aprende
  // (nombreConocido vacío), NO se toca → conserva el "¡un gusto, Oscar!" de bienvenida.
  const r3 = limpiarVocativoNombre(mensaje, nombreConocido)
  if (r3.limpiado) { mensaje = r3.mensaje; flags.push('nombre_vocativo_limpiado') }

  // ── Guardrail 4: re-saludo (si ya saludó antes, no vuelve a abrir con "Hola/Buenas") ──
  const r4 = limpiarReSaludo(mensaje, yaSaludo)
  if (r4.limpiado) { mensaje = r4.mensaje; flags.push('re_saludo_limpiado') }

  // ── Guardrail 1: precio fantasma ──
  // Busca cifras de dinero en el mensaje y las verifica contra el factSheet (qué
  // cuenta como dinero y qué cifras respalda la ficha: ver revisarPrecios).
  const precios = revisarPrecios(mensaje, fs)
  let preciosMalos = []
  if (precios.sinFicha) {
    // CASO MÁS PELIGROSO: la campaña no tiene precio en su factSheet, pero el
    // cerebro escribió una cifra → es inventada sí o sí. Marcar TODAS.
    for (const p of precios.malos) flags.push(`precio_inventado_sin_factsheet:${p}`)
  } else if (precios.malos.length) {
    // Hay ficha y la cifra no sale de ella. Aquí solo se MARCA: pensarYResponder le
    // pide al modelo que corrija el borrador y, si no lo logra, neutraliza la oración.
    preciosMalos = precios.malos
    for (const p of preciosMalos) flags.push(`precio_no_coincide_factsheet:${p}`)
  }

  // ── Guardrail 2: promesas prohibidas ──
  const promesasProhibidas = [
    /garantiz/i,
    /te devuelvo/i, /devoluci[oó]n garantizada/i,
    /vas a vender seguro/i, /venta asegurada/i
  ]
  for (const patron of promesasProhibidas) {
    if (patron.test(mensaje)) {
      flags.push(`promesa_prohibida:${patron.source}`)
    }
  }

  // Sin ficha no hay precio correcto que pedirle al modelo: se neutraliza la ORACIÓN
  // COMPLETA que trae la cifra, sustituyéndola por una frase humana cerrada (ver
  // neutralizarOraciones: reemplazar solo el fragmento dejaba frankenstein gramatical).
  if (precios.sinFicha) {
    // FIX sep 2026: antes se neutralizaba con un regex SOLO de símbolo ("S/ 1500"),
    // distinto del detector. "cuesta 2500 soles" se DETECTABA y se marcaba como
    // neutralizado… pero llegaba intacto al lead. Detector y neutralizador usan ahora
    // la MISMA definición de dinero (RX_DINERO), sin flag global (test() sin estado).
    const RX_PRECIO_UNA = new RegExp(RX_DINERO.source, 'i')
    // La frase de reemplazo es del VERTICAL: "lo vemos en la llamada" solo tiene
    // sentido en exportación (colágeno cierra por chat, no por llamada).
    const fraseNeutra = vertical?.FRASE_PRECIO_SIN_FICHA || FRASE_PRECIO_DEFAULT
    mensaje = neutralizarOraciones(mensaje, (o) => RX_PRECIO_UNA.test(o), fraseNeutra)
    flags.push('precio_neutralizado_oracion_completa')
  }

  return { mensaje, flags, preciosMalos }
}

// ════════════════════════════════════════════════════════
// HELPER — cadenaDeBanco (overrides del banco de pruebas → cadena)
// Traduce las palancas históricas del banco (provider, model, useDevApi, location,
// thinkingLevel, thinkingBudget) a un paso de la cadena, para que /debug/brain-evals y
// brain-replay midan EXACTAMENTE el mismo camino de llamada que el bot vivo.
// ════════════════════════════════════════════════════════
function cadenaDeBanco(o) {
  // BRAIN_PROVIDER puede traer el modelo del primario no-Gemini ("mistral:ministral-14b-latest")
  const delEntorno = o.provider ? null : parsearPaso(process.env.BRAIN_PROVIDER || 'gemini')
  const pedido = o.useDevApi ? 'devapi' : String(o.provider || delEntorno?.provider || 'gemini').toLowerCase()
  const esGemini = ['gemini', 'vertex', 'devapi'].includes(pedido)
  const base = normalizarPaso({
    provider: pedido,
    model: o.model || (esGemini ? BRAIN_MODEL : (delEntorno?.model || null)),
    location: esGemini ? (o.location || BRAIN_LOCATION) : null,
    thinkingLevel: esGemini ? (o.thinkingLevel || BRAIN_THINKING_LEVEL) : null,
    thinkingBudget: o.thinkingBudget,
    rol: 'primario'
  })
  if (!base) return []
  if (o.fallback !== true) return [base]
  return [base, ...construirCadena().slice(1).filter(p => p.id !== base.id)]
}

// ════════════════════════════════════════════════════════
// HELPER — parsearJsonCerebro
// Acepta el JSON limpio o envuelto en basura/fences. Exige un "mensaje" de texto: un
// modelo de razonamiento sin presupuesto devolvió {"type":"object"} (jul 2026) y eso
// NO es una respuesta — cuenta como fallo y la cadena reintenta o pasa al seguro.
// ════════════════════════════════════════════════════════
export function parsearJsonCerebro(texto) {
  if (!texto || typeof texto !== 'string') return null
  const valido = (o) => (o && typeof o === 'object' && typeof o.mensaje === 'string' && o.mensaje.trim()) ? o : null
  const limpio = texto.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  try { return valido(JSON.parse(limpio)) } catch (_) { /* sigue */ }
  const m = texto.match(/\{[\s\S]*\}/)
  if (m) { try { return valido(JSON.parse(m[0])) } catch (_) { /* irrescatable */ } }
  return null
}

// ════════════════════════════════════════════════════════
// HELPER — rescatarMensaje (FIX #11)
// Último recurso cuando el JSON vino roto/cortado tras 3 intentos.
// Como en el schema el campo "mensaje" va PRIMERO, aunque el JSON se corte,
// el "mensaje" suele estar completo. Lo extraemos con regex tolerante para
// entregarle ALGO al lead en vez de un hueco mudo. Devuelve null si no hay nada usable.
// ════════════════════════════════════════════════════════
function rescatarMensaje(rawText) {
  if (!rawText || typeof rawText !== 'string') return null
  // Limpia fences de markdown por si acaso
  const limpio = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '')
  // Busca el valor del campo "mensaje": "....."
  // Captura hasta la comilla de cierre que NO esté escapada, o hasta el final si está cortado.
  const m = limpio.match(/"mensaje"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m && m[1]) {
    // Des-escapa secuencias JSON básicas
    const texto = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
    if (texto.length >= 3) return texto
  }
  // Si el mensaje quedó cortado SIN comilla de cierre (JSON truncado a la mitad del mensaje),
  // intentamos capturar desde "mensaje":" hasta donde llegue, limpiando cola rota.
  const abierto = limpio.match(/"mensaje"\s*:\s*"((?:[^"\\]|\\.)*)$/)
  if (abierto && abierto[1]) {
    let texto = abierto[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
    // Corta cualquier fragmento de clave JSON que se haya colado al final
    texto = texto.replace(/[",}\s]*"?(razonamiento|momento_actual|stage_sugerido|slots_detectados|debe_escalar_humano|razon_escalamiento|como_cerrarlo|temperatura_lead).*$/s, '').trim()
    if (texto.length >= 10) return texto  // umbral más alto para texto cortado (evita basura)
  }
  return null
}

// ════════════════════════════════════════════════════════
// HELPER — error
// ════════════════════════════════════════════════════════
function buildError(code, startTime, metadata = {}) {
  console.error(`[AgentBrain] FALLO: ${code}`, JSON.stringify(metadata).slice(0, 300))
  return {
    ok: false,
    error: code,
    error_metadata: metadata,
    mensaje: null,
    razonamiento: '',
    slots_detectados: {},
    stage_sugerido: null,
    debe_escalar_humano: false,
    temperatura_lead: 'warm',
    guardrail_flags: [],
    audit: { latency_ms: Date.now() - startTime }
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — resumen para logs
// ════════════════════════════════════════════════════════
export function summarizeBrainResult(r) {
  if (!r) return 'no result'
  if (!r.ok) return `❌ brain error: ${r.error}`
  const flags = r.guardrail_flags?.length ? ` ⚠️[${r.guardrail_flags.join(',')}]` : ''
  const escalar = r.debe_escalar_humano ? ' 🚨ESCALAR' : ''
  const momento = r.momento_actual ? ` ${r.momento_actual}` : ''
  const costo = r.audit?.cost_usd?.total_cost_usd
  const costoTxt = typeof costo === 'number' ? `$${costo.toFixed(6)}` : '$?'
  return `🧠 ${r.mensaje?.length || 0} chars |${momento} stage→${r.stage_sugerido} | ${r.temperatura_lead}${escalar}${flags} | ${costoTxt} | ${r.audit?.latency_ms}ms`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const AGENT_BRAIN_VERSION = 'v7_1_precio_corregido_prompt_fijo'
