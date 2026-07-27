// src/api/config.js
// Configuración del sistema Hidata — Sprint 2
// Usa modelos nuevos: vendor (en lugar de vendedor), botConfig simplificado

import { ACTIVE_TENANT } from '../lib/tenant.js'

// ── Tenant del request (fix forense jul 2026) ──
// ANTES estos endpoints usaban `tenantId: 'hidata'` FIJO: todos los clientes leían y
// ESCRIBÍAN la misma fila de config. Si BIOAYUR editaba su mensaje de bienvenida, se
// lo pisaba a Perú Exporta. El JWT ya trae el tenant (auth-guard → request.user), así
// que se usa ese; sin token cae al tenant del deploy (compat del CRM actual).
// PENDIENTE de seguridad: estas rutas /config/* NO pasan por verifyJwt todavía.
function tenantDe(request) {
  return request?.user?.tenantId || ACTIVE_TENANT
}

// Defaults NEUTROS: el nombre de la empresa sale de la BD del tenant, no de un
// literal. Poner 'Perú Exporta TV' aquí hacía que un cliente nuevo viera la marca
// de otro en su propio panel.
const CONFIG_VACIA = {
  msgBienvenida: '', msgProducto: '', msgExperiencia: '',
  msgPresentacion: '', msgObjecion: '', msgUrgencia: '', msgHandoff: '',
  nombreEmpresa: '', nombreProducto: ''
}

// ============================================================
// BOT CONFIG — Leer
// ============================================================
export async function getBotConfig(request, reply, prisma) {
  try {
    const config = await prisma.botConfig.findFirst({
      where: { tenantId: tenantDe(request), activo: true }
    })
    if (!config) {
      // Retornar config vacía en vez de 404 — el CRM maneja esto
      return reply.send({ ...CONFIG_VACIA })
    }
    return reply.send(config)
  } catch (error) {
    console.error('[config] getBotConfig:', error.message)
    // Retornar config vacía en vez de 500
    return reply.send({ ...CONFIG_VACIA })
  }
}

// ============================================================
// BOT CONFIG — Guardar
// ============================================================
export async function updateBotConfig(request, reply, prisma) {
  try {
    const campos = [
      'msgBienvenida','msgProducto','msgExperiencia','msgPresentacion',
      'msgObjecion','msgUrgencia','msgHandoff','nombreEmpresa','nombreProducto'
    ]

    const configActual = await prisma.botConfig.findFirst({
      where: { tenantId: tenantDe(request), activo: true }
    })

    const data = { updatedEn: new Date() }
    campos.forEach(c => { if (request.body[c] !== undefined) data[c] = request.body[c] })

    if (configActual) {
      await prisma.botConfig.update({ where: { id: configActual.id }, data })
    } else {
      await prisma.botConfig.create({ data: { ...data, tenantId: tenantDe(request), activo: true } })
    }

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[config] updateBotConfig:', error.message)
    return reply.status(500).send({ error: 'Error al guardar configuración' })
  }
}

