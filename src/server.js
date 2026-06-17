// src/server.js — Hidata v20
// Día 8: Cleanup arquitectónico + bug guardrails fixed
// Sprint 3: + endpoint /debug/brain-test (banco de pruebas del cerebro, aislado)

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import * as Sentry from '@sentry/node'
import { PrismaClient } from '@prisma/client'
import { handleWebhook } from './webhook/handler.js'
import {
  getLeads, updateLead, sendMensaje, doAccion, getReportes, getMensajes
} from './api/leads.js'
import {
  getBotConfig, updateBotConfig,
  getVendedores, createVendedor, updateVendedor, desactivarVendedor
} from './api/config.js'
import {
  getCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  saveSteps, addTrigger, deleteTrigger, testTrigger, activarCampaign
} from './routes/campaigns.js'
import { loginVendor, getVendorNames } from './routes/auth.js'

import { geminiHealthCheck } from './lib/gemini.js'
import { analizarMensaje, analizarMensajeStateless } from './perception/perception.js'
import { buildPerceptionContext, summarizeContext } from './perception/perception-context-builder.js'
import { classifyExpectedIntent } from './perception/perception-schema.js'
import { actualizarEstado } from './state/state.js'
import { summarizeTransition } from './state/state-transitions.js'
import { describeLeadState } from './state/stage-definitions.js'
import { decideMode, summarizeModeDecision, isValidEscalation } from './routing/mode-router.js'
import { summarizeFullPolicyDecision } from './policy/policy.js'
import { summarizeBotResponse } from './response/response.js'

// ── Sprint 3: Cerebro unificado (banco de pruebas aislado) ──
import { pensarYResponder, summarizeBrainResult } from './brain/agent-brain.js'
import { juzgarRespuesta, juzgarPorRubrica } from './brain/brain-judge.js'
import { BRAIN_EVALS, BRAIN_EVALS_VERSION } from './brain/brain-evals-dataset.js'
import { flattenFactSheet } from './response/factsheet-loader.js'

// ── Fase D: motor de followups (disparado por cron externo) ──
import { ejecutarFollowups, FOLLOWUP_ENGINE_VERSION } from './motor/followupEngine.js'

// ── WhatsApp Cloud API (Meta): recepción. Apagado por default (WHATSAPP_PROVIDER=evolution) ──
import { procesarWebhookCloud } from './whatsapp/cloud/router.js'
import { verifyWebhookChallenge, verifySignature } from './whatsapp/cloud/webhook.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const prisma = new PrismaClient({ log: ['error'] })
const app = Fastify({ logger: false })

// Sentry: captura los errores que Fastify atrapa en los handlers de ruta (los
// no atrapados ya los toma la SDK por los handlers globales). INERTE si no hay
// SENTRY_DSN: la init real vive en instrument.mjs (cargado vía --import antes
// que todo); acá solo enganchamos el error handler de Fastify si está activo.
if (process.env.SENTRY_DSN) Sentry.setupFastifyErrorHandler(app)

await app.register(cors, {
  origin: [
    'https://testing1-crm.vercel.app',
    'https://peru-exporta-crm.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']
})

// ── Health ───────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  service: 'Hidata — WhatsApp Sales ERP',
  version: '7.0.0',
  timestamp: new Date().toISOString()
}))

// ── Debug — Gemini connection ────────────────────────────────
app.get('/debug/gemini-check', async (req, reply) => {
  const result = await geminiHealthCheck()
  return reply.send(result)
})

