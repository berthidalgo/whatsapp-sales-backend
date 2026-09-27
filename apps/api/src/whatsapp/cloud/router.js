// src/whatsapp/cloud/router.js — WhatsApp Cloud API (Meta) → el MISMO turno del bot
//
// Toma el webhook de Meta ya verificado (firma HMAC en server.js), lo normaliza
// (parser) y mete cada mensaje al pipeline ÚNICO del bot: debounce → turno
// (webhook/handler.js → procesarTurno) → envío por el transporte del canal.
//
// REESCRITO (sep 2026). La versión anterior:
//   · no sabía de qué cliente era el número (todo caía al tenant por defecto),
//   · tenía su propia copia de la segunda mitad del turno, sin kill-stale, sin lock y
//     sin la foto de precios del Momento 4,
//   · ignoraba audios y fotos.
// Ahora el tenant sale del canal (phone_number_id → channels), igual que con Evolution,
// y audios/fotos se convierten en texto antes de entrar al cerebro (mismo patrón que
// event-router.js: una foto descrita es un mensaje más y hereda debounce, lock y memoria).

import prisma from '../../db/prisma.js'
import { resolveLead } from '../../webhook/lead-resolver.js'
import { enqueueMessage } from '../../webhook/debounce.js'
import { checkAndMark } from '../../webhook/idempotency.js'
import { resolveChannel, tenantAtiende, summarizeChannelResolution } from '../../webhook/channel-resolver.js'
import { procesarTurno } from '../../webhook/handler.js'
import { MODES } from '../../state/stage-definitions.js'
import { verticalPorTenant } from '../../lib/tenant.js'
import { describirImagen } from '../../lib/vision.js'
import { saveInboundMedia } from '../../lib/mediaStore.js'
import { transcribirAudio } from '../../lib/groq.js'
import { enviarTexto, credencialesCloud } from '../transporte.js'
import { parseCloudWebhook } from './parser.js'
import { descargarMediaCloud } from './media.js'

export async function procesarWebhookCloud(payload) {
  const eventos = parseCloudWebhook(payload)
  let queued = 0, skipped = 0, errores = 0
  for (const ev of eventos) {
    if (ev.tipo !== 'message') continue   // statuses (entregado/leído/falló) no son del lead
    try {
      const r = await procesarMensajeCloud(ev)
      if (r.queued) queued++
      else { skipped++; if (r.reason) console.log(`[CloudRouter] mensaje ${ev.messageId} sin procesar: ${r.reason}`) }
    } catch (e) {
      errores++
      console.error(`[CloudRouter] error en mensaje ${ev.messageId}:`, e.message)
    }
  }
  if (queued || skipped || errores) {
    console.log(`[CloudRouter] webhook | encolados=${queued} omitidos=${skipped} errores=${errores}`)
  }
  return { ok: true, queued, skipped, errores }
}

/**
 * Decide qué hacer con un mensaje entrante de Meta. Exportada para tests: todas las
 * dependencias con efectos se pueden inyectar.
 */
export async function procesarMensajeCloud(ev, deps = {}) {
  const d = {
    checkAndMark, resolveChannel, tenantAtiende, resolveLead, enqueueMessage, procesarTurno,
    convertirMediaATexto, responderNoTexto,
    ...deps
  }

  // 1. Meta reintenta webhooks: el mismo mensaje puede llegar dos veces.
  if (ev.messageId && !d.checkAndMark(`cloud:${ev.messageId}`, { provider: 'cloud' })) {
    return { queued: false, reason: 'duplicado' }
  }

  // 2. ¿De qué cliente es el número que recibió el mensaje? (phone_number_id → channels)
  const canal = await d.resolveChannel(ev.phoneNumberId)
  if (canal.resolvedBy === 'active_tenant_fallback' && process.env.ALLOW_TENANT_FALLBACK !== 'true') {
    console.error(`[CloudRouter] ⛔ phone_number_id "${ev.phoneNumberId}" no está en channels → ignorado. Registrá el canal (scripts/canal-cloud.js).`)
    return { queued: false, reason: 'canal_desconocido' }
  }
  const servicio = d.tenantAtiende(canal)
  if (!servicio.atiende) return { queued: false, reason: `tenant_sin_servicio: ${servicio.motivo}` }
  console.log(`[CloudRouter] ${summarizeChannelResolution(canal)}`)

  // 3. Identidad: teléfono si viene; si el usuario usa username, su BSUID.
  const remitente = ev.telefono || ev.bsuid
  if (!remitente) return { queued: false, reason: 'sin_remitente' }
  const resolution = await d.resolveLead({
    remoteJid: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : `${ev.bsuid}@bsuid`,
    senderPn: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : null,
    addressingMode: ev.telefono ? 'pn' : 'bsuid',
    instanceName: ev.phoneNumberId,
    pushName: ev.pushName,
    firstMessageText: ev.text || '',
    tenantId: canal.tenantId
  })
  if (!resolution.ok) return { queued: false, reason: 'lead_resolution_failed' }
  if (resolution.isArchived) return { queued: false, reason: 'lead_archivado' }

  // El canal viaja dentro del turno: el envío sale por ESTE número y con SUS credenciales.
  const leadInfo = { ...resolution, channel: canal, tenantId: canal.tenantId }

  // 4. Audio y foto sin texto → se convierten en texto antes del cerebro.
  let texto = ev.text
  if (!texto && ev.mediaId && (ev.messageType === 'audio' || ev.messageType === 'image')) {
    texto = await d.convertirMediaATexto({ ev, leadInfo })
  }
  if (!texto) {
    await d.responderNoTexto({ ev, leadInfo })
    return { queued: false, reason: `sin_texto (${ev.messageType})` }
  }

  // 5. Mismo camino que Evolution: el debounce agrupa ráfagas y el turno corre una vez.
  const r = d.enqueueMessage({
    leadId: leadInfo.leadId,
    text: texto,
    processFn: (combinedText, meta) => d.procesarTurno(leadInfo, combinedText, meta),
    metadata: { messageId: ev.messageId, messageType: ev.messageType, provider: 'cloud' }
  })
  if (!r?.queued) return { queued: false, reason: `debounce: ${r?.error || 'rechazado'}` }
  return { queued: true, leadId: leadInfo.leadId }
}

