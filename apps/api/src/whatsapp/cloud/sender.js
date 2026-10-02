// src/whatsapp/cloud/sender.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Envío vía Graph API:
//   - sendToWhatsAppCloud(): mensaje de TEXTO libre. Solo válido DENTRO de la ventana
//     de servicio de 24h (el lead escribió hace <24h). Mismo contrato de retorno que el
//     sender de Evolution → intercambiable desde whatsapp/transporte.js.
//   - sendImageCloud(): imagen (p.ej. la foto de precios del Momento 4). Meta no acepta
//     base64: primero se SUBE el archivo (/media) y luego se envía por su id.
//   - sendTemplateCloud(): plantilla pre-aprobada. ÚNICO modo permitido FUERA de la
//     ventana de 24h (followup >24h, campañas). Requiere plantilla aprobada en Meta.
//   - sendInteractiveCloud(): botones de respuesta, lista o botón de enlace (los arma
//     cloud/interactivos.js). Como el texto libre, solo dentro de la ventana de 24 h.
//   - marcarLeidoCloud(): marca el mensaje del cliente como leído (✓✓ azules) y, si se
//     pide, muestra «escribiendo…» hasta 25 s o hasta que salga la respuesta.
//
// MULTITENANT (sep 2026): cada función acepta `credenciales` ({ phoneNumberId,
// accessToken }) del canal del cliente. Sin ellas se usan las env vars CLOUD_* (el
// número propio de Hidata o un deploy de un solo cliente).
//
// Destinatario: teléfono (campo `to`) o, si el usuario oculta su número con un
// username, su BSUID (campo `recipient`; Meta lo acepta desde julio de 2026).
//
// Contrato de retorno: { ok, sent, messageId, status, latency_ms, error, errors }.

import { resolverCredencialesCloud, cloudReady } from './config.js'
import { sanearComponentes } from './plantillas.js'

const TIMEOUT_MS = 10000
const TIMEOUT_MEDIA_MS = 25000
const MAX_TEXT = 4096

// BSUID: código de país ISO de 2 letras + punto + hasta 128 alfanuméricos (ej. US.1349...).
const RX_BSUID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/

/** Campo de destinatario para Graph: { to: '519...' } o { recipient: 'PE.abc...' }. */
export function destinatarioCloud(telefonoOBsuid) {
  const v = String(telefonoOBsuid || '').trim()
  if (RX_BSUID.test(v)) return { recipient: v }
  const digitos = v.split('@')[0].split(':')[0].replace(/\D/g, '')
  return digitos ? { to: digitos } : null
}

/** Credenciales efectivas. El token global solo sirve al mismo número configurado. */
function resolverCredenciales(credenciales) {
  return resolverCredencialesCloud(credenciales)
}

