// src/webhook/inbox.js — BANDEJA DE ENTRADA DURABLE (Hito A1)
//
// EL AGUJERO QUE CIERRA. Antes de este módulo el webhook de Meta contestaba 200 y después
// trabajó todo en memoria: debounce con setTimeout, marca de idempotencia en un Map y locks
// por lead en un Set. Si el proceso se reiniciaba (deploy, caída, Render durmiendo) en ese
// hueco, el mensaje se perdía SIN RASTRO: nadie se enteró, ni el lead ni el vendedor, y
// Meta lo daba por recibido. Al revés, si la caída venía después del 200 pero antes de
// terminar, el reintento de Meta reprocesaba el mismo mensaje.
//
// AQUÍ:
//   1. La entrada AUTENTICADA y RUTEADA (ya con su tenant, resuelta por el canal) se
//      escribe en PostgreSQL ANTES de responder. Si esa escritura falla, el webhook
//      devuelve error y Meta reintenta: nunca se confirma trabajo que no quedó guardado.
//   2. La identidad del evento es estable (tenant + provider + eventKey, único en BD), así
//      que un replay del mismo wamid NO crea una segunda fila ni duplica historial o
//      respuesta. El Map en memoria sigue como filtro rápido, pero ya no es la garantía.
//   3. El agrupado de ráfagas pasa a ser una COLUMNA (`disponibleEn` = ahora + 6 s), no un
//      timer en memoria. Después de un reinicio el mismo criterio sigue agrupando.
//   4. Estados explícitos (PENDING/PROCESSING/DONE/DISCARDED/FAILED) con reintentos
//      acotados y recuperación: al arrancar, lo que quedó PROCESSING con un reclamo
//      caducado vuelve a PENDING.
//   5. La coordinación por lead se hace con un reclamo atómico en la propia tabla
//      (UPDATE ... WHERE estado='PENDING' ... FOR UPDATE SKIP LOCKED RETURNING), no con un
//      Set en memoria: dos procesos no pueden procesar el mismo turno.

import { randomUUID } from 'node:crypto'
import { enqueueMessage } from './debounce.js'

export const DEBOUNCE_WINDOW_MS = 6000
export const MAX_ATTEMPTS = 3
// Un reclamo se considera muerto si el proceso que lo tomó no lo terminó. 5 minutos cubre
// un turno completo (descarga de media + cerebro + envío) con holgura.
export const CLAIM_TTL_MS = 5 * 60 * 1000

export const ESTADO = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  DISCARDED: 'DISCARDED',
  FAILED: 'FAILED',
}

/**
 * Registra una entrada ya autenticada y ruteada. Idempotente por (tenant, provider, eventKey).
 * @returns {{ id: string|null, estado: 'nuevo'|'duplicado', disponibleEn: Date }}
 */
export async function registrarEntrada(prisma, {
  tenantId, provider = 'cloud', eventKey, tipo = 'message', phoneNumberId = null, payload = {}, leadId = null,
}, { now = new Date(), debounceMs = DEBOUNCE_WINDOW_MS } = {}) {
  if (!tenantId) throw Object.assign(new Error('tenant requerido para la bandeja'), { code: 'INBOX_TENANT_REQUIRED' })
  if (!eventKey) throw Object.assign(new Error('eventKey requerido para la bandeja'), { code: 'INBOX_EVENT_KEY_REQUIRED' })
  const disponibleEn = new Date(now.getTime() + debounceMs)
  try {
    const fila = await prisma.inboundEvent.create({
      data: { tenantId, provider, eventKey, tipo, phoneNumberId, payload, leadId, disponibleEn },
      select: { id: true, estado: true, disponibleEn: true },
    })
    return { id: fila.id, estado: 'nuevo', disponibleEn: fila.disponibleEn }
  } catch (err) {
    // Conflicto de unicidad = replay del mismo evento. La fila existente ES la verdad: se
    // devuelve tal cual y el llamador no la reprocesa (ni historial, ni respuesta).
    if (err?.code === 'P2002') {
      const ya = await prisma.inboundEvent.findUnique({
        where: { tenantId_provider_eventKey: { tenantId, provider, eventKey } },
        select: { id: true, estado: true, disponibleEn: true },
      })
      if (ya) return { id: ya.id, estado: 'duplicado', disponibleEn: ya.disponibleEn }
    }
    throw err
  }
}

