// src/whatsapp/cloud/parser.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Traduce el webhook de Meta (entry[].changes[].value) a una lista NORMALIZADA de
// eventos que el cableado (event-router cloud) consume. El formato de Meta es
// COMPLETAMENTE distinto al de Evolution; este parser es el puente.
//
// Estructura Meta del webhook entrante:
//   { object:"whatsapp_business_account", entry:[{ id, changes:[{ field:"messages",
//     value:{ metadata:{phone_number_id, display_phone_number}, contacts:[{wa_id, profile:{name}}],
//             messages:[{from,id,timestamp,type,text:{body},image:{id,caption},...}],
//             statuses:[{id,status,recipient_id,...}] } }] }] }
//
// Salida (por evento): { tipo:'message'|'status', telefono, pushName, messageId,
//   messageType, text, mediaId, caption, timestamp, phoneNumberId, adContext }.
// El caption de una imagen se mapea a `text` (mismo criterio que el fix de Evolution:
// imagen con pie de foto va al cerebro como texto).

export function parseCloudWebhook(payload) {
  const eventos = []
  if (payload?.object !== 'whatsapp_business_account') return eventos

  for (const entry of (payload.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'messages') continue
      const value = change.value || {}
      const phoneNumberId = value.metadata?.phone_number_id || null

      // nombre del contacto (pushName) por wa_id y por BSUID. Desde 2026 un usuario con
      // username puede llegar SIN wa_id: solo con su BSUID (contacts[].user_id).
      const nameByWaId = {}
      const nameByBsuid = {}
      for (const ct of (value.contacts || [])) {
        if (ct.wa_id) nameByWaId[ct.wa_id] = ct.profile?.name || null
        if (ct.user_id) nameByBsuid[ct.user_id] = ct.profile?.name || null
      }

      // statuses = recibos (delivered/read/failed) de mensajes que NOSOTROS enviamos.
      // No son del lead; se exponen para auditoría/logs, el cableado decide si los usa.
      for (const st of (value.statuses || [])) {
        eventos.push({
          tipo: 'status', messageId: st.id, status: st.status,
          telefono: st.recipient_id || null, bsuid: st.recipient_user_id || null,
          timestamp: st.timestamp, phoneNumberId
        })
      }

      // messages = entrantes del usuario (el lead)
      for (const m of (value.messages || [])) {
        const ev = {
          tipo: 'message',
          telefono: m.from || null,          // wa_id del usuario (solo dígitos, sin '+'); puede faltar si usa username
          bsuid: m.from_user_id || null,     // ID del usuario para ESTE negocio (ej. "PE.8f3a..."); llega desde abr-2026
          pushName: (m.from && nameByWaId[m.from]) || (m.from_user_id && nameByBsuid[m.from_user_id]) || null,
          messageId: m.id || null,
          messageType: m.type || 'unknown',
          text: null,
          mediaId: null,
          caption: null,
          timestamp: m.timestamp || null,
          phoneNumberId,
          adContext: contextoDeAnuncio(m.referral)
        }

        switch (m.type) {
          case 'text':
            ev.text = m.text?.body || ''
            break
          case 'image':
            ev.mediaId = m.image?.id || null
            ev.caption = m.image?.caption || null
            if (ev.caption) ev.text = ev.caption  // imagen con pie → texto al cerebro
            break
          case 'document':
            ev.mediaId = m.document?.id || null
            ev.caption = m.document?.caption || null
            if (ev.caption) ev.text = ev.caption
            break
          case 'video':
            ev.mediaId = m.video?.id || null
            ev.caption = m.video?.caption || null
            if (ev.caption) ev.text = ev.caption
            break
          case 'audio':
            ev.mediaId = m.audio?.id || null   // nota de voz → el router la transcribe con Whisper
            break
          case 'interactive':                  // respuesta a botón/lista
            ev.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ''
            break
          case 'button':                       // respuesta a template con botón
            ev.text = m.button?.text || ''
            break
          // location, contacts, sticker, reaction... → sin texto; messageType lo marca
        }
        eventos.push(ev)
      }
    }
  }
  return eventos
}

/**
 * El primer mensaje de alguien que tocó "Enviar mensaje" en un anuncio (Click-to-WhatsApp)
 * trae `referral`: titular y texto del anuncio, su ID y el ctwa_clid del clic. Se traduce
 * a la MISMA forma que extractAdContext() de Evolution para que el Campaign Resolver
 * (Plan B: titular del anuncio → campaña) funcione igual con los dos proveedores.
 */
export function contextoDeAnuncio(referral) {
  if (!referral || typeof referral !== 'object') return null
  return {
    adReplyTitle: referral.headline || null,
    adReplyBody: referral.body || null,
    sourceId: referral.source_id || null,        // ID del anuncio (o del post)
    sourceUrl: referral.source_url || null,
    sourceType: referral.source_type || null,    // 'ad' | 'post'
    ctwaClid: referral.ctwa_clid || null,        // ID del clic: lo pide la Conversions API de Meta
    conversionSource: referral.source_type === 'ad' ? 'FB_Ads' : (referral.source_type || null),
    hasAdContext: true
  }
}

/** Extrae solo los mensajes entrantes (descarta statuses). Atajo para el cableado. */
export function soloMensajes(payload) {
  return parseCloudWebhook(payload).filter(e => e.tipo === 'message')
}

export const CLOUD_PARSER_VERSION = 'v3_bsuid_referral'