// ── Debug — Perception single test ───────────────────────────
app.post('/debug/perception-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, context, tenantId = 'peru_exporta', stateless = false } = req.body || {}

  if (!mensaje) {
    return reply.status(400).send({
      error: 'Body must include "mensaje" field',
      example: { mensaje: 'ya pe causa, suena bien', telefono: '51938188585', stateless: true }
    })
  }

  try {
    let result

    if (stateless || !telefono) {
      result = await analizarMensajeStateless({
        mensaje, contexto: context || {}, tenantId
      })
      result._mode = 'stateless'
    } else {
      result = await analizarMensaje({
        mensaje, telefono, tenantId, saveTrace: true
      })
      result._mode = 'full'

      const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
      result._context_summary = summarizeContext(builtContext)
    }

    result._endpoint_latency_ms = Date.now() - startTime
    return reply.send(result)
  } catch (err) {
    console.error('[Debug] Perception test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 5)
    })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — State Layer test (Día 3) ─────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/state-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: {
        mensaje: 'Hola, soy Juan, quiero exportar palta',
        telefono: '51938188585'
      }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({
        error: 'Lead does not exist. State Layer requires existing lead.',
        telefono,
        hint: 'Try /debug/perception-test first to verify the lead exists.'
      })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({
      mensaje, telefono, tenantId, saveTrace: true
    })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({
      perception, leadId, telefono, contextFlags
    })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        perception_intents: perception.intents,
        perception_intent_specific: perception.intent_specific,
        state_before: stateResult.stateBefore
          ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}`
          : null,
        state_after: stateResult.leadState
          ? describeLeadState(stateResult.leadState)
          : null,
        transition_summary: stateResult.transition
          ? summarizeTransition(stateResult.transition)
          : null,
        mode_router_summary: stateResult.modeRouterDecision
          ? summarizeModeDecision(stateResult.modeRouterDecision)
          : null,
        policy_summary: stateResult.policyDecision
          ? summarizeFullPolicyDecision(stateResult.policyDecision)
          : null,
        response_summary: stateResult.botResponse
          ? summarizeBotResponse(stateResult.botResponse)
          : null,
        bot_text: stateResult.botResponse?.text || null,
        slots_changed: stateResult.mergeResult?.change_count || 0,
        latency: {
          perception_ms: perceptionLatency,
          state_ms: stateLatency,
          total_ms: totalLatency
        }
      },
      perception: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern,
        entities: perception.entities,
        sentiment: perception.sentiment,
        signals: perception.signals,
        rationale: perception.rationale,
        meta: perception.meta,
        is_fallback: perception._is_fallback || false
      },
      state: {
        ok: stateResult.ok,
        leadState: stateResult.leadState,
        transition: stateResult.transition,
        mergeResult: stateResult.mergeResult,
        modeRouterDecision: stateResult.modeRouterDecision,
        policyDecision: stateResult.policyDecision,
        botResponse: stateResult.botResponse,
        stateBefore: stateResult.stateBefore,
        errors: stateResult.errors,
        latency_ms: stateResult.latency_ms
      },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] State test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 8)
    })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — Mode Router test (Día 4) ─────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/mode-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta', simulate = null } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example_normal: {
        mensaje: 'Hola, soy Juan',
        telefono: '51938188585'
      },
      example_with_simulation: {
        mensaje: 'Hola, soy Juan',
        telefono: '51938188585',
        simulate: {
          tenantSettings: { estadoSuscripcion: 'past_due', turnosConsumidosMesActual: 10500, turnosIncluidosPorVendedorMes: 10000, numVendedoresPagados: 1 },
          vendorActivo: { id: 1, activo: false, nombre: 'Joan' }
        }
      }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    if (simulate) {
      const currentLeadState = await prisma.leadState.findUnique({ where: { leadId } })
      if (!currentLeadState) {
        return reply.status(404).send({
          error: 'lead_state does not exist. Use /debug/state-test first.',
          telefono, leadId
        })
      }

      const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: false })

      const modeRouterDecision = decideMode({
        leadState: currentLeadState,
        perception,
        context: contextFlags,
        tenantSettings: simulate.tenantSettings || null,
        vendorActivo: simulate.vendorActivo || null
      })

      const escalationValid = isValidEscalation(
        currentLeadState.currentMode,
        modeRouterDecision.decision.final_mode
      )

      return reply.send({
        ok: true,
        _mode: 'simulated',
        _endpoint_latency_ms: Date.now() - startTime,
        summary: {
          lead_id: leadId,
          telefono,
          mensaje,
          mode_router_summary: summarizeModeDecision(modeRouterDecision),
          escalation_valid: escalationValid,
          state_unchanged: 'simulation does not persist any change'
        },
        simulation_inputs: { tenantSettings: simulate.tenantSettings, vendorActivo: simulate.vendorActivo },
        perception_summary: {
          intents: perception.intents,
          intent_specific: perception.intent_specific,
          temperature: perception.sentiment?.temperature
        },
        leadState_used: {
          currentMode: currentLeadState.currentMode,
          currentStage: currentLeadState.currentStage,
          slotsFilled: currentLeadState.slotsFilled
        },
        mode_router_decision: modeRouterDecision
      })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: true })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({ perception, leadId, telefono, contextFlags })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    return reply.send({
      ok: stateResult.ok,
      _mode: 'real',
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        state_before: stateResult.stateBefore ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}` : null,
        state_after: stateResult.leadState ? describeLeadState(stateResult.leadState) : null,
        mode_router_summary: stateResult.modeRouterDecision ? summarizeModeDecision(stateResult.modeRouterDecision) : 'router not executed',
        mode_router_overrode_state: stateResult.modeRouterDecision?.decision?.overrode_state || false,
        guards_triggered: stateResult.modeRouterDecision?.guards_triggered || [],
        latency: { perception_ms: perceptionLatency, state_ms: stateLatency, total_ms: totalLatency }
      },
      perception_summary: { intents: perception.intents, intent_specific: perception.intent_specific, temperature: perception.sentiment?.temperature },
      state: { ok: stateResult.ok, leadState: stateResult.leadState, transition: stateResult.transition, modeRouterDecision: stateResult.modeRouterDecision, errors: stateResult.errors },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Mode test error:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 8) })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — Policy Layer test (Día 5) ────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/policy-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: { mensaje: 'esta caro pe, mucha plata', telefono: '51938188585' }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: true })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({ perception, leadId, telefono, contextFlags })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime
    const policyDecision = stateResult.policyDecision

    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern?.pattern,
        state_before: stateResult.stateBefore ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}` : null,
        state_after: stateResult.leadState ? describeLeadState(stateResult.leadState) : null,
        mode_router_summary: stateResult.modeRouterDecision ? summarizeModeDecision(stateResult.modeRouterDecision) : null,
        policy_summary: policyDecision ? summarizeFullPolicyDecision(policyDecision) : 'policy not executed',
        action_type: policyDecision?.action?.type || null,
        action_strategy: policyDecision?.action?.strategy || null,
        bot_should_respond: policyDecision?.action?.bot_should_respond ?? null,
        rule_matched: policyDecision?.rule_matched || null,
        guardrails_blocking: policyDecision?.guardrails?.blocking_names || [],
        latency: { perception_ms: perceptionLatency, state_ms: stateLatency, total_ms: totalLatency }
      },
      policy: policyDecision ? {
        action: policyDecision.action,
        guardrails: policyDecision.guardrails,
        rule_matched: policyDecision.rule_matched,
        decision_path: policyDecision.decision_path,
        candidates: policyDecision.candidates,
        input_snapshot: policyDecision.input_snapshot,
        meta: policyDecision.meta,
        ok: policyDecision.ok,
        errors: policyDecision.errors
      } : null,
      perception_summary: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        pattern: perception.conversational_pattern?.pattern,
        entities: perception.entities,
        temperature: perception.sentiment?.temperature
      },
      state_summary: {
        ok: stateResult.ok,
        currentStage: stateResult.leadState?.currentStage,
        currentMode: stateResult.leadState?.currentMode,
        slotsFilled: stateResult.leadState?.slotsFilled,
        transition_reason: stateResult.transition?.transition_reason
      },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Policy test error:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 8) })
  }
})

// ════════════════════════════════════════════════════════════════
// ── Debug — Response Layer test (Día 6) ──────────────────────────
// Pipeline completo: Perception → State → ModeRouter → Policy → Response
//
// Body:
//   { mensaje: string, telefono: string }
//
// Devuelve:
//   - El TEXTO generado por el bot (lo más importante)
//   - Audit completo del Response Layer
//   - Decisiones de todas las capas previas
// ════════════════════════════════════════════════════════════════
app.post('/debug/response-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: {
        mensaje: 'esta caro pe, mucha plata',
        telefono: '51938188585'
      }
    })
  }

  try {
    // ─── 1. Construir contexto ───
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    // ─── 2. Pipeline completo Perception → State → ModeRouter → Policy → Response ───
    const perceptionStart = Date.now()
    const perception = await analizarMensaje({
      mensaje, telefono, tenantId, saveTrace: true
    })
    // Asegurar que el mensaje original esté disponible para Response Layer
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({
      perception, leadId, telefono, contextFlags
    })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    const botResponse = stateResult.botResponse
    const policyDecision = stateResult.policyDecision

    // ─── 3. Construir respuesta enriquecida con FOCO en Response ───
    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,

      // ─── 🎯 LO MÁS IMPORTANTE: el texto generado por el bot ───
      bot_text: botResponse?.text || null,
      bot_responded: botResponse?.bot_responded || false,

      // ─── Resumen ejecutivo del pipeline completo ───
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,

        // Perception
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern?.pattern,

        // State
        state_before: stateResult.stateBefore
          ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}`
          : null,
        state_after: stateResult.leadState
          ? describeLeadState(stateResult.leadState)
          : null,

        // Mode Router
        mode_router_summary: stateResult.modeRouterDecision
          ? summarizeModeDecision(stateResult.modeRouterDecision)
          : null,

        // Policy
        policy_summary: policyDecision
          ? summarizeFullPolicyDecision(policyDecision)
          : null,
        action_type: policyDecision?.action?.type || null,
        action_strategy: policyDecision?.action?.strategy || null,

        // ⭐ Response (lo principal de este endpoint)
        response_summary: botResponse
          ? summarizeBotResponse(botResponse)
          : 'response not executed',
        generation_method: botResponse?.generation?.method || null,
        text_length: botResponse?.text?.length || 0,
        response_cost_usd: botResponse?.audit?.cost_usd || 0,
        response_latency_ms: botResponse?.audit?.latency_ms || 0,
        llm_failed: botResponse?.audit?.llm_failed || false,

        latency: {
          perception_ms: perceptionLatency,
          state_ms: stateLatency,
          total_ms: totalLatency
        }
      },

      // ─── Response completo (audit trail) ───
      response: botResponse ? {
        ok: botResponse.ok,
        bot_responded: botResponse.bot_responded,
        text: botResponse.text,
        generation: botResponse.generation,
        audit: botResponse.audit,
        meta: botResponse.meta
      } : null,

      // ─── Datos de soporte ───
      perception_summary: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        pattern: perception.conversational_pattern?.pattern,
        entities: perception.entities,
        temperature: perception.sentiment?.temperature,
        rationale: perception.rationale
      },

      policy_summary: policyDecision ? {
        action_type: policyDecision.action?.type,
        strategy: policyDecision.action?.strategy,
        bot_should_respond: policyDecision.action?.bot_should_respond,
        rule_matched: policyDecision.rule_matched,
        guardrails_blocking: policyDecision.guardrails?.blocking_names || []
      } : null,

      state_summary: {
        ok: stateResult.ok,
        currentStage: stateResult.leadState?.currentStage,
        currentMode: stateResult.leadState?.currentMode,
        slotsFilled: stateResult.leadState?.slotsFilled,
        transition_reason: stateResult.transition?.transition_reason
      },

      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Response test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 8)
    })
  }
})

