// tests/factsheet-loader.test.js — flattenFactSheet: la lógica que evita inventar
// precios/nombres (el bug del precio falso S/2,997). Función PURA, sin BD.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flattenFactSheet } from '../src/response/factsheet-loader.js'

test('sin config → defaults seguros, NUNCA precio inventado', () => {
  const fs = flattenFactSheet(null)
  assert.equal(fs.tieneFactSheet, false)
  assert.equal(fs.precioTexto, null)
  assert.equal(fs.nombreProducto, 'nuestro programa')
})

test('config sin factSheet → defaults seguros', () => {
  assert.equal(flattenFactSheet({ agente: {} }).tieneFactSheet, false)
})

test('precio.textoExacto se usa tal cual', () => {
  const fs = flattenFactSheet({ factSheet: { precio: { textoExacto: 'S/ 1,500' } } })
  assert.equal(fs.precioTexto, 'S/ 1,500')
  assert.equal(fs.tieneFactSheet, true)
})

test('precio por monto+moneda se compone si no hay textoExacto', () => {
  const fs = flattenFactSheet({ factSheet: { precio: { monto: 1500, moneda: 'S/' } } })
  assert.equal(fs.precioTexto, 'S/ 1500')
  assert.equal(fs.precioMonto, 1500)
})

test('el nombre real del programa entra al bloque; el genérico NO', () => {
  const real = flattenFactSheet({ agente: { nombreProducto: 'Mi Primera Exportación' }, factSheet: { precio: { textoExacto: 'S/1,500' } } })
  assert.equal(real.nombreProducto, 'Mi Primera Exportación')
  assert.match(real.factSheetBloque, /Nombre del programa: Mi Primera Exportación/)
  assert.match(real.factSheetBloque, /Precio: S\/1,500/)

  const generico = flattenFactSheet({ factSheet: { precio: { textoExacto: 'S/1,500' } } })
  assert.doesNotMatch(generico.factSheetBloque, /Nombre del programa/)
})

test('incluye[] → texto unido por comas', () => {
  const fs = flattenFactSheet({ factSheet: { incluye: ['A', 'B', 'C'] } })
  assert.equal(fs.incluyeTexto, 'A, B, C')
})
