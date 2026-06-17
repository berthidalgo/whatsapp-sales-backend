// tests/debounce.test.js — agrupado anti-duplicado del transporte
// Comportamiento crítico: varios mensajes del lead en la ventana → el cerebro
// corre UNA sola vez con el texto combinado (no una respuesta por mensaje).
// Usa los mock timers nativos de node:test (sin tocar el reloj real).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueMessage,
  cancelDebounce,
  clearAllDebounces,
  DEBOUNCE_VERSION
} from '../src/webhook/debounce.js'

const WINDOW = 6000 // DEBOUNCE_WINDOW_MS

test('valida entradas: sin leadId / text / processFn → no encola', () => {
  clearAllDebounces()
  assert.equal(enqueueMessage({ text: 'x', processFn: () => {} }).queued, false)
  assert.equal(enqueueMessage({ leadId: 1, processFn: () => {} }).queued, false)
  assert.equal(enqueueMessage({ leadId: 1, text: 'x' }).queued, false)
})

test('agrupa varios mensajes del mismo lead en UNA sola llamada', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const processFn = (combined, meta) => { calls.push({ combined, meta }) }

  const r1 = enqueueMessage({ leadId: 1, text: 'hola ', processFn })
  const r2 = enqueueMessage({ leadId: 1, text: '  como estas', processFn })
  assert.equal(r1.queued, true)
  assert.equal(r2.bufferSize, 2)        // segundo mensaje se sumó al buffer
  assert.equal(calls.length, 0)          // aún NO se procesó (ventana abierta)

  t.mock.timers.tick(WINDOW)             // expira la ventana → flush

  assert.equal(calls.length, 1)          // UNA sola llamada (no una por mensaje)
  assert.equal(calls[0].combined, 'hola\ncomo estas')  // combinados con \n, trim aplicado
  assert.equal(calls[0].meta.messageCount, 2)
})

test('el timer se reinicia con cada mensaje (no dispara a mitad de ráfaga)', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const processFn = (c) => { calls.push(c) }

  enqueueMessage({ leadId: 7, text: 'a', processFn })
  t.mock.timers.tick(WINDOW - 1000)      // casi expira
  enqueueMessage({ leadId: 7, text: 'b', processFn })  // reinicia el timer
  t.mock.timers.tick(WINDOW - 1000)      // no alcanza desde el reinicio
  assert.equal(calls.length, 0)          // todavía no dispara
  t.mock.timers.tick(1000)               // ahora sí completa la ventana
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'a\nb')
})

test('leads distintos se procesan por separado', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const byLead = {}
  const mk = (id) => (c) => { byLead[id] = c }

  enqueueMessage({ leadId: 1, text: 'uno', processFn: mk(1) })
  enqueueMessage({ leadId: 2, text: 'dos', processFn: mk(2) })
  t.mock.timers.tick(WINDOW)

  assert.equal(byLead[1], 'uno')
  assert.equal(byLead[2], 'dos')
})

test('cancelDebounce impide el flush (handoff del vendedor)', (t) => {
  clearAllDebounces()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  enqueueMessage({ leadId: 9, text: 'hola', processFn: (c) => calls.push(c) })
  cancelDebounce(9)                       // el humano tomó la conversación
  t.mock.timers.tick(WINDOW)
  assert.equal(calls.length, 0)          // el bot NO responde
})

test('expone versión', () => {
  assert.match(DEBOUNCE_VERSION, /^v\d/)
})
