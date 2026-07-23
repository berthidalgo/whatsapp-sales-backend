// src/webhook/channel-resolver.js — EL ROUTER DE TENANT (jul 2026)
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   Hasta hoy el tenant activo era `ACTIVE_TENANT`, una ENV VAR global del
//   proceso. Eso significaba: UN deploy = UN cliente atendiendo WhatsApp.
//   Con Perú Exporta + BIOAYUR + el tercero, o levantabas 3 servicios de Render
//   o apagabas dos clientes para atender al tercero.
//
//   Lo absurdo es que la respuesta SIEMPRE venía en el payload y la tirábamos:
//   Evolution manda `data.instance` en cada webhook, y esa instancia identifica
//   inequívocamente de QUIÉN es el número que recibió el mensaje.
//
//   Ahora:  webhook → externalKey → Channel → tenantId
//
//   Los 3 clientes conviven en UN deploy, cada uno con su número. Sumar el
//   cuarto = INSERTAR UNA FILA en `channels`. Cero redeploy.
//
// CASCADA DE RESOLUCIÓN (de más fuerte a más débil):
//   1. Channel.externalKey       → la fuente de verdad nueva
//   2. Vendor.instanciaEvolution → PUENTE de compatibilidad: los datos actuales
//      ya tienen la instancia por vendedor ('bioayur', 'peru-exporta-test'), así
//      que el routing funciona AUNQUE la tabla channels esté vacía.
//   3. ACTIVE_TENANT             → red de seguridad final (cero regresión)
//
//   El paso 2 es lo que hace este cambio seguro de desplegar: si la migración de
//   datos no corrió todavía, el comportamiento es byte-idéntico al de siempre.
//
// CACHÉ:
//   Este resolver corre en CADA mensaje entrante. Sin caché serían 2 queries por
//   turno solo para saber de quién es. Cachea por externalKey con TTL corto: un
//   cambio de canal tarda ≤60s en propagarse, y eso es aceptable para algo que
//   se toca cuando se da de alta un cliente (no en caliente).
// ─────────────────────────────────────────────────────────────────────────

import prisma from '../db/prisma.js'
import { ACTIVE_TENANT } from '../lib/tenant.js'

const CACHE_TTL_MS = 60_000
const cache = new Map()   // externalKey -> { value, expiresAt }

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) { cache.delete(key); return null }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** Limpia la caché — para tests y para el día que el dashboard edite canales en caliente. */
export function invalidateChannelCache(externalKey = null) {
  if (externalKey) cache.delete(externalKey)
  else cache.clear()
}

/**
 * Resuelve a qué tenant pertenece un canal entrante.
 *
 * @param {string|null} externalKey - instancia Evolution (o phone_number_id en Cloud/Bird)
 * @returns {Promise<{
 *   tenantId: string,
 *   channelId: string|null,
 *   provider: string,
 *   credenciales: object|null,
 *   externalKey: string|null,
 *   numeroDisplay: string|null,
 *   resolvedBy: 'channel' | 'vendor_instance' | 'active_tenant_fallback'
 * }>}
 */
export async function resolveChannel(externalKey) {
  const key = (externalKey || '').trim()

  if (!key) {
    // Sin instancia en el payload no hay nada que resolver: caemos al default.
    // Pasa con webhooks malformados o eventos que no traen `instance`.
    return fallbackActiveTenant(null, 'sin externalKey en el payload')
  }

  const cached = cacheGet(key)
  if (cached) return cached

  // ─── 1. Channel (fuente de verdad) ───
  try {
    const ch = await prisma.channel.findUnique({
      where: { externalKey: key },
      select: {
        id: true, tenantId: true, provider: true, credenciales: true,
        numeroDisplay: true, activo: true,
        tenant: { select: { estadoSuscripcion: true, displayName: true } }
      }
    })

    if (ch) {
      if (!ch.activo) {
        // Canal dado de baja: NO lo servimos con otro tenant (eso mezclaría datos).
        // Se registra y se deja pasar al fallback explícito del tenant dueño.
        console.warn(`[ChannelResolver] canal "${key}" está INACTIVO (tenant ${ch.tenantId}) — no se atiende`)
      }
      const resolved = {
        tenantId: ch.tenantId,
        channelId: ch.id,
        provider: ch.provider,
        credenciales: ch.credenciales || null,
        externalKey: key,
        numeroDisplay: ch.numeroDisplay || null,
        activo: ch.activo,
        resolvedBy: 'channel'
      }
      cacheSet(key, resolved)
      return resolved
    }
  } catch (err) {
    // Si la tabla todavía no existe (migración no aplicada), no tumbamos el bot:
    // seguimos a la cascada de compatibilidad.
    console.warn(`[ChannelResolver] no se pudo leer channels (${err.message}) → cascada de compat`)
  }

  // ─── 2. PUENTE: instancia declarada en el vendor ───
  // Los datos de hoy ya tienen esto poblado, así que el routing multitenant
  // funciona ANTES de sembrar la tabla channels.
  try {
    const vendor = await prisma.vendor.findFirst({
      where: { instanciaEvolution: key, activo: true },
      select: { tenantId: true, nombre: true }
    })
    if (vendor?.tenantId) {
      const resolved = {
        tenantId: vendor.tenantId,
        channelId: null,
        provider: 'evolution',
        credenciales: null,
        externalKey: key,
        numeroDisplay: null,
        activo: true,
        resolvedBy: 'vendor_instance'
      }
      cacheSet(key, resolved)
      console.log(`[ChannelResolver] "${key}" → tenant ${vendor.tenantId} (vía vendor ${vendor.nombre}; sembrá channels para hacerlo explícito)`)
      return resolved
    }
  } catch (err) {
    console.warn(`[ChannelResolver] fallo el puente por vendor: ${err.message}`)
  }

  // ─── 3. Red de seguridad ───
  return fallbackActiveTenant(key, 'ninguna coincidencia en channels ni en vendors')
}

function fallbackActiveTenant(key, motivo) {
  console.warn(`[ChannelResolver] ⚠️ "${key || '(vacío)'}" sin canal (${motivo}) → fallback ACTIVE_TENANT=${ACTIVE_TENANT}`)
  return {
    tenantId: ACTIVE_TENANT,
    channelId: null,
    provider: 'evolution',
    credenciales: null,
    externalKey: key,
    numeroDisplay: null,
    activo: true,
    resolvedBy: 'active_tenant_fallback'
  }
}

/**
 * Canal por DEFECTO de un tenant, para ENVIAR cuando el turno no nace de un
 * webhook entrante (followups del cron, campañas salientes, recordatorios).
 * Devuelve null si el tenant no tiene canales sembrados → el llamador cae a las
 * env vars de siempre.
 */
export async function defaultChannelForTenant(tenantId) {
  if (!tenantId) return null
  try {
    return await prisma.channel.findFirst({
      where: { tenantId, activo: true },
      orderBy: [{ esDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, provider: true, externalKey: true, credenciales: true, numeroDisplay: true, tenantId: true }
    })
  } catch (err) {
    console.warn(`[ChannelResolver] defaultChannelForTenant(${tenantId}) falló: ${err.message}`)
    return null
  }
}

export function summarizeChannelResolution(r) {
  if (!r) return 'sin resolución'
  const via = {
    channel: '🎯 channel',
    vendor_instance: '🔗 vendor',
    active_tenant_fallback: '⚠️ fallback'
  }[r.resolvedBy] || r.resolvedBy
  return `${via} ${r.externalKey || '(sin key)'} → ${r.tenantId} [${r.provider}]`
}

export const CHANNEL_RESOLVER_VERSION = 'v1_routing_por_instancia'
