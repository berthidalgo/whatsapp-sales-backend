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
import { enqueueMessage, cancelDebounce, invalidarTurnoEnVuelo } from '../../webhook/debounce.js'
import { checkAndMark } from '../../webhook/idempotency.js'
import { resolveChannel, tenantAtiende, summarizeChannelResolution } from '../../webhook/channel-resolver.js'
import { procesarTurno } from '../../webhook/handler.js'
import { MODES } from '../../state/stage-definitions.js'
import { verticalPorTenant } from '../../lib/tenant.js'
import { describirImagen } from '../../lib/vision.js'
import { saveInboundMedia } from '../../lib/mediaStore.js'
import { esPosibleComprobante, escalarAHumano, avisarComprobante, ACUSE_COMPROBANTE } from '../../webhook/comprobante.js'
import { transcribirAudio } from '../../lib/groq.js'
import { enviarTexto, credencialesCloud, persistirMensajeSaliente } from '../transporte.js'
import { parseCloudWebhook } from './parser.js'
import { descargarMediaCloud } from './media.js'
import { procesarStatuses } from './statuses.js'
import { indicarEscribiendo } from './escribiendo.js'
import { describirEventoDePlantilla } from './plantillas-catalogo.js'

export async function procesarWebhookCloud(payload) {
  const eventos = parseCloudWebhook(payload)

  // Los recibos (enviado/entregado/leído/falló) van por su propio carril: no abren un
  // turno del bot, solo marcan la fila del mensaje que YA salió. Antes se descartaban
  // con un `continue` y la bandeja no tenía forma de saber si algo se entregó.
  const recibos = await procesarStatuses(eventos)
  if (recibos.aplicados || recibos.fallidos) {
    console.log(`[CloudRouter] recibos | aplicados=${recibos.aplicados} no_entregados=${recibos.fallidos}`)
  }

  // Avisos de Meta sobre plantillas (aprobada, pausada, recategorizada, calidad): no abren
  // turno ni tocan la base; se registran diciendo QUÉ parte del bot afectan, porque una
  // plantilla pausada no avisa sola — los seguimientos simplemente dejan de salir.
  for (const ev of eventos) {
    if (ev.tipo !== 'plantilla') continue
    const { nivel, linea } = describirEventoDePlantilla(ev)
    console[nivel === 'warn' ? 'warn' : 'log'](`[CloudRouter] ${linea}`)
  }

  // Coexistencia: lo que el dueño contestó desde su celular. No abre turno del bot —
  // al revés, lo calla. Va antes que los mensajes para que si en el mismo webhook viene
  // la pregunta del lead y la respuesta del dueño, el bot ya encuentre el modo en HUMANO.
  for (const ev of eventos) {
    if (ev.tipo !== 'echo') continue
    try {
      const r = await procesarEcho(ev)
      if (!r.guardado && r.reason) console.log(`[CloudRouter] eco ${ev.messageId} sin guardar: ${r.reason}`)
    } catch (e) {
      console.error(`[CloudRouter] error en eco ${ev.messageId}:`, e.message)
    }
  }

  let queued = 0, skipped = 0, errores = 0
  for (const ev of eventos) {
    if (ev.tipo !== 'message') continue
    try {
      // `indicarEscribiendo` solo se inyecta aquí (producción): los tests del router llaman a
      // procesarMensajeCloud con sus propias dependencias y no tocan Meta ni la base.
      const r = await procesarMensajeCloud(ev, { indicarEscribiendo })
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
    manejarMedia, responderNoTexto,
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
  if (ev.adContext?.hasAdContext) {
    console.log(`[CloudRouter] 📢 llegó de un anuncio: "${ev.adContext.adReplyTitle || '(sin titular)'}" (ad ${ev.adContext.sourceId || '?'})`)
  }
  const resolution = await d.resolveLead({
    remoteJid: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : `${ev.bsuid}@bsuid`,
    senderPn: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : null,
    addressingMode: ev.telefono ? 'pn' : 'bsuid',
    instanceName: ev.phoneNumberId,
    pushName: ev.pushName,
    adContext: ev.adContext || null,   // anuncio → campaña (Plan B del Campaign Resolver)
    firstMessageText: ev.text || '',
    tenantId: canal.tenantId
  })
  if (!resolution.ok) return { queued: false, reason: 'lead_resolution_failed' }
  if (resolution.isArchived) return { queued: false, reason: 'lead_archivado' }

  // El canal viaja dentro del turno: el envío sale por ESTE número y con SUS credenciales.
  const leadInfo = { ...resolution, channel: canal, tenantId: canal.tenantId }

  // 3b. «Leído» + «escribiendo…» YA, antes de bajar la media: una nota de voz tarda en
  // descargarse y transcribirse, y es justo cuando más se nota el silencio. Solo para los
  // tipos que siempre reciben respuesta (del cerebro o un acuse). Sin `await` y con todo
  // fallo tragado — incluso uno síncrono —: es de mejor esfuerzo y nunca frena el turno.
  if (TIPOS_CON_RESPUESTA.has(ev.messageType)) {
    try {
      Promise.resolve(d.indicarEscribiendo?.({ messageId: ev.messageId, leadId: leadInfo.leadId, canal })).catch(() => {})
    } catch { /* mejor esfuerzo */ }
  }

  // 4. La media SIEMPRE se baja y se guarda, tenga o no pie de foto.
  //
  // ANTES (bug encontrado al preparar el cutover a Cloud, sep 2026): la condición era
  // `!texto && ev.mediaId`, o sea que si el lead mandaba su captura de Yape CON un pie
  // ("ya pagué 🙏") —el caso más común de todos— los bytes no se descargaban nunca. La
  // foto no entraba a media_assets, no se veía en la bandeja y el cerebro solo leía el
  // pie. El vendedor tenía que pedirle la captura otra vez. Ahora el pie decide quién
  // habla (el texto del lead manda), pero la imagen se guarda igual.
  let texto = ev.text
  let mediaAssetId = null
  if (ev.mediaId && TIPOS_CON_MEDIA.has(ev.messageType)) {
    const r = await d.manejarMedia({ ev, leadInfo, hayTexto: !!texto })
    if (r.escalado) return { queued: false, reason: 'comprobante_escalado', leadId: leadInfo.leadId }
    mediaAssetId = r.mediaAssetId ?? null
    if (!texto) texto = r.texto
  }
  if (!texto) {
    await d.responderNoTexto({ ev, leadInfo, mediaAssetId })
    return { queued: false, reason: `sin_texto (${ev.messageType})` }
  }

  // 5. Mismo camino que Evolution: el debounce agrupa ráfagas y el turno corre una vez.
  const r = d.enqueueMessage({
    leadId: leadInfo.leadId,
    text: texto,
    processFn: (combinedText, meta) => d.procesarTurno(leadInfo, combinedText, meta),
    metadata: { messageId: ev.messageId, messageType: ev.messageType, provider: 'cloud', interactiveId: ev.interactiveId || null }
  })
  if (!r?.queued) return { queued: false, reason: `debounce: ${r?.error || 'rechazado'}` }
  return { queued: true, leadId: leadInfo.leadId }
}

// ════════════════════════════════════════════════════════
// COEXISTENCIA — el dueño contestó desde su celular
// ════════════════════════════════════════════════════════
/**
 * En coexistencia el número vive en la app del celular Y en la nube. Cuando el dueño
 * responde desde su teléfono, Meta nos manda una copia. Hay que hacer dos cosas, y las
 * dos importan:
 *
 *   1. GUARDARLO como VENDEDOR. Si no, la bandeja muestra la pregunta del cliente y
 *      ninguna respuesta — el CRM miente sobre lo que pasó.
 *   2. CALLAR AL BOT. Un humano ya está atendiendo; si el bot contesta también, el
 *      cliente recibe dos respuestas distintas y el negocio queda como un desastre.
 *      Este es el punto donde coexistencia se rompe si no se maneja, y es exactamente
 *      lo que la hace usable cuando sí se maneja: el dueño toma el chat sin avisar a
 *      nadie, solo escribiendo desde su celular como siempre.
 *
 * Exportada para test: las dependencias con efectos se inyectan.
 */
export async function procesarEcho(ev, deps = {}) {
  const d = { checkAndMark, resolveChannel, tenantAtiende, resolveLead, cancelDebounce, invalidarTurnoEnVuelo, persistirMensajeSaliente, prisma, ...deps }

  if (ev.messageId && !d.checkAndMark(`cloud-echo:${ev.messageId}`, { provider: 'cloud' })) {
    return { guardado: false, reason: 'duplicado' }
  }

  const canal = await d.resolveChannel(ev.phoneNumberId)
  if (canal.resolvedBy === 'active_tenant_fallback' && process.env.ALLOW_TENANT_FALLBACK !== 'true') {
    return { guardado: false, reason: 'canal_desconocido' }
  }
  const servicio = d.tenantAtiende(canal)
  if (!servicio.atiende) return { guardado: false, reason: `tenant_sin_servicio: ${servicio.motivo}` }

  // El lead es el DESTINATARIO del eco (a quién le escribió el dueño), no el remitente.
  const destinatario = ev.telefono || ev.bsuid
  if (!destinatario) return { guardado: false, reason: 'sin_destinatario' }

  // Si el wamid ya está en la base, este eco es de un mensaje que mandamos NOSOTROS por
  // la API: ya está guardado y con su recibo. Guardarlo otra vez lo duplicaría.
  if (ev.messageId) {
    const ya = await d.prisma.message.findUnique({ where: { waMessageId: ev.messageId }, select: { id: true } })
    if (ya) return { guardado: false, reason: 'ya_persistido' }
  }

  const resolution = await d.resolveLead({
    remoteJid: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : `${ev.bsuid}@bsuid`,
    senderPn: ev.telefono ? `${ev.telefono}@s.whatsapp.net` : null,
    addressingMode: ev.telefono ? 'pn' : 'bsuid',
    instanceName: ev.phoneNumberId,
    pushName: null,
    firstMessageText: '',
    tenantId: canal.tenantId
  })
  if (!resolution.ok) return { guardado: false, reason: 'lead_resolution_failed' }

  const leadId = resolution.leadId
  const texto = ev.text || MARCADORES[ev.messageType] || `[el vendedor envió ${ev.messageType} desde el celular]`

  // El eco puede ser el primer contacto, antes de que exista lead_state.
  // Tomar control antes de guardar el historial conserva el takeover si ese insert falla.
  const humano = { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() }
  await d.prisma.leadState.upsert({
    where: { leadId }, update: humano, create: { leadId, ...humano },
  })
  ;(deps.invalidarTurnoEnVuelo || deps.cancelDebounce || invalidarTurnoEnVuelo)(leadId)
  await d.persistirMensajeSaliente(d.prisma, {
    data: { leadId, origen: 'VENDEDOR', texto },
    resultado: { messageId: ev.messageId || null, provider: 'cloud', phoneNumberId: ev.phoneNumberId },
    canal, tenantId: canal.tenantId,
  })

  console.log(`[CloudRouter] 📱 el dueño contestó al lead ${leadId} desde su celular → bot en pausa`)
  return { guardado: true, leadId }
}

// ════════════════════════════════════════════════════════
// MEDIA — se guarda siempre; se convierte a texto solo si hace falta
// ════════════════════════════════════════════════════════
// Tipos que traen media_id descargable. Stickers, ubicaciones y reacciones quedan
// fuera a propósito: no aportan nada a la bandeja y guardarlos es puro peso.
const TIPOS_CON_MEDIA = new Set(['image', 'audio', 'document', 'video'])

// Tipos a los que el bot SIEMPRE contesta algo (respuesta del cerebro o acuse neutro de
// responderNoTexto). Solo para esos se muestra «escribiendo…»: stickers, reacciones,
// ubicaciones o contactos se quedan sin respuesta, y un «escribiendo…» que no termina en
// nada es justo lo que Meta pide evitar.
const TIPOS_CON_RESPUESTA = new Set(['text', 'interactive', 'button', ...TIPOS_CON_MEDIA])

// Marcadores del timeline. El front los reconoce para no repetir el texto sobre la
// media que ya renderiza (ver esMarcadorMedia en Conversation.tsx).
const MARCADORES = {
  image:    '[📷 el lead envió una imagen]',
  audio:    '[🎙️ el lead envió una nota de voz]',
  document: '[📄 el lead envió un documento]',
  video:    '[🎬 el lead envió un video]'
}

/**
 * Baja la media una sola vez y decide qué hacer con ella.
 * Devuelve { texto, mediaAssetId, escalado }:
 *   · texto        — lo que entra al cerebro si el lead no escribió nada.
 *   · mediaAssetId — para colgar la media del mensaje marcador (si no hubo texto).
 *   · escalado     — true si era el comprobante de pago: el turno NO sigue al cerebro.
 */
async function manejarMedia({ ev, leadInfo, hayTexto }) {
  const vacio = { texto: null, mediaAssetId: null, escalado: false }
  try {
    const media = await descargarMediaCloud(ev.mediaId, credencialesCloud(leadInfo.channel))
    if (!media.ok) {
      console.warn(`[CloudRouter] no se pudo descargar ${ev.messageType} del lead ${leadInfo.leadId}: ${media.error}`)
      return vacio
    }

    // El comprobante de pago tiene camino propio: no es conversación, es un evento
    // operativo que escala a un humano. Misma regla que Evolution (webhook/comprobante.js);
    // antes este camino no existía en Meta y el pago pasaba de largo como una foto más.
    if (ev.messageType === 'image' && await esPosibleComprobante(prisma, leadInfo.leadId)) {
      return await escalarComprobante({ ev, leadInfo, media })
    }

    // Guardar SIEMPRE: la bandeja es el nuevo CRM, lo que no se guarda no existe.
    const guardada = await saveInboundMedia(prisma, {
      leadId: leadInfo.leadId, messageId: null, tenantId: leadInfo.tenantId,
      tipo: ev.messageType, mimeType: media.mimeType, base64: media.base64
    })
    if (!guardada.ok) console.warn(`[CloudRouter] media del lead ${leadInfo.leadId} no persistida: ${guardada.error}`)
    const mediaAssetId = guardada.id ?? null

    // Si el lead ya escribió (pie de foto / caption), ESE es su mensaje: la media queda
    // guardada y visible, pero no se gasta un LLM en describir lo que él ya explicó.
    if (hayTexto) return { texto: null, mediaAssetId, escalado: false }

    if (ev.messageType === 'audio') {
      const tr = await transcribirAudio({
        base64: media.base64, mimeType: media.mimeType || 'audio/ogg', language: 'es',
        vertical: verticalPorTenant(leadInfo.tenantId)
      })
      if (tr.ok && tr.texto) {
        console.log(`[CloudRouter] 🎙️→📝 audio del lead ${leadInfo.leadId} transcrito (${tr.texto.length} chars)`)
        return { texto: tr.texto, mediaAssetId, escalado: false }
      }
      return { texto: null, mediaAssetId, escalado: false }
    }

    if (ev.messageType === 'image') {
      const desc = await describirImagen({ base64: media.base64, mimeType: media.mimeType, tenantId: leadInfo.tenantId })
      return { texto: desc.ok ? `[el lead envió una foto: ${desc.descripcion}]` : null, mediaAssetId, escalado: false }
    }

    // Documento y video: no se leen (todavía), pero YA no desaparecen — quedan en la
    // bandeja con su marcador y el vendedor puede abrirlos.
    return { texto: null, mediaAssetId, escalado: false }
  } catch (err) {
    console.error(`[CloudRouter] error manejando ${ev.messageType} del lead ${leadInfo.leadId}:`, err.message)
    return vacio
  }
}

// El comprobante: acusar recibo, guardar la imagen colgada de su marcador, callar al
// bot y avisar al vendedor con los datos leídos. El escalamiento es lo único síncrono.
async function escalarComprobante({ ev, leadInfo, media }) {
  const leadId = leadInfo.leadId
  const st = await prisma.leadState.findUnique({ where: { leadId } })

  let marcadorId = null
  try {
    const m = await prisma.message.create({ data: { leadId, origen: 'LEAD', texto: MARCADORES.image } })
    marcadorId = m.id
  } catch (err) {
    console.error(`[CloudRouter] marcador de comprobante lead ${leadId}:`, err.message)
  }

  saveInboundMedia(prisma, {
    leadId, messageId: marcadorId, tenantId: leadInfo.tenantId,
    tipo: 'image', mimeType: media.mimeType, base64: media.base64
  }).catch(e => console.error(`[CloudRouter] persistir comprobante lead ${leadId}:`, e.message))

  // Lo crítico primero: el bot se calla pase lo que pase con el resto.
  await escalarAHumano(prisma, leadId)

  if (st?.currentMode !== MODES.HUMAN_ACTIVE && st?.currentMode !== MODES.PAUSED) {
    const r = await enviarTexto({ canal: leadInfo.channel, telefono: leadInfo.telefono, texto: ACUSE_COMPROBANTE })
    if (r.ok) {
      await persistirMensajeSaliente(prisma, { data: { leadId, origen: 'BOT', texto: ACUSE_COMPROBANTE }, resultado: r, canal: leadInfo.channel, tenantId: leadInfo.tenantId })
        .catch(e => console.error(`[CloudRouter] persistir acuse lead ${leadId}:`, e.message))
    }
  }

  // Lectura + aviso al vendedor: lento (modelo multimodal) y no crítico → en segundo plano.
  avisarComprobante({
    leadId, telefono: leadInfo.telefono,
    nombre: st?.slotsFilled?.nombre || leadInfo.nombreDetectado || null,
    slots: st?.slotsFilled || {}, vendorId: leadInfo.vendorId || 1,
    stage: st?.currentStage, tenantId: leadInfo.tenantId,
    base64: media.base64, mimeType: media.mimeType
  }).catch(e => console.error(`[CloudRouter] aviso de comprobante lead ${leadId}:`, e.message))

  console.log(`[CloudRouter] 🚨 Posible COMPROBANTE del lead ${leadId} (stage=${st?.currentStage}) → escalado a HUMAN_ACTIVE`)
  return { texto: null, mediaAssetId: null, escalado: true }
}

// Lo que no se pudo convertir: se deja registro y, si el bot está a cargo, un acuse
// NEUTRO (sin marca ni vertical) para que el lead no quede sin respuesta. Stickers,
// ubicaciones y reacciones se ignoran en silencio (responderles sería raro).
async function responderNoTexto({ ev, leadInfo, mediaAssetId = null }) {
  const marcador = MARCADORES[ev.messageType]
  if (!marcador) return
  try {
    const msg = await prisma.message.create({ data: { leadId: leadInfo.leadId, origen: 'LEAD', texto: marcador } })
    // Colgar la media de su marcador: así el Inbox la pinta DENTRO de la burbuja y no
    // como un adjunto huérfano ubicado solo por su hora.
    if (mediaAssetId) {
      await prisma.mediaAsset.update({ where: { id: mediaAssetId }, data: { messageId: msg.id } })
        .catch(e => console.error(`[CloudRouter] linkear media ${mediaAssetId}:`, e.message))
    }
    const st = await prisma.leadState.findUnique({ where: { leadId: leadInfo.leadId }, select: { currentMode: true } })
    if (st?.currentMode === MODES.HUMAN_ACTIVE || st?.currentMode === MODES.PAUSED) return
    const respuesta = ev.messageType === 'image'
      ? 'Vi tu imagen 🙌 Para ayudarte mejor por aquí, ¿me cuentas por escrito qué necesitas? 😊'
      : ev.messageType === 'audio'
        ? 'Disculpa, no pude escuchar bien tu audio 😊 ¿Me lo escribes por aquí?'
        : 'Lo recibí 🙌 Por aquí solo puedo leer mensajes escritos, ¿me cuentas qué necesitas? 😊'
    const r = await enviarTexto({ canal: leadInfo.channel, telefono: leadInfo.telefono, texto: respuesta })
    if (r.ok) await persistirMensajeSaliente(prisma, { data: { leadId: leadInfo.leadId, origen: 'BOT', texto: respuesta }, resultado: r, canal: leadInfo.channel, tenantId: leadInfo.tenantId })
  } catch (err) {
    console.error(`[CloudRouter] acuse de no-texto lead ${leadInfo.leadId}:`, err.message)
  }
}

export const CLOUD_ROUTER_VERSION = 'v3_media_siempre_guardada_y_comprobante'
