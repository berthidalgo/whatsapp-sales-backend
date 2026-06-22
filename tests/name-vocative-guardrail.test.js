// tests/name-vocative-guardrail.test.js — Guardrail 3 del nombre (limpiarVocativoNombre)
// Quita el vocativo ", Nombre" que Gemini mete en CADA mensaje (tic telemarketing).
// BUG cazado en el test en vivo de Blanca (2026-06-22): el slot guardaba el nombre
// COMPLETO ("Blanca Hidalgo Tacas") → el regex buscaba ese vocativo completo, que el
// bot nunca usa (solo el primer nombre) → no limpiaba (Blanca salió 5/9 vs Oscar 1/17).
// Fix: usar SOLO el primer token del nombre.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { limpiarVocativoNombre } from '../src/brain/agent-brain.js'

test('nombre simple: quita el vocativo ", Oscar"', () => {
  const r = limpiarVocativoNombre('¡Mucho gusto, Oscar! Ahora cuéntame.', 'Oscar')
  assert.equal(r.limpiado, true)
  assert.ok(!/Oscar/.test(r.mensaje), 'no debe quedar "Oscar"')
})

test('REGRESIÓN bug de Blanca: nombre COMPLETO en el slot → usa el primer token', () => {
  const r = limpiarVocativoNombre('¡Claro que sí, Blanca! Disculpa.', 'Blanca Hidalgo Tacas')
  assert.equal(r.limpiado, true)
  assert.ok(!/Blanca/.test(r.mensaje), 'debe quitar "Blanca" aunque el slot tenga el nombre completo')
})

test('vocativo al inicio "Blanca, ..." también se limpia', () => {
  const r = limpiarVocativoNombre('Blanca, te cuento del programa.', 'Blanca')
  assert.equal(r.limpiado, true)
  assert.ok(!/^Blanca,/.test(r.mensaje))
})

test('turno que RECIÉN aprende el nombre (nombreConocido vacío) → NO toca (conserva la bienvenida)', () => {
  const r = limpiarVocativoNombre('¡Un gusto, Oscar!', '')
  assert.equal(r.limpiado, false)
  assert.equal(r.mensaje, '¡Un gusto, Oscar!')
})

test('nombre como sustantivo (sin coma vocativa) NO se sobre-limpia', () => {
  const r = limpiarVocativoNombre('El producto de Oscar tiene potencial.', 'Oscar')
  assert.equal(r.mensaje, 'El producto de Oscar tiene potencial.')
})
