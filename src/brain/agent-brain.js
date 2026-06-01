// src/brain/agent-brain.js — Hidata v20 · Sprint 3 (Cerebro unificado)
//
// ════════════════════════════════════════════════════════════════════════
// EL CEREBRO — un solo agente que RAZONA, no un pipeline que clasifica.
//
// QUÉ REEMPLAZA (cuando se cablee): la cadena rígida
//   Perception(encajona en intents) → FSM/Policy(elige UNA acción) → Response(rellena plantilla)
// que hacía al bot sonar a autoresponder: ignoraba múltiples preguntas,
// alucinaba slots ("palta"), y solo podía hacer una cosa por turno.
//
// QUÉ HACE EN SU LUGAR (fundado en literatura 2025-2026):
//   - RAISE (arXiv 2401.02777, probado en ventas inmobiliarias): scratchpad
//     de razonamiento + memoria + ejemplos sobre ReAct.
//   - StateAct (arXiv 2410.02810): el LLM mantiene el ESTADO él mismo vía
//     self-prompting, en vez de una FSM rígida diseñada a mano.
//   - SalesLLM (arXiv 2604.07054): el reto medible es la "role inversion"
//     (el bot se confunde de quién es quién) — la combatimos con reglas duras.
//
// PRINCIPIO DE DISEÑO (lo que nos diferencia de Kommo/autoresponders):
//   Libertad EN LA GENERACIÓN + control EN LA VALIDACIÓN.
//   El cerebro responde LIBRE como un humano (atiende N preguntas, con persona).
//   Los guardrails determinísticos validan la SALIDA (que no invente precio,
//   que no prometa, que no confirme pago sin evidencia) ANTES de enviar.
//   El FSM deja de ser una jaula y pasa a ser una BRÚJULA (le dice al cerebro
//   en qué etapa está y cuál es su meta, pero NO le dicta la frase).
//
// SALIDA ESTRUCTURADA EN UN SOLO TURNO (esto mata "una acción por turno"):
//   { mensaje, estado_actualizado, acciones, razonamiento }
//   → la respuesta natural + qué slots se llenaron + a qué stage pasar +
//     si hay que escalar a humano, TODO de una vez.
//
// AISLADO: este módulo NO se llama desde el pipeline todavía. Se prueba en
// paralelo (endpoint /brain/test) contra conversaciones reales antes de
// reemplazar la cadena vieja. Cero regresión hasta que decidamos cablearlo.
// ════════════════════════════════════════════════════════════════════════

import { callGemini, calculateCost } from '../lib/gemini.js'
import { flattenFactSheet } from '../response/factsheet-loader.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const BRAIN_MODEL = 'gemini-2.5-flash'   // El cerebro necesita razonar → Flash (no Lite)
const TEMPERATURE = 0.6                    // Equilibrio: natural pero no descontrolado
const MAX_OUTPUT_TOKENS = 2000

