// src/brain/brain-pipeline.js — Hidata v20 · Sprint 3
//
// ════════════════════════════════════════════════════════════════════════
// EL PUENTE: conecta el cerebro unificado al pipeline real de WhatsApp.
//
// Reemplaza la cadena vieja Perception→ModeRouter→Policy→Response cuando el
// interruptor USAR_CEREBRO_NUEVO está activo. Hace 5 cosas:
//   1. Arma el historial de la conversación desde la BD (lo que el cerebro necesita)
//   2. Carga el estado del lead (stage, slots) y el config de su campaña
//   3. Llama al cerebro (pensarYResponder)
//   4. PROTEGE el stage: si el cerebro sugiere retroceder sin razón, lo ignora
//   5. Guarda el estado actualizado en la BD (lead_state) + persiste slots
//
// Devuelve un objeto con la MISMA forma que espera el handler:
//   { ok, botResponse: { text, bot_responded, ... }, ... }
// para que el handler no note la diferencia y el envío por Evolution sea igual.
// ════════════════════════════════════════════════════════════════════════

import { pensarYResponder, summarizeBrainResult } from './agent-brain.js'
import prisma from '../db/prisma.js'

// Orden del embudo (para proteger contra retrocesos de stage)
// Índice mayor = más avanzado en la venta. El stage solo AVANZA, no retrocede
// (salvo que el cerebro escale a humano o detecte algo que justifique reset).
const STAGE_ORDER = [
  'first_contact',
  'greeting',
  'discovery',
  'qualifying_empresa',
  'qualifying',
  'presenting',
  'objection_handling',
  'call_scheduling',
  'post_close'
]

function stageRank(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? 0 : i
}

/**
 * Arma el historial de la conversación para el cerebro.
 * Jala los últimos N mensajes del lead desde la BD, ordenados cronológicamente.
 */
async function construirHistorial(prisma, leadId, limite = 12) {
  const mensajes = await prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: limite,
    select: { origen: true, texto: true, createdAt: true }
  })

  // Vienen en desc (más nuevo primero); los invertimos a orden cronológico
  return mensajes.reverse().map(m => ({
    rol: m.origen === 'LEAD' ? 'lead' : 'agente',
    texto: m.texto
  }))
}

/**
 * Procesa un mensaje entrante usando el cerebro unificado.
 *
 * @param {object} args
 * @param {number} args.leadId         - id del lead
 * @param {string} args.telefono       - teléfono del lead
 * @param {string} args.mensajeActual  - el texto que el lead acaba de enviar (combinado)
 * @param {string} args.tenantId       - tenant
 * @param {string} args.vendorNombre   - nombre del agente/vendedor (la identidad del bot)
 * @returns {Promise<object>} { ok, botResponse, brainResult, stateAfter }
 */
export async function procesarConCerebro({ leadId, telefono, mensajeActual, tenantId = 'peru_exporta', vendorNombre = 'Daniel' }) {
  const startTime = Date.now()

  try {
    // ─── 1. Cargar estado del lead + su campaña (en paralelo) ───
    const [leadState, lead] = await Promise.all([
      prisma.leadState.findUnique({ where: { leadId } }),
      prisma.lead.findUnique({
        where: { id: leadId },
        select: { campaignId: true, nombre: true }
      })
    ])

    // Cargar el config de la campaña (el factSheet + comportamiento/agentGoal)
    let campaignConfig = null
    if (lead?.campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: lead.campaignId },
        select: { config: true, slug: true, nombre: true }
      })
      campaignConfig = campaign?.config || null
    }

    // ─── 2. Armar el historial desde la BD ───
    const historial = await construirHistorial(prisma, leadId)

    // ─── 3. Armar el estadoLead que el cerebro espera ───
    const estadoLead = {
      stage: leadState?.currentStage || 'first_contact',
      slots: leadState?.slotsFilled || {},
      tenantId,
      vendorNombre
    }

    // ─── 4. Llamar al CEREBRO ───
    const brainResult = await pensarYResponder({
      mensajeActual,
      historial,
      estadoLead,
      campaignConfig,
      vendorNombre
    })

    console.log(`[BrainPipeline] ${summarizeBrainResult(brainResult)}`)

    // Si el cerebro falló, devolvemos sin romper (el handler maneja el "no response")
    if (!brainResult.ok || !brainResult.mensaje) {
      return {
        ok: false,
        error: brainResult.error || 'brain_no_message',
        botResponse: null,
        brainResult
      }
    }

    // ─── 5. PROTEGER EL STAGE (no retroceder sin razón) ───
    const stageActual = leadState?.currentStage || 'first_contact'
    const stageSugerido = brainResult.stage_sugerido || stageActual
    let stageFinal = stageActual

    if (brainResult.debe_escalar_humano) {
      // Si escala a humano, respetamos lo que diga el cerebro (puede ser cualquier stage)
      stageFinal = stageSugerido
    } else if (stageRank(stageSugerido) >= stageRank(stageActual)) {
      // Solo avanza o se mantiene. NUNCA retrocede sin razón.
      stageFinal = stageSugerido
    } else {
      // El cerebro sugirió retroceder → lo ignoramos, mantenemos el avanzado
      console.log(`[BrainPipeline] ⚠️ Stage protegido: cerebro sugirió "${stageSugerido}" (retroceso desde "${stageActual}"), se mantiene "${stageActual}"`)
      stageFinal = stageActual
    }

    // ─── 6. Fusionar slots (los nuevos del cerebro sobre los existentes) ───
    const slotsExistentes = leadState?.slotsFilled || {}
    const slotsNuevos = brainResult.slots_detectados || {}
    const slotsFusionados = { ...slotsExistentes }
    for (const [k, v] of Object.entries(slotsNuevos)) {
      // Solo guardamos slots con valor real (no vacíos ni explicaciones raras)
      if (v && typeof v === 'string' && v.trim() && !v.toLowerCase().includes('vacío')) {
        slotsFusionados[k] = v
      }
    }

    // ─── 7. Guardar el estado actualizado en la BD ───
    await prisma.leadState.upsert({
      where: { leadId },
      update: {
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        lastMessageAt: new Date(),
        ...(brainResult.debe_escalar_humano ? { currentMode: 'HUMANO_ACTIVO' } : {})
      },
      create: {
        leadId,
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        currentMode: brainResult.debe_escalar_humano ? 'HUMANO_ACTIVO' : 'AUTO_CONSULTIVO'
      }
    })

    // ─── 8. Devolver con la forma que espera el handler ───
    return {
      ok: true,
      botResponse: {
        text: brainResult.mensaje,
        bot_responded: !brainResult.debe_escalar_humano,  // si escala a humano, el bot NO responde (espera al humano)
        generation: {
          method: 'agent_brain_v1',
          reason: brainResult.debe_escalar_humano ? 'escalado_a_humano' : 'brain_response'
        },
        audit: brainResult.audit
      },
      brainResult,
      stateAfter: { stage: stageFinal, slots: slotsFusionados, escalado: brainResult.debe_escalar_humano },
      _pipeline_ms: Date.now() - startTime
    }

  } catch (err) {
    console.error('[BrainPipeline] Error:', err.message)
    return {
      ok: false,
      error: `brain_pipeline_exception: ${err.message}`,
      botResponse: null,
      brainResult: null
    }
  }
}

export const BRAIN_PIPELINE_VERSION = 'v1_sprint3'
