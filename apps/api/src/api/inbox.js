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
    // La venta cerrada vive como clave interna (_pedido) para que el bot no la liste
    // como dato del lead; aquí se expone aparte para el vendedor.
    pedido: (slots._pedido && typeof slots._pedido === 'object') ? slots._pedido : null,
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

// GET /v2/vendors — vendedores del MISMO tenant, para el picker de reasignar.
// A diferencia del /auth/vendors PÚBLICO (pantalla de login, pre-auth), esta es
// autenticada y tenant-scopeada → NO filtra vendedores de otros tenants (muro duro).
// FAIL-CLOSED: sin tenantId en el token, lista vacía (Prisma trata `tenantId: undefined`
// como "sin filtro" = devolvería TODOS los tenants → lo cortamos antes de la query).
export async function listVendorsV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.send([])
    const vendors = await prisma.vendor.findMany({
      where: { tenantId, activo: true },
      select: { id: true, nombre: true, role: true },
      orderBy: { id: 'asc' },
    })
    return reply.send(vendors)
  } catch (error) {
    console.error('[inbox] listVendorsV2:', error.message)
    return reply.code(500).send({ error: 'error al listar vendedores' })
  }
}

// Paginación opt-in: sin ?limit ni ?offset se devuelve el array legacy (compat con
// el front actual). Con ellos, { items, page: { limit, offset, hasMore } } para que
// el CRM pagine bandejas de miles de leads sin traerlas enteras.
function leerPaginacionLeads(query) {
  if (query?.limit === undefined && query?.offset === undefined) return null
  let limit = query?.limit === undefined ? 50 : Number(query.limit)
  let offset = query?.offset === undefined ? 0 : Number(query.offset)
  if (!Number.isInteger(limit) || limit < 1) limit = 50
  if (limit > 200) limit = 200
  if (!Number.isInteger(offset) || offset < 0) offset = 0
  return { limit, offset }
}

