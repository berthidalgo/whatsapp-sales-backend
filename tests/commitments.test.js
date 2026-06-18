// tests/commitments.test.js — validez de compromisos fechados (motor de compromisos, Fase D)
// compromisoEsValido decide si un compromiso del cerebro se guarda: necesita fecha_iso
// parseable y a FUTURO (no fechar en el pasado ni con basura).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compromisoEsValido } from '../src/brain/brain-pipeline.js'

const AHORA = Date.parse('2026-06-17T12:00:00-05:00')

test('compromiso con fecha futura válida → true', () => {
  assert.equal(compromisoEsValido({ tipo: 'pago', fecha_iso: '2026-06-20T15:00:00-05:00' }, AHORA), true)
})

test('compromiso con fecha PASADA → false (no fechar atrás)', () => {
  assert.equal(compromisoEsValido({ fecha_iso: '2026-06-10T15:00:00-05:00' }, AHORA), false)
})

test('compromiso sin fecha_iso → false', () => {
  assert.equal(compromisoEsValido({ tipo: 'pago', descripcion: 'yapear' }, AHORA), false)
  assert.equal(compromisoEsValido({ fecha_iso: '' }, AHORA), false)
})

test('compromiso null / undefined → false (no rompe)', () => {
  assert.equal(compromisoEsValido(null, AHORA), false)
  assert.equal(compromisoEsValido(undefined, AHORA), false)
})

test('fecha_iso basura / no parseable → false', () => {
  assert.equal(compromisoEsValido({ fecha_iso: 'el viernes' }, AHORA), false)
  assert.equal(compromisoEsValido({ fecha_iso: 'mañana 3pm' }, AHORA), false)
})

test('exactamente ahora → false (no es a futuro)', () => {
  assert.equal(compromisoEsValido({ fecha_iso: '2026-06-17T12:00:00-05:00' }, AHORA), false)
})
