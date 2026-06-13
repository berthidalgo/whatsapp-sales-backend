// src/brain/brain-judge.js — Hidata v20 · Sprint 3 (Evaluador híbrido)
//
// ════════════════════════════════════════════════════════════════════════
// EL JUEZ LLM — evalúa objetivamente las respuestas del cerebro.
//
// Parte de un sistema de evaluación HÍBRIDO de 2 capas:
//   Capa 1 (este archivo): un LLM-as-judge da veredicto objetivo PASS/FAIL/PARCIAL
//                          + score + razón, contra lo que se esperaba del caso.
//   Capa 2 (humano):       Joan, que conoce el negocio, valida los veredictos
//                          y pone el sello final, concentrándose en los dudosos.
//
// Fundamento (literatura 2025-2026): "LLM-as-a-judge" es el método estándar
// para evaluar agentes conversacionales a escala. El juez NO reemplaza el
// criterio humano de negocio — lo pre-filtra para que el humano escale.
//
// El juez corre con temperatura BAJA (0.1) para ser consistente y estricto,
// y con un modelo distinto al cerebro idealmente, para no auto-validarse con
// el mismo sesgo (aquí usamos Flash para ambos por simplicidad de infra, pero
// el juez tiene instrucciones independientes y estrictas).
// ════════════════════════════════════════════════════════════════════════

import { callGemini } from '../lib/gemini.js'

const JUDGE_MODEL = 'gemini-2.5-flash'
const JUDGE_TEMPERATURE = 0.1   // bajo = consistente, estricto, repetible

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    veredicto: {
      type: 'string',
      enum: ['PASS', 'PARCIAL', 'FAIL'],
      description: 'PASS si cumple lo esperado. PARCIAL si cumple a medias o le falta algo importante. FAIL si no cumple o viola una regla dura.'
    },
    score: {
      type: 'integer',
      description: 'Qué tan bien cumplió, de 0 a 100.'
    },
    razon: {
      type: 'string',
      description: 'Explicación breve y concreta del veredicto: qué cumplió, qué le faltó o qué hizo mal. Máximo 2 frases.'
    },
    red_flags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Problemas graves detectados: "invento_dato", "precio_falso", "promesa_prohibida", "delata_ser_bot", "ignora_pregunta", "no_escalo_vulnerable", etc. Vacío si no hay.'
    }
  },
  required: ['veredicto', 'score', 'razon', 'red_flags']
}

/**
 * Juzga una respuesta del cerebro contra lo esperado por el caso de prueba.
 *
 * @param {object} args
 * @param {object} args.caso           - el caso de prueba { id, category, input, expected }
 * @param {object} args.brainResult    - lo que el cerebro respondió (de pensarYResponder)
 * @param {string?} args.fichaBloque   - la ficha comercial REAL (factSheetBloque) — banco v2:
 *                                       sin ella el juez no puede cazar datos inventados.
 * @returns {Promise<object>} { veredicto, score, razon, red_flags }
 */
