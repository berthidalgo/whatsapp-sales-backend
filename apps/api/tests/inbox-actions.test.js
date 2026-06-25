import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modoValido, puedeReasignar, esEtiquetaValida } from '../src/api/inbox-actions.js'

test('modoValido: acepta HUMAN_ACTIVE y AUTO_CONSULTIVO, rechaza lo demás', () => {
  assert.equal(modoValido('HUMAN_ACTIVE'), true)
  assert.equal(modoValido('AUTO_CONSULTIVO'), true)
  assert.equal(modoValido('PAUSED'), false)   // terminal del cerebro, no toggle del CRM
  assert.equal(modoValido('xyz'), false)
  assert.equal(modoValido(undefined), false)
})

test('puedeReasignar: solo ADMIN/SUPERVISOR', () => {
  assert.equal(puedeReasignar({ role: 'ADMIN' }), true)
  assert.equal(puedeReasignar({ role: 'SUPERVISOR' }), true)
  assert.equal(puedeReasignar({ role: 'VENDOR' }), false)
  assert.equal(puedeReasignar(null), false)
})

test('esEtiquetaValida: acepta la taxonomía y el limpiado, rechaza lo inventado', () => {
  assert.equal(esEtiquetaValida('Caliente'), true)
  assert.equal(esEtiquetaValida('Pagó'), true)
  assert.equal(esEtiquetaValida(null), true)        // limpiar la etiqueta
  assert.equal(esEtiquetaValida(''), true)          // limpiar la etiqueta
  assert.equal(esEtiquetaValida('caliente'), false) // case-sensitive: no es del set
  assert.equal(esEtiquetaValida('VIP'), false)      // fuera de la taxonomía
  assert.equal(esEtiquetaValida(123), false)
})