// ════════════════════════════════════════════════════════════════
// ── Debug — Brain test (Sprint 3) — CEREBRO UNIFICADO AISLADO ────
// Prueba el cerebro nuevo SIN tocar el pipeline real ni ningún lead.
// Le mandas una conversación y devuelve qué responde el cerebro.
//
// Body:
//   {
//     "mensajeActual": "string (requerido)",
//     "historial": [ { "rol": "lead"|"agente", "texto": "..." } ],
//     "estadoLead": { "stage": "presenting", "slots": { "nombre": "Joan" } },
//     "campaignSlug": "MPX"   (carga el factSheet de esa campaña desde la BD)
//   }
// ════════════════════════════════════════════════════════════════
app.post('/debug/brain-test', async (req, reply) => {
  const startTime = Date.now()
  try {
    const {
      mensajeActual,
      historial = [],
      estadoLead = {},
      campaignSlug = 'MPX',
      campaignConfig = null
    } = req.body || {}

    if (!mensajeActual) {
      return reply.code(400).send({
        ok: false,
        error: 'Body must include "mensajeActual"',
        example: {
          mensajeActual: 'mándame los casos de éxito y dime cuándo empiezan las clases y hasta cuándo pago',
          historial: [
            { rol: 'lead', texto: 'Hola, info de cursos de exportación' },
            { rol: 'agente', texto: 'Perfecto, ¿tu nombre y producto?' },
            { rol: 'lead', texto: 'Joan, con RUC' }
          ],
          estadoLead: { stage: 'presenting', slots: { nombre: 'Joan', empresa: 'con RUC' } },
          campaignSlug: 'MPX'
        }
      })
    }

    // Cargar el config de la campaña desde la BD (o usar el que pasen directo)
    let config = campaignConfig
    if (!config && campaignSlug) {
      const campaign = await prisma.campaign.findFirst({
        where: { slug: campaignSlug },
        select: { config: true, nombre: true, slug: true }
      })
      config = campaign?.config || null
      if (!config) {
        console.warn(`[BrainTest] Campaña ${campaignSlug} sin config en BD — el cerebro hablará genérico`)
      }
    }

    // Llamar al cerebro REAL
    const result = await pensarYResponder({
      mensajeActual,
      historial,
      estadoLead,
      campaignConfig: config,
      vendorNombre: estadoLead?.vendorNombre || 'Cristina'
    })

    console.log(`[BrainTest] ${summarizeBrainResult(result)}`)

    return reply.send({
      ok: result.ok,
      // Si falló, el motivo exacto (diagnóstico):
      error: result.error || null,
      error_metadata: result.error_metadata || null,
      // Lo que el lead VERÍA:
      mensaje_al_lead: result.mensaje,
      // Lo interno (auditoría):
      razonamiento: result.razonamiento,
      slots_detectados: result.slots_detectados,
      stage_sugerido: result.stage_sugerido,
      debe_escalar_humano: result.debe_escalar_humano,
      temperatura_lead: result.temperatura_lead,
      guardrail_flags: result.guardrail_flags,
      audit: result.audit,
      campaign_usada: config ? campaignSlug : 'NINGUNA (genérico)',
      total_ms: Date.now() - startTime
    })

  } catch (err) {
    console.error('[BrainTest] Error:', err.message)
    return reply.code(500).send({ ok: false, error: err.message, total_ms: Date.now() - startTime })
  }
})

