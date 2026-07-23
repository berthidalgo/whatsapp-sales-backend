// src/routes/auth.js — Sprint 3 + Hito 1 (Fase Frontend)
// POST /auth/login — Login con PIN de 4 dígitos.
// Hito 1: ahora firma un JWT (claims vendorId/role/tenantId) que el front guarda y
// manda en cada request → los endpoints v2 derivan el scope del TOKEN, no de query
// params manipulables. Se mantiene el objeto `vendor` para compatibilidad con el CRM viejo.

import { ACTIVE_TENANT } from '../lib/tenant.js'

// Rate-limit en memoria: bloquea un nombre tras MAX_INTENTOS fallidos en la ventana.
// El PIN de 4 dígitos es brute-forceable (10k combos); esto lo frena. Render = 1
// instancia → la memoria basta (mismo criterio que el candado de followups).
const intentosFallidos = new Map() // nombre -> { count, until }
const MAX_INTENTOS = 5
const BLOQUEO_MS = 10 * 60 * 1000  // 10 min

function estaBloqueado(nombre) {
  const e = intentosFallidos.get(nombre)
  if (!e) return false
  if (Date.now() > e.until) { intentosFallidos.delete(nombre); return false }
  return e.count >= MAX_INTENTOS
}
function registrarFallo(nombre) {
  const e = intentosFallidos.get(nombre) || { count: 0, until: 0 }
  e.count += 1
  e.until = Date.now() + BLOQUEO_MS
  intentosFallidos.set(nombre, e)
}

export async function loginVendor(request, reply, prisma) {
  try {
    const { nombre, pin } = request.body

    if (!nombre || !pin) {
      return reply.status(400).send({ error: 'nombre y pin son requeridos' })
    }

    if (estaBloqueado(nombre)) {
      return reply.status(429).send({ error: 'demasiados intentos, espera unos minutos' })
    }

    // ⚠️ FIX MULTITENANT: el login se acota al tenant del request. Sin esto, dos
    // clientes con un vendedor homónimo y el mismo PIN de 4 dígitos colisionaban
    // (findFirst devolvía el de OTRO tenant → sesión cruzada). El PIN es de 4
    // dígitos: con 3+ clientes las colisiones dejan de ser hipotéticas.
    const tenantId = resolveTenantForLogin(request)

    const vendor = await prisma.vendor.findFirst({
      where: { nombre, pin: String(pin), activo: true, tenantId }
    })

    if (!vendor) {
      registrarFallo(nombre)
      return reply.status(401).send({ error: 'PIN incorrecto o vendedor no encontrado' })
    }

    intentosFallidos.delete(nombre) // login OK → limpia el contador

    // JWT firmado: claims que el cliente NO puede alterar. @fastify/jwt expone reply.jwtSign.
    const token = await reply.jwtSign({
      vendorId: vendor.id,
      role: vendor.role,                 // ADMIN | VENDOR (SUPERVISOR a futuro)
      tenantId: vendor.tenantId,
    }, { expiresIn: '7d' })              // el token CADUCA; el front maneja el 401 → re-login

    // Nunca devolver el PIN al cliente
    const { pin: _, ...vendorSafe } = vendor

    return reply.send({
      ok: true,
      token,
      vendor: {
        ...vendorSafe,
        // Campos compatibles con el CRM existente
        id: vendor.id,
        nombre: vendor.nombre,
        rol: vendor.role,          // ADMIN | VENDOR
        role: vendor.role,
        tenantId: vendor.tenantId,
        instancia: vendor.instanciaEvolution || '',
        whatsappNumber: vendor.whatsappNumber || '',
        initials: vendor.nombre.substring(0, 2).toUpperCase(),
        color: getColorPorNombre(vendor.nombre),
      }
    })
  } catch (error) {
    console.error('[Auth] Error en login:', error.message)
    return reply.status(500).send({ error: 'Error interno' })
  }
}

