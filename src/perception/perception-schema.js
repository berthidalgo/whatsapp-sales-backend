// src/perception/perception-schema.js — Hidata v20
// Schema JSON estricto que Gemini 2.5 Flash debe respetar al responder
// 
// Esta es la fuente de verdad del contrato Perception → State
// Cambios aquí afectan TODO el motor downstream

// ════════════════════════════════════════════════════════
// INTENTS — qué quiere el lead en este turno
// ════════════════════════════════════════════════════════
export const VALID_INTENTS = [
  // Principales (12)
  'greeting',                    // hola, buenas, qué tal
  'providing_info',              // me llamo X, exporto Y, tengo Z
  'asking_question',             // pregunta general no de precio
  'asking_price',                // cuánto cuesta, precio, costo
  'ready_to_pay',                // ya yapeo, dame cuenta, pago ahora
  'requesting_call',             // llámame, quiero llamada
  'confirming_schedule',         // mañana 4pm, hoy 8, sí dale
  'rejecting',                   // no me interesa, déjalo así
  'delaying',                    // después, más tarde, te aviso
  'confused',                    // no entiendo, qué es eso
  'paid',                        // ya pagué, transferí, yapeé
  'off_topic',                   // hablando de otra cosa

  // Auxiliares (4)
  'muletilla_aprobacion_suave',  // ya pe causa (no es afirmación)
  'muletilla_pregunta',          // no?, sí?, cierto?
  'returning_lead_acknowledge',  // hola disculpa la demora, regreso
  'media_received'               // imagen, audio, video, sticker
]

// ════════════════════════════════════════════════════════
// SENTIMENT — temperatura del lead
// ════════════════════════════════════════════════════════
export const VALID_TEMPERATURES = ['hot', 'warm', 'cold']
export const VALID_URGENCY = ['low', 'medium', 'high']

// ════════════════════════════════════════════════════════
// JSON SCHEMA OFICIAL — Gemini structured output
// ════════════════════════════════════════════════════════
export const perceptionResponseSchema = {
  type: 'object',
  properties: {
    
    // ─── Intents detectados (array ordenado por urgencia) ───
    intents: {
      type: 'array',
      items: {
        type: 'string',
        enum: VALID_INTENTS
      },
      minItems: 1,
      description: 'Array ordenado de intents detectados. Primero el más urgente o accionable.'
    },
    
    // ─── Entities extraídas del mensaje ───
    entities: {
      type: 'object',
      properties: {
        nombre:       { type: 'string', nullable: true, description: 'Nombre propio del lead si lo dijo' },
        producto:     { type: 'string', nullable: true, description: 'Producto a exportar (palta, café, mango, textil, etc)' },
        cantidad:     { type: 'string', nullable: true, description: 'Volumen mencionado: "1 contenedor", "500 kilos", "5 toneladas"' },
        pais_destino: { type: 'string', nullable: true, description: 'País destino de exportación' },
        fecha_hora:   { type: 'string', nullable: true, description: 'Fecha/hora mencionada en formato natural: "mañana 4pm", "hoy noche"' },
        monto:        { type: 'string', nullable: true, description: 'Monto mencionado: "S/100", "$500", "1500 soles"' },
        empresa:      { type: 'boolean', nullable: true, description: 'true si dijo que tiene empresa, false si dijo que es independiente, null si no mencionó' },
        experiencia:  { type: 'boolean', nullable: true, description: 'true si tiene experiencia exportando, false si recién empieza, null si no mencionó' }
      },
      required: ['nombre', 'producto', 'cantidad', 'pais_destino', 'fecha_hora', 'monto', 'empresa', 'experiencia']
    },
    
    // ─── Sentiment del lead ───
    sentiment: {
      type: 'object',
      properties: {
        temperature: {
          type: 'string',
          enum: VALID_TEMPERATURES,
          description: 'hot=listo para comprar, warm=interesado pero dudoso, cold=poco interés'
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Qué tan seguro estás de la temperatura asignada'
        },
        objection: {
          type: 'string',
          nullable: true,
          description: 'Objeción explícita si la hay: "está caro", "consulto con socio", "no tengo tiempo"'
        },
        urgency: {
          type: 'string',
          enum: VALID_URGENCY,
          description: 'Urgencia percibida del lead'
        }
      },
      required: ['temperature', 'confidence', 'objection', 'urgency']
    },
    
    // ─── Signals especiales ───
    signals: {
      type: 'object',
      properties: {
        is_muletilla: {
          type: 'boolean',
          description: 'Es muletilla peruana sin contenido real (ya pe causa, no?, ya estuvo)'
        },
        is_returning_lead: {
          type: 'boolean',
          description: 'El lead reconoce que regresa después de tiempo. SOLO si el lead lo dice explícito.'
        },
        is_quechua_or_other: {
          type: 'boolean',
          description: 'Mensaje incluye palabras quechua o idioma no español'
        },
        is_media: {
          type: 'boolean',
          description: 'Mensaje contiene imagen, audio, video o sticker'
        },
        is_lying_signal: {
          type: 'boolean',
          description: 'Detectaste inconsistencia clara: dijo algo y antes dijo lo contrario'
        }
      },
      required: ['is_muletilla', 'is_returning_lead', 'is_quechua_or_other', 'is_media', 'is_lying_signal']
    },
    
    // ─── Razonamiento (debug, también va a turn_trace) ───
    rationale: {
      type: 'string',
      description: 'Una línea explicando por qué clasificaste así. Crítico para auditoría.'
    }
  },
  
  required: ['intents', 'entities', 'sentiment', 'signals', 'rationale']
}

