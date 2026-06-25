import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeLeadListItem, serializeLeadDetail } from '../src/api/inbox.js'

const leadBase = {
  id: 42, telefono: '51999', nombreDetectado: 'María', productoDetectado: null,
  updatedAt: new Date('2026-06-23T10:00:00Z'), createdAt: new Date('2026-06-20T10:00:00Z'),
  vendor: { nombre: 'Cristina' },
  leadState: {
    currentStage: 'objection', currentMode: 'HUMAN_ACTIVE', returningLeadFlag: false,
    label: 'Caliente',
    lastMessageAt: new Date('2026-06-23T09:00:00Z'),
    slotsFilled: {
      nombre: 'María', producto: 'palta', objecion: 'precio',
      _cierre: { ofertas_llamada: 2, objeciones_trabajadas: ['precio'] },
    },
  },
  mensajes: [{ texto: 'me parece caro', origen: 'LEAD', createdAt: new Date('2026-06-23T09:05:00Z') }],
}

test('serializeLeadListItem mapea lead_state → contrato', () => {
  const r = serializeLeadListItem(leadBase)
  assert.equal(r.id, 42)
  assert.equal(r.nombre, 'María')
  assert.equal(r.producto, 'palta')        // cae a slots.producto
  assert.equal(r.stage, 'objection')
  assert.equal(r.mode, 'HUMAN_ACTIVE')
  assert.equal(r.objecion, 'precio')
  assert.equal(r.ultimoMensaje, 'me parece caro')
  assert.equal(r.ultimoOrigen, 'LEAD')
  assert.equal(r.vendedor, 'Cristina')
  assert.equal(r.label, 'Caliente')        // etiqueta manual del vendedor
})

test('serializeLeadDetail expone slots SIN claves internas y resume _cierre', () => {
  const r = serializeLeadDetail(leadBase)
  assert.equal(r.stage, 'objection')
  assert.ok(!('_cierre' in r.slots), '_cierre no debe filtrarse en slots')
  assert.equal(r.slots.producto, 'palta')
  assert.match(r.cierreResumen, /2 ofertas de llamada/)
  assert.match(r.cierreResumen, /precio/)
  assert.equal(r.label, 'Caliente')
})

test('serializers no crashean con lead_state ausente', () => {
  const r = serializeLeadListItem({ id: 1, telefono: '519', mensajes: [], leadState: null })
  assert.equal(r.stage, 'first_contact')
  assert.equal(r.mode, 'AUTO_CONSULTIVO')
  assert.equal(r.nombre, '519')
  assert.equal(r.label, null)              // sin lead_state → label null, no crash
})
