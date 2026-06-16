// src/perception/perception-schema.js — Hidata v20
// 
// Sistema de 3 niveles de clasificación:
//   1. intents[]           → catálogo cerrado, alto nivel (16 etiquetas)
//   2. intent_specific     → catálogo abierto, granularidad lingüística
//   3. conversational_pattern → patrones que requieren historial
//
// Cambios aquí afectan TODO el motor downstream.

// ════════════════════════════════════════════════════════
// NIVEL 1 — INTENTS DE ALTO NIVEL
// Catálogo cerrado. Perception SIEMPRE devuelve al menos uno.
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
// NIVEL 2 — INTENT GRANULAR LINGÜÍSTICO
// Catálogo abierto. Etiquetas exactas del eval set.
// Convención para nuevas: objecion_X, muletilla_X, señal_X, promesa_X
// ════════════════════════════════════════════════════════
export const VALID_INTENT_SPECIFIC = [
  // Asking price con matiz
  'asking_price_temprano',                 // pregunta precio antes de calificar

  // Requesting call con matiz
  'lead_pide_llamada_first_turn_HOT',      // pide llamada en primer turno = caliente

  // Rejecting / objeciones específicas
  'objecion_precio',                       // está caro, muy alto
  'objecion_decision',                     // tengo que consultarlo
  'objecion_timing_pago',                  // ya gasté en otra cosa
  'objecion_estacional',                   // no es la temporada
  'objecion_validacion',                   // ¿son confiables? ¿RUC?
  'objecion_no_tengo_tiempo',              // no puedo este horario
  'objecion_no_tengo_dinero',              // no tengo plata ahora
  'objecion_consulto_familia',             // tengo que hablar con mi esposa/socio
  'objecion_horario_cascada',              // los sábados no puedo
  'objecion_ya_gaste_en_abono',            // ya invertí en otra cosa primero

  // Delaying específico
  'promesa_diferida',                      // te aviso después, más tarde

  // Señales sutiles
  'señal_compra_disfrazada_de_objecion',   // pregunta como objeción pero quiere comprar

  // Servicios fuera de oferta
  'lead_servicio_no_ofrecido',             // pide broker, comprador directo
  'lead_descalificado_infraestructura'     // no tiene RUC ni nada
]

// ════════════════════════════════════════════════════════
// NIVEL 3 — PATRONES CONVERSACIONALES
// Requieren historial. Perception los DETECTA pero State los CONFIRMA.
// ════════════════════════════════════════════════════════
export const VALID_CONVERSATIONAL_PATTERNS = [
  'lead_es_proxy',                          // habla por otro (hijo, esposa)
  'posible_pretencion',                     // habla bonito sin sustento
  'patron_sobre_afirmacion_sin_profundidad', // dice todo sí sí sin profundidad
  'lead_responde_todo_bonito',              // espejo del anterior
  'lead_revela_proyectos_multiples',        // dispersión entre productos
  'lead_consulta_terceros',                 // siempre consulta antes de decidir
  'lead_pretencioso',                       // performativo
  'lead_curioso_universal',                 // pregunta de todo, no compra nada
  'lead_perfil_ambiguo'                     // no encaja en ningún perfil claro
]

// ════════════════════════════════════════════════════════
// MAP — qué parent (Nivel 1) corresponde a cada granular (Nivel 2)
// Útil para fallback cuando intent_specific no se reconoce
// ════════════════════════════════════════════════════════
export const INTENT_SPECIFIC_TO_PARENT = {
  'asking_price_temprano':                'asking_price',
  'lead_pide_llamada_first_turn_HOT':     'requesting_call',
  
  'objecion_precio':                      'rejecting',
  'objecion_decision':                    'delaying',
  'objecion_timing_pago':                 'delaying',
  'objecion_estacional':                  'delaying',
  'objecion_validacion':                  'asking_question',
  'objecion_no_tengo_tiempo':             'delaying',
  'objecion_no_tengo_dinero':             'delaying',
  'objecion_consulto_familia':            'delaying',
  'objecion_horario_cascada':             'delaying',
  'objecion_ya_gaste_en_abono':           'delaying',
  
  'promesa_diferida':                     'delaying',
  
  'señal_compra_disfrazada_de_objecion':  'asking_question',
  
  'lead_servicio_no_ofrecido':            'asking_question',
  'lead_descalificado_infraestructura':   'providing_info'
}

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
    
    // ─── Nivel 1: intents alto nivel (siempre presente) ───
    intents: {
      type: 'array',
      items: {
        type: 'string',
        enum: VALID_INTENTS
      },
      minItems: 1,
      description: 'Array ordenado de intents de alto nivel. Primero el más urgente o accionable.'
    },
    
    intent_confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Qué tan seguro estás del primer intent del array'
    },
    
    // ─── Nivel 2: intent granular (opcional) ───
    intent_specific: {
      type: 'string',
      nullable: true,
      description: 'Etiqueta granular del catálogo VALID_INTENT_SPECIFIC si aplica. null si solo aplica el alto nivel.'
    },
    
    // ─── Nivel 3: patrón conversacional (opcional) ───
    conversational_pattern: {
      type: 'object',
      nullable: true,
      properties: {
        pattern: {
          type: 'string',
          description: 'Etiqueta del catálogo VALID_CONVERSATIONAL_PATTERNS'
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confianza del patrón. Baja con 1 mensaje, alta con 5+ turnos.'
        },
        needs_more_turns: {
          type: 'boolean',
          description: 'true si Perception detectó hint pero necesita más turnos para confirmar'
        }
      },
      required: ['pattern', 'confidence', 'needs_more_turns']
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
        empresa:      { type: 'boolean', nullable: true, description: 'true si tiene empresa, false si independiente, null si no mencionó' },
        experiencia:  { type: 'boolean', nullable: true, description: 'true si tiene experiencia exportando, false si recién empieza, null si no mencionó' }
      },
      required: ['nombre', 'producto', 'cantidad', 'pais_destino', 'fecha_hora', 'monto', 'empresa', 'experiencia']
    },
    
    // ─── Sentiment ───
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
          description: 'Objeción explícita si la hay (puede repetir intent_specific o ser texto libre)'
        },
        urgency: {
          type: 'string',
          enum: VALID_URGENCY,
          description: 'Urgencia percibida'
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
          description: 'El lead reconoce explícitamente que regresa después de tiempo'
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
          description: 'Detectaste inconsistencia clara con turnos previos'
        }
      },
      required: ['is_muletilla', 'is_returning_lead', 'is_quechua_or_other', 'is_media', 'is_lying_signal']
    },
    
    // ─── Razonamiento (debug + auditoría) ───
    rationale: {
      type: 'string',
      description: 'Una línea explicando por qué clasificaste así. Crítico para auditoría.'
    }
  },
  
  required: ['intents', 'intent_confidence', 'intent_specific', 'conversational_pattern', 
             'entities', 'sentiment', 'signals', 'rationale']
}

