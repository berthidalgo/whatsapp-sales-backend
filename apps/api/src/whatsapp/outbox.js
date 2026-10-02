// src/whatsapp/outbox.js — SALIDA DURABLE (Hito A2)
//
// EL AGUJERO QUE CIERRA. Meta acepta el envío y devuelve un wamid; DESPUÉS insertábamos
// la fila del historial. Si ese insert fallaba (BD inestable, despliegue), el cliente había
// recibido el mensaje y la bandeja no lo sabía: el vendedor veía silencio y el bot podía
// repetir. Peor aún era "arreglarlo" reenviando: el cliente recibía dos.
//
// LO QUE ESTE MÓDULO PROMETE Y LO QUE NO:
//   · La INTENCIÓN de envío se persiste ANTES de llamar a Meta (outbox). Si esa escritura
//     falla, no se envía: es preferible no contestar que mandar algo sin rastro.
//   · El RESULTADO se persiste con la misma fila: SENT con su wamid, REJECTED con el error
//     de Meta, o UNCERTAIN cuando no se puede saber.
//   · NO hay exactly-once y no lo prometemos. Meta NO ofrece clave de idempotencia para
//     POST /messages (verificado en su documentación: la respuesta es un nuevo envío
//     siempre; solo el `wamid` permite TERMINAR una conversación, no deduplicar). Por eso
//     un resultado incierto NUNCA se reenvía solo: se muestra y se resuelve a mano.
//   · Solo lo que NO se envió nunca (un rechazo explícito de Meta, o un fallo antes de la
//     llamada) es reintentable sin riesgo. Por eso los reintentos automáticos se limitan a
//     los fallos previos a la llamada.

import { randomUUID } from 'node:crypto'
import { conciliarReciboPendiente } from './cloud/statuses.js'
import { reciboDeEnvio } from './transporte.js'

export const ESTADO_SALIDA = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  REJECTED: 'REJECTED',
  UNCERTAIN: 'UNCERTAIN',
}

export const MAX_INTENTOS = 2
export const CLAIM_TTL_MS = 5 * 60 * 1000

/**
 * Clasifica el resultado de un envío en tres familias con consecuencias DISTINTAS.
 *
 *   'no_enviado'  — la llamada a Meta no llegó a completarse de forma aceptable y además
 *                    sabemos que no fue aceptada (validación previa, credenciales, canal).
 *                    Reintentable sin riesgo de duplicado.
 *   'rechazado'   — Meta respondió con un error: NO se envió. Nunca se reintenta solo, y
 *                    nunca se marca como enviado.
 *   'incierto'    — no se puede saber si Meta lo aceptó (timeout, caída, 5xx después de
 *                    enviar). NUNCA se reenvía automáticamente. Queda visible.
 */
export function clasificarEnvio(resultado, transporte = 'cloud') {
  if (resultado?.ok) return { clase: 'aceptado', wamid: resultado.messageId || null }

  const error = String(resultado?.error || '')
  // Errores de validación/configuración: la petición ni se construyó. Reintentable.
  const noEnvio = [
    'telefono_required', 'text_required', 'template_required', 'media_params_missing',
    'cloud_not_configured', 'env_', 'instance_required', 'message_id_required',
  ]
  if (noEnvio.some(p => error.startsWith(p))) return { clase: 'no_enviado' }

  // Meta respondió con 5xx: el servidor falló. No sabemos si registró el envío → incierto.
  if (error.startsWith('graph_') && Number(resultado?.status) >= 500) return { clase: 'incierto' }

  // Meta respondió con un rechazo explícito (4xx o error de negocio). Sus errores llegan
  // como graph_<status> o fuera_de_ventana_24h. NO es reintentable y NO se marca enviado.
  if (error.startsWith('graph_') || error === 'fuera_de_ventana_24h' || resultado?.status) {
    return { clase: 'rechazado', codigo: resultado?.errorCode ?? null }
  }

  // Timeout, fetch_error, o cualquier otra cosa: pudo aceptarse. Incierto.
  if (error.startsWith('timeout_') || error === 'fetch_error' || error.startsWith('send_failed_after_retry')) {
    return { clase: 'incierto' }
  }
  // Cualquier otro error sin clasificación explícita: incierto. Es la respuesta
  // conservadora y la correcta: preferimos dejar un envío marcado como incierto (que el
  // operador puede conciliar) que duplicar un mensaje que el cliente ya recibió.
  return { clase: 'incierto' }
}

/**
 * Persiste la INTENCIÓN de envío. OBLIGATORIA antes de llamar a Meta: quien llama debe
 * abortar si esta función lanza, porque todavía no salió nada y el error es honesto.
 */
