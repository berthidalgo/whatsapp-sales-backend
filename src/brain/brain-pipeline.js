// src/brain/brain-pipeline.js — Hidata v20 · Sprint 3
//
// ════════════════════════════════════════════════════════════════════════
// EL PUENTE: conecta el cerebro unificado al pipeline real de WhatsApp.
//
// Reemplaza la cadena vieja Perception→ModeRouter→Policy→Response cuando el
// interruptor USAR_CEREBRO_NUEVO está activo. Hace 5 cosas:
// 1. Arma el historial de la conversación desde la BD (lo que el cerebro necesita)
// 2. Carga el estado del lead (stage, slots) y el config de su campaña
// 3. Llama al cerebro (pensarYResponder)
// 4. PROTEGE el stage: si el cerebro sugiere retroceder sin razón, lo ignora
// 5. Guarda el estado actualizado en la BD (lead_state) + persiste slots
//
// Devuelve un objeto con la MISMA forma que espera el handler:
// { ok, botResponse: { text, bot_responded, ... }, ... }
// para que el handler no note la diferencia y el envío por Evolution sea igual.
//
// ════════════════════════════════════════════════════════════════════════
// FIX Sprint 3 (post-producción, 02-jun-2026) — dos bugs del mismo origen:
//
// BUG #4 (crash en cada escalada): el código escribía currentMode:'HUMANO_ACTIVO'
//   (string en español, a mano). La BD solo acepta 'HUMAN_ACTIVE' (constraint
//   valid_mode). Cada vez que el cerebro escalaba a humano, el upsert reventaba
//   y el lead se quedaba sin respuesta. → Ahora se importa MODES del catálogo
//   maestro (igual que event-router) y se usa MODES.HUMAN_ACTIVE / MODES.AUTO_CONSULTIVO.
//   Si el valor está mal, ni arranca. El bug no puede renacer.
//
// BUG #5 (leads HOT atascados): el STAGE_ORDER estaba hardcodeado a mano e
//   incompleto — inventaba stages que no existen ('greeting','qualifying',
//   'objection_handling') y le FALTABA 'call_confirmed'. Como call_confirmed no
//   estaba en la lista, stageRank() devolvía 0, y el avance legítimo
//   call_scheduling→call_confirmed se interpretaba como "retroceso" y se bloqueaba.
//   → Ahora STAGE_ORDER se deriva del catálogo maestro STAGES (única fuente de verdad).
//
// DECISIÓN DE NEGOCIO (Camino 2 — validación humana del cierre):
//   Para MPX (ticket alto S/1,500, agentGoal=AGENDAR_LLAMADA), el "sí" de WhatsApp
//   NO es el cierre real — el cierre real es la llamada. Por eso el bot llega hasta
//   call_scheduling (coordina horario, su trabajo) pero NUNCA marca call_confirmed
//   por su cuenta: ese stage lo valida el humano (Joan) o el registro de la llamada.
//   Así el embudo no se infla con "confirmados" que luego no contestan el teléfono.
//   El cerebro IGUAL responde con calidez al lead que confirma; solo el dato interno
//   espera el visto bueno humano.
// ════════════════════════════════════════════════════════════════════════

import { pensarYResponder, summarizeBrainResult, AGENT_BRAIN_VERSION } from './agent-brain.js'
import prisma from '../db/prisma.js'
import { STAGES, MODES } from '../state/stage-definitions.js'

// ─────────────────────────────────────────────────────────────────────────
// Orden del embudo (para proteger contra retrocesos de stage).
// DERIVADO del catálogo maestro STAGES — NO hardcodear strings a mano (eso causó
// el bug #5). Índice mayor = más avanzado. El stage solo AVANZA, no retrocede,
// salvo que el cerebro escale a humano.
// ─────────────────────────────────────────────────────────────────────────
const STAGE_ORDER = [
  STAGES.FIRST_CONTACT,          // 0
  STAGES.DISCOVERY,              // 1
  STAGES.QUALIFYING_EMPRESA,     // 2
  STAGES.PRESENTING,             // 3
  STAGES.CALL_SCHEDULING,        // 4
  STAGES.CALL_CONFIRMED,         // 5
  STAGES.POST_CLOSE              // 6
]
// Nota: RETURNING_RECOGNITION se maneja por escalada/reactivación, no por el
// orden lineal del embudo, así que no entra en este array de avance.

