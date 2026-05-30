// src/webhook/event-router.js — Hidata v20 · Sprint 2 (paso 1a — identidad @lid)
//
// EVENT ROUTER
//
// Recibe el payload crudo de Evolution API y dispatcha al handler correcto.
//
// ─────────────────────────────────────────────────────────────────────────
// CAMBIO Sprint 2 (paso 1a):
//   - Extrae del payload de Baileys lo que antes se tiraba a la basura:
//       · remoteJidAlt / senderPn  → número real cuando remoteJid es @lid
//       · addressingMode           → 'pn' | 'lid'
//       · contextInfo.externalAdReply / conversionSource → contexto de anuncio CTWA
//     y se lo pasa al lead-resolver (identidad) y, vía pass-through, al
//     Campaign Resolver del paso 1b.
//   - RECON: cuando llega un @lid o un anuncio CTWA, lo LOGUEA en producción.
//     Así, al correr un anuncio real, vemos en Render qué trae Baileys de verdad
//     en NUESTRA instancia → diseñamos el Campaign Resolver con datos reales.
//   - Endurece el filtro de no-leads: grupos + canales + broadcast (isNonLeadJid).
// ─────────────────────────────────────────────────────────────────────────
//
// Eventos manejados:
//   - messages.upsert     → mensaje nuevo (lead o vendor)
//   - messages.update     → mensaje editado/borrado (log, skip)
//   - connection.update   → cambio de conexión (log, alert si close)
//   - send.message        → confirmación de envío (audit)
//   - logout.instance     → ALERTA crítica (vendor debe re-escanear QR)
//   - qrcode.updated      → log con instrucciones
//
// CERO BD writes directos. Delega a lead-resolver, debounce y state.
//
// API pública: routeEvent(payload, processPipelineFn)

import prisma from '../db/prisma.js'
import {
  resolveLead,
  normalizePhone,
  isNonLeadJid,
  isGroupJid,
  isLidJid,
  summarizeResolution
} from './lead-resolver.js'
import { enqueueMessage, cancelDebounce } from './debounce.js'
import { MODES } from '../state/stage-definitions.js'

// ════════════════════════════════════════════════════════
// API PÚBLICA — routeEvent()
// ════════════════════════════════════════════════════════

/**
 * Dispatcha un payload de Evolution al handler correcto.
 *
 * @param {object} payload - Payload crudo de Evolution
 * @param {function} processPipelineFn - async (leadInfo, combinedText, bufferMeta) => void
 * @returns {object} { ok, handled, eventType, action }
 */
export async function routeEvent(payload, processPipelineFn) {
  const startTime = Date.now()

  // ─── Validación de payload ───
  if (!payload || typeof payload !== 'object') {
    return buildErrorResponse('invalid_payload', startTime)
  }

  const eventType = payload.event || 'unknown'

  try {
    // ─── Dispatch por tipo de evento ───
    switch (eventType) {

      case 'messages.upsert':
        return await handleMessagesUpsert(payload, processPipelineFn, startTime)

      case 'messages.update':
        return await handleMessagesUpdate(payload, startTime)

      case 'connection.update':
        return await handleConnectionUpdate(payload, startTime)

      case 'send.message':
        return await handleSendMessage(payload, startTime)

      case 'logout.instance':
        return await handleLogoutInstance(payload, startTime)

      case 'qrcode.updated':
        return await handleQrcodeUpdated(payload, startTime)

      default:
        return await handleUnknownEvent(eventType, payload, startTime)
    }

  } catch (err) {
    console.error(`[EventRouter] Error processing ${eventType}:`, err.message)
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'))
    return buildErrorResponse('handler_error', startTime, {
      eventType,
      error: err.message
    })
  }
}

// ════════════════════════════════════════════════════════
// HANDLER — messages.upsert
// ════════════════════════════════════════════════════════

