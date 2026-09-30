// tests/cierre-y-avisos.test.js — VENTA CERRADA, AVISO AL VENDEDOR, WEBHOOK, PIN, TRAZA
//
// Congela los arreglos del peritaje del 23-sep-2026:
//   · El aviso de un lead escalado de BIOAYUR iba a un teléfono de RELLENO del seed y
//     con el briefing de exportación ("📦 producto / 🏢 situación / 🌱 experiencia").
//   · A una clienta que YA compró, el motor de fondo la "rescataba" al bot a las 6 h y le
//     mandaba "no se te pase la promo".
//   · POST /webhook aceptaba payloads de cualquiera.
//   · Los PIN vivían en texto plano.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { destinoInvalido, lineasPerfil, componentesAvisoVendedor } from '../src/webhook/notifications.js'
import { secretoWebhookValido } from '../src/webhook/handler.js'
import { hashPin, verificarPin, esHash, validarPinNuevo } from '../src/lib/pin.js'
import { filaTurnTrace } from '../src/brain/brain-pipeline.js'
import * as colageno from '../src/brain/verticals/colageno.js'
import * as exportacion from '../src/brain/verticals/exportacion.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ── Aviso al vendedor ───────────────────────────────────────────────────

test('aviso: detecta el teléfono de relleno del seed y el número del propio bot', () => {
  assert.match(destinoInvalido('51999000001'), /relleno/, 'el placeholder de Jhon (BIOAYUR)')
  assert.match(destinoInvalido('51900000002'), /relleno/, 'placeholders de Perú Exporta')
  assert.match(destinoInvalido('+51 924 104 066', { numerosDelBot: ['51924104066'] }), /propio bot/)
  assert.match(destinoInvalido(null), /sin teléfono/)
  assert.match(destinoInvalido('51987654321', { numeroLead: '+51 987 654 321' }), /mismo teléfono/)
  assert.equal(destinoInvalido('51987654321', { numeroLead: '51912345678' }), null)
  assert.equal(destinoInvalido('51987654321', { numerosDelBot: ['51924104066', null] }), null)
})

test('aviso: el briefing de colágeno habla de DESPACHO, no de exportación', () => {
  const lineas = lineasPerfil({ dolor: 'piel', pack: '3', distrito: 'Surco', direccion: 'Av. X 123' }, colageno.CAMPOS_BRIEFING)
  const txt = lineas.join('\n')
  assert.match(txt, /📦 {2}3/)
  assert.match(txt, /📍 {2}Surco/)
  assert.match(txt, /🏠 {2}Av\. X 123/)
  assert.doesNotMatch(txt, /producto por confirmar|situación|experiencia por confirmar/)
})

test('aviso: exportación conserva su briefing histórico (mismas líneas y placeholders)', () => {
  const txt = lineasPerfil({ producto: 'palta' }, exportacion.CAMPOS_BRIEFING).join('\n')
  assert.equal(txt, '📦  palta\n🏢  (situación por confirmar)\n🌱  (experiencia por confirmar)')
  assert.match(lineasPerfil({ pais_destino: 'España' }, exportacion.CAMPOS_BRIEFING).join('\n'), /🌍 {2}España/)
})

// ── Venta cerrada ───────────────────────────────────────────────────────

test('venta: colágeno reconoce el pedido escalado', () => {
  const slots = { nombre: 'María', pack: '3', distrito: 'Surco' }
  assert.deepEqual(
    colageno.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'PEDIDO: 3 envases, María, Surco', slots }),
    { pack: '3', distrito: 'Surco', direccion: null, nombre: 'María' })
  assert.ok(colageno.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'otro motivo', slots }),
    'con pack + distrito + nombre también cuenta aunque la razón no diga PEDIDO')
})

test('venta: NO es venta si no escaló, si es provincia sin datos, o si solo se ofreció', () => {
  assert.equal(colageno.detectarVentaCerrada({ debeEscalar: false, razonEscalamiento: 'PEDIDO: x', slots: {} }), null)
  assert.equal(colageno.detectarVentaCerrada({ debeEscalar: true, razonEscalamiento: 'quiere envío a Trujillo (provincia)', slots: { distrito: 'Trujillo' } }), null)
  assert.equal(exportacion.detectarVentaCerrada, undefined, 'exportación cierra en la llamada, no por chat')
})

test('venta: los 3 motores de fondo excluyen a quien ya compró', () => {
  const motor = readFileSync(join(SRC, 'motor', 'followupEngine.js'), 'utf8')
  const exclusiones = motor.match(/NOT \(ls\.slots_filled \? '_pedido'\)/g) || []
  assert.equal(exclusiones.length, 3, 'followups, recordatorios de compromiso y rescate de escalados')
})

// ── Webhook ─────────────────────────────────────────────────────────────

test('webhook: sin WEBHOOK_SECRET configurado no bloquea (compatibilidad)', () => {
  assert.equal(secretoWebhookValido({ headers: {} }, ''), true)
})

