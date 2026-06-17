// tests/episodic-memory.test.js — memoria episódica (lead que vuelve).
// Prueba la parte PURA: construir el bloque de memoria desde filas archivadas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { construirResumenMemoria } from '../src/brain/brain-pipeline.js'

test('sin filas → null (lead nuevo → prompt idéntico, cero regresión)', () => {
  assert.equal(construirResumenMemoria([]), null)
  assert.equal(construirResumenMemoria(null), null)
})

test('arma el bloque con nombre, producto, experiencia y stage legible + "hace X días"', () => {
  const filas = [{
    nombre_detectado: 'Carlos',
    slots: { nombre: 'Carlos', producto: 'café', experiencia: 'empezando desde cero', empresa: 'persona natural' },
    stage_final: 'call_scheduling',
    archived_at: new Date(Date.now() - 3 * 86400000)
  }]
  const b = construirResumenMemoria(filas)
  assert.match(b, /ya conversaron antes/i)
  assert.match(b, /Nombre: Carlos/)
  assert.match(b, /Le interesaba exportar: café/)
  assert.match(b, /coordinando una llamada/)   // stage_final → frase legible
  assert.match(b, /hace 3 días/)
  assert.match(b, /Qué gusto que vuelvas/)      // instrucción de re-saludo cálido
})

test('filtra valores-basura (no especificado / no tengo / explorando)', () => {
  const filas = [{
    nombre_detectado: 'Blanca',
    slots: { nombre: 'Blanca', producto: 'no especificado, explorando ideas', empresa: 'no tengo empresa', experiencia: 'recién voy a empezar' },
    stage_final: 'call_scheduling',
    archived_at: new Date()
  }]
  const b = construirResumenMemoria(filas)
  assert.match(b, /Nombre: Blanca/)
  assert.doesNotMatch(b, /explorando ideas/)    // producto basura → fuera
  assert.doesNotMatch(b, /no tengo empresa/)    // empresa basura → fuera
  assert.match(b, /recién voy a empezar/)        // experiencia válida → se conserva
  assert.match(b, /hoy mismo/)
})

test('cae al nombre_detectado si falta el slot nombre', () => {
  const b = construirResumenMemoria([{ nombre_detectado: 'Pedro', slots: {}, stage_final: 'discovery', archived_at: new Date() }])
  assert.match(b, /Nombre: Pedro/)
})