async function handleMessagesUpsert(payload, processPipelineFn, startTime) {
  const data = payload?.data || {}

  // ════════════════════════════════════════════════════════
  // FIX Día 8 — Compatibilidad con DOS estructuras de payload:
  //   Estructura A (Evolution v2.3.7 webhook real): data.messages = [ { key, message } ]
  //   Estructura B (algunos endpoints / tests):      data.key = {...}, data.message = {...}
  // ════════════════════════════════════════════════════════
  const isArrayStructure = Array.isArray(data.messages) && data.messages.length > 0
  const msgEnvelope = isArrayStructure ? data.messages[0] : data

  const key = msgEnvelope?.key || {}
  const message = msgEnvelope?.message || {}
  const pushName = msgEnvelope?.pushName || data?.pushName || null
  const instanceName = data.instance || payload.instance || null

  // ─── 1. Validar estructura mínima ───
  if (!key.remoteJid || !key.id) {
    return buildErrorResponse('messages_upsert_missing_keys', startTime, {
      hasRemoteJid: !!key.remoteJid,
      hasId: !!key.id,
      detectedStructure: isArrayStructure ? 'array' : 'direct',
      payloadDataKeys: Object.keys(data)
    })
  }

  // ─── 2. Rechazar no-leads (grupo / canal / broadcast) ───
  if (isNonLeadJid(key.remoteJid)) {
    console.log(`[EventRouter] Skipping non-lead JID: ${key.remoteJid}`)
    return buildResponse('non_lead_skipped', startTime, { jid: key.remoteJid })
  }

  // ─── 3. Extraer identificadores de direccionamiento (PN / LID / alt) ───
  const addressing = extractAddressing(key, msgEnvelope, data)

  // ─── 4. Extraer contexto de anuncio CTWA (para el Campaign Resolver, paso 1b) ───
  const adContext = extractAdContext(message)

  // ─── 5. Detectar tipo y extraer texto ───
  const messageType = detectMessageType(message)
  const text = extractText(message)

  console.log(`[EventRouter] messages.upsert | fromMe=${key.fromMe} | type=${messageType} | jid=${key.remoteJid} | struct=${isArrayStructure ? 'array' : 'direct'}`)

  // ─── 5-bis. RECON: si es @lid o trae anuncio, lo logueamos para ver el payload real ───
  if (isLidJid(addressing.remoteJid) || addressing.addressingMode === 'lid') {
    console.log(`[EventRouter] 🔍 LID payload | remoteJid=${addressing.remoteJid} | remoteJidAlt=${addressing.remoteJidAlt} | senderPn=${addressing.senderPn} | mode=${addressing.addressingMode} | pushName=${pushName}`)
  }
  if (adContext?.hasAdContext) {
    console.log(`[EventRouter] 📢 CTWA ad context: ${JSON.stringify(adContext)}`)
  }

  // ─── 6. Resolver lead (identidad) ───
  const leadResolution = await resolveLead({
    remoteJid: key.remoteJid,
    remoteJidAlt: addressing.remoteJidAlt,
    senderPn: addressing.senderPn,
    addressingMode: addressing.addressingMode,
    instanceName,
    pushName,
    adContext
  })

  if (!leadResolution.ok) {
    console.error(`[EventRouter] Lead resolution failed: ${leadResolution.errors?.[0]?.code}`)
    return buildErrorResponse('lead_resolution_failed', startTime, {
      errors: leadResolution.errors
    })
  }

  console.log(`[EventRouter] ${summarizeResolution(leadResolution)}`)

  // ─── 7. Determinar acción según fromMe ───
  if (key.fromMe === true) {
    // ✋ Mensaje del VENDOR (manual desde WhatsApp)
    return await handleVendorMessage({
      leadInfo: leadResolution,
      text,
      messageId: key.id,
      messageType,
      startTime
    })
  } else {
    // 📨 Mensaje del LEAD
    return await handleLeadMessage({
      leadInfo: leadResolution,
      text,
      messageId: key.id,
      messageType,
      processPipelineFn,
      startTime
    })
  }
}

// ════════════════════════════════════════════════════════
// HANDLER — Lead message (fromMe: false)
// ════════════════════════════════════════════════════════

async function handleLeadMessage({
  leadInfo,
  text,
  messageId,
  messageType,
  processPipelineFn,
  startTime
}) {

  // ─── Mensaje sin texto procesable (audio/imagen/etc) ───
  if (!text || messageType !== 'text') {
    console.log(`[EventRouter] Non-text message from lead ${leadInfo.leadId}: ${messageType}`)
    // TODO: transcripción de audio, OCR de imagen
    return buildResponse('non_text_message_skipped', startTime, {
      leadId: leadInfo.leadId,
      messageType
    })
  }

  // ─── Verificar si lead está archivado ───
  if (leadInfo.isArchived) {
    console.log(`[EventRouter] Lead ${leadInfo.leadId} is archived, skipping`)
    return buildResponse('lead_archived_skipped', startTime, {
      leadId: leadInfo.leadId
    })
  }

  // ─── Encolar al debounce ───
  const debounceResult = enqueueMessage({
    leadId: leadInfo.leadId,
    text,
    processFn: async (combinedText, bufferMetadata) => {
      // Pipeline cognitivo via la función pasada por handler.js
      await processPipelineFn(leadInfo, combinedText, bufferMetadata)
    },
    metadata: {
      messageId,
      messageType,
      remoteJid: leadInfo.telefono,
      waJid: leadInfo.waJid,                    // JID real para responder (sender, paso 1c)
      addressingMode: leadInfo.addressingMode,
      vendorId: leadInfo.vendorId
    }
  })

  if (!debounceResult.queued) {
    console.error(`[EventRouter] Debounce enqueue failed: ${debounceResult.error}`)
    return buildErrorResponse('debounce_enqueue_failed', startTime, debounceResult)
  }

  return buildResponse('lead_message_queued', startTime, {
    leadId: leadInfo.leadId,
    telefono: leadInfo.telefono,
    bufferSize: debounceResult.bufferSize,
    willProcessIn: debounceResult.willProcessIn
  })
}

