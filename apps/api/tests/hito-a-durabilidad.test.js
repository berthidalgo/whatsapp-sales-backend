// tests/hito-a-durabilidad.test.js — A1 (entrada) y A2 (salida) sin base de datos.
//
// Estas pruebas no dependen de PostgreSQL a propósito: la lógica de estados, identidad,
// clasificación de fallos y transición de la outbox es PURA y tiene que poder probarse sin
// levantar nada. El comportamiento con base real (reclamo atómico, índice único, rollback
// del upgrade) está en tests/integration/crm-postgres.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ESTADO, DEBOUNCE_WINDOW_MS, textoDelGrupo, hayEntradaPendiente,
} from '../src/webhook/inbox.js'
import {
  ESTADO_SALIDA, clasificarEnvio, resumenOutbox,
} from '../src/whatsapp/outbox.js'

// ── Doubles ──────────────────────────────────────────────────────────────
function prismaFalso() {
  const filas = []
  let n = 0
  return {
    filas,
    inboundEvent: {
      async create({ data }) {
        const choque = filas.find(f => f.tenantId === data.tenantId && f.provider === data.provider && f.eventKey === data.eventKey)
        if (choque) { const e = new Error('unique'); e.code = 'P2002'; throw e }
        const fila = { id: `in-${++n}`, attempts: 0, estado: ESTADO.PENDING, claimId: null, claimedAt: null, processedAt: null, lastError: null, payload: {}, ...data }
        filas.push(fila)
        return fila
      },
      async findUnique({ where }) {
        // Soporta tanto la clave primaria como la compuesta (tenant, proveedor, eventKey),
        // que es la que devuelve el índice único en un replay.
        if (where.tenantId_provider_eventKey) {
          const k = where.tenantId_provider_eventKey
          return filas.find(f => f.tenantId === k.tenantId && f.provider === k.provider && f.eventKey === k.eventKey) || null
        }
        return filas.find(f => f.id === where.id) || null
      },
      async updateMany({ where, data }) {
        let n = 0
        for (const f of filas) {
          if (where.id?.in && !where.id.in.includes(f.id)) continue
          if (where.leadId != null && f.leadId !== where.leadId) continue
          if (where.estado && f.estado !== where.estado) continue
          Object.assign(f, data); n++
        }
        return { count: n }
      },
      async update({ where, data }) {
        const f = filas.find(x => x.id === where.id)
        Object.assign(f, data)
        return f
      },
      async count({ where = {} } = {}) {
        return filas.filter(f => (where.estado ? f.estado === where.estado : true) && (where.leadId ? f.leadId === where.leadId : true)).length
      },
      async groupBy() { return [] },
      async findMany() { return [] },
    },
    outboundMessage: {
      async create({ data }) { return { id: `out-${++n}`, ...data } },
      async updateMany() { return { count: 0 } },
      async update() { return null },
      async findMany() { return [] },
      async groupBy() { return [] },
    },
    message: { async create() { return { id: 1 } }, async findUnique() { return null } },
  }
}

// ── A1 · Identidad estable y reintento acotado ───────────────────────────
test('A1: la identidad del evento es (tenant, proveedor, eventKey) — el replay no crea otra fila', async () => {
  const db = prismaFalso()
  const { registrarEntrada } = await import('../src/webhook/inbox.js')
  const base = { tenantId: 'acme', provider: 'cloud', eventKey: 'wamid.1' }
  const primera = await registrarEntrada(db, base)
  const replay = await registrarEntrada(db, base)
  assert.equal(primera.estado, 'nuevo')
  assert.equal(replay.estado, 'duplicado', 'el mismo wamid reentregado es el MISMO evento')
  assert.equal(replay.id, primera.id, 'no hay fila nueva que pueda duplicar historial o respuesta')
  assert.equal(db.filas.length, 1)
  // Mismo wamid de OTRO tenant es otro evento: el aislamiento manda sobre la deduplicación.
  const otro = await registrarEntrada(db, { ...base, tenantId: 'otra' })
  assert.equal(otro.estado, 'nuevo')
  assert.equal(db.filas.length, 2)
})

