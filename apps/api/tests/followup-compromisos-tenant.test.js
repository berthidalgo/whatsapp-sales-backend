// Pruebas conductuales: cron real, BD y transporte sustituidos; ninguna API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import prisma from '../src/db/prisma.js'
import { ejecutarRecordatoriosCompromiso } from '../src/motor/followupEngine.js'

const TENANT = 'tenant-prueba'
const lead = (campaign, tenantId = TENANT) => ({ id: 41, tenantId, campaign })
const propia = { tenantId: TENANT, nombre: 'CursoPropio', config: {
  agente: { nombreProducto: 'ProductoPropio' },
  followups: { compromiso: 'Hola {{nombre}}, recordatorio de {{producto}}.' }
} }

function simular(t, { filas, fallaLectura = false }) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T17:00:00Z') })
  const previas = Object.fromEntries(['EVOLUTION_API_URL', 'EVOLUTION_API_KEY'].map(k => [k, process.env[k]]))
  process.env.EVOLUTION_API_URL = 'http://127.0.0.1:1/evolution-ficticia'
  process.env.EVOLUTION_API_KEY = 'solo-test-offline'
  t.after(() => {
    for (const [k, valor] of Object.entries(previas)) {
      if (valor === undefined) delete process.env[k]
      else process.env[k] = valor
    }
  })
  const candidato = { commitment_id: '00000000-0000-0000-0000-000000000001', leadId: 41,
    tenantId: TENANT, telefono: '51900000000', nombre: 'Ana Pérez' }
  const consulta = t.mock.method(prisma, '$queryRawUnsafe', async () => [candidato])
  // Los delegates Prisma son proxies; sustituirlos evita conectar la BD.
  const delegates = { lead: prisma.lead, channel: prisma.channel, message: prisma.message }
  t.after(() => { Object.assign(prisma, delegates) })
  prisma.lead = { findMany: t.mock.fn(async () => {
    if (fallaLectura) throw new Error('lectura ficticia fallida')
    return filas
  }) }
  const canal = t.mock.fn(async ({ where }) => ({
    id: 'canal-test', tenantId: where.tenantId, provider: 'evolution', externalKey: 'instancia-test'
  }))
  prisma.channel = { findFirst: canal }
  const marcas = t.mock.method(prisma, '$executeRaw', async () => 1)
  const mensajes = t.mock.fn(async ({ data }) => ({ id: 1, ...data }))
  prisma.message = { create: mensajes }
  const envios = []
  t.mock.method(globalThis, 'fetch', async (url, opciones) => {
    assert.equal(url, 'http://127.0.0.1:1/evolution-ficticia/message/sendText/instancia-test')
    envios.push(JSON.parse(opciones.body))
    return { ok: true, status: 200, json: async () => ({ key: { id: 'envio-ficticio' }, status: 'PENDING' }) }
  })
  return { consulta, canal, marcas, mensajes, envios }
}

for (const caso of [
  { nombre: 'campaña propia conserva el recordatorio comercial', filas: [lead(propia)], envia: true, personalizado: true },
  { nombre: 'lead sin campaña conserva el recordatorio neutro', filas: [lead(null)], envia: true },
  { nombre: 'campaña de otro tenant bloquea el recordatorio', filas: [lead({ ...propia, tenantId: 'tenant-ajeno' })] },
  { nombre: 'tenant del lead cambiado entre consultas bloquea el recordatorio', filas: [lead(null, 'tenant-ajeno')] },
  { nombre: 'lead no resuelto bloquea el recordatorio', filas: [] },
  { nombre: 'relación de campaña no resuelta bloquea el recordatorio', filas: [lead(undefined)] },
  { nombre: 'lead sin tenant bloquea el recordatorio', filas: [lead(null, null)] },
  { nombre: 'fallo de lectura comercial bloquea el recordatorio', fallaLectura: true }
]) {
  test('compromisos tenant: ' + caso.nombre, async (t) => {
    const fake = simular(t, caso)
    const resultado = await ejecutarRecordatoriosCompromiso()
    assert.equal(fake.consulta.mock.callCount(), 1, 'se ejecuta el cron, no una réplica de la guarda')
    assert.equal(resultado.ok, true)
    assert.equal(resultado.enviados, caso.envia ? 1 : 0)
    assert.equal(resultado.errores, 0)
    assert.equal(fake.envios.length, caso.envia ? 1 : 0)
    assert.equal(fake.canal.mock.callCount(), caso.envia ? 1 : 0)
    assert.equal(fake.marcas.mock.callCount(), caso.envia ? 1 : 0)
    assert.equal(fake.mensajes.mock.callCount(), caso.envia ? 1 : 0)
    if (caso.envia) {
      assert.equal(fake.envios[0].number, '51900000000')
      const texto = fake.envios[0].text
      assert.match(texto, /Ana/)
      if (caso.personalizado) assert.equal(texto, 'Hola Ana, recordatorio de ProductoPropio.')
      else assert.doesNotMatch(texto, /ProductoPropio|CursoPropio|tenant-ajeno/)
      assert.equal(fake.mensajes.mock.calls[0].arguments[0].data.texto, texto)
    }
  })
}