/**
 * Reclama las entradas listas de UN lead de forma atómica. Dos workers concurrentes no
 * pueden obtener la misma fila: el `estado='PENDING'` con SKIP LOCKED lo garantiza en la
 * base, no en memoria. Devuelve el grupo en orden cronológico (la ráfaga combinada).
 */
export async function reclamarTurnoDeLead(prisma, leadId, { limit = 20, claimId = randomUUID(), now = new Date() } = {}) {
  return prisma.$queryRaw`
    UPDATE inbound_events
       SET estado = 'PROCESSING', claim_id = ${claimId}, claimed_at = ${now}, updated_at = ${now}
     WHERE id IN (
       SELECT id FROM inbound_events
        WHERE "leadId" = ${leadId}
          AND estado = 'PENDING'
          AND disponible_en <= ${now}
        ORDER BY disponible_en ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, event_key AS "eventKey", tipo, payload, disponible_en AS "disponibleEn",
              created_at AS "createdAt", phone_number_id AS "phoneNumberId", provider
  `
}

/** Marca un grupo de entradas como procesadas (o descartadas, con su motivo). */
export async function cerrarEntradas(prisma, ids, estado = ESTADO.DONE, { lastError = null } = {}) {
  const unicos = [...new Set((ids || []).filter(Boolean))]
  if (!unicos.length) return { count: 0 }
  const r = await prisma.inboundEvent.updateMany({
    where: { id: { in: unicos }, estado: ESTADO.PROCESSING },
    data: { estado, processedAt: new Date(), lastError, updatedAt: new Date() },
  })
  return { count: r.count }
}

/**
 * Reintento acotado: vuelve a PENDING con backoff si le quedan intentos; si los agotó,
 * FAILED. Se usa cuando el procesamiento falló por algo recuperable (BD caída un segundo,
 * lead momentáneamente no resoluble) — no cuando la entrada ya no tiene sentido.
 */
export async function reencolarEntrada(prisma, id, { lastError, maxAttempts = MAX_ATTEMPTS, now = new Date() } = {}) {
  const fila = await prisma.inboundEvent.findUnique({ where: { id }, select: { attempts: true, estado: true } })
  if (!fila || fila.estado === ESTADO.DONE || fila.estado === ESTADO.DISCARDED) {
    return { reencolada: false, estado: fila?.estado || null }
  }
  const attempts = fila.attempts + 1
  const base = { attempts, lastError: String(lastError || '').slice(0, 500), claimId: null, claimedAt: null, updatedAt: now }
  if (attempts >= maxAttempts) {
    await prisma.inboundEvent.update({ where: { id }, data: { ...base, estado: ESTADO.FAILED } })
    return { reencolada: false, estado: ESTADO.FAILED, attempts }
  }
  // Backoff 2^n acotado. Sin esto, un proveedor caído se reintenta en bucle cerrado.
  await prisma.inboundEvent.update({
    where: { id },
    data: { ...base, estado: ESTADO.PENDING, disponibleEn: new Date(now.getTime() + Math.min(2 ** attempts * 1000, 60_000)) },
  })
  return { reencolada: true, estado: ESTADO.PENDING, attempts }
}

/**
 * Recuperación tras reinicio. Una fila PROCESSING cuyo reclamo caducó pertenece a un proceso
 * que ya no existe: vuelve a PENDING (o FAILED si agotó intentos). Sin esto, una caída a
 * mitad de turno dejaba el mensaje en PROCESSING para siempre — peor que perderlo, porque
 * además quedaba invisible.
 */