export async function listLeadsV2(request, reply, prisma) {
  try {
    const pag = leerPaginacionLeads(request.query)
    const base = {
      where: scopeWhere(request.user),
      orderBy: { updatedAt: 'desc' },
      include: {
        leadState: { select: { currentStage: true, currentMode: true, slotsFilled: true, lastMessageAt: true, returningLeadFlag: true, label: true } },
        vendor: { select: { nombre: true } },
        mensajes: { orderBy: { createdAt: 'desc' }, take: 1, select: { texto: true, origen: true, createdAt: true } },
      },
    }
    if (!pag) {
      const leads = await prisma.lead.findMany({ ...base, take: 200 })
      return reply.send(leads.map(serializeLeadListItem))
    }
    // +1 para saber si hay más sin un COUNT extra.
    const leads = await prisma.lead.findMany({ ...base, take: pag.limit + 1, skip: pag.offset })
    const hasMore = leads.length > pag.limit
    const items = (hasMore ? leads.slice(0, pag.limit) : leads).map(serializeLeadListItem)
    return reply.send({ items, page: { limit: pag.limit, offset: pag.offset, hasMore } })
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

const TIPOS_CURSOR = ['message', 'media', 'state']

function compararEventoDesc(a, b) {
  const fecha = new Date(b.evento.at).getTime() - new Date(a.evento.at).getTime()
  if (fecha) return fecha
  const tipo = TIPOS_CURSOR.indexOf(a.tipo) - TIPOS_CURSOR.indexOf(b.tipo)
  if (tipo) return tipo
  if (a.tipo !== 'state') return Number(b.id) - Number(a.id)
  return String(a.id) === String(b.id) ? 0 : String(a.id) < String(b.id) ? 1 : -1
}

export function cursorConversacion(fila) {
  return 'c1.' + Buffer.from(JSON.stringify({
    at: new Date(fila.evento.at).toISOString(), tipo: fila.tipo, id: fila.id,
  })).toString('base64url')
}

function leerCursorConversacion(valor) {
  if (typeof valor !== 'string' || valor.length > 512) return null
  if (!valor.startsWith('c1.')) {
    const at = new Date(valor)
    return Number.isNaN(at.getTime()) ? null : { at }
  }
  try {
    const c = JSON.parse(Buffer.from(valor.slice(3), 'base64url').toString('utf8'))
    const at = new Date(c.at)
    if (Number.isNaN(at.getTime()) || !TIPOS_CURSOR.includes(c.tipo)) return null
    if (c.tipo === 'state' ? typeof c.id !== 'string' || !c.id : !Number.isSafeInteger(c.id) || c.id < 1) return null
    return { at, tipo: c.tipo, id: c.id }
  } catch { return null }
}

// before=ISO se mantiene para consumidores anteriores. El cursor nuevo desempata
// fecha + tipo + id; cada stream recibe exactamente el mismo límite lógico.
function corteConversacion(cursor, tipo) {
  if (!cursor) return {}
  if (!cursor.tipo) return { createdAt: { lt: cursor.at } }
  const orden = TIPOS_CURSOR.indexOf(tipo) - TIPOS_CURSOR.indexOf(cursor.tipo)
  if (orden < 0) return { createdAt: { lt: cursor.at } }
  if (orden > 0) return { createdAt: { lte: cursor.at } }
  return { OR: [
    { createdAt: { lt: cursor.at } },
    { createdAt: cursor.at, id: { lt: cursor.id } },
  ] }
}

export async function conversationV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    let limit = 300
    if (request.query?.limit !== undefined) {
      const n = Number(request.query.limit)
      limit = Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 300
    }
    const paginada = true
    const cursor = request.query?.before === undefined ? null : leerCursorConversacion(request.query.before)
    if (request.query?.before !== undefined && !cursor) {
      return reply.code(400).send({ error: 'before debe ser fecha ISO o cursor de conversación válido' })
    }
    const ventana = paginada ? { take: limit + 1 } : {}
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }]
    const [mensajes, notifs, huerfanas] = await Promise.all([
      prisma.message.findMany({
        where: { leadId: id, ...corteConversacion(cursor, 'message') }, orderBy, ...ventana,
        select: { id: true, origen: true, texto: true, createdAt: true, status: true, errorDetalle: true },
      }),
      prisma.crmNotification.findMany({
        where: { leadId: id, ...corteConversacion(cursor, 'state') }, orderBy, ...ventana,
        select: { id: true, title: true, priority: true, createdAt: true },
      }),
      prisma.mediaAsset.findMany({
        where: { leadId: id, messageId: null, ...corteConversacion(cursor, 'media') }, orderBy, ...ventana,
        select: { id: true, messageId: true, tipo: true, mimeType: true, createdAt: true },
      }),
    ])
    const candidatos = [
      ...mensajes.map(m => {
        const evento = { id: 'message:' + m.id, kind: 'message', origen: m.origen, texto: m.texto, at: m.createdAt }
        if (m.origen !== 'LEAD' && m.status) {
          evento.estado = m.status
          if (m.status === 'failed' && m.errorDetalle) evento.estadoDetalle = m.errorDetalle
        }
        return { tipo: 'message', id: m.id, evento }
      }),
      ...huerfanas.map(md => ({
        tipo: 'media', id: md.id,
        evento: { id: 'media:' + md.id, kind: 'message', origen: 'LEAD', texto: null, at: md.createdAt, media: { id: md.id, tipo: md.tipo, mimeType: md.mimeType } },
      })),
      ...notifs.map(n => ({
        tipo: 'state', id: n.id,
        evento: { id: 'state:' + n.id, kind: 'state', label: n.title, priority: n.priority, at: n.createdAt },
      })),
    ].sort(compararEventoDesc)
    const hayMas = paginada && candidatos.length > limit
    const filas = paginada ? candidatos.slice(0, limit) : candidatos
    const idsMensajes = filas.filter(f => f.tipo === 'message').map(f => f.id)
    // Adjuntos de los mensajes seleccionados: su fecha puede diferir de la del
    // marcador, por lo que no deben recortarse con el cursor del timeline.
    if (idsMensajes.length) {
      const adjuntos = await prisma.mediaAsset.findMany({
        where: { leadId: id, messageId: { in: idsMensajes } },
        orderBy: { id: 'asc' },
        select: { id: true, messageId: true, tipo: true, mimeType: true },
      })
      const porMensaje = new Map(adjuntos.map(md => [md.messageId, md]))
      for (const fila of filas) {
        const md = fila.tipo === 'message' && porMensaje.get(fila.id)
        if (md) fila.evento.media = { id: md.id, tipo: md.tipo, mimeType: md.mimeType }
      }
    }
    const ultima = filas.at(-1)
    return reply.send({
      leadId: id,
      eventos: filas.map(f => f.evento).reverse(),
      page: {
        limit, hayMas,
        cursorAntesDe: hayMas && ultima ? new Date(ultima.evento.at).toISOString() : null,
        cursor: hayMas && ultima ? cursorConversacion(ultima) : null,
      },
    })
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
    if (media.tenantId && media.tenantId !== request.user?.tenantId) return reply.code(404).send({ error: 'media no encontrada' })

    if (media.storage === 'pg' && media.bytes) {
      reply.header('Content-Type', media.mimeType || 'application/octet-stream')
      reply.header('X-Content-Type-Options', 'nosniff')
      if (!/^(image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/mp4|application\/pdf)$/i.test(media.mimeType || '')) reply.header('Content-Disposition', 'attachment')
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
