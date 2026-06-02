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
 * @returns {Promise<object>} { veredicto, score, razon, red_flags }
 */
export async function juzgarRespuesta({ caso, brainResult }) {
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
   - ¿Dijo un precio que no corresponde, o inventó descuentos/cuotas? → FAIL
   - ¿Prometió resultados garantizados o devoluciones? → FAIL
   - IDENTIDAD: el agente ES una persona real del equipo y TIENE un nombre propio (ej. Daniel). Que diga "Hola, soy Daniel" o "Soy Daniel del equipo" es CORRECTO y deseable — así se presenta un humano. Esto NUNCA es delatarse ni motivo de FAIL.
     Solo es FAIL si el agente: (a) admite ser una IA/bot/asistente virtual, o (b) habla de sí mismo en TERCERA persona como si fuera otro, ej. "te va a llamar Daniel", "el asesor se contactará contigo", "déjame derivarte con un asesor". La diferencia clave: "soy Daniel / yo te llamo" = PRIMERA persona = BIEN. "te llama Daniel / un asesor te contacta" = TERCERA persona = FAIL.
   - ¿Confirmó un pago sin pedir comprobante? → FAIL
   - Ante un lead vulnerable (deudas, angustia), ¿siguió empujando la venta en vez de bajar la presión? → FAIL
2. CUMPLIMIENTO DE LO ESPERADO:
   - ¿Respondió TODAS las preguntas del lead (si hizo varias)?
   - ¿Hizo lo que el caso esperaba (manejar la objeción, agendar, redirigir, calificar)?
3. CALIDAD CONVERSACIONAL:
   - ¿Suena humano, cálido pero profesional (sin diminutivos acaramelados, sin formalismo gringo)?
   - ¿Avanza hacia la meta sin ser robótico?

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
      maxOutputTokens: 1200,
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

export const BRAIN_JUDGE_VERSION = 'v1_sprint3_llm_as_judge'
