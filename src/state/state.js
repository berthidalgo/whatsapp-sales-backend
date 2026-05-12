// src/state/state.js — Hidata v20
//
// EL CORAZÓN DEL STATE LAYER
//
// API principal: actualizarEstado({ perception, turnId, leadId, telefono })
//
// Pipeline interno:
//   1. Lee lead_state actual (o crea uno si no existe)
//   2. Llama resolveNextState() para decidir transición
//   3. Llama mergeSlots() para actualizar slots
//   4. Escribe lead_state actualizado (en una transacción)
//   5. Sincroniza lead.pasoActual y lead.nombreDetectado/productoDetectado
//   6. Sincroniza lead.estado SOLO si mode es PAUSED
//   7. Actualiza turn_trace.stateAfter del turno actual
//   8. Devuelve { leadState, transition, mergeResult }
//
// NUNCA crashea — si algo falla, devuelve estado original sin cambios

import prisma from '../db/prisma.js'
import { resolveNextState, STATE_TRANSITIONS_VERSION } from './state-transitions.js'
import { mergeSlots, sanitizeSlots, summarizeMerge, CONTEXT_GRAPH_VERSION } from './context-graph.js'
import {
  STAGES,
  MODES,
  STAGE_TO_PASO_ACTUAL,
  MODE_TO_LEAD_ESTADO,
  SLOT_TO_LEAD_COLUMN,
  SLOTS,
  describeLeadState,
  STATE_DEFINITIONS_VERSION
} from './stage-definitions.js'

// ════════════════════════════════════════════════════════
// API PRINCIPAL — actualizarEstado()
// ════════════════════════════════════════════════════════

/**
 * Actualiza el estado completo del lead después de Perception.
 * 
 * @param {object} params
 * @param {object} params.perception - Output de Perception (con meta.turn_id)
 * @param {number} params.leadId - ID del lead
 * @param {string} params.telefono - Teléfono del lead (para logging)
 * @param {object} params.contextFlags - Flags del contexto (is_returning_lead, etc)
 * @returns {object} {
 *   ok: boolean,
 *   leadState: object,
 *   transition: object,
 *   mergeResult: object,
 *   errors: array
 * }
 */
export async function actualizarEstado({ perception, leadId, telefono, contextFlags = {} }) {
  const startTime = Date.now()
  const errors = []

  // Validación defensiva
  if (!leadId) {
    return {
      ok: false,
      errors: [{ phase: 'validation', message: 'leadId is required' }],
      leadState: null,
      transition: null,
      mergeResult: null
    }
  }

  if (!perception) {
    return {
      ok: false,
      errors: [{ phase: 'validation', message: 'perception is required' }],
      leadState: null,
      transition: null,
      mergeResult: null
    }
  }

  try {
    // ─── 1. Leer o crear lead_state ───
    const currentLeadState = await getOrCreateLeadState(leadId)
    const stateBefore = serializeStateBefore(currentLeadState)

    // ─── 2. Calcular transición (función pura) ───
    const transition = resolveNextState({
      perception,
      currentState: currentLeadState,
      flags: contextFlags
    })

    // ─── 3. Mergear slots ───
    const mergeResult = mergeSlots(
      currentLeadState.slotsFilled || {},
      sanitizeSlots(transition.slots_to_merge || {})
    )

    // ─── 4. Construir el lead_state actualizado ───
    const updates = buildLeadStateUpdates({
      transition,
      mergeResult,
      currentLeadState,
      contextFlags
    })

    // ─── 5. Escribir lead_state, lead y turn_trace en una transacción ───
    const updatedLeadState = await prisma.$transaction(async (tx) => {
      // Update lead_state
      const newLeadState = await tx.leadState.update({
        where: { leadId },
        data: updates
      })

      // Sincronizar lead.pasoActual y campos espejo
      const leadUpdates = buildLeadSyncUpdates({ transition, mergeResult })
      if (Object.keys(leadUpdates).length > 0) {
        await tx.lead.update({
          where: { id: leadId },
          data: leadUpdates
        }).catch(err => {
          console.error('[State] Error syncing lead:', err.message)
          errors.push({ phase: 'sync_lead', message: err.message })
        })
      }

      // Actualizar turn_trace.stateAfter (si tenemos turn_id)
      const turnId = perception?.meta?.turn_id
      if (turnId) {
        const stateAfter = serializeStateAfter({
          newLeadState,
          transition,
          mergeResult
        })

        await tx.turnTrace.update({
          where: { turnId },
          data: { stateAfter }
        }).catch(err => {
          console.error('[State] Error updating turn_trace:', err.message)
          errors.push({ phase: 'update_trace', message: err.message })
        })
      }

      return newLeadState
    })

    const latencyMs = Date.now() - startTime
    
    // Log resumen para debugging
    console.log(
      `[State] ${telefono || `lead_${leadId}`} | ` +
      `${describeLeadState(currentLeadState)} → ${describeLeadState(updatedLeadState)} | ` +
      `${transition.transition_reason} | ` +
      `${summarizeMerge(mergeResult)} | ` +
      `${latencyMs}ms`
    )

    return {
      ok: true,
      leadState: updatedLeadState,
      transition,
      mergeResult,
      errors,
      latency_ms: latencyMs,
      stateBefore
    }

  } catch (err) {
    console.error('[State] Fatal error:', err.message)
    errors.push({ phase: 'fatal', message: err.message, stack: err.stack?.split('\n').slice(0, 3) })
    
    return {
      ok: false,
      errors,
      leadState: null,
      transition: null,
      mergeResult: null,
      latency_ms: Date.now() - startTime
    }
  }
}

