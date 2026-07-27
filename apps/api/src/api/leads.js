// src/api/leads.js — Sprint 4
// Fix Bug 3: moverLead firma corregida
// Fix Bug 5: doAccion actualiza también conversation.state
// Fix Bug 10: sendMensaje envía por WhatsApp real
// Fix Bug 11: doAccion cancela followup cerrando conversation

import { sendToWhatsApp } from '../webhook/sender.js'
import { scopeWhere } from '../lib/auth-guard.js'

/**
 * Verifica que el lead EXISTE y pertenece al scope del usuario autenticado.
 * Devuelve el lead o null (el llamador responde 404).
 *
 * MURO MULTITENANT (auditoría pre-producción, jul 2026): estos handlers operaban
 * por `id` a secas — `prisma.lead.update({ where: { id } })`. Con varios clientes en
 * la misma BD, un usuario de un tenant podía leer, modificar y MANDARLE WHATSAPP a
 * los leads de otro con solo cambiar el número en la URL (IDOR clásico).
 *
 * Se responde 404 y no 403 a propósito: un 403 confirmaría que ese lead existe en
 * otro tenant. Mismo criterio que los endpoints /v2/*.
 */
async function leadEnScope(prisma, request, id, extra = {}) {
  if (!Number.isInteger(id)) return null
  return prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, ...extra })
}

export async function getLeads(request, reply, prisma) {
  try {
    // El scope sale del JWT (tenant + vendedor), NUNCA de la query string: antes
    // se leía `?vendorId=&role=` — parámetros que ponía el propio cliente, así que
    // bastaba mandar `?role=ADMIN` para listar los leads de TODOS los tenants.
    const where = scopeWhere(request.user)

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        campaign: {
          select: { slug: true, nombre: true, vendor: { select: { nombre: true } } }
        },
        vendor: { select: { nombre: true, role: true } },
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { state: true, currentStep: true, lastLeadMessageAt: true }
        }
      }
    })

    const formateados = leads.map(lead => ({
      id: lead.id,
      nombre: lead.nombreDetectado || lead.telefono,
      numero: lead.telefono,
      phone: lead.telefono,
      fila: lead.id,
      producto: lead.productoDetectado || lead.campaign?.slug || '',
      tipo: lead.campaign?.nombre || 'Sin campaña',
      estado: mapEstado(lead.estado),
      convState: lead.conversations?.[0]?.state || null,
      prioridad: 'normal',
      scoreTotal: 0,
      creadoEn: lead.createdAt,
      ultimoTimestamp: lead.ultimoMensaje || lead.createdAt,
      vendedor: lead.vendor?.nombre || lead.campaign?.vendor?.nombre || '',
      vendorId: lead.vendorId,
      urgente: lead.estado === 'NUEVO' || lead.estado === 'EN_FLUJO'
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[API/leads] getLeads:', error.message)
    return reply.status(500).send({ error: 'Error al obtener leads' })
  }
}

function mapEstado(estado) {
  const mapa = {
    'NUEVO':      'nuevo',
    'EN_FLUJO':   'pendiente llamar',
    'NOTIFICADO': 'por_llamar',
    'CERRADO':    'cerrado',
  }
  return mapa[estado] || 'nuevo'
}

// Fix Bug 3: firma correcta — leadId es el ID del lead, colId es el estado
export async function updateLead(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { estado } = request.body

    const estadoInverso = {
      'nuevo':            'NUEVO',
      'pendiente llamar': 'EN_FLUJO',
      'por_llamar':       'NOTIFICADO',
      'no_contesto':      'EN_FLUJO',
      'agendado':         'EN_FLUJO',
      'mat_enviado':      'NOTIFICADO',
      'cerrado':          'CERRADO',
    }

    const nuevoEstado = estadoInverso[estado] || 'NUEVO'

    if (!await leadEnScope(prisma, request, id, { select: { id: true } })) {
      return reply.status(404).send({ error: 'Lead no encontrado' })
    }
    await prisma.lead.update({ where: { id }, data: { estado: nuevoEstado, updatedAt: new Date() } })

    // Sincronizar conversation.state
    if (nuevoEstado === 'CERRADO') {
      await prisma.conversation.updateMany({
        where: { leadId: id, state: { not: 'CLOSED' } },
        data: { state: 'CLOSED', updatedAt: new Date() }
      }).catch(() => {})
    }

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] updateLead:', error.message)
    return reply.status(500).send({ error: 'Error al actualizar lead' })
  }
}