export async function recuperarEntradas(prisma, { claimTtlMs = CLAIM_TTL_MS, now = new Date(), maxAttempts = MAX_ATTEMPTS } = {}) {
  const limite = new Date(now.getTime() - claimTtlMs)
  const huerfanas = await prisma.inboundEvent.findMany({
    where: { estado: ESTADO.PROCESSING, OR: [{ claimedAt: null }, { claimedAt: { lt: limite } }] },
    orderBy: { claimedAt: 'asc' },
    take: 100,
    select: { id: true, attempts: true },
  })
  let recuperadas = 0, agotadas = 0
  for (const h of huerfanas) {
    const r = await reencolarEntrada(prisma, h.id, {
      lastError: 'reclamo caducado: el proceso que lo tomó no terminó (reinicio)', maxAttempts, now,
    })
    if (r.reencolada) recuperadas++
    else if (r.estado === ESTADO.FAILED) agotadas++
  }
  return { revisadas: huerfanas.length, recuperadas, agotadas }
}

/** Conteo para /ready y para el log de arranque: hay trabajo sin procesar. */
export async function pendientesDeInbox(prisma) {
  const por = await prisma.inboundEvent.groupBy({ by: ['estado'], _count: { _all: true } })
  const mapa = Object.fromEntries(por.map(p => [p.estado, p._count._all]))
  return {
    PENDING: mapa.PENDING || 0,
    PROCESSING: mapa.PROCESSING || 0,
    FAILED: mapa.FAILED || 0,
    total: por.reduce((a, p) => a + p._count._all, 0),
  }
}

/** Textos combinados de un grupo, en orden. El turno lee la ráfaga completa. */
export function textoDelGrupo(filas) {
  return (filas || []).map(f => String(f?.payload?.text || '').trim()).filter(Boolean).join('\n')
}

/**
 * Actualiza una entrada ya guardada (enlace con su lead y/o el texto final a procesar).
 * Se usa para que la recuperación pueda retomar el turno SIN repetir lo caro: si la media
 * ya se bajó y el lead ya se resolvió, `payload.texto` viene puesto y solo falta agrupar.
 */
export async function actualizarEntrada(prisma, id, { leadId = undefined, payload = undefined } = {}) {
  if (!id) return { count: 0 }
  return prisma.inboundEvent.updateMany({
    where: { id },
    data: {
      ...(leadId !== undefined ? { leadId } : {}),
      ...(payload !== undefined ? { payload } : {}),
      updatedAt: new Date(),
    },
  })
}

/** Marca entradas como descartadas (con motivo). Acepta ids o filas de la bandeja. */
export async function descartarEntradas(prisma, ids, motivo = 'descartado') {
  const unicos = [...new Set((ids || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean))]
  return cerrarEntradas(prisma, unicos, ESTADO.DISCARDED, { lastError: motivo })
}

/**
 * ¿Hay entradas del lead que el turno en vuelo todavía no tomó? Si las hay, su respuesta
 * quedó obsoleta (el lead siguió escribiendo) y debe descartarse sin enviar.
 *
 * Es el equivalente durable del "kill-stale" que antes vivía en un Map del proceso: las
 * filas ya reclamadas están en PROCESSING, así que no cuentan; solo las nuevas (PENDING).
 */
export async function hayEntradaPendiente(prisma, leadId, { now = new Date() } = {}) {
  if (!leadId) return false
  const n = await prisma.inboundEvent.count({
    where: { leadId, estado: ESTADO.PENDING, disponibleEn: { gt: now } },
  })
  return n > 0
}

/**
 * Leads con entradas PENDING cuya ráfaga ya venció (o sea, listas para turno). Es la
 * consulta que usa el barrido: no depende de ningún timer en memoria, así que después de
 * un reinicio encuentra exactamente el mismo trabajo pendiente.
 */
