// tests/kill-stale.test.js — anti-cascade (Paso 2): generación monotónica por lead.
// El pipeline captura la generación al arrancar; si sube antes de enviar (llegó un
// mensaje nuevo mientras el cerebro pensaba), descarta su respuesta obsoleta. Esto mata
// la cascada (2 Enter del lead → 2 respuestas con 2 preguntas). Mock timers para simular
// el flush (el "arranque del cerebro") sin tocar el reloj real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueMessage, getMessageGeneration, clearAllDebounces } from '../src/webhook/debounce.js'

const WINDOW = 6000
const noop = () => {}

test('lead nuevo → generación 0', () => {
  clearAllDebounces()
  assert.equal(getMessageGeneration(999), 0)
})

test('cada mensaje encolado incrementa la generación', () => {
  clearAllDebounces()
  enqueueMessage({ leadId: 1, text: 'a', processFn: noop })
  assert.equal(getMessageGeneration(1), 1)
  enqueueMessage({ leadId: 1, text: 'b', processFn: noop })
  assert.equal(getMessageGeneration(1), 2)
})

test('generaciones independientes por lead', () => {
  clearAllDebounces()
  enqueueMessage({ leadId: 1, text: 'a', processFn: noop })
  enqueueMessage({ leadId: 2, text: 'x', processFn: noop })
  enqueueMessage({ leadId: 2, text: 'y', processFn: noop })
  assert.equal(getMessageGeneration(1), 1)
  assert.equal(getMessageGeneration(2), 2)
})

test('CASCADE: mensaje nuevo DURANTE el procesamiento sube la generación → respuesta OBSOLETA', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  enqueueMessage({ leadId: 5, text: 'se ve bien', processFn: noop })
  const genAtStart = getMessageGeneration(5)   // el pipeline captura aquí al arrancar
  t.mock.timers.tick(WINDOW)                    // flush → "el cerebro empieza a pensar ~18s"
  // mientras piensa, el lead manda otro Enter:
  enqueueMessage({ leadId: 5, text: 'pero trabajo tarde', processFn: noop })
  // el pipeline, antes de enviar, ve que la generación subió → DESCARTA (obsoleta)
  assert.equal(getMessageGeneration(5) > genAtStart, true)
})

test('SIN cascada: si nadie escribe durante el procesamiento, la generación NO sube → se ENVÍA', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  enqueueMessage({ leadId: 6, text: 'hola', processFn: noop })
  const genAtStart = getMessageGeneration(6)
  t.mock.timers.tick(WINDOW)
  assert.equal(getMessageGeneration(6) > genAtStart, false)  // no obsoleta → enviar normal
})

test('el flush NO borra la generación (sobrevive para detectar el cascade)', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  enqueueMessage({ leadId: 8, text: 'a', processFn: noop })
  t.mock.timers.tick(WINDOW)                    // flush borra el BUFFER...
  assert.equal(getMessageGeneration(8), 1)      // ...pero la generación PERSISTE (clave del fix)
})

test('el re-encolado por el lock (mismo texto) también sube la generación → invalida lo viejo', () => {
  clearAllDebounces()
  enqueueMessage({ leadId: 9, text: 'a', processFn: noop })
  const g1 = getMessageGeneration(9)
  enqueueMessage({ leadId: 9, text: 'a', processFn: noop, metadata: { reenqueuedFromLock: true } })
  assert.equal(getMessageGeneration(9), g1 + 1)
})

test('clearAllDebounces resetea la generación a 0', () => {
  enqueueMessage({ leadId: 3, text: 'a', processFn: noop })
  assert.ok(getMessageGeneration(3) >= 1)
  clearAllDebounces()
  assert.equal(getMessageGeneration(3), 0)
})

test('MUTE-SAFE: todo bump de generación viene de un encolado (siempre hay mensaje que responder)', () => {
  // Invariante: getMessageGeneration solo sube vía enqueueMessage, que SIEMPRE bufferea.
  // Por eso descartar una respuesta obsoleta nunca deja mudo al lead: hay un mensaje
  // encolado que producirá la respuesta final.
  clearAllDebounces()
  const antes = getMessageGeneration(11)
  const r = enqueueMessage({ leadId: 11, text: 'hola', processFn: noop })
  assert.equal(r.queued, true)                  // se bufferó
  assert.equal(getMessageGeneration(11), antes + 1)  // y subió la generación (van juntos)
})
