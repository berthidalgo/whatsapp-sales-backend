// src/webhook/sender.js — Hidata v20 Día 7
//
// SENDER — Wrapper de Evolution API para enviar mensajes a WhatsApp
//
// API pública: sendToWhatsApp({ telefono, text, instanceName })
//
// Funcionalidad:
//   - POST /message/sendText/{instance} a Evolution
//   - Retry 1 vez si timeout (10s primer intento, 5s retry)
//   - Validación de input
//   - Cero crashes
//   - Logging detallado

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const PRIMARY_TIMEOUT_MS = 10000        // 10s primer intento
const RETRY_TIMEOUT_MS = 5000           // 5s retry
const MAX_TEXT_LENGTH = 4096            // Límite WhatsApp (~4096 chars)

// ════════════════════════════════════════════════════════
// API PÚBLICA — sendToWhatsApp()
// ════════════════════════════════════════════════════════

/**
 * Envía un mensaje de texto a un número de WhatsApp via Evolution API.
 * 
 * @param {object} params
 * @param {string} params.telefono - Número sin formato (ej: "51938188585")
 * @param {string} params.text - Texto a enviar
 * @param {string} params.instanceName - Nombre de instancia Evolution
 * @returns {object} {
 *   ok, sent, messageId, status,
 *   latency_ms, retry_used, errors
 * }
 */
export async function sendToWhatsApp({ telefono, text, instanceName }) {
  const startTime = Date.now()
  const errors = []

  // ─── 1. Validación de input ───
  if (!telefono || typeof telefono !== 'string') {
    return buildErrorResponse('telefono_required', startTime, errors)
  }

  if (!text || typeof text !== 'string') {
    return buildErrorResponse('text_required', startTime, errors)
  }

  if (!instanceName || typeof instanceName !== 'string') {
    return buildErrorResponse('instance_required', startTime, errors)
  }

  // ─── 2. Validar env variables ───
  const baseUrl = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY

  if (!baseUrl) {
    return buildErrorResponse('env_EVOLUTION_API_URL_missing', startTime, errors)
  }

  if (!apiKey) {
    return buildErrorResponse('env_EVOLUTION_API_KEY_missing', startTime, errors)
  }

  // ─── 3. Truncar texto si excede límite ───
  let finalText = text.trim()
  if (finalText.length > MAX_TEXT_LENGTH) {
    console.warn(`[Sender] Text too long (${finalText.length} chars), truncating to ${MAX_TEXT_LENGTH}`)
    finalText = finalText.substring(0, MAX_TEXT_LENGTH - 3) + '...'
  }

  // ─── 4. Construir URL y body ───
  const url = `${baseUrl.replace(/\/$/, '')}/message/sendText/${instanceName}`
  const body = {
    number: telefono,
    text: finalText
  }

  // ─── 5. Primer intento ───
  console.log(`[Sender] Sending to ${telefono} via ${instanceName} (${finalText.length} chars)`)

  try {
    const result = await callEvolutionWithTimeout(url, apiKey, body, PRIMARY_TIMEOUT_MS)
    
    if (result.ok) {
      const messageId = result.data?.key?.id || null
      const status = result.data?.status || 'unknown'
      
      console.log(`[Sender] ✅ Sent to ${telefono} | messageId=${messageId} | status=${status}`)
      
      return {
        ok: true,
        sent: true,
        messageId,
        status,
        latency_ms: Date.now() - startTime,
        retry_used: false,
        errors: []
      }
    }
    
    errors.push(`Primary call failed: ${result.error}`)
  } catch (err) {
    errors.push(`Primary call exception: ${err.message}`)
  }

  // ─── 6. Retry ───
  console.warn(`[Sender] Primary call failed, retrying for ${telefono}...`)

  try {
    const result = await callEvolutionWithTimeout(url, apiKey, body, RETRY_TIMEOUT_MS)
    
    if (result.ok) {
      const messageId = result.data?.key?.id || null
      const status = result.data?.status || 'unknown'
      
      console.log(`[Sender] ✅ Sent on RETRY to ${telefono} | messageId=${messageId}`)
      
      return {
        ok: true,
        sent: true,
        messageId,
        status,
        latency_ms: Date.now() - startTime,
        retry_used: true,
        errors
      }
    }
    
    errors.push(`Retry failed: ${result.error}`)
  } catch (err) {
    errors.push(`Retry exception: ${err.message}`)
  }

  // ─── 7. Ambos intentos fallaron ───
  console.error(`[Sender] ❌ Send failed for ${telefono} after 2 attempts`)
  
  return buildErrorResponse('send_failed_after_retry', startTime, errors, true)
}

