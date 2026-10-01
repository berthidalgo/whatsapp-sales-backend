// src/brain/verticals/colageno.js — VERTICAL COLÁGENO (BIOAYUR ELIXIR)
//
// ─────────────────────────────────────────────────────────────────────────
// El manual de venta del e-commerce nutracéutico (jul 2026). Nace del documento
// BIOAYUR_CHATBOT_SISTEMA.md del dueño (venta consultiva PAS: dolor → deseo →
// precio como CIERRE) + el diagnóstico forense del 1/60 (el error fue volcar
// foto+precios+distrito en el primer mensaje) + la mentoría de flujos (salud =
// SEMIconsultiva; las objeciones reales son lo que separa al bot que cierra).
//
// Filosofía de este vertical (INVERSA a exportación):
//   - El bot SÍ CIERRA la venta por chat: toma el pedido completo (pack +
//     nombre + distrito + dirección) con pago CONTRAENTREGA (paga al recibir).
//   - Al confirmar el pedido, ESCALA a humano con el resumen para despachar.
//   - EL PRECIO NO EXISTE HASTA EL MOMENTO 4 (espejo de "la llamada no existe
//     hasta M5" de exportación — misma mecánica, distinto objeto prohibido).
//   - CUMPLIMIENTO DIGEMID/Meta: PROHIBIDO "curar" y variantes. Solo
//     "apoya / favorece / contribuye / ayuda a". Guardrail determinista abajo.
//
// Mapeo de stages (mismos IDs del motor — el FSM no se toca):
//   first_contact      = M1 Entrada del asesor (reconoce oferta, reconduce al DOLOR)
//   discovery          = M2 Profundizar el dolor
//   qualifying_empresa = M3 Validar + prueba/autoridad (SIN precio)
//   presenting         = M4 Foto + PRECIO + packs (ancla el pack de 3)
//   call_scheduling    = M5 Cierre logístico (distrito + nombre + dirección)
//   call_confirmed     = M6 Pedido confirmado (lo marca el humano al despachar)
//
// NÚCLEO COMÚN (jul 2026): las reglas de conversación genéricas se COMPONEN desde
// nucleo-comun.js. Al portar este vertical desde exportación se habían perdido
// reglas por copia manual (p.ej. "SALUDAS UNA SOLA VEZ") — ahora se heredan y el
// test de contrato falla si falta alguna. Aquí abajo queda solo lo PROPIO del
// negocio: DIGEMID, contraentrega, los packs, el cierre por chat.
// ─────────────────────────────────────────────────────────────────────────

import {
  personaBase,
  UNA_PREGUNTA_A_LA_VEZ,
  ANTI_DISCO_RAYADO,
  CONDUCCION_BASE,
  REGLAS_DURAS_BASE
} from './nucleo-comun.js'

export const VERTICAL_ID = 'colageno'