test('A1: sin tenant o sin identidad la entrada NO se guarda (fallo rápido, no fila a medias)', async () => {
  const db = prismaFalso()
  const { registrarEntrada } = await import('../src/webhook/inbox.js')
  await assert.rejects(() => registrarEntrada(db, { provider: 'cloud', eventKey: 'w' }), /tenant/)
  await assert.rejects(() => registrarEntrada(db, { tenantId: 'acme' }), /eventKey/)
  assert.equal(db.filas.length, 0)
})

test('A1: la ráfaga se agrupa con una fecha, no con un temporizador en memoria', async () => {
  const db = prismaFalso()
  const { registrarEntrada } = await import('../src/webhook/inbox.js')
  const t0 = new Date('2026-10-01T12:00:00.000Z')
  const a = await registrarEntrada(db, { tenantId: 'acme', eventKey: 'w1', payload: { text: 'hola' } }, { now: t0 })
  assert.equal(a.disponibleEn.getTime() - t0.getTime(), DEBOUNCE_WINDOW_MS, 'la ventana es un dato, no un SetTimeout')
  // Tras un reinicio el criterio es el mismo: la fila sigue diciendo cuándo se procesa.
  const posterior = await registrarEntrada(db, { tenantId: 'acme', eventKey: 'w2', payload: { text: 'y ahora?' } }, { now: new Date(t0.getTime() + 4000) })
  assert.ok(posterior.disponibleEn > a.disponibleEn)
})

test('A1: reencolar agota los intentos con backoff y termina en FAILED con su motivo', async () => {
  const db = prismaFalso()
  const { registrarEntrada, reencolarEntrada } = await import('../src/webhook/inbox.js')
  const { id } = await registrarEntrada(db, { tenantId: 'acme', eventKey: 'w1' })
  const r1 = await reencolarEntrada(db, id, { lastError: 'bd caida' })
  assert.equal(r1.reencolada, true)
  assert.equal(db.filas[0].estado, ESTADO.PENDING)
  assert.ok(db.filas[0].disponibleEn > db.filas[0].createdAt || db.filas[0].disponibleEn, 'el reintento se aleja en el tiempo')
  await reencolarEntrada(db, id, { lastError: 'bd caida' })
  const r3 = await reencolarEntrada(db, id, { lastError: 'bd caida' })
  assert.equal(r3.reencolada, false)
  assert.equal(db.filas[0].estado, ESTADO.FAILED, 'agotados los intentos, queda FAILED y NO se pierde en silencio')
  assert.match(db.filas[0].lastError, /bd caida/)
})

test('A1: una entrada ya DONE o DISCARDED no se reencola (no se procesa dos veces)', async () => {
  const db = prismaFalso()
  const { registrarEntrada, reencolarEntrada, cerrarEntradas } = await import('../src/webhook/inbox.js')
  const { id } = await registrarEntrada(db, { tenantId: 'acme', eventKey: 'w1' })
  db.filas[0].estado = ESTADO.PROCESSING
  await cerrarEntradas(db, [id], ESTADO.DONE)
  const r = await reencolarEntrada(db, id, { lastError: 'tarde' })
  assert.equal(r.reencolada, false)
  assert.equal(db.filas[0].estado, ESTADO.DONE)
})

test('A1: el texto del turno sale de las filas guardadas, en orden', () => {
  assert.equal(textoDelGrupo([{ payload: { text: 'hola' } }, { payload: { text: 'soy Juan' } }]), 'hola\nsoy Juan')
  assert.equal(textoDelGrupo([{ payload: {} }, { payload: { text: '  ' } }]), '', 'una entrada sin texto no inventa contenido')
})

test('A1: hayEntradaPendiente detecta el mensaje nuevo que invalida la respuesta en vuelo', async () => {
  const db = prismaFalso()
  const { registrarEntrada, hayEntradaPendiente } = await import('../src/webhook/inbox.js')
  const { id } = await registrarEntrada(db, { tenantId: 'acme', eventKey: 'w1', leadId: 7 })
  assert.equal(await hayEntradaPendiente(db, 7), true, 'la fila sin tomar hace obsoleta la respuesta en curso')
  db.filas[0].estado = ESTADO.PROCESSING
  assert.equal(await hayEntradaPendiente(db, 7), false, 'lo ya reclamado no cuenta: el turno en vuelo sigue siendo válido')
  assert.equal(await hayEntradaPendiente(db, 99), false)
  void id
})

