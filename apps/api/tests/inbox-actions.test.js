import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modoValido, puedeReasignar } from '../src/api/inbox-actions.js'

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