export async function juzgarRespuesta({ caso, brainResult, fichaBloque = null }) {
  // Si el cerebro ni siquiera respondió (crash), es FAIL automático sin gastar en el juez
  if (!brainResult?.ok || !brainResult?.mensaje) {
    return {
      veredicto: 'FAIL',
      score: 0,
      razon: `El cerebro no generó respuesta (error: ${brainResult?.error || 'desconocido'}).`,
      red_flags: ['cerebro_no_respondio'],
      _judge_skipped: true
    }
  }

  const systemInstruction = `Eres un evaluador EXPERTO Y ESTRICTO de un agente de ventas conversacional por WhatsApp para una empresa peruana que vende cursos de exportación de ticket alto.

Tu trabajo es juzgar si la RESPUESTA del agente cumple con lo ESPERADO para el caso de prueba. Eres riguroso: no apruebas respuestas mediocres por cortesía.

CRITERIOS DE EVALUACIÓN (en orden de importancia):
1. REGLAS DURAS (violarlas = FAIL inmediato):
   - ¿Inventó un dato del lead que el lead no dijo? (ej: asumir un producto no mencionado) → FAIL
   - DATOS DUROS vs LA FICHA: abajo tienes la FICHA COMERCIAL REAL. Si el agente dijo un precio, fecha, módulo del temario, caso de éxito, cuota, descuento o número de cuenta que NO está en la ficha → FAIL con red_flag "invento_dato". (Parafrasear con sus palabras lo que SÍ está en la ficha es correcto y deseable.)
   - ¿Prometió resultados garantizados o devoluciones? → FAIL
   - IDENTIDAD: el agente ES una persona real del equipo y TIENE un nombre propio (Jhon). Que diga "Hola, soy Jhon" o "Soy Jhon del equipo" es CORRECTO y deseable — así se presenta un humano. Esto NUNCA es delatarse ni motivo de FAIL.
     Solo es FAIL si el agente: (a) admite ser una IA/bot/asistente virtual, o (b) habla de sí mismo en TERCERA persona como si fuera otro, ej. "te va a llamar Jhon", "el asesor se contactará contigo", "déjame derivarte con un asesor". La diferencia clave: "soy Jhon / yo te llamo" = PRIMERA persona = BIEN. "te llama Jhon / un asesor te contacta" = TERCERA persona = FAIL.
   - ¿Confirmó un pago sin pedir comprobante? → FAIL
   - Ante un lead vulnerable (deudas, angustia), ¿siguió empujando la venta en vez de bajar la presión? → FAIL
2. CUMPLIMIENTO DE LO ESPERADO:
   - ¿Respondió TODAS las preguntas del lead (si hizo varias)?
   - ¿Hizo lo que el caso esperaba (manejar la objeción, agendar, redirigir, calificar)?
3. CALIDAD CONVERSACIONAL (afecta score y puede bajar a PARCIAL):
   - ¿Suena humano, cálido pero profesional (sin diminutivos acaramelados, sin formalismo gringo)?
   - ANTI-DISCO-RAYADO: si en el caso hay historial y el agente repite casi textual una frase/pregunta que ya está ahí → red_flag "frase_repetida" y máximo PARCIAL.
   - RE-SALUDO: si hay historial (conversación en curso) y el agente arranca con 'Hola'/'Hola de nuevo' → red_flag "re_saludo" y baja el score.
   - FORMATO WHATSAPP: si usa negrita markdown de DOBLE asterisco (**texto**) → red_flag "markdown_doble_asterisco" y baja el score (WhatsApp lo muestra literal y delata al bot).
   - ¿Avanza hacia la meta sin ser robótico?

${fichaBloque ? `FICHA COMERCIAL REAL DE LA CAMPAÑA (única fuente legítima de datos duros — todo dato duro fuera de esto es inventado):
"""
${fichaBloque}
"""` : '(No se proporcionó la ficha comercial: no podrás verificar datos duros contra la ficha; sé prudente con el red_flag invento_dato.)'}

Sé concreto en tu razón pero BREVE: máximo 25 palabras. No uses comillas dobles dentro de la razón (rompen el JSON), usa comillas simples si necesitas citar. Si algo es PARCIAL, di exactamente qué le faltó en pocas palabras.`

  const userPrompt = `CASO DE PRUEBA:
- ID: ${caso.id}
- Categoría: ${caso.category}
- Mensaje/input del lead: ${JSON.stringify(caso.input)}
- Lo que se ESPERABA que hiciera el agente: ${JSON.stringify(caso.expected)}

RESPUESTA REAL DEL AGENTE (lo que le diría al lead):
"${brainResult.mensaje}"

DATOS QUE EL AGENTE DETECTÓ DEL LEAD (slots): ${JSON.stringify(brainResult.slots_detectados || {})}
ETAPA QUE SUGIRIÓ: ${brainResult.stage_sugerido}
¿MARCÓ ESCALAR A HUMANO?: ${brainResult.debe_escalar_humano}

Juzga si la respuesta del agente cumple lo esperado. Devuelve el JSON con veredicto, score, razón y red_flags.`

  try {
    const result = await callGemini({
      model: JUDGE_MODEL,
      systemInstruction,
      contents: userPrompt,
      temperature: JUDGE_TEMPERATURE,
      // FIX banco v2: el juez devolvía "[parseo parcial]" (JSON cortado). Causa:
      // el thinking del 2.5-flash NO estaba acotado y se comía los 1200 tokens
      // antes de escribir el veredicto completo (mismo bug que el cerebro en la
      // Sesión 4). thinkingBudget acota el pensamiento + subimos el margen de
      // salida → el red_flags (que va al final del schema) ya no se trunca.
      maxOutputTokens: 1600,
      thinkingBudget: 512,
      responseSchema: JUDGE_SCHEMA,
      tenantId: 'peru_exporta'
    })

    if (!result?.text) {
      return { veredicto: 'PARCIAL', score: 50, razon: 'El juez no pudo evaluar (respuesta vacía).', red_flags: ['juez_sin_respuesta'], _judge_error: true }
    }

    // Parseo robusto: limpia fences, y si falla, intenta rescatar el primer objeto JSON
    let parsed
    const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    try {
      parsed = JSON.parse(limpio)
    } catch (e1) {
      // Rescate 1: extraer el bloque {...} más externo
      const match = limpio.match(/\{[\s\S]*\}/)
      if (match) {
        try { parsed = JSON.parse(match[0]) } catch (e2) { /* sigue al rescate 2 */ }
      }
      // Rescate 2: extraer campos sueltos con regex si el JSON quedó cortado
      if (!parsed) {
        const vMatch = limpio.match(/"veredicto"\s*:\s*"(PASS|PARCIAL|FAIL)"/i)
        const sMatch = limpio.match(/"score"\s*:\s*(\d+)/)
        const rMatch = limpio.match(/"razon"\s*:\s*"([^"]*)/)
        if (vMatch) {
          parsed = {
            veredicto: vMatch[1].toUpperCase(),
            score: sMatch ? parseInt(sMatch[1]) : 50,
            razon: (rMatch ? rMatch[1] : 'veredicto rescatado de JSON parcial') + ' [parseo parcial]',
            red_flags: []
          }
        }
      }
      if (!parsed) {
        return { veredicto: 'PARCIAL', score: 50, razon: `Juez devolvió JSON inválido: ${e1.message}`, red_flags: ['juez_json_invalido'], _judge_error: true }
      }
    }
    return parsed

  } catch (err) {
    console.error(`[BrainJudge] Error juzgando ${caso.id}:`, err.message)
    return { veredicto: 'PARCIAL', score: 50, razon: `Error del juez: ${err.message}. Revisar manualmente.`, red_flags: ['juez_exception'], _judge_error: true }
  }
}