// ════════════════════════════════════════════════════════
// SCHEMA de salida estructurada (misma columna vertebral que exportación:
// el motor espera estos campos top-level; cambian slots y semántica de cierre)
// ════════════════════════════════════════════════════════
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mensaje: {
      type: 'string',
      description: 'El mensaje natural para la clienta/el cliente. Una pregunta a la vez. Tono peruano cálido y femenino-cercano (💜 😊), CORTO (2-4 líneas de WhatsApp). SOLO datos de la ficha. NUNCA inventes precios, promociones, beneficios médicos ni plazos de entrega. PROHIBIDO decir "curar/cura/sana/elimina/trata la enfermedad" — solo "apoya/favorece/contribuye/ayuda a". Si el mensaje es largo (ej: presentar los packs en M4), sepáralo en párrafos cortos con \\n\\n.'
    },
    momento_actual: {
      type: 'string',
      description: 'En cuál de los 6 momentos del flujo estás DESPUÉS de este mensaje. M1=entrada y elegir dolor, M2=profundizar dolor, M3=validar+prueba (sin precio), M4=precio y packs, M5=cierre logístico (distrito/nombre/dirección), M6=pedido confirmado. Avanza en orden; NO saltes a M4 sin que haya elegido su dolor, salvo que insista 2 veces en el precio.',
      enum: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']
    },
    stage_sugerido: {
      type: 'string',
      description: 'A qué etapa del funnel pasar (mapea con el momento: M1=first_contact, M2=discovery, M3=qualifying_empresa, M4=presenting, M5=call_scheduling, M6=call_confirmed).',
      enum: ['first_contact', 'discovery', 'qualifying_empresa', 'presenting', 'call_scheduling', 'call_confirmed', 'post_close']
    },
    debe_escalar_humano: {
      type: 'boolean',
      description: 'true si hay pedido aceptado con los datos necesarios, logística fuera de la cobertura documentada, reclamo, consulta médica delicada, petición de persona, hostilidad sostenida o vulnerabilidad seria.'
    },
    razon_escalamiento: {
      type: 'string',
      description: 'Si debe_escalar_humano=true, POR QUÉ en pocas palabras, para avisar al equipo. Ej: "PEDIDO: 3 envases, María, Surco — despachar hoy", "quiere envío a Trujillo (provincia)", "reclamo de pedido anterior", "consulta médica (gestante)". Vacío si no escalas.'
    },
    como_cerrarlo: {
      type: 'string',
      description: 'SOLO si debe_escalar_humano=true: briefing interno para el humano (NO se envía a la clienta). Si es PEDIDO CONFIRMADO: el resumen operativo completo — pack elegido, precio total, nombre, distrito, dirección/referencia si la dio, y cualquier detalle útil ("quiere que llegue antes del viernes"). Si es otra escalada: la jugada — qué la motiva, qué la frena, siguiente paso concreto. Aterrizado a ESTA conversación, nunca genérico.'
    },
    temperatura_lead: {
      type: 'string',
      description: 'Qué tan caliente está — y tu comportamiento DEBE reflejarlo: hot = quiere comprar YA, deja de preguntar y toma el pedido; warm = flujo consultivo normal; cold = cero presión, cierra cálido con la puerta abierta.',
      enum: ['cold', 'warm', 'hot']
    },
    slots_detectados: {
      type: 'object',
      description: 'Datos que la clienta reveló EXPLÍCITAMENTE. Regla de oro: si dudas a qué slot pertenece algo, NO lo pongas. Omite la clave de cualquier dato que no haya dado.',
      properties: {
        nombre: { type: 'string', description: 'El nombre propio de la clienta/el cliente. Ej: "María", "Rosa". NO un saludo.' },
        dolor: { type: 'string', description: 'El objetivo principal que ELIGIÓ mejorar: "piel", "energia", "articulaciones", "cabello_unas" o "todo". SOLO si lo dijo o eligió del menú (tocó 1/2/3/4 o lo nombró). Si aún no elige, OMITE la clave.', enum: ['piel', 'energia', 'articulaciones', 'cabello_unas', 'todo'] },
        detalle_dolor: { type: 'string', description: 'El matiz específico que contó de su dolor. Ej: "resequedad y líneas de expresión", "cansancio desde que despierta", "molestia en las rodillas", "prevenir". Con SUS palabras, corto.' },
        experiencia_colageno: { type: 'string', description: 'Si ya probó colágeno antes o es su primera vez. Ej: "ya tomó otro colágeno", "primera vez". SOLO si lo dijo.' },
        distrito: { type: 'string', description: 'El distrito de entrega (o ciudad si es provincia) para el envío. Ej: "Surco", "Comas", "Trujillo". SOLO si lo dijo.' },
        direccion: { type: 'string', description: 'La dirección o referencia de entrega si la dio. Ej: "Av. Aviación 2450, dpto 302". SOLO si la dio explícitamente.' },
        pack: { type: 'string', description: 'La opción o cantidad que ACEPTÓ comprar, exactamente como aparece en la ficha. No presupongas tamaños ni packs.' }
      }
    },
    compromiso: {
      type: 'object',
      description: 'SOLO si la clienta se comprometió a algo CONCRETO con FECHA futura (ej. "mañana te confirmo", "el lunes lo pido"). Si no hay compromiso fechado, OMITE esta clave.',
      properties: {
        tipo: { type: 'string', description: 'Tipo de compromiso.', enum: ['pago', 'comprobante', 'decision', 'otro'] },
        descripcion: { type: 'string', description: 'Qué prometió, en pocas palabras. Ej: "confirmar el pedido mañana".' },
        fecha_iso: { type: 'string', description: 'Fecha/hora ISO 8601 zona Perú -05:00. Ej: "2026-07-20T15:00:00-05:00". Resuelve "mañana"/"el lunes" con AHORA MISMO (va junto a la conversación). Sin fecha concreta → omite el compromiso entero.' }
      }
    },
    cierre: {
      type: 'object',
      description: 'Telemetría de tu jugada de CIERRE en ESTE turno (para no repetirte). Llénalo en M4/M5/M6 o al resolver una objeción. En M1-M3 sin objeción, OMITE.',
      properties: {
        ofrecio_llamada: { type: 'boolean', description: 'true SOLO si en ESTE mensaje propusiste CONCRETAR EL PEDIDO (pediste distrito/nombre o invitaste a coordinar el envío). false si no.' },
        objecion_trabajada: { type: 'string', description: 'Qué freno resolviste en ESTE turno. "ninguna" si no hubo. tiempo_decision = "lo pienso/te aviso".', enum: ['precio', 'confianza', 'funciona', 'tiempo_decision', 'forma_pago', 'ninguna'] },
        palanca: { type: 'string', description: 'Tu movimiento de avance este turno: valor (beneficio/dato útil), prueba_social (clientas que notan diferencia / respaldo de la ficha), resolver_objecion, cierre_suave (siguiente paso natural), eleccion_alternativa (ofreciste 2 packs). "ninguna" si solo conversaste.', enum: ['valor', 'prueba_social', 'resolver_objecion', 'cierre_suave', 'eleccion_alternativa', 'ninguna'] }
      }
    },
    enviar_imagen: {
      type: 'string',
      description: 'Pon "precios" SOLO en el Momento 4, EXACTAMENTE en el turno en que presentas los packs y precios — el sistema adjunta automáticamente la foto oficial con las opciones de esta campaña. NO la pongas en ningún otro momento (ni al saludar, ni al hablar del dolor, ni en el cierre logístico). Omite la clave si no corresponde. Nunca digas "te mando la foto" como si la escribieras: solo presentas los precios en texto y el sistema envía la imagen sola.',
      enum: ['precios']
    },
    razonamiento: {
      type: 'string',
      description: 'MÁXIMO 1 frase corta (menos de 15 palabras). Ej: "M2, profundizo su dolor de piel." Interno, NO se envía.'
    }
  },
  required: ['mensaje', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead']
}

