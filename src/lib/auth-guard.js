// src/lib/auth-guard.js — Hito 1 (Fase Frontend)
// Guard de autenticación + scoping RBAC server-side para los endpoints v2.
// Reemplaza el "auth de teatro" (role/vendorId por query param, manipulable por el
// cliente) por un JWT firmado cuyos claims NO los puede tocar el cliente.

// Roles que VEN TODO el tenant (no se acotan a su propio vendorId).
const ROLES_VE_TODO = new Set(['ADMIN', 'SUPERVISOR'])

// preHandler de Fastify: valida el Bearer token. Si falla → 401 y corta la cadena.
// @fastify/jwt rellena request.user con los claims { vendorId, role, tenantId }.
export async function verifyJwt(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'token ausente o inválido' })
  }
}

// Deriva el filtro Prisma (where) a partir del usuario autenticado.
//  - tenantId SIEMPRE acota (muro duro multi-tenant: un tenant jamás ve otro).
//  - VENDOR se acota a SUS leads (vendorId); ADMIN/SUPERVISOR ven todo su tenant.
// Pura función → testeable sin red ni BD. El fallback vendorId=-1 garantiza que un
// VENDOR sin vendorId no vea NADA (fail-closed), en vez de ver todo por accidente.
export function scopeWhere(user) {
  const where = {}
  if (!user) return where
  if (user.tenantId) where.tenantId = user.tenantId
  if (!ROLES_VE_TODO.has(user.role)) where.vendorId = user.vendorId ?? -1
  return where
}

export { ROLES_VE_TODO }
