// src/brain/verticals/index.js — REGISTRY DE VERTICALES (jul 2026)
//
// El "vertical" es el manual de venta que usa el cerebro: persona + momentos +
// schema de slots + validaciones propias del negocio. El MOTOR (retry, fallback
// LLM, guardrails genéricos, parseo, kill-stale) es el mismo para todos.
//
// Resolución (de más específico a más general):
//   1. campaignConfig.vertical  → la campaña manda (permite A/B y migraciones)
//   2. default del tenant       → bioayur=colageno, peru_exporta=exportacion
//   3. 'exportacion'            → default histórico (cero regresión)
//
// Un vertical id desconocido cae a exportación CON warning — el bot jamás se
// queda sin manual (mismo principio del fallback LLM: degradar, nunca morir).

import * as exportacion from './exportacion.js'
import * as colageno from './colageno.js'
import { verticalPorTenant } from '../../lib/tenant.js'

const REGISTRY = {
  exportacion,
  colageno
}

export function getVertical(campaignConfig = null, tenantId = null) {
  const pedido = campaignConfig?.vertical || verticalPorTenant(tenantId)
  const v = REGISTRY[pedido]
  if (!v) {
    console.warn(`[Verticals] vertical desconocido "${pedido}" (tenant=${tenantId}) → fallback a exportacion`)
    return exportacion
  }
  return v
}

export const VERTICALES_DISPONIBLES = Object.keys(REGISTRY)
export const VERTICALS_VERSION = 'v1_registry'
