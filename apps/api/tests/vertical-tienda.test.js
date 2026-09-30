// tests/vertical-tienda.test.js — Vertical tienda (e-commerce de producto ganador, contraentrega)
//
// Cubre lo propio de este negocio (lo común lo vigila contrato-vertical.test.js):
//   1. El tenant hidata resuelve a tienda y el prompt vive de la FICHA de la campaña.
//   2. El guardrail de pagos: ningún número de cuenta, Yape a un número ni pedido de
//      adelanto sale en boca del bot — sin bloquear "pagas con Yape al recibir".
//   3. La venta cerrada se reconoce (saca al cliente de los seguimientos automáticos).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVertical } from '../src/brain/verticals/index.js'
import * as tienda from '../src/brain/verticals/tienda.js'
import { flattenFactSheet } from '../src/response/factsheet-loader.js'
import { pensarYResponder } from '../src/brain/agent-brain.js'

const CONFIG = {
  vertical: 'tienda',
  agente: { nombre: 'Joan', empresa: 'Hidata Importaciones', nombreProducto: 'Lámpara Luna 3D' },
  factSheet: {
    precio: { moneda: 'S/', monto: 59 },
    ofertaHoy: '2 unidades por S/ 99',
    incluye: ['lámpara', 'cable USB', 'control remoto'],
    metodosPago: ['contraentrega: efectivo, Yape o Plin al recibir']
  }
}

test('tienda: el tenant hidata usa el manual de tienda', () => {
  assert.equal(getVertical(null, 'hidata').VERTICAL_ID, 'tienda')
  assert.equal(getVertical({ vertical: 'tienda' }, 'bioayur').VERTICAL_ID, 'tienda', 'la campaña manda sobre el tenant')
})

test('tienda: con ficha, el precio y la oferta salen de la campaña', () => {
  const prompt = tienda.construirSystemPrompt({ campaignConfig: CONFIG, fs: flattenFactSheet(CONFIG), vendorNombre: 'Joan', estadoLead: null })
  assert.match(prompt, /Eres Joan, asesor de ventas de Hidata Importaciones/)
  assert.match(prompt, /FICHA DEL PRODUCTO/)
  assert.match(prompt, /S\/ 59/)
  assert.match(prompt, /2 unidades por S\/ 99/)
  assert.match(prompt, /Lámpara Luna 3D/)
})

test('tienda: sin ficha no hay precio y el bot deriva', () => {
  const prompt = tienda.construirSystemPrompt({ campaignConfig: null, fs: {}, vendorNombre: null, estadoLead: null })
  assert.match(prompt, /NO des ningún precio/)
  assert.doesNotMatch(prompt, /S\/\s?\d/)
})

const GENERAL = { vertical: 'tienda', agente: { nombre: 'Joan', empresa: 'Hidata Importaciones' }, atribucion: { esCampanaDefault: true } }

test('campaña general: saluda sin inventar producto', async () => {
  const r = await pensarYResponder({ mensajeActual: 'Hola', campaignConfig: GENERAL, estadoLead: { tenantId: 'hidata' } })
  assert.equal(r.debe_escalar_humano, false)
  assert.match(r.mensaje, /¿Qué producto viste/)
  assert.equal(r.audit.proveedor, 'regla')
})

test('campaña general: usa la identidad de cada tenant', async () => {
  const campaignConfig = { ...GENERAL, agente: { nombre: 'Ana', empresa: 'Tienda Ejemplo' } }
  const r = await pensarYResponder({ mensajeActual: 'Hola', campaignConfig, estadoLead: { tenantId: 'otro' } })
  assert.match(r.mensaje, /Ana, de Tienda Ejemplo/)
  assert.doesNotMatch(r.mensaje, /Hidata|Joan/)
})
test('campaña general: una foto con pie se deriva sin describirla ni inventar accesorios', async () => {
  const r = await pensarYResponder({
    mensajeActual: 'Que ves en la foto ?',
    historial: [{ rol: 'agente', texto: '¿Qué producto viste?' }],
    campaignConfig: GENERAL,
    estadoLead: { tenantId: 'hidata' }
  })
  assert.equal(r.debe_escalar_humano, true)
  assert.match(r.mensaje, /No puedo confirmar qué muestra la foto/)
  assert.doesNotMatch(r.mensaje, /BMX|kit de seguridad|te mandé/i)
})