// ════════════════════════════════════════════════════════
// VALIDADOR DEFENSIVO — para verificar output de Gemini
// ════════════════════════════════════════════════════════
export function validatePerceptionOutput(output) {
  const errors = []
  
  // Validación de estructura mínima
  if (!output) {
    return { valid: false, errors: ['Output is null or undefined'] }
  }
  
  // Intents
  if (!Array.isArray(output.intents) || output.intents.length === 0) {
    errors.push('intents must be non-empty array')
  } else {
    const invalidIntents = output.intents.filter(i => !VALID_INTENTS.includes(i))
    if (invalidIntents.length > 0) {
      errors.push(`Invalid intents: ${invalidIntents.join(', ')}`)
    }
  }
  
  // Entities (debe existir como objeto)
  if (!output.entities || typeof output.entities !== 'object') {
    errors.push('entities must be an object')
  }
  
  // Sentiment
  if (!output.sentiment) {
    errors.push('sentiment is required')
  } else {
    if (!VALID_TEMPERATURES.includes(output.sentiment.temperature)) {
      errors.push(`Invalid temperature: ${output.sentiment.temperature}`)
    }
    if (!VALID_URGENCY.includes(output.sentiment.urgency)) {
      errors.push(`Invalid urgency: ${output.sentiment.urgency}`)
    }
    if (typeof output.sentiment.confidence !== 'number' || 
        output.sentiment.confidence < 0 || 
        output.sentiment.confidence > 1) {
      errors.push('confidence must be number between 0 and 1')
    }
  }
  
  // Signals
  if (!output.signals) {
    errors.push('signals is required')
  } else {
    const requiredFlags = [
      'is_muletilla', 'is_returning_lead', 'is_quechua_or_other',
      'is_media', 'is_lying_signal'
    ]
    for (const flag of requiredFlags) {
      if (typeof output.signals[flag] !== 'boolean') {
        errors.push(`signals.${flag} must be boolean`)
      }
    }
  }
  
  // Rationale
  if (typeof output.rationale !== 'string' || output.rationale.length < 5) {
    errors.push('rationale must be string with explanation')
  }
  
  return {
    valid: errors.length === 0,
    errors
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Output de fallback en caso de error catastrófico
// ════════════════════════════════════════════════════════
export function fallbackPerceptionOutput(reason = 'unknown_error') {
  return {
    intents: ['confused'],
    entities: {
      nombre: null, producto: null, cantidad: null,
      pais_destino: null, fecha_hora: null, monto: null,
      empresa: null, experiencia: null
    },
    sentiment: {
      temperature: 'warm',
      confidence: 0.0,
      objection: null,
      urgency: 'low'
    },
    signals: {
      is_muletilla: false,
      is_returning_lead: false,
      is_quechua_or_other: false,
      is_media: false,
      is_lying_signal: false
    },
    rationale: `Fallback activado: ${reason}`,
    _is_fallback: true
  }
}