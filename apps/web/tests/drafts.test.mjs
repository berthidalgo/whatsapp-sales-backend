// tests/drafts.test.mjs — El borrador pertenece a un lead (Hito B1).
//
// El fallo que cierra este módulo: el compositor tenía UN texto para toda la pantalla.
// Escribías para Ana, seleccionabas a Bruno y "Enviar" mandaba el texto de Ana a Bruno —
// un envío erróneo a un cliente real, irreversible. Aquí se comprueba que el borrador se
// guarda POR lead y que un envío fallido no lo borra.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { guardarBorrador, leerBorrador, borrarBorrador, limpiarBorradores } from '../src/drafts.ts'

// localStorage es la única dependencia del módulo; en Node se emula.
class Memoria {
  constructor() { this.m = new Map() }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null }
  setItem(k, v) { this.m.set(k, String(v)) }
  removeItem(k) { this.m.delete(k) }
}
globalThis.localStorage = new Memoria()

beforeEach(() => { limpiarBorradores() })

test('el borrador de un lead NO aparece en otro', () => {
  guardarBorrador(11, 'Hola Ana, te escribo por el pack')
  guardarBorrador(22, 'Hola Bruno, otro tema')
  assert.equal(leerBorrador(11), 'Hola Ana, te escribo por el pack')
  assert.equal(leerBorrador(22), 'Hola Bruno, otro tema')
  assert.equal(leerBorrador(33), '', 'un lead sin borrador arranca vacío, no con el de otro')
})

test('escribir para A y cambiar a B nunca envía el texto de A a B', () => {
  guardarBorrador(1, 'texto pensado para Ana')
  // El compositor de Bruno empieza con SU borrador (vacío), no con el de Ana.
  assert.equal(leerBorrador(2), '')
  // Y volver a Ana conserva lo suyo.
  assert.equal(leerBorrador(1), 'texto pensado para Ana')
})

test('un texto vacío borra solo SU entrada (no el borrador de los demás)', () => {
  guardarBorrador(1, 'para Ana')
  guardarBorrador(2, 'para Bruno')
  borrarBorrador(1)
  assert.equal(leerBorrador(1), '')
  assert.equal(leerBorrador(2), 'para Bruno', 'borrar el de Ana no toca el de Bruno')
})

test('solo texto en blanco no ocupa memoria (no deja basura de otros)', () => {
  guardarBorrador(5, '   ')
  assert.equal(leerBorrador(5), '')
})

test('un almacenamiento corrupto no rompe la pantalla: se lee como vacío', () => {
  localStorage.setItem('hidata_borradores', '{esto no es json')
  assert.equal(leerBorrador(1), '')
  guardarBorrador(1, 'hola')
  assert.equal(leerBorrador(1), 'hola', 'y se recupera al escribir')
})