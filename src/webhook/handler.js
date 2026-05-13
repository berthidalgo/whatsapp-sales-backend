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

import { checkAndMark } from './idempotency.js'
import { routeEvent, summarizeEventResult } from './event-router.js'
import { sendToWhatsApp } from './sender.js'
import { buildPerceptionContext } from '../perception/perception-context-builder.js'
import { analizarMensaje } from '../perception/perception.js'
import { actualizarEstado } from '../state/state.js'

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
    const messageId = payload?.data?.key?.id || null

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

  // ─── Lock check ───
  if (processingLeads.has(leadId)) {
    console.warn(`[Pipeline] Lead ${leadId} already processing, will retry in 5s`)
    setTimeout(() => {
      processPipelineFn(leadInfo, combinedText, bufferMetadata).catch(err => {
        console.error('[Pipeline] Retry error:', err.message)
      })
    }, 5000)
    return
  }

  processingLeads.add(leadId)

  try {
    console.log(`[Pipeline] ▶️ Starting for lead ${leadId} (${telefono}): ${bufferMetadata?.messageCount || 1} msg combined`)

    // ─── 1. Construir contexto de Perception ───
    const builtContext = await buildPerceptionContext({
      telefono,
      mensaje: combinedText,
      tenantId: leadInfo.tenantId || 'peru_exporta'
    })

    const contextFlags = builtContext.contexto.flags

    // ─── 2. Perception ───
    const perceptionStart = Date.now()
    const perception = await analizarMensaje({
      mensaje: combinedText,
      telefono,
      tenantId: leadInfo.tenantId || 'peru_exporta',
      saveTrace: true
    })
    
    // Inyectar mensaje original en perception.meta para Response Layer
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = combinedText
    perception.meta.buffer_metadata = bufferMetadata
    
    const perceptionMs = Date.now() - perceptionStart
    console.log(`[Pipeline] Perception ${perceptionMs}ms: intents=${perception.intents?.join(',')}`)

    // ─── 3. State + Mode Router + Policy + Response ───
    const stateStart = Date.now()
    const stateResult = await actualizarEstado({
      perception,
      leadId,
      telefono,
      contextFlags
    })
    const stateMs = Date.now() - stateStart

    if (!stateResult.ok) {
      console.error(`[Pipeline] State failed for lead ${leadId}:`, stateResult.errors)
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
    } else {
      console.error(`[Pipeline] ❌ Send failed:`, sendResult.error)
    }

    // ─── Log final ───
    const totalMs = Date.now() - pipelineStart
    console.log(
      `[Pipeline] ✓ Lead ${leadId} | ` +
      `Perception:${perceptionMs}ms State:${stateMs}ms Send:${sendMs}ms | ` +
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
export const HANDLER_VERSION = 'v20_day7_full_refactor'