// ════════════════════════════════════════════════════════
// HANDLER — Vendor message (fromMe: true)
// ════════════════════════════════════════════════════════

async function handleVendorMessage({
  leadInfo,
  text,
  messageId,
  messageType,
  startTime
}) {

  console.log(`[EventRouter] VENDOR message to lead ${leadInfo.leadId} (id: ${messageId})`)

  try {
    // ─── 1. Cancelar debounce activo ───
    const cancelResult = cancelDebounce(leadInfo.leadId)
    if (cancelResult.cancelled) {
      console.log(`[EventRouter] Cancelled debounce for lead ${leadInfo.leadId} (had ${cancelResult.bufferSize} buffered)`)
    }

    // ─── 2. Marcar lead_state.currentMode = HUMAN_ACTIVE ───
    await prisma.leadState.updateMany({
      where: { leadId: leadInfo.leadId },
      data: {
        currentMode: MODES.HUMAN_ACTIVE,
        modeEnteredAt: new Date()
      }
    })

    console.log(`[EventRouter] Lead ${leadInfo.leadId} marked as HUMAN_ACTIVE`)

    // ─── 3. TODO: guardar Message en BD con origen='VENDEDOR' ───

    return buildResponse('vendor_message_handled', startTime, {
      leadId: leadInfo.leadId,
      debounceCancelled: cancelResult.cancelled,
      bufferSizeAtCancel: cancelResult.bufferSize,
      modeSetTo: 'HUMAN_ACTIVE'
    })

  } catch (err) {
    console.error(`[EventRouter] Error handling vendor message:`, err.message)
    return buildErrorResponse('vendor_message_handler_failed', startTime, {
      leadId: leadInfo.leadId,
      error: err.message
    })
  }
}

// ════════════════════════════════════════════════════════
// HANDLER — messages.update
// ════════════════════════════════════════════════════════

async function handleMessagesUpdate(payload, startTime) {
  console.log(`[EventRouter] messages.update event (log only, no action)`)
  return buildResponse('messages_update_logged', startTime, {})
}

// ════════════════════════════════════════════════════════
// HANDLER — connection.update
// ════════════════════════════════════════════════════════

async function handleConnectionUpdate(payload, startTime) {
  const state = payload?.data?.state || 'unknown'
  const instance = payload?.data?.instance || payload?.instance || 'unknown'

  switch (state) {
    case 'open':
      console.log(`[EventRouter] ✅ Connection OPEN for instance ${instance}`)
      break
    case 'close':
      console.error(`[EventRouter] 🔴 Connection CLOSED for instance ${instance} - vendor must reconnect`)
      break
    case 'connecting':
      console.log(`[EventRouter] 🟡 Connection connecting for instance ${instance}`)
      break
    default:
      console.warn(`[EventRouter] Unknown connection state "${state}" for instance ${instance}`)
  }

  return buildResponse('connection_update_logged', startTime, { state, instance })
}

// ════════════════════════════════════════════════════════
// HANDLER — send.message
// ════════════════════════════════════════════════════════

async function handleSendMessage(payload, startTime) {
  const data = payload?.data || {}
  const isArrayStructure = Array.isArray(data.messages) && data.messages.length > 0
  const msgEnvelope = isArrayStructure ? data.messages[0] : data
  const messageId = msgEnvelope?.key?.id || 'unknown'
  const remoteJid = msgEnvelope?.key?.remoteJid || 'unknown'

  console.log(`[EventRouter] ✉️ send.message confirmed: ${messageId} → ${remoteJid}`)

  return buildResponse('send_message_logged', startTime, { messageId, remoteJid })
}

// ════════════════════════════════════════════════════════
// HANDLER — logout.instance
// ════════════════════════════════════════════════════════

