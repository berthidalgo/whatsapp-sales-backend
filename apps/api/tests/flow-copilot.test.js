import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsearCopiloto, filtrarEdits } from '../src/brain/flow-copilot.js'

test('parsearCopiloto: lee el JSON del copiloto y tolera basura', () => {
  const ok = parsearCopiloto('{"respuesta":"hola","edits":{"factSheet":{"propuestaValor":"x"}}}')
  assert.equal(ok.respuesta, 'hola')
  assert.equal(ok.edits.factSheet.propuestaValor, 'x')
  
  // basura → respuesta = el texto, edits vacío
  const basura = parsearCopiloto('no soy json')
  assert.equal(basura.respuesta, 'no soy json')
  assert.equal(basura.edits && Object.keys(basura.edits).length, 0)
})

test('filtrarEdits: SOLO campos permitidos de factSheet y agente', () => {
  const edits = filtrarEdits({
    factSheet: {
      propuestaValor: 'La mejor opción',
      campoInventado: 'basura'
    },
    agente: {
      nombreProducto: 'Hidata Pro',
      otroCampo: 'basura'
    },
    campoFuera: 'basura'
  })
  assert.deepEqual(Object.keys(edits), ['factSheet', 'agente'])
  assert.equal(edits.factSheet.propuestaValor, 'La mejor opción')
  assert.equal(edits.factSheet.campoInventado, undefined)
  assert.equal(edits.agente.nombreProducto, 'Hidata Pro')
  assert.equal(edits.agente.otroCampo, undefined)
})

test('filtrarEdits: tolera entrada nula/rara', () => {
  assert.deepEqual(filtrarEdits(null), { factSheet: {}, agente: {} })
  assert.deepEqual(filtrarEdits('x'), { factSheet: {}, agente: {} })
})

