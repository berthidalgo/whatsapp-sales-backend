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
async function getGeminiClient(tenantId = 'peru_exporta') {
  // Intenta leer configuración dedicada del tenant
  let projectId = DEFAULT_PROJECT
  let location = DEFAULT_LOCATION
  
  try {
    const tenant = await prisma.tenantSettings.findUnique({
      where: { tenantId }
    })
    
    // En el futuro: si el tenant tiene byok_enabled, usar su propio project
    // Hoy: todos los tenants usan el project maestro de Hidata
    if (tenant?.byokEnabled && tenant?.geminiApiKeyEncrypted) {
      // TODO Fase 4: parsear project/location desde tenant settings
      // Por ahora ignoramos byok y usamos el master
    }
  } catch (err) {
    console.warn('[Gemini] No se pudo leer tenant_settings:', err.message)
  }
  
  // Vertex AI usa Application Default Credentials (Service Account)
  // No requiere apiKey: las credenciales vienen del JSON via env var
  // GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-credentials.json
  return new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location: location
  })
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
  maxOutputTokens = 2048
}) {
  const startTime = Date.now()
  const client = await getGeminiClient(tenantId)
  
  const config = {
    temperature,
    maxOutputTokens
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
