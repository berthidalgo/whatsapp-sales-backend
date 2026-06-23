// src/lib/gemini.js — Hidata v20
// Wrapper de Gemini 2.5 Flash usando Vertex AI (Google Cloud)
// 
// MIGRADO desde AI Studio API a Vertex AI para aprovechar los créditos
// de Google Cloud Free Trial (S/1,057 disponibles).
//
// Multi-tenant ready: cada tenant puede tener su propio project_id futuro.
//
// Autenticación: Service Account JSON via GOOGLE_APPLICATION_CREDENTIALS
//
// FIX Día 7: pricing corregido + soporte para Flash Lite

import { GoogleGenAI } from '@google/genai'
import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN GLOBAL
// ════════════════════════════════════════════════════════
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'graceful-envoy-493005-m7'
const DEFAULT_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'

// ════════════════════════════════════════════════════════
// CLIENT FACTORY — multi-tenant ready (Vertex AI)
// ════════════════════════════════════════════════════════
// CACHE del cliente por tenant (Sprint A.2): antes se creaba un GoogleGenAI NUEVO
// y se consultaba tenant_settings en BD en CADA llamada a Gemini (cada turno del
// bot + cada caso de eval). Eso: (a) pegaba a la BD sin necesidad, (b) re-instanciaba
// el SDK, (c) hacía que el SDK escupiera su log de auth ("project/location will take
// precedence...") en cada llamada → inundaba los logs de Render. Ahora se construye
// UNA vez por tenant por proceso y se reusa. El log de auth sale 1 vez, no miles.
const clientCache = new Map()

async function getGeminiClient(tenantId = 'peru_exporta', opts = {}) {
  const { location: locationOverride = null, apiKey: apiKeyOverride = null } = opts

  // Llave de cache que distingue las 3 puertas, para no mezclar clientes:
  //   - Developer API (apiKey): el backend de aistudio/gemini.google.com.
  //   - Vertex + location override (ej: 'global' para gemini-3.5-flash).
  //   - Vertex vivo (us-central1).
  // FIX (peritaje Sprint A.2): antes el cache CHEQUEABA por cacheKey pero GUARDABA
  // por tenantId → un cliente de banco (global) se cacheaba bajo la llave viva y
  // contaminaba al bot real. Ahora set y get usan la MISMA cacheKey.
  const cacheKey = apiKeyOverride ? `${tenantId}:devapi`
    : locationOverride ? `${tenantId}:${locationOverride}`
    : tenantId
  const cached = clientCache.get(cacheKey)
  if (cached) return cached

  let client
  if (apiKeyOverride) {
    // ── Puerta Developer API (banco): solo apiKey, sin vertexai/project/location.
    // Mismo backend que la web de Gemini → cuota generosa, ideal para el 3.5. ──
    client = new GoogleGenAI({ apiKey: apiKeyOverride })
  } else {
    // ── Puerta Vertex AI (viva): Service Account (ADC) + project + location. ──
    let projectId = DEFAULT_PROJECT
    let location = locationOverride || DEFAULT_LOCATION

    try {
      const tenant = await prisma.tenantSettings.findUnique({ where: { tenantId } })
      // En el futuro: si el tenant tiene byok_enabled, usar su propio project.
      // Hoy: todos los tenants usan el project maestro de Hidata.
      if (tenant?.byokEnabled && tenant?.geminiApiKeyEncrypted) {
        // TODO Fase 4: parsear project/location desde tenant settings
      }
    } catch (err) {
      console.warn('[Gemini] No se pudo leer tenant_settings:', err.message)
    }

    // GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-credentials.json
    client = new GoogleGenAI({ vertexai: true, project: projectId, location })
  }

  clientCache.set(cacheKey, client)
  return client
}

// ════════════════════════════════════════════════════════
// HEALTH CHECK — verifica que Gemini responde via Vertex AI
// ════════════════════════════════════════════════════════
export async function geminiHealthCheck(tenantId = 'peru_exporta') {
  const startTime = Date.now()
  
  try {
    const client = await getGeminiClient(tenantId)
    
    const response = await client.models.generateContent({
      model: DEFAULT_MODEL,
      contents: 'Responde solo con la palabra: OK'
    })
    
    const text = response.text || ''
    const latencyMs = Date.now() - startTime
    
    return {
      ok: true,
      tenantId,
      project: DEFAULT_PROJECT,
      location: DEFAULT_LOCATION,
      model: DEFAULT_MODEL,
      response: text.trim(),
      latency_ms: latencyMs,
      usage: response.usageMetadata || null,
      _backend: 'vertex_ai'
    }
  } catch (err) {
    return {
      ok: false,
      tenantId,
      project: DEFAULT_PROJECT,
      location: DEFAULT_LOCATION,
      error: err.message,
      error_stack: err.stack?.split('\n').slice(0, 5),
      latency_ms: Date.now() - startTime,
      _backend: 'vertex_ai'
    }
  }
}