async function handleLogoutInstance(payload, startTime) {
  const instance = payload?.data?.instance || payload?.instance || 'unknown'

  console.error(`[EventRouter] 🚨 LOGOUT_INSTANCE for ${instance} - VENDOR ACTION REQUIRED: rescan QR`)

  return buildResponse('logout_instance_alerted', startTime, {
    instance,
    severity: 'critical',
    action_required: 'rescan_qr'
  })
}

// ════════════════════════════════════════════════════════
// HANDLER — qrcode.updated
// ════════════════════════════════════════════════════════

async function handleQrcodeUpdated(payload, startTime) {
  const instance = payload?.data?.instance || payload?.instance || 'unknown'

  console.log(`[EventRouter] 📱 QR code updated for ${instance} - vendor can scan to connect`)

  return buildResponse('qrcode_updated_logged', startTime, { instance })
}

// ════════════════════════════════════════════════════════
// HANDLER — Unknown event
// ════════════════════════════════════════════════════════

async function handleUnknownEvent(eventType, payload, startTime) {
  console.warn(`[EventRouter] Unknown event type: ${eventType}`)
  return buildResponse('unknown_event_skipped', startTime, { eventType })
}

// ════════════════════════════════════════════════════════
// HELPERS — Extracción de direccionamiento y contexto de anuncio
// ════════════════════════════════════════════════════════

/**
 * Extrae los identificadores de direccionamiento del payload.
 * Distintas versiones de Evolution los ponen en sitios distintos → defensivo.
 *
 * @returns {{ remoteJid, remoteJidAlt, senderPn, addressingMode }}
 */
function extractAddressing(key, msgEnvelope, data) {
  return {
    remoteJid: key.remoteJid || null,
    remoteJidAlt: key.remoteJidAlt || null,
    senderPn:
      msgEnvelope?.senderPn ||
      data?.senderPn ||
      key?.senderPn ||
      null,
    addressingMode: key.addressingMode || null
  }
}

/**
 * Extrae el contexto de anuncio CTWA (click-to-WhatsApp / Meta Ads) del mensaje.
 * Lo consume el Campaign Resolver (paso 1b): Plan B (adReplyTitle) y Plan D
 * (conversionSource). Aquí solo se extrae y se pasa.
 *
 * @returns {object|null}
 */
function extractAdContext(message) {
  const ctx =
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    null

  if (!ctx) return null

  const ext = ctx.externalAdReply || null

  return {
    adReplyTitle: ext?.title || null,
    adReplyBody: ext?.body || null,
    sourceId: ext?.sourceId || null,
    sourceUrl: ext?.sourceUrl || null,
    conversionSource: ctx.conversionSource || null,
    entryPointConversionApp: ctx.entryPointConversionApp || null,
    hasAdContext: !!(ext || ctx.conversionSource)
  }
}

// ════════════════════════════════════════════════════════
// HELPERS — Detección de tipo de mensaje y texto
// ════════════════════════════════════════════════════════

function detectMessageType(message) {
  if (!message || typeof message !== 'object') return 'unknown'

  if (message.conversation) return 'text'
  if (message.extendedTextMessage) return 'text'
  if (message.audioMessage) return 'audio'
  if (message.imageMessage) return 'image'
  if (message.videoMessage) return 'video'
  if (message.documentMessage) return 'document'
  if (message.stickerMessage) return 'sticker'
  if (message.locationMessage) return 'location'
  if (message.contactMessage) return 'contact'

  return 'unknown'
}

function extractText(message) {
  if (!message || typeof message !== 'object') return ''

  if (typeof message.conversation === 'string') {
    return message.conversation.trim()
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text.trim()
  }

  return ''
}

// ════════════════════════════════════════════════════════
// HELPERS — Response builders
// ════════════════════════════════════════════════════════

function buildResponse(action, startTime, metadata = {}) {
  return {
    ok: true,
    handled: true,
    action,
    metadata,
    latency_ms: Date.now() - startTime
  }
}

function buildErrorResponse(errorCode, startTime, metadata = {}) {
  return {
    ok: false,
    handled: false,
    error: errorCode,
    metadata,
    latency_ms: Date.now() - startTime
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen para logs
// ════════════════════════════════════════════════════════

export function summarizeEventResult(result) {
  if (!result) return 'no result'

  if (!result.ok) {
    return `❌ event error: ${result.error} (${result.latency_ms}ms)`
  }

  return `✅ ${result.action} (${result.latency_ms}ms)`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const EVENT_ROUTER_VERSION = 'v3_sprint2_lid_extract'
