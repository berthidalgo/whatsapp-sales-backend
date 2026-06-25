import { test } from 'node:test'
import assert from 'node:assert/strict'
import { construirGuiaSupervisor, construirSystemPrompt } from '../src/brain/agent-brain.js'

const MARKER = 'GUÍA ADICIONAL DEL SUPERVISOR'
const fsStub = { factSheetBloque: 'FICHA DE PRUEBA' }
const base = { campaignConfig: {}, fs: fsStub, vendorNombre: 'Test', estadoLead: {} }
const conFlow = { flow: { nodes: { presenting: { guidance: 'Enfatiza el caso del alumno X' } } } }

test('construirGuiaSupervisor: vacío cuando no hay overrides (cero cambio)', () => {
  assert.equal(construirGuiaSupervisor(null), '')
  assert.equal(construirGuiaSupervisor({}), '')
  assert.equal(construirGuiaSupervisor({ flow: {} }), '')
  assert.equal(construirGuiaSupervisor({ flow: { nodes: {} } }), '')
  assert.equal(construirGuiaSupervisor({ flow: { nodes: { presenting: { guidance: '   ' } } } }), '')  // vacío real
})

test('construirGuiaSupervisor: arma el addendum con la guía editada', () => {
  const out = construirGuiaSupervisor(conFlow)
  assert.match(out, /GUÍA ADICIONAL DEL SUPERVISOR/)
  assert.match(out, /Momento 4 \(Presentación\): Enfatiza el caso del alumno X/)
  assert.match(out, /GANA la regla de seguridad/)  // las reglas de seguridad mandan
})

test('CANDADO: el prompt vivo es BYTE-IDÉNTICO salvo flag ON + overrides', () => {
  const prev = process.env.FLOW_OVERRIDES_ENABLED

  // (1) flag OFF (default) + overrides → SIN addendum (el bot vivo no cambia)
  delete process.env.FLOW_OVERRIDES_ENABLED
  const offConFlow = construirSystemPrompt({ ...base, campaignConfig: conFlow })
  assert.ok(!offConFlow.includes(MARKER), 'flag OFF: no debe inyectar aunque haya overrides')

  // (2) flag ON + SIN overrides → SIN addendum (byte-idéntico para campañas sin editar)
  process.env.FLOW_OVERRIDES_ENABLED = 'true'
  const onSinFlow = construirSystemPrompt(base)
  assert.ok(!onSinFlow.includes(MARKER), 'flag ON sin overrides: no debe inyectar')
  // y es idéntico al prompt con flag OFF sin overrides (cero cambio)
  delete process.env.FLOW_OVERRIDES_ENABLED
  const offSinFlow = construirSystemPrompt(base)
  assert.equal(onSinFlow, offSinFlow, 'sin overrides el prompt es idéntico con flag ON u OFF')

  // (3) flag ON + overrides → addendum presente
  process.env.FLOW_OVERRIDES_ENABLED = 'true'
  const onConFlow = construirSystemPrompt({ ...base, campaignConfig: conFlow })
  assert.ok(onConFlow.includes(MARKER), 'flag ON + overrides: debe inyectar el addendum')
  assert.match(onConFlow, /Momento 4 \(Presentación\): Enfatiza el caso del alumno X/)

  // restaurar
  if (prev === undefined) delete process.env.FLOW_OVERRIDES_ENABLED
  else process.env.FLOW_OVERRIDES_ENABLED = prev
})
