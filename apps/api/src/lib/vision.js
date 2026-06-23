// src/lib/vision.js — Hidata v20 · Fase B.1+ (Etapa 2: leer comprobantes)
//
// HÍBRIDO código + IA (decisión de Joan, 2026-06-13): el FILTRO barato lo hace el
// código (solo se llama a esto cuando la imagen llega en contexto de pago — ver
// event-router); la COMPRENSIÓN del comprobante (clasificar voucher vs troll +
// extraer datos de CUALQUIER formato — Yape/Plin/BCP/Interbank/BBVA sin un parser
// por banco) la hace Gemini multimodal. Costo: ~258 tokens (≈$0.0004) por imagen,
// y solo en las que pasan el filtro → despreciable a volumen piloto.
//
// Gemini ya es multimodal: se le pasa la imagen como parte `inlineData` (base64).
// Usa el MISMO modelo/location del cerebro (BRAIN_* env) → en prod es 3.5 global.

import { callGemini } from './gemini.js'

const VISION_SCHEMA = {
  type: 'object',
  properties: {
    es_comprobante: {
      type: 'boolean',
      description: 'true SOLO si la imagen es un comprobante/constancia de pago real (Yape, Plin, transferencia, depósito, voucher bancario). false si es una foto cualquiera, meme, captura no relacionada, screenshot de otra cosa, etc.'
    },
    metodo: { type: 'string', description: 'Medio de pago detectado: "Yape", "Plin", "Transferencia", "Depósito", "Tarjeta", o "" si no se distingue.' },
    monto: { type: 'string', description: 'Monto del pago tal cual aparece, con moneda. Ej: "S/ 1,500.00". "" si no se ve.' },
    fecha: { type: 'string', description: 'Fecha (y hora si aparece) de la operación tal cual. "" si no se ve.' },
    numero_operacion: { type: 'string', description: 'Código/número de operación o constancia. "" si no aparece.' },
    nombre_origen: { type: 'string', description: 'Nombre de quien ENVÍA el pago, si aparece. "" si no.' },
    nombre_destino: { type: 'string', description: 'Nombre de quien RECIBE el pago (titular de la cuenta destino), si aparece. Importante para validar que el pago fue a la cuenta correcta. "" si no.' },
    resumen: { type: 'string', description: 'Resumen en UNA línea para el vendedor. Si es comprobante: "Yape S/1,500 a Cesar Laines, op 12345678, 13/jun". Si NO es comprobante: describe brevemente qué es la imagen ("parece una foto de un producto", "meme", etc).' }
  },
  required: ['es_comprobante', 'resumen']
}

/**
 * Lee una imagen y, si es un comprobante de pago, extrae sus datos.
 * @param {object} args
 * @param {string} args.base64    - imagen en base64 (sin el prefijo data:)
 * @param {string} args.mimeType  - ej "image/jpeg", "image/png"
 * @returns {Promise<{ ok, esComprobante, datos, resumen, error? }>}
 */
export async function leerComprobante({ base64, mimeType = 'image/jpeg' }) {
  if (!base64 || typeof base64 !== 'string') {
    return { ok: false, esComprobante: false, resumen: '(sin imagen)', error: 'base64_vacio' }
  }

  const systemInstruction = `Eres un validador EXPERTO de comprobantes de pago peruanos (Yape, Plin, transferencias BCP/Interbank/BBVA, depósitos). Te dan una imagen que un lead envió por WhatsApp tras decir que pagó un curso. Tu trabajo: (1) decidir si REALMENTE es un comprobante de pago o es otra cosa (foto cualquiera, meme, captura no relacionada), y (2) si lo es, extraer los datos clave para que el vendedor humano valide el pago. NO inventes datos: si un campo no se ve en la imagen, déjalo en "". Sé literal con lo que la imagen muestra.`

  // contents multimodal: parte de texto + parte de imagen (inlineData).
  const contents = [{
    role: 'user',
    parts: [
      { text: 'Analiza esta imagen. ¿Es un comprobante de pago? Si sí, extrae monto, fecha, número de operación, método y nombres. Devuelve el JSON.' },
      { inlineData: { mimeType, data: base64 } }
    ]
  }]

  try {
    const result = await callGemini({
      model: process.env.BRAIN_MODEL || 'gemini-2.5-flash',
      location: process.env.BRAIN_LOCATION || null,
      thinkingLevel: process.env.BRAIN_THINKING_LEVEL || null,
      systemInstruction,
      contents,
      temperature: 0.1,            // determinista: extracción, no creatividad
      maxOutputTokens: 1200,
      responseSchema: VISION_SCHEMA,
      tenantId: 'peru_exporta'
    })

    if (!result?.text) {
      return { ok: false, esComprobante: false, resumen: '(no se pudo leer la imagen)', error: 'sin_texto' }
    }

    let parsed
    const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    try { parsed = JSON.parse(limpio) } catch (e) {
      const m = limpio.match(/\{[\s\S]*\}/)
      if (m) { try { parsed = JSON.parse(m[0]) } catch (_) {} }
    }
    if (!parsed) {
      return { ok: false, esComprobante: false, resumen: '(respuesta ilegible de la IA)', error: 'json_invalido' }
    }

    return {
      ok: true,
      esComprobante: parsed.es_comprobante === true,
      datos: {
        metodo: parsed.metodo || '',
        monto: parsed.monto || '',
        fecha: parsed.fecha || '',
        numeroOperacion: parsed.numero_operacion || '',
        nombreOrigen: parsed.nombre_origen || '',
        nombreDestino: parsed.nombre_destino || ''
      },
      resumen: parsed.resumen || '',
      cost: result?.usage ? result.usage : null
    }
  } catch (err) {
    console.error('[Vision] Error leyendo comprobante:', err.message)
    return { ok: false, esComprobante: false, resumen: '(error al procesar la imagen)', error: err.message }
  }
}