// ════════════════════════════════════════════════════════
// API PRINCIPAL — la usan Perception, Policy, Response
// ════════════════════════════════════════════════════════
export async function callGemini({
  tenantId = 'peru_exporta',
  model = DEFAULT_MODEL,
  systemInstruction = null,
  contents,
  responseSchema = null,
  temperature = 0.3,
  maxOutputTokens = 2048,
  thinkingBudget = null,
  thinkingLevel = null,
  location = null,
  apiKey = null
}) {
  const startTime = Date.now()
  const client = await getGeminiClient(tenantId, { location, apiKey })

  const config = {
    temperature,
    maxOutputTokens
  }

  // FIX jun 2026 (bug Sesión 4): los Gemini "piensan" antes de responder y el
  // pensamiento consume del MISMO presupuesto de maxOutputTokens. Gemini 3.5
  // piensa mucho más que 2.5: en turnos pesados (M4) quemaba los 4000 tokens
  // pensando y devolvía texto VACÍO ("sin texto en respuesta" x3 → hueco mudo).
  // thinkingBudget acota el pensamiento y garantiza espacio para la respuesta.
  //
  // Banco v2 (Sprint A.2): los Gemini 3.x NO usan presupuesto numérico sino
  // thinkingLevel ('low'|'medium'|'high'). Si llega thinkingLevel, MANDA sobre
  // thinkingBudget (son excluyentes en la API). Solo lo usa el banco de pruebas.
  if (thinkingLevel !== null) {
    config.thinkingConfig = { thinkingLevel }
  } else if (thinkingBudget !== null) {
    config.thinkingConfig = { thinkingBudget }
  }

  if (systemInstruction) {
    config.systemInstruction = systemInstruction
  }
  
  if (responseSchema) {
    config.responseMimeType = 'application/json'
    config.responseSchema = responseSchema
  }
  
  const response = await client.models.generateContent({
    model,
    contents,
    config
  })
  
  return {
    text: response.text,
    response,
    latencyMs: Date.now() - startTime,
    usage: response.usageMetadata,
    model
  }
}

// ════════════════════════════════════════════════════════
// CALCULADORA DE COSTOS — Pricing OFICIAL de Vertex AI
// FIX Día 7: pricing corregido + soporte Flash Lite
// 
// Fuente: https://cloud.google.com/vertex-ai/generative-ai/pricing
// Verificado: Mayo 2026
// ════════════════════════════════════════════════════════
const PRICING_PER_1M_TOKENS = {
  // Modelo principal — usado en Perception
  'gemini-2.5-flash': {
    input:  0.30,    // USD por 1M tokens (FIX: era 0.075, incorrecto)
    output: 2.50     // USD por 1M tokens (FIX: era 0.30, incorrecto)
  },
  
  // Modelo ligero — usado en Response Layer (Día 6+)
  'gemini-2.5-flash-lite': {
    input:  0.10,    // 3x más barato que Flash regular
    output: 0.40     // 6x más barato que Flash regular
  },
  
  // Modelo flagship — reservado para casos complejos futuros
  'gemini-2.5-pro': {
    input:  1.25,
    output: 10.00
  },

  // Generación 3.5 — el cerebro migra aquí (Sprint A.2, decisión Joan 2026-06-11).
  // GA desde Google I/O (19-may-2026), sin riesgo de jubilación de preview.
  // Fuente: ai.google.dev/gemini-api/docs/pricing, verificado 2026-06-11.
  // Costo ~5x vs 2.5-flash → mitigación futura: context caching ($0.15/M cacheado).
  'gemini-3.5-flash': {
    input:  1.50,
    output: 9.00
  }
}

/**
 * Calcula el costo en USD de una llamada a Gemini.
 * 
 * Acepta dos signatures para compatibilidad:
 *   1. calculateCost(model, usage)          → modo objeto (Perception)
 *   2. calculateCost(model, inputTokens, outputTokens) → modo separado (Response)
 * 
 * @param {string} model - Modelo usado (gemini-2.5-flash, etc)
 * @param {object|number} usageOrInput - Objeto usage o número de input tokens
 * @param {number} [outputTokens] - Solo si signature #2
 * @returns {object|number} Objeto con desglose o número simple
 */
export function calculateCost(model, usageOrInput, outputTokens) {
  const pricing = PRICING_PER_1M_TOKENS[model]
  
  if (!pricing) {
    console.warn(`[Gemini] No pricing defined for model: ${model}`)
    return null
  }
  
  let inputTokens = 0
  let outTokens = 0
  let returnSimple = false
  
  // Detectar signature
  if (typeof usageOrInput === 'object' && usageOrInput !== null) {
    // Signature #1: calculateCost(model, usage)
    inputTokens = usageOrInput.promptTokenCount     || 0
    outTokens   = usageOrInput.candidatesTokenCount || 0
  } else if (typeof usageOrInput === 'number') {
    // Signature #2: calculateCost(model, inputTokens, outputTokens)
    inputTokens = usageOrInput
    outTokens   = outputTokens || 0
    returnSimple = true   // Response-llm.js espera número simple
  } else {
    console.warn('[Gemini] calculateCost: invalid usage param')
    return null
  }
  
  const inputCost  = (inputTokens  / 1_000_000) * pricing.input
  const outputCost = (outTokens    / 1_000_000) * pricing.output
  const totalCost  = inputCost + outputCost
  
  // Si signature #2, devolver número simple (compatible con response-llm.js)
  if (returnSimple) {
    return totalCost
  }
  
  // Si signature #1, devolver objeto detallado (compatible con perception.js)
  return {
    input_tokens:    inputTokens,
    output_tokens:   outTokens,
    total_tokens:    inputTokens + outTokens,
    input_cost_usd:  inputCost,
    output_cost_usd: outputCost,
    total_cost_usd:  totalCost
  }
}
