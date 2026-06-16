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
import { enqueueMessage } from './debounce.js'
import { sendToWhatsApp } from './sender.js'
import { procesarConCerebro } from '../brain/brain-pipeline.js'

// ════════════════════════════════════════════════════════
// ESTADO INTERNO — Lock por leadId
// ════════════════════════════════════════════════════════

/**
 * Set de leads cuyo pipeline está actualmente ejecutándose.
 * Previene race conditions cuando llegan mensajes durante procesamiento.
 */
const processingLeads = new Set()

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

  try {
    console.log(`[Pipeline] ▶️ Starting for lead ${leadId} (${telefono}): ${bufferMetadata?.messageCount || 1} msg combined`)

    // ─── Cerebro unificado (ÚNICA vía desde Fase C: el pipeline viejo se eliminó) ───
    console.log(`[Pipeline] 🧠 Cerebro para lead ${leadId}`)
    const brainStart = Date.now()
    const stateResult = await procesarConCerebro({
      leadId,
      telefono,
      mensajeActual: combinedText,
      tenantId: leadInfo.tenantId || 'peru_exporta',
      vendorNombre: leadInfo.vendorNombre || 'Jhon'  // fallback; el nombre real lo manda config.agente.nombre
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

    // ─── 5. Enviar respuesta vía Evolution API ───
    const sendStart = Date.now()
    const sendResult = await sendToWhatsApp({
      telefono,
      text: botResponse.text,
      instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'
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
    } else {
      console.error(`[Pipeline] ❌ Send failed:`, sendResult.error)
    }

    // ─── Log final ───
    const totalMs = Date.now() - pipelineStart
    console.log(
      `[Pipeline] ✓ Lead ${leadId} | ` +
      `Total:${totalMs}ms | ` +
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
export const HANDLER_VERSION = 'v23_sprintA_persist_bot_msg'
