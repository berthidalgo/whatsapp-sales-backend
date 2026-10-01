// tests/campaign-schema.test.js — CONTRATO DE FICHA (F1 forense)
//
// Sin este contrato, un PUT dejaba la ficha en estados que el cerebro no
// entiende (precio sin texto, monto que el guardrail marcaría como inventado,
// ficha sin identidad, o borrada por omitir un campo). Cada test es un estado
// real que llegó o casi llegó a producción.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validarCampaignConfig, fusionarConfig,
  validarTrigger, validarTriggers, normalizarTrigger
} from '../src/config/campaign-schema.js'

const FICHA_BUENA = {
  vertical: 'colageno',
  agente: { nombre: 'Jhon', empresa: 'BIOAYUR', rol: 'asesor comercial', nombreProducto: 'BIOAYUR ELIXIR' },
  factSheet: {
    precio: {
      textoExacto: '1 envase: S/ 139 · 2 envases: S/ 249 · 3 envases: S/ 339',
      monto: 139,
      moneda: 'S/'
    },
    ofertaHoy: 'SOLO POR HOY: 1 envase S/ 129 · 2 envases S/ 239 · 3 envases S/ 329',
    incluye: ['Colágeno hidrolizado 10g'],
    reglasOro: ['Nunca pedir pago por adelantado']
  },
  atribucion: { esCampanaDefault: true, mensajeDescubrimiento: '¿qué quieres mejorar: piel, energía o articulaciones?' }
}

test('contrato: la ficha buena pasa', () => {
  const r = validarCampaignConfig(FICHA_BUENA)
  assert.equal(r.ok, true, JSON.stringify(r.errores))
})

test('contrato: sin identidad no hay ficha (nombre y empresa obligatorios)', () => {
  const sinAgente = { ...FICHA_BUENA, agente: undefined }
  assert.match(validarCampaignConfig(sinAgente).errores.join('|'), /agente/)
  const sinNombre = { ...FICHA_BUENA, agente: { empresa: 'X' } }
  assert.match(validarCampaignConfig(sinNombre).errores.join('|'), /agente\.nombre/)
  const sinEmpresa = { ...FICHA_BUENA, agente: { nombre: 'X' } }
  assert.match(validarCampaignConfig(sinEmpresa).errores.join('|'), /agente\.empresa/)
})

test('contrato: monto que no está en el texto se rechaza (el guardrail lo marcaría inventado)', () => {
  const mala = {
    ...FICHA_BUENA,
    factSheet: { ...FICHA_BUENA.factSheet, precio: { textoExacto: '1 envase: S/ 139', monto: 319, moneda: 'S/' } }
  }
  const r = validarCampaignConfig(mala)
  assert.equal(r.ok, false)
  assert.match(r.errores.join('|'), /no aparece en textoExacto/)
})

test('contrato: precio sin moneda o sin cifras se rechaza', () => {
  const sinMoneda = {
    ...FICHA_BUENA,
    factSheet: { precio: { textoExacto: '1 envase: 139 · 2 envases: 249', monto: 139 } }
  }
  assert.match(validarCampaignConfig(sinMoneda).errores.join('|'), /moneda/)
  const sinTexto = { ...FICHA_BUENA, factSheet: { precio: { monto: 139, moneda: 'S/' } } }
  assert.match(validarCampaignConfig(sinTexto).errores.join('|'), /textoExacto/)
})

test('contrato: "promo" sin precio se rechaza (invento en potencia)', () => {
  const mala = { ...FICHA_BUENA, factSheet: { ...FICHA_BUENA.factSheet, ofertaHoy: '¡Aprovecha la promo de hoy, está buenísima!' } }
  const r = validarCampaignConfig(mala)
  assert.equal(r.ok, false)
  assert.match(r.errores.join('|'), /ofertaHoy/)
})

test('contrato: default sin mensaje de descubrimiento se rechaza', () => {
  const mala = { ...FICHA_BUENA, atribucion: { esCampanaDefault: true } }
  assert.match(validarCampaignConfig(mala).errores.join('|'), /mensajeDescubrimiento/)
  const noDefault = { ...FICHA_BUENA, atribucion: { esCampanaDefault: false } }
  assert.equal(validarCampaignConfig(noDefault).ok, true)
})

test('contrato: vertical desconocido se rechaza', () => {
  assert.match(validarCampaignConfig({ ...FICHA_BUENA, vertical: 'inmobiliaria' }).errores.join('|'), /vertical/)
})

test('contrato: config que no es objeto se rechaza', () => {
  for (const v of [null, [], 'ficha', 42]) {
    assert.equal(validarCampaignConfig(v).ok, false)
  }
})

test('merge: omitir sección la conserva (anti-borrado accidental)', () => {
  const out = fusionarConfig(FICHA_BUENA, { factSheet: { propuestaValor: 'nueva' } })
  assert.equal(out.agente.nombre, 'Jhon')
  assert.equal(out.factSheet.propuestaValor, 'nueva')
  assert.equal(out.factSheet.precio.monto, 139)
})

test('merge: null explícito vacía la sección (borrado intencional)', () => {
  const out = fusionarConfig(FICHA_BUENA, { ofertaHoy: null })
  assert.equal(out.ofertaHoy, undefined)
  const out2 = fusionarConfig(FICHA_BUENA, { factSheet: null })
  assert.equal(out2.factSheet, undefined)
})

test('triggers: normaliza tildes/mayúsculas y exige mínimo 1 sin duplicados', () => {
  assert.equal(normalizarTrigger('Vi la Promoción'), 'vi la promocion')
  assert.equal(validarTriggers([]).ok, false)
  assert.equal(validarTriggers(['elixir', 'ELIXIR']).ok, false) // duplicado tras normalizar
  const r = validarTriggers(['Elixir', 'Vi la Promoción'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.valores, ['elixir', 'vi la promocion'])
  assert.equal(validarTrigger('x').ok, false)
})