// GET /auth/vendors — lista pública de nombres para la pantalla de login
// No devuelve PINs ni datos sensibles.
//
// ⚠️ FIX MULTITENANT (jul 2026): este endpoint es PRE-auth (no hay JWT todavía),
// así que no puede scopear por token. Antes devolvía los vendedores de TODOS los
// tenants → la pantalla de login de Perú Exporta listaba al equipo de BIOAYUR
// (fuga cross-tenant + problema comercial: un cliente ve los nombres de otro).
//
// Ahora el tenant se declara explícitamente:
//   1. ?tenant=slug        → el front de cada cliente manda el suyo
//   2. resolveTenantFromOrigin(origin) → deriva del dominio del CRM (multi-dominio)
//   3. ACTIVE_TENANT       → fallback de compat (deploy single-tenant actual)
// Nunca devuelve la lista completa. Un tenant inexistente → lista vacía, no error
// (no confirmamos qué tenants existen a un curioso).
export async function getVendorNames(request, reply, prisma) {
  try {
    const tenantId = resolveTenantForLogin(request)

    const vendors = await prisma.vendor.findMany({
      where: { activo: true, tenantId },
      select: { id: true, nombre: true, role: true },
      orderBy: { id: 'asc' }
    })

    return reply.send(vendors.map(v => ({
      id: v.id,
      nombre: v.nombre,
      role: v.role,
      initials: v.nombre.substring(0, 2).toUpperCase(),
      color: getColorPorNombre(v.nombre),
    })))
  } catch (error) {
    console.error('[Auth] Error en getVendorNames:', error.message)
    return reply.status(500).send({ error: 'Error interno' })
  }
}

// ════════════════════════════════════════════════════════
// TENANT EN EL LOGIN (pre-auth)
// ════════════════════════════════════════════════════════
//
// El login es el ÚNICO punto donde no hay JWT del cual derivar el tenant, así que
// hay que resolverlo del request. Cascada explícita, de más fuerte a más débil:
//
//   1. ?tenant=slug          → el front lo declara (lo que usará cada CRM por cliente)
//   2. Origin → TENANT_POR_ORIGEN → el dominio del CRM identifica al cliente
//   3. ACTIVE_TENANT         → compat con el deploy single-tenant de hoy
//
// NO es un control de seguridad (el cliente puede mandar cualquier tenant): es un
// FILTRO DE VISIBILIDAD. Lo que realmente autentica es el PIN, y el PIN se valida
// contra el vendor DE ESE TENANT (ver loginVendor) → declarar otro tenant no da
// acceso a nada, solo cambia qué lista de nombres se ve.
//
// Mapa dominio→tenant por env var, para no tocar código al sumar un cliente:
//   TENANT_ORIGINS='crm.peruexporta.com=peru_exporta,crm.bioayur.com=bioayur'
function tenantPorOrigen() {
  const raw = process.env.TENANT_ORIGINS || ''
  const mapa = {}
  for (const par of raw.split(',')) {
    const [dominio, tenant] = par.split('=').map(s => s?.trim())
    if (dominio && tenant) mapa[dominio.toLowerCase()] = tenant
  }
  return mapa
}

export function resolveTenantForLogin(request) {
  const pedido = String(request?.query?.tenant || '').trim()
  if (pedido) return pedido

  const origin = String(request?.headers?.origin || '').toLowerCase()
  if (origin) {
    const mapa = tenantPorOrigen()
    // Match por host (el Origin viene como https://host[:port])
    const host = origin.replace(/^https?:\/\//, '').split(':')[0]
    if (mapa[host]) return mapa[host]
  }

  return ACTIVE_TENANT
}

// Colores determinísticos por nombre — mismo que config.js del CRM
function getColorPorNombre(nombre) {
  const colores = ['#ff6b35','#7c3aed','#16a34a','#0ea5e9','#f59e0b','#ef4444','#8b5cf6','#06b6d4']
  const i = nombre.charCodeAt(0) % colores.length
  return colores[i]
}
