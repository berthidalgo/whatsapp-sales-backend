import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeWhere } from '../src/lib/auth-guard.js'

test('scopeWhere: VENDOR se acota a su tenant Y su vendorId', () => {
  const w = scopeWhere({ role: 'VENDOR', vendorId: 7, tenantId: 'peru_exporta' })
  assert.deepEqual(w, { tenantId: 'peru_exporta', vendorId: 7 })
})

test('scopeWhere: ADMIN ve todo su tenant (sin filtro de vendorId)', () => {
  const w = scopeWhere({ role: 'ADMIN', vendorId: 1, tenantId: 'peru_exporta' })
  assert.deepEqual(w, { tenantId: 'peru_exporta' })
})

test('scopeWhere: SUPERVISOR ve todo su tenant', () => {
  const w = scopeWhere({ role: 'SUPERVISOR', vendorId: 3, tenantId: 'acme' })
  assert.deepEqual(w, { tenantId: 'acme' })
})

test('scopeWhere: VENDOR sin vendorId no ve nada (fail-closed, vendorId=-1)', () => {
  const w = scopeWhere({ role: 'VENDOR', tenantId: 'peru_exporta' })
  assert.equal(w.vendorId, -1)
})

test('scopeWhere: usuario nulo → where vacío (no crashea)', () => {
  assert.deepEqual(scopeWhere(null), {})
})
