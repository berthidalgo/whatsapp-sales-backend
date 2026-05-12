// src/response/response-prompts.js — Hidata v20 Día 6
//
// CATÁLOGO DE PROMPTS Y TEMPLATES
//
// Estructura híbrida para 9 action types:
//   - 4 templates puros: SALUDAR_INICIAL, PEDIR_CALIFICACION, 
//     PEDIR_SITUACION_EMPRESA, GREET_RETURNING, CONFIRMAR_PAGO
//   - 4 LLM prompts: PRESENTAR_PROGRAMA, MANEJAR_OBJECION, 
//     AGENDAR_LLAMADA
//   - 1 no-op: SILENCE (no genera texto)
//
// Cada prompt está versionado para A/B testing futuro.

import { ACTIONS, OBJECTION_STRATEGIES } from '../policy/action-types.js'

// ════════════════════════════════════════════════════════
// STRATEGY MAP — qué hace cada action: template o LLM
// ════════════════════════════════════════════════════════
export const RESPONSE_STRATEGY = {
  [ACTIONS.SALUDAR_INICIAL]:          'template',
  [ACTIONS.PEDIR_CALIFICACION]:       'template',
  [ACTIONS.PEDIR_SITUACION_EMPRESA]:  'template',
  [ACTIONS.GREET_RETURNING]:          'template',
  [ACTIONS.CONFIRMAR_PAGO]:           'template',
  
  [ACTIONS.PRESENTAR_PROGRAMA]:       'llm',
  [ACTIONS.MANEJAR_OBJECION]:         'llm',
  [ACTIONS.AGENDAR_LLAMADA]:          'llm',
  
  [ACTIONS.SILENCE]:                  'no_response'
}

// ════════════════════════════════════════════════════════
// TEMPLATES PUROS — substitución de variables simple
// Cada template tiene versión y array de variantes (futuro A/B)
// ════════════════════════════════════════════════════════

export const TEMPLATES = {
  // SALUDAR_INICIAL — primer contacto, sin contexto del lead
  [ACTIONS.SALUDAR_INICIAL]: {
    version: 'v1',
    variants: [
      "¡Hola! Soy {vendorNombre} de Peru Exporta TV 🇵🇪\n\nTe damos la bienvenida al programa que ya formó a +1,300 exportadores peruanos.\n\nPara ayudarte mejor, ¿me dices tu nombre y qué producto te interesa exportar?",
      "¡Buenas! Soy {vendorNombre} del equipo Peru Exporta TV.\n\nNos da gusto que te animes a exportar 💪\n\n¿Me cuentas tu nombre y qué producto manejas?"
    ],
    variables: ['vendorNombre']
  },

  // PEDIR_CALIFICACION — ya saludamos, falta nombre o producto
  [ACTIONS.PEDIR_CALIFICACION]: {
    version: 'v1',
    variants: [
      "Perfecto. ¿Me ayudas con un par de datos?\n\n1) Tu nombre\n2) Qué producto exportas o quieres exportar\n3) Si ya tienes experiencia exportando o estás comenzando",
      "Súper. Para asesorarte mejor necesito saber:\n\n• Tu nombre\n• El producto que manejas\n• Si ya exportaste antes o es tu primera vez"
    ],
    variables: []
  },

  // PEDIR_SITUACION_EMPRESA — ya tenemos nombre+producto
  [ACTIONS.PEDIR_SITUACION_EMPRESA]: {
    version: 'v1',
    variants: [
      "Excelente {nombre}, {producto} tiene muy buena demanda internacional 🌎\n\nUna pregunta clave:\n¿Tienes empresa constituida (RUC, SUNAT) o vas a empezar como persona natural?",
      "Genial {nombre}, {producto} es producto estrella de exportación peruana 💪\n\nCuéntame, ¿ya tienes empresa formal o estás empezando como independiente?"
    ],
    variables: ['nombre', 'producto']
  },

  // GREET_RETURNING — lead que vuelve después de 30+ días
  [ACTIONS.GREET_RETURNING]: {
    version: 'v1',
    variants: [
      "¡{nombre}! Qué bueno verte por aquí de nuevo 🤝\n\nVeo que conversamos hace un tiempo sobre exportar {producto}. ¿Cómo va todo? ¿Retomamos donde lo dejamos o hay algún cambio en tu plan?",
      "¡Hola {nombre}! Tiempo sin saber de ti 💪\n\nAntes hablamos sobre {producto}. ¿Sigues con la idea de exportar o cambiaron las cosas? Cuéntame y vemos cómo seguir."
    ],
    variables: ['nombre', 'producto']
  },

  // CONFIRMAR_PAGO — recibimos comprobante o lead afirma pago
  [ACTIONS.CONFIRMAR_PAGO]: {
    version: 'v1',
    variants: [
      "¡Perfecto {nombre}! 🎉\n\nRecibido tu pago. En breve {vendorNombre} te confirma todos los detalles del programa y la fecha de inicio.\n\n¡Bienvenido oficialmente a Peru Exporta TV! 🇵🇪",
      "¡Excelente {nombre}! ✅\n\nPago confirmado. Ya {vendorNombre} se contacta contigo para la siguiente etapa y darte acceso al programa.\n\nFelicidades, ya eres parte del equipo 💪"
    ],
    variables: ['nombre', 'vendorNombre']
  }
}

