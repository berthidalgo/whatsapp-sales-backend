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
