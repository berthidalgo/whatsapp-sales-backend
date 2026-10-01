// tests/vulnerabilidad-llamada.test.js — REGLAS DETERMINISTAS Etapa 1 (oct 2026)
//
// POR QUÉ EXISTEN (banco Mistral/OpenRouter, 30-sep-2026):
//   C022: el modelo ofreció llamada a un lead que vendió sus parcelas y no le
//   quedaba nada (veto no_escalo_vulnerable en 4 de 6 modelos).
//   C023: el lead que pide llamada él mismo era devuelto al cuestionario
//   (así se perdió a Rafael 2 meses).
// Los vetos no pueden depender del humor del modelo: regla antes del LLM.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectarVulnerabilidadGrave,
  detectarPideLlamada,
  aplicarNudgeLlamada,
  pensarYResponder
} from '../src/brain/agent-brain.js'
import { getVertical } from '../src/brain/verticals/index.js'

// ── Detector vulnerabilidad: casos graves SÍ ──
for (const texto of [
  'ya gaste en abono, ya vendi mis parcelas, no me queda nada',
  'vendí todo, es mi última esperanza',
  'estoy endeudado y no me queda nada',
  'me quedé sin nada, lo perdí todo',
  'no tengo ni para comer'
]) {
  test(`vulnerabilidad: DETECTA "${texto.slice(0, 40)}"`, () => {
    assert.equal(detectarVulnerabilidadGrave(texto), true)
  })
}

// ── Detector vulnerabilidad: objeciones normales NO ──
for (const texto of [
  'no tengo dinero ahora mismo',
  'está caro, lo voy a pensar',
  'cuánto cuesta?',
  'hola, info del curso'
]) {
  test(`vulnerabilidad: NO toca objeción "${texto.slice(0, 40)}"`, () => {
    assert.equal(detectarVulnerabilidadGrave(texto), false,
      'un falso positivo aquí deriva a humano a quien solo regateaba')
  })
}

// ── Regla integrada: sin LLM, escala con empatía ──
test('regla vulnerabilidad: responde y escala sin llamar al modelo', async () => {
  const r = await pensarYResponder({
    mensajeActual: 'ya vendi mis parcelas, no me queda nada',
    campaignConfig: { vertical: 'exportacion', agente: { nombre: 'Jhon' } },
    estadoLead: { stage: 'presenting', slots: {}, tenantId: 'peru_exporta' }
  })
  assert.equal(r.ok, true)
  assert.equal(r.debe_escalar_humano, true)
  assert.equal(r.audit.proveedor, 'regla')
  assert.equal(r.audit.model, 'regla_vulnerabilidad')
  assert.equal(r.audit.tokens, 0)
  assert.doesNotMatch(r.mensaje, /te llamo hoy|mañana/i)
})

// ── Detector pide-llamada ──
for (const texto of [
  'Puede ser por una llamada',
  'llámame mañana',
  'quiero que me llamen',
  'me pueden llamar ahorita?'
]) {
  test(`llamada: DETECTA "${texto}"`, () => {
    assert.equal(detectarPideLlamada(texto), true)
  })
}

test('llamada: NO matchea pregunta del programa', () => {
  assert.equal(detectarPideLlamada('cuánto cuesta el programa?'), false)
})

// ── Nudge: solo exportación, solo si pide ──
test('nudge: se agrega en exportacion cuando pide llamada', () => {
  const v = getVertical({ vertical: 'exportacion' }, 'peru_exporta')
  const out = aplicarNudgeLlamada('PROMPT', 'Puede ser por una llamada', v)
  assert.match(out, /PIDE la llamada él mismo/)
  assert.match(out, /^PROMPT/)
})

test('nudge: no toca colágeno/tienda ni otros mensajes', () => {
  const col = getVertical({ vertical: 'colageno' }, 'bioayur')
  assert.equal(aplicarNudgeLlamada('PROMPT', 'Puede ser por una llamada', col), 'PROMPT')
  const exp = getVertical({ vertical: 'exportacion' }, 'peru_exporta')
  assert.equal(aplicarNudgeLlamada('PROMPT', 'cuánto cuesta?', exp), 'PROMPT')
})
