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
// Salida (por evento): { tipo:'message'|'status'|'echo'|'plantilla', telefono, pushName, messageId,
//   messageType, text, mediaId, caption, interactiveId, timestamp, phoneNumberId, adContext }.
// Los avisos de plantillas (tipo 'plantilla') tienen su propia forma: ver eventoDePlantilla().
// El caption de una imagen se mapea a `text` (mismo criterio que el fix de Evolution:
// imagen con pie de foto va al cerebro como texto).
//
// ── COEXISTENCIA (sep 2026) ──
// En coexistencia el número vive a la vez en la app del celular y en la nube. Cuando el
// dueño contesta DESDE SU CELULAR, Meta nos manda una copia por el campo `message_echoes`.
// Eso NO es un mensaje del lead: si se tratara como tal, el bot le respondería a su propio
// dueño y la bandeja registraría como pregunta del cliente lo que dijo el vendedor. Sale
// como tipo 'echo' y el router lo guarda como VENDEDOR.
//
// Meta cambia estos campos con el tiempo y su documentación va detrás. Por eso lo que no
// reconocemos NO se descarta en silencio: se registra con su forma, para poder adaptarlo
// en cuanto aparezca de verdad en vez de descubrirlo por un hueco en la bandeja.

export function parseCloudWebhook(payload) {
  const eventos = []
  if (payload?.object !== 'whatsapp_business_account') return eventos

  for (const entry of (payload.entry || [])) {
    for (const change of (entry.changes || [])) {
      const value = change.value || {}
      const phoneNumberId = value.metadata?.phone_number_id || null

      // Lo que el dueño escribió desde la app del celular (solo en coexistencia).
      if (Array.isArray(value.message_echoes)) {
        for (const m of value.message_echoes) eventos.push(parsearEcho(m, phoneNumberId))
      }

      // Avisos de Meta sobre las PLANTILLAS de la cuenta (aprobada, pausada, recategorizada,
      // calidad). No son de un cliente: `entry.id` es la cuenta de WhatsApp (WABA).
      const aviso = eventoDePlantilla(change.field, value, entry.id)
      if (aviso) { eventos.push(aviso); continue }

      if (change.field !== 'messages') {
        if (!CAMPOS_CONOCIDOS.has(change.field)) {
          console.log(`[CloudParser] campo no manejado "${change.field}" → claves: ${Object.keys(value).join(', ')}`)
        }
        continue
      }

      // nombre del contacto (pushName) por wa_id y por BSUID. Desde 2026 un usuario con
      // username puede llegar SIN wa_id: solo con su BSUID (contacts[].user_id).
      const nameByWaId = {}
      const nameByBsuid = {}
      for (const ct of (value.contacts || [])) {
        if (ct.wa_id) nameByWaId[ct.wa_id] = ct.profile?.name || null
        if (ct.user_id) nameByBsuid[ct.user_id] = ct.profile?.name || null
      }

      // statuses = recibos (sent/delivered/read/failed) de mensajes que NOSOTROS enviamos.
      // No son del lead, pero son la única prueba de que lo nuestro llegó: los aplica
      // cloud/statuses.js sobre la fila del mensaje, enganchando por el wamid.
      // `errors` viaja entero porque en un failed es lo único que explica POR QUÉ.
      for (const st of (value.statuses || [])) {
        eventos.push({
          tipo: 'status', messageId: st.id, status: st.status,
          telefono: st.recipient_id || null, bsuid: st.recipient_user_id || null,
          timestamp: st.timestamp, phoneNumberId,
          errors: Array.isArray(st.errors) ? st.errors : null
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
          timestamp: m.timestamp || null,
          phoneNumberId,
          adContext: contextoDeAnuncio(m.referral),
          ...contenidoDelMensaje(m)
        }
        eventos.push(ev)
      }
    }
  }
  return eventos
}

// Campos de `changes[].field` que ya sabemos manejar. Lo que no esté aquí se registra
// con su forma en vez de desaparecer: así el primer webhook raro se ve en los logs.
// `history` y `smb_app_state_sync` son de la sincronización inicial de coexistencia
// (Meta manda el historial y los contactos del celular); todavía no los consumimos,
// pero tampoco queremos una línea de ruido por cada uno.
const CAMPOS_CONOCIDOS = new Set([
  'messages', 'message_echoes', 'history', 'smb_app_state_sync', 'smb_message_echoes'
])

// Avisos sobre plantillas. Llegan solo si en la app de Meta se suscriben estos campos del
// webhook (además de `messages`). Formas tomadas de la referencia de webhooks de Meta.
const CAMPOS_DE_PLANTILLA = {
  message_template_status_update: (v) => ({
    cambio: 'estado',
    estado: v.event || null,                 // APPROVED, REJECTED, PAUSED, DISABLED, FLAGGED…
    motivo: v.reason || null,                // NONE, PROMOTIONAL, INVALID_FORMAT, INCORRECT_CATEGORY…
    detalle: v.rejection_info?.reason || v.other_info?.description || v.other_info?.title || null,
    categoria: v.message_template_category || null
  }),
  template_category_update: (v) => ({
    cambio: 'categoria',
    categoriaAnterior: v.previous_category || null,
    categoriaNueva: v.new_category || null,
    categoriaCorrecta: v.correct_category || null,   // solo en el aviso PREVIO al cambio
    desde: v.category_update_timestamp || null
  }),
  message_template_quality_update: (v) => ({
    cambio: 'calidad',
    calidadAnterior: v.previous_quality_score || null,   // GREEN | YELLOW | RED | UNKNOWN
    calidadNueva: v.new_quality_score || null
  })
}

/** Evento normalizado de un aviso de plantilla, o null si el campo no es de plantillas. */
export function eventoDePlantilla(field, value = {}, wabaId = null) {
  const leer = CAMPOS_DE_PLANTILLA[field]
  if (!leer) return null
  return {
    tipo: 'plantilla',
    wabaId: wabaId || null,
    plantillaId: value?.message_template_id != null ? String(value.message_template_id) : null,
    nombre: value?.message_template_name || null,
    idioma: value?.message_template_language || null,
    ...leer(value || {})
  }
}

/**
 * Saca el contenido de un mensaje de Meta, venga de donde venga (del lead o del eco del
 * celular). Devuelve siempre las mismas claves para que el evento tenga forma estable.
 * `interactiveId` es el id que NOSOTROS pusimos en el botón/fila que el cliente tocó (o el
 * payload del botón de una plantilla): identifica la opción sin depender del texto.
 */
export function contenidoDelMensaje(m) {
  const out = { text: null, mediaId: null, caption: null, interactiveId: null }
  switch (m?.type) {
    case 'text':
      out.text = m.text?.body || ''
      break
    case 'image':
      out.mediaId = m.image?.id || null
      out.caption = m.image?.caption || null
      if (out.caption) out.text = out.caption  // imagen con pie → texto al cerebro
      break
    case 'document':
      out.mediaId = m.document?.id || null
      out.caption = m.document?.caption || null
      if (out.caption) out.text = out.caption
      break
    case 'video':
      out.mediaId = m.video?.id || null
      out.caption = m.video?.caption || null
      if (out.caption) out.text = out.caption
      break
    case 'audio':
      out.mediaId = m.audio?.id || null   // nota de voz → el router la transcribe
      break
    case 'interactive':                   // respuesta a botón/lista
      out.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ''
      out.interactiveId = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || null
      break
    case 'button':                        // respuesta a template con botón
      out.text = m.button?.text || ''
      out.interactiveId = m.button?.payload || null
      break
    // location, contacts, sticker, reaction... → sin texto; messageType lo marca
  }
  return out
}

/**
 * Eco de coexistencia: lo que el DUEÑO escribió desde la app de su celular.
 *
 * La diferencia con un mensaje normal es de quién es cada extremo: aquí `from` es el
 * número del negocio y `to` es el cliente. El lead se busca por `to`, no por `from` —
 * confundirlos haría que el negocio se convierta en lead de sí mismo.
 */
export function parsearEcho(m, phoneNumberId = null) {
  return {
    tipo: 'echo',
    telefono: m?.to || m?.recipient_id || null,   // el CLIENTE, no el negocio
    bsuid: m?.to_user_id || null,
    desde: m?.from || null,                        // el número del negocio (informativo)
    pushName: null,
    messageId: m?.id || null,
    messageType: m?.type || 'unknown',
    timestamp: m?.timestamp || null,
    phoneNumberId,
    adContext: null,
    ...contenidoDelMensaje(m)
  }
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

export const CLOUD_PARSER_VERSION = 'v4_interactive_id_y_avisos_de_plantilla'
