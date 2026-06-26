import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsearDebrief, DEBRIEF_OUTCOMES } from '../src/brain/call-debrief.js'

test('parsearDebrief: normaliza outcome y acota campos', () => {
  const r = parsearDebrief('{"outcome":"pensándolo","objecion":"el precio","proximoPaso":"volver a llamar","fechaISO":"2026-06-26T15:00:00-05:00","resumen":"Le interesa, lo va a pensar"}')
  assert.equal(r.outcome, 'pensándolo')
  assert.equal(r.objecion, 'el precio')
  assert.equal(r.proximoPaso, 'volver a llamar')
  assert.equal(r.fechaISO, '2026-06-26T15:00:00-05:00')
  assert.match(r.resumen, /va a pensar/)
})

test('parsearDebrief: outcome desconocido → "otro"; nulls tolerados', () => {
  const r = parsearDebrief('{"outcome":"inventado","objecion":null,"proximoPaso":null,"fechaISO":null,"resumen":"x"}')
  assert.equal(r.outcome, 'otro')
  assert.equal(r.objecion, null)
  assert.ok(DEBRIEF_OUTCOMES.includes(r.outcome))
})

test('parsearDebrief: basura no-JSON → estructura segura', () => {
  const r = parsearDebrief('no soy json')
  assert.equal(r.outcome, 'otro')
  assert.equal(r.resumen, '')
})
