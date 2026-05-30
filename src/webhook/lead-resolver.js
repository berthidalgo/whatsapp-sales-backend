// src/webhook/lead-resolver.js — Hidata v20 · Sprint 2 (paso 1a — identidad @lid)
//
// LEAD RESOLVER — resuelve la IDENTIDAD del lead a partir del payload de Baileys.
//
// ─────────────────────────────────────────────────────────────────────────
// CAMBIO Sprint 2 (paso 1a — solo identidad, NO campaña):
//
//   WhatsApp metió el esquema @lid (rollout 2024-2025). Ya no siempre manda el
//   número real: manda un "LID" opaco (ej: 11927141003400@lid) que:
//     - NO es un teléfono (no se le puede enviar como número),
//     - NO es un grupo (los grupos terminan en @g.us),
//     - SÍ es un usuario individual con su número oculto (muchas veces un
//       lead pagado que vino de un anuncio click-to-WhatsApp / Meta Ads).
//
//   Cascada de identidad en 3 anillos:
//     Anillo 0 (normal):     remoteJid = ...@s.whatsapp.net → número directo.
//     Anillo 1 (@lid recup.): el número real viene en remoteJidAlt / senderPn
//                             (Evolution v2.3.7 lo trae en la mayoría de casos)
//                             → dedup por número real, respondemos al número real.
//                             Cero migración: el número entra en el campo telefono.
//     Anillo 2 (@lid puro):  solo @lid, sin número (típico de Meta Ads).
//                             → dedup por el LID (estable por usuario). El reply
//                               fino y el campo de schema son del siguiente paso.
//
//   Además:
//     - Rechaza grupos (@g.us), canales (@newsletter) y broadcast (@broadcast).
//     - isNew determinístico (createdAt === updatedAt), ya no heurístico de reloj.
//     - Devuelve waJid / addressingMode / lidRecovered para el sender (paso 1c)
//       y adContext (pass-through) para el Campaign Resolver (paso 1b).
//
//   ⚠️ El default de campaña 'MPX' sigue TEMPORAL aquí. Lo reemplaza el Campaign
//      Resolver (paso 1b). No se borra todavía para no dejar leads sin campaña
//      (el bot perdería su prompt/factSheet). El hardcode muere en 1b, no acá.
// ─────────────────────────────────────────────────────────────────────────

import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const DEFAULT_TENANT_ID = 'peru_exporta'
const DEFAULT_CAMPAIGN_SLUG = 'MPX'   // ⚠️ TEMPORAL — lo mata el Campaign Resolver (paso 1b)
const FALLBACK_VENDOR_ID = 1

// Sufijos de JID que NO representan un lead individual
const NON_LEAD_SUFFIXES = ['@g.us', '@newsletter', '@broadcast']

// ════════════════════════════════════════════════════════
// API PÚBLICA — resolveLead()
// ════════════════════════════════════════════════════════

/**
 * Resuelve o crea un lead a partir del payload de Evolution.
 *
 * @param {object}  args
 * @param {string}  args.remoteJid      - JID principal del payload (puede ser @lid)
 * @param {string?} args.remoteJidAlt   - JID alternativo (PN real cuando remoteJid es @lid)
 * @param {string?} args.senderPn       - número real del remitente (algunas versiones de Evolution)
 * @param {string?} args.addressingMode - 'pn' | 'lid' (informativo de Baileys)
 * @param {string?} args.instanceName   - instancia Evolution
 * @param {string?} args.pushName       - nombre visible (puede ser null en CTWA)
 * @param {object?} args.adContext      - contexto de anuncio CTWA (pass-through para 1b)
 * @param {string?} args.tenantId
 */