// ════════════════════════════════════════════════════════
// getOrCreateLeadState — manejar leads sin lead_state previo
// ════════════════════════════════════════════════════════

/**
 * Lee el lead_state. Si no existe, lo crea con defaults.
 * Necesario porque leads creados por v19 no tienen lead_state.
 */
async function getOrCreateLeadState(leadId) {
  const existing = await prisma.leadState.findUnique({
    where: { leadId }
  })

  if (existing) return existing

  // No existe → crear con defaults
  console.log(`[State] Creating lead_state for lead ${leadId} (first time)`)
  
  // Intentar inferir desde lead.estado v19 si existe
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { estado: true, pasoActual: true, nombreDetectado: true, productoDetectado: true, vendorId: true }
  })

  const inferredStage = inferStageFromV19({
    estado: lead?.estado,
    pasoActual: lead?.pasoActual
  })

  const initialSlots = {}
  if (lead?.nombreDetectado)   initialSlots[SLOTS.NOMBRE]   = lead.nombreDetectado
  if (lead?.productoDetectado) initialSlots[SLOTS.PRODUCTO] = lead.productoDetectado

  const newLeadState = await prisma.leadState.create({
    data: {
      leadId,
      currentMode:  MODES.AUTO_CONSULTIVO,
      currentStage: inferredStage,
      slotsFilled:  initialSlots,
      slotsPending: [],
      intentosPorSlot: {},
      vendorActiveId: lead?.vendorId || null,
      returningLeadFlag: false
    }
  })

  return newLeadState
}

/**
 * Mapea lead.estado/pasoActual de v19 al stage v20 equivalente
 */
function inferStageFromV19({ estado, pasoActual }) {
  // Si v19 marcó CERRADO o PAGO_PENDIENTE, ya pasamos al final
  if (estado === 'CERRADO') return STAGES.POST_CLOSE
  if (estado === 'PAGO_PENDIENTE') return STAGES.POST_CLOSE

  // Mapeo desde pasoActual
  const PASO_TO_STAGE = {
    1: STAGES.FIRST_CONTACT,
    2: STAGES.DISCOVERY,
    3: STAGES.QUALIFYING_EMPRESA,
    4: STAGES.PRESENTING,
    5: STAGES.CALL_SCHEDULING,
    6: STAGES.CALL_CONFIRMED,
    7: STAGES.POST_CLOSE
  }

  return PASO_TO_STAGE[pasoActual || 1] || STAGES.FIRST_CONTACT
}