// ════════════════════════════════════════════════════════
// MOMENTOS — el flujo consultivo PAS de BIOAYUR (del .md del dueño)
// ════════════════════════════════════════════════════════
export const MOMENTOS = {
  "first_contact": "**MOMENTO 1 — ENTRADA DEL ASESOR**\nPreséntate UNA vez. Reconoce el motivo del contacto sin afirmar que existe una promoción. Pregunta qué quiere mejorar, usando solo objetivos respaldados por la ficha. NO des precio ni foto todavía; si insiste en el precio después de una reconducción, responde con el precio exacto publicado. No presupongas un menú automático previo.",
  "discovery": "**MOMENTO 2 — PROFUNDIZAR SU DOLOR**\nEscucha y valida con empatía SIN dramatizar. Haz UNA pregunta relevante sobre su objetivo o experiencia. SIN precio ni foto. No hagas diagnósticos, no prometas resultados ni beneficios ausentes de la ficha.",
  "qualifying_empresa": "**MOMENTO 3 — VALIDAR Y APORTAR VALOR**\nUsa un beneficio o dato de composición EXPLÍCITO de la ficha relacionado con su necesidad. Certificaciones, dosis, duración, ingredientes, tolerancias, resultados y testimonios SOLO si constan en la ficha. No inventes respaldo institucional. SIN precio ni foto.",
  "presenting": "**MOMENTO 4 — PRECIO Y OPCIONES**\nPresenta únicamente las opciones y ofertas vigentes de esta ficha. No asumas número de envases, duración del tratamiento ni descuento. Usa enviar_imagen=precios solo si hay una imagen registrada.\n__FICHA__\nConduce con UNA pregunta hacia la opción que el cliente prefiera.",
  "call_scheduling": "**MOMENTO 5 — CIERRE LOGÍSTICO**\nRecoge opción/pack elegido, nombre, distrito o ciudad y dirección. Pago, cobertura, costo de envío y plazos SOLO según ficha. Si no están documentados, confirma con el equipo; no prometas contraentrega ni envío gratis. No vuelvas a preguntar datos que ya dio.",
  "call_confirmed": "**MOMENTO 6 — PEDIDO CONFIRMADO**\nConfirma el resumen con los datos aportados y el precio publicado, sin prometer stock ni despacho inmediato. PEDIDO CONFIRMADO = ESCALAR: debe_escalar_humano=true, razón comienza con PEDIDO:, resumen operativo en como_cerrarlo. El equipo confirma la logística pendiente."
}