// ════════════════════════════════════════════════════════
// SCHEMA de salida estructurada (Gemini lo respeta con responseSchema)
// Un solo turno produce: respuesta + estado + acciones + razonamiento.
// ════════════════════════════════════════════════════════
const BRAIN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    razonamiento: {
      type: 'string',
      description: 'Scratchpad breve: qué pidió el lead (TODAS sus preguntas), en qué etapa está, qué conviene hacer. Para auditoría, NO se envía al lead.'
    },
    mensaje: {
      type: 'string',
      description: 'El mensaje natural para el lead. Atiende TODAS sus preguntas. Tono humano peruano. SOLO datos del factSheet.'
    },
    slots_detectados: {
      type: 'object',
      description: 'Datos que el lead reveló EXPLÍCITAMENTE en la conversación. Regla de oro: si tienes dudas de a qué slot pertenece algo, NO lo pongas. Solo incluye un slot si el lead lo dijo CLARAMENTE y encaja en su definición exacta. Deja fuera (no incluyas la clave) cualquier slot que el lead no haya dado.',
      properties: {
        nombre: { type: 'string', description: 'El nombre propio del lead. Ej: "Joan", "María". NO un saludo ni una empresa.' },
        producto: { type: 'string', description: 'El PRODUCTO físico que el lead exporta o quiere exportar. Ej: "palta", "café", "textiles", "teléfonos". NUNCA pongas aquí su situación de empresa ("con RUC"), su experiencia, ni nada que no sea un producto concreto. Si el lead no nombró un producto, DEJA ESTE SLOT FUERA.' },
        empresa: { type: 'string', description: 'La situación de empresa del lead. Ej: "con RUC", "empresa constituida", "persona natural", "sin empresa". Aquí SÍ va "con RUC".' },
        experiencia: { type: 'string', description: 'Nivel de experiencia exportando. Ej: "primera vez", "ya exporta", "empezando desde cero".' },
        pais_destino: { type: 'string', description: 'País al que quiere exportar. Ej: "Estados Unidos", "España".' },
        fecha_hora: { type: 'string', description: 'Fecha/hora que el lead aceptó para la llamada. Ej: "mañana 11am".' }
      }
    },
    stage_sugerido: {
      type: 'string',
      description: 'A qué etapa del funnel pasar. Opciones: first_contact, discovery, qualifying_empresa, presenting, call_scheduling, call_confirmed, post_close',
      enum: ['first_contact', 'discovery', 'qualifying_empresa', 'presenting', 'call_scheduling', 'call_confirmed', 'post_close']
    },
    debe_escalar_humano: {
      type: 'boolean',
      description: 'true SOLO si: vulnerabilidad económica, angustia emocional seria, amenaza legal, crisis personal, o el lead pide expresamente un humano.'
    },
    temperatura_lead: {
      type: 'string',
      description: 'Qué tan caliente está el lead ahora.',
      enum: ['cold', 'warm', 'hot']
    }
  },
  required: ['razonamiento', 'mensaje', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead']
}

// ════════════════════════════════════════════════════════
// API PÚBLICA — pensarYResponder()
// ════════════════════════════════════════════════════════

/**
 * El cerebro lee TODA la conversación + contexto y produce respuesta + estado.
 *
 * @param {object}  args
 * @param {string}  args.mensajeActual    - último mensaje del lead (o varios combinados)
 * @param {Array}   args.historial        - [{ rol: 'lead'|'agente', texto }]  conversación completa
 * @param {object}  args.estadoLead       - { stage, slots, mode, nombre }
 * @param {object}  args.campaignConfig   - el config de la campaña (factSheet, agente, comportamiento)
 * @param {string?} args.vendorNombre
 * @returns {Promise<object>} { ok, mensaje, slots_detectados, stage_sugerido, debe_escalar_humano, ... }
 */