// ════════════════════════════════════════════════════════
// CONSTRUCCIÓN DE UPDATES
// ════════════════════════════════════════════════════════

/**
 * Construye el objeto de updates para lead_state
 */
function buildLeadStateUpdates({ transition, mergeResult, currentLeadState, contextFlags }) {
  const updates = {
    lastMessageAt: new Date(),
    slotsFilled: mergeResult.merged
  }

  // Solo actualizar stage si cambió
  if (transition.nextStage !== currentLeadState.currentStage) {
    updates.currentStage = transition.nextStage
  }

  // Solo actualizar mode si cambió
  if (transition.nextMode !== currentLeadState.currentMode) {
    updates.currentMode = transition.nextMode
    updates.modeEnteredAt = new Date()
  }

  // Returning lead flag
  if (contextFlags.is_returning_lead && !currentLeadState.returningLeadFlag) {
    updates.returningLeadFlag = true
  }

  return updates
}

/**
 * Construye el objeto de updates para sincronizar con lead (campo v19)
 * Solo actualiza lo necesario para mantener compatibilidad
 */
function buildLeadSyncUpdates({ transition, mergeResult }) {
  const updates = {}

  // Sincronizar pasoActual (siempre que el stage haya cambiado)
  const nextPasoActual = STAGE_TO_PASO_ACTUAL[transition.nextStage]
  if (nextPasoActual) {
    updates.pasoActual = nextPasoActual
  }

  // Sincronizar lead.estado SOLO si el mode lo requiere
  const newEstado = MODE_TO_LEAD_ESTADO[transition.nextMode]
  if (newEstado !== null && newEstado !== undefined) {
    updates.estado = newEstado
  }

  // Sincronizar campos espejo (nombre y producto)
  for (const [slotKey, leadColumn] of Object.entries(SLOT_TO_LEAD_COLUMN)) {
    if (mergeResult.changes[slotKey]) {
      updates[leadColumn] = mergeResult.changes[slotKey].new
    }
  }

  // Actualizar timestamp del último mensaje del lead
  updates.ultimoMensaje = new Date()

  return updates
}

// ════════════════════════════════════════════════════════
// SERIALIZACIÓN para turn_trace
// ════════════════════════════════════════════════════════

/**
 * Snapshot del estado ANTES de actualizar (para turn_trace.stateBefore)
 */
function serializeStateBefore(leadState) {
  return {
    mode: leadState.currentMode,
    stage: leadState.currentStage,
    slots_filled: leadState.slotsFilled,
    returning_lead_flag: leadState.returningLeadFlag,
    last_message_at: leadState.lastMessageAt
  }
}

/**
 * Snapshot del estado DESPUÉS de actualizar (para turn_trace.stateAfter)
 * Incluye también la transición y el merge result
 */
function serializeStateAfter({ newLeadState, transition, mergeResult }) {
  return {
    mode: newLeadState.currentMode,
    stage: newLeadState.currentStage,
    slots_filled: newLeadState.slotsFilled,
    returning_lead_flag: newLeadState.returningLeadFlag,
    
    // Metadata de la decisión
    transition: {
      from_stage: transition.stayed ? newLeadState.currentStage : 'previous',
      to_stage: transition.nextStage,
      from_mode: transition.stayed ? newLeadState.currentMode : 'previous',
      to_mode: transition.nextMode,
      reason: transition.transition_reason,
      stayed: transition.stayed
    },
    
    // Metadata del merge
    merge: {
      change_count: mergeResult.change_count,
      changes: mergeResult.changes
    },
    
    // Versiones para tracking
    versions: {
      definitions: STATE_DEFINITIONS_VERSION,
      transitions: STATE_TRANSITIONS_VERSION,
      context_graph: CONTEXT_GRAPH_VERSION
    }
  }
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const STATE_VERSION = 'v1'