export function construirFlujoMomentos({ pasoPresentacion, nombreProducto = null }) {
  const header = `# EL FLUJO — 6 MOMENTOS, NUNCA CAMBIES EL ORDEN
Vas avanzando 1 → 2 → 3 → 4 → 5 → 6. Mira el historial para saber en qué momento estás. Reporta el momento en que quedas en el campo "momento_actual". La regla de oro del orden: DESEO primero, PRECIO después, DISTRITO al final. Si la clienta corre (quiere comprar ya), tú corres con ella — el orden se salta hacia ADELANTE cuando la señal de compra es clara, jamás se le frena.`

  const ORDEN = ['first_contact', 'discovery', 'qualifying_empresa', 'presenting', 'call_scheduling', 'call_confirmed']
  const bloques = ORDEN.map(stage => {
    let texto = MOMENTOS[stage]
    // La marca se interpola ANTES de inyectar la ficha: la ficha (dato del
    // cliente en BD) no se toca, solo la prosa del manual.
    if (stage === 'presenting' && texto.includes('__FICHA__')) {
      texto = texto.replace('__FICHA__', pasoPresentacion)
    }
    return texto
  })
  return header + '\n\n' + bloques.join('\n\n')
}

// ════════════════════════════════════════════════════════
// SYSTEM PROMPT — la identidad y reglas del asesor BIOAYUR
// ════════════════════════════════════════════════════════
export function construirSystemPrompt({ campaignConfig, fs, vendorNombre, estadoLead }) {
  const agente = campaignConfig?.agente || {}
  const nombreAgente = agente.nombre || vendorNombre || 'asesor'
  const nombreEmpresa = agente.empresa || 'nuestra marca'
  const nombreProducto = agente.nombreProducto || 'nuestro producto'
  const pasoPresentacion = fs?.tieneFactSheet ? fs.factSheetBloque : '(Sin ficha: NO des ningún precio; confirma los datos con el equipo.)'
  return `Eres ${nombreAgente}, ${agente.rol || 'asesor comercial de '+nombreEmpresa}. Atiendes consultas por WhatsApp sobre ${nombreProducto}.
# IDENTIDAD Y CONVERSACIÓN
${personaBase({nombreAgente,nombreEmpresa})}
${UNA_PREGUNTA_A_LA_VEZ}
${ANTI_DISCO_RAYADO}
${CONDUCCION_BASE}
${REGLAS_DURAS_BASE}
TÚ SÍ CIERRAS LA VENTA POR CHAT. Sigue la ficha para público, tono, pago y entrega. No inventes experiencia personal ni afirmes que el producto tiene una fórmula concreta.
# EL PRECIO NO EXISTE HASTA EL MOMENTO 4
Primero escucha y aporta valor. Si insiste tras una reconducción, responde con el precio exacto. Un cliente que ya quiere comprar pasa al pedido sin cuestionarios.
# PROHIBIDO "CURAR"
Lenguaje permitido: apoya, favorece, contribuye, ayuda a, únicamente según ficha. No prometas curación, resultados garantizados ni sustitución de tratamientos médicos. Solo beneficios expresamente respaldados por la ficha, sin diagnósticos. En embarazo, lactancia, enfermedades o medicación, recomienda consultar a su médico y escala si requiere atención humana.
# DATOS DEL PRODUCTO — ÚNICA FUENTE
${pasoPresentacion}
Composición, dosis, peso, porciones, sabor, alérgenos, registro sanitario, duración, testimonios y cualquier garantía SOLO de esta ficha. Si falta un dato, dilo y confirma con el equipo. No infieras una propiedad porque otro producto del mismo vertical la tenga.
Pago, cobertura y plazos SOLO de la ficha. NUNCA proporciones números de cuenta ni confirmes pagos sin validación humana.
# FLUJO
${construirFlujoMomentos({pasoPresentacion,nombreProducto})}
Si ya aportó los datos del pedido, confirma y escala. Si rechaza, retírate con dignidad y cero persecución. Vulnerabilidad grave y petición de persona requieren atención humana. Nunca re-encuestes al cliente ni repitas una promesa. Devuelve el JSON estructurado.`
}
// ════════════════════════════════════════════════════════
// GUARDRAIL DETERMINISTA ANTI-"CURAR" (DIGEMID + Meta) — red de seguridad
// El prompt ya lo prohíbe; esto garantiza que NI UNA salida con lenguaje
// curativo llegue al lead. Mismo patrón validado del guardrail de precio
// fantasma: neutralizar la ORACIÓN completa (reemplazo léxico rompería la
// gramática), sustituyéndola por el reencuadre seguro del .md del dueño.
// ════════════════════════════════════════════════════════
// Léxico prohibido (con \b para no dar falsos positivos: "curiosa", "procura",
// "vida sana" NO matchean; "cura/curar/curación/curativo" y "sanar/sanará" SÍ).
const RX_CURAR = new RegExp(
  [
    '\\bcura(r|rá|rán|rlo|rla|rte|s|n|ndo|ción|tiva|tivo)?\\b',   // cura, curar, curará, curación, curativo...
    '\\bsanar(á|án|te|lo|la)?\\b', '\\bsane[sn]?\\b',              // sanar, sanará, sane (verbo; "sana" adjetivo se salva)
    '\\belimina(rá|r|n)? (el|la|los|las) dolor',                   // elimina el dolor...
    '\\bdesaparec\\w* (el|la|los|las) (dolor|arrug)',              // desaparece el dolor / las arrugas
    '\\btrata(rá|r|miento para)? (la|el) (enfermedad|artrosis|artritis|diabetes|osteoporosis|gastritis|ansiedad|depresi)',
    '\\bes (un )?medicamento\\b', '\\bcomo medicina\\b',
    '\\bgarantiz\\w+ (que|resultados)'
  ].join('|'),
  'i'
)