export async function registrarIntencion(prisma, {
  tenantId, leadId = null, origen, tipo = 'text', payload = {}, canalRef = null,
}) {
  if (!tenantId) throw Object.assign(new Error('tenant requerido en la outbox'), { code: 'OUTBOX_TENANT_REQUIRED' })
  return prisma.outboundMessage.create({
    data: { tenantId, leadId, origen, tipo, payload, canalRef },
    select: { id: true, estado: true },
  })
}

/**
 * Marca la fila como enviada y persiste el mensaje en el historial. Si el insert del
 * historial falla, la outbox queda SENT con wamid y `messageId` nulo: la recuperación la
 * reconcilia por wamid (único) SIN volver a enviar. Esa es la parte que antes duplicaba.
 */
export async function confirmarEnvio(prisma, outboxId, { resultado, mensajeData, canal, tenantId }) {
  const recibo = reciboDeEnvio(resultado, canal)
  let mensaje = null
  let errorHistorial = null
  try {
    mensaje = await prisma.message.create({ data: { ...mensajeData, ...recibo } })
  } catch (err) {
    errorHistorial = err.message
    console.error(`[Outbox] mensaje ${outboxId}: Meta aceptó pero no se pudo guardar el historial: ${err.message}`)
  }
  if (recibo.waMessageId && recibo.cloudPhoneNumberId && tenantId) {
    try {
      await conciliarReciboPendiente({ waMessageId: recibo.waMessageId, phoneNumberId: recibo.cloudPhoneNumberId, tenantId }, prisma)
    } catch (err) {
      console.error('[Outbox] conciliación de recibo pendiente:', err.message)
    }
  }
  await prisma.outboundMessage.update({
    where: { id: outboxId },
    data: {
      estado: ESTADO_SALIDA.SENT,
      waMessageId: recibo.waMessageId || null,
      messageId: mensaje?.id ?? null,
      attempts: { increment: 1 },
      claimId: null, claimedAt: null,
      sentAt: new Date(),
      lastError: errorHistorial,
      updatedAt: new Date(),
    },
  })
  return { mensaje, historialGuardado: !!mensaje, errorHistorial }
}

/** Meta rechazó: NO se marca como enviado y NO se reintenta solo. */
export async function marcarRechazado(prisma, outboxId, { resultado, mensajeData, leadId }) {
  const codigo = resultado?.errorCode ?? null
  const detalle = [resultado?.error, ...(resultado?.errors || []).filter(Boolean)].filter(Boolean).join(' · ').slice(0, 500)
  // El rechazo también deja rastro en el historial: el vendedor ve que intentó contestar
  // y que Meta no lo dejó, con su motivo. No se marca 'sent' ni 'failed' de recibo porque
  // nunca hubo un wamid al que colgar un recibo.
  let mensaje = null
  try {
    mensaje = await prisma.message.create({
      data: { ...mensajeData, status: 'failed', statusAt: new Date(), errorCode: codigo, errorDetalle: detalle || null },
    })
  } catch (err) {
    console.error(`[Outbox] mensaje ${outboxId}: no se pudo registrar el rechazo en el historial: ${err.message}`)
  }
  await prisma.outboundMessage.update({
    where: { id: outboxId },
    data: {
      estado: ESTADO_SALIDA.REJECTED, errorCode: codigo, lastError: detalle || null,
      attempts: { increment: 1 }, messageId: mensaje?.id ?? null,
      claimId: null, claimedAt: null, updatedAt: new Date(),
    },
  })
  return { mensaje }
}

/**
 * Resultado incierto: pudo aceptarse, no lo sabemos. NO se reenvía, NO se marca como
 * enviado. Queda consultable para que el operador decida (o para conciliar si más tarde
 * llega un recibo con ese wamid).
 */
export async function marcarIncierto(prisma, outboxId, { resultado }) {
  const detalle = [resultado?.error, ...(resultado?.errors || []).filter(Boolean)].filter(Boolean).join(' · ').slice(0, 500)
  await prisma.outboundMessage.update({
    where: { id: outboxId },
    data: {
      estado: ESTADO_SALIDA.UNCERTAIN, lastError: detalle || null,
      attempts: { increment: 1 }, claimId: null, claimedAt: null, updatedAt: new Date(),
    },
  })
  return { incierto: true }
}

/**
 * Recuperación de salida (arranque y barrido periódico):
 *   · SENT sin historial → se crea la fila por wamid. NO se reenvía.
 *   · SENDING con reclamo caducado → el resultado es desconocido: pasa a UNCERTAIN. Nunca
 *     se reenvía a ciegas, porque pudo aceptarse antes de la caída.
 *   · PENDING que nunca se reclamó → se envía (nunca salió; el intento anterior no empezó).
 */
