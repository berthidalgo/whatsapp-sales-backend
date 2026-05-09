// src/lib/gemini.js — Hidata v20
// Wrapper de Gemini 2.5 Flash multi-tenant ready
// 
// Hoy: usa GEMINI_API_KEY del env (key maestra de Joan)
// Futuro: lee gemini_api_key_encrypted de tenant_settings por tenantId
// 
// Versión inicial — apenas envuelve la SDK oficial @google/genai
// El uso real (Perception, Policy, Response) viene en Días 2-6

import { GoogleGenAI } from '@google/genai'
import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// MODELO POR DEFECTO
// ════════════════════════════════════════════════════════
const DEFAULT_MODEL = 'gemini-2.5-flash'

// ════════════════════════════════════════════════════════
// CLIENT FACTORY — multi-tenant ready
// ════════════════════════════════════════════════════════
async function getGeminiClient(tenantId = 'peru_exporta') {
  // Intenta leer key dedicada del tenant
  let apiKey = null
  
  try {
    const tenant = await prisma.tenantSettings.findUnique({
      where: { tenantId }
    })
    
    // Solo usa key del tenant si está habilitado BYOK explícitamente
    if (tenant?.byokEnabled && tenant?.geminiApiKeyEncrypted) {
      apiKey = tenant.geminiApiKeyEncrypted
      // TODO Fase 4: descifrar con KMS antes de usar
    }
  } catch (err) {
    console.warn('[Gemini] No se pudo leer tenant_settings:', err.message)
  }
  
  // Fallback: key maestra del env (caso default hoy)
  apiKey = apiKey || process.env.GEMINI_API_KEY
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurada en env ni en tenant_settings')
  }
  
  return new GoogleGenAI({ apiKey })
}

// ════════════════════════════════════════════════════════
// HEALTH CHECK — verifica que Gemini responde
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
      model: DEFAULT_MODEL,
      response: text.trim(),
      latency_ms: latencyMs,
      usage: response.usageMetadata || null
    }
  } catch (err) {
    return {
      ok: false,
      tenantId,
      error: err.message,
      latency_ms: Date.now() - startTime
    }
  }
}

// ════════════════════════════════════════════════════════
// API PRINCIPAL — la usarán Perception, Policy, Response
// ════════════════════════════════════════════════════════
export async function callGemini({
  tenantId = 'peru_exporta',
  model = DEFAULT_MODEL,
  systemInstruction = null,
  contents,
  responseSchema = null,  // para structured output
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
// CALCULADORA DE COSTOS — Gemini 2.5 Flash pricing oficial
// Mayo 2026 — verificar periódicamente en ai.google.dev/pricing
// ════════════════════════════════════════════════════════
const PRICING_PER_1M_TOKENS = {
  'gemini-2.5-flash': {
    input:  0.075,  // USD
    output: 0.30    // USD
  }
}

export function calculateCost(model, usage) {
  if (!usage) return null
  
  const pricing = PRICING_PER_1M_TOKENS[model]
  if (!pricing) return null
  
  const inputTokens  = usage.promptTokenCount    || 0
  const outputTokens = usage.candidatesTokenCount || 0
  
  const inputCost  = (inputTokens  / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  const totalCost  = inputCost + outputCost
  
  return {
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    total_tokens:  inputTokens + outputTokens,
    input_cost_usd:  inputCost,
    output_cost_usd: outputCost,
    total_cost_usd:  totalCost
  }
}