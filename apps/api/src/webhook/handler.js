// src/webhook/handler.js — Hidata v20 Día 7
//
// HANDLER PRINCIPAL DEL WEBHOOK (REFACTOR COMPLETO v20)
//
// v19 muerto. v20 puro.
//
// Pipeline completo:
//   1. Recibe POST /webhook desde Evolution API
//   2. Responde 200 OK INMEDIATO (Evolution no espera)
//   3. En background:
//      a. Idempotency check
//      b. Route event al handler correcto
//      c. Para lead messages → encola al debounce (9s)
//      d. Cuando debounce expira → ejecuta pipeline cognitivo
//      e. Si bot debe responder → llama sender (Evolution API)
//
// PROTECCIONES:
//   - Respond first, process after (no bloquea Evolution)
//   - Idempotency con messageId (Map con TTL)
//   - Debounce 9s por leadId (acumula mensajes)
//   - Lock por leadId (previene pipelines en paralelo)
//   - Try/catch en cada nivel (cero crashes)
//
// API:
//   handleWebhook(req, reply, prisma) → Fastify handler

import { timingSafeEqual } from 'node:crypto'
import prisma from '../db/prisma.js'
import { checkAndMark } from './idempotency.js'
import { routeEvent, summarizeEventResult } from './event-router.js'
import { enqueueMessage, getMessageGeneration } from './debounce.js'
import { enviarTexto, enviarImagen, transporteDe } from '../whatsapp/transporte.js'
import { procesarConCerebro, confirmarTurno, descartarTurno } from '../brain/brain-pipeline.js'
import {
  registrarIntencion, confirmarEnvio, marcarRechazado, marcarIncierto, clasificarEnvio,
} from '../whatsapp/outbox.js'
import { ACTIVE_TENANT } from '../lib/tenant.js'
import { getImagen } from '../lib/assets.js'

// ════════════════════════════════════════════════════════
// ESTADO INTERNO — Lock por leadId
// ════════════════════════════════════════════════════════

/**
 * Set de leads cuyo pipeline está actualmente ejecutándose.
 * Previene race conditions cuando llegan mensajes durante procesamiento.
 */
const processingLeads = new Set()

// ════════════════════════════════════════════════════════
// INSTANCIA DE SALIDA — por qué número responde el bot
// ════════════════════════════════════════════════════════
//
// Cascada (de más específico a más general):
//   1. El canal que RECIBIÓ el mensaje  → siempre correcto en multitenant
//   2. La instancia del vendedor dueño  → puente con los datos actuales
//   3. EVOLUTION_INSTANCE_NAME          → compat single-tenant (deploy de hoy)
//
// Ya NO hay fallback a 'peru-exporta-test': un literal con el número de un cliente
// como último recurso significa que, ante cualquier fallo de resolución, los leads
// de OTRO cliente reciben respuesta desde el número equivocado. Prefiero que el
// envío falle ruidosamente a que un cliente vea el número de otro.
export function instanciaDeSalida(leadInfo) {
  const delCanal = leadInfo?.channel?.externalKey
  if (delCanal) return delCanal

  const delVendor = leadInfo?.instanciaEvolution
  if (delVendor) return delVendor

  const delEntorno = process.env.EVOLUTION_INSTANCE_NAME
  if (delEntorno) return delEntorno

  console.error(`[Pipeline] ❌ Sin instancia de salida para lead ${leadInfo?.leadId} (tenant ${leadInfo?.tenantId}) — no se envía. Sembrá un Channel para este tenant.`)
  return null
}

// ════════════════════════════════════════════════════════
// AUTENTICACIÓN DEL WEBHOOK (fix sep 2026)
// ════════════════════════════════════════════════════════
//
// POST /webhook no validaba NADA. Cualquiera con la URL (es pública, está en el repo)
// podía POSTear un "messages.upsert" falso y:
//   · crear leads basura y gastar LLM en cada uno,
//   · hacer que el bot le escribiera a CUALQUIER número desde la línea del cliente
//     (riesgo directo de baneo del número),
//   · mandar fromMe:true y SILENCIAR al bot en la conversación de un lead real.
//
// Ahora: si WEBHOOK_SECRET está configurado, el POST debe traerlo — en el header
// x-webhook-secret (recomendado; Evolution v2 lo manda con webhook.headers), como
// Authorization: Bearer, o como ?secret= en la URL (para versiones de Evolution que no
// soportan headers). Comparación en tiempo constante. Sin la env var, se acepta todo
// y se avisa en el log (compatibilidad mientras se reconfigura la instancia).
export function secretoWebhookValido(req, secreto = process.env.WEBHOOK_SECRET) {
  if (!secreto) return true
  const h = req?.headers || {}
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '')
  const candidatos = [h['x-webhook-secret'], bearer, req?.query?.secret].filter(Boolean).map(String)
  const esperado = Buffer.from(String(secreto))
  return candidatos.some(c => {
    const b = Buffer.from(c)
    return b.length === esperado.length && timingSafeEqual(b, esperado)
  })
}