export async function pensarYResponder({
  mensajeActual,
  historial = [],
  estadoLead = {},
  campaignConfig = null,
  vendorNombre = 'el equipo'
}) {
  const startTime = Date.now()

  const fs = flattenFactSheet(campaignConfig)
  const systemInstruction = construirSystemPrompt({ campaignConfig, fs, vendorNombre, estadoLead })
  const userPrompt = construirUserPrompt({ mensajeActual, historial, estadoLead })

  try {
    const result = await callGemini({
      model: BRAIN_MODEL,
      systemInstruction,
      contents: userPrompt,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseSchema: BRAIN_RESPONSE_SCHEMA,
      tenantId: estadoLead?.tenantId || 'peru_exporta'
    })

    if (!result?.text) {
      return buildError('empty_brain_response', startTime)
    }

    let parsed
    try {
      // Gemini a veces envuelve el JSON en ```json ... ``` — lo limpiamos
      const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim()
      parsed = JSON.parse(limpio)
    } catch (e) {
      return buildError('brain_json_parse_failed', startTime, {
        parse_error: e.message,
        raw_length: result.text?.length || 0,
        raw_preview: result.text?.slice(0, 300),
        raw_tail: result.text?.slice(-150),
        finish_reason: result.response?.candidates?.[0]?.finishReason || 'unknown'
      })
    }

    // ─── GUARDRAIL DE SALIDA (control determinístico post-generación) ───
    // Aquí está la red de seguridad: validamos lo que el cerebro produjo
    // ANTES de devolverlo. Esto es lo que nos diferencia de un autoresponder.
    const validado = validarSalida(parsed, fs)

    return {
      ok: true,
      mensaje: validado.mensaje,
      razonamiento: parsed.razonamiento || '',
      slots_detectados: parsed.slots_detectados || {},
      stage_sugerido: parsed.stage_sugerido || estadoLead?.stage || 'discovery',
      debe_escalar_humano: parsed.debe_escalar_humano === true,
      temperatura_lead: parsed.temperatura_lead || 'warm',
      guardrail_flags: validado.flags,
      audit: {
        model: BRAIN_MODEL,
        tokens: result.usage?.totalTokenCount || 0,
        cost_usd: result.usage ? calculateCost(BRAIN_MODEL, result.usage) : null,
        latency_ms: Date.now() - startTime
      }
    }

  } catch (err) {
    console.error('[AgentBrain] Error:', err.message)
    return buildError('brain_exception', startTime, { message: err.message })
  }
}

// ════════════════════════════════════════════════════════
// SYSTEM PROMPT — la identidad y reglas del cerebro
// Aquí vive el prompt engineering 100x. Persona + contexto + reglas duras.
// ════════════════════════════════════════════════════════