// ════════════════════════════════════════════════════════
// LLM PROMPTS — para acciones que requieren personalización
// ════════════════════════════════════════════════════════

// PRESENTAR_PROGRAMA — mostrar curso/precio personalizado
export const LLM_PROMPTS = {
  [ACTIONS.PRESENTAR_PROGRAMA]: {
    version: 'v1',
    system: `Eres asistente de Peru Exporta TV (ESCEX), programa de formación para exportadores peruanos.

CONTEXTO DEL PROGRAMA:
- Programa MPX (Master Programa de Exportación): 12 sesiones online + asesorías 1:1
- Precio actual: S/2,997 (regular S/4,500)
- Modalidad: clases en vivo + grabaciones + comunidad WhatsApp
- Resultados: +1,300 exportadores formados, casos de éxito en mango, palta, café, textil

TU TAREA:
Presentar el programa al lead de forma PERSONALIZADA según su producto y situación.

REGLAS DE TONO:
- Español peruano informal pero profesional
- Usa el nombre del lead naturalmente
- Conecta el programa con SU producto específico
- Menciona casos de éxito si el producto coincide
- NO uses "estimado/a", "cordialmente", "atentamente" (suena gringo)
- Mensaje en 4-6 líneas máximo
- Emojis moderados: 💪 🤝 ✅ 🌎 (no muchos)
- Termina con pregunta de cierre suave que invite a llamada

FORMATO DE OUTPUT:
Devuelve SOLO el texto del mensaje, sin metadata, sin comillas, sin prefacios.`,
    
    user_template: `INFORMACIÓN DEL LEAD:
- Nombre: {nombre}
- Producto: {producto}
- Empresa: {empresa_status}
- Experiencia exportando: {experiencia_status}

ÚLTIMO MENSAJE DEL LEAD: "{ultimo_mensaje}"

Genera el mensaje de presentación del programa para este lead.`,

    examples: [
      {
        input: { 
          nombre: 'Juan', 
          producto: 'palta hass',
          empresa_status: 'sin empresa formal',
          experiencia_status: 'primera vez exportando',
          ultimo_mensaje: 'cuéntame del programa'
        },
        output: `Juan, te cuento del programa MPX 💪\n\nEs una formación de 12 sesiones donde te llevamos paso a paso desde cero hasta tu primera exportación. La palta hass es producto bandera, hemos formado exportadores que cerraron su primer contenedor a USA en 4-6 meses.\n\nLa inversión es S/2,997 (regular S/4,500) e incluye:\n• 12 sesiones en vivo\n• Asesorías personalizadas 1:1\n• Comunidad WhatsApp para resolver dudas en tiempo real\n\n¿Te parece si conversamos en una llamada de 15 min para diseñarte tu plan?`
      }
    ]
  },

  // MANEJAR_OBJECION — varía según strategy
  [ACTIONS.MANEJAR_OBJECION]: {
    version: 'v1',
    system: `Eres asistente de Peru Exporta TV especializado en manejo de objeciones de leads peruanos.

CONTEXTO COMERCIAL:
- Programa MPX a S/2,997 (regular S/4,500)
- Opciones de pago: contado, 50/50, hasta 3 cuotas
- Modalidad híbrida: en vivo + grabaciones
- Vamos a generar respuestas según la STRATEGY específica detectada

REGLAS DE TONO:
- Español peruano informal pero respetuoso
- Validar la objeción ANTES de responder (no atacar)
- Usar el nombre del lead
- NO defensivo, SIEMPRE consultivo
- Mensaje en 3-5 líneas máximo
- Cerrar con pregunta que avance la conversación

STRATEGY ACTIVA: {strategy}

GUÍA POR STRATEGY:
- precio_reframe: comparar inversión vs ROI/costo de no exportar
- decision_qualify: pedir fecha específica de re-confirmación
- timing_fragmentar: ofrecer 50/50 o cuotas
- estacional_sincronizar: sincronizar curso con calendario del lead
- validacion_enviar_assets: ofrecer enviar casos de éxito
- tiempo_cascada_flexible: grabaciones + asesorías flexibles
- dinero_50_50_default: separar 50% + saldo
- familia_fecha_especifica: acordar fecha re-confirmación
- horario_cascada: flexibilidad de horarios
- ya_gaste_empatia_micro: empatía + micro-compromiso S/100
- generica: manejo genérico con redirección

FORMATO DE OUTPUT:
Devuelve SOLO el texto del mensaje, sin metadata, sin comillas, sin prefacios.`,

    user_template: `INFORMACIÓN DEL LEAD:
- Nombre: {nombre}
- Producto: {producto}
- Stage actual: {stage}

OBJECIÓN DETECTADA:
- Strategy: {strategy}
- Mensaje del lead: "{ultimo_mensaje}"
- Razón Perception: {rationale}

Genera el mensaje de manejo de objeción siguiendo la strategy "{strategy}".`,

    examples: [
      {
        input: {
          nombre: 'María',
          producto: 'café',
          stage: 'presenting',
          strategy: 'precio_reframe',
          ultimo_mensaje: 'está caro pe, mucha plata',
          rationale: 'objeción de precio post-presentación'
        },
        output: `Te entiendo María, S/2,997 suena fuerte si lo ves solo como gasto 🤝\n\nPero piénsalo así: con UN contenedor de café exportado recuperas eso 5 veces. Y el programa te da las herramientas para hacer 3-4 exportaciones al año.\n\n¿Qué tal si conversamos 15 minutos y te muestro cómo otros productores de café están exportando con esta inversión?`
      },
      {
        input: {
          nombre: 'Carlos',
          producto: 'palta',
          stage: 'presenting',
          strategy: 'dinero_50_50_default',
          ultimo_mensaje: 'no tengo toda la plata ahora',
          rationale: 'objeción de dinero sin recursos inmediatos'
        },
        output: `Te entiendo Carlos, entrar a una formación así es decisión grande 💪\n\nTenemos una opción: separas con el 50% (S/1,500) y el saldo lo pagas antes de iniciar las sesiones. Así aseguras tu cupo y tienes tiempo de organizar el resto.\n\n¿Te funciona esa modalidad?`
      }
    ]
  },

  // AGENDAR_LLAMADA — coordinar horario con lead
  [ACTIONS.AGENDAR_LLAMADA]: {
    version: 'v1',
    system: `Eres asistente de Peru Exporta TV agendando una llamada con un lead.

CONTEXTO:
- Llamadas son de 15-20 minutos
- Horario laboral: Lunes a Viernes 9am-7pm, Sábados 9am-2pm
- Zona horaria: Lima, Perú (GMT-5)
- Vendor que llama: {vendorNombre}

REGLAS DE TONO:
- Español peruano informal
- Si lead pidió llamada → confirmar entusiasmo
- Si tenemos fecha_hora → confirmar
- Si NO tenemos fecha_hora → proponer 2-3 opciones específicas (hoy noche, mañana mañana, mañana tarde)
- Mensaje en 3-4 líneas
- Cerrar con confirmación de horario

FORMATO DE OUTPUT:
Devuelve SOLO el texto del mensaje, sin metadata, sin comillas, sin prefacios.`,

    user_template: `INFORMACIÓN DEL LEAD:
- Nombre: {nombre}
- Producto: {producto}
- Stage: {stage}
- Fecha/hora propuesta: {fecha_hora}
- Mensaje del lead: "{ultimo_mensaje}"

Vendor que va a llamar: {vendorNombre}

Genera el mensaje de agendamiento.`,

    examples: [
      {
        input: {
          nombre: 'Joan',
          producto: 'palta',
          stage: 'call_scheduling',
          fecha_hora: null,
          ultimo_mensaje: 'sí dale, llámame',
          vendorNombre: 'Cristina'
        },
        output: `Perfecto Joan 🤝\n\nTe llama Cristina, especialista en exportación de palta. Te propongo:\n\n• Hoy a las 7pm\n• Mañana 11am\n• Mañana 4pm\n\n¿Cuál te queda mejor?`
      }
    ]
  }
}

