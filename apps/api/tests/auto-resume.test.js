// tests/auto-resume.test.js — el timer del auto-resume de HUMAN_ACTIVE (Bloque #4)
// y la protección de stage. Umbral por defecto = 6h (env HUMAN_ACTIVE_RESUME_HORAS).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { debeAutoReanudar, stageRank } from '../src/brain/brain-pipeline.js'
import { STAGES } from '../src/state/stage-definitions.js'

const horasAtras = (h) => new Date(Date.now() - h * 3.6e6)

test('debeAutoReanudar: RETOMA si pasó más del umbral (7h > 6h default)', () => {
  assert.equal(debeAutoReanudar({ modeEnteredAt: horasAtras(7) }), true)
})

test('debeAutoReanudar: NO retoma si la actividad humana es reciente (1h)', () => {
  assert.equal(debeAutoReanudar({ modeEnteredAt: horasAtras(1) }), false)
})

test('debeAutoReanudar: NO retoma sin modeEnteredAt', () => {
  assert.equal(debeAutoReanudar({}), false)
  assert.equal(debeAutoReanudar(null), false)
})

test('stageRank ordena el embudo; stage desconocido = 0 (no retrocede por error)', () => {
  assert.ok(stageRank(STAGES.CALL_SCHEDULING) > stageRank(STAGES.DISCOVERY))
  assert.ok(stageRank(STAGES.PRESENTING) > stageRank(STAGES.FIRST_CONTACT))
  assert.equal(stageRank('inventado'), 0)
})
