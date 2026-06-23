// src/routes/auth.js — Sprint 3 + Hito 1 (Fase Frontend)
// POST /auth/login — Login con PIN de 4 dígitos.
// Hito 1: ahora firma un JWT (claims vendorId/role/tenantId) que el front guarda y
// manda en cada request → los endpoints v2 derivan el scope del TOKEN, no de query
// params manipulables. Se mantiene el objeto `vendor` para compatibilidad con el CRM viejo.

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

    const vendor = await prisma.vendor.findFirst({
      where: { nombre, pin: String(pin), activo: true }
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
    })

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
// No devuelve PINs ni datos sensibles
export async function getVendorNames(request, reply, prisma) {
  try {
    const vendors = await prisma.vendor.findMany({
      where: { activo: true },
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

// Colores determinísticos por nombre — mismo que config.js del CRM
function getColorPorNombre(nombre) {
  const colores = ['#ff6b35','#7c3aed','#16a34a','#0ea5e9','#f59e0b','#ef4444','#8b5cf6','#06b6d4']
  const i = nombre.charCodeAt(0) % colores.length
  return colores[i]
}