// ════════════════════════════════════════════════════════
// FALLBACK TEMPLATES — cuando LLM falla
// Mensajes seguros que NUNCA generan respuesta vacía
// ════════════════════════════════════════════════════════
export const FALLBACK_TEMPLATES = {
  [ACTIONS.PRESENTAR_PROGRAMA]: 
    "{nombre}, te cuento del programa MPX 💪\n\nEs una formación de 12 sesiones diseñada para llevar a exportadores como tú de cero a tu primera exportación.\n\nInversión: S/2,997 (regular S/4,500). Incluye sesiones en vivo, asesorías personalizadas y comunidad WhatsApp.\n\n¿Conversamos en una llamada de 15 minutos?",

  [ACTIONS.MANEJAR_OBJECION]:
    "{nombre}, te entiendo 🤝\n\nVamos a buscar la mejor forma de que esto te funcione. ¿Tienes 10 minutos para una llamada y vemos qué opción se ajusta mejor a tu situación?",

  [ACTIONS.AGENDAR_LLAMADA]:
    "Perfecto {nombre} 💪\n\nTe propongo hablar mañana a las 11am o 4pm. ¿Cuál te queda mejor?"
}

// ════════════════════════════════════════════════════════
// HELPERS — para que response.js use estos prompts
// ════════════════════════════════════════════════════════

