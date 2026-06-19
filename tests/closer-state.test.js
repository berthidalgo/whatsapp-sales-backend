// tests/closer-state.test.js — estado del closer (v5_5, anti-disco-rayado del cierre)
// acumularCierre suma turno a turno cuántas veces el bot ofreció la llamada, qué
// objeciones ya resolvió y su última palanca; resumenCierre lo vuelve texto para el
// prompt. Es el bucle que impide que el bot ruegue/repita: SABE su historial de cierre.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acumularCierre, resumenCierre } from '../src/brain/brain-pipeline.js'

// ── acumularCierre ──────────────────────────────────────────────────────────

test('estado inicial (null) + primer ofrecimiento de llamada → cuenta 1', () => {
  const r = acumularCierre(null, { ofrecio_llamada: true, objecion_trabajada: 'ninguna', palanca: 'cierre_suave' })
  assert.equal(r.ofertas_llamada, 1)
  assert.deepEqual(r.objeciones, [])
  assert.equal(r.ultima_palanca, 'cierre_suave')
})

test('ofrecimientos se ACUMULAN turno a turno (1 → 2 → 3)', () => {
  let r = acumularCierre(null, { ofrecio_llamada: true })
  r = acumularCierre(r, { ofrecio_llamada: true })
  r = acumularCierre(r, { ofrecio_llamada: true })
  assert.equal(r.ofertas_llamada, 3)  // el prompt verá "3 veces" → debe dejar de proponerla
})

test('turno que NO ofrece llamada no incrementa el contador', () => {
  const prev = { ofertas_llamada: 2, objeciones: [], ultima_palanca: 'valor' }
  const r = acumularCierre(prev, { ofrecio_llamada: false, palanca: 'prueba_social' })
  assert.equal(r.ofertas_llamada, 2)
  assert.equal(r.ultima_palanca, 'prueba_social')
})

test('objeciones se ACUMULAN sin duplicar', () => {
  let r = acumularCierre(null, { objecion_trabajada: 'tiempo', palanca: 'resolver_objecion' })
  assert.deepEqual(r.objeciones, ['tiempo'])
  r = acumularCierre(r, { objecion_trabajada: 'precio', palanca: 'resolver_objecion' })
  assert.deepEqual(r.objeciones, ['tiempo', 'precio'])
  r = acumularCierre(r, { objecion_trabajada: 'tiempo', palanca: 'resolver_objecion' })  // repetida
  assert.deepEqual(r.objeciones, ['tiempo', 'precio'])  // no se duplica
})

test('"ninguna" no entra a la lista de objeciones', () => {
  const r = acumularCierre(null, { objecion_trabajada: 'ninguna', palanca: 'valor' })
  assert.deepEqual(r.objeciones, [])
})

test('palanca "ninguna" preserva la última palanca real anterior', () => {
  const prev = { ofertas_llamada: 0, objeciones: [], ultima_palanca: 'prueba_social' }
  const r = acumularCierre(prev, { palanca: 'ninguna' })
  assert.equal(r.ultima_palanca, 'prueba_social')
})

test('cierreTurno null/undefined → preserva el estado previo (no rompe)', () => {
  const prev = { ofertas_llamada: 2, objeciones: ['tiempo'], ultima_palanca: 'valor' }
  assert.deepEqual(acumularCierre(prev, null), prev)
  assert.deepEqual(acumularCierre(prev, undefined), prev)
})

test('tolera prev con objeciones ausente (estado corrupto/viejo)', () => {
  const r = acumularCierre({ ofertas_llamada: 1 }, { objecion_trabajada: 'precio', ofrecio_llamada: true })
  assert.equal(r.ofertas_llamada, 2)
  assert.deepEqual(r.objeciones, ['precio'])
})

// ── resumenCierre ───────────────────────────────────────────────────────────

test('estado vacío / null → null (lead nuevo, prompt idéntico)', () => {
  assert.equal(resumenCierre(null), null)
  assert.equal(resumenCierre({ ofertas_llamada: 0, objeciones: [], ultima_palanca: null }), null)
})

test('resumen con 1 oferta → "1 vez"', () => {
  const s = resumenCierre({ ofertas_llamada: 1, objeciones: [], ultima_palanca: 'cierre_suave' })
  assert.match(s, /propusiste la llamada 1 vez/)
  assert.match(s, /última palanca fue "cierre_suave"/)
})

test('resumen con 2 ofertas → "2 veces" (el bot debe dejar de proponerla)', () => {
  const s = resumenCierre({ ofertas_llamada: 2, objeciones: ['tiempo'], ultima_palanca: 'resolver_objecion' })
  assert.match(s, /propusiste la llamada 2 veces/)
  assert.match(s, /objeciones: tiempo/)
})

test('resumen solo con objeción trabajada (sin ofertas) NO es null', () => {
  const s = resumenCierre({ ofertas_llamada: 0, objeciones: ['precio'], ultima_palanca: 'resolver_objecion' })
  assert.match(s, /ya resolviste estas objeciones: precio/)
})
