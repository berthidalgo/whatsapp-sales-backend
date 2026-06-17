// src/whatsapp/cloud/router.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Recepción: toma el webhook de Meta, lo normaliza (parser) y rutea cada mensaje al
// MISMO pipeline que Evolution — reusa resolveLead + debounce + procesarConCerebro,
// sin duplicar la lógica del cerebro. Es el equivalente Cloud de event-router.js.
//
// Cubre el flujo PRINCIPAL (texto → cerebro). El manejo de media (comprobante con
// vision) y el handoff del vendedor vía Coexistence quedan marcados para conectar al
// enchufar el número (requieren credenciales reales para validar de verdad).

import { resolveLead } from '../../webhook/lead-resolver.js'
import { enqueueMessage } from '../../webhook/debounce.js'
import { procesarConCerebro } from '../../brain/brain-pipeline.js'
import { parseCloudWebhook } from './parser.js'
import { sendToWhatsAppCloud } from './sender.js'
import prisma from '../../db/prisma.js'

export async function procesarWebhookCloud(payload) {
  const eventos = parseCloudWebhook(payload)
  let queued = 0, skipped = 0, errores = 0
  for (const ev of eventos) {
    if (ev.tipo !== 'message') continue   // statuses (recibos delivered/read) se ignoran
    try {
      const r = await procesarMensajeCloud(ev)
      if (r.queued) queued++
      else skipped++
    } catch (e) {
      errores++
      console.error(`[CloudRouter] error en mensaje ${ev.messageId}:`, e.message)
    }
  }
  console.log(`[CloudRouter] webhook procesado | queued=${queued} skipped=${skipped} errores=${errores}`)
  return { ok: true, queued, skipped, errores }
}

async function procesarMensajeCloud(ev) {
  // Cloud usa números normales (no @lid de Evolution): el wa_id ES el teléfono.
  const resolution = await resolveLead({
    remoteJid: `${ev.telefono}@s.whatsapp.net`,
    senderPn: ev.telefono,
    addressingMode: 'pn',
    instanceName: ev.phoneNumberId || 'cloud',
    pushName: ev.pushName,
    firstMessageText: ev.text || ''
  })
  if (!resolution.ok) return { queued: false, reason: 'lead_resolution_failed' }
  const { leadId, telefono } = resolution

  // Sin texto (audio, o imagen sin caption): el comprobante con vision se conecta al
  // enchufar el número (media.js descarga vía Graph + vision.js lee). El núcleo enruta texto.
  if (!ev.text) {
    return { queued: false, reason: 'no_text', messageType: ev.messageType, mediaId: ev.mediaId }
  }

  // Mismo camino que Evolution: debounce agrupa ráfagas y el cerebro corre una vez.
  // CIERRA EL LAZO (fix 2026-06-17): procesarConCerebro CALCULA la respuesta pero NO
  // la envía ni persiste el msg del BOT — en el path Evolution esa segunda mitad la
  // hace handler.js (processPipelineFn: send + persist). Llamando al cerebro directo
  // había que replicarla aquí, o el lead en Cloud quedaría MUDO y el historial roto.
  enqueueMessage({
    leadId,
    text: ev.text,
    processFn: async (combinedText) => {
      const resultado = await procesarConCerebro({
        leadId, telefono, mensajeActual: combinedText,
        tenantId: resolution.tenantId, vendorNombre: resolution.vendorNombre
      })
      await enviarYPersistir(leadId, telefono, resultado)
    },
    metadata: { messageId: ev.messageId, messageType: ev.messageType, provider: 'cloud' }
  })
  return { queued: true, leadId }
}

// Segunda mitad del turno (la que en Evolution vive en handler.js processPipelineFn):
// envía la respuesta del cerebro POR CLOUD + persiste el msg del BOT. Mismos guards
// que el handler: si el cerebro calló (compuerta de modo / sin texto) no se envía; el
// msg del BOT solo se persiste si el envío fue OK (un no-entregado no entra al historial).
async function enviarYPersistir(leadId, telefono, resultado) {
  if (!resultado?.ok) {
    console.error(`[CloudRouter] cerebro no produjo respuesta lead ${leadId}: ${resultado?.error || 'desconocido'}`)
    return
  }
  const botResponse = resultado.botResponse
  if (!botResponse || !botResponse.bot_responded || !botResponse.text) {
    console.log(`[CloudRouter] 🔇 sin envío lead ${leadId}: ${botResponse?.generation?.reason || 'sin respuesta'}`)
    return
  }
  const sendResult = await sendToWhatsAppCloud({ telefono, text: botResponse.text })
  if (sendResult.ok) {
    console.log(`[CloudRouter] ✅ enviado a ${telefono} (${botResponse.text.length} chars, ${sendResult.latency_ms}ms)`)
    try {
      await prisma.message.create({ data: { leadId, origen: 'BOT', texto: botResponse.text } })
    } catch (err) {
      console.error(`[CloudRouter] no se pudo persistir msg BOT lead ${leadId}:`, err.message)
    }
  } else {
    console.error(`[CloudRouter] ❌ envío Cloud falló lead ${leadId}: ${sendResult.error} ${sendResult.errors?.join(' | ') || ''}`)
  }
}

export const CLOUD_ROUTER_VERSION = 'v1_cloud_to_pipeline'