function construirSystemPrompt({ campaignConfig, fs, vendorNombre, estadoLead }) {
  const agente = campaignConfig?.agente || {}
  const comportamiento = campaignConfig?.comportamiento || {}
  const nombreAgente = agente.nombre || 'Daniel'
  const rolAgente = agente.rol || 'Asesor de Perú Exporta TV'
  const agentGoal = comportamiento.agentGoal || 'AGENDAR_LLAMADA'

  // La meta en lenguaje natural (la BRÚJULA, no la jaula)
  // CLAVE: el agente ES el vendedor. Habla en primera persona, nunca deriva a "otro asesor".
  const metaTexto = agentGoal === 'CERRAR_VENTA'
    ? 'Tu meta es cerrar la venta TÚ MISMO por chat cuando el lead esté listo (tomar sus datos, pasarle el medio de pago, confirmar).'
    : 'Tu meta es coordinar una LLAMADA con el lead para verlo con calma y ayudarlo a dar el paso. Tú mismo haces esa llamada (eres su asesor de principio a fin). Propones la llamada en primera persona: "coordinamos una llamada", "te llamo y lo vemos juntos" — NUNCA "te llama otro asesor".'

  return `Eres ${nombreAgente}, ${rolAgente}. Hablas por WhatsApp con un lead peruano interesado en exportar.

# QUIÉN ERES
- Eres ${nombreAgente}, una persona REAL del equipo de Perú Exporta TV. Para el lead, eres su asesor de principio a fin: tú lo atiendes, tú lo asesoras, y tú mismo lo llamas o cierras con él. NO hay "otro asesor" detrás de ti — TÚ eres esa persona.
- NUNCA revelas ni insinúas que eres una IA, un bot o un "asistente virtual". Eres ${nombreAgente}. Si te preguntan "¿eres un bot?", respondes con naturalidad humana (eres ${nombreAgente} del equipo) y rediriges a ayudar, sin mentir agresivamente pero sin declararte máquina.
- Hablas SIEMPRE en primera persona ("yo te ayudo", "déjame ver", "coordinamos", "te llamo"). JAMÁS hables de ti mismo en tercera persona ni te refieras a "el asesor" o "${nombreAgente}" como si fuera otra persona — ESE es el error que delata a un bot. Tú eres ${nombreAgente}.
- Hablas español peruano natural, cálido pero PROFESIONAL. Cercano sin ser confianzudo. Mensajes cortos de WhatsApp (2-5 líneas). Emojis con moderación (💪 🤝 🌎 🥑), no en cada línea.
- EVITA diminutivos acaramelados que restan seriedad a un programa de ticket alto: nada de "llamadita", "espacito", "cosita", "ratito", "minutitos". Di "una llamada", "una llamada corta", "unos minutos", "15 minutos". Eres un asesor profesional que trata al lead como un adulto que va a invertir en serio, no un vendedor meloso.
- NUNCA usas "estimado/a", "cordialmente", "atentamente" — eso es el otro extremo, suena acartonado y gringo. El punto medio: profesional y humano a la vez.

# TU META (esto te GUÍA, no te encadena)
${metaTexto}
Estás trabajando hacia esa meta, pero PRIMERO eres útil y honesto. No fuerces el cierre si el lead todavía tiene dudas reales sin resolver.

# FICHA COMERCIAL — TU ÚNICA FUENTE DE VERDAD
Programa: ${fs.nombreProducto}
${fs.factSheetBloque}
${fs.noIncluyeTexto ? `\nLo que NO incluye (sé honesto si preguntan): ${fs.noIncluyeTexto}` : ''}

# REGLAS DURAS (inviolables)
1. RESPONDE TODAS LAS PREGUNTAS DEL LEAD. Si el lead hace 3 preguntas en un mensaje, respondes las 3, no una. Esto es lo más importante: un humano no ignora preguntas.
   → Para CADA pregunta: si el dato ESTÁ en la ficha comercial de arriba, RESPÓNDELO con ese dato. Solo si el dato NO está en la ficha, dices que lo ves con calma en la llamada (en primera persona: "eso lo afinamos en la llamada", NUNCA "el asesor lo confirma"). Ejemplo: si preguntan "¿cuándo empiezan las clases?" y la ficha tiene "Fecha de inicio", DA esa fecha.
2. PRECIO: usa ÚNICAMENTE el precio de la ficha comercial de arriba. Si la ficha no trae precio, di que lo ves con el lead en la llamada (en primera persona). NUNCA inventes precios, descuentos ni promociones.
3. NUNCA inventes ni confundas datos del lead. Mira SOLO lo que el lead dijo explícitamente. Dos errores graves a evitar:
   (a) Afirmar "veo que tu producto es X" cuando el lead nunca lo dijo. Si no dijo producto, pregúntalo.
   (b) Meter un dato en el slot equivocado. Ejemplo real: si el lead dice "Joan, con RUC", entonces nombre="Joan" y empresa="con RUC" — "con RUC" NO es el producto. Si el lead no nombró ningún producto concreto (palta, café, etc.), el slot producto queda VACÍO. No rellenes producto con su situación de empresa ni con nada que no sea un producto físico.
4. NO prometas resultados ("vas a vender seguro", "garantizado") ni devoluciones. El programa da herramientas, no garantías de venta.
5. Si el lead te corrige o te confronta ("¿de dónde sacas eso?"), ADMITE el error con humildad y corrige de inmediato. NUNCA inventes excusas ni sigas de largo ignorando su reclamo. La confianza es todo en ventas de ticket alto.
6. NO confirmes que recibiste un pago a menos que el lead muestre evidencia clara (comprobante, monto). Si dice "ya pagué" sin prueba, pide amablemente el comprobante.
7. Cuando propongas la llamada, hazlo en PRIMERA PERSONA, como la persona que la hará: "te llamo", "coordinamos una llamada", "lo vemos juntos en una llamadita". NUNCA digas "te llama un asesor", "te llama ${vendorNombre}" ni te refieras a un tercero — TÚ haces la llamada, tú eres su asesor.
8. Si detectas vulnerabilidad económica (se endeudó, no le queda nada), angustia seria, amenaza legal o crisis personal: NO insistas en vender. Marca debe_escalar_humano=true y responde con calma y empatía, ofreciendo verlo con calma sin presión.

# CÓMO RESPONDER
- Lee TODA la conversación para entender el hilo. El lead recuerda lo que dijo antes; tú también.
- Conecta el programa con el producto y la situación REAL del lead (lo que él dijo).
- Si ya tienes lo que necesitas para tu meta, avanza hacia ella con naturalidad (propón la llamada con 2-3 horarios concretos).
- Sé conversacional, no un folleto. Responde como ${nombreAgente}, una persona, no como un catálogo.`
}

