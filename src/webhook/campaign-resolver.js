// src/webhook/campaign-resolver.js — Hidata v20 · Sprint 2 (oleada 1)
//
// CAMPAIGN RESOLVER — decide QUÉ campaña corresponde a un lead entrante.
//
// ─────────────────────────────────────────────────────────────────────────
// REEMPLAZA el hardcode DEFAULT_CAMPAIGN_SLUG = 'MPX' del lead-resolver.
//
// El número NO identifica la campaña (hasta 3 campañas corren simultáneas a
// los mismos 3 números). La llave principal es el TRIGGER DE TEXTO que el
// traffiker define en Facebook Ads y nos comunica.
//
// Cascada de atribución (se evalúan en orden hasta que una matchee):
//   Plan A (PRINCIPAL): trigger de texto, matcheo FLEXIBLE por contención.
//        Reusa la MISMA lógica que el usuario prueba en el dashboard
//        (POST /campaigns/test-trigger). Coherencia total: lo que el traffiker
//        prueba en su UI es exactamente lo que el bot asigna en producción.
//   Plan B (REFUERZO): externalAdReply.title del payload CTWA confirma campaña.
//   Plan C (FALLBACK): si NADA matchea (texto libre u orgánico) → modo
//        descubrimiento. El bot NO adivina: pregunta qué curso interesa.
//   Plan D: conversionSource (FB_Ads vs orgánico) → solo tagging/analítica.
//
// ⚠️ DORMIDO en la oleada 1: este módulo existe pero todavía NO se llama desde
//    el pipeline. La oleada 2 lo cablea en el lead-resolver y mata el hardcode.
// ─────────────────────────────────────────────────────────────────────────

import prisma from '../db/prisma.js'

const DEFAULT_TENANT_ID = 'peru_exporta'

// ════════════════════════════════════════════════════════
// Normalización (IDÉNTICA a src/routes/campaigns.js para coherencia)
// minúsculas + sin tildes (NFD) + sin símbolos
// ════════════════════════════════════════════════════════
export function normalizeText(s) {
  if (!s || typeof s !== 'string') return ''
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

// ════════════════════════════════════════════════════════
// API PÚBLICA — resolveCampaign()
// ════════════════════════════════════════════════════════

/**
 * Resuelve la campaña de un lead entrante a partir del texto y el contexto CTWA.
 *
 * @param {object}  args
 * @param {string}  args.text       - primer mensaje del lead
 * @param {object?} args.adContext  - { adReplyTitle, conversionSource, ... } (Plan B/D)
 * @param {string?} args.tenantId
 * @returns {Promise<{
 *   campaignId: number|null,
 *   slug: string|null,
 *   nombre: string|null,
 *   config: object|null,
 *   matchType: 'trigger' | 'adReplyTitle' | 'discovery',
 *   matchedTrigger: string|null,
 *   discoveryMessage: string|null,
 *   conversionSource: string|null
 * }>}
 */
export async function resolveCampaign({
  text,
  adContext = null,
  tenantId = DEFAULT_TENANT_ID
}) {
  const conversionSource = adContext?.conversionSource || null   // Plan D (tagging)

  // Cargamos TODAS las campañas activas del tenant con sus triggers.
  // (Dinámico: lee lo que el usuario tenga creado en su dashboard, no hardcode.)
  let campaigns = []
  try {
    campaigns = await prisma.campaign.findMany({
      where: { tenantId, activa: true },
      select: {
        id: true,
        slug: true,
        nombre: true,
        config: true,
        triggers: { select: { texto: true } }
      }
    })
  } catch (err) {
    console.error('[CampaignResolver] DB error loading campaigns:', err.message)
    return buildDiscovery(null, conversionSource)
  }

  if (campaigns.length === 0) {
    console.warn(`[CampaignResolver] No active campaigns for tenant "${tenantId}"`)
    return buildDiscovery(null, conversionSource)
  }

  const normalizedMsg = normalizeText(text)

  // ── Plan A: matcheo flexible por contención contra triggers ──
  if (normalizedMsg) {
    for (const c of campaigns) {
      const matched = (c.triggers || []).find(
        t => t.texto && normalizedMsg.includes(normalizeText(t.texto))
      )
      if (matched) {
        console.log(`[CampaignResolver] Plan A · "${matched.texto}" → ${c.slug}`)
        return {
          campaignId: c.id,
          slug: c.slug,
          nombre: c.nombre,
          config: c.config || null,
          matchType: 'trigger',
          matchedTrigger: matched.texto,
          discoveryMessage: null,
          conversionSource
        }
      }
    }
  }

  // ── Plan B: refuerzo por externalAdReply.title ──
  const adTitle = adContext?.adReplyTitle ? normalizeText(adContext.adReplyTitle) : null
  if (adTitle) {
    for (const c of campaigns) {
      const titles = (c.config?.atribucion?.adReplyTitles || []).map(normalizeText)
      if (titles.some(t => t && (adTitle.includes(t) || t.includes(adTitle)))) {
        console.log(`[CampaignResolver] Plan B · adReplyTitle "${adContext.adReplyTitle}" → ${c.slug}`)
        return {
          campaignId: c.id,
          slug: c.slug,
          nombre: c.nombre,
          config: c.config || null,
          matchType: 'adReplyTitle',
          matchedTrigger: null,
          discoveryMessage: null,
          conversionSource
        }
      }
    }
  }

  // ── Plan C: nada matcheó → modo descubrimiento (el bot NO adivina) ──
  console.log(`[CampaignResolver] Plan C · sin match → modo descubrimiento (source=${conversionSource || 'orgánico'})`)
  // Mensaje de descubrimiento: el de la campaña default si existe, si no uno genérico
  const defaultCampaign =
    campaigns.find(c => c.config?.atribucion?.esCampanaDefault) || null
  return buildDiscovery(defaultCampaign, conversionSource)
}

// ════════════════════════════════════════════════════════
// HELPER — respuesta de modo descubrimiento
// ════════════════════════════════════════════════════════

function buildDiscovery(defaultCampaign, conversionSource) {
  const msg =
    defaultCampaign?.config?.atribucion?.mensajeDescubrimiento ||
    '¡Hola! Con gusto te ayudo. ¿Sobre qué curso quieres información?'

  return {
    campaignId: defaultCampaign?.id || null,
    slug: defaultCampaign?.slug || null,
    nombre: defaultCampaign?.nombre || null,
    config: defaultCampaign?.config || null,
    matchType: 'discovery',
    matchedTrigger: null,
    discoveryMessage: msg,
    conversionSource
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — resumen para logs
// ════════════════════════════════════════════════════════

export function summarizeCampaignResolution(r) {
  if (!r) return 'no result'
  if (r.matchType === 'discovery') {
    return `🔎 discovery (sin campaña asignada${r.slug ? `, default ${r.slug}` : ''})`
  }
  return `🎯 ${r.slug} via ${r.matchType}${r.matchedTrigger ? ` ("${r.matchedTrigger}")` : ''}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const CAMPAIGN_RESOLVER_VERSION = 'v1_sprint2_trigger_match'
