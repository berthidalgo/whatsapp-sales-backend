// src/whatsapp/cloud/sender.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Envío vía Graph API. DOS funciones:
//   - sendToWhatsAppCloud(): mensaje de TEXTO libre. Solo válido DENTRO de la ventana
//     de servicio de 24h (el lead escribió hace <24h). MISMA FIRMA que el sender de
//     Evolution → drop-in para notifications.js / followupEngine.js / event-router.js.
//   - sendTemplateCloud(): plantilla pre-aprobada. ÚNICO modo permitido FUERA de la
//     ventana de 24h (followup >24h, campañas). Requiere template aprobado en Meta.
//
// Contrato de retorno idéntico a Evolution: { ok, sent, messageId, status, latency_ms, error, errors }.

import { cloudConfig, cloudReady } from './config.js'

const TIMEOUT_MS = 10000
const MAX_TEXT = 4096

// ════════════════════════════════════════════════════════
// TEXTO (dentro de ventana 24h)
// ════════════════════════════════════════════════════════
export async function sendToWhatsAppCloud({ telefono, text, instanceName = null }) {
  const start = Date.now()
  if (!telefono || typeof telefono !== 'string') return buildErr('telefono_required', start)
  if (!text || typeof text !== 'string')         return buildErr('text_required', start)
  if (!cloudReady())                              return buildErr('cloud_not_configured', start)

  const c = cloudConfig()
  let finalText = text.trim()
  if (finalText.length > MAX_TEXT) finalText = finalText.slice(0, MAX_TEXT - 3) + '...'

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: soloDigitos(telefono),
    type: 'text',
    text: { preview_url: false, body: finalText }
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// TEMPLATE (fuera de ventana 24h — followups/campañas)
// components: array Meta (header/body/button params). Vacío = template sin variables.
// ════════════════════════════════════════════════════════
export async function sendTemplateCloud({ telefono, templateName, languageCode = 'es', components = [] }) {
  const start = Date.now()
  if (!telefono || typeof telefono !== 'string') return buildErr('telefono_required', start)
  if (!templateName)                             return buildErr('template_required', start)
  if (!cloudReady())                             return buildErr('cloud_not_configured', start)

  const c = cloudConfig()
  const body = {
    messaging_product: 'whatsapp',
    to: soloDigitos(telefono),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {})
    }
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// HELPER — POST a Graph con timeout
// ════════════════════════════════════════════════════════
async function postGraph(url, token, body, start) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)

    if (!res.ok) {
      // Meta devuelve { error: { message, code, error_subcode, ... } }
      const metaErr = data?.error?.message || `http_${res.status}`
      return {
        ok: false, sent: false, messageId: null, status: res.status,
        latency_ms: Date.now() - start, error: `graph_${res.status}`,
        errors: [String(metaErr).slice(0, 300)]
      }
    }
    const messageId = data?.messages?.[0]?.id || null
    return {
      ok: true, sent: true, messageId, status: 'sent',
      latency_ms: Date.now() - start, error: null, errors: []
    }
  } catch (e) {
    clearTimeout(timer)
    return {
      ok: false, sent: false, messageId: null, status: null,
      latency_ms: Date.now() - start,
      error: e.name === 'AbortError' ? `timeout_${TIMEOUT_MS}ms` : 'fetch_error',
      errors: [e.message]
    }
  }
}

function soloDigitos(tel) {
  return String(tel).split('@')[0].split(':')[0].replace(/\D/g, '')
}

function buildErr(code, start) {
  return { ok: false, sent: false, messageId: null, status: null, latency_ms: Date.now() - start, error: code, errors: [] }
}

export const CLOUD_SENDER_VERSION = 'v1_cloud_api_graph'