// ════════════════════════════════════════════════════════════════════════
// IMAGEN GENERAL (no-comprobante) — el lead manda una foto cualquiera en
// cualquier etapa: su producto, una captura, un meme, lo que sea. El código puro
// no puede entender píxeles → Gemini la mira, la clasifica y genera la respuesta
// natural de Jhon (reconduce a calificar). Una sola llamada hace todo.
// ════════════════════════════════════════════════════════════════════════
const IMAGEN_SCHEMA = {
  type: 'object',
  properties: {
    categoria: {
      type: 'string',
      enum: ['producto_exportable', 'documento', 'captura_pantalla', 'persona', 'meme_troll', 'otro'],
      description: 'Qué es la imagen. "producto_exportable" si muestra un producto que el lead podría exportar (palta, café, textil, artesanía, etc.).'
    },
    descripcion: { type: 'string', description: 'Descripción factual breve de la imagen, para registro interno. Ej: "foto de paltas en una caja". NO inventes.' },
    respuesta: { type: 'string', description: 'La respuesta de Jhon al lead, en WhatsApp peruano cálido, CORTA (1-3 líneas). Si es su producto, reacciona con entusiasmo genuino y reconduce a conocerlo (¿ya exporta? ¿qué producto?). Si es algo no relacionado o troll, reconduce con cordialidad al tema de exportar. NO uses ** (negrita markdown). NO inventes datos del programa.' }
  },
  required: ['categoria', 'descripcion', 'respuesta']
}

/**
 * Lee una imagen NO-comprobante y genera la respuesta natural de Jhon.
 * @returns {Promise<{ ok, categoria, descripcion, respuesta, error? }>}
 */
export async function responderAImagen({ base64, mimeType = 'image/jpeg', nombreLead = null, stage = null }) {
  if (!base64) return { ok: false, error: 'base64_vacio' }

  const nombreTxt = nombreLead ? ` El lead se llama ${nombreLead}.` : ''
  const systemInstruction = `Eres Jhon, asesor humano de Perú Exporta TV (cursos de exportación para peruanos). Un lead te mandó una IMAGEN por WhatsApp (ya verificamos que NO es un comprobante de pago).${nombreTxt} Tu trabajo: mírala, clasifícala y responde como Jhon — cálido, humano, peruano, mensajes cortos. Si es su producto (palta, café, textil, artesanía...), reacciona con entusiasmo GENUINO y reconduce a conocerlo para exportar. Si es una captura, un meme o algo no relacionado, reconduce con cordialidad al tema de exportar, sin sonar robótico. NUNCA inventes datos del programa (precio, fechas) — eso va en su momento. NUNCA uses negrita markdown (**).`

  const contents = [{
    role: 'user',
    parts: [
      { text: 'Mira esta imagen que mandó el lead. Clasifícala y responde como Jhon. Devuelve el JSON.' },
      { inlineData: { mimeType, data: base64 } }
    ]
  }]

  try {
    const result = await callGemini({
      model: process.env.BRAIN_MODEL || 'gemini-2.5-flash',
      location: process.env.BRAIN_LOCATION || null,
      thinkingLevel: process.env.BRAIN_THINKING_LEVEL || null,
      systemInstruction,
      contents,
      temperature: 0.6,
      maxOutputTokens: 1200,
      responseSchema: IMAGEN_SCHEMA,
      tenantId: 'peru_exporta'
    })
    if (!result?.text) return { ok: false, error: 'sin_texto' }
    let parsed
    const limpio = result.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    try { parsed = JSON.parse(limpio) } catch (e) {
      const m = limpio.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]) } catch (_) {} }
    }
    if (!parsed?.respuesta) return { ok: false, error: 'json_invalido' }
    // Guardrail de formato (mismo criterio que el cerebro): ** → * y sin #
    const respuesta = String(parsed.respuesta).replace(/\*\*+/g, '*').replace(/^#{1,6}\s*/gm, '')
    return { ok: true, categoria: parsed.categoria || 'otro', descripcion: parsed.descripcion || '', respuesta }
  } catch (err) {
    console.error('[Vision] Error respondiendo a imagen:', err.message)
    return { ok: false, error: err.message }
  }
}
