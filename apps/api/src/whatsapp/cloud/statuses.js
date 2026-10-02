// Recibos de Meta: dueño verificado, avance atómico y cola durable para callbacks tempranos.
import prismaDefault from '../../db/prisma.js'
import { resolveChannel as resolveChannelDefault } from '../../webhook/channel-resolver.js'

const PISABLES = {
  sent: ['sent'],
  delivered: ['sent', 'delivered'],
  read: ['sent', 'delivered', 'read', 'failed'],
  failed: ['sent', 'delivered', 'read', 'failed'],
}
export const ESTADOS_VALIDOS = new Set(Object.keys(PISABLES))

export function resumirError(errors) {
  const e = Array.isArray(errors) ? errors[0] : null
  if (!e) return { errorCode: null, errorDetalle: null }
  const texto = [...new Set([e.title, e.message, e.error_data?.details].filter(Boolean))].join(' · ').slice(0, 500)
  return { errorCode: Number.isInteger(e.code) ? e.code : null, errorDetalle: texto || null }
}

// El 'sent' inicial de Message es un ACK local, con milisegundos. El recibo de Meta
// usa segundos y puede parecer anterior a ese ACK; solo los estados del proveedor
// se comparan por fecha. La cola pendiente siempre contiene fechas del proveedor.
function estadoAplicable(status, statusAt, ackLocal = false) {
  const alternativas = [{ status: null }]
  if (ackLocal) alternativas.push({ status: 'sent' })
  alternativas.push({
    AND: [
      { status: { in: PISABLES[status] } },
      { OR: [{ statusAt: null }, { statusAt: { lte: statusAt } }] },
    ],
  })
  return { OR: alternativas }
}

function fechaRecibo(timestamp) {
  if (timestamp == null || timestamp === '') return new Date()
  const segundos = Number(timestamp)
  const fecha = new Date(segundos * 1000)
  return Number.isFinite(segundos) && segundos >= 0 && Number.isFinite(fecha.getTime()) ? fecha : null
}

function clavePendiente(phoneNumberId, waMessageId) {
  return { phoneNumberId_waMessageId: { phoneNumberId, waMessageId } }
}

/**
 * Consume un pendiente solo cuando existe su Message del mismo tenant y teléfono.
 * deleteMany acotado a la versión leída evita borrar un recibo más nuevo que llegue
 * durante la conciliación. Se puede repetir después de un reinicio sin regresiones.
 */
export async function conciliarReciboPendiente({ waMessageId, phoneNumberId, tenantId }, prisma = prismaDefault) {
  if (!waMessageId || !phoneNumberId || !tenantId) return { aplicado: false, motivo: 'sin_dueño' }
  const pendiente = await prisma.pendingCloudReceipt.findUnique({ where: clavePendiente(phoneNumberId, waMessageId) })
  if (!pendiente || pendiente.tenantId !== tenantId) return { aplicado: false, motivo: 'sin_pendiente' }
  const dueño = {
    waMessageId,
    lead: { tenantId },
    OR: [{ cloudPhoneNumberId: phoneNumberId }, { cloudPhoneNumberId: null }],
  }
  const r = await prisma.message.updateMany({
    where: { ...dueño, AND: [estadoAplicable(pendiente.status, pendiente.statusAt, true)] },
    data: {
      status: pendiente.status, statusAt: pendiente.statusAt,
      errorCode: pendiente.errorCode, errorDetalle: pendiente.errorDetalle,
      cloudPhoneNumberId: phoneNumberId,
    },
  })
  // Una fila avanzada puede consumir el pendiente; una fila ajena nunca lo consume.
  const existe = r.count > 0 || await prisma.message.findFirst({ where: dueño, select: { id: true } })
  if (!existe) {
    // Rotar los huérfanos evita que los primeros 100 bloqueen la recuperación de otros.
    await prisma.pendingCloudReceipt.updateMany({ where: { tenantId, phoneNumberId, waMessageId }, data: { updatedAt: new Date() } })
    return { aplicado: false, pendiente: true, motivo: 'esperando_mensaje' }
  }
  await prisma.pendingCloudReceipt.deleteMany({
    where: {
      phoneNumberId, waMessageId, tenantId,
      status: pendiente.status, statusAt: pendiente.statusAt,
    },
  })
  return { aplicado: r.count > 0, motivo: r.count > 0 ? null : 'ya_avanzado' }
}

