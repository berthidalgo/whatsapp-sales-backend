// src/lib/cerebras.js — Hidata v20 · Cliente Cerebras (OpenAI-compatible)
//
// Seguro de 2da línea con TPM ALTO (60-100K/min) → aguanta volumen cuando Gemini cae.
// Contra de Cerebras free: contexto capado a ~8.192 tokens → se usa con el PROMPT
// COMPACTO del cerebro (construirSystemPromptCompacto), no el completo. Contrato de
// retorno = el de callGemini/callGroq ({ text, usage, latencyMs, model }).

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions'
const TIMEOUT_MS = 30000

export async function callCerebras({
  model,
  systemInstruction = null,
  contents,
  temperature = 0.7,
  maxOutputTokens = 1024,
  jsonMode = true
}) {
  const startTime = Date.now()
  const apiKey = process.env.CEREBRAS_API_KEY
  if (!apiKey) throw new Error('CEREBRAS_API_KEY no seteada en el entorno')

  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: typeof contents === 'string' ? contents : JSON.stringify(contents) })

  const body = { model, messages, temperature, max_tokens: maxOutputTokens }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(CEREBRAS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`cerebras_${res.status}: ${JSON.stringify(data?.error || data).slice(0, 200)}`)

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

export const CEREBRAS_CLIENT_VERSION = 'v1_openai_compat'