// Fix Bug 10: envía por WhatsApp real además de guardar en DB
export async function sendMensaje(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { contenido } = request.body
    if (!contenido) return reply.status(400).send({ error: 'contenido requerido' })

    // Doble guarda: existe Y es de este tenant/vendedor. Sin esto, cualquiera con
    // un token válido mandaba WhatsApp a los leads de otro cliente cambiando el id.
    const lead = await leadEnScope(prisma, request, id, { include: { vendor: true } })
    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    const conv = await prisma.conversation.findFirst({
      where: { leadId: id },
      orderBy: { updatedAt: 'desc' }
    })

    // Guardar en DB
    await prisma.message.create({
      data: {
        leadId: id,
        conversationId: conv?.id || null,
        origen: 'VENDEDOR',
        texto: contenido
      }
    })

    // Enviar por WhatsApp si el vendor tiene instancia
    const instancia = lead.vendor?.instanciaEvolution
    if (instancia) {
      await sendToWhatsApp({ telefono: lead.telefono, text: contenido, instanceName: instancia }).catch(err => {
        console.error('[API/leads] sendMensaje WhatsApp error:', err.message)
      })
    }

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] sendMensaje:', error.message)
    return reply.status(500).send({ error: 'Error al enviar mensaje' })
  }
}

// Fix Bug 11: actualiza conversation.state al hacer acciones desde el CRM
export async function doAccion(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { accion } = request.body

    const estadoMap = {
      'material':   'NOTIFICADO',
      'nocontesto': 'EN_FLUJO',
      'agendar':    'EN_FLUJO',
      'cerrado':    'CERRADO',
    }

    const nuevoEstado = estadoMap[accion] || 'EN_FLUJO'

    if (!await leadEnScope(prisma, request, id, { select: { id: true } })) {
      return reply.status(404).send({ error: 'Lead no encontrado' })
    }
    await prisma.lead.update({ where: { id }, data: { estado: nuevoEstado, updatedAt: new Date() } })

    // Sincronizar conversation
    if (nuevoEstado === 'CERRADO') {
      await prisma.conversation.updateMany({
        where: { leadId: id, state: { not: 'CLOSED' } },
        data: { state: 'CLOSED', updatedAt: new Date() }
      }).catch(() => {})
    } else if (nuevoEstado === 'NOTIFICADO') {
      await prisma.conversation.updateMany({
        where: { leadId: id, state: 'ACTIVE' },
        data: { state: 'NOTIFIED', updatedAt: new Date() }
      }).catch(() => {})
    }

    return reply.send({ ok: true, estado: nuevoEstado })
  } catch (error) {
    console.error('[API/leads] doAccion:', error.message)
    return reply.status(500).send({ error: 'Error en acción' })
  }
}

export async function getReportes(request, reply, prisma) {
  try {
    // Mismo criterio que getLeads: el scope viene del JWT, no de la query string
    // (antes `?role=ADMIN` daba los números de negocio de TODOS los clientes).
    const where = scopeWhere(request.user)

    const [total, cerrados, enFlujo, nuevos, notificados] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...where, estado: 'CERRADO' } }),
      prisma.lead.count({ where: { ...where, estado: 'EN_FLUJO' } }),
      prisma.lead.count({ where: { ...where, estado: 'NUEVO' } }),
      prisma.lead.count({ where: { ...where, estado: 'NOTIFICADO' } }),
    ])

    const conversion = total > 0 ? Math.round((cerrados / total) * 100) : 0
    return reply.send({ total, cerrados, porLlamar: enFlujo, nuevos, notificados, conversion, periodo: 'todos' })
  } catch (error) {
    console.error('[API/leads] getReportes:', error.message)
    return reply.status(500).send({ error: 'Error al obtener reportes' })
  }
}

// Historial de mensajes — nuevo endpoint para el Inbox
export async function getMensajes(request, reply, prisma) {
  try {
    const leadId = Number(request.params.id)

    // Esto devuelve la CONVERSACIÓN COMPLETA de una persona real. Sin la guarda,
    // un token de cualquier tenant leía los chats de los leads de otro cliente
    // iterando ids. Es el dato más sensible del sistema después del comprobante.
    if (!await leadEnScope(prisma, request, leadId, { select: { id: true } })) {
      return reply.status(404).send({ error: 'Lead no encontrado' })
    }

    const mensajes = await prisma.message.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
      take: 100
    })
    return reply.send(mensajes)
  } catch (error) {
    console.error('[API/leads] getMensajes:', error.message)
    return reply.status(500).send({ error: 'Error al obtener mensajes' })
  }
}