// ============================================================
// VENDEDORES — Listar
// Usa tabla vendors (Sprint 2) — compatible con CRM existente
// ============================================================
export async function getVendedores(request, reply, prisma) {
  try {
    // FUGA CERRADA (jul 2026): esto listaba los vendedores de TODOS los tenants
    // (`where: { activo: true }` a secas) → el panel de un cliente mostraba el
    // equipo y los teléfonos de otro. El tenant acota siempre.
    const vendors = await prisma.vendor.findMany({
      where: { activo: true, tenantId: tenantDe(request) },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { campaigns: true } } }
    })

    // Formatear para que el CRM existente lo entienda
    const formateados = vendors.map(v => ({
      id: String(v.id),
      nombre: v.nombre,
      email: '',
      rol: v.role === 'ADMIN' ? 'ADMIN' : 'VENDEDOR',
      whatsappNumber: v.telefono,
      // La instancia REAL de la BD. Antes se INVENTABA como `peru-exporta-${nombre}`,
      // así que para un vendedor de otro cliente el CRM mostraba una instancia que no
      // existe (y con la marca de Perú Exporta encima).
      instanciaEvolution: v.instanciaEvolution || null,
      activo: v.activo,
      creadoEn: v.createdAt,
      totalLeads: 0
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[config] getVendedores:', error.message)
    return reply.status(500).send({ error: 'Error al obtener vendedores' })
  }
}

// ============================================================
// VENDEDORES — Agregar
// ============================================================
export async function createVendedor(request, reply, prisma) {
  try {
    const { nombre, whatsappNumber, rol } = request.body

    if (!nombre || !whatsappNumber) {
      return reply.status(400).send({ error: 'nombre y whatsappNumber son requeridos' })
    }

    const telefono = whatsappNumber.replace(/[^0-9]/g, '')
    const tenantId = tenantDe(request)

    // Dedup POR TENANT (jul 2026): antes era findUnique({ telefono }) global — dos
    // clientes no podían tener un vendedor con el mismo número, y peor, el mensaje de
    // "ya registrado" filtraba que ese número existe en OTRO tenant. Ahora se busca
    // dentro del tenant del admin.
    const existente = await prisma.vendor.findFirst({ where: { telefono, tenantId } })
    if (existente) {
      return reply.status(409).send({ error: `El número ${telefono} ya está registrado` })
    }

    const vendor = await prisma.vendor.create({
      data: {
        // tenantId EXPLÍCITO: antes se omitía y caía al @default("peru_exporta") del
        // schema → un vendedor creado por el admin de BIOAYUR aterrizaba en Perú
        // Exporta. Este era el agujero que hacía imposible dar de alta un cliente
        // nuevo de forma limpia. El default del schema se elimina en esta misma tanda.
        tenantId,
        nombre,
        telefono,
        role: rol === 'ADMIN' ? 'ADMIN' : 'VENDOR',
        activo: true
      }
    })

    return reply.status(201).send({ ok: true, vendedor: vendor })
  } catch (error) {
    console.error('[config] createVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al crear vendedor' })
  }
}

// ============================================================
// VENDEDORES — Editar
// ============================================================
export async function updateVendedor(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { nombre, whatsappNumber, rol } = request.body

    // MURO DE TENANT: el vendedor debe ser del tenant del admin. Sin esto, un admin
    // podía editar (o cambiarle el rol a) un vendedor de OTRO cliente por su id.
    const objetivo = await prisma.vendor.findFirst({
      where: { id, tenantId: tenantDe(request) }, select: { id: true }
    })
    if (!objetivo) return reply.status(404).send({ error: 'Vendedor no encontrado' })

    const data = { updatedAt: new Date() }
    if (nombre) data.nombre = nombre
    if (whatsappNumber) data.telefono = whatsappNumber.replace(/[^0-9]/g, '')
    if (rol) data.role = rol === 'ADMIN' ? 'ADMIN' : 'VENDOR'

    const vendor = await prisma.vendor.update({ where: { id }, data })
    return reply.send({ ok: true, vendedor: vendor })
  } catch (error) {
    console.error('[config] updateVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al actualizar vendedor' })
  }
}

// ============================================================
// VENDEDORES — Desactivar
// ============================================================
export async function desactivarVendedor(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const tenantId = tenantDe(request)

    // Muro de tenant: solo un vendedor del propio cliente.
    const vendor = await prisma.vendor.findFirst({ where: { id, tenantId } })
    if (!vendor) return reply.status(404).send({ error: 'Vendedor no encontrado' })

    if (vendor.role === 'ADMIN') {
      // El conteo del "único admin" DEBE acotarse al tenant. Antes contaba los admins
      // de TODOS los clientes: BIOAYUR podía quedarse sin ningún admin porque Perú
      // Exporta tenía otros, y el check pasaba. Cada cliente cuenta los suyos.
      const totalAdmins = await prisma.vendor.count({
        where: { role: 'ADMIN', activo: true, tenantId }
      })
      if (totalAdmins <= 1) {
        return reply.status(400).send({ error: 'No puedes desactivar al único admin' })
      }
    }

    await prisma.vendor.update({
      where: { id },
      data: { activo: false }
    })

    return reply.send({ ok: true, mensaje: `${vendor.nombre} desactivado correctamente` })
  } catch (error) {
    console.error('[config] desactivarVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al desactivar vendedor' })
  }
}
