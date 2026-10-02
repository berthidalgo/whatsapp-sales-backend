// src/api/inbox.js — Hito 1 (Fase Frontend): contrato v2 de LECTURA para el Inbox.
// Expone el estado REAL del cerebro (lead_state) que el CRM viejo nunca vio.
// Todos los handlers asumen que verifyJwt ya corrió (request.user disponible) y
// acotan con scopeWhere → un VENDOR solo ve lo suyo, ADMIN/SUPERVISOR todo el tenant.
// Contrato: ../../shared/types.ts (LeadListItem / LeadDetail / ConversationResponse).

import { scopeWhere } from '../lib/auth-guard.js'
import { getMedia } from '../lib/mediaStore.js'
// La taxonomía de etiquetas es la misma que valida inbox-actions (fuente única back↔front):
// un filtro de etiqueta arbitrario se ignora en vez de consultarse.
import { esEtiquetaValida } from '../../../../packages/shared/labels.js'

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
    // Resultado confirmado por una persona (no la etapa inferida del bot). Ver
    // `resultadoConfirmado`: sin llamada registrada, esto es null y la interfaz lo muestra
    // como "no disponible" en lugar de rellenar con una suposición.
    ...resultadoConfirmado(lead.callEvents),
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
    ...resultadoConfirmado(lead.callEvents),
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

// Filtros de la bandeja (Hito B2). Se resuelven AQUÍ, en SQL, sobre el alcance del
// usuario: no sobre la página cargada.
//
// POR QUÉ NO EN EL NAVEGADOR (el bug que esto arregla): la pantalla pedía ?limit&?offset y
// después filtraba los 50–200 elementos que tenía en memoria. Con 2.000 leads, buscar
// "Surco" mostraba cero resultados aunque hubiera leads de Surco: no estaban en la página.
// La interfaz lo-rotulaba "Ningún lead coincide con el filtro", que es FALSO. Ahora el
// backend filtra sobre todo el alcance y devuelve `total`, y la pantalla puede decir
// "3 de 412" con verdad.
function leerFiltrosLeads(query, { etiquetaValida }) {
  const q = typeof query?.q === 'string' ? query.q.trim().slice(0, 120) : ''
  const stage = typeof query?.stage === 'string' && /^[a-z_]+$/i.test(query.stage) ? query.stage : ''
  // '__none__' es el filtro "sin etiqueta"; cualquier otra cosa tiene que ser taxonomía
  // válida. Un valor arbitrario se ignora en vez de consultarse (el rótulo lo elige el
  // backend, no el cliente).
  const labelCrudo = typeof query?.label === 'string' ? query.label : ''
  const label = labelCrudo === '__none__' ? '__none__' : (labelCrudo && etiquetaValida(labelCrudo) ? labelCrudo : '')
  return { q, stage, label }
}

// ════════════════════════════════════════════════════════════════════════
// HITO B4 — RESULTADO COMERCIAL CONFIRMADO POR UN HUMANO
//
// `lead_state.current_stage` es una INFERENCIA: dice dónde cree el bot que está la
// conversación. No es un hecho de negocio, y el código lo trata como tal (el bot nunca marca
// call_confirmed ni post_close: son etapas que validan las personas). Tampoco sirve para
// medir: un embudo lleno de "post_close" inferidos por el bot no son ventas.
//
// El resultado que sí es un hecho es `call_events.outcome_tag`, escrito por el vendedor en el
// debrief. Por eso `resultadoConfirmado` se lee de ahí y NO del stage, y cada respuesta dice
// de dónde sale. Cuando no hay llamada registrada, se dice "no disponible" en vez de
// inventar un valor: un panel que rellena huecos con mentiras no sirve para decidir.
//
// Se expone como etiqueta en la lista y en el detalle para que el vendedor vea el estado
// comercial de un vistazo, sinplerlo con la etapa inferida.
// ════════════════════════════════════════════════════════════════════════

export const RESULTADOS_HUMANOS = new Set([
  'interesado', 'agendado', 'pensándolo', 'pidió_info',
  'no_contesta', 'no_interesado', 'pagó', 'otro',
])

// Traducción a una etiqueta corta y honesta para la interfaz.
const ETIQUETA_RESULTADO = {
  interesado: 'Contactado', agendado: 'Agendado', 'pensándolo': 'Pendiente',
  'pidió_info': 'Contactado', no_contesta: 'Sin respuesta', no_interesado: 'No interesado',
  pagó: 'Venta confirmada', otro: 'Otro',
}

/**
 * Último resultado CONFIRMADO por un humano para este lead. Es lo que se expone en el
 * contrato (`resultado`, `resultadoEtiqueta`, `resultadoFuente`): el nombre de la clave es
 * parte del contrato con el front, no un detalle interno.
 * @returns {{ resultado: string|null, resultadoEtiqueta: string|null, resultadoFuente: 'call_events'|null, resultadoFecha: string|null }}
 */
