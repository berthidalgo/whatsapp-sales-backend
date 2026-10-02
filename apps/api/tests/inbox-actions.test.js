import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modoValido, puedeReasignar, esEtiquetaValida, cuerpoVentanaCerrada, primerNombreLead } from '../src/api/inbox-actions.js'

test('modoValido: acepta HUMAN_ACTIVE y AUTO_CONSULTIVO, rechaza lo demás', () => {
  assert.equal(modoValido('HUMAN_ACTIVE'), true)
  assert.equal(modoValido('AUTO_CONSULTIVO'), true)
  assert.equal(modoValido('PAUSED'), false)   // terminal del cerebro, no toggle del CRM
  assert.equal(modoValido('xyz'), false)
  assert.equal(modoValido(undefined), false)
})

test('puedeReasignar: solo ADMIN/SUPERVISOR', () => {
  assert.equal(puedeReasignar({ role: 'ADMIN' }), true)
  assert.equal(puedeReasignar({ role: 'SUPERVISOR' }), true)
  assert.equal(puedeReasignar({ role: 'VENDOR' }), false)
  assert.equal(puedeReasignar(null), false)
})

test('esEtiquetaValida: acepta la taxonomía y el limpiado, rechaza lo inventado', () => {
  assert.equal(esEtiquetaValida('Caliente'), true)
  assert.equal(esEtiquetaValida('Pagó'), true)
  assert.equal(esEtiquetaValida(null), true)        // limpiar la etiqueta
  assert.equal(esEtiquetaValida(''), true)          // limpiar la etiqueta
  assert.equal(esEtiquetaValida('caliente'), false) // case-sensitive: no es del set
  assert.equal(esEtiquetaValida('VIP'), false)      // fuera de la taxonomía
  assert.equal(esEtiquetaValida(123), false)
})

// ── Ventana de 24 h de Meta ─────────────────────────────────────────────
// Meta solo deja mandar texto libre si el lead escribió en las últimas 24 h. Antes eso
// caía en un 502 genérico y el vendedor reescribía el mensaje hasta rendirse. Este es el
// contrato que lee el front para ofrecerle la plantilla que sí reabre el chat.

test('ventana cerrada: el cuerpo trae la plantilla configurada y devuelve el texto escrito', () => {
  const c = cuerpoVentanaCerrada('te mando el link', { CLOUD_TEMPLATE_REAPERTURA: 'reapertura_es' })
  assert.equal(c.ventanaCerrada, true)
  assert.equal(c.plantilla, 'reapertura_es')
  assert.equal(c.textoPendiente, 'te mando el link', 'el vendedor no pierde lo que escribió')
  assert.match(c.error, /24 h/)
})

test('ventana cerrada: sin plantilla aprobada, plantilla es null (el front avisa, no ofrece botón)', () => {
  assert.equal(cuerpoVentanaCerrada('hola', {}).plantilla, null)
})

test('nombre de plantilla: solo el primer nombre, capitalizado; la basura se descarta', () => {
  assert.equal(primerNombreLead('jesus gabriel martínez fl'), 'Jesus')
  assert.equal(primerNombreLead('MARÍA'), 'María')
  assert.equal(primerNombreLead('51987654321'), '', 'un teléfono no es un nombre')
  assert.equal(primerNombreLead('J'), '')
  assert.equal(primerNombreLead(null), '')
})
