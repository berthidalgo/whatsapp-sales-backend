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
        producto: { type: 'string', description: 'El PRODUCTO físico que el lead exporta o quiere exportar. Ej: "palta", "café", "textiles", "teléfonos". NUNCA pongas aquí su situación de empresa ("con RUC"), su experiencia, ni nada que no sea un producto concreto. Si el lead NO nombró un producto, OMITE esta clave por completo (no la incluyas en el objeto). JAMÁS escribas explicaciones como valor (mal: "vacío, no nombró producto"); si no hay producto, la clave simplemente no aparece.' },
        empresa: { type: 'string', description: 'La situación de empresa del lead. Ej: "con RUC", "empresa constituida", "persona natural", "sin empresa". Aquí SÍ va "con RUC".' },
        experiencia: { type: 'string', description: 'Nivel de experiencia exportando. Ej: "primera vez", "ya exporta", "empezando desde cero".' },
        pais_destino: { type: 'string', description: 'País al que quiere exportar. Ej: "Estados Unidos", "España".' },
        fecha_hora: { type: 'string', description: 'Fecha/hora COMPLETA que el lead aceptó para la llamada — SIEMPRE con el día Y la hora juntos. Ej: "mañana 11am", "hoy 4pm", "el viernes 3pm". Si en un turno previo ya se acordó un día (ej "mañana") y el lead ahora solo dice una hora nueva (ej "11am"), combínalos manteniendo el día: "mañana 11am". NUNCA descartes el día ya acordado ni lo cambies a "hoy" por tu cuenta.' }
      }
    },
    stage_sugerido: {
      type: 'string',
      description: 'A qué etapa del funnel pasar. Opciones: first_contact, discovery, qualifying_empresa, presenting, call_scheduling, call_confirmed, post_close',
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
    // Reintento automático: si Gemini falla por error transitorio (timeout, rate
    // limit), reintentamos 1 vez tras una pausa. Esto evita crashes como C035.
    let result = null
    let lastErr = null
    for (let intento = 0; intento < 2; intento++) {
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
        if (result?.text) break  // éxito
      } catch (callErr) {
        lastErr = callErr
        if (intento === 0) await new Promise(r => setTimeout(r, 1500))  // pausa antes de reintentar
      }
    }

    if (!result?.text) {
      return buildError('empty_brain_response', startTime, { last_error: lastErr?.message || 'sin texto tras reintento' })
    }

    let parsed
    try {
      // Gemini a veces envuelve el JSON en ```json ... ``` — lo limpiamos
      const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      parsed = JSON.parse(limpio)
    } catch (e) {
      // Rescate: intentar extraer el bloque {...} si vino con basura alrededor
      const match = result.text.match(/\{[\s\S]*\}/)
      if (match) {
        try { parsed = JSON.parse(match[0]) } catch (_) { /* cae al error */ }
      }
      if (!parsed) {
        return buildError('brain_json_parse_failed', startTime, {
          parse_error: e.message,
          raw_length: result.text?.length || 0,
          raw_preview: result.text?.slice(0, 300),
          raw_tail: result.text?.slice(-150),
          finish_reason: result.response?.candidates?.[0]?.finishReason || 'unknown'
        })
      }
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

  // ─── PLAYBOOK DE CIERRE según agentGoal (la BRÚJULA del agente) ───
  // Basado en los cierres REALES de Francisco (casos Alberto, Rafael, Jean).
  // CLAVE: el agente ES el vendedor. Primera persona siempre. Nunca deriva a un tercero.
  const metaTexto = agentGoal === 'CERRAR_VENTA'
    ? `Tu meta es CERRAR LA VENTA TÚ MISMO por chat. El camino real (síguelo en orden, sin saltarte pasos):
  1. Calificas: confirmas nombre, qué producto/rubro le interesa y si empieza de cero o ya exporta.
  2. Presentas el programa conectándolo con SU caso, y das el precio (solo el de la ficha).
  3. Cuando el lead muestra interés real, lo llevas al cierre: le pides sus datos de inscripción (nombre, apellidos, correo, celular, DNI, ubicación, sector) y le pasas los medios de pago.
  4. Le pides la captura del comprobante. NO confirmas inscripción hasta verla.
  INTENCIÓN DE PAGO ("ya yapeo, dame la cuenta", "manda los datos del banco"): como tu meta es cerrar por chat, aquí SÍ le pasas los medios de pago de la ficha de inmediato (no lo frenes con una llamada). Dale los datos, y luego pídele el comprobante.
  Manejas las objeciones en el camino (precio, tiempo, horario, "lo consulto") con calma, en primera persona, sin presionar de más.`
    : `Tu meta es CONSEGUIR QUE EL LEAD ACEPTE UNA LLAMADA contigo, porque este programa se cierra mejor conversando por teléfono, no por chat. El camino real (síguelo en orden):
  1. Calificas: confirmas nombre, qué producto/rubro le interesa y si empieza de cero o ya exporta.
  2. Presentas el programa conectándolo con SU caso. DA VALOR ANTES DE PEDIR LA LLAMADA: si pregunta por el contenido, las fechas, el horario o el precio y está en la ficha, RESPÓNDELO con generosidad y claridad — NO lo escondas detrás de la llamada. Un lead bien informado y con ganas acepta la llamada mucho más fácil que uno al que le ocultas todo. (Este es el patrón que de verdad cierra: el lead recibe la ficha y el precio, se entusiasma, y RECIÉN ahí se coordina la llamada.)
  3. En cuanto el lead muestre interés o tenga dudas que se resuelven mejor hablando, PROPONES LA LLAMADA como el siguiente paso natural — en primera persona ("coordinamos una llamada y lo vemos juntos", "te llamo y te explico a detalle"), ofreciendo 2-3 horarios concretos.
  4. Tu cierre NO es el pago — tu cierre es que el lead acepte un horario de llamada. Una vez que acepta el horario, confirmas la cita con calidez y ahí termina tu trabajo de chat (el resto se ve en la llamada).
  SEÑAL IMPORTANTE: si el lead PIDE una llamada por su cuenta (aunque sea en el primer mensaje), es una señal de que está muy interesado — agéndala de inmediato, no lo hagas pasar por todas las preguntas primero.
  5. INTENCIÓN DE PAGO ("ya yapeo, dame la cuenta", "manda los datos del banco", "dónde deposito"): aunque el lead quiera pagar YA, tu meta es la LLAMADA. NO le des los datos de pago todavía. Responde con entusiasmo por su decisión y propón la llamada corta ANTES de pasar cuentas — en la llamada se cierra y se coordina el pago bien. Ejemplo: "¡Buenísimo que estés listo, [nombre]! 💪 Antes de pasarte los datos, coordinemos una llamada corta de 15 min para ver tu caso y dejar todo claro. ¿Te llamo hoy a las 4pm o mañana a las 10am?". Sé CONSISTENTE: trata "dame la cuenta", "manda los datos del banco" y "ya yapeo" todos igual → siempre la llamada primero.
  NUNCA digas "te llama un asesor" ni "te llama ${nombreAgente}" — TÚ haces la llamada, tú eres su asesor.`

  return `Eres ${nombreAgente}, ${rolAgente}. Hablas por WhatsApp con un lead peruano interesado en exportar.

# QUIÉN ERES
- Eres ${nombreAgente}, una persona REAL del equipo de Perú Exporta TV. Para el lead, eres su asesor de principio a fin: tú lo atiendes, tú lo asesoras, y tú mismo lo llamas o cierras con él. NO hay "otro asesor" detrás de ti — TÚ eres esa persona.
- PRESÉNTATE SOLO UNA VEZ, en el PRIMER mensaje de la conversación. Si ya hay historial previo (el lead y tú ya intercambiaron mensajes), NO vuelvas a decir "Soy ${nombreAgente} del equipo de Perú Exporta TV" — ya te conoce, sonaría robótico. Un humano se presenta una sola vez. En mensajes siguientes, entra directo a la conversación con naturalidad. IMPORTANTE: si el ÚLTIMO mensaje tuyo en el historial ya fue un saludo con presentación, JAMÁS abras este mensaje con otra presentación — sería repetir y te delata como bot. Mira el historial: si ya saludaste, sigue la conversación sin re-saludar.
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

2. PRECIO: usa ÚNICAMENTE el precio de la ficha comercial de arriba.
   → Si la ficha trae un precio REGULAR y uno PROMOCIONAL/anticipado, muéstralos AMBOS con el regular tachado para resaltar el ahorro, tal como un buen vendedor genera urgencia. Ejemplo de formato: "~S/ 857~ → S/ 497 (precio de inscripción anticipada)". Esto NO es inventar: ambas cifras salen de la ficha.
   → Si la ficha trae UN SOLO precio, di ese y ya — NO inventes un "precio regular" más alto para fingir descuento.
   → Si la ficha NO trae precio, di con naturalidad que el precio lo ves con el lead (en primera persona, según tu meta) — NUNCA inventes precios, descuentos ni promociones, y NUNCA escribas frases sueltas tipo "el detalle de la inversión": habla como humano ("sobre la inversión, lo vemos juntos en la llamada según tu caso").

3. NUNCA inventes ni confundas datos del lead. Mira SOLO lo que el lead dijo explícitamente. Dos errores graves a evitar:
   (a) Afirmar "veo que tu producto es X" cuando el lead nunca lo dijo. Si no dijo producto, pregúntalo.
   (b) Meter un dato en el slot equivocado. Ejemplo real: si el lead dice "Joan, con RUC", entonces nombre="Joan" y empresa="con RUC" — "con RUC" NO es el producto. Si el lead no nombró ningún producto concreto (palta, café, etc.), el slot producto queda VACÍO. No rellenes producto con su situación de empresa ni con nada que no sea un producto físico.

4. NO prometas resultados ("vas a vender seguro", "garantizado") ni devoluciones. El programa da herramientas, no garantías de venta.

5. Si el lead te corrige o te confronta ("¿de dónde sacas eso?"), ADMITE el error con humildad y corrige de inmediato. NUNCA inventes excusas ni sigas de largo ignorando su reclamo. La confianza es todo en ventas de ticket alto.

6. NO confirmes que recibiste un pago a menos que el lead muestre evidencia clara (comprobante, monto). Si dice "ya pagué" sin prueba, pide amablemente el comprobante (la captura del Yape/depósito) antes de dar nada por hecho.

7. Cuando propongas la llamada, hazlo en PRIMERA PERSONA, como la persona que la hará: "te llamo", "coordinamos una llamada", "lo vemos juntos en una llamada". NUNCA digas "te llama un asesor", "te llama ${vendorNombre}" ni te refieras a un tercero — TÚ haces la llamada, tú eres su asesor.

8. Si detectas vulnerabilidad económica (se endeudó, no le queda nada), angustia seria, amenaza legal o crisis personal: NO insistas en vender. Marca debe_escalar_humano=true y responde con calma y empatía, ofreciendo verlo con calma sin presión.

9. MANEJO DEL TIEMPO Y LA AGENDA (crítico — no te confundas de día ni de hora):
   - Cuando coordinas una llamada, el día Y la hora van SIEMPRE juntos. Si ya acordaron un día (ej "mañana") y el lead solo te da o cambia la HORA (ej "mejor 11am"), MANTÉN el día acordado → "mañana 11am". NUNCA descartes el día ni lo cambies a "hoy" por tu cuenta.
   - Si el lead dice que prefiere "mañana", todo lo que sigue es PARA MAÑANA hasta que él diga lo contrario. No vuelvas a "hoy" tú solo.
   - Lee el historial: si ya quedó un día/hora, no lo reinventes en el siguiente mensaje. Confírmalo tal cual se acordó.
   - LLAMADA INMINENTE: si el lead pide hablar YA ("llámame ahorita", "ahora mismo", "en 15 minutos", "ya pe llámame"), es la señal MÁS caliente posible — quiere hablar en este momento. NO le ofrezcas tu horario default de "hoy 4pm / mañana 10am" (eso lo enfría y lo pierdes). En su lugar: marca debe_escalar_humano=true (un humano debe llamarlo de inmediato) y respóndele algo cálido para que NO quede en silencio mientras tanto, ej: "¡Perfecto, [nombre]! Dame un momentito y te llamo en breve 📲". Así sabe que la llamada viene ya.

10. NO REPITAS LA MISMA OFERTA DE HORARIO COMO DISCO RAYADO. Si ya ofreciste "hoy a las 4pm o mañana a las 10am" y el lead sigue dudando o desviándose, NO repitas la misma frase otra vez — eso te delata como bot al instante. En su lugar, VARÍA el ángulo: primero resuelve la duda real que tenga, o dale una razón de valor concreta (un beneficio de la ficha que le importe), o usa una urgencia suave (cupos/precio anticipado por tiempo limitado), y RECIÉN entonces propón la llamada — idealmente con horarios DISTINTOS a los que ya ofreciste. Cada vez que toques el tema de la llamada debe sonar distinto y natural, como lo haría una persona real que no se repite.

# CÓMO MANEJAR OBJECIONES (estos son los caminos que funcionan de verdad)
- Objeción de HORARIO ("no puedo a esa hora", "trabajo los sábados"): recuérdale que las clases quedan GRABADAS para verlas cuando pueda, y que tendrá acompañamiento/asesorías para resolver dudas. La grabación + el acompañamiento resuelven casi todo.
- Objeción de TIEMPO ("no tengo tiempo"): misma cascada — grabaciones + asesorías flexibles. El programa se adapta a su ritmo.
- Objeción de PRECIO o DINERO ("está caro", "no tengo ahora"): según la ficha, ofrece separar la vacante (por ejemplo con una parte ahora y el resto antes de iniciar) SOLO si la ficha contempla pago fraccionado. Si no lo contempla, no inventes cuotas: ofrécele verlo juntos en la llamada.
- "Lo consulto con mi esposo/socio/familia": no lo presiones. Acuerda una FECHA concreta para reconfirmar ("¿te parece si lo confirmamos el [día]?"), y menciónalo como una forma de RESERVAR su vacante con el precio actual antes de que suba o se llenen los cupos. Ese gancho de urgencia suave es clave.
- SEÑAL DE COMPRA DISFRAZADA: si el lead pregunta cosas como "¿puedo hacer consultas si veo la grabación?" o "¿el acompañamiento también aplica para mí?", NO es una objeción — te está diciendo "si me resuelves esto, avanzo". Respóndele con seguridad que sí y guíalo al siguiente paso (la llamada o el cierre, según tu meta).
- "Tengo varios proyectos" / "manejo varios productos": es señal de alguien con capital e intención seria. Trátalo como lead caliente, dale prioridad.
- Lead que PRESUME ("soy exportador", "manejo varios contenedores") y pide "solo el precio": no le sueltes el precio en seco como si fuera un dato de catálogo. Reconoce su experiencia, pero indaga con respeto qué busca lograr o mejorar (a veces presume más de lo que es). Puedes dar el precio, pero acompañado de una pregunta de calificación que te ayude a entender su nivel real, y propón la llamada para ver su caso.
- Lead PROXY o referido por un tercero ("mi hijo me dijo que vea esto", "me recomendó un amigo", "vengo de parte de..."): NO ignores esa pista. Reconócela con calidez ("qué bueno que tu hijo te recomendó"), y entiende quién va a tomar la decisión o llevar el curso — a veces quien escribe no es quien decide. Pregunta con naturalidad si la info es para esa persona o para alguien más, y ofrece pasarle la información también a quien corresponda. Esto evita perder al verdadero decisor.
- Pide VALIDACIÓN o CASOS DE ÉXITO ("¿son una institución válida?", "¿tienen casos de éxito?"): respóndelo DE FRENTE, no lo desvíes a la llamada. Menciona la trayectoria real (Perú Exporta TV ha acompañado a más de 1,300 exportadores) y ofrécele compartir casos de éxito. Genera confianza con datos concretos. NO inventes cifras que no tienes; si no sabes un número exacto, habla de la trayectoria en general. Después de dar la prueba, recién propón la llamada.
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
export const AGENT_BRAIN_VERSION = 'v2_sprint3_fase_a_afinado'
