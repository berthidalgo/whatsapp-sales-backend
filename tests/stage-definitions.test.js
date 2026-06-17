// tests/stage-definitions.test.js — la lógica del embudo (gates de avance,
// transiciones permitidas, fast-track del lead HOT). Funciones PURAS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STAGES, MODES, SLOTS,
  isValidStage, isValidMode,
  canAdvanceToStage, isTransitionAllowed, getFastTrackStage,
  suggestStageFromIntent
} from '../src/state/stage-definitions.js'

test('isValidStage / isValidMode rechazan valores fuera del catálogo', () => {
  assert.equal(isValidStage(STAGES.DISCOVERY), true)
  assert.equal(isValidStage('inventado'), false)
  assert.equal(isValidMode(MODES.HUMAN_ACTIVE), true)
  assert.equal(isValidMode('HUMANO_ACTIVO'), false) // el string del bug #4 histórico
})

test('canAdvanceToStage exige los slots requeridos', () => {
  const sinSlots = canAdvanceToStage(STAGES.QUALIFYING_EMPRESA, {})
  assert.equal(sinSlots.canAdvance, false)
  assert.ok(sinSlots.missingSlots.includes(SLOTS.NOMBRE))

  const completo = canAdvanceToStage(STAGES.QUALIFYING_EMPRESA, { [SLOTS.NOMBRE]: 'Juan', [SLOTS.PRODUCTO]: 'palta' })
  assert.equal(completo.canAdvance, true)
  assert.deepEqual(completo.missingSlots, [])
})

test('canAdvanceToStage trata "" y null como faltantes', () => {
  const r = canAdvanceToStage(STAGES.QUALIFYING_EMPRESA, { [SLOTS.NOMBRE]: '', [SLOTS.PRODUCTO]: null })
  assert.equal(r.canAdvance, false)
})

test('isTransitionAllowed respeta la matriz (no saltos ilegales)', () => {
  assert.equal(isTransitionAllowed(STAGES.FIRST_CONTACT, STAGES.DISCOVERY), true)
  assert.equal(isTransitionAllowed(STAGES.FIRST_CONTACT, STAGES.POST_CLOSE), false)
  assert.equal(isTransitionAllowed('inventado', STAGES.DISCOVERY), false)
})

test('getFastTrackStage: lead HOT que pide llamada en el 1er turno salta a agendar', () => {
  assert.equal(getFastTrackStage(STAGES.FIRST_CONTACT, 'lead_pide_llamada_first_turn_HOT'), STAGES.CALL_SCHEDULING)
  assert.equal(getFastTrackStage(STAGES.FIRST_CONTACT, 'otro_intent'), null)
  assert.equal(getFastTrackStage(STAGES.QUALIFYING_EMPRESA, 'lead_pide_llamada_first_turn_HOT'), null)
})

test('suggestStageFromIntent mapea intents y devuelve null para los desconocidos/no-avance', () => {
  assert.equal(suggestStageFromIntent('requesting_call'), STAGES.CALL_SCHEDULING)
  assert.equal(suggestStageFromIntent('rejecting'), null)
  assert.equal(suggestStageFromIntent('inexistente'), null)
})