// ─────────────────────────────────────────────────────────────────────────
// CAMINO 2 — Stages que el CEREBRO NO puede asignar por su cuenta.
// Estos los valida un humano (o el registro real del evento). Si el cerebro los
// sugiere, respondemos normal pero mantenemos el stage anterior.
// Para MPX: call_confirmed = "el lead confirmó la llamada DE VERDAD" → lo marca Joan.
// ─────────────────────────────────────────────────────────────────────────
const STAGES_SOLO_HUMANO = new Set([
  STAGES.CALL_CONFIRMED
])

function stageRank(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? 0 : i
}

/**
 * Arma el historial de la conversación para el cerebro.
 * Jala los últimos N mensajes del lead desde la BD, ordenados cronológicamente.
 */
/**
 * Persiste un mensaje del LEAD en la BD (FIX jun 2026 — LA MEMORIA del cerebro).
 * Hasta este fix, NADIE escribía en `messages` en el flujo del webhook: el único
 * create vivía en el endpoint manual del CRM. Resultado: construirHistorial()
 * devolvía SIEMPRE vacío y el cerebro veía "(esta es la primera interacción)"
 * en cada turno — operaba solo con stage+slots, amnésico a la conversación.
 * Un fallo aquí NO debe tumbar el turno: se loguea y se sigue.
 */
async function persistirMensajeLead(leadId, texto) {
  try {
    await prisma.message.create({ data: { leadId, origen: 'LEAD', texto } })
  } catch (err) {
    console.error(`[BrainPipeline] No se pudo persistir mensaje LEAD ${leadId}:`, err.message)
  }
}

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
 * @param {number} args.leadId - id del lead
 * @param {string} args.telefono - teléfono del lead
 * @param {string} args.mensajeActual - el texto que el lead acaba de enviar (combinado)
 * @param {string} args.tenantId - tenant
 * @param {string} args.vendorNombre - nombre del agente/vendedor (la identidad del bot)
 * @returns {Promise<object>} { ok, botResponse, brainResult, stateAfter }
 */