const FRASE_SEGURA = ' Es un suplemento que apoya el bienestar según su ficha; no reemplaza un tratamiento médico. Para tu caso, consulta con un profesional de salud.'

export function validarMensajeExtra(mensaje) {
  const flags = []
  if (!mensaje || typeof mensaje !== 'string' || !RX_CURAR.test(mensaje)) {
    return { mensaje, flags }
  }
  // Neutraliza SOLO las oraciones que contienen léxico prohibido; preserva el resto.
  const oraciones = mensaje.match(/[^.!?]+[.!?]*/g) || [mensaje]
  let reemplazos = 0
  let out = oraciones
    .map(o => {
      if (RX_CURAR.test(o)) {
        reemplazos++
        // La frase segura se inserta UNA sola vez; oraciones prohibidas extra se borran.
        return reemplazos === 1 ? FRASE_SEGURA : ''
      }
      return o
    })
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // Paranoia final: si tras neutralizar quedara vacío (mensaje era 100% prohibido),
  // enviamos el reencuadre seguro solo.
  if (!out) out = FRASE_SEGURA.trim()
  flags.push(`curar_neutralizado_x${reemplazos}`)
  return { mensaje: out, flags }
}

// ════════════════════════════════════════════════════════
// PIEZAS DEL NEGOCIO QUE EL MOTOR CONSUME (sep 2026)
// ════════════════════════════════════════════════════════

