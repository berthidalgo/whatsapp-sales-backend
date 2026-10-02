import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validarCampaignConfig, fusionarConfig, validarTriggers, normalizarTrigger, buscarClavePeligrosa } from '../src/config/campaign-schema.js'
const cfg = () => ({ vertical: 'tienda', agente: { nombre: 'Asesor de prueba', empresa: 'Empresa de prueba' }, factSheet: { precio: { textoExacto: 'S/ 139', monto: 139, moneda: 'S/' } } })

test('forense: 100 montos parciales nunca pasan por el precio completo', () => {
  for (let n = 10; n < 110; n++) {
    const c = cfg(); c.factSheet.precio = { textoExacto: 'S/' + n + '9', monto: n }
    assert.equal(validarCampaignConfig(c).ok, false)
  }
})
for (const [textoExacto, monto] of [['S/. 139', 139], ['S/ 124.50', 124.5], ['S/ 1,500', 1500], ['124,50 soles', 124.5], ['USD 139', 139]]) {
  test('forense: precio monetario exacto ' + textoExacto, () => {
    const c = cfg(); c.factSheet.precio = { textoExacto, monto }
    assert.equal(validarCampaignConfig(c).ok, true)
  })
}
test('forense: cantidades y uso no son dinero', () => {
  for (const textoExacto of ['uso 139', '3 envases 139', 'el sol brilla 139']) {
    const c = cfg(); c.factSheet.precio = { textoExacto, monto: 139 }
    assert.equal(validarCampaignConfig(c).ok, false)
  }
})
for (const key of ['__proto__', 'constructor', 'prototype']) {
  test('forense: rechaza la clave peligrosa ' + key + ' en helper y contrato', () => {
    const parche = JSON.parse('{"factSheet":{"' + key + '":{"admin":true}}}')
    assert.throws(() => fusionarConfig(cfg(), parche))
    assert.equal(validarCampaignConfig({ ...cfg(), ...parche }).ok, false)
    assert.equal({}.admin, undefined)
  })
}
test('forense: identidad heredada y profundidad excesiva se rechazan', () => {
  const c = Object.create({ agente: cfg().agente }); c.factSheet = {}
  assert.equal(validarCampaignConfig(c).ok, false)
  let nested = {}; for (let i = 0; i < 14; i++) nested = { a: nested }
  assert.ok(buscarClavePeligrosa(nested))
})
test('forense: merge anidado conserva monto, moneda y otras imágenes', () => {
  const c = cfg(); c.factSheet.imagenes = { precios: { archivo: 't1/precios.png' }, inicio: { archivo: 't1/inicio.png' } }
  const out = fusionarConfig(c, { factSheet: { precio: { textoExacto: 'S/ 139' }, imagenes: { precios: { mimetype: 'image/png' } } } })
  assert.equal(out.factSheet.precio.monto, 139)
  assert.equal(out.factSheet.precio.moneda, 'S/')
  assert.equal(out.factSheet.imagenes.inicio.archivo, 't1/inicio.png')
  assert.equal(out.factSheet.imagenes.precios.archivo, 't1/precios.png')
})
for (const archivo of ['../package.json', '/etc/passwd', 'C:/secret.png', 'tenant_other/precios.png']) {
  test('forense: rechaza ruta de imagen ' + archivo, () => {
    const c = cfg(); c.factSheet.imagenes = { precios: { archivo, mimetype: 'image/png' } }
    assert.equal(validarCampaignConfig(c, { tenantId: 'tenant_test' }).ok, false)
  })
}
test('forense: imagen propia pasa, storage remoto sin implementación falla', () => {
  const c = cfg(); c.factSheet.imagenes = { precios: { archivo: 'tenant_test/precios.png', mimetype: 'image/png' } }
  assert.equal(validarCampaignConfig(c, { tenantId: 'tenant_test' }).ok, true)
  c.factSheet.imagenes.precios = { storageKey: 'private/key' }
  assert.equal(validarCampaignConfig(c, { tenantId: 'tenant_test' }).ok, false)
})
test('forense: trigger pack-3 y espacio repetido comparten forma estable', () => {
  assert.equal(normalizarTrigger('Páck-3'), 'pack3')
  assert.equal(normalizarTrigger('Pack   3'), 'pack 3')
  assert.equal(validarTriggers([123]).ok, false)
  assert.equal(validarTriggers([], { permitirVacios: true }).ok, true)
})