/** Guarda primero: el HTTP 200 del webhook nunca convierte un callback temprano en pérdida. */
export async function aplicarStatus(ev, prisma = prismaDefault, deps = {}) {
  const waMessageId = ev?.messageId
  const status = String(ev?.status || '').toLowerCase()
  const phoneNumberId = String(ev?.phoneNumberId || '').trim()
  if (!waMessageId) return { aplicado: false, motivo: 'sin_wamid' }
  if (!ESTADOS_VALIDOS.has(status)) return { aplicado: false, motivo: 'estado_desconocido: ' + status }
  if (!phoneNumberId) return { aplicado: false, motivo: 'sin_canal' }
  const statusAt = fechaRecibo(ev.timestamp)
  if (!statusAt) return { aplicado: false, motivo: 'timestamp_invalido' }
  const canal = await (deps.resolveChannel || resolveChannelDefault)(phoneNumberId)
  if (canal?.resolvedBy !== 'channel' || canal?.provider !== 'cloud' ||
      canal?.externalKey !== phoneNumberId || !canal?.tenantId) {
    return { aplicado: false, motivo: 'canal_no_verificado' }
  }
  const tenantId = canal.tenantId
  const error = status === 'failed' ? resumirError(ev.errors) : { errorCode: null, errorDetalle: null }
  const data = { tenantId, phoneNumberId, waMessageId, status, statusAt, ...error }
  try {
    await prisma.pendingCloudReceipt.create({ data })
  } catch (err) {
    if (err?.code !== 'P2002') throw err
    await prisma.pendingCloudReceipt.updateMany({
      where: { tenantId, phoneNumberId, waMessageId, AND: [estadoAplicable(status, statusAt)] },
      data: { status, statusAt, ...error },
    })
  }
  const resultado = await conciliarReciboPendiente({ waMessageId, phoneNumberId, tenantId }, prisma)
  if (resultado.aplicado && status === 'failed') {
    console.warn('[CloudStatus] mensaje ' + waMessageId + ' no llegó — ' + (error.errorCode || 's/código') + ': ' + (error.errorDetalle || 'sin detalle'))
  }
  return resultado
}

/** Recuperación acotada para reinicios o fallos temporales después del insert saliente. */
export async function conciliarRecibosPendientes(prisma = prismaDefault, { limit = 100 } = {}) {
  const pendientes = await prisma.pendingCloudReceipt.findMany({
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(Number(limit) || 100, 500)),
  })
  let aplicados = 0
  for (const p of pendientes) {
    try {
      const r = await conciliarReciboPendiente(p, prisma)
      if (r.aplicado) aplicados++
    } catch (err) {
      console.error('[CloudStatus] conciliación pendiente:', err.message)
    }
  }
  return { revisados: pendientes.length, aplicados }
}

export async function procesarStatuses(eventos, prisma = prismaDefault, deps = {}) {
  let aplicados = 0, omitidos = 0, fallidos = 0, pendientes = 0
  for (const ev of eventos) {
    if (ev.tipo !== 'status') continue
    try {
      const r = await aplicarStatus(ev, prisma, deps)
      if (r.aplicado) { aplicados++; if (ev.status === 'failed') fallidos++ }
      else if (r.pendiente) pendientes++
      else omitidos++
    } catch (err) {
      omitidos++
      console.error('[CloudStatus] recibo ' + ev.messageId + ' falló:', err.message)
    }
  }
  return { aplicados, omitidos, fallidos, pendientes }
}

export const CLOUD_STATUSES_VERSION = 'v2_cola_durable_por_dueño'