// ════════════════════════════════════════════════════════════════
// ── Debug — Brain Evals (Sprint 3) — EVALUADOR HÍBRIDO ───────────
// Corre los 26 casos conversacionales: cada uno por CEREBRO + JUEZ LLM.
// Devuelve reporte con PASS/PARCIAL/FAIL para que Joan ponga el sello final.
//
// Body (opcional): { "campaignSlug": "MPX", "idFilter": ["C001","C006"] }
// Sin body corre los 26. Tarda ~1-2 min (chunks de 3).
// ════════════════════════════════════════════════════════════════
app.post('/debug/brain-evals', async (req, reply) => {
  const startTime = Date.now()
  const {
    campaignSlug = 'MPX',
    idFilter = null,
    categoryFilter = null,
    // ── Palancas de banco (Sprint A.2) — domar gemini-3.5 SIN tocar el bot vivo ──
    // overrides: { model?, thinkingLevel?, sinSchema? } → se pasan a pensarYResponder.
    // Sin overrides, el banco corre con la config viva (lo que está en producción).
    overrides = null,
    // Concurrencia: el juez 2.5-flash en location 'global' tira 429 en ráfaga.
    // chunkSize=1 + pausa larga = corrida lenta pero sin 429 (para medir limpio).
    chunkSize = 3,
    pauseMs = 1200
  } = req.body || {}

  try {
    let campaignConfig = null
    const campaign = await prisma.campaign.findFirst({
      where: { slug: campaignSlug },
      select: { config: true, slug: true }
    })
    campaignConfig = campaign?.config || null
    // La ficha REAL aplanada → se la pasamos al juez para que cace datos inventados
    // (banco v2). Sin esto, el juez no sabía qué precio/temario/fechas son legítimos.
    const fichaBloque = flattenFactSheet(campaignConfig)?.factSheetBloque || null

    let casos = BRAIN_EVALS
    if (idFilter && Array.isArray(idFilter)) {
      casos = casos.filter(c => idFilter.includes(c.id))
    }
    if (categoryFilter && Array.isArray(categoryFilter)) {
      casos = casos.filter(c => categoryFilter.includes(c.category))
    }

    const CHUNK_SIZE = Math.max(1, chunkSize)
    const PAUSE_MS = pauseMs
    const resultados = []

    for (let i = 0; i < casos.length; i += CHUNK_SIZE) {
      const chunk = casos.slice(i, i + CHUNK_SIZE)
      const chunkResults = await Promise.all(chunk.map(caso => correrUnCasoEval(caso, campaignConfig, { overrides, fichaBloque })))
      resultados.push(...chunkResults)
      if (i + CHUNK_SIZE < casos.length) await sleep(PAUSE_MS)
    }

    const pass = resultados.filter(r => r.veredicto === 'PASS').length
    const parcial = resultados.filter(r => r.veredicto === 'PARCIAL').length
    const fail = resultados.filter(r => r.veredicto === 'FAIL').length
    const conRedFlags = resultados.filter(r => r.red_flags && r.red_flags.length > 0)
    const avgScore = resultados.length
      ? Math.round(resultados.reduce((s, r) => s + (r.score || 0), 0) / resultados.length)
      : 0
    const costoTotal = resultados.reduce((s, r) => s + (r.costo_caso_usd || 0), 0)

    return reply.send({
      resumen: {
        total_casos: resultados.length,
        PASS: pass, PARCIAL: parcial, FAIL: fail,
        pass_rate: resultados.length ? `${Math.round(pass / resultados.length * 100)}%` : '0%',
        score_promedio: avgScore,
        casos_con_red_flags: conRedFlags.length,
        costo_total_usd: costoTotal.toFixed(5),
        tiempo_total_ms: Date.now() - startTime,
        campaign_usada: campaignConfig ? campaignSlug : 'NINGUNA (genérico)',
        // Config del banco — para comparar corridas (qué modelo/versiones se midió)
        dataset_version: BRAIN_EVALS_VERSION,
        modelo_cerebro: resultados[0]?.modelo_usado || (overrides?.model || 'default'),
        overrides_aplicados: overrides || '(ninguno — config viva)',
        concurrencia: `chunk=${CHUNK_SIZE} pause=${PAUSE_MS}ms`
      },
      requieren_revision: resultados
        .filter(r => r.veredicto !== 'PASS')
        .map(r => ({
          id: r.id, categoria: r.categoria, veredicto: r.veredicto, score: r.score,
          razon_juez: r.razon_juez, red_flags: r.red_flags,
          mensaje_lead: r.input_lead, respuesta_cerebro: r.respuesta_cerebro, esperado: r.esperado
        })),
      todos_los_casos: resultados.map(r => ({
        id: r.id, categoria: r.categoria, veredicto: r.veredicto, score: r.score,
        input_lead: r.input_lead, esperado: r.esperado, respuesta_cerebro: r.respuesta_cerebro,
        slots: r.slots, stage: r.stage, escalo_humano: r.escalo_humano,
        latency_ms: r.latency_ms, razon_juez: r.razon_juez, red_flags: r.red_flags
      }))
    })

  } catch (err) {
    console.error('[BrainEvals] Fatal:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 6) })
  }
})

async function correrUnCasoEval(caso, campaignConfig, banco = {}) {
  const t0 = Date.now()
  const { overrides = null, fichaBloque = null } = banco
  try {
    const brainResult = await pensarYResponder({
      mensajeActual: caso.input.mensajeActual,
      historial: caso.input.historial || [],
      estadoLead: caso.input.estadoLead || {},
      campaignConfig,
      vendorNombre: 'Jhon',
      overrides
    })

    const veredicto = await juzgarRespuesta({ caso, brainResult, fichaBloque })
    const costoCerebro = brainResult?.audit?.cost_usd?.total_cost_usd || 0

    return {
      id: caso.id, categoria: caso.category,
      veredicto: veredicto.veredicto, score: veredicto.score,
      razon_juez: veredicto.razon, red_flags: veredicto.red_flags || [],
      input_lead: caso.input.mensajeActual, esperado: caso.expected,
      respuesta_cerebro: brainResult?.mensaje || `(sin respuesta — error: ${brainResult?.error})`,
      slots: brainResult?.slots_detectados || {}, stage: brainResult?.stage_sugerido,
      escalo_humano: brainResult?.debe_escalar_humano,
      modelo_usado: brainResult?.audit?.model || null,
      latency_ms: brainResult?.audit?.latency_ms || null,
      costo_caso_usd: costoCerebro, _ms: Date.now() - t0
    }
  } catch (err) {
    return {
      id: caso.id, categoria: caso.category, veredicto: 'FAIL', score: 0,
      razon_juez: `Error corriendo el caso: ${err.message}`, red_flags: ['caso_exception'],
      input_lead: caso.input.mensajeActual, esperado: caso.expected,
      respuesta_cerebro: '(crash)', slots: {}, stage: null, escalo_humano: false,
      costo_caso_usd: 0, _ms: Date.now() - t0
    }
  }
}

// ════════════════════════════════════════════════════════════════
// ── Debug — Brain REPLAY (Sprint A.2) — banco multi-turno REAL ───
// Re-juega las conversaciones REALES archivadas turno por turno: en cada punto
// donde el lead escribió y el bot tuvo que responder, le da al cerebro el
// historial real hasta ahí + el mensaje del lead, y juzga su respuesta con la
// rúbrica (reglas duras + calidad). Mide cómo se porta cada modelo en contexto
// real de conversación (no casos sintéticos de 1 turno).
//
// Body: { overrides?, convFilter?:[ids], maxTurns?:int, chunkSize?, pauseMs? }
//   overrides: { model?, useDevApi?, thinkingLevel?, location?, sinSchema? }
// ════════════════════════════════════════════════════════════════
app.post('/debug/brain-replay', async (req, reply) => {
  const startTime = Date.now()
  const { overrides = null, convFilter = null, maxTurns = 6, chunkSize = 2, pauseMs = 1500, campaignSlug = 'MPX' } = req.body || {}

  try {
    const campaign = await prisma.campaign.findFirst({ where: { slug: campaignSlug }, select: { config: true } })
    const campaignConfig = campaign?.config || null
    const fichaBloque = flattenFactSheet(campaignConfig)?.factSheetBloque || null

    // Cargar conversaciones archivadas (raw SQL: la tabla no está en el schema Prisma)
    let convs = await prisma.$queryRawUnsafe(
      `SELECT id, telefono, motivo, mensajes FROM conversaciones_archivadas ORDER BY id`
    )
    if (convFilter && Array.isArray(convFilter)) convs = convs.filter(c => convFilter.includes(Number(c.id)))

    // Extraer los "turnos" evaluables: cada bloque de mensajes LEAD seguido de un BOT.
    const turnos = []
    for (const conv of convs) {
      const msgs = Array.isArray(conv.mensajes) ? conv.mensajes : []
      let i = 0, usados = 0
      while (i < msgs.length && usados < maxTurns) {
        if (msgs[i]?.origen === 'LEAD') {
          const histEnd = i
          const leadMsgs = []
          while (i < msgs.length && msgs[i]?.origen === 'LEAD') { leadMsgs.push(msgs[i].texto); i++ }
          if (i < msgs.length && msgs[i]?.origen === 'BOT') {
            const historial = msgs.slice(0, histEnd).map(m => ({ rol: m.origen === 'LEAD' ? 'lead' : 'agente', texto: m.texto }))
            turnos.push({
              convId: Number(conv.id), motivo: conv.motivo,
              turnoIdx: usados + 1,
              historial, mensajeLead: leadMsgs.filter(Boolean).join('\n'),
              respuestaHistorica: msgs[i].texto
            })
            usados++
          }
        } else i++
      }
    }

    // Correr cada turno: cerebro (con overrides) + juez por rúbrica
    const CHUNK = Math.max(1, chunkSize)
    const resultados = []
    for (let k = 0; k < turnos.length; k += CHUNK) {
      const chunk = turnos.slice(k, k + CHUNK)
      const res = await Promise.all(chunk.map(t => correrUnTurnoReplay(t, campaignConfig, { overrides, fichaBloque })))
      resultados.push(...res)
      if (k + CHUNK < turnos.length) await sleep(pauseMs)
    }

    const pass = resultados.filter(r => r.veredicto === 'PASS').length
    const parcial = resultados.filter(r => r.veredicto === 'PARCIAL').length
    const fail = resultados.filter(r => r.veredicto === 'FAIL').length
    const avg = resultados.length ? Math.round(resultados.reduce((s, r) => s + (r.score || 0), 0) / resultados.length) : 0
    const flags = resultados.flatMap(r => r.red_flags || []).reduce((a, f) => { a[f] = (a[f] || 0) + 1; return a }, {})
    const lat = resultados.filter(r => r.latency_ms)
    const latAvg = lat.length ? Math.round(lat.reduce((s, r) => s + r.latency_ms, 0) / lat.length) : 0

    return reply.send({
      resumen: {
        modelo: resultados[0]?.modelo_usado || (overrides?.useDevApi ? 'devapi:'+(overrides?.model||'?') : overrides?.model || 'default'),
        overrides: overrides || '(config viva)',
        total_turnos: resultados.length, conversaciones: convs.length,
        PASS: pass, PARCIAL: parcial, FAIL: fail,
        pass_rate: resultados.length ? Math.round(pass / resultados.length * 100) + '%' : '0%',
        score_promedio: avg, latencia_prom_ms: latAvg,
        red_flags: flags, judge_version: 'v3_rubrica_multiturno',
        tiempo_total_ms: Date.now() - startTime
      },
      no_pass: resultados.filter(r => r.veredicto !== 'PASS').map(r => ({
        conv: r.convId, turno: r.turnoIdx, veredicto: r.veredicto, score: r.score,
        lead: r.mensajeLead, jhon: r.respuesta_cerebro, razon: r.razon_juez, flags: r.red_flags
      })),
      todos: resultados
    })
  } catch (err) {
    console.error('[BrainReplay] Fatal:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 6) })
  }
})

async function correrUnTurnoReplay(turno, campaignConfig, banco = {}) {
  const t0 = Date.now()
  const { overrides = null, fichaBloque = null } = banco
  try {
    const brainResult = await pensarYResponder({
      mensajeActual: turno.mensajeLead,
      historial: turno.historial,
      estadoLead: { stage: 'first_contact', slots: {} },  // sin slots: ambos modelos rastrean del historial → comparación justa
      campaignConfig, vendorNombre: 'Jhon', overrides
    })
    const veredicto = await juzgarPorRubrica({ historial: turno.historial, mensajeLead: turno.mensajeLead, brainResult, fichaBloque })
    return {
      convId: turno.convId, turnoIdx: turno.turnoIdx, motivo: turno.motivo,
      veredicto: veredicto.veredicto, score: veredicto.score, razon_juez: veredicto.razon,
      red_flags: veredicto.red_flags || [], mensajeLead: turno.mensajeLead,
      respuesta_cerebro: brainResult?.mensaje || `(sin respuesta — ${brainResult?.error})`,
      respuesta_historica: turno.respuestaHistorica,
      slots: brainResult?.slots_detectados || {}, escalo: brainResult?.debe_escalar_humano,
      modelo_usado: brainResult?.audit?.model || null, latency_ms: brainResult?.audit?.latency_ms || null,
      _ms: Date.now() - t0
    }
  } catch (err) {
    return { convId: turno.convId, turnoIdx: turno.turnoIdx, veredicto: 'FAIL', score: 0, razon_juez: `Error: ${err.message}`, red_flags: ['turno_exception'], mensajeLead: turno.mensajeLead, respuesta_cerebro: '(crash)', red_flagsList: [], _ms: Date.now() - t0 }
  }
}

// ────────────────────────────────────────────────────────────
// ── Debug — Run Perception Evals (Día 2) ─────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/run-perception-evals', async (req, reply) => {
  const startTime = Date.now()
  const { categoryFilter = null, idFilter = null } = req.body || {}

  try {
    const datasetPath = join(__dirname, '..', 'data', 'evals-peru-exporta-v2.jsonl')
    const fileContent = await readFile(datasetPath, 'utf-8')
    const allEvals = fileContent
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, i) => {
        try { return JSON.parse(line) } catch (err) { console.error(`[Evals] Línea ${i + 1} inválida:`, err.message); return null }
      })
      .filter(Boolean)

    let perceptionEvals = allEvals.filter(e => e.expected?.perception_intent)
    if (idFilter) perceptionEvals = perceptionEvals.filter(e => idFilter.includes(e.id))
    if (categoryFilter) perceptionEvals = perceptionEvals.filter(e => e.category === categoryFilter)

    const ejecutables = perceptionEvals.filter(e => { const msg = e.input?.lead_message; return msg && typeof msg === 'string' && msg.trim().length > 0 })
    const noEjecutables = perceptionEvals.filter(e => { const msg = e.input?.lead_message; return !msg || typeof msg !== 'string' || msg.trim().length === 0 })

    const CHUNK_SIZE = 3
    const SLEEP_BETWEEN_CHUNKS_MS = 1000
    const details = []

    for (let i = 0; i < ejecutables.length; i += CHUNK_SIZE) {
      const chunk = ejecutables.slice(i, i + CHUNK_SIZE)
      const chunkResults = await Promise.all(chunk.map(async (evalCase) => runSingleEval(evalCase)))
      details.push(...chunkResults)
      if (i + CHUNK_SIZE < ejecutables.length) await sleep(SLEEP_BETWEEN_CHUNKS_MS)
    }

    const passed = details.filter(d => d.status === 'passed').length
    const failed = details.filter(d => d.status === 'failed').length
    const errors = details.filter(d => d.status === 'error').length
    const totalCost = details.reduce((sum, d) => sum + (d.cost_usd || 0), 0)
    const totalLatency = details.reduce((sum, d) => sum + (d.latency_ms || 0), 0)
    const avgLatency = details.length > 0 ? Math.round(totalLatency / details.length) : 0

    return reply.send({
      summary: {
        total_in_dataset: allEvals.length,
        with_perception_intent: perceptionEvals.length,
        executable: ejecutables.length,
        skipped_sequence_evals: noEjecutables.length,
        passed, failed, errors,
        pass_rate: ejecutables.length > 0 ? (passed / ejecutables.length).toFixed(2) : 0,
        total_cost_usd: totalCost.toFixed(6),
        avg_latency_ms: avgLatency,
        total_runtime_ms: Date.now() - startTime
      },
      passed_evals: details.filter(d => d.status === 'passed').map(d => ({ id: d.eval_id, category: d.category, expected: d.expected_intent, got: d.got_summary })),
      failed_evals: details.filter(d => d.status === 'failed').map(d => ({ id: d.eval_id, category: d.category, expected: d.expected_intent, expected_level: d.expected_level, got_intents: d.got_intents, got_intent_specific: d.got_intent_specific, got_pattern: d.got_pattern, rationale: d.rationale, diagnosis: d.diagnosis, latency_ms: d.latency_ms, cost_usd: d.cost_usd })),
      error_evals: details.filter(d => d.status === 'error').map(d => ({ id: d.eval_id, category: d.category, error: d.error, latency_ms: d.latency_ms })),
      skipped_evals: noEjecutables.map(e => ({ id: e.id, category: e.category, reason: 'requires_sequence_evaluation_not_perception' }))
    })
  } catch (err) {
    console.error('[Evals] Fatal error:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 8) })
  }
})

