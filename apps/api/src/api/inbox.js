// src/api/inbox.js — Hito 1 (Fase Frontend): contrato v2 de LECTURA para el Inbox.
// Expone el estado REAL del cerebro (lead_state) que el CRM viejo nunca vio.
// Todos los handlers asumen que verifyJwt ya corrió (request.user disponible) y
// acotan con scopeWhere → un VENDOR solo ve lo suyo, ADMIN/SUPERVISOR todo el tenant.
// Contrato: ../../shared/types.ts (LeadListItem / LeadDetail / ConversationResponse).

import { scopeWhere } from '../lib/auth-guard.js'

// ── Serializers (puros, exportados para test) ──────────────────────────────

function leerSlots(st) {
  return (st?.slotsFilled && typeof st.slotsFilled === 'object') ? st.slotsFilled : {}
}

export function serializeLeadListItem(lead) {
  const st = lead.leadState
  const slots = leerSlots(st)
  const ultimo = lead.mensajes?.[0] || null
  return {
    id: lead.id,
    nombre: lead.nombreDetectado || slots.nombre || lead.telefono,
    telefono: lead.telefono,
    producto: lead.productoDetectado || slots.producto || null,
    stage: st?.currentStage || 'first_contact',
    mode: st?.currentMode || 'AUTO_CONSULTIVO',
    temperatura: slots.temperatura_lead || slots.temperatura || null,
    objecion: slots.objecion || null,
    ultimoMensaje: ultimo?.texto || null,
    ultimoMensajeAt: ultimo?.createdAt || st?.lastMessageAt || lead.updatedAt || null,
    ultimoOrigen: ultimo?.origen || null,
    vendedor: lead.vendor?.nombre || null,
    esRecurrente: !!st?.returningLeadFlag,
  }
}

export function serializeLeadDetail(lead) {
  const st = lead.leadState
  const slots = leerSlots(st)
  return {
    id: lead.id,
    nombre: lead.nombreDetectado || slots.nombre || lead.telefono,
    telefono: lead.telefono,
    stage: st?.currentStage || 'first_contact',
    mode: st?.currentMode || 'AUTO_CONSULTIVO',
    slots: sinInternos(slots),
    cierreResumen: resumirCierre(slots._cierre),
    esRecurrente: !!st?.returningLeadFlag,
    vendedor: lead.vendor?.nombre || null,
    creadoEn: lead.createdAt,
  }
}

// Quita las claves internas (prefijo _, ej. _cierre) antes de exponer los slots.
function sinInternos(slots) {
  const out = {}
  for (const [k, v] of Object.entries(slots)) if (!k.startsWith('_')) out[k] = v
  return out
}

// Resume legible el estado del closer (_cierre) para la ficha del vendedor.
function resumirCierre(cierre) {
  if (!cierre || typeof cierre !== 'object') return null
  const partes = []
  if (cierre.ofertas_llamada != null) partes.push(`${cierre.ofertas_llamada} ofertas de llamada`)
  if (Array.isArray(cierre.objeciones_trabajadas) && cierre.objeciones_trabajadas.length)
    partes.push(`objeciones: ${cierre.objeciones_trabajadas.join(', ')}`)
  if (Array.isArray(cierre.municion_usada) && cierre.municion_usada.length)
    partes.push(`munición usada: ${cierre.municion_usada.join(', ')}`)
  return partes.length ? partes.join(' · ') : null
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function listLeadsV2(request, reply, prisma) {
  try {
    const leads = await prisma.lead.findMany({
      where: scopeWhere(request.user),
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        leadState: { select: { currentStage: true, currentMode: true, slotsFilled: true, lastMessageAt: true, returningLeadFlag: true } },
        vendor: { select: { nombre: true } },
        mensajes: { orderBy: { createdAt: 'desc' }, take: 1, select: { texto: true, origen: true, createdAt: true } },
      },
    })
    return reply.send(leads.map(serializeLeadListItem))
  } catch (error) {
    console.error('[inbox] listLeadsV2:', error.message)
    return reply.code(500).send({ error: 'error al listar leads' })
  }
}

export async function leadDetailV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      include: { leadState: true, vendor: { select: { nombre: true } } },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })
    return reply.send(serializeLeadDetail(lead))
  } catch (error) {
    console.error('[inbox] leadDetailV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener el lead' })
  }
}

export async function conversationV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    // Ownership: el lead debe estar en el scope del usuario (si no, 404, no se filtra).
    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    const [mensajes, notifs] = await Promise.all([
      prisma.message.findMany({ where: { leadId: id }, orderBy: { createdAt: 'asc' }, take: 300, select: { origen: true, texto: true, createdAt: true } }),
      prisma.crmNotification.findMany({ where: { leadId: id }, orderBy: { createdAt: 'asc' }, select: { title: true, priority: true, createdAt: true } }),
    ])

    const eventos = [
      ...mensajes.map(m => ({ kind: 'message', origen: m.origen, texto: m.texto, at: m.createdAt })),
      ...notifs.map(n => ({ kind: 'state', label: n.title, priority: n.priority, at: n.createdAt })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at))

    return reply.send({ leadId: id, eventos })
  } catch (error) {
    console.error('[inbox] conversationV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener la conversación' })
  }
}
