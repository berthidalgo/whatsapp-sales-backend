// tests/hito-a-postgres.test.js — A1/A2/A3 contra PostgreSQL de verdad.
//
// Sin esta suite, la durabilidad sería una intención: los estados, el reclamo atómico y el
// índice único existen en el código pero podrían no funcionar contra la base real. Aquí se
// comprueban las cuatro promesas del Hito A:
//
//   1. Un reinicio tras la recepción NO pierde el mensaje (lo PENDING sigue ahí y se recupera).
//   2. Un replay NO duplica historial ni respuesta (índice único + estados terminales).
//   3. Un fallo de BD NO confirma trabajo sin guardar (la fila no aparece y el llamador falla).
//   4. La salida nunca se marca enviada si no se envió, y nunca se duplica por reintento.
//
// Requiere CRM_TEST_DATABASE_URL local explícita; sin ella se omite (ver offline-guard).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { loadContract, prepareDatabase } from '../scripts/db-readiness-lib.js'
import {
  registrarEntrada, cerrarEntradas, reencolarEntrada, recuperarEntradas,
  reclamarTurnoDeLead, hayEntradaPendiente, leadsListosParaTurno, textoDelGrupo,
  actualizarEntrada, ESTADO,
} from '../src/webhook/inbox.js'
import {
  registrarIntencion, confirmarEnvio, marcarRechazado, marcarIncierto,
  recuperarOutbox, ESTADO_SALIDA, clasificarEnvio,
} from '../src/whatsapp/outbox.js'
import { confirmarTurno, descartarTurno, slotsAportadosPorLead, consumioModelo } from '../src/brain/brain-pipeline.js'

const url = process.env.CRM_TEST_DATABASE_URL
const activo = !!url && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)

// Este archivo es integración real: entra en la suite de PostgreSQL, no en la offline.
const esPostgres = process.env.RUN_POSTGRES_TESTS === '1'