/**
 * Devuelve la strategy de generación para una action
 */
export function getResponseStrategy(action_type) {
  return RESPONSE_STRATEGY[action_type] || 'no_response'
}

/**
 * Devuelve template (para strategy='template')
 * Selecciona random entre variants
 */
export function getTemplate(action_type) {
  const template = TEMPLATES[action_type]
  if (!template) return null
  
  const variant = template.variants[Math.floor(Math.random() * template.variants.length)]
  return {
    text: variant,
    version: template.version,
    variables: template.variables
  }
}

/**
 * Devuelve prompt LLM completo (system + user template + examples)
 */
export function getLLMPrompt(action_type) {
  return LLM_PROMPTS[action_type] || null
}

/**
 * Devuelve template de fallback para una action
 */
export function getFallbackTemplate(action_type) {
  return FALLBACK_TEMPLATES[action_type] || null
}

/**
 * Sustituye variables en un template
 * @param {string} text - Template con {variable}
 * @param {object} vars - Objeto con valores
 */
export function substituteVariables(text, vars = {}) {
  if (!text) return ''
  
  let result = text
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `{${key}}`
    const safeValue = value === null || value === undefined ? '' : String(value)
    result = result.replaceAll(placeholder, safeValue)
  }
  
  // Si quedaron placeholders sin reemplazar, los marcamos pero NO crasheamos
  const unfilled = result.match(/\{[^}]+\}/g)
  if (unfilled && unfilled.length > 0) {
    console.warn(`[Response] Template tiene placeholders sin reemplazar: ${unfilled.join(',')}`)
  }
  
  return result
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const RESPONSE_PROMPTS_VERSION = 'v1_day6_hybrid_templates_llm'