let avisoSinSecreto = false

// ════════════════════════════════════════════════════════
// API PÚBLICA — handleWebhook()
// ════════════════════════════════════════════════════════

/**
 * Fastify handler para POST /webhook.
 * 
 * IMPORTANTE: responde 200 OK INMEDIATO, procesa en background.
 * Evolution puede hacer retry si timeout > 30s.
 */
export async function handleWebhook(req, reply, prisma) {
  const payload = req.body
  const startTime = Date.now()

  if (!process.env.WEBHOOK_SECRET && !avisoSinSecreto) {
    avisoSinSecreto = true
    console.warn('[Webhook] ⚠️ WEBHOOK_SECRET no configurado: /webhook acepta POST de cualquiera. Configúralo y ponlo en el webhook de la instancia de Evolution.')
  }
  if (!secretoWebhookValido(req)) {
    console.warn(`[Webhook] 🚫 POST rechazado: secreto ausente o inválido (event=${payload?.event || '?'})`)
    return reply.code(401).send({ ok: false, error: 'unauthorized' })
  }

  // ─── Respond INMEDIATO ───
  reply.send({
    ok: true,
    received: true,
    timestamp: new Date().toISOString()
  })

  // ─── Procesar en background ───
  processWebhookAsync(payload, startTime).catch(err => {
    console.error('[Webhook] Background error:', err.message)
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'))
  })
}

// ════════════════════════════════════════════════════════
// PROCESAMIENTO ASYNC (background)
// ════════════════════════════════════════════════════════

async function processWebhookAsync(payload, startTime) {
  try {
    // ─── 1. Validación básica ───
    if (!payload || typeof payload !== 'object') {
      console.warn('[Webhook] Invalid payload received')
      return
    }

    const eventType = payload.event || 'unknown'

    // ─── FIX Día 8: messageId con compatibilidad dual ───
    // Estructura A: data.messages[0].key.id (Evolution v2.3.7 real)
    // Estructura B: data.key.id (tests / otros endpoints)
    const data = payload?.data || {}
    const isArrayStructure = Array.isArray(data.messages) && data.messages.length > 0
    const msgEnvelope = isArrayStructure ? data.messages[0] : data
    const messageId = msgEnvelope?.key?.id || null

    // ─── 2. Idempotency check (solo para messages.upsert) ───
    if (eventType === 'messages.upsert' && messageId) {
      const shouldProcess = checkAndMark(messageId, { eventType })
      
      if (!shouldProcess) {
        console.log(`[Webhook] Duplicate message ${messageId}, skipping`)
        return
      }
    }

    // ─── 3. Route event ───
    const result = await routeEvent(payload, processPipelineFn)

    console.log(`[Webhook] ${eventType}: ${summarizeEventResult(result)} (total: ${Date.now() - startTime}ms)`)

  } catch (err) {
    console.error('[Webhook] processWebhookAsync error:', err.message)
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'))
  }
}

// ════════════════════════════════════════════════════════
// PIPELINE COGNITIVO (callback del debounce)
// ════════════════════════════════════════════════════════

/**
 * Función que el debounce llama cuando expira el timer.
 * Recibe el texto combinado y ejecuta el pipeline cognitivo completo.
 * 
 * @param {object} leadInfo - { leadId, telefono, vendorId, vendorNombre, ... }
 * @param {string} combinedText - Texto combinado de todos los mensajes del buffer
 * @param {object} bufferMetadata - Metadata del debounce (messageCount, etc)
 */
// Exportada (sep 2026): el webhook de Meta (whatsapp/cloud/router.js) corre ESTE mismo
// turno. Antes tenía su propia copia sin kill-stale, sin lock y sin foto de precios.
export { processPipelineFn as procesarTurno }

