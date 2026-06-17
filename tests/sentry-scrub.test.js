// tests/sentry-scrub.test.js — red de seguridad del scrubber de PII de Sentry.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactPII, scrubEvent, scrubBreadcrumb } from '../src/lib/sentry-scrub.js'

test('redactPII tacha teléfonos de 9+ dígitos (con o sin +)', () => {
  assert.equal(redactPII('lead 51938188585 escribió'), 'lead [tel-redacted] escribió')
  assert.equal(redactPII('cel 938188585'), 'cel [tel-redacted]')
  assert.equal(redactPII('con +51938188585'), 'con [tel-redacted]')
})

test('redactPII NO toca ids cortos ni números chicos (lead_id, latencias)', () => {
  assert.equal(redactPII('lead 1304 stage discovery'), 'lead 1304 stage discovery')
  assert.equal(redactPII('latencia 21222 ms'), 'latencia 21222 ms')
})

test('redactPII tolera no-strings', () => {
  assert.equal(redactPII(null), null)
  assert.equal(redactPII(123), 123)
})

test('scrubEvent tacha mensaje + excepción y BORRA body/headers/cookies/user', () => {
  const ev = scrubEvent({
    message: 'fallo con 51999888777',
    exception: { values: [{ value: 'tel 987654321 en error' }] },
    request: { data: { texto: 'hola soy juan' }, headers: { a: 1 }, cookies: { b: 2 }, query_string: 'x=51999888777' },
    user: { id: 5 }
  })
  assert.equal(ev.message, 'fallo con [tel-redacted]')
  assert.equal(ev.exception.values[0].value, 'tel [tel-redacted] en error')
  assert.equal(ev.request.data, undefined)
  assert.equal(ev.request.headers, undefined)
  assert.equal(ev.request.cookies, undefined)
  assert.equal(ev.request.query_string, 'x=[tel-redacted]')
  assert.equal(ev.user, undefined)
})

test('scrubEvent tolera evento vacío o null', () => {
  assert.deepEqual(scrubEvent({}), {})
  assert.equal(scrubEvent(null), null)
})

test('scrubBreadcrumb tacha el mensaje (incluye los console.log capturados)', () => {
  const bc = scrubBreadcrumb({ message: 'console: lead 912345678 pidió precio' })
  assert.equal(bc.message, 'console: lead [tel-redacted] pidió precio')
})