test('webhook: acepta el secreto por header, Bearer o ?secret=; rechaza el resto', () => {
  const S = 'secreto-de-prueba-123'
  assert.equal(secretoWebhookValido({ headers: { 'x-webhook-secret': S } }, S), true)
  assert.equal(secretoWebhookValido({ headers: { authorization: `Bearer ${S}` } }, S), true)
  assert.equal(secretoWebhookValido({ headers: {}, query: { secret: S } }, S), true)
  assert.equal(secretoWebhookValido({ headers: {} }, S), false, 'sin secreto')
  assert.equal(secretoWebhookValido({ headers: { 'x-webhook-secret': 'otro' } }, S), false, 'largo distinto')
  assert.equal(secretoWebhookValido({ headers: { 'x-webhook-secret': S.replace('1', '9') } }, S), false, 'mismo largo, otro valor')
})

test('webhook: una instancia desconocida ya no cae al tenant por defecto', () => {
  const router = readFileSync(join(SRC, 'webhook', 'event-router.js'), 'utf8')
  assert.match(router, /resolvedBy === 'active_tenant_fallback' && process\.env\.ALLOW_TENANT_FALLBACK !== 'true'/)
})

// ── PIN ─────────────────────────────────────────────────────────────────

test('pin: el hash verifica el PIN correcto y rechaza los demás', () => {
  const h = hashPin('4827')
  assert.ok(esHash(h))
  assert.ok(!h.includes('4827'), 'el PIN no queda legible')
  assert.equal(verificarPin('4827', h), true)
  assert.equal(verificarPin('4828', h), false)
  assert.notEqual(hashPin('4827'), h, 'sal aleatoria: dos hashes del mismo PIN difieren')
})

test('pin: los PIN heredados en texto plano siguen entrando (migración sin ventana)', () => {
  assert.equal(verificarPin('0000', '0000'), true)
  assert.equal(verificarPin('1234', '0000'), false)
  assert.equal(verificarPin(null, '0000'), false)
})

test('pin: un PIN nuevo no puede ser trivial ni tener otro largo', () => {
  assert.equal(validarPinNuevo('4827'), null)
  assert.ok(validarPinNuevo('0000'))
  assert.ok(validarPinNuevo('1234'))
  assert.ok(validarPinNuevo('12a4'))
  assert.ok(validarPinNuevo('482'))
})

// ── Traza por turno ─────────────────────────────────────────────────────

test('turn_trace: la fila guarda proveedor, fallback, costos y guardrails del turno', () => {
  const fila = filaTurnTrace({
    leadId: 7, mensajeActual: 'quiero el de 3', latencyMs: 1234.6, tenantId: 'bioayur',
    estadoAntes: { stage: 'presenting' }, estadoDespues: { stage: 'call_scheduling' },
    brainResult: {
      ok: true, mensaje: '¡Listo!', momento_actual: 'M5', stage_sugerido: 'call_scheduling',
      guardrail_flags: ['re_saludo_limpiado'], razonamiento: 'x',
      audit: { proveedor: 'groq:openai/gpt-oss-120b', model: 'openai/gpt-oss-120b', fallback: true, tokens: 900, cost_usd: null }
    }
  })
  assert.equal(fila.modelUsed, 'groq:openai/gpt-oss-120b')
  assert.equal(fila.auditLog.fallback, true)
  assert.equal(fila.latencyMs, 1235)
  assert.deepEqual(fila.guardrails, ['re_saludo_limpiado'])
  assert.equal(fila.policyDecision.tenantId, 'bioayur')
  assert.deepEqual(fila.errors, [])
  assert.deepEqual(fila.modelCosts, {})
})

test('turn_trace: un turno FALLIDO también deja rastro con el error', () => {
  const fila = filaTurnTrace({ leadId: 1, mensajeActual: 'hola', brainResult: { ok: false, error: 'brain_json_parse_failed', error_metadata: { parse_error: 'x' } } })
  assert.equal(fila.errors[0].error, 'brain_json_parse_failed')
  assert.equal(fila.botResponse, null)
})

test('aviso al vendedor por plantilla de Meta: 3 variables limpias (sin saltos ni espacios de más)', () => {
  // Un pedido confirmado que el vendedor no ve es una venta perdida: fuera de las 24 h,
  // Meta solo deja pasar una plantilla, y rechaza variables con saltos de línea.
  const [body] = componentesAvisoVendedor({ nombre: 'Rosa', motivo: 'PEDIDO: 3 envases,\n  Rosa,     Surco', telefono: '+51 987 654 321' })
  assert.equal(body.type, 'body')
  assert.deepEqual(body.parameters.map(p => p.text), ['Rosa', 'PEDIDO: 3 envases, Rosa, Surco', 'https://wa.me/51987654321'])
  const sinNombre = componentesAvisoVendedor({ nombre: null, motivo: '', telefono: '51999' })[0].parameters
  assert.equal(sinNombre[0].text, 'Cliente sin nombre')
  assert.equal(sinNombre[1].text, '-', 'Meta no acepta una variable vacía')
})