// ════════════════════════════════════════════════════════
// ENVÍO DE MEDIA (imagen) — Evolution /message/sendMedia (jul 2026)
// El bot manda la foto de precios en el Momento 4 del vertical colágeno
// (como el rival manda su video, pero en el momento correcto del cierre).
// media = base64 SIN el prefijo data: (Evolution lo quiere pelado).
// ════════════════════════════════════════════════════════
export async function sendMediaToWhatsApp({ telefono, base64, mimetype = 'image/png', fileName = 'imagen.png', caption = '', instanceName }) {
  const startTime = Date.now()
  if (!telefono || !base64 || !instanceName) {
    return { ok: false, error: 'media_params_missing', latency_ms: 0 }
  }
  const baseUrl = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!baseUrl || !apiKey) return { ok: false, error: 'env_evolution_missing', latency_ms: 0 }

  const url = `${baseUrl.replace(/\/$/, '')}/message/sendMedia/${instanceName}`
  const cleanB64 = base64.replace(/^data:[^;]+;base64,/, '')
  const body = { number: telefono, mediatype: 'image', mimetype, caption, media: cleanB64, fileName }

  console.log(`[Sender] 📎 Enviando imagen a ${telefono} (${Math.round(cleanB64.length / 1024)}KB b64) via ${instanceName}`)
  try {
    const result = await callEvolutionWithTimeout(url, apiKey, body, 25000)  // media es más pesada → timeout mayor
    if (result.ok) {
      return { ok: true, sent: true, latency_ms: Date.now() - startTime, status: result.status }
    }
    console.error(`[Sender] ❌ Media send failed: ${result.error}`)
    return { ok: false, error: result.error, latency_ms: Date.now() - startTime }
  } catch (err) {
    return { ok: false, error: `media_exception: ${err.message}`, latency_ms: Date.now() - startTime }
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Llamada a Evolution con timeout
// ════════════════════════════════════════════════════════

/**
 * Hace POST a Evolution API con timeout estricto.
 */
async function callEvolutionWithTimeout(url, apiKey, body, timeoutMs) {
  let timeoutId

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ ok: false, error: `timeout_${timeoutMs}ms` })
    }, timeoutMs)
  })

  const fetchPromise = (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        },
        body: JSON.stringify(body)
      })

      if (timeoutId) clearTimeout(timeoutId)

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        return {
          ok: false,
          error: `http_${response.status}: ${JSON.stringify(data)?.substring(0, 200)}`,
          status: response.status,
          data
        }
      }

      return {
        ok: true,
        data,
        status: response.status
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId)
      return {
        ok: false,
        error: `fetch_error: ${err.message}`
      }
    }
  })()

  return Promise.race([fetchPromise, timeoutPromise])
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

function buildErrorResponse(errorCode, startTime, errors, retryUsed = false) {
  return {
    ok: false,
    sent: false,
    messageId: null,
    status: null,
    latency_ms: Date.now() - startTime,
    retry_used: retryUsed,
    error: errorCode,
    errors
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen para logs
// ════════════════════════════════════════════════════════

export function summarizeSendResult(result) {
  if (!result) return 'no result'

  if (!result.ok) {
    return `❌ send failed: ${result.error || 'unknown'} (${result.latency_ms}ms)`
  }

  const retry = result.retry_used ? ' [retry]' : ''
  return `✅ sent (${result.latency_ms}ms, msgId=${result.messageId || 'none'})${retry}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const SENDER_VERSION = 'v1_day7_evolution_wrapper'