export async function recuperarOutbox(prisma, { claimTtlMs = CLAIM_TTL_MS, now = new Date(), enviar = null } = {}) {
  const limite = new Date(now.getTime() - claimTtlMs)
  let reconciliados = 0, inciertos = 0, reenviados = 0

  const aceptados = await prisma.outboundMessage.findMany({
    where: { estado: ESTADO_SALIDA.SENT, messageId: null, waMessageId: { not: null } },
    take: 100, select: { id: true, tenantId: true, leadId: true, origen: true, tipo: true, payload: true, waMessageId: true },
  })
  for (const row of aceptados) {
    try {
      // El wamid es único: si ya existe (otra corrida lo hizo), no se inserta dos veces.
      const ya = await prisma.message.findUnique({ where: { waMessageId: row.waMessageId }, select: { id: true } })
      if (ya) {
        await prisma.outboundMessage.update({ where: { id: row.id }, data: { messageId: ya.id, updatedAt: now } })
      } else {
        // El número de teléfono se recupera del lead para que el recibo (delivered/read)
        // pueda engancharse igual que en el camino normal: sin esto, un mensaje reconciliado
        // nunca recibiría sus recibos y la bandeja lo mostraría como "enviado" para siempre.
        let phoneNumberId = null
        if (row.leadId) {
          const canal = await prisma.channel.findFirst({
            where: { tenantId: row.tenantId, provider: 'cloud', activo: true, esDefault: true },
            select: { externalKey: true },
          })
          phoneNumberId = canal?.externalKey || null
        }
        const creado = await prisma.message.create({
          data: {
            leadId: row.leadId, origen: row.origen,
            texto: String(row.payload?.texto || '').slice(0, 4096) || '[mensaje enviado]',
            waMessageId: row.waMessageId, status: 'sent', statusAt: now, cloudPhoneNumberId: phoneNumberId,
          },
        })
        await prisma.outboundMessage.update({ where: { id: row.id }, data: { messageId: creado.id, updatedAt: now } })
      }
      reconciliados++
    } catch (err) {
      console.error(`[Outbox] no se pudo reconciliar ${row.id}:`, err.message)
    }
  }

  const colgados = await prisma.outboundMessage.findMany({
    where: { estado: ESTADO_SALIDA.SENDING, OR: [{ claimedAt: null }, { claimedAt: { lt: limite } }] },
    take: 50, select: { id: true, waMessageId: true, lastError: true },
  })
  for (const row of colgados) {
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        estado: row.waMessageId ? ESTADO_SALIDA.SENT : ESTADO_SALIDA.UNCERTAIN,
        lastError: row.lastError || 'el proceso se reinició con el envío en curso: resultado desconocido',
        claimId: null, claimedAt: null, updatedAt: now,
      },
    })
    if (!row.waMessageId) inciertos++
  }

  const pendientes = await prisma.outboundMessage.findMany({
    where: { estado: ESTADO_SALIDA.PENDING, claimId: null, attempts: { lt: MAX_INTENTOS } },
    orderBy: { createdAt: 'asc' }, take: 25,
    select: { id: true, tenantId: true, leadId: true, origen: true, tipo: true, payload: true, canalRef: true },
  })
  for (const row of pendientes) {
    if (!enviar) break
    const claim = await prisma.outboundMessage.updateMany({
      where: { id: row.id, estado: ESTADO_SALIDA.PENDING, claimId: null },
      data: { estado: ESTADO_SALIDA.SENDING, claimId: randomUUID(), claimedAt: now, updatedAt: now },
    })
    if (claim.count === 0) continue
    try {
      const r = await enviar(row)
      if (r?.ok) await confirmarEnvio(prisma, row.id, { resultado: r, mensajeData: { leadId: row.leadId, origen: row.origen, texto: row.payload?.texto }, tenantId: row.tenantId })
      else await marcarIncierto(prisma, row.id, { resultado: r })
      reenviados++
    } catch (err) {
      await marcarIncierto(prisma, row.id, { resultado: { error: err.message, errors: [] } })
    }
  }
  return { reconciliados, inciertos, reenviados }
}

/** Conteo para /ready y diagnóstico. */
export async function resumenOutbox(prisma) {
  const por = await prisma.outboundMessage.groupBy({ by: ['estado'], _count: { _all: true } })
  const mapa = Object.fromEntries(por.map(p => [p.estado, p._count._all]))
  return {
    PENDING: mapa.PENDING || 0,
    SENDING: mapa.SENDING || 0,
    SENT: mapa.SENT || 0,
    REJECTED: mapa.REJECTED || 0,
    UNCERTAIN: mapa.UNCERTAIN || 0,
  }
}

export const OUTBOX_VERSION = 'v1_intencion_durable_sin_exactly_once'