import { test } from 'node:test'
import assert from 'node:assert/strict'
import { materializarFlujoCerebro } from '../src/brain/flow-materializer.js'

test('materializa los 8 momentos del cerebro como nodos', () => {
  const flow = materializarFlujoCerebro()
  assert.equal(flow.source, 'materialized')
  assert.equal(flow.nodes.length, 8)
  const ids = flow.nodes.map(n => n.id)
  assert.ok(ids.includes('first_contact') && ids.includes('presenting') && ids.includes('post_close'))
  // M1 saluda y pide nombre+producto; sus requiredSlots están vacíos (no exige nada para saludar)
  const m1 = flow.nodes.find(n => n.id === 'first_contact')
  assert.equal(m1.momento, 'M1')
  assert.equal(m1.type, 'generative')
  assert.deepEqual(m1.requiredSlots, [])
  // post_close es terminal
  assert.equal(flow.nodes.find(n => n.id === 'post_close').type, 'terminal')
  // presenting exige el perfil completo
  assert.ok(flow.nodes.find(n => n.id === 'presenting').requiredSlots.includes('empresa'))
})

test('materializa las transiciones como aristas (incl. el fast-track HOT)', () => {
  const flow = materializarFlujoCerebro()
  // No hay self-loops (los "se queda" no son aristas de avance)
  assert.ok(flow.edges.every(e => e.from !== e.to), 'no debe haber aristas self-loop')
  // first_contact → discovery existe
  assert.ok(flow.edges.some(e => e.from === 'first_contact' && e.to === 'discovery'))
  // fast-track: first_contact → call_scheduling con fastTrack=true
  const ft = flow.edges.find(e => e.from === 'first_contact' && e.to === 'call_scheduling')
  assert.ok(ft && ft.fastTrack === true, 'debe existir el salto HOT a agendar')
  // call_confirmed → post_close
  assert.ok(flow.edges.some(e => e.from === 'call_confirmed' && e.to === 'post_close'))
})
