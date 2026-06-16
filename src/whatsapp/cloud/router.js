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
  enqueueMessage({
    leadId,
    text: ev.text,
    processFn: async (combinedText) => {
      await procesarConCerebro({
        leadId, telefono, mensajeActual: combinedText,
        tenantId: resolution.tenantId, vendorNombre: resolution.vendorNombre
      })
    },
    metadata: { messageId: ev.messageId, messageType: ev.messageType, provider: 'cloud' }
  })
  return { queued: true, leadId }
}

export const CLOUD_ROUTER_VERSION = 'v1_cloud_to_pipeline'
