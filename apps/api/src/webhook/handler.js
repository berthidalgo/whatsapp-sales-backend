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

import prisma from '../db/prisma.js'
import { checkAndMark } from './idempotency.js'
import { routeEvent, summarizeEventResult } from './event-router.js'
import { enqueueMessage, getMessageGeneration } from './debounce.js'
import { sendToWhatsApp, sendMediaToWhatsApp } from './sender.js'
import { procesarConCerebro } from '../brain/brain-pipeline.js'
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
      vendorNombre: leadInfo.vendorNombre || 'Jhon'  // fallback alineado al config (el nombre real lo manda config.agente.nombre)
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
    // El avance del lead (slots/stage que el cerebro ya guardó) NO se pierde; solo se
    // descarta el ENVÍO obsoleto. MUTE-SAFE: el mensaje nuevo encolado siempre responde.
    if (getMessageGeneration(leadId) > genAtStart) {
      console.warn(`[Pipeline] 🗑️ Lead ${leadId}: llegó mensaje nuevo mientras el cerebro pensaba (gen ${genAtStart}→${getMessageGeneration(leadId)}) → DESCARTO respuesta obsoleta; responde el turno nuevo (anti-cascade)`)
      return
    }

    // ─── 5. Enviar respuesta por el MISMO canal que recibió el mensaje ───
    // Antes: `process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'` — una env
    // var global con el número de UN cliente hardcodeado como fallback. Con dos
    // clientes activos eso respondía a los leads de BIOAYUR desde el número de Perú
    // Exporta. Ahora se responde por la instancia que RECIBIÓ el mensaje: correcto
    // por construcción, sin importar cuántos clientes haya.
    const sendStart = Date.now()
    const sendResult = await sendToWhatsApp({
      telefono,
      text: botResponse.text,
      instanceName: instanciaDeSalida(leadInfo)
    })
    const sendMs = Date.now() - sendStart

    if (sendResult.ok) {
      console.log(`[Pipeline] ✅ Sent to ${telefono} (${botResponse.text.length} chars, ${sendMs}ms)`)
      // FIX jun 2026 — persistir la respuesta del BOT (la otra mitad de la memoria:
      // construirHistorial lee de `messages` y aquí nadie escribía). Solo si el
      // envío fue OK: un mensaje NO entregado no debe entrar al historial.
      // Un fallo del insert no tumba el pipeline: se loguea y se sigue.
      try {
        await prisma.message.create({ data: { leadId, origen: 'BOT', texto: botResponse.text } })
      } catch (err) {
        console.error(`[Pipeline] No se pudo persistir mensaje BOT lead ${leadId}:`, err.message)
      }

      // ─── 5b. ADJUNTAR IMAGEN si el cerebro la pidió (vertical colágeno, foto de
      //     precios en M4) — se envía DESPUÉS del texto y solo si el texto salió OK.
      //     Fire-and-forget suave: un fallo del envío de imagen NO tumba el turno. ───
      if (botResponse.enviar_imagen) {
        const img = getImagen(botResponse.enviar_imagen)
        if (img) {
          const mediaRes = await sendMediaToWhatsApp({
            telefono, base64: img.base64, mimetype: img.mimetype, fileName: img.fileName,
            instanceName: instanciaDeSalida(leadInfo)
          })
          console.log(mediaRes.ok
            ? `[Pipeline] 📎 Imagen "${botResponse.enviar_imagen}" enviada a ${telefono} (${mediaRes.latency_ms}ms)`
            : `[Pipeline] ⚠️ No se pudo enviar imagen "${botResponse.enviar_imagen}": ${mediaRes.error}`)
        } else {
          console.warn(`[Pipeline] cerebro pidió imagen "${botResponse.enviar_imagen}" pero no existe en assets`)
        }
      }
    } else {
      console.error(`[Pipeline] ❌ Send failed:`, sendResult.error)
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
export const HANDLER_VERSION = 'v24_killstale_anticascade'