export async function procesarConCerebro({ leadId, telefono, mensajeActual, tenantId = 'peru_exporta', vendorNombre = 'Jhon' }) {
  const startTime = Date.now()

  try {
    // ─── 1. Cargar estado del lead + su campaña (en paralelo) ───
    const [leadState, lead] = await Promise.all([
      prisma.leadState.findUnique({ where: { leadId } }),
      prisma.lead.findUnique({
        where: { id: leadId },
        select: { campaignId: true, nombreDetectado: true }
      })
    ])

    // ─── 1b. COMPUERTA DE MODO (FIX jun 2026) ───
    // Si un humano tiene la conversación (HUMAN_ACTIVE, por handoff fromMe o por
    // escalamiento del propio cerebro) o el lead está PAUSED, el cerebro NO
    // interviene. Sin esta compuerta, el bot respondía igual al siguiente mensaje
    // del lead e interrumpía al vendedor humano (el handoff solo cancelaba el
    // buffer del instante, no los turnos siguientes). El mensaje del lead SÍ se
    // persiste: la conversación no pierde memoria mientras el humano atiende.
    const modoActual = leadState?.currentMode || MODES.AUTO_CONSULTIVO
    if (modoActual === MODES.HUMAN_ACTIVE || modoActual === MODES.PAUSED) {
      await persistirMensajeLead(leadId, mensajeActual)
      console.log(`[BrainPipeline] 🔇 Lead ${leadId} en modo ${modoActual} → cerebro en silencio (handoff)`)
      return {
        ok: true,
        botResponse: {
          text: null,
          bot_responded: false,
          generation: {
            method: `agent_brain_${AGENT_BRAIN_VERSION}`,
            reason: `modo_${modoActual.toLowerCase()}`
          }
        },
        brainResult: null,
        stateAfter: null,
        _pipeline_ms: Date.now() - startTime
      }
    }

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

    // ─── 2b. Persistir el mensaje del LEAD ───
    // DESPUÉS de armar el historial (el mensaje actual va aparte en el prompt
    // como "ÚLTIMO MENSAJE"; si entrara también al historial, se duplicaría).
    // Se persiste ANTES de llamar al cerebro: si el cerebro falla, el mensaje
    // del lead igual quedó registrado (sí lo recibimos).
    await persistirMensajeLead(leadId, mensajeActual)

    // ─── 3. Armar el estadoLead que el cerebro espera ───
    const estadoLead = {
      stage: leadState?.currentStage || STAGES.FIRST_CONTACT,
      slots: leadState?.slotsFilled || {},
      tenantId,
      vendorNombre,
      // Etiqueta del agente en el historial del prompt (nombreCorto). El nombre
      // real lo manda config.agente.nombre (Jhon); sin esto salía "AGENTE".
      agenteNombre: campaignConfig?.agente?.nombre || vendorNombre
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

    // ─── 5. PROTEGER EL STAGE (no retroceder sin razón + bloqueo Camino 2) ───
    const stageActual = leadState?.currentStage || STAGES.FIRST_CONTACT
    const stageSugerido = brainResult.stage_sugerido || stageActual
    let stageFinal = stageActual

    if (brainResult.debe_escalar_humano) {
      // Si escala a humano, respetamos lo que diga el cerebro (puede ser cualquier stage)
      // — salvo que sea un stage de solo-humano (no tendría sentido auto-asignarlo).
      stageFinal = STAGES_SOLO_HUMANO.has(stageSugerido) ? stageActual : stageSugerido
    } else if (STAGES_SOLO_HUMANO.has(stageSugerido) && stageSugerido !== stageActual) {
      // CAMINO 2: el cerebro quiere marcar call_confirmed por su cuenta → NO se lo
      // permitimos. Respondemos normal (con calidez), pero el stage espera validación
      // humana. Esto evita inflar el embudo con confirmaciones de WhatsApp no validadas.
      console.log(`[BrainPipeline] 🔒 Stage de validación humana: cerebro sugirió "${stageSugerido}", se mantiene "${stageActual}" (lo marca el humano)`)
      stageFinal = stageActual
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
    // currentMode usa el catálogo MODES (NO strings a mano — eso causó el bug #4).
    await prisma.leadState.upsert({
      where: { leadId },
      update: {
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        lastMessageAt: new Date(),
        ...(brainResult.debe_escalar_humano ? { currentMode: MODES.HUMAN_ACTIVE } : {})
      },
      create: {
        leadId,
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        currentMode: brainResult.debe_escalar_humano ? MODES.HUMAN_ACTIVE : MODES.AUTO_CONSULTIVO
      }
    })

    // ─── 8. Devolver con la forma que espera el handler ───
    return {
      ok: true,
      botResponse: {
        text: brainResult.mensaje,
        // FIX jun 2026: al escalar, el mensaje cálido del cerebro TAMBIÉN se envía
        // (regla 8 del prompt: "respóndele algo cálido para que no quede mudo").
        // Antes bot_responded=false silenciaba al lead vulnerable/HOT justo cuando
        // más importaba. El silencio de los turnos SIGUIENTES lo garantiza la
        // compuerta de modo (el upsert de abajo deja el lead en HUMAN_ACTIVE).
        bot_responded: true,
        generation: {
          // FIX jun 2026: la marca era 'agent_brain_v1' hardcodeada — los logs
          // decían v1 con el v4 vivo (falsa alarma del protocolo de pruebas).
          // Ahora se deriva de AGENT_BRAIN_VERSION: una sola fuente de verdad.
          method: `agent_brain_${AGENT_BRAIN_VERSION}`,
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

export const BRAIN_PIPELINE_VERSION = 'v3_sprintA_memoria_modegate_escalamiento'
