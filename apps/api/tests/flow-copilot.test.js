import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsearCopiloto, filtrarEdits } from '../src/brain/flow-copilot.js'
import { materializarFlujoCerebro } from '../src/brain/flow-materializer.js'

test('parsearCopiloto: lee el JSON del copiloto y tolera basura', () => {
  const ok = parsearCopiloto('{"respuesta":"hola","edits":{"presenting":{"guidance":"x"}},"aviso":"ojo"}')
  assert.equal(ok.respuesta, 'hola')
  assert.equal(ok.edits.presenting.guidance, 'x')
  assert.equal(ok.aviso, 'ojo')
  // basura → respuesta = el texto, edits vacío
  const basura = parsearCopiloto('no soy json')
  assert.equal(basura.edits && Object.keys(basura.edits).length, 0)
  assert.equal(basura.aviso, null)
})

test('filtrarEdits: SOLO nodos que existen, solo guidance/label, con tope', () => {
  const flow = materializarFlujoCerebro()
  const edits = filtrarEdits({
    presenting: { guidance: '  nueva guía  ', label: 'Pitch' },   // válido (se trimea)
    nodo_inventado: { guidance: 'basura' },                        // id no existe → fuera
    discovery: { campoRaro: 'x' },                                 // sin guidance/label → fuera
  }, flow)
  assert.deepEqual(Object.keys(edits), ['presenting'])
  assert.equal(edits.presenting.guidance, 'nueva guía')
  assert.equal(edits.presenting.label, 'Pitch')
})

test('filtrarEdits: tolera entrada nula/rara', () => {
  const flow = materializarFlujoCerebro()
  assert.deepEqual(filtrarEdits(null, flow), {})
  assert.deepEqual(filtrarEdits({ presenting: null }, flow), {})
  assert.deepEqual(filtrarEdits('x', flow), {})
})
