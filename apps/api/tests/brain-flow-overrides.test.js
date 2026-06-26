import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  construirGuiaSupervisor,
  construirSystemPrompt,
  construirFlujoMomentos,
  MOMENTOS
} from '../src/brain/agent-brain.js'
import { GOLDEN_FLOW_PROMPT } from './fixtures/golden-flow-fixture.js'

const fsStub = { factSheetBloque: 'FICHA DE PRUEBA' }
const base = { campaignConfig: {}, fs: fsStub, vendorNombre: 'Test', estadoLead: {} }
const conFlow = { flow: { nodes: { presenting: { guidance: 'Enfatiza el caso del alumno X' } } } }

// 1. Mantener retrocompatibilidad con tests de construirGuiaSupervisor (deprecada)
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

// 2. Tests de la nueva arquitectura (momentos dinámicos)
test('CANDADO: construirFlujoMomentos sin override y con ficha fija es byte-identico al golden', () => {
  const result = construirFlujoMomentos({
    pasoPresentacion: '__FICHA_DE_PRUEBA__',
    overrides: {},
    flagOn: false
  })
  assert.equal(result.replace(/\r\n/g, '\n'), GOLDEN_FLOW_PROMPT.replace(/\r\n/g, '\n'))
})

test('CANDADO: construirFlujoMomentos con flagOn=true pero sin overrides es byte-identico al golden', () => {
  const result = construirFlujoMomentos({
    pasoPresentacion: '__FICHA_DE_PRUEBA__',
    overrides: {},
    flagOn: true
  })
  assert.equal(result.replace(/\r\n/g, '\n'), GOLDEN_FLOW_PROMPT.replace(/\r\n/g, '\n'))
})

test('CANDADO: el prompt completo incluye el flujo exacto retornado por construirFlujoMomentos', () => {
  const prompt = construirSystemPrompt({
    campaignConfig: {},
    fs: fsStub,
    vendorNombre: 'Test',
    estadoLead: {}
  })

  const flujoEsperado = construirFlujoMomentos({
    pasoPresentacion: 'FICHA DE PRUEBA',
    overrides: {},
    flagOn: false
  })

  const normalizedPrompt = prompt.replace(/\r\n/g, '\n')
  const normalizedFlujo = flujoEsperado.replace(/\r\n/g, '\n')

  const startIdx = normalizedPrompt.indexOf('# EL FLUJO')
  assert.ok(startIdx !== -1, 'Debe encontrarse la sección del flujo en el prompt')

  const endIdx = normalizedPrompt.indexOf('# SI EL LEAD DA TODO DE GOLPE')
  assert.ok(endIdx !== -1, 'Debe encontrarse el marcador de fin en el prompt')

  const subPrompt = normalizedPrompt.slice(startIdx, endIdx).trim()
  assert.equal(subPrompt, normalizedFlujo)
})

test('OVERRIDE ACTIVO: reemplaza un momento, mantiene el resto intacto y M4 conserva ficha', () => {
  const overrides = {
    discovery: {
      guidance: 'Momento 2 modificado por el supervisor'
    }
  }

  const result = construirFlujoMomentos({
    pasoPresentacion: 'FICHA_PRES',
    overrides,
    flagOn: true
  })

  // M2 debe haber cambiado
  assert.ok(result.includes('Momento 2 modificado por el supervisor'))
  assert.ok(!result.includes(MOMENTOS.discovery))

  // M1 y M3 deben permanecer byte-idénticos
  assert.ok(result.includes(MOMENTOS.first_contact))
  assert.ok(result.includes(MOMENTOS.qualifying_empresa))

  // M4 (presenting) debe conservar su contenido original con la ficha inyectada
  const m4Esperado = MOMENTOS.presenting.replace('__FICHA__', 'FICHA_PRES')
  assert.ok(result.includes(m4Esperado))
})

test('OVERRIDE M4 SIN CENTINELA: inyecta la ficha de forma segura', () => {
  const overrides = {
    presenting: {
      guidance: 'Presentación personalizada del supervisor'
    }
  }

  const result = construirFlujoMomentos({
    pasoPresentacion: 'DATOS_DE_MI_FICHA',
    overrides,
    flagOn: true
  })

  assert.ok(result.includes('Presentación personalizada del supervisor'))
  assert.ok(result.includes('Estos son los datos REALES del programa:'))
  assert.ok(result.includes('DATOS_DE_MI_FICHA'))
})

