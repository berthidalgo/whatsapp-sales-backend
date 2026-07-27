// src/lib/groq.js — Hidata v20 · Cliente Groq (OpenAI-compatible)
//
// Seguro de segunda línea (R3): cuando Vertex/Gemini cae, el cerebro cae a Groq y
// NO queda mudo. También es el motor del banco para examinar qué modelo free de Groq
// es el mejor fallback (metodología pro vs flash).
//
// Groq NO tiene el responseSchema nativo de Gemini → se usa response_format json_object
// + se inyecta la descripción del schema en el system prompt (schemaToPrompt). El parser
// robusto del cerebro extrae el JSON igual que con Gemini.
//
// Contrato de retorno = el de callGemini ({ text, usage{normalizado}, latencyMs, model })
// para ser drop-in dentro de pensarYResponder.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const TIMEOUT_MS = 30000

export async function callGroq({
  model,
  systemInstruction = null,
  contents,
  temperature = 0.7,
  maxOutputTokens = 2048,
  jsonMode = true
}) {
  const startTime = Date.now()
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY no seteada en el entorno')

  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: typeof contents === 'string' ? contents : JSON.stringify(contents) })

  const body = { model, messages, temperature, max_tokens: maxOutputTokens }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`groq_${res.status}: ${JSON.stringify(data?.error || data).slice(0, 200)}`)

    // Normalizar usage al shape de Gemini (para que el audit del cerebro funcione igual)
    const u = data?.usage || {}
    const usage = {
      promptTokenCount: u.prompt_tokens || 0,
      candidatesTokenCount: u.completion_tokens || 0,
      totalTokenCount: u.total_tokens || 0
    }
    return {
      text: data?.choices?.[0]?.message?.content || '',
      usage,
      latencyMs: Date.now() - startTime,
      model
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ════════════════════════════════════════════════════════════════════════
// WHISPER — transcripción de audio entrante (BLOQUE #3, jun 2026)
// El lead peruano manda muchas notas de voz. Groq corre Whisper GRATIS
// (whisper-large-v3-turbo) → transcribimos la nota y la tratamos como texto.
// La API de audio NO es JSON: es multipart/form-data (subida de archivo).
// ════════════════════════════════════════════════════════════════════════
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const WHISPER_MODEL = 'whisper-large-v3-turbo'
// Pista de dominio: Whisper la usa como contexto/ortografía → mejora términos
// peruanos y nombres propios.
//
// POR VERTICAL (fix forense jul 2026): antes esta pista era UNA sola, con vocabulario
// de exportación ("palta, arandanos, ESCEX, Peru Exporta"), y se aplicaba a TODOS los
// clientes. Una nota de voz de una clienta de colágeno se transcribía sesgada hacia
// exportación — el mismo defecto que hizo que el bot le hablara de exportar. La pista
// ahora sale del vertical del tenant; la base peruana (Yape, Plin, distritos) es común.
const WHISPER_BASE_ES = 'Conversacion de WhatsApp en espanol peruano. Terminos comunes: Yape, Plin, RUC, DNI, soles, contraentrega, delivery.'

const WHISPER_PROMPT_POR_VERTICAL = {
  exportacion: `${WHISPER_BASE_ES} Tema: exportacion. Terminos: exportar, exportacion, palta, arandanos, cafe, maca, quinua, ESCEX, partida arancelaria, FOB, contenedor.`,
  // Vocabulario de DOMINIO, no de marca: el nombre comercial del producto se queda
  // en el vertical (ver el guardián anti-contaminación). Whisper solo necesita el
  // campo semántico para no oír "exportar" donde dijeron "colágeno".
  colageno:    `${WHISPER_BASE_ES} Tema: suplementos de colageno y belleza. Terminos: colageno, frasco, envase, piel, arrugas, articulaciones, cabello, unas, vitamina C, acido hialuronico.`
}

export function whisperPromptDe(vertical) {
  return WHISPER_PROMPT_POR_VERTICAL[vertical] || WHISPER_BASE_ES
}

/**
 * Transcribe un audio (base64) a texto con Groq Whisper.
 * @param {object} args
 * @param {string} args.base64    - audio en base64 (sin prefijo data:)
 * @param {string} args.mimeType  - ej. 'audio/ogg; codecs=opus' (nota de voz de WhatsApp)
 * @param {string} args.language  - hint de idioma ('es')
 * @param {string?} args.vertical - vertical del tenant ('exportacion'|'colageno'), para
 *                                  la pista de vocabulario. Sin él usa la base peruana.
 * @returns {Promise<{ ok, texto?, latencyMs?, error? }>}
 */
export async function transcribirAudio({ base64, mimeType = 'audio/ogg', language = 'es', vertical = null }) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return { ok: false, error: 'GROQ_API_KEY no seteada' }
  if (!base64) return { ok: false, error: 'sin_base64' }
  const startTime = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const buffer = Buffer.from(base64, 'base64')
    // La extensión del archivo importa para que Groq detecte el formato.
    const ext = /mpeg|mp3/.test(mimeType) ? 'mp3'
      : /wav/.test(mimeType) ? 'wav'
      : /mp4|m4a/.test(mimeType) ? 'm4a'
      : /webm/.test(mimeType) ? 'webm'
      : 'ogg'  // las notas de voz de WhatsApp son ogg/opus
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`)
    form.append('model', WHISPER_MODEL)
    if (language) form.append('language', language)
    form.append('prompt', whisperPromptDe(vertical))
    form.append('response_format', 'json')
    // NO seteamos Content-Type: fetch lo pone con el boundary correcto del multipart.
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: `groq_whisper_${res.status}: ${JSON.stringify(data?.error || data).slice(0, 200)}` }
    const texto = (data?.text || '').trim()
    if (!texto) return { ok: false, error: 'transcripcion_vacia' }
    return { ok: true, texto, latencyMs: Date.now() - startTime }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

export const GROQ_WHISPER_MODEL = WHISPER_MODEL

/**
 * Convierte el responseSchema de Gemini a una instrucción de texto, para modelos sin
 * structured output nativo (Groq). Expande un nivel de anidamiento (ej: slots_detectados).
 */
export function schemaToPrompt(schema) {
  if (!schema?.properties) return ''
  const lineas = [
    '# FORMATO DE SALIDA (OBLIGATORIO)',
    'Responde ÚNICAMENTE con un objeto JSON válido (sin texto fuera del JSON, sin bloques markdown) con estos campos:'
  ]
  for (const [k, v] of Object.entries(schema.properties)) {
    const tipo = v.enum ? `uno de: ${v.enum.join('|')}` : v.type
    let l = `- "${k}" (${tipo}): ${(v.description || '').slice(0, 300)}`
    if (v.type === 'object' && v.properties) {
      for (const [sk, sv] of Object.entries(v.properties)) {
        const st = sv.enum ? `uno de: ${sv.enum.join('|')}` : sv.type
        l += `\n    · "${sk}" (${st}): ${(sv.description || '').slice(0, 180)}`
      }
    }
    lineas.push(l)
  }
  const req = schema.required || []
  if (req.length) lineas.push(`Campos OBLIGATORIOS: ${req.join(', ')}.`)
  return lineas.join('\n')
}

export const GROQ_CLIENT_VERSION = 'v1_openai_compat'