async function runSingleEval(evalCase, retryCount = 0) {
  const startTime = Date.now()
  const expectedIntent = evalCase.expected.perception_intent
  const expectedLevel = classifyExpectedIntent(expectedIntent)

  try {
    const result = await analizarMensajeStateless({
      mensaje: evalCase.input.lead_message,
      contexto: evalCase.input.context || {},
      tenantId: 'peru_exporta'
    })

    if (result._is_fallback && retryCount < 1) {
      await sleep(2000)
      return runSingleEval(evalCase, retryCount + 1)
    }

    let passed = false
    let diagnosis = null

    if (expectedLevel === 'level_1') {
      passed = result.intents?.includes(expectedIntent)
      if (!passed) diagnosis = `Expected "${expectedIntent}" in intents[], got [${result.intents?.join(', ')}]`
    } else if (expectedLevel === 'level_2') {
      passed = result.intent_specific === expectedIntent
      if (!passed) {
        if (result.intent_specific === null) {
          diagnosis = `Expected intent_specific="${expectedIntent}" but got null. Parent intent was [${result.intents?.join(', ')}]`
        } else {
          diagnosis = `Expected intent_specific="${expectedIntent}" but got "${result.intent_specific}"`
        }
      }
    } else if (expectedLevel === 'level_3') {
      passed = result.conversational_pattern?.pattern === expectedIntent
      if (!passed) diagnosis = `Expected conversational_pattern="${expectedIntent}" but got ${result.conversational_pattern?.pattern || 'null'}`
    } else {
      diagnosis = `Unknown expected level for "${expectedIntent}"`
    }

    return {
      eval_id: evalCase.id,
      category: evalCase.category,
      status: passed ? 'passed' : 'failed',
      expected_intent: expectedIntent,
      expected_level: expectedLevel,
      got_intents: result.intents,
      got_intent_specific: result.intent_specific,
      got_pattern: result.conversational_pattern?.pattern || null,
      got_summary: passed ? `${expectedIntent} ✓` : null,
      rationale: result.rationale,
      diagnosis,
      latency_ms: Date.now() - startTime,
      cost_usd: result.meta?.cost_usd || 0,
      _retried: retryCount > 0
    }
  } catch (err) {
    return {
      eval_id: evalCase.id,
      category: evalCase.category,
      status: 'error',
      error: err.message,
      expected_intent: expectedIntent,
      latency_ms: Date.now() - startTime,
      cost_usd: 0
    }
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// ── Auth ─────────────────────────────────────────────────────
app.get('/auth/vendors',  async (req, reply) => getVendorNames(req, reply, prisma))
app.post('/auth/login',   async (req, reply) => loginVendor(req, reply, prisma))

// ── Webhook ──────────────────────────────────────────────────
app.post('/webhook', async (req, reply) => handleWebhook(req, reply, prisma))
app.get('/webhook',  async () => ({ status: 'webhook activo', version: '7.0.0' }))

// ── Cron: motor de followups (Fase D) ────────────────────────
// Lo dispara un cron externo (cron-job.org / Render Cron) cada ~15 min.
// Protegido por secret (?secret= o header x-cron-secret). El motor ya tiene su
// propia ventana horaria, así que es seguro pegarle aunque sea de madrugada.
async function handleCronFollowup(req, reply) {
  if (!process.env.CRON_SECRET) {
    return reply.code(503).send({ error: 'CRON_SECRET no configurado en el entorno' })
  }
  const secret = req.query?.secret || req.headers['x-cron-secret']
  if (secret !== process.env.CRON_SECRET) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  const r = await ejecutarFollowups()
  return reply.send({ engine: FOLLOWUP_ENGINE_VERSION, ...r })
}
app.get('/cron/followup',  handleCronFollowup)
app.post('/cron/followup', handleCronFollowup)

// ── Webhook Cloud API (Meta) — endpoint SEPARADO, NO toca /webhook de Evolution ──
// GET = handshake de verificación de Meta (hub.challenge). POST = mensajes entrantes.
// Inerte hasta que se configure el número (CLOUD_* env vars) y WHATSAPP_PROVIDER=cloud.
app.get('/webhook/cloud', async (req, reply) => {
  const r = verifyWebhookChallenge(req.query || {})
  if (r.ok) return reply.code(200).type('text/plain').send(r.challenge)
  return reply.code(403).send('forbidden')
})
app.post('/webhook/cloud', async (req, reply) => {
  // Firma best-effort: si hay rawBody + CLOUD_APP_SECRET, se valida. La firma ESTRICTA
  // se activa al enchufar el número (agregando el content-type parser que guarda rawBody).
  const sig = req.headers['x-hub-signature-256']
  if (req.rawBody && process.env.CLOUD_APP_SECRET) {
    const v = verifySignature(req.rawBody, sig)
    if (!v.ok) { console.warn(`[CloudWebhook] firma inválida: ${v.reason}`); return reply.code(401).send('invalid signature') }
  }
  // Meta espera respuesta <5s o reintenta → responder ya y procesar en segundo plano.
  reply.code(200).send('EVENT_RECEIVED')
  procesarWebhookCloud(req.body).catch(e => console.error('[CloudWebhook] error:', e.message))
})

// ── Leads ────────────────────────────────────────────────────
app.get('/leads',                async (req, reply) => getLeads(req, reply, prisma))
app.put('/leads/:id',            async (req, reply) => updateLead(req, reply, prisma))
app.post('/leads/:id/mensaje',   async (req, reply) => sendMensaje(req, reply, prisma))
app.post('/leads/:id/accion',    async (req, reply) => doAccion(req, reply, prisma))
app.get('/leads/:id/mensajes',   async (req, reply) => getMensajes(req, reply, prisma)) 
app.get('/reportes',             async (req, reply) => getReportes(req, reply, prisma))

// ── Config ───────────────────────────────────────────────────
app.get('/config/bot',  async (req, reply) => getBotConfig(req, reply, prisma))
app.put('/config/bot',  async (req, reply) => updateBotConfig(req, reply, prisma))
app.get('/config/vendedores',                async (req, reply) => getVendedores(req, reply, prisma))
app.post('/config/vendedores',               async (req, reply) => createVendedor(req, reply, prisma))
app.put('/config/vendedores/:id',            async (req, reply) => updateVendedor(req, reply, prisma))
app.put('/config/vendedores/:id/desactivar', async (req, reply) => desactivarVendedor(req, reply, prisma))

// ── Campaigns ────────────────────────────────────────────────
app.get('/campaigns',                      async (req, reply) => getCampaigns(req, reply, prisma))
app.get('/campaigns/:id',                  async (req, reply) => getCampaign(req, reply, prisma))
app.post('/campaigns',                     async (req, reply) => createCampaign(req, reply, prisma))
app.put('/campaigns/:id',                  async (req, reply) => updateCampaign(req, reply, prisma))
app.delete('/campaigns/:id',               async (req, reply) => deleteCampaign(req, reply, prisma))
app.put('/campaigns/:id/steps',            async (req, reply) => saveSteps(req, reply, prisma))
app.post('/campaigns/:id/triggers',        async (req, reply) => addTrigger(req, reply, prisma))
app.delete('/campaigns/:id/triggers/:tid', async (req, reply) => deleteTrigger(req, reply, prisma))
app.post('/campaigns/test-trigger',        async (req, reply) => testTrigger(req, reply, prisma))
app.patch('/campaigns/:id/activar',        async (req, reply) => activarCampaign(req, reply, prisma))

// ── Vendors ──────────────────────────────────────────────────
app.get('/vendors', async (req, reply) => {
  const vendors = await prisma.vendor.findMany({
    where: { activo: true },
    select: { id: true, nombre: true, telefono: true, role: true, instanciaEvolution: true }
  })
  return vendors
})



// ── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await prisma.$connect()
  console.log('✅ PostgreSQL conectado')
  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔════════════════════════════════════════╗
║   Hidata — WhatsApp Sales ERP v20      ║
║   Puerto: ${PORT}                      ║
║   Día 8: Audit + cleanup arquitectónico║
╚════════════════════════════════════════╝
  `)
} catch (error) {
  console.error('❌ Error arrancando servidor:', error)
  await prisma.$disconnect()
  process.exit(1)
}

process.on('SIGTERM', async () => {
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
})
