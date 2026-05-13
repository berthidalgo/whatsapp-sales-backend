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