// Historial de cierre de ESTA conversación (lo resume brain-pipeline desde lead_state).
// Viaja en el mensaje del turno, no en el system prompt (cambia turno a turno).
export function textoHistorialCierre(cierreResumen) {
  return `# TU HISTORIAL DE CIERRE EN ESTA CONVERSACIÓN
${cierreResumen}. (Aquí "llamada" = tus intentos de concretar el pedido.) NO es para que abandones el cierre — es para que NO lo propongas calcado: cada nuevo intento con un ángulo fresco atado a lo último que dijo. Si ya resolviste una objeción, no la re-expliques.`
}

// Memoria de la clienta que vuelve (brain-pipeline → construirResumenMemoria): sus
// slots y hasta dónde llegaron, dicho en el idioma de este negocio.
export const MEMORIA_EPISODICA = {
  datos: [
    ['dolor', 'Quería mejorar'],
    ['detalle_dolor', 'Lo que le preocupaba'],
    ['experiencia_colageno', 'Experiencia con colágeno'],
    ['pack', 'Pack que eligió'],
    ['distrito', 'Distrito']
  ],
  etapas: {
    first_contact:         'apenas se estaban saludando',
    discovery:             'estaban viendo qué quería mejorar',
    qualifying_empresa:    'ya le habías contado de la fórmula',
    presenting:            'ya le habías dado los precios',
    call_scheduling:       'ya estaban coordinando su pedido',
    call_confirmed:        'ya había confirmado un pedido',
    post_close:            'ya había comprado',
    returning_recognition: 'ya había vuelto antes'
  }
}

// Si la campaña no tiene ficha y el modelo escribe un precio, se neutraliza la
// oración con esto. Aquí no hay llamada: el cierre es por chat.
export const FRASE_PRECIO_SIN_FICHA = ' El precio exacto de los packs te lo confirmo en un momento 😊'

// Briefing al vendedor: lo que necesita para DESPACHAR, no para calificar.
export const CAMPOS_BRIEFING = [
  ['💜', 'dolor', '(objetivo por confirmar)'],
  ['📝', 'detalle_dolor', null],
  ['🧪', 'experiencia_colageno', null],
  ['📦', 'pack', '(pack por confirmar)'],
  ['📍', 'distrito', '(distrito por confirmar)'],
  ['🏠', 'direccion', null]
]

/**
 * ¿Este turno CERRÓ una venta? En colágeno el bot toma el pedido y lo escala con
 * razon_escalamiento="PEDIDO: ..." (Momento 6). Marcarlo importa porque, sin marca,
 * el motor de fondo trataba al lead como uno más: a las 6 h sin mensaje humano lo
 * "rescataba" al bot y le mandaba el followup "no se te pase la promo" a alguien que
 * YA compró.
 *
 * @returns {object|null} el pedido ({ pack, distrito, direccion, nombre }) o null
 */
export function detectarVentaCerrada({ debeEscalar, razonEscalamiento, slots = {} }) {
  if (!debeEscalar) return null
  const dijoPedido = /^\s*pedido\b/i.test(String(razonEscalamiento || ''))
  const datosCompletos = !!(slots.pack && slots.distrito && slots.nombre)
  if (!dijoPedido && !datosCompletos) return null
  return {
    pack: slots.pack || null,
    distrito: slots.distrito || null,
    direccion: slots.direccion || null,
    nombre: slots.nombre || null
  }
}

export const COLAGENO_VERTICAL_VERSION = 'v2_producto_por_config'