test('Hito A sobre PostgreSQL real: entrada y salida durables', { skip: !activo || !esPostgres, timeout: 120000 }, async t => {
  const base = new URL(url)
  const nombre = `crm_hitoa_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  let db
  try {
    await admin.query(`CREATE DATABASE "${nombre}"`)
    const u = new URL(base); u.pathname = '/' + nombre
    const client = new pg.Client({ connectionString: u.toString() }); await client.connect()
    await prepareDatabase(client, loadContract(), { apply: true })
    await client.end()
    db = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await db.$connect()

    await db.tenantSettings.create({ data: { tenantId: 'acme', displayName: 'Acme' } })
    const vendor = await db.vendor.create({ data: { tenantId: 'acme', nombre: 'V', telefono: '1' } })
    const camp = await db.campaign.create({ data: { tenantId: 'acme', vendorId: vendor.id, slug: 'C', nombre: 'C', config: {} } })
    const lead = await db.lead.create({ data: { tenantId: 'acme', vendorId: vendor.id, campaignId: camp.id, telefono: '519' } })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: la entrada se guarda ANTES de procesarse y el replay no crea otra fila', async () => {
      const ahora = new Date()
      const a = await registrarEntrada(db, {
        tenantId: 'acme', provider: 'cloud', eventKey: 'wamid.entrada.1',
        phoneNumberId: 'phone-acme', payload: { messageId: 'wamid.entrada.1', text: 'hola', messageType: 'text' },
      })
      assert.equal(a.estado, 'nuevo')
      // Replay exacto del mismo evento (lo que hace Meta al no recibir respuesta).
      const b = await registrarEntrada(db, {
        tenantId: 'acme', provider: 'cloud', eventKey: 'wamid.entrada.1',
        phoneNumberId: 'phone-acme', payload: { messageId: 'wamid.entrada.1', text: 'hola', messageType: 'text' },
      })
      assert.equal(b.estado, 'duplicado')
      assert.equal(b.id, a.id)
      assert.equal(await db.inboundEvent.count({ where: { eventKey: 'wamid.entrada.1' } }), 1)

      // Y al ser una fila real, se puede reclamar, cerrar y NO volver a procesarse.
      await db.inboundEvent.update({ where: { id: a.id }, data: { leadId: lead.id, disponibleEn: new Date(Date.now() - 1000) } })
      const reclamadas = await reclamarTurnoDeLead(db, lead.id)
      assert.equal(reclamadas.length, 1)
      assert.equal(textoDelGrupo(reclamadas), 'hola', 'el turno lee lo que se guardó')
      await cerrarEntradas(db, [a.id], ESTADO.DONE)
      const otraVez = await reclamarTurnoDeLead(db, lead.id)
      assert.equal(otraVez.length, 0, 'una entrada DONE no se procesa de nuevo → no hay respuesta duplicada')
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: dos workers concurrentes no toman la misma entrada (reclamo atómico)', async () => {
      await db.inboundEvent.deleteMany({ where: { eventKey: { in: ['carrera.1', 'carrera.2'] } } })
      for (const k of ['carrera.1', 'carrera.2']) {
        await registrarEntrada(db, {
          tenantId: 'acme', provider: 'cloud', eventKey: k,
          payload: { text: k }, leadId: lead.id,
        }, { debounceMs: -1000 })   // ya vencida: lista para reclamar
      }
      const [uno, otro] = await Promise.all([reclamarTurnoDeLead(db, lead.id), reclamarTurnoDeLead(db, lead.id)])
      const total = uno.length + otro.length
      assert.equal(total, 2, 'cada fila la toma exactamente un worker')
      const ids = [...uno, ...otro].map(f => f.id)
      assert.equal(new Set(ids).size, 2, 'ninguna se reclamó dos veces')
      await db.inboundEvent.deleteMany({ where: { id: { in: ids } } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: reinicio — lo que quedó PROCESSING vuelve a PENDING y se recupera', async () => {
      await db.inboundEvent.deleteMany({ where: { eventKey: { startsWith: 'reinicio' } } })
      const { id } = await registrarEntrada(db, {
        tenantId: 'acme', provider: 'cloud', eventKey: 'reinicio.1', leadId: lead.id,
        payload: { text: 'mensaje que el proceso no terminó' },
      }, { debounceMs: -1000 })
      // El proceso "murió" con la fila tomada: PROCESSING y un reclamo viejo.
      await db.inboundEvent.update({
        where: { id },
        data: { estado: ESTADO.PROCESSING, claimId: 'proceso-muerto', claimedAt: new Date(Date.now() - 10 * 60 * 1000) },
      })
      const listos = await leadsListosParaTurno(db)
      assert.ok(!listos.some(l => l.leadId === lead.id), 'una fila PROCESSING no se ofrece como trabajo listo')

      const recuperacion = await recuperarEntradas(db)
      assert.equal(recuperacion.recuperadas >= 1, true, 'el reclamo caducado vuelve a la cola')
      const fila = await db.inboundEvent.findUnique({ where: { id } })
      assert.equal(fila.estado, ESTADO.PENDING)
      assert.equal(fila.claimId, null)
      assert.match(fila.lastError, /reclamo caducado/)
      // Queda programada con un backoff corto, no "para siempre": se procesará en el
      // siguiente barrido sin que nadie tenga que hacer nada (ni otro reinicio).
      const espera = fila.disponibleEn.getTime() - Date.now()
      assert.ok(espera > 0 && espera <= 60_000, `reintento_programado (en ${espera} ms), no perdido`)
      await db.inboundEvent.deleteMany({ where: { id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: fallo de escritura NO deja fila; la entrada no se confirma como guardada', async () => {
      // Sin `tenantSettings` para ese tenant, la FK de la bandeja revienta el insert: es el
      // "fallo de BD" del enunciado, y tiene que PROPAGARSE (no tragarse y devolver "ok").
      await assert.rejects(() => registrarEntrada(db, {
        tenantId: 'tenant-inexistente', provider: 'cloud', eventKey: 'perdida.1',
      }))
      assert.equal(await db.inboundEvent.count({ where: { eventKey: 'perdida.1' } }), 0)
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: hayEntradaPendiente invalida la respuesta que ya quedó obsoleta', async () => {
      // Se aísla el lead: si quedara otra entrada PENDING de pruebas anteriores, la
      // comprobación sería ambigua y el test podría pasar (o fallar) por el motivo errado.
      await db.inboundEvent.deleteMany({ where: { leadId: lead.id } })
      const { id } = await registrarEntrada(db, {
        tenantId: 'acme', provider: 'cloud', eventKey: 'obsoleta.1', leadId: lead.id, payload: { text: 'nuevo' },
      })
      assert.equal(await hayEntradaPendiente(db, lead.id), true, 'llegó algo nuevo: la respuesta en vuelo quedó obsoleta')
      await db.inboundEvent.update({ where: { id }, data: { estado: ESTADO.PROCESSING } })
      assert.equal(await hayEntradaPendiente(db, lead.id), false, 'lo ya reclamado no invalida el turno que lo está procesando')
      await db.inboundEvent.deleteMany({ where: { id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A1: los reintentos se agotan y la entrada FAILED conserva el motivo', async () => {
      await db.inboundEvent.deleteMany({ where: { eventKey: { startsWith: 'agotada' } } })
      const { id } = await registrarEntrada(db, { tenantId: 'acme', provider: 'cloud', eventKey: 'agotada.1' })
      for (let i = 0; i < 3; i++) await reencolarEntrada(db, id, { lastError: 'la BD no respondió' })
      const fila = await db.inboundEvent.findUnique({ where: { id } })
      assert.equal(fila.estado, ESTADO.FAILED)
      assert.match(fila.lastError, /la BD no respondió/, 'el motivo queda: no es un silencio')
      await db.inboundEvent.deleteMany({ where: { id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A2: la intención se persiste antes de enviar y el rechazo no se marca enviado', async () => {
      const box = await registrarIntencion(db, {
        tenantId: 'acme', leadId: lead.id, origen: 'BOT', tipo: 'text',
        payload: { texto: 'hola' }, canalRef: 'phone-acme',
      })
      assert.equal(box.estado, ESTADO_SALIDA.PENDING)
      const antes = await db.outboundMessage.count()
      // Meta rechaza (fuera de ventana): NO se persiste como enviado y NO se reintenta solo.
      const clase = clasificarEnvio({ ok: false, error: 'fuera_de_ventana_24h', status: 400, errorCode: 131047 })
      assert.equal(clase.clase, 'rechazado')
      await marcarRechazado(db, box.id, {
        resultado: { error: 'fuera_de_ventana_24h', errorCode: 131047, errors: ['dentro o fuera de la ventana'] },
        mensajeData: { leadId: lead.id, origen: 'BOT', texto: 'hola' },
      })
      const fila = await db.outboundMessage.findUnique({ where: { id: box.id } })
      assert.equal(fila.estado, ESTADO_SALIDA.REJECTED)
      assert.equal(fila.errorCode, 131047)
      assert.equal(fila.waMessageId, null, 'un rechazo no tiene wamid: no hubo envío')
      // En el historial tampoco dice 'sent': dice que no se entregó, con su motivo.
      const msg = await db.message.findFirst({ where: { leadId: lead.id, texto: 'hola' }, orderBy: { id: 'desc' } })
      assert.equal(msg.status, 'failed')
      assert.equal(msg.waMessageId, null)
      assert.equal(await db.outboundMessage.count(), antes, 'no se crean filas extra')
      await db.message.deleteMany({ where: { id: msg.id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A2: aceptación de Meta seguida de fallo de BD NO se reenvía, se reconcilia', async () => {
      const box = await registrarIntencion(db, {
        tenantId: 'acme', leadId: lead.id, origen: 'BOT', payload: { texto: 'mensaje aceptado' },
      })
      // Meta aceptó y la outbox se marca SENT, pero el insert del historial falla (BD caída).
      await db.outboundMessage.update({
        where: { id: box.id },
        data: { estado: ESTADO_SALIDA.SENT, waMessageId: 'wamid.aceptado.1', messageId: null },
      })
      assert.equal(await db.message.count({ where: { waMessageId: 'wamid.aceptado.1' } }), 0)

      const r = await recuperarOutbox(db)
      assert.ok(r.reconciliados >= 1, 'la recuperación crea el historial faltante por wamid')
      const msg = await db.message.findFirst({ where: { waMessageId: 'wamid.aceptado.1' } })
      assert.ok(msg, 'el mensaje aceptado por Meta queda en el historial')
      assert.equal(msg.status, 'sent')
      assert.equal(msg.texto, 'mensaje aceptado')
      const fila = await db.outboundMessage.findUnique({ where: { id: box.id } })
      assert.equal(fila.messageId, msg.id)
      assert.equal(fila.estado, ESTADO_SALIDA.SENT, 'y NO vuelve a PENDING: no se reenvía')

      // Segunda pasada: idempotente (el wamid es único, no se duplica).
      await recuperarOutbox(db)
      assert.equal(await db.message.count({ where: { waMessageId: 'wamid.aceptado.1' } }), 1)
      await db.message.deleteMany({ where: { id: msg.id } })
      await db.outboundMessage.deleteMany({ where: { id: box.id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A2: un envío en curso al reiniciar queda INCIERTO, nunca se reenvía solo', async () => {
      const box = await registrarIntencion(db, {
        tenantId: 'acme', leadId: lead.id, origen: 'BOT', payload: { texto: '¿salió o no?' },
      })
      await db.outboundMessage.update({
        where: { id: box.id },
        data: {
          estado: ESTADO_SALIDA.SENDING, claimId: 'proceso-muerto',
          claimedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      })
      const r = await recuperarOutbox(db, { enviar: async () => { throw new Error('NUNCA debe reenviar un incierto') } })
      const fila = await db.outboundMessage.findUnique({ where: { id: box.id } })
      assert.equal(fila.estado, ESTADO_SALIDA.UNCERTAIN, 'queda visible para resolución controlada')
      assert.match(fila.lastError, /resultado desconocido/)
      assert.equal(r.reenviados, 0)
      await db.outboundMessage.deleteMany({ where: { id: box.id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A2: envío aceptado y confirmado deja SENT + historial, con su recibo', async () => {
      const box = await registrarIntencion(db, {
        tenantId: 'acme', leadId: lead.id, origen: 'BOT', payload: { texto: 'ok' }, canalRef: 'phone-acme',
      })
      const r = await confirmarEnvio(db, box.id, {
        resultado: { ok: true, messageId: 'wamid.ok.1', provider: 'cloud', phoneNumberId: 'phone-acme' },
        mensajeData: { leadId: lead.id, origen: 'BOT', texto: 'ok' },
        canal: { provider: 'cloud', externalKey: 'phone-acme', tenantId: 'acme', credenciales: { phoneNumberId: 'phone-acme' } },
        tenantId: 'acme',
      })
      assert.equal(r.historialGuardado, true)
      const fila = await db.outboundMessage.findUnique({ where: { id: box.id } })
      assert.equal(fila.estado, ESTADO_SALIDA.SENT)
      assert.equal(fila.waMessageId, 'wamid.ok.1')
      const msg = await db.message.findFirst({ where: { waMessageId: 'wamid.ok.1' } })
      assert.equal(msg.status, 'sent')
      assert.equal(msg.cloudPhoneNumberId, 'phone-acme')
      await db.message.deleteMany({ where: { id: msg.id } })
      await db.outboundMessage.deleteMany({ where: { id: box.id } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A3: los hechos del lead se guardan; el avance espera al envío', async () => {
      await db.leadState.upsert({
        where: { leadId: lead.id },
        create: { leadId: lead.id, currentStage: 'first_contact', slotsFilled: {} },
        update: { slotsFilled: {}, turnoPendiente: null },
      })
      const slots = { nombre: 'Rosa', distrito: 'Surco', producto: 'Pack 3', _canal_contacto: 'llamada', _cierre: { ofertas_llamada: 1 } }
      const delLead = slotsAportadosPorLead(slots)
      assert.deepEqual(delLead, { nombre: 'Rosa', distrito: 'Surco', producto: 'Pack 3' })
      assert.equal('_canal_contacto' in delLead, false, 'lo que derivó el bot no es un hecho del lead')
      assert.equal('_cierre' in delLead, false)

      const turnoId = randomBytes(8).toString('hex')
      await db.leadState.update({
        where: { leadId: lead.id },
        data: {
          currentStage: 'first_contact',            // NO avanza todavía
          slotsFilled: delLead,
          turnoId,
          turnoPendiente: { turnoId, stage: 'call_scheduling', slots },
        },
      })
      const antes = await db.leadState.findUnique({ where: { leadId: lead.id } })
      assert.equal(antes.currentStage, 'first_contact', 'el avance comercial espera a que el cliente reciba el mensaje')
      assert.equal(antes.slotsFilled.nombre, 'Rosa', 'pero lo que dijo el lead ya está')

      // El turno se descarta (respuesta obsoleta, takeover o envío rechazado): los hechos
      // siguen y el avance no existe.
      await descartarTurno(db, lead.id, turnoId)
      const trasDescarte = await db.leadState.findUnique({ where: { leadId: lead.id } })
      assert.equal(trasDescarte.turnoPendiente, null)
      assert.equal(trasDescarte.currentStage, 'first_contact', 'NO hay venta/llamada fantasma')
      assert.equal(trasDescarte.slotsFilled.nombre, 'Rosa', 'el nombre que dijo el cliente no se pierde')
      assert.equal(trasDescarte.slotsFilled.distrito, 'Surco')
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A3: confirmado, el avance se aplica; un turno viejo NO pisa el nuevo', async () => {
      const viejo = 'turno-viejo'
      await db.leadState.update({
        where: { leadId: lead.id },
        data: { turnoId: viejo, currentStage: 'first_contact', turnoPendiente: { turnoId: viejo, stage: 'call_scheduling', slots: { nombre: 'Rosa' } } },
      })
      assert.equal((await confirmarTurno(db, lead.id, viejo)).confirmado, true)
      assert.equal((await db.leadState.findUnique({ where: { leadId: lead.id } })).currentStage, 'call_scheduling')

      const nuevo = 'turno-nuevo'
      await db.leadState.update({
        where: { leadId: lead.id },
        data: { turnoId: nuevo, turnoPendiente: { turnoId: nuevo, stage: 'call_confirmed', slots: {} } },
      })
      // El turno viejo termina tarde: su turnoId ya no es el vigente → no escribe nada.
      const r = await confirmarTurno(db, lead.id, viejo)
      assert.equal(r.confirmado, false)
      assert.equal(r.motivo, 'turno_superado')
      assert.equal((await db.leadState.findUnique({ where: { leadId: lead.id } })).currentStage, 'call_scheduling',
        'una respuesta obsoleta no degrada ni avanza el estado de otro turno')
      // Y un descarte tardío tampoco pisa el turno nuevo.
      await descartarTurno(db, lead.id, viejo)
      assert.ok((await db.leadState.findUnique({ where: { leadId: lead.id } })).turnoPendiente, 'el turno vigente sigue pendiente')
      await db.leadState.update({ where: { leadId: lead.id }, data: { turnoPendiente: null, currentStage: 'first_contact' } })
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A4: un turno resuelto por regla NO se cuenta como consumo de IA', () => {
      assert.equal(consumioModelo({ audit: { proveedor: 'regla', tokens: 0, cost_usd: 0 } }), false)
      assert.equal(consumioModelo({ audit: { proveedor: 'openrouter:poolside/laguna-s-2.1', tokens: 900 } }), true)
      assert.equal(consumioModelo({ audit: { proveedor: 'vertex' } }), true)
      assert.equal(consumioModelo({}), false)
      assert.equal(consumioModelo(null), false)
    })

    // ─────────────────────────────────────────────────────────────────────
    await t.test('A5: la entrada y la salida nunca cruzan tenants', async () => {
      await db.tenantSettings.create({ data: { tenantId: 'otro', displayName: 'Otro' } })
      const v2 = await db.vendor.create({ data: { tenantId: 'otro', nombre: 'V2', telefono: '9' } })
      const c2 = await db.campaign.create({ data: { tenantId: 'otro', vendorId: v2.id, slug: 'X', nombre: 'X' } })
      const leadAjeno = await db.lead.create({ data: { tenantId: 'otro', vendorId: v2.id, campaignId: c2.id, telefono: '520' } })
      // Una entrada de 'acme' apuntando al lead de 'otro' es exactamente la contaminación que
      // el gate de BD debe ver (db-readiness SCOPE_CHECKS lo comprueba en --verificar).
      const sucio = await db.inboundEvent.create({
        data: {
          tenantId: 'acme', provider: 'cloud', eventKey: 'contaminada.1', leadId: leadAjeno.id,
          disponibleEn: new Date(),
        },
      }).then(() => true).catch(() => false)
      // La FK solo comprueba que el lead exista, no el tenant: por eso existe el SCOPE_CHECK.
      assert.equal(sucio, true, 'el modelo por sí solo NO impide el cruce; lo detecta la verificación')
      const { readCatalog, checkTenantScope } = await import('../scripts/db-readiness-lib.js')
      const issues = await checkTenantScope(db.$queryRawUnsafe ? clientStub(db) : clientStub(db), ['inbound_events', 'leads'])
      assert.ok(issues.some(i => i.name === 'inbound_lead_tenant'), 'la verificación lo marca')
      await db.inboundEvent.deleteMany({ where: { id: sucio.id } })
      await db.lead.deleteMany({ where: { id: leadAjeno.id } })
      await db.campaign.deleteMany({ where: { id: c2.id } })
      await db.vendor.deleteMany({ where: { id: v2.id } })
      await db.tenantSettings.deleteMany({ where: { tenantId: 'otro' } })
      void readCatalog
    })
  } finally {
    if (db) await db.$disconnect()
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [nombre])
    await admin.query(`DROP DATABASE IF EXISTS "${nombre}"`)
    await admin.end()
  }
})

// Cliente mínimo para checkTenantScope (una función de consulta).
function clientStub(db) {
  return { query: async (sql) => ({ rows: await db.$queryRawUnsafe(sql) }) }
}