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
  const userPrompt = construirUserPrompt({ mensajeActual, historial, estadoLead })

  try {
    // Reintentos, clasificación de errores, circuit breaker y fallback: todo en la
    // cadena. Un JSON roto o sin "mensaje" cuenta como fallo y se reintenta.
    const ejec = await ejecutarCadena({
      cadena,
      llamar: (paso) => llamarPaso(paso, {
        systemInstruction, userPrompt, schema: usarSchema, temperature: TEMPERATURE,
        tenantId: estadoLead?.tenantId || ACTIVE_TENANT
      }),
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

    const result = ejec.result

    // ─── GUARDRAIL DE SALIDA (control determinístico post-generación) ───
    // Aquí está la red de seguridad: validamos lo que el cerebro produjo
    // ANTES de devolverlo. Esto es lo que nos diferencia de un autoresponder.
    const yaSaludo = Array.isArray(historial) && historial.some(m => m?.rol === 'agente')
    const validado = validarSalida(parsed, fs, estadoLead?.slots?.nombre, yaSaludo, vertical)

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
        tokens: result?.usage?.totalTokenCount || 0,
        cost_usd: result?.usage ? calculateCost(modeloFinal, result.usage) : null,
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
// USER PROMPT — la conversación + el estado actual
// ════════════════════════════════════════════════════════
function construirUserPrompt({ mensajeActual, historial, estadoLead }) {
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
    .replace(/^[¡\s]+/, '')
    .trim()
  if (m.length < 8 || m === mensaje.trim()) return { mensaje, limpiado: false }       // era casi solo saludo → no tocar
  m = m.charAt(0).toUpperCase() + m.slice(1)                                          // capitaliza lo que quedó
  return { mensaje: m, limpiado: true }
}

/**
 * Valida el mensaje del cerebro contra el factSheet.
 * Si detecta un precio que NO está en la ficha, lo marca (y en modo estricto, reescribe).
 * El vertical puede aportar validaciones EXTRA de su negocio (ej. colágeno:
 * guardrail anti-"curar" DIGEMID) vía vertical.validarMensajeExtra.
 *
 * @returns {{ mensaje: string, flags: string[] }}
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
  // Busca cifras de dinero en el mensaje y las verifica contra el factSheet.
  //
  // AMPLIADO (auditoría pre-producción jul 2026): antes solo se detectaba el SÍMBOLO
  // delante ("S/ 1500", "$300"). Pero el modelo escribe dinero de varias formas, y en
  // cuanto el bot de un cliente nuevo dijera "cuesta 2500 soles" —sin símbolo— el
  // guardrail no veía NADA y una cifra inventada llegaba al lead sin marcar. Ahora
  // se cubren las tres formas reales:
  //   · símbolo delante: "S/ 1,500", "$300"
  //   · moneda detrás:   "1500 soles", "300 dólares", "2500 PEN"
  //   · símbolo pegado:  "S/1500"
  // Deliberadamente NO se marcan números sueltos ("12 sesiones", "1,300 alumnos"):
  // eso llenaría de falsos positivos y, sin factSheet, NEUTRALIZARÍA mensajes sanos.
  // Solo cuenta como dinero lo que trae símbolo o palabra de moneda pegada.
  const RX_DINERO = /(?:S\/\.?\s?\d[\d,\.]*)|(?:\$\s?\d[\d,\.]*)|(?:\d[\d,\.]*\s?(?:soles|sol|dólares|dolares|usd|pen|euros?|eur)\b)/gi
  const preciosEnMensaje = mensaje.match(RX_DINERO) || []
  if (preciosEnMensaje.length > 0) {
    if (!fs.precioTexto) {
      // CASO MÁS PELIGROSO: la campaña no tiene precio en su factSheet, pero el
      // cerebro escribió una cifra → es inventada sí o sí. Marcar TODAS.
      for (const p of preciosEnMensaje) {
        flags.push(`precio_inventado_sin_factsheet:${p.trim()}`)
      }
    } else {
      // Hay precio real: cualquier cifra que no coincida con el real es sospechosa.
      // Validamos contra el precio regular Y la OFERTA DE HOY (descuento oficial de la
      // ficha) — si no, los precios de la promo se marcarían como fantasma (jul 2026).
      const montoReal = fs.precioMonto ? String(fs.precioMonto) : null
      const textoRealDigitos = (fs.precioTexto + ' ' + (fs.ofertaHoyTexto || '')).replace(/\D/g, '')
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
  //
  // FIX #1 (jun 2026): antes el reemplazo era "el detalle de la inversión (lo vemos
  // juntos en la llamada)" insertado donde estaba la cifra — eso producía
  // frankenstein gramatical visible al lead (caso real JH: "tiene una inversión de
  // el detalle de la inversión..."). Reemplazar el FRAGMENTO siempre rompe la
  // gramática porque no sabemos qué palabras lo rodean.
  //
  // SOLUCIÓN: neutralizar la ORACIÓN COMPLETA que contiene el precio fantasma,
  // sustituyéndola por una frase humana cerrada. Esto preserva el resto del mensaje
  // (saludo, cierre, otras respuestas) y nunca deja preposiciones/artículos sueltos.
  // Verificado contra el caso real "S/2500" + 6 variantes → todas fluyen limpio.
  if (flags.some(f => f.startsWith('precio_inventado_sin_factsheet'))) {
    // FIX sep 2026: antes se neutralizaba con un regex SOLO de símbolo ("S/ 1500"),
    // distinto del detector. "cuesta 2500 soles" se DETECTABA y se marcaba como
    // neutralizado… pero llegaba intacto al lead. Detector y neutralizador usan ahora
    // la MISMA definición de dinero (RX_DINERO), sin flag global (test() sin estado).
    const RX_PRECIO_UNA = new RegExp(RX_DINERO.source, 'i')
    // La frase de reemplazo es del VERTICAL: "lo vemos en la llamada" solo tiene
    // sentido en exportación (colágeno cierra por chat, no por llamada).
    const fraseNeutra = vertical?.FRASE_PRECIO_SIN_FICHA
      || ' El precio exacto te lo confirmo en un momento 😊'
    // Partimos en oraciones (manteniendo el signo final) y cambiamos solo la que
    // contiene la cifra inventada.
    const oraciones = mensaje.match(/[^.!?]+[.!?]*/g) || [mensaje]
    mensaje = oraciones
      .map(o => RX_PRECIO_UNA.test(o) ? fraseNeutra : o)
      .join('')
      .replace(/\s{2,}/g, ' ')
      .trim()
    flags.push('precio_neutralizado_oracion_completa')
  }

  return { mensaje, flags }
}

// ════════════════════════════════════════════════════════
// HELPER — cadenaDeBanco (overrides del banco de pruebas → cadena)
// Traduce las palancas históricas del banco (provider, model, useDevApi, location,
// thinkingLevel, thinkingBudget) a un paso de la cadena, para que /debug/brain-evals y
// brain-replay midan EXACTAMENTE el mismo camino de llamada que el bot vivo.
// ════════════════════════════════════════════════════════
function cadenaDeBanco(o) {
  // BRAIN_PROVIDER puede traer el modelo del primario no-Gemini ("mistral:mistral-small-latest")
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
export const AGENT_BRAIN_VERSION = 'v7_0_verticales_exportacion_colageno'