test('campaña general: confirma el PDF solo si existe su marcador', async () => {
  const historial = [{ rol: 'lead', texto: '[📄 el lead envió un documento]' }]
  const recibido = await pensarYResponder({ mensajeActual: '¿Recibieron el PDF?', historial, campaignConfig: GENERAL, estadoLead: { tenantId: 'hidata' } })
  assert.match(recibido.mensaje, /Sí, recibimos tu documento/)
  assert.equal(recibido.debe_escalar_humano, false)
  const ausente = await pensarYResponder({ mensajeActual: '¿Recibieron el PDF?', campaignConfig: GENERAL, estadoLead: { tenantId: 'hidata' } })
  assert.doesNotMatch(ausente.mensaje, /Sí, recibimos/)
})
test('campaña general: consulta de producto sin ficha se deriva', async () => {
  const r = await pensarYResponder({ mensajeActual: '¿Cuánto cuesta el BMX?', campaignConfig: GENERAL, estadoLead: { tenantId: 'hidata' } })
  assert.equal(r.debe_escalar_humano, true)
  assert.match(r.razon_escalamiento, /sin ficha/)
  assert.doesNotMatch(r.mensaje, /BMX|S\/\s*\d/)
})
test('guardrail de pagos: neutraliza cuentas, Yape a un número y adelantos', () => {
  const casos = [
    'Perfecto. Yapéame al 987 654 321 y te lo envío hoy.',
    'Genial, deposita a la cuenta BCP 191-2345 y listo.',
    'Te paso el número de cuenta para que abones.',
    'Para separarlo necesito un pago por adelantado de S/ 20.',
    'Escríbeme al 912345678 para coordinar.'
  ]
  for (const m of casos) {
    const r = tienda.validarMensajeExtra(m)
    assert.match(r.mensaje, /pagas al recibir/, `debió neutralizar: ${m}`)
    assert.doesNotMatch(r.mensaje, /\d{3}\s?\d{3}\s?\d{3}|cuenta|adelantado de/i, `quedó el dato: ${r.mensaje}`)
    assert.ok(r.flags.some(f => f.startsWith('pago_adelantado_neutralizado')))
  }
})

test('guardrail de pagos: NO toca la contraentrega legítima', () => {
  const ok = [
    'Pagas con Yape o Plin al recibir tu pedido 📦',
    'Puedes pagar en efectivo, con Yape o Plin al momento de la entrega.',
    'Cuesta S/ 59 y si llevas 2 te sale a S/ 99. ¿Cuántas quieres?'
  ]
  for (const m of ok) {
    const r = tienda.validarMensajeExtra(m)
    assert.equal(r.mensaje, m)
    assert.deepEqual(r.flags, [])
  }
})

test('venta cerrada: "PEDIDO:" o datos completos la marcan; si no, no', () => {
  const slots = { producto: 'Lámpara Luna 3D', cantidad: '2', nombre: 'Rosa', ciudad: 'Arequipa', direccion: 'Jr. Los Pinos 123' }
  assert.deepEqual(
    tienda.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'PEDIDO: 2 lámparas, Rosa, Arequipa', slots }),
    { producto: 'Lámpara Luna 3D', variante: null, cantidad: '2', ciudad: 'Arequipa', distrito: null, direccion: 'Jr. Los Pinos 123', nombre: 'Rosa' }
  )
  assert.ok(tienda.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'quiere hablar con alguien', slots }), 'datos completos también cuentan')
  assert.equal(tienda.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'pregunta stock', slots: { producto: 'x' } }), null)
  assert.equal(tienda.detectarVentaCerrada({ debeEscalar: false, razonEscalamiento: 'PEDIDO: x', slots }), null)
})