export async function resolveLead({
  remoteJid,
  remoteJidAlt = null,
  senderPn = null,
  addressingMode = null,
  instanceName,
  pushName = null,
  adContext = null,
  tenantId = DEFAULT_TENANT_ID
}) {
  const startTime = Date.now()

  // ─── 1. Validación de input ───
  if (!remoteJid || typeof remoteJid !== 'string') {
    return buildErrorResponse('remoteJid_missing', startTime)
  }

  // ─── 2. Rechazar entidades que NO son leads (grupo / canal / broadcast) ───
  if (isNonLeadJid(remoteJid)) {
    return buildErrorResponse('non_lead_jid_not_supported', startTime, {
      jid: remoteJid
    })
  }

  // ─── 3. Resolver IDENTIDAD (maneja @lid) ───
  const identity = resolveIdentity({ remoteJid, remoteJidAlt, senderPn })

  // Clave de dedup: número real si lo hay; si es @lid puro, el LID (estable por usuario).
  const dedupKey = identity.phone || normalizePhone(identity.lidRaw)

  if (!dedupKey || dedupKey.length < 9) {
    return buildErrorResponse('invalid_identity', startTime, {
      originalJid: remoteJid,
      addressingMode: identity.addressingMode,
      dedupKey
    })
  }

  try {
    // ─── 4. Resolver vendor para la instancia ───
    const vendor = await resolveVendor(instanceName)

    // ─── 5. Resolver campaign_id (⚠️ TEMPORAL: default MPX — lo reemplaza el paso 1b) ───
    const campaign = await resolveCampaign(DEFAULT_CAMPAIGN_SLUG, tenantId)

    // ─── 6. Upsert atómico del lead (dedup por [tenantId, telefono]) ───
    // OJO: el schema ahora tiene @@unique([tenantId, telefono]), por eso el
    // where usa la clave compuesta tenantId_telefono (no telefono suelto).
    const lead = await prisma.lead.upsert({
      where: { tenantId_telefono: { tenantId, telefono: dedupKey } },
      update: {
        ultimoMensaje: new Date()
      },
      create: {
        telefono: dedupKey,
        nombreDetectado: pushName || null,
        estado: 'NUEVO',                          // Default del schema
        pasoActual: 0,                            // Default del schema
        campaignId: campaign?.id || null,         // FK a Campaign (puede ser null)
        vendorId: vendor.id,
        tenantId: tenantId,
        waJid: identity.waJid,                    // JID real para responder (sender, oleada 3)
        addressingMode: identity.addressingMode,  // 'pn' | 'lid' | 'lid_unrecovered'
        ultimoMensaje: new Date()
      },
      select: {
        id: true,
        telefono: true,
        vendorId: true,
        estado: true,
        pasoActual: true,
        nombreDetectado: true,
        productoDetectado: true,
        createdAt: true,
        updatedAt: true,                          // Para isNew determinístico
        archivedAt: true
      }
    })

    // ─── 7. ¿Es nuevo? Determinístico: en el primer insert, createdAt === updatedAt ───
    const isNew =
      new Date(lead.createdAt).getTime() === new Date(lead.updatedAt).getTime()

    const lidTag =
      identity.addressingMode === 'lid'
        ? ' [LID→PN recuperado]'
        : identity.addressingMode === 'lid_unrecovered'
          ? ' [LID puro — sin número, reply pendiente paso 1c]'
          : ''

    if (isNew) {
      console.log(`[LeadResolver] NEW lead: ${dedupKey} (id: ${lead.id}, vendor: ${vendor.nombre})${lidTag}`)
    } else {
      console.log(`[LeadResolver] Existing lead: ${dedupKey} (id: ${lead.id}, vendor: ${vendor.nombre})${lidTag}`)
    }

    // ─── 8. Resultado exitoso ───
    return {
      ok: true,
      leadId: lead.id,
      telefono: lead.telefono,
      vendorId: lead.vendorId,
      vendorNombre: vendor.nombre,
      isNew,
      tenantId,
      isArchived: lead.archivedAt !== null,
      leadEstado: lead.estado,
      nombreDetectado: lead.nombreDetectado,
      productoDetectado: lead.productoDetectado,
      // ── Identidad / direccionamiento (consumido por sender [1c] y campaign [1b]) ──
      waJid: identity.waJid,                      // JID al que responder (PN preferido, @lid fallback)
      addressingMode: identity.addressingMode,    // 'pn' | 'lid' | 'lid_unrecovered' | 'unknown'
      lidRecovered: identity.lidRecovered,        // true si recuperamos el PN real desde un @lid
      lidRaw: identity.lidRaw,                    // el @lid original (si lo hubo)
      adContext,                                  // pass-through para el Campaign Resolver
      latency_ms: Date.now() - startTime,
      errors: []
    }

  } catch (err) {
    console.error('[LeadResolver] Error:', err.message)
    return buildErrorResponse('database_error', startTime, {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 3)
    })
  }
}

// ════════════════════════════════════════════════════════
// IDENTIDAD — distingue PN vs @lid y recupera el número cuando se puede
// ════════════════════════════════════════════════════════

/**
 * Resuelve la identidad de direccionamiento del lead.
 *
 * @returns {{
 *   phone: string|null,        // número real normalizado (null si es @lid puro)
 *   waJid: string,             // JID al que el sender debe responder
 *   addressingMode: string,    // 'pn' | 'lid' | 'lid_unrecovered' | 'unknown'
 *   lidRecovered: boolean,     // true si se recuperó el PN desde un @lid
 *   lidRaw: string|null        // el @lid original
 * }}
 */
function resolveIdentity({ remoteJid, remoteJidAlt, senderPn }) {
  // ── Anillo 0 — número directo (caso normal) ──
  if (isPnJid(remoteJid)) {
    return {
      phone: normalizePhone(remoteJid),
      waJid: remoteJid,
      addressingMode: 'pn',
      lidRecovered: false,
      lidRaw: null
    }
  }

  // ── @lid — intentamos recuperar el PN real desde remoteJidAlt o senderPn ──
  if (isLidJid(remoteJid)) {
    // Distintas versiones de Evolution ponen el PN real en uno u otro campo.
    const pnCandidate = [remoteJidAlt, senderPn].find(isPnJid)

    if (pnCandidate) {
      // Anillo 1 — recuperado: dedup por el número real, respondemos al número real.
      return {
        phone: normalizePhone(pnCandidate),
        waJid: pnCandidate,
        addressingMode: 'lid',
        lidRecovered: true,
        lidRaw: remoteJid
      }
    }

    // Anillo 2 — @lid puro: sin número real recuperable (típico de Meta Ads).
    // Dedup por el LID (estable por usuario). El reply fino es del paso 1c.
    return {
      phone: null,
      waJid: remoteJid,
      addressingMode: 'lid_unrecovered',
      lidRecovered: false,
      lidRaw: remoteJid
    }
  }

  // ── JID desconocido (no PN, no @lid; los grupos ya se filtraron antes) ──
  return {
    phone: normalizePhone(remoteJid),
    waJid: remoteJid,
    addressingMode: 'unknown',
    lidRecovered: false,
    lidRaw: null
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Resolver campaign por slug
// ════════════════════════════════════════════════════════

/**
 * Encuentra el campaign activo por slug (ej: "MPX" → campaign_id).
 * ⚠️ TEMPORAL: el Campaign Resolver (paso 1b) reemplaza este default por
 *    matcheo de triggers contra el texto del lead.
 */
async function resolveCampaign(slug, tenantId) {
  if (!slug) return null

  try {
    const campaign = await prisma.campaign.findFirst({
      where: {
        slug,
        tenantId,
        activa: true
      },
      select: {
        id: true,
        slug: true,
        nombre: true
      }
    })

    if (!campaign) {
      console.warn(`[LeadResolver] No active campaign found for slug "${slug}", lead will have null campaignId`)
    }

    return campaign

  } catch (err) {
    console.error('[LeadResolver] resolveCampaign failed:', err.message)
    return null
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Resolver vendor para una instancia
// ════════════════════════════════════════════════════════

async function resolveVendor(instanceName) {
  try {
    // Cascade 1: vendor con instancia coincidente
    if (instanceName) {
      const vendorByInstance = await prisma.vendor.findFirst({
        where: {
          instanciaEvolution: instanceName,
          activo: true
        },
        select: {
          id: true,
          nombre: true,
          activo: true,
          role: true,
          instanciaEvolution: true
        }
      })

      if (vendorByInstance) {
        return vendorByInstance
      }
    }

    console.warn(`[LeadResolver] No vendor found for instance "${instanceName}", falling back to ADMIN`)

    // Cascade 2: vendor con role ADMIN
    const adminVendor = await prisma.vendor.findFirst({
      where: {
        role: 'ADMIN',
        activo: true
      },
      select: {
        id: true,
        nombre: true,
        activo: true,
        role: true,
        instanciaEvolution: true
      }
    })

    if (adminVendor) {
      return adminVendor
    }

    console.warn('[LeadResolver] No active ADMIN vendor, falling back to vendor_id=1')

    // Cascade 3: vendor por ID hardcoded (Joan) — frágil, pero último recurso
    const fallbackVendor = await prisma.vendor.findUnique({
      where: { id: FALLBACK_VENDOR_ID },
      select: {
        id: true,
        nombre: true,
        activo: true,
        role: true,
        instanciaEvolution: true
      }
    })

    if (fallbackVendor) {
      return fallbackVendor
    }

    throw new Error('No vendor available in database')

  } catch (err) {
    console.error('[LeadResolver] resolveVendor failed:', err.message)
    throw err
  }
}

// ════════════════════════════════════════════════════════
// HELPERS — Normalización y clasificación de JID
// ════════════════════════════════════════════════════════

/**
 * Extrae solo los dígitos de un JID (quita @sufijo y prefijo whatsapp:).
 * Para un @lid devuelve los dígitos del LID (NO es un teléfono real).
 */
export function normalizePhone(jid) {
  if (!jid || typeof jid !== 'string') return ''

  let cleaned = jid.replace(/@.+$/, '')
  cleaned = cleaned.replace(/^whatsapp:/, '')
  cleaned = cleaned.replace(/\D/g, '')

  return cleaned
}

/**
 * true si el JID NO es un lead individual: grupo, canal o broadcast.
 */
export function isNonLeadJid(jid) {
  if (!jid || typeof jid !== 'string') return false
  return NON_LEAD_SUFFIXES.some(suffix => jid.endsWith(suffix))
}

/**
 * true si es un grupo (@g.us). Se mantiene por compatibilidad con código existente.
 */
export function isGroupJid(jid) {
  if (!jid || typeof jid !== 'string') return false
  return jid.endsWith('@g.us')
}

/**
 * true si el JID es un LID (@lid) — usuario individual con número oculto.
 */
export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid')
}

/**
 * true si el JID es un número de teléfono clásico (@s.whatsapp.net).
 */
export function isPnJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

function buildErrorResponse(errorCode, startTime, metadata = {}) {
  console.error(`[LeadResolver] Error: ${errorCode}`, metadata)

  return {
    ok: false,
    leadId: null,
    telefono: null,
    vendorId: null,
    vendorNombre: null,
    isNew: false,
    tenantId: null,
    waJid: null,
    addressingMode: null,
    lidRecovered: false,
    lidRaw: null,
    adContext: null,
    latency_ms: Date.now() - startTime,
    errors: [{
      code: errorCode,
      metadata
    }]
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen para logs
// ════════════════════════════════════════════════════════

export function summarizeResolution(result) {
  if (!result) return 'no result'

  if (!result.ok) {
    return `❌ resolve failed: ${result.errors?.[0]?.code || 'unknown'} (${result.latency_ms}ms)`
  }

  const newLabel = result.isNew ? ' [NEW]' : ''
  const archivedLabel = result.isArchived ? ' [ARCHIVED]' : ''
  const modeLabel =
    result.addressingMode && result.addressingMode !== 'pn'
      ? ` [${result.addressingMode}]`
      : ''

  return `✅ lead ${result.leadId} (${result.telefono}) → vendor ${result.vendorNombre}${newLabel}${archivedLabel}${modeLabel} (${result.latency_ms}ms)`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const LEAD_RESOLVER_VERSION = 'v4_sprint2_composite_key'