export function resultadoConfirmado(callEvents) {
  if (!Array.isArray(callEvents) || !callEvents.length) {
    return { resultado: null, resultadoEtiqueta: null, resultadoFuente: null, resultadoFecha: null }
  }
  const conTag = callEvents.filter(c => c?.outcomeTag && RESULTADOS_HUMANOS.has(c.outcomeTag))
  if (!conTag.length) return { resultado: null, resultadoEtiqueta: null, resultadoFuente: null, resultadoFecha: null }
  const ultimo = conTag.sort((a, b) => new Date(b.occurredAt || b.createdAt || 0) - new Date(a.occurredAt || a.createdAt || 0))[0]
  return {
    resultado: ultimo.outcomeTag,
    resultadoEtiqueta: ETIQUETA_RESULTADO[ultimo.outcomeTag] || ultimo.outcomeTag,
    resultadoFuente: 'call_events',
    resultadoFecha: ultimo.occurredAt || ultimo.createdAt || null,
  }
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
// el front actual). Con ellos —o con filtros— se devuelve
// { items, page: { limit, offset, hasMore, total } }.
//
// `total` cuenta los leads del ALCANCE del usuario que cumplen los filtros, no los de la
// página. Es lo que permite decir "3 de 412" en pantalla en vez de "Ningún lead coincide
// con el filtro", que era FALSO cuando el lead buscado estaba en la página 3.
function leerPaginacionLeads(query, { conFiltros = false, etiquetaValida = () => false } = {}) {
  const hayFiltros = conFiltros && (
    (typeof query?.q === 'string' && query.q.trim()) ||
    (typeof query?.stage === 'string' && query.stage) ||
    (typeof query?.label === 'string' && query.label)
  )
  if (query?.limit === undefined && query?.offset === undefined && !hayFiltros) return null
  let limit = query?.limit === undefined ? 50 : Number(query.limit)
  let offset = query?.offset === undefined ? 0 : Number(query.offset)
  if (!Number.isInteger(limit) || limit < 1) limit = 50
  if (limit > 200) limit = 200
  if (!Number.isInteger(offset) || offset < 0) offset = 0
  return { limit, offset, filtros: leerFiltrosLeads(query, { etiquetaValida }) }
}

export async function listLeadsV2(request, reply, prisma) {
  try {
    const pag = leerPaginacionLeads(request.query, { conFiltros: true, etiquetaValida: esEtiquetaValida })
    const base = {
      where: scopeWhere(request.user),
      orderBy: { updatedAt: 'desc' },
include: {
        leadState: { select: { currentStage: true, currentMode: true, slotsFilled: true, lastMessageAt: true, returningLeadFlag: true, label: true } },
        vendor: { select: { nombre: true } },
        mensajes: { orderBy: { createdAt: 'desc' }, take: 1, select: { texto: true, origen: true, createdAt: true } },
        // La ÚLTIMA llamada registrada: de aquí sale el resultado comercial confirmado.
        // No es el stage del bot (ver `resultadoConfirmado`).
        callEvents: {
          orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
          take: 5,
          select: { outcomeTag: true, occurredAt: true, createdAt: true },
        },
      },
    }
    if (!pag) {
      const leads = await prisma.lead.findMany({ ...base, take: 200 })
      return reply.send(leads.map(serializeLeadListItem))
    }
    const where = aplicarFiltrosLeads(base.where, pag.filtros)
    // +1 fila para saber si hay más sin traerla; el total sí se cuenta, porque es el dato
    // que evita presentar una página parcial como si fuera el resultado completo.
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({ ...base, where, take: pag.limit + 1, skip: pag.offset }),
      prisma.lead.count({ where }),
    ])
    const hasMore = leads.length > pag.limit
    const items = (hasMore ? leads.slice(0, pag.limit) : leads).map(serializeLeadListItem)
    return reply.send({ items, page: { limit: pag.limit, offset: pag.offset, hasMore, total } })
  } catch (error) {
    console.error('[inbox] listLeadsV2:', error.message)
    return reply.code(500).send({ error: 'error al listar leads' })
  }
}

/**
 * Aplica búsqueda y filtros al alcance del usuario, TODO en Prisma/SQL: nombre, teléfono y
 * producto (este último vive en el slot del cerebro), etapa y etiqueta.
 *
 * Se aplica SOBRE `scopeWhere(user)`, así que un filtro nunca amplía el alcance: un
 * vendedor sigue viendo solo sus leads con cualquier combinación de filtros.
 */
export function aplicarFiltrosLeads(where, filtros = {}) {
  const out = { ...where }
  if (filtros.q) {
    const q = filtros.q
    out.OR = [
      { nombreDetectado: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q } },
      { leadState: { slotsFilled: { path: ['producto'], string_contains: q } } },
    ]
  }
  if (filtros.stage) out.leadState = { ...(out.leadState || {}), currentStage: filtros.stage }
  if (filtros.label === '__none__') out.leadState = { ...(out.leadState || {}), label: null }
  else if (filtros.label) out.leadState = { ...(out.leadState || {}), label: filtros.label }
  return out
}

export async function leadDetailV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      include: {
        leadState: true,
        vendor: { select: { nombre: true } },
        callEvents: {
          orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
          take: 5,
          select: { outcomeTag: true, occurredAt: true, createdAt: true },
        },
      },
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