// ════════════════════════════════════════════════════════
// TEXTO (dentro de ventana 24h)
// ════════════════════════════════════════════════════════
export async function sendToWhatsAppCloud({ telefono, text, credenciales = null }) {
  const start = Date.now()
  const dest = destinatarioCloud(telefono)
  if (!dest)                             return buildErr('telefono_required', start)
  if (!text || typeof text !== 'string') return buildErr('text_required', start)
  const c = resolverCredenciales(credenciales)
  if (!cloudReady(c))                    return buildErr('cloud_not_configured', start)

  let finalText = text.trim()
  if (finalText.length > MAX_TEXT) finalText = finalText.slice(0, MAX_TEXT - 3) + '...'

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...dest,
    type: 'text',
    text: { preview_url: false, body: finalText }
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// IMAGEN: subir a /media y enviar por id
// ════════════════════════════════════════════════════════
export async function sendImageCloud({ telefono, base64, mimetype = 'image/png', fileName = 'imagen.png', caption = '', credenciales = null }) {
  const start = Date.now()
  const dest = destinatarioCloud(telefono)
  if (!dest || !base64) return buildErr('media_params_missing', start)
  const c = resolverCredenciales(credenciales)
  if (!cloudReady(c))   return buildErr('cloud_not_configured', start)

  // 1. Subir el archivo (multipart). Meta devuelve { id } y lo guarda 30 días.
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimetype)
  const binario = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64')
  form.append('file', new Blob([binario], { type: mimetype }), fileName)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MEDIA_MS)
  let mediaId = null
  try {
    const res = await fetch(`${c.graphBase}/${c.phoneNumberId}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.accessToken}` }, body: form, signal: ctrl.signal
    })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.id) {
      return { ...buildErr(`graph_upload_${res.status}`, start), status: res.status, errors: [String(data?.error?.message || '').slice(0, 300)] }
    }
    mediaId = data.id
  } catch (e) {
    clearTimeout(timer)
    return { ...buildErr(e.name === 'AbortError' ? `timeout_${TIMEOUT_MEDIA_MS}ms` : 'fetch_error', start), errors: [e.message] }
  }

  // 2. Enviar el mensaje con la imagen subida
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...dest,
    type: 'image',
    image: { id: mediaId, ...(caption ? { caption } : {}) }
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// TEMPLATE (fuera de ventana 24h — followups/campañas)
// components: array Meta (header/body/button params). Vacío = template sin variables.
// Los valores de texto se limpian aquí (sanearComponentes): un salto de línea o un valor
// vacío en una variable hace que Meta rechace el envío entero.
// ════════════════════════════════════════════════════════
export async function sendTemplateCloud({ telefono, templateName, languageCode = 'es', components = [], credenciales = null }) {
  const start = Date.now()
  const dest = destinatarioCloud(telefono)
  if (!dest)          return buildErr('telefono_required', start)
  if (!templateName)  return buildErr('template_required', start)
  const c = resolverCredenciales(credenciales)
  if (!cloudReady(c)) return buildErr('cloud_not_configured', start)

  const componentes = sanearComponentes(components)
  const body = {
    messaging_product: 'whatsapp',
    ...dest,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'es' },
      ...(componentes.length ? { components: componentes } : {})
    }
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// INTERACTIVO (botones / lista / enlace) — dentro de la ventana de 24h
// `interactive` ya viene armado y validado por cloud/interactivos.js.
// ════════════════════════════════════════════════════════
export async function sendInteractiveCloud({ telefono, interactive, credenciales = null }) {
  const start = Date.now()
  const dest = destinatarioCloud(telefono)
  if (!dest)                              return buildErr('telefono_required', start)
  if (!interactive || !interactive.type)  return buildErr('interactive_required', start)
  const c = resolverCredenciales(credenciales)
  if (!cloudReady(c))                     return buildErr('cloud_not_configured', start)

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...dest,
    type: 'interactive',
    interactive
  }
  return postGraph(`${c.graphBase}/${c.phoneNumberId}/messages`, c.accessToken, body, start)
}

// ════════════════════════════════════════════════════════
// LEÍDO + «ESCRIBIENDO…»
// Es la MISMA ruta /messages con otro cuerpo. Meta responde { success: true }, sin wamid
// (por eso `messageId` sale null aquí). Se puede marcar como leído hasta 30 días después.
// Meta pide mostrar «escribiendo…» solo si de verdad se va a responder.
// ════════════════════════════════════════════════════════
export async function marcarLeidoCloud({ messageId, escribiendo = false, credenciales = null }) {
  const start = Date.now()
  if (!messageId) return buildErr('message_id_required', start)
  const c = resolverCredenciales(credenciales)
  if (!cloudReady(c)) return buildErr('cloud_not_configured', start)

  const body = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    ...(escribiendo ? { typing_indicator: { type: 'text' } } : {})
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
      // Meta devuelve { error: { message, code, error_subcode, ... } }. El código 131047
      // significa "fuera de la ventana de 24 h": ahí solo se puede enviar una plantilla.
      const metaErr = data?.error?.message || `http_${res.status}`
      const code = data?.error?.code
      return {
        ok: false, sent: false, messageId: null, status: res.status,
        latency_ms: Date.now() - start,
        error: code === 131047 ? 'fuera_de_ventana_24h' : `graph_${res.status}`,
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

function buildErr(code, start) {
  return { ok: false, sent: false, messageId: null, status: null, latency_ms: Date.now() - start, error: code, errors: [] }
}

export const CLOUD_SENDER_VERSION = 'v3_interactivo_leido_escribiendo'