async function processPipelineFn(leadInfo, combinedText, bufferMetadata) {
  const { leadId, telefono, vendorNombre } = leadInfo
  const pipelineStart = Date.now()

  // ─── Lock check (FIX BUG A, jun 2026) ───
  // Si este lead YA está siendo procesado, NO reintentamos el mismo texto a ciegas
  // (eso causaba respuestas duplicadas/incoherentes: el pipeline viejo terminaba y
  // soltaba su respuesta, y este reintento soltaba OTRA). En su lugar, REENCOLAMOS
  // el texto al debounce: si llegan más mensajes del lead se agrupan, y el pipeline
  // corre UNA sola vez cuando el lock se libere. Determinístico, sin paralelismo.
  if (processingLeads.has(leadId)) {
    console.warn(`[Pipeline] Lead ${leadId} ya en proceso → reencolando al debounce (evita duplicado)`)
    enqueueMessage({
      leadId,
      text: combinedText,
      processFn: (reCombinedText, reMeta) => processPipelineFn(leadInfo, reCombinedText, reMeta),
      metadata: { reenqueuedFromLock: true, originalMeta: bufferMetadata }
    })
    return
  }

  processingLeads.add(leadId)

  // ─── KILL-STALE (Paso 2, anti-cascade) ───
  // Generación del lead al ARRANCAR este turno. Si el lead manda un mensaje nuevo
  // mientras el cerebro piensa (~18s > ventana de debounce de 6s), la generación subirá
  // y, antes de enviar, descartaremos esta respuesta por obsoleta (ver más abajo).
  const genAtStart = getMessageGeneration(leadId)

  try {
    console.log(`[Pipeline] ▶️ Starting for lead ${leadId} (${telefono}): ${bufferMetadata?.messageCount || 1} msg combined (gen ${genAtStart})`)

    let stateResult

    // ═══ Cerebro unificado (única vía) ═══
    // El tenant viene RESUELTO del canal entrante (channel-resolver), no de una env
    // var global. ACTIVE_TENANT queda solo como red de seguridad para webhooks sin
    // instancia identificable.
    const brainStart = Date.now()
    stateResult = await procesarConCerebro({
      leadId,
      telefono,
      mensajeActual: combinedText,
      tenantId: leadInfo.tenantId || ACTIVE_TENANT,
      vendorNombre: leadInfo.vendorNombre || 'asesor'  // el nombre real lo manda config.agente.nombre; sin él, neutro
    })
    console.log(`[Pipeline] Cerebro ${Date.now() - brainStart}ms`)

    if (!stateResult.ok) {
      console.error(`[Pipeline] Cerebro falló para lead ${leadId}: ${stateResult.error}`)
      return
    }

    const botResponse = stateResult.botResponse

    // ─── 4. Decisión de envío ───
    if (!botResponse) {
      console.log(`[Pipeline] No bot response generated for lead ${leadId}`)
      return
    }

    if (!botResponse.bot_responded) {
      console.log(`[Pipeline] 🔇 Silence: ${botResponse.generation?.reason || 'no reason'}`)
      return
    }

    if (!botResponse.text) {
      console.warn(`[Pipeline] bot_responded=true but text is empty for lead ${leadId}`)
      return
    }

    // ─── KILL-STALE: ¿llegó un mensaje nuevo mientras el cerebro pensaba? ───
    // Si la generación subió, el lead siguió escribiendo (varios Enter) → ESTA respuesta
    // quedó OBSOLETA (no leyó lo último que dijo). La DESCARTAMOS sin enviar ni persistir:
    // el mensaje nuevo ya está encolado en el debounce y producirá la respuesta FINAL que
    // lee todo. Así se evita la cascada (2 mensajes seguidos, cada uno con su pregunta).
    //
    // HITO A3: los HECHOS que el lead aportó (su nombre, su distrito, el pedido que
    // pidió) se conservan — se guardaron al recibir el turno. Lo que se descarta es el
    // AVANCE que dependía de que el cliente recibiera ESTA respuesta (subir de etapa,
    // marcar el pedido, avisar al vendedor). Antes ese avance sobrevivía a un descarte y
    // producía ventas fantasma.
    if (getMessageGeneration(leadId) > genAtStart) {
      console.warn(`[Pipeline] Lead ${leadId}: llegó mensaje nuevo mientras el cerebro pensaba (gen ${genAtStart}→${getMessageGeneration(leadId)}) → DESCARTO respuesta obsoleta; responde el turno nuevo (anti-cascade)`)
      if (stateResult.turno?.turnoId) await descartarTurno(prisma, stateResult.turno.leadId, stateResult.turno.turnoId)
        .catch(err => console.error(`[Pipeline] no se pudo descartar el turno obsoleto (lead ${leadId}):`, err.message))
      return
    }

    // ─── 5. Enviar respuesta por el MISMO canal que recibió el mensaje ───
    // Antes: `process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'` — una env
    // var global con el número de UN cliente hardcodeado como fallback. Con dos
    // clientes activos eso respondía a los leads de BIOAYUR desde el número de Perú
    // Exporta. Ahora se responde por la instancia que RECIBIÓ el mensaje: correcto
    // por construcción, sin importar cuántos clientes haya.
    // El canal decide el transporte (Meta o Evolution). La instancia solo aplica a
    // Evolution; en Meta el número de salida es el phone_number_id del canal.
    const canal = leadInfo.channel || null
    const instancia = transporteDe(canal) === 'evolution' ? instanciaDeSalida(leadInfo) : null
    const tenantId = leadInfo.tenantId || ACTIVE_TENANT
    const sendStart = Date.now()

    // ═══ HITO A2 — INTENCIÓN DURABLE ANTES DE ENVIAR ═══
    // Antes se llamaba a Meta y, solo si salía bien, se guardaba el historial. Si el
    // insert fallaba, el cliente tenía el mensaje y la bandeja no: el vendedor veía
    // silencio y el bot podía repetir. Ahora la intención se persiste ANTES. Si esta
    // escritura falla, NO se envía (fallo de BD no confirma trabajo sin guardar) y el turno
    // se descarta para que otro intento lo retome con la entrada aún en la bandeja.
    let outboxId = null
    try {
      const intencion = await registrarIntencion(prisma, {
        tenantId,
        leadId,
        origen: 'BOT',
        tipo: 'text',
        payload: { texto: botResponse.text },
        canalRef: canal?.externalKey || null,
      })
      outboxId = intencion.id
    } catch (err) {
      console.error(`[Pipeline] lead ${leadId}: no se pudo registrar la intención de envío; NO se envía:`, err.message)
      if (stateResult.turno?.turnoId) await descartarTurno(prisma, stateResult.turno.leadId, stateResult.turno.turnoId).catch(() => {})
      throw err
    }

    const sendResult = await enviarTexto({
      canal,
      telefono,
      texto: botResponse.text,
      instancia
    })
    const sendMs = Date.now() - sendStart
    const clase = clasificarEnvio(sendResult, transporteDe(canal))

    if (sendResult.ok) {
      console.log(`[Pipeline] Enviado a ${telefono} (${botResponse.text.length} chars, ${sendMs}ms)`)
      // El historial se persiste junto con el resultado del envío, en la MISMA fila de la
      // outbox. Si el insert falla, la outbox queda SENT con wamid y la recuperación la
      // reconcilia por wamid (único) SIN volver a enviar: nunca se duplica el mensaje.
      await confirmarEnvio(prisma, outboxId, {
        resultado: sendResult,
        mensajeData: { leadId, origen: 'BOT', texto: botResponse.text },
        canal,
        tenantId,
      }).catch(err => console.error(`[Pipeline] No se pudo persistir mensaje BOT lead ${leadId}:`, err.message))

      // HITO A3: el envío fue aceptado → el avance comercial del turno es real.
      if (stateResult.turno?.turnoId) {
        await confirmarTurno(prisma, leadId, stateResult.turno.turnoId, { tenantId })
          .catch(err => console.error(`[Pipeline] No se pudo confirmar el turno del lead ${leadId}:`, err.message))
      }

      // ─── 5b. ADJUNTAR IMAGEN si el cerebro la pidió (vertical colágeno, foto de
      //     precios en M4) — se envía DESPUÉS del texto y solo si el texto salió OK.
      //     Fire-and-forget suave: un fallo del envío de imagen NO tumba el turno. ───
      if (botResponse.enviar_imagen && getMessageGeneration(leadId) === genAtStart) {
        // La imagen se resuelve para ESTA campaña (su ficha manda) dentro de SU
        // tenant: la misma clave ("precios") apunta a un archivo distinto en cada
        // cliente. Sin registro, getImagen devuelve null y no se manda nada.
        let imagenesConfig = {}
        try {
          const tenantId = leadInfo.tenantId || ACTIVE_TENANT
          const lead = await prisma.lead.findFirst({
            where: { id: leadId, tenantId },
            select: { campaign: { select: { config: true, tenantId: true } } }
          })
          if (!lead || (lead.campaign && lead.campaign.tenantId !== tenantId)) throw new Error('campaña fuera del tenant')
          const ficha = lead.campaign?.config?.factSheet
          imagenesConfig = ficha ? (ficha.imagenes || {}) : null
        } catch (err) {
          console.warn(`[Pipeline] no se pudo leer la ficha para la imagen: ${err.message}`)
        }
        const img = getImagen(botResponse.enviar_imagen, leadInfo.tenantId || ACTIVE_TENANT, imagenesConfig)
        if (img && getMessageGeneration(leadId) === genAtStart) {
          const mediaRes = await enviarImagen({
            canal, telefono, base64: img.base64, mimetype: img.mimetype, fileName: img.fileName,
            instancia
          })
          // La imagen también pasa por la outbox: es un envío con las mismas dudas
          // (aceptada y sin historial, o rechazo que el vendedor debe ver).
          if (mediaRes.ok) {
            try {
              const imgBox = await registrarIntencion(prisma, {
                tenantId, leadId, origen: 'BOT', tipo: 'image',
                payload: { texto: 'Imagen enviada', clave: botResponse.enviar_imagen },
                canalRef: canal?.externalKey || null,
              })
              await confirmarEnvio(prisma, imgBox.id, {
                resultado: mediaRes,
                mensajeData: { leadId, origen: 'BOT', texto: 'Imagen enviada' },
                canal, tenantId,
              })
            } catch (e) {
              console.error('[Pipeline] persistir imagen saliente:', e.message)
            }
          }
          console.log(mediaRes.ok
            ? `[Pipeline] 📎 Imagen "${botResponse.enviar_imagen}" enviada a ${telefono} (${mediaRes.latency_ms}ms)`
            : `[Pipeline] ⚠️ No se pudo enviar imagen "${botResponse.enviar_imagen}": ${mediaRes.error}`)
        } else {
          console.warn(`[Pipeline] cerebro pidió imagen "${botResponse.enviar_imagen}" pero no existe en assets`)
        }
      }
    } else {
      // HITO A2 — tres desenlaces distintos, con tres tratamientos distintos:
      //   · RECHAZADO: Meta respondió que no. Se registra como fallido con su código para
      //     que el vendedor lo vea en la bandeja. NUNCA se marca como enviado.
      //   · NO ENVIADO: ni se construyó la petición (sin credenciales, sin canal). Se
      //     puede reintentar sin riesgo, porque nada salió.
      //   · INCIERTO: timeout o error de red. Pudo aceptarse. NO se reenvía: queda visible
      //     para que un humano lo resuelva (o lo concilie si llega un recibo con ese wamid).
      console.error(`[Pipeline] Send no ok (${clase.clase}):`, sendResult.error)
      if (clase.clase === 'rechazado') {
        await marcarRechazado(prisma, outboxId, {
          resultado: sendResult,
          mensajeData: { leadId, origen: 'BOT', texto: botResponse.text },
          leadId,
        }).catch(e => console.error('[Pipeline] registrar rechazo:', e.message))
      } else if (clase.clase === 'no_enviado') {
        await prisma.outboundMessage.update({
          where: { id: outboxId },
          data: { estado: 'PENDING', attempts: { increment: 1 }, lastError: String(sendResult.error || '').slice(0, 500), claimId: null, claimedAt: null, updatedAt: new Date() },
        }).catch(e => console.error('[Pipeline] outbox PENDING:', e.message))
      } else {
        await marcarIncierto(prisma, outboxId, { resultado: sendResult })
          .catch(e => console.error('[Pipeline] marcar incierto:', e.message))
      }
      // HITO A3: el cliente NO recibió la respuesta → el avance comercial de este turno
      // no se confirma. Los datos que el lead aportó se conservan.
      if (stateResult.turno?.turnoId) {
        await descartarTurno(prisma, leadId, stateResult.turno.turnoId)
          .catch(err => console.error(`[Pipeline] no se pudo descartar el turno (lead ${leadId}):`, err.message))
      }
    }

    // ─── Log final ───
    const totalMs = Date.now() - pipelineStart
    console.log(
      `[Pipeline] ✓ Lead ${leadId} | ` +
      `Total:${totalMs}ms | ` +
      `motor:cerebro | ` +
      `bot:${botResponse.generation?.method || 'unknown'}`
    )

  } catch (err) {
    console.error(`[Pipeline] FATAL error for lead ${leadId}:`, err.message)
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'))
    // NO enviamos nada al lead si pipeline falló (cero mensajes rotos)
  } finally {
    // ─── Liberar lock SIEMPRE ───
    processingLeads.delete(leadId)
  }
}

// ════════════════════════════════════════════════════════
// HELPERS DE DEBUG
// ════════════════════════════════════════════════════════

/**
 * Devuelve info de pipelines activos (para /debug/health)
 */
export function getActivePipelines() {
  return {
    total_active: processingLeads.size,
    lead_ids: Array.from(processingLeads)
  }
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const HANDLER_VERSION = 'v25_transporte_por_canal'
