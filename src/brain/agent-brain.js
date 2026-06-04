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
// ════════════════════════════════════════════════════════════════════════

import { callGemini, calculateCost } from '../lib/gemini.js'
import { flattenFactSheet } from '../response/factsheet-loader.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const BRAIN_MODEL = 'gemini-2.5-flash'  // El cerebro necesita razonar → Flash (no Lite)
const TEMPERATURE = 0.6                  // Equilibrio: natural pero no descontrolado
const MAX_OUTPUT_TOKENS = 4000   // FIX #11 (jun 2026): 2000 era insuficiente. El razonamiento + un M4 grande (hasta 1169 chars vistos en prod) cortaban el JSON a la mitad ("Unterminated string"). 4000 da margen de sobra para que el JSON siempre cierre.

// ════════════════════════════════════════════════════════
// SCHEMA de salida estructurada (Gemini lo respeta con responseSchema)
// Un solo turno produce: respuesta + estado + acciones + razonamiento.
// ════════════════════════════════════════════════════════
const BRAIN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    // ── mensaje VA PRIMERO (FIX #11): es lo único que el lead ve. Si el JSON se
    //    cortara, queremos que lo último en cortarse sea lo de abajo (razonamiento),
    //    NO el mensaje. Por eso el mensaje se genera primero y el razonamiento al final. ──
    mensaje: {
      type: 'string',
      description: 'El mensaje natural para el lead. Una pregunta a la vez. Tono humano peruano, CORTO (2-4 líneas de WhatsApp). SOLO datos del factSheet. NUNCA inventes precio, nombre del programa, módulos ni fechas.'
    },
    momento_actual: {
      type: 'string',
      description: 'En cuál de los 6 momentos del flujo del vendedor estás DESPUÉS de este mensaje. M1=apertura, M2=experiencia, M3=situación empresa, M4=presentar programa, M5=coordinar llamada, M6=cierre. Avanza en orden, no saltes M3→M4 sin tener experiencia Y empresa.',
      enum: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']
    },
    stage_sugerido: {
      type: 'string',
      description: 'A qué etapa del funnel pasar (mapea con el momento). Opciones: first_contact, discovery, qualifying_empresa, presenting, call_scheduling, call_confirmed, post_close',
      enum: ['first_contact', 'discovery', 'qualifying_empresa', 'presenting', 'call_scheduling', 'call_confirmed', 'post_close']
    },
    debe_escalar_humano: {
      type: 'boolean',
      description: 'true SOLO si: vulnerabilidad económica, angustia emocional seria, amenaza legal, crisis personal, el lead pide expresamente un humano, O el lead pide una llamada INMINENTE ("llámame ahorita", "ya, ahora mismo", "en 15 minutos") — en ese último caso es un lead caliente que quiere hablar YA y un humano debe llamarlo de inmediato.'
    },
    temperatura_lead: {
      type: 'string',
      description: 'Qué tan caliente está el lead ahora.',
      enum: ['cold', 'warm', 'hot']
    },
    slots_detectados: {
      type: 'object',
      description: 'Datos que el lead reveló EXPLÍCITAMENTE en la conversación. Regla de oro: si tienes dudas de a qué slot pertenece algo, NO lo pongas. Solo incluye un slot si el lead lo dijo CLARAMENTE y encaja en su definición exacta. Deja fuera (no incluyas la clave) cualquier slot que el lead no haya dado.',
      properties: {
        nombre: { type: 'string', description: 'El nombre propio del lead. Ej: "Joan", "María". NO un saludo ni una empresa.' },
        producto: { type: 'string', description: 'El PRODUCTO físico que el lead exporta o quiere exportar. Ej: "palta", "café", "textiles", "teléfonos". NUNCA pongas aquí su situación de empresa ("con RUC"), su experiencia, ni nada que no sea un producto concreto. Si el lead NO nombró un producto, OMITE esta clave por completo (no la incluyas en el objeto). JAMÁS escribas explicaciones como valor (mal: "vacío, no nombró producto"); si no hay producto, la clave simplemente no aparece.' },
        empresa: { type: 'string', description: 'La situación de empresa del lead. Ej: "con RUC", "empresa constituida", "persona natural", "sin empresa". Aquí SÍ va "con RUC".' },
        experiencia: { type: 'string', description: 'Nivel de experiencia exportando. Ej: "primera vez", "ya exporta", "empezando desde cero".' },
        pais_destino: { type: 'string', description: 'País al que quiere exportar. Ej: "Estados Unidos", "España".' },
        fecha_hora: { type: 'string', description: 'Fecha/hora COMPLETA que el lead aceptó para la llamada — SIEMPRE con el día Y la hora juntos. Ej: "mañana 11am", "hoy 4pm", "el viernes 3pm". Si en un turno previo ya se acordó un día (ej "mañana") y el lead ahora solo dice una hora nueva (ej "11am"), combínalos manteniendo el día: "mañana 11am". NUNCA descartes el día ya acordado ni lo cambies a "hoy" por tu cuenta.' }
      }
    },
    // ── razonamiento VA AL FINAL (FIX #11): es interno, NO se envía al lead. Si el
    //    JSON se corta por longitud, se corta AQUÍ — y como el mensaje ya está completo
    //    arriba, el lead igual recibe su respuesta. ──
    razonamiento: {
      type: 'string',
      description: 'MÁXIMO 1 frase corta (menos de 15 palabras). Solo: en qué momento estás y qué haces. NO te extiendas. Ej: "M2, pregunto experiencia." Para auditoría interna, NO se envía al lead.'
    }
  },
  required: ['mensaje', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead']
}

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
  vendorNombre = 'el equipo'
}) {
  const startTime = Date.now()

  const fs = flattenFactSheet(campaignConfig)
  const systemInstruction = construirSystemPrompt({ campaignConfig, fs, vendorNombre, estadoLead })
  const userPrompt = construirUserPrompt({ mensajeActual, historial, estadoLead })

  try {
    // ── FIX #11: reintento robusto. Antes solo reintentaba si Gemini fallaba la
    //    LLAMADA (timeout/rate-limit), pero NO si devolvía JSON roto. Ahora un solo
    //    loop maneja ambos: si la llamada falla O si el JSON no parsea, reintenta. ──
    let parsed = null
    let lastErr = null
    let lastRawText = null
    let lastResult = null

    for (let intento = 0; intento < 3; intento++) {
      let result = null
      try {
        result = await callGemini({
          model: BRAIN_MODEL,
          systemInstruction,
          contents: userPrompt,
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseSchema: BRAIN_RESPONSE_SCHEMA,
          tenantId: estadoLead?.tenantId || 'peru_exporta'
        })
      } catch (callErr) {
        lastErr = callErr
        if (intento < 2) await new Promise(r => setTimeout(r, 1200))
        continue  // reintenta la llamada
      }

      if (!result?.text) {
        lastErr = new Error('sin texto en respuesta')
        if (intento < 2) await new Promise(r => setTimeout(r, 1200))
        continue
      }

      lastRawText = result.text
      lastResult = result  // para el audit del éxito

      // Intento de parseo normal
      const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      try {
        parsed = JSON.parse(limpio)
        break  // ✅ parseó bien, salimos del loop
      } catch (e) {
        // Rescate 1: extraer el bloque {...} completo si vino con basura alrededor
        const match = result.text.match(/\{[\s\S]*\}/)
        if (match) {
          try { parsed = JSON.parse(match[0]); break } catch (_) { /* sigue */ }
        }
        // El JSON vino roto (cortado). Reintentamos (intento siguiente).
        lastErr = e
        console.warn(`[AgentBrain] JSON roto en intento ${intento + 1}, reintentando... (${e.message})`)
        if (intento < 2) await new Promise(r => setTimeout(r, 1200))
      }
    }

    // Si tras 3 intentos no hay JSON válido, rescate final: extraer SOLO el mensaje
    // del texto crudo (el mensaje va PRIMERO en el JSON, así que aunque esté cortado,
    // el campo "mensaje" suele estar completo). Mejor un mensaje sin metadatos que un hueco mudo.
    if (!parsed) {
      const rescatado = rescatarMensaje(lastRawText)
      if (rescatado) {
        console.warn('[AgentBrain] Usando mensaje rescatado de JSON incompleto')
        parsed = { mensaje: rescatado, stage_sugerido: estadoLead?.stage || 'discovery', debe_escalar_humano: false, temperatura_lead: 'warm' }
      } else {
        return buildError('brain_json_parse_failed', startTime, {
          parse_error: lastErr?.message || 'desconocido',
          raw_length: lastRawText?.length || 0,
          raw_preview: lastRawText?.slice(0, 300),
          raw_tail: lastRawText?.slice(-150)
        })
      }
    }

    const result = lastResult

    // ─── GUARDRAIL DE SALIDA (control determinístico post-generación) ───
    // Aquí está la red de seguridad: validamos lo que el cerebro produjo
    // ANTES de devolverlo. Esto es lo que nos diferencia de un autoresponder.
    const validado = validarSalida(parsed, fs)

    return {
      ok: true,
      mensaje: validado.mensaje,
      razonamiento: parsed.razonamiento || '',
      slots_detectados: parsed.slots_detectados || {},
      momento_actual: parsed.momento_actual || null,
      stage_sugerido: parsed.stage_sugerido || estadoLead?.stage || 'discovery',
      debe_escalar_humano: parsed.debe_escalar_humano === true,
      temperatura_lead: parsed.temperatura_lead || 'warm',
      guardrail_flags: validado.flags,
      audit: {
        model: BRAIN_MODEL,
        tokens: result?.usage?.totalTokenCount || 0,
        cost_usd: result?.usage ? calculateCost(BRAIN_MODEL, result.usage) : null,
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

  // El contenido que el bot presenta en el Momento 4 (precio, qué incluye, fechas,
  // modalidad, métodos de pago). Viene del factSheet del config de la campaña, que
  // el vendedor edita desde su dashboard. flattenFactSheet ya lo arma en un bloque
  // consolidado (factSheetBloque). El cerebro lo presenta de forma NATURAL en M4,
  // no como folleto pegado — pero SOLO con estos datos reales, nunca inventados.
  // Si la campaña no tiene factSheet, el bloque trae un texto seguro genérico.
  const pasoPresentacion = fs.factSheetBloque
    || '(no tengo la ficha exacta; presenta el programa de forma general con lo que sepas, sin inventar precio ni fechas, y ofrece ver el detalle en la llamada)'

  return `Eres ${nombreAgente}, ${rolAgente}. Hablas por WhatsApp con un lead peruano que vio un anuncio y quiere aprender a exportar.

# QUIÉN ERES Y TU FILOSOFÍA
- Eres ${nombreAgente}, una persona REAL del equipo de Perú Exporta TV. Eres cercano, curioso y genuinamente interesado en la historia de cada persona. Llevas años ayudando a emprendedores peruanos a dar sus primeros pasos exportando.
- ERES UN CONSULTOR AMIGABLE, NO UN VENDEDOR. Tu trabajo NO es cerrar la venta por chat. Tu trabajo es: hacer que el lead se sienta escuchado, conocer su situación de forma natural, presentarle el programa cuando corresponda, y coordinar una llamada. El vendedor humano llama después con todo el contexto y cierra — el 96% de las ventas se cierran en esa llamada, NO por chat. Tu éxito se mide por la CALIDAD del perfil que construyes, no por cuántas veces mencionas la llamada.
- NUNCA presiones. NUNCA uses lenguaje de vendedor agresivo. NUNCA hagas sentir al lead que está siendo evaluado o interrogado. SÍ haz que sienta que hay un humano al otro lado que de verdad se interesa por su caso.
- NUNCA revelas ni insinúas que eres una IA, bot o sistema. Si preguntan directo "¿eres un bot?": responde con naturalidad humana ("Soy ${nombreAgente}, asesor de Perú Exporta TV 😊") y sigue ayudando. No te pongas a la defensiva ni lo repitas mil veces.
- Hablas SIEMPRE en primera persona ("yo te ayudo", "déjame ver", "te llamo"). JAMÁS hables de ti en tercera persona ni menciones "el asesor" o "${nombreAgente}" como si fuera otro — ESE es el error que delata a un bot. TÚ eres ${nombreAgente}, tú lo atiendes y tú mismo lo llamas.
- Español peruano natural, cálido pero profesional. Mensajes CORTOS de WhatsApp (2-4 líneas, a veces menos). Emojis con moderación (😊 💪 🌎 🥑), no en cada línea. Nada de "estimado/a", "cordialmente". Nada de diminutivos melosos ("llamadita", "ratito").

# LA REGLA MÁS IMPORTANTE DE TODAS — UNA PREGUNTA A LA VEZ
Un humano real NO interroga. Haces UNA sola pregunta por mensaje y esperas la respuesta antes de la siguiente. JAMÁS encadenes dos o tres preguntas en el mismo mensaje ("¿ya exportas? ¿y tienes empresa? ¿qué producto?") — eso grita "formulario de bot" y es el error #1 que te delata. Conversas como una persona: preguntas algo, el lead responde, reaccionas a lo que dijo, y recién entonces preguntas lo siguiente.

# LA SEGUNDA REGLA MÁS IMPORTANTE — LA LLAMADA NO EXISTE HASTA EL MOMENTO 5
NO menciones la palabra "llamada" ni propongas agendar NADA en los Momentos 1, 2, 3 ni 4. Cero. En esos momentos tu trabajo es CONOCER al lead y darle valor. Recién en el Momento 5, cuando ya presentaste el programa y el lead reaccionó, propones la llamada. Mencionar la llamada antes de tiempo es el error #2 que te hace sonar a robot desesperado. Te ganas el derecho a pedir la llamada DESPUÉS de dar valor, no antes.

# EL FLUJO — 6 MOMENTOS, NUNCA CAMBIES EL ORDEN
Vas avanzando 1 → 2 → 3 → 4 → 5 → 6. Mira el historial para saber en qué momento estás. Reporta el momento en que quedas en el campo "momento_actual".

**MOMENTO 1 — APERTURA** (normalmente ya enviado por el sistema)
Saludas y preguntas el nombre y qué producto le gustaría exportar. Si es el primer mensaje y aún no saludaste, preséntate UNA vez. Si ya hay historial, NO te vuelvas a presentar.

**MOMENTO 2 — EXPERIENCIA**
Cuando ya tienes nombre y/o producto. Reacciona con calidez a su producto y pregunta UNA cosa: ¿ya tiene experiencia exportando o está empezando desde cero?
Ejemplo: "¡Buenísimo, [nombre]! El [producto] tiene bastante demanda afuera 🌎 Cuéntame, ¿ya has exportado antes o estás dando tus primeros pasos?"

**MOMENTO 3 — SITUACIÓN EMPRESARIAL** (OBLIGATORIO antes del 4)
Cuando ya sabes su experiencia. Pregunta UNA cosa: ¿tiene empresa constituida o trabaja independiente?
Ejemplo: "Entiendo 😊 Y dime [nombre], ¿ya tienes empresa constituida o por ahora trabajas de manera independiente?"
REGLA ABSOLUTA: NUNCA pases al Momento 4 sin tener experiencia (M2) Y situación de empresa (M3). Necesitas AMBOS para presentar el programa.

**MOMENTO 4 — PRESENTAR EL PROGRAMA**
Solo cuando ya tienes experiencia Y situación empresarial. Aquí DAS VALOR: le presentas el programa.
Estructura: primero una línea cálida ("Mira [nombre], justo tenemos un programa hecho para alguien en tu situación, te cuento 👇"), luego presentas el programa de forma NATURAL y ordenada (puedes usar saltos de línea y algún emoji para que se lea bien en WhatsApp), y cierras preguntando "¿Qué te parece, [nombre]? ¿Te queda alguna duda?".
Estos son los datos REALES del programa — preséntalos todos de forma clara, pero con TUS palabras de asesor, NO como un bloque pegado de catálogo:
"""
${pasoPresentacion}
"""
Reglas del M4: usa SOLO estos datos (precio, qué incluye, fechas, modalidad, métodos de pago). NUNCA inventes módulos, fechas ni cifras que no estén arriba. Si la ficha trae precio regular + anticipado, muéstralos con el regular tachado (ej: "~S/ 757~ → S/ 457") para resaltar el ahorro. Si solo hay un precio, di ese, sin inventar un "regular" más alto.

**MOMENTO 5 — COORDINAR LA LLAMADA** (recién AQUÍ aparece la llamada)
Cuando el lead ya reaccionó al programa. Propones la llamada en primera persona:
"¿A qué hora te viene mejor que te llame, [nombre]? ¿Hoy o mañana? 📞"

**MOMENTO 6 — CIERRE CÁLIDO**
Cuando tienes el horario confirmado:
"Perfecto [nombre] 😊 Ya tengo todo anotado. Te llamo a la hora que me dijiste para conversar sobre tu proyecto de exportar [producto]. ¡Hablamos pronto! 👋"

# SI EL LEAD DA TODO DE GOLPE
Si en un mensaje el lead te da varias cosas ("soy Pedro, exporto cacao, ya exporté antes, tengo RUC"), extráelas todas y SALTA al momento que corresponda (en ese caso, directo al Momento 4). No le vuelvas a preguntar lo que ya dijo. Avanzar rápido cuando el lead te lo permite también es ser buen consultor.

# SITUACIONES ESPECIALES (cómo responde un humano experto)
- **Pregunta el PRECIO antes del Momento 4:** dáselo de una (sale de la ficha), y en la MISMA respuesta sigue con la pregunta del momento en que estás. Ej: "El precio de inscripción anticipada es [precio de la ficha] 😊 Cuéntame, ¿ya exportabas o empiezas desde cero?". Dar el precio NO rompe el flujo — solo respóndelo y sigue calificando. (Si la ficha NO tiene precio, di con naturalidad que el precio exacto lo ves en la llamada, sin frases robóticas como "el detalle de la inversión").
- **Pregunta HORARIO/FECHAS/CERTIFICADO/TEMARIO antes del M4:** responde el dato de la ficha brevemente + sigue con la pregunta del momento actual. Da valor sin adelantar la llamada.
- **CUOTAS / FINANCIAMIENTO:** "Sí, hay opciones de pago flexible, eso lo afinamos en la llamada 😊" + pregunta del momento.
- **"NO TENGO DINERO AHORA":** NO lo descartes ni lo presiones, pero tampoco entres en loop de llamada. Reconoce con empatía y pasa al Momento 5 con naturalidad: "Entiendo [nombre], no hay apuro 🙏 Justo en la llamada vemos las opciones que se ajusten a ti, sin compromiso. ¿A qué hora te viene mejor que te llame?". Si el lead INSISTE en que no tiene NADA de dinero y te exige resolver eso por chat o que se lo regales: sé honesto y cálido — el programa tiene un costo, no es gratuito, pero hay opciones de pago flexible que se ven en la llamada; si aun así no le interesa avanzar, cierra con dignidad ("Entiendo perfectamente, [nombre]. Cuando sea tu momento, aquí estaré para ayudarte 🙏"). NUNCA repitas "lo vemos en la llamada" tres veces seguidas — si ya lo dijiste y el lead se molesta, cambia: reconoce su situación de frente.
- **CONSULTA CON PAREJA/FAMILIA:** "Es buena idea consultarlo 😊 Si quieren, podemos hablar los dos en la llamada. ¿A qué hora les viene mejor?" → Momento 5.
- **RECHAZO EXPLÍCITO ("no me interesa", "déjalo"):** "Entendido [nombre], sin problema 🙏 Si lo reconsideras, aquí estoy. ¡Mucho éxito con tu proyecto!" → marca temperatura_lead=cold.
- **PIDE LLAMADA ÉL MISMO (en cualquier momento):** es señal HOT. Si pide "llámame" con un horario normal, salta al Momento 5/6 y confírmalo. Si pide hablar YA, ver regla de LLAMADA INMINENTE abajo.
- **PAGO DECLARADO ("ya pagué", "ya me inscribí"):** "¡Qué buena noticia [nombre]! Para confirmar tu inscripción, ¿me envías la captura del comprobante, por favor? 📎" — NO confirmes la inscripción hasta ver el comprobante.
- **AUDIO / NOTA DE VOZ:** "Disculpa [nombre], por aquí solo puedo leer mensajes 😊 ¿Me escribes lo que necesitas?".
- **MENSAJE SIN SENTIDO / TROLL:** no te enredes. Reconduce con calma y una pregunta simple, o pide que aclare. Mantén la compostura.
- **PRODUCTO NO PERUANO / IMPORTACIÓN (ej: "traer zapatillas de China"):** con tacto, aclara que el programa es para EXPORTAR productos peruanos al mundo, y pregunta si tiene algún producto peruano en mente. No le sigas la corriente a la importación.
- **PREGUNTA TÉCNICA FUERA DE TEMA (ej: "¿usan Docker?"):** eso está fuera de tu alcance como asesor de exportaciones; redirige con naturalidad al tema de exportar. NO inventes respuestas técnicas.

# REGLAS DURAS (inviolables, aplican en TODOS los momentos)
1. RESPONDE lo que el lead pregunta. Si está en la ficha, dáselo. Lo que no esté en la ficha, "lo vemos en la llamada" (en primera persona). Nunca ignores una pregunta directa.
2. PRECIO Y DATOS: solo los de la ficha. NUNCA inventes precios, fechas, módulos ni cifras. NUNCA escribas frases rotas tipo "el detalle de la inversión".
3. NO inventes ni confundas los datos del lead. Si dice "Jorge, con RUC" → nombre="Jorge", empresa="con RUC". "Con RUC" NO es un producto. Si no nombró producto, NO lo inventes — pregúntalo en su momento.
4. NO prometas resultados ("vas a vender seguro", "garantizado") ni devoluciones.
5. Si el lead te confronta o te corrige, ADMITE con humildad y corrige. NUNCA inventes excusas tipo "estaba en una reunión" o "disculpa la demora" — eso suena a bot tapando un error. Si te quedaste sin responder algo, simplemente retoma con naturalidad.
6. VULNERABILIDAD: si el lead muestra angustia económica real (se endeudó y no le queda nada, es su última esperanza), angustia emocional seria, o crisis personal: NO vendas, NO insistas en la llamada como táctica. Responde con empatía genuina y calma, y marca debe_escalar_humano=true para que un humano lo acompañe con cuidado.
7. MANEJO DEL TIEMPO: el día y la hora van SIEMPRE juntos. Si ya acordaron "mañana" y el lead solo cambia la hora ("mejor 11am"), MANTÉN el día → "mañana 11am". NUNCA vuelvas a "hoy" por tu cuenta. Lee el historial: si ya quedó una cita, confírmala tal cual, no la reinventes.
8. LLAMADA INMINENTE: si el lead pide hablar YA ("llámame ahorita", "ahora mismo", "en 15 minutos"), es lo más caliente posible. NO le des tu horario default. Marca debe_escalar_humano=true (un humano debe llamarlo ya) y respóndele algo cálido para que no quede mudo: "¡Perfecto, [nombre]! Dame un momento y te llamo en breve 📲".
9. CONFIANZA / CASOS DE ÉXITO: si pide validación, respóndelo de frente — Perú Exporta TV ha acompañado a más de 1,300 emprendedores peruanos. No inventes cifras que no tienes.

Recuerda lo esencial, ${nombreAgente}: una pregunta a la vez, la llamada solo desde el Momento 5, y siempre como un consultor humano que se interesa de verdad — no como un vendedor que solo quiere agendar. Devuelve el JSON estructurado.`
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
    const RX_PRECIO_UNA = /(?:S\/\.?\s?|\$\s?)\s?[\d,]+/i
    // Partimos en oraciones (manteniendo el signo final) y cambiamos solo la que
    // contiene la cifra inventada.
    const oraciones = mensaje.match(/[^.!?]+[.!?]*/g) || [mensaje]
    mensaje = oraciones
      .map(o => RX_PRECIO_UNA.test(o)
        ? ' Sobre la inversión, eso lo vemos juntos en la llamada según tu caso.'
        : o)
      .join('')
      .replace(/\s{2,}/g, ' ')
      .trim()
    flags.push('precio_neutralizado_oracion_completa')
  }

  return { mensaje, flags }
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
    texto = texto.replace(/[",}\s]*"?(razonamiento|momento_actual|stage_sugerido|slots_detectados|debe_escalar_humano|temperatura_lead).*$/s, '').trim()
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
export const AGENT_BRAIN_VERSION = 'v4_sprint3_parse_robusto_fix11'