// ════════════════════════════════════════════════════════
// VALIDADOR DEFENSIVO
// ════════════════════════════════════════════════════════
export function validatePerceptionOutput(output) {
  const errors = []
  
  if (!output) {
    return { valid: false, errors: ['Output is null or undefined'] }
  }
  
  // Nivel 1: intents
  if (!Array.isArray(output.intents) || output.intents.length === 0) {
    errors.push('intents must be non-empty array')
  } else {
    const invalid = output.intents.filter(i => !VALID_INTENTS.includes(i))
    if (invalid.length > 0) {
      errors.push(`Invalid intents: ${invalid.join(', ')}`)
    }
  }
  
  if (typeof output.intent_confidence !== 'number' || 
      output.intent_confidence < 0 || output.intent_confidence > 1) {
    errors.push('intent_confidence must be number between 0 and 1')
  }
  
  // Nivel 2: intent_specific (puede ser null)
  if (output.intent_specific !== null && output.intent_specific !== undefined) {
    if (!VALID_INTENT_SPECIFIC.includes(output.intent_specific)) {
      errors.push(`Invalid intent_specific: ${output.intent_specific}. Use null if no granular fit.`)
    }
  }
  
  // Nivel 3: conversational_pattern (puede ser null)
  if (output.conversational_pattern !== null && output.conversational_pattern !== undefined) {
    const cp = output.conversational_pattern
    if (!VALID_CONVERSATIONAL_PATTERNS.includes(cp.pattern)) {
      errors.push(`Invalid conversational_pattern.pattern: ${cp.pattern}`)
    }
    if (typeof cp.confidence !== 'number' || cp.confidence < 0 || cp.confidence > 1) {
      errors.push('conversational_pattern.confidence must be number between 0 and 1')
    }
    if (typeof cp.needs_more_turns !== 'boolean') {
      errors.push('conversational_pattern.needs_more_turns must be boolean')
    }
  }
  
  // Entities
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
        output.sentiment.confidence < 0 || output.sentiment.confidence > 1) {
      errors.push('sentiment.confidence must be number between 0 and 1')
    }
  }
  
  // Signals
  if (!output.signals) {
    errors.push('signals is required')
  } else {
    const required = ['is_muletilla', 'is_returning_lead', 'is_quechua_or_other',
                      'is_media', 'is_lying_signal']
    for (const flag of required) {
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
// FALLBACK — output cuando todo falla
// ════════════════════════════════════════════════════════
export function fallbackPerceptionOutput(reason = 'unknown_error') {
  return {
    intents: ['confused'],
    intent_confidence: 0.0,
    intent_specific: null,
    conversational_pattern: null,
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

// ════════════════════════════════════════════════════════
// HELPER — para el comparador de evals (Día 2 - Paso 6)
// Determina si una etiqueta del dataset es de alto nivel o granular
// ════════════════════════════════════════════════════════
export function classifyExpectedIntent(expected_intent) {
  if (VALID_INTENTS.includes(expected_intent)) {
    return 'level_1'    // alto nivel — buscar en intents[]
  }
  if (VALID_INTENT_SPECIFIC.includes(expected_intent)) {
    return 'level_2'    // granular — comparar con intent_specific
  }
  if (VALID_CONVERSATIONAL_PATTERNS.includes(expected_intent)) {
    return 'level_3'    // patrón — comparar con conversational_pattern.pattern
  }
  return 'unknown'      // etiqueta no reconocida
}