// ════════════════════════════════════════════════════════
// USER PROMPT — la conversación + el estado actual
// ════════════════════════════════════════════════════════

function construirUserPrompt({ mensajeActual, historial, estadoLead }) {
  const slots = estadoLead?.slots || {}
  const slotsConocidos = Object.entries(slots)
    .filter(([_, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ') || '(ninguno todavía)'

  // Historial en formato legible (la MEMORIA de la conversación)
  const historialTexto = historial.length
    ? historial.map(h => `${h.rol === 'lead' ? 'LEAD' : nombreCorto(estadoLead)}: ${h.texto}`).join('\n')
    : '(esta es la primera interacción)'

  return `# CONVERSACIÓN HASTA AHORA
${historialTexto}

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

/**
 * Valida el mensaje del cerebro contra el factSheet.
 * Si detecta un precio que NO está en la ficha, lo marca (y en modo estricto, reescribe).
 *
 * @returns {{ mensaje: string, flags: string[] }}
 */
function validarSalida(parsed, fs) {
  const flags = []
  let mensaje = parsed.mensaje || ''

  // ── Guardrail 1: precio fantasma ──
  // Busca cifras tipo S/XXXX o $XXX en el mensaje y verifica contra el factSheet.
  const preciosEnMensaje = mensaje.match(/(?:S\/\.?\s?|\$\s?)\s?[\d,]+/gi) || []
  if (preciosEnMensaje.length > 0) {
    if (!fs.precioTexto) {
      // CASO MÁS PELIGROSO: la campaña no tiene precio en su factSheet, pero el
      // cerebro escribió una cifra → es inventada sí o sí. Marcar TODAS.
      for (const p of preciosEnMensaje) {
        flags.push(`precio_inventado_sin_factsheet:${p.trim()}`)
      }
    } else {
      // Hay precio real: cualquier cifra que no coincida con el real es sospechosa.
      const montoReal = fs.precioMonto ? String(fs.precioMonto) : null
      const textoRealDigitos = fs.precioTexto.replace(/\D/g, '')
      for (const p of preciosEnMensaje) {
        const soloDigitos = p.replace(/\D/g, '')
        if (soloDigitos && soloDigitos !== montoReal && !textoRealDigitos.includes(soloDigitos)) {
          flags.push(`precio_no_coincide_factsheet:${p.trim()}_vs_${fs.precioTexto}`)
        }
      }
    }
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

  // NOTA: en esta versión los flags se REPORTAN (para medir cuánto se equivoca el
  // cerebro en producción real). La REESCRITURA automática (re-pedirle al LLM que
  // corrija) es el siguiente incremento, cuando tengamos datos de cuán frecuente es.
  // Por ahora: si hay flag de precio inventado y NO hay factSheet, neutralizamos
  // el precio para no decir una cifra falsa al lead.
  if (flags.some(f => f.startsWith('precio_inventado_sin_factsheet'))) {
    mensaje = mensaje.replace(/(?:S\/\.?\s?|\$\s?)\s?[\d,]+/gi, 'el detalle de la inversión (lo vemos juntos en la llamada)')
  }

  return { mensaje, flags }
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
  const costo = r.audit?.cost_usd?.total_cost_usd
  const costoTxt = typeof costo === 'number' ? `$${costo.toFixed(6)}` : '$?'
  return `🧠 ${r.mensaje?.length || 0} chars | stage→${r.stage_sugerido} | ${r.temperatura_lead}${escalar}${flags} | ${costoTxt} | ${r.audit?.latency_ms}ms`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const AGENT_BRAIN_VERSION = 'v1_sprint3_unified_reasoning'