// ════════════════════════════════════════════════════════
// AUDIO y FOTO → texto
// ════════════════════════════════════════════════════════
async function convertirMediaATexto({ ev, leadInfo }) {
  try {
    const media = await descargarMediaCloud(ev.mediaId, credencialesCloud(leadInfo.channel))
    if (!media.ok) {
      console.warn(`[CloudRouter] no se pudo descargar ${ev.messageType} del lead ${leadInfo.leadId}: ${media.error}`)
      return null
    }
    if (ev.messageType === 'audio') {
      const tr = await transcribirAudio({
        base64: media.base64, mimeType: media.mimeType || 'audio/ogg', language: 'es',
        vertical: verticalPorTenant(leadInfo.tenantId)
      })
      if (tr.ok && tr.texto) {
        console.log(`[CloudRouter] 🎙️→📝 audio del lead ${leadInfo.leadId} transcrito (${tr.texto.length} chars)`)
        return tr.texto
      }
      return null
    }
    // Foto: se guarda para la bandeja y se describe para el cerebro.
    saveInboundMedia(prisma, {
      leadId: leadInfo.leadId, messageId: null, tenantId: leadInfo.tenantId,
      tipo: 'image', mimeType: media.mimeType, base64: media.base64
    }).catch(e => console.error(`[CloudRouter] persistir imagen lead ${leadInfo.leadId}:`, e.message))
    const d = await describirImagen({ base64: media.base64, mimeType: media.mimeType, tenantId: leadInfo.tenantId })
    return d.ok ? `[el lead envió una foto: ${d.descripcion}]` : null
  } catch (err) {
    console.error(`[CloudRouter] error convirtiendo ${ev.messageType} del lead ${leadInfo.leadId}:`, err.message)
    return null
  }
}

// Lo que no se pudo convertir: se deja registro y, si el bot está a cargo, un acuse
// NEUTRO (sin marca ni vertical) para que el lead no quede sin respuesta. Stickers,
// ubicaciones y reacciones se ignoran en silencio (responderles sería raro).
async function responderNoTexto({ ev, leadInfo }) {
  if (ev.messageType !== 'image' && ev.messageType !== 'audio') return
  const marcador = ev.messageType === 'image' ? '[📷 el lead envió una imagen]' : '[🎙️ el lead envió una nota de voz]'
  try {
    await prisma.message.create({ data: { leadId: leadInfo.leadId, origen: 'LEAD', texto: marcador } })
    const st = await prisma.leadState.findUnique({ where: { leadId: leadInfo.leadId }, select: { currentMode: true } })
    if (st?.currentMode === MODES.HUMAN_ACTIVE || st?.currentMode === MODES.PAUSED) return
    const respuesta = ev.messageType === 'image'
      ? 'Vi tu imagen 🙌 Para ayudarte mejor por aquí, ¿me cuentas por escrito qué necesitas? 😊'
      : 'Disculpa, no pude escuchar bien tu audio 😊 ¿Me lo escribes por aquí?'
    const r = await enviarTexto({ canal: leadInfo.channel, telefono: leadInfo.telefono, texto: respuesta })
    if (r.ok) await prisma.message.create({ data: { leadId: leadInfo.leadId, origen: 'BOT', texto: respuesta } })
  } catch (err) {
    console.error(`[CloudRouter] acuse de no-texto lead ${leadInfo.leadId}:`, err.message)
  }
}

export const CLOUD_ROUTER_VERSION = 'v2_multitenant_mismo_turno'