export async function leadsListosParaTurno(prisma, { now = new Date(), limite = 20 } = {}) {
  // El mínimo (más antiguo) por lead: es el orden en que hay que atender el trabajo. Con
  // DISTINCT, ORDER BY debe repetir la expresión proyectada (regla de Postgres).
  return prisma.$queryRaw`
    SELECT "leadId" AS "leadId", min(disponible_en) AS "primera"
      FROM inbound_events
     WHERE "leadId" IS NOT NULL
       AND estado = 'PENDING'
       AND disponible_en <= ${now}
       AND (claim_id IS NULL OR claimed_at IS NULL)
     GROUP BY "leadId"
     ORDER BY "primera" ASC
     LIMIT ${limite}
  `
}

/**
 * Extiende la ventana de ráfaga de un lead. Cada mensaje nuevo corre el reloj 6 s hacia
 * atrás: es el debounce, pero con la fecha en la fila. Si el proceso muere, el criterio
 * sigue siendo el mismo y el barrido agrupa igual.
 */
export async function extenderVentana(prisma, leadId, { debounceMs = DEBOUNCE_WINDOW_MS, now = new Date() } = {}) {
  const disponibleEn = new Date(now.getTime() + debounceMs)
  await prisma.inboundEvent.updateMany({
    where: { leadId, estado: ESTADO.PENDING },
    data: { disponibleEn, updatedAt: now },
  })
  return { disponibleEn }
}

/**
 * Encola la ráfaga del lead para que el turno corra cuando venza la ventana.
 *
 * El grouping sigue teniendo un temporizador en memoria (es lo que da la latencia de 6 s
 * sin consultas), pero la lista de mensajes que el turno procesa sale de la BANDEJA, no del
 * buffer: si el proceso se reinició, no hay buffer, pero sí filas PENDING. Por eso el
 * barrido de recuperación usa exactamente el mismo camino (`correrTurnoDesdeBandeja`) y no
 * puede inventarse un mensaje que la BD no tiene.
 */
export function programarTurno({ leadId, processFn, prisma: db, textos = [], metadata = {} }) {
  return enqueueMessage({
    leadId,
    text: textos.join('\n') || '(entrada sin texto)',
    metadata,
    processFn: (combinado, meta) => correrTurnoDesdeBandeja(db, leadId, processFn, { meta }),
  })
}

/**
 * Reclama la ráfaga vencida de un lead y ejecuta el turno con ESA información.
 *
* · Si no hay filas PENDING vencidas, no inventa nada: devuelve `sin_entradas`. Así una
 *   programación sobrante no produce un turno sin mensaje ni una respuesta duplicada.
 * · Si el turno lanza, las filas vuelven a PENDING con backoff acotado: el mensaje se
 *   reintentará, no se pierde.
 */
export async function correrTurnoDesdeBandeja(prisma, leadId, processFn, { meta = {} } = {}) {
  const filas = await reclamarTurnoDeLead(prisma, leadId)
  if (!filas.length) return { procesado: false, motivo: 'sin_entradas_pendientes' }
  const texto = textoDelGrupo(filas)
  try {
    await processFn(texto, {
      ...(meta || {}),
      messageCount: filas.length,
      individualMessages: filas.map(f => ({ text: f.payload?.text || '', timestamp: f.createdAt, metadata: f.payload })),
    })
    await cerrarEntradas(prisma, filas.map(f => f.id), ESTADO.DONE)
    return { procesado: true, entradas: filas.length }
  } catch (err) {
    // El turno falló: la ráfaga vuelve a la cola con reintentos acotados. Los datos que el
    // lead aportó ya están en el historial; esto es lo que permite reintentar sin perderlos.
    for (const f of filas) {
      await reencolarEntrada(prisma, f.id, { lastError: `turno fallido: ${err.message}` })
    }
    console.error(`[Inbox] lead ${leadId}: el turno falló (${err.message}); ${filas.length} entradas reencoladas`)
    return { procesado: false, motivo: 'turno_fallido', error: err.message }
  }
}

export const INBOX_VERSION = 'v1_bandeja_durable'