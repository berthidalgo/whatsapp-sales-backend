// src/lib/openai-compat.js — PROVEEDORES OpenAI-compatibles del cerebro (sep 2026)
//
// POR QUÉ EXISTE: con Vertex sin facturación, la llave de Gemini Dev inválida, Groq
// gratis chico para el prompt (413) y Cerebras cobrando (402), el bot quedó sin
// ningún proveedor vivo. Casi todo el mercado habla el MISMO protocolo que OpenAI
// (/chat/completions), así que un solo cliente abre la puerta a todos: sumar un
// proveedor es poner su llave en el entorno, sin tocar código.
//
// Presets (llave en el entorno → entra solo a la cadena como seguro):
//   mistral     MISTRAL_API_KEY      plan Free: US$10/mes de crédito API, sin tarjeta (desde ago-2026)
//   openrouter  OPENROUTER_API_KEY   una llave para cientos de modelos; los ":free" cuestan $0
//   deepseek    DEEPSEEK_API_KEY     de pago (prepago), el más barato por token
//   nvidia      NVIDIA_API_KEY       build.nvidia.com: gratis para PROTOTIPOS (no producción)
//   compat      OPENAI_COMPAT_BASE_URL (+ OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_MODEL)
//               cualquier otro: Together, Fireworks, DeepInfra, un vLLM/Ollama propio...
//
// Contrato de retorno = el de callGemini/callGroq ({ text, usage, latencyMs, model }).
// Los errores llevan `status` (lo lee statusDeError de la cadena) y el mensaje
// "<proveedor>_<status>: ..." como Groq y Cerebras.

const TIMEOUT_MS = 40000   // los modelos ":free" de OpenRouter comparten cola: a veces tardan

export const PROVEEDORES_COMPAT = {
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    llave: 'MISTRAL_API_KEY',
    // Plan Free (verificado con la cuenta, 28-sep-2026): SOLO los Ministral (3B/8B/14B) y
    // open-mistral-nemo tienen cupo; Small, Medium, Magistral y Devstral dan 0 pedidos/min
    // y Large 403. Ministral 14B ($0.2/$0.2, 30 RPM) es el mejor de los gratis
    // (~500 conversaciones/mes con los US$10). La caché NO aplica aquí (cached_tokens=0).
    modelo: 'ministral-14b-latest',
    json: true
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    llave: 'OPENROUTER_API_KEY',
    modelo: 'google/gemma-4-31b-it:free',
    json: true,
    headers: { 'X-Title': 'Hidata' },
    // OpenRouter unifica el esfuerzo de razonamiento en su propio campo
    razonamiento: (effort) => ({ reasoning: { effort } })
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    llave: 'DEEPSEEK_API_KEY',
    modelo: 'deepseek-flash',
    json: true
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    llave: 'NVIDIA_API_KEY',
    modelo: 'openai/gpt-oss-120b',
    json: false   // no todos los modelos de NIM aceptan response_format: el parser del cerebro extrae el JSON
  },
  compat: {
    url: null,    // OPENAI_COMPAT_BASE_URL + /chat/completions
    llave: 'OPENAI_COMPAT_API_KEY',
    modelo: null, // OPENAI_COMPAT_MODEL o el que diga BRAIN_FALLBACKS
    json: true
  }
}

export function esProveedorCompat(provider) {
  return Object.prototype.hasOwnProperty.call(PROVEEDORES_COMPAT, provider)
}

/** URL de /chat/completions del proveedor (el genérico la arma desde su base). */
export function urlCompat(provider, env = process.env) {
  if (provider !== 'compat') return PROVEEDORES_COMPAT[provider]?.url || null
  const base = String(env.OPENAI_COMPAT_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!base) return null
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

/** Modelo por defecto del proveedor cuando la config solo lo nombra. */
export function modeloCompatDefault(provider, env = process.env) {
  if (provider === 'compat') return env.OPENAI_COMPAT_MODEL || null
  return PROVEEDORES_COMPAT[provider]?.modelo || null
}

/**
 * ¿Hay con qué llamarlo? Los presets piden su llave; el genérico pide la URL (un
 * servidor propio en la red interna puede no tener llave).
 */
export function compatConfigurado(provider, env = process.env) {
  if (provider === 'compat') return !!urlCompat('compat', env)
  const p = PROVEEDORES_COMPAT[provider]
  return !!(p && env[p.llave])
}

export async function callCompat({
  provider,
  model,
  systemInstruction = null,
  contents,
  temperature = 0.7,
  maxOutputTokens = 2048,
  jsonMode = true,
  reasoningEffort = null,
  env = process.env
}) {
  const p = PROVEEDORES_COMPAT[provider]
  if (!p) throw new Error(`proveedor OpenAI-compatible desconocido: ${provider}`)
  const url = urlCompat(provider, env)
  if (!url) throw new Error(`${provider}: falta OPENAI_COMPAT_BASE_URL`)
  const apiKey = env[p.llave] || null
  if (!apiKey && provider !== 'compat') throw new Error(`${p.llave} no seteada en el entorno`)

  const startTime = Date.now()
  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  // Partes al estilo OpenAI ([{ type: 'text' }, { type: 'image_url' }]) pasan tal cual:
  // así se le manda una foto a un modelo multimodal (visión por OpenRouter, sep 2026).
  const esMultimodal = Array.isArray(contents) && contents.length > 0 && contents.every(p => typeof p?.type === 'string')
  messages.push({ role: 'user', content: typeof contents === 'string' || esMultimodal ? contents : JSON.stringify(contents) })

  const body = { model, messages, temperature, max_tokens: maxOutputTokens }
  if (jsonMode && p.json) body.response_format = { type: 'json_object' }
  if (reasoningEffort) Object.assign(body, p.razonamiento ? p.razonamiento(reasoningEffort) : { reasoning_effort: reasoningEffort })

  const headers = { 'Content-Type': 'application/json', ...(p.headers || {}) }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const e = new Error(`${provider}_${res.status}: ${JSON.stringify(data?.error || data).slice(0, 200)}`)
      e.status = res.status
      throw e
    }

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
      // OpenRouter con un router (ej. "openrouter/free") dice qué modelo respondió de verdad
      model: data?.model || model
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

export const OPENAI_COMPAT_VERSION = 'v1_presets_mistral_openrouter_deepseek_nvidia'