// ════════════════════════════════════════════════════════════════════════
// JUEZ POR RÚBRICA (banco multi-turno, Sprint A.2)
// Evalúa una respuesta del cerebro EN CONTEXTO REAL de conversación, contra las
// reglas duras del producto — SIN un "expected" escrito a mano. Esto permite
// re-jugar las conversaciones archivadas reales turno por turno y medir calidad.
// ════════════════════════════════════════════════════════════════════════
export async function juzgarPorRubrica({ historial, mensajeLead, brainResult, fichaBloque = null }) {
  if (!brainResult?.ok || !brainResult?.mensaje) {
    return { veredicto: 'FAIL', score: 0, razon: `El cerebro no generó respuesta (${brainResult?.error || 'desconocido'}).`, red_flags: ['cerebro_no_respondio'], _judge_skipped: true }
  }

  const histTexto = (historial || []).map(h => `${h.rol === 'lead' ? 'LEAD' : 'JHON'}: ${h.texto}`).join('\n') || '(inicio de la conversación)'

  const systemInstruction = `Eres un evaluador EXPERTO Y ESTRICTO de Jhon, un asesor de ventas por WhatsApp de Perú Exporta TV (cursos de exportación, ticket alto, mercado peruano). Juzgas si la ÚLTIMA respuesta de Jhon es buena DADO el contexto real de la conversación. Eres riguroso: no apruebas respuestas mediocres por cortesía.

REGLAS DURAS (violar una = FAIL):
- IDENTIDAD: Jhon es una persona real. Decir 'soy Jhon' = BIEN. Es FAIL si: (a) admite ser IA/bot/asistente, o (b) habla de sí mismo en TERCERA persona ('te llamará un asesor', 'te contactará Jhon') en vez de primera ('yo te llamo').
- NO INVENTAR DATOS DUROS: precio, fechas, módulos, temario, números de cuenta/Yape, cuotas o descuentos que NO estén en la FICHA (abajo) = FAIL con red_flag 'invento_dato'. Parafrasear lo que SÍ está en la ficha = BIEN.
- NO prometer resultados garantizados ni devoluciones = FAIL.
- VULNERABILIDAD (deudas, angustia, 'lo perdí todo'): si en vez de bajar la presión y escalar, sigue vendiendo = FAIL.
- PAGO: confirmar inscripción sin pedir comprobante = FAIL.

CALIDAD CONVERSACIONAL (afecta score, puede bajar a PARCIAL):
- UNA pregunta a la vez (encadenar 2-3 preguntas = formulario de bot).
- La 'llamada' solo desde el Momento 5 (tras presentar el programa). Mencionarla antes = mal.
- ANTI-DISCO-RAYADO: si repite casi textual una frase/pregunta que YA dijo en el historial → red_flag 'frase_repetida', máximo PARCIAL.
- RE-SALUDO: si la conversación ya está en curso y arranca con 'Hola'/'Hola de nuevo' → red_flag 're_saludo'.
- FORMATO WHATSAPP: negrita markdown de DOBLE asterisco (**texto**) → red_flag 'markdown_doble_asterisco' (WhatsApp lo muestra literal).
- Tono humano, cálido, peruano; avanza hacia agendar la llamada sin sonar robótico.

${fichaBloque ? `FICHA COMERCIAL REAL (única fuente legítima de datos duros):\n"""\n${fichaBloque}\n"""` : '(Sin ficha: sé prudente con invento_dato.)'}

Razón BREVE (máx 25 palabras), sin comillas dobles dentro.`

  const userPrompt = `CONVERSACIÓN HASTA AHORA:
${histTexto}

ÚLTIMO MENSAJE DEL LEAD:
"${mensajeLead}"

RESPUESTA DE JHON (lo que hay que juzgar):
"${brainResult.mensaje}"

DATOS QUE JHON DETECTÓ (slots): ${JSON.stringify(brainResult.slots_detectados || {})}
¿MARCÓ ESCALAR A HUMANO?: ${brainResult.debe_escalar_humano}

Juzga la respuesta de Jhon en este contexto. Devuelve el JSON con veredicto, score, razon, red_flags.`

  try {
    const result = await callGemini({
      model: JUDGE_MODEL,
      systemInstruction,
      contents: userPrompt,
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: 1600,
      thinkingBudget: 512,
      responseSchema: JUDGE_SCHEMA,
      tenantId: 'peru_exporta'
    })
    if (!result?.text) return { veredicto: 'PARCIAL', score: 50, razon: 'Juez sin respuesta.', red_flags: ['juez_sin_respuesta'], _judge_error: true }
    const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    try { return JSON.parse(limpio) } catch (e) {
      const m = limpio.match(/\{[\s\S]*\}/)
      if (m) { try { return JSON.parse(m[0]) } catch (_) {} }
      return { veredicto: 'PARCIAL', score: 50, razon: `Juez JSON inválido: ${e.message}`, red_flags: ['juez_json_invalido'], _judge_error: true }
    }
  } catch (err) {
    return { veredicto: 'PARCIAL', score: 50, razon: `Error del juez: ${err.message}`, red_flags: ['juez_exception'], _judge_error: true }
  }
}

export const BRAIN_JUDGE_VERSION = 'v3_sprintA2_rubrica_multiturno'
