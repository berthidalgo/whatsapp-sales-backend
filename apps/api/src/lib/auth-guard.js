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
    const u = request.user
    if (!u || typeof u.tenantId !== 'string' || !u.tenantId.trim() ||
        !['ADMIN', 'SUPERVISOR', 'VENDOR'].includes(u.role) ||
        !Number.isSafeInteger(u.vendorId) || u.vendorId <= 0) {
      return reply.code(401).send({ error: 'sesión sin identidad o tenant válido' })
    }
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
  if (!user || typeof user.tenantId !== 'string' || !user.tenantId.trim()) return { id: -1 }
  const where = { tenantId: user.tenantId }
  if (!ROLES_VE_TODO.has(user.role)) where.vendorId = user.vendorId ?? -1
  return where
}

// preHandler de ROL (sep 2026): va DESPUÉS de verifyJwt → `preHandler: [verifyJwt, requireAdmin]`.
// Antes, cualquier token válido —también el de un VENDEDOR— podía crear vendedores
// (incluso ADMIN), borrar la campaña que tiene la ficha de precios o correr el banco
// de evals completo contra el LLM. Esas acciones son de administración.
export async function requireAdmin(request, reply) {
  if (!ROLES_VE_TODO.has(request.user?.role)) {
    return reply.code(403).send({ error: 'requiere rol ADMIN o SUPERVISOR' })
  }
}

export { ROLES_VE_TODO }
