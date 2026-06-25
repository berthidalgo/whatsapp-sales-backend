// src/api/inbox.js — Hito 1 (Fase Frontend): contrato v2 de LECTURA para el Inbox.
// Expone el estado REAL del cerebro (lead_state) que el CRM viejo nunca vio.
// Todos los handlers asumen que verifyJwt ya corrió (request.user disponible) y
// acotan con scopeWhere → un VENDOR solo ve lo suyo, ADMIN/SUPERVISOR todo el tenant.
// Contrato: ../../shared/types.ts (LeadListItem / LeadDetail / ConversationResponse).

import { scopeWhere } from '../lib/auth-guard.js'
import { getMedia } from '../lib/mediaStore.js'

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
    label: st?.label ?? null,
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
    label: st?.label ?? null,
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
        leadState: { select: { currentStage: true, currentMode: true, slotsFilled: true, lastMessageAt: true, returningLeadFlag: true, label: true } },
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

    const [mensajes, notifs, medias] = await Promise.all([
      prisma.message.findMany({ where: { leadId: id }, orderBy: { createdAt: 'asc' }, take: 300, select: { id: true, origen: true, texto: true, createdAt: true } }),
      prisma.crmNotification.findMany({ where: { leadId: id }, orderBy: { createdAt: 'asc' }, select: { title: true, priority: true, createdAt: true } }),
      prisma.mediaAsset.findMany({ where: { leadId: id }, select: { id: true, messageId: true, tipo: true, mimeType: true } }),
    ])

    // Linkear cada media a su mensaje marcador (1:1 por messageId) → el front la
    // renderiza inline. La media NO se sirve aquí (solo metadatos); el front la pide
    // con auth al endpoint /media/:mediaId (cero URL pública del comprobante).
    const mediaPorMsg = new Map()
    for (const m of medias) if (m.messageId != null) mediaPorMsg.set(m.messageId, m)

    const eventos = [
      ...mensajes.map(m => {
        const ev = { kind: 'message', origen: m.origen, texto: m.texto, at: m.createdAt }
        const md = mediaPorMsg.get(m.id)
        if (md) ev.media = { id: md.id, tipo: md.tipo, mimeType: md.mimeType }
        return ev
      }),
      ...notifs.map(n => ({ kind: 'state', label: n.title, priority: n.priority, at: n.createdAt })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at))

    return reply.send({ leadId: id, eventos })
  } catch (error) {
    console.error('[inbox] conversationV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener la conversación' })
  }
}

// GET /v2/leads/:id/media/:mediaId — sirve los bytes de una media con JWT+scope.
// Doble guarda: el lead debe estar en el scope del usuario Y la media debe pertenecer
// a ese lead (un vendedor no saca media de otro adivinando el mediaId). Sin URL pública
// → la PII financiera del comprobante solo la ve el dueño/admin autenticado.
export async function serveMediaV2(request, reply, prisma) {
  try {
    const leadId = Number(request.params.id)
    const mediaId = Number(request.params.mediaId)
    if (!Number.isInteger(leadId) || !Number.isInteger(mediaId)) {
      return reply.code(400).send({ error: 'parámetros inválidos' })
    }

    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id: leadId }, select: { id: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    const media = await getMedia(prisma, mediaId)
    if (!media || media.leadId !== leadId) return reply.code(404).send({ error: 'media no encontrada' })

    if (media.storage === 'pg' && media.bytes) {
      reply.header('Content-Type', media.mimeType || 'application/octet-stream')
      reply.header('Cache-Control', 'private, max-age=3600')
      return reply.send(Buffer.from(media.bytes))
    }
    if (media.storage === 'supabase' && media.url) {
      return reply.redirect(media.url)  // futuro: signed URL de bucket privado
    }
    return reply.code(404).send({ error: 'media sin contenido' })
  } catch (error) {
    console.error('[inbox] serveMediaV2:', error.message)
    return reply.code(500).send({ error: 'error al servir media' })
  }
}