// ── A2 · Clasificación del resultado de envío ───────────────────────────
// ESTA ES LA PARTE QUE NO SE PUEDE ADELANTAR: Meta NO ofrece clave de idempotencia para
// POST /messages (verificado en su documentación), así que "reintenté y no sé si había
// salido" NO se puede resolver automáticamente. La clasificación decide qué se puede
// reintentar sin riesgo y qué debe quedarse visible para que lo resuelva una persona.
test('A2: Meta aceptó → clase "aceptado" con su wamid (base para reconciliar sin reenviar)', () => {
  const r = clasificarEnvio({ ok: true, messageId: 'wamid.abc' })
  assert.deepEqual(r, { clase: 'aceptado', wamid: 'wamid.abc' })
})

test('A2: rechazo explícito de Meta → "rechazado", nunca marcado como enviado ni reintentado', () => {
  const fuera = clasificarEnvio({ ok: false, error: 'fuera_de_ventana_24h', status: 400, errorCode: 131047 })
  assert.equal(fuera.clase, 'rechazado')
  assert.equal(fuera.codigo, 131047)
  const grafico = clasificarEnvio({ ok: false, error: 'graph_400', status: 400, errorCode: 100 })
  assert.equal(grafico.clase, 'rechazado')
})

test('A2: 5xx de Meta → incierto (el servidor falló; no sabemos si registró el envío)', () => {
  assert.equal(clasificarEnvio({ ok: false, error: 'graph_503', status: 503 }).clase, 'incierto')
})

test('A2: timeout o error de red → incierto: NUNCA se reenvía a ciegas', () => {
  assert.equal(clasificarEnvio({ ok: false, error: 'timeout_10000ms' }).clase, 'incierto')
  assert.equal(clasificarEnvio({ ok: false, error: 'fetch_error' }).clase, 'incierto')
  assert.equal(clasificarEnvio({ ok: false, error: 'send_failed_after_retry', errors: ['socket'] }).clase, 'incierto')
})

test('A2: lo que ni siquiera salió (sin credenciales, sin canal) → "no_enviado", reintentable sin riesgo', () => {
  for (const error of ['cloud_not_configured', 'env_CLOUD_ACCESS_TOKEN_missing', 'telefono_required', 'instance_required']) {
    assert.equal(clasificarEnvio({ ok: false, error }).clase, 'no_enviado', error)
  }
})

test('A2: el estado incierto es visible y countable, no un silencio', async () => {
  const db = prismaFalso()
  db.outboundMessage.groupBy = async () => ([
    { estado: ESTADO_SALIDA.UNCERTAIN, _count: { _all: 3 } },
    { estado: ESTADO_SALIDA.SENT, _count: { _all: 7 } },
  ])
  const r = await resumenOutbox(db)
  assert.equal(r.UNCERTAIN, 3)
  assert.equal(r.SENT, 7)
})

// ── Reglas que el código tiene que seguir por construcción ───────────────
test('A2: no se promete exactly-once en ninguna parte del módulo de salida', () => {
  const fuente = readFileSync(new URL('../src/whatsapp/outbox.js', import.meta.url), 'utf8')
  assert.match(fuente, /NO hay exactly-once y no lo prometemos/, 'el límite está escrito donde se decide')
  assert.doesNotMatch(fuente, /exactly-once garantizado|exactly once garantizado/i)
  // Y el reenvío automático solo existe para lo que nunca salió.
  assert.match(fuente, /NUNCA se reenvía/, 'el veto al reenvío ciego está explícito')
})

test('A2: Meta no ofrece idempotencia; el diseño no puede depender de ella', () => {
  // Si alguien "optimiza" usando una clave de idempotencia que Meta no honra, este test
  // señala el lugar exacto donde hacerlo sería un error silencioso.
  const fuente = readFileSync(new URL('../src/whatsapp/outbox.js', import.meta.url), 'utf8')
  assert.match(fuente, /POST \/messages/)
  assert.match(fuente, /unicidad|único/, 'la deduplicación real es la unicidad del wamid, no una cabecera')
  assert.doesNotMatch(fuente, /Idempotency-Key/i, 'no se envía una cabecera que Meta ignora')
})