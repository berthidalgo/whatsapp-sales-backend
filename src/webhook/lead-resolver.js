// src/webhook/lead-resolver.js — Hidata v20 Día 7
//
// LEAD RESOLVER (FIX Día 7)
//
// Resuelve el leadId a partir del número de WhatsApp (remoteJid de Evolution).
// Si el lead no existe en BD, lo crea automáticamente.
//
// FIX aplicado:
//   - Removido campaignSlug (NO existe en schema)
//   - Usar campaignId (que sí existe en schema)
//   - Removido archived del select (usar archivedAt)
//   - estado default "NUEVO" alineado con schema
//   - pasoActual: 0 alineado con default schema

import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const DEFAULT_TENANT_ID = 'peru_exporta'
const DEFAULT_CAMPAIGN_SLUG = 'MPX'              // Para buscar campaign_id
const FALLBACK_VENDOR_ID = 1                      // Joan, por defecto

// ════════════════════════════════════════════════════════
// API PÚBLICA — resolveLead()
// ════════════════════════════════════════════════════════

/**
 * Resuelve o crea un lead a partir del payload de Evolution.
 */
export async function resolveLead({
  remoteJid,
  instanceName,
  pushName = null,
  tenantId = DEFAULT_TENANT_ID
}) {
  const startTime = Date.now()

  // ─── 1. Validación de input ───
  if (!remoteJid || typeof remoteJid !== 'string') {
    return buildErrorResponse('remoteJid_missing', startTime)
  }

  // ─── 2. Detectar y rechazar grupos ───
  if (isGroupJid(remoteJid)) {
    return buildErrorResponse('group_jid_not_supported', startTime, {
      jid: remoteJid
    })
  }

  // ─── 3. Normalizar número ───
  const telefono = normalizePhone(remoteJid)
  
  if (!telefono || telefono.length < 9) {
    return buildErrorResponse('invalid_phone_number', startTime, {
      originalJid: remoteJid,
      normalized: telefono
    })
  }

  try {
    // ─── 4. Resolver vendor para la instancia ───
    const vendor = await resolveVendor(instanceName)

    // ─── 5. Resolver campaign_id desde slug (MPX) ───
    const campaign = await resolveCampaign(DEFAULT_CAMPAIGN_SLUG, tenantId)

    // ─── 6. Upsert atómico del lead ───
    const lead = await prisma.lead.upsert({
      where: { telefono },
      update: {
        ultimoMensaje: new Date()
      },
      create: {
        telefono,
        nombreDetectado: pushName || null,
        estado: 'NUEVO',                          // Default del schema
        pasoActual: 0,                            // Default del schema
        campaignId: campaign?.id || null,         // FK a Campaign (puede ser null)
        vendorId: vendor.id,
        tenantId: tenantId,
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
        archivedAt: true                          // Para detectar si está archivado
      }
    })

    // ─── 7. Detectar si es nuevo (createdAt reciente = hace < 5 segundos) ───
    const ageMs = Date.now() - new Date(lead.createdAt).getTime()
    const isNew = ageMs < 5000

    if (isNew) {
      console.log(`[LeadResolver] NEW lead created: ${telefono} (id: ${lead.id}, vendor: ${vendor.nombre})`)
    } else {
      console.log(`[LeadResolver] Existing lead: ${telefono} (id: ${lead.id}, vendor: ${vendor.nombre})`)
    }

    // ─── 8. Devolver resultado exitoso ───
    return {
      ok: true,
      leadId: lead.id,
      telefono: lead.telefono,
      vendorId: lead.vendorId,
      vendorNombre: vendor.nombre,
      isNew,
      tenantId,
      isArchived: lead.archivedAt !== null,       // Boolean derivado de archivedAt
      leadEstado: lead.estado,
      nombreDetectado: lead.nombreDetectado,
      productoDetectado: lead.productoDetectado,
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
// HELPER — Resolver campaign por slug
// ════════════════════════════════════════════════════════

/**
 * Encuentra el campaign activo por slug (ej: "MPX" → campaign_id)
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

    // Cascade 3: vendor por ID hardcoded (Joan)
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
// HELPERS — Phone normalization & validation
// ════════════════════════════════════════════════════════

export function normalizePhone(jid) {
  if (!jid || typeof jid !== 'string') return ''
  
  let cleaned = jid.replace(/@.+$/, '')
  cleaned = cleaned.replace(/^whatsapp:/, '')
  cleaned = cleaned.replace(/\D/g, '')
  
  return cleaned
}

export function isGroupJid(jid) {
  if (!jid || typeof jid !== 'string') return false
  return jid.endsWith('@g.us')
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
  
  return `✅ lead ${result.leadId} (${result.telefono}) → vendor ${result.vendorNombre}${newLabel}${archivedLabel} (${result.latency_ms}ms)`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const LEAD_RESOLVER_VERSION = 'v2_day7_schema_aligned'
