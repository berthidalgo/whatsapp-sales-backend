// tests/multitenant-routing.test.js — EL CANDADO DEL MULTITENANT (jul 2026)
//
// Estos tests protegen la invariante que hace posible atender a varios clientes
// desde un solo deploy: EL BOT RESPONDE POR EL MISMO NÚMERO QUE RECIBIÓ EL MENSAJE.
//
// El bug que previenen es concreto y ya existió: el handler enviaba con
// `process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'`. Con dos clientes
// activos, cualquier fallo de resolución hacía que los leads de BIOAYUR recibieran
// respuesta desde el número de Perú Exporta — un cliente viendo el número de otro.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { instanciaDeSalida } from '../src/webhook/handler.js'
import { summarizeChannelResolution } from '../src/webhook/channel-resolver.js'
import { resolveTenantForLogin } from '../src/routes/auth.js'

// ════════════════════════════════════════════════════════
// INSTANCIA DE SALIDA — por dónde responde el bot
// ════════════════════════════════════════════════════════

test('salida: manda el canal que RECIBIÓ el mensaje (caso multitenant normal)', () => {
  const salida = instanciaDeSalida({
    leadId: 42,
    tenantId: 'bioayur',
    channel: { externalKey: 'bioayur', tenantId: 'bioayur' },
    instanciaEvolution: 'peru-exporta-test'   // ruido: el vendor dice otra cosa
  })
  assert.equal(salida, 'bioayur', 'el canal entrante gana sobre cualquier otra fuente')
})

test('salida: sin canal resuelto, usa la instancia del vendedor dueño', () => {
  const salida = instanciaDeSalida({
    leadId: 7, tenantId: 'peru_exporta', channel: null,
    instanciaEvolution: 'peru-exporta-cristina'
  })
  assert.equal(salida, 'peru-exporta-cristina')
})

test('salida: sin canal ni vendor, cae a la env var (compat single-tenant)', () => {
  const prev = process.env.EVOLUTION_INSTANCE_NAME
  process.env.EVOLUTION_INSTANCE_NAME = 'instancia-del-entorno'
  try {
    assert.equal(instanciaDeSalida({ leadId: 1, tenantId: 'peru_exporta' }), 'instancia-del-entorno')
  } finally {
    if (prev === undefined) delete process.env.EVOLUTION_INSTANCE_NAME
    else process.env.EVOLUTION_INSTANCE_NAME = prev
  }
})

test('REGRESIÓN: sin ninguna fuente devuelve null — JAMÁS un número hardcodeado', () => {
  const prev = process.env.EVOLUTION_INSTANCE_NAME
  delete process.env.EVOLUTION_INSTANCE_NAME
  try {
    const salida = instanciaDeSalida({ leadId: 99, tenantId: 'academia_julio' })
    assert.equal(salida, null, 'preferimos fallar ruidosamente a responder por el número de otro cliente')
    assert.notEqual(salida, 'peru-exporta-test', 'el literal viejo no puede volver')
  } finally {
    if (prev !== undefined) process.env.EVOLUTION_INSTANCE_NAME = prev
  }
})

test('salida: un tenant nuevo sin canal NO hereda el de otro cliente', () => {
  const prev = process.env.EVOLUTION_INSTANCE_NAME
  delete process.env.EVOLUTION_INSTANCE_NAME
  try {
    // La academia de Julio entra sin canal sembrado: no debe salir por BIOAYUR
    // ni por Perú Exporta. Cualquier string aquí sería una fuga entre clientes.
    assert.equal(instanciaDeSalida({ leadId: 1, tenantId: 'academia_julio', channel: null }), null)
  } finally {
    if (prev !== undefined) process.env.EVOLUTION_INSTANCE_NAME = prev
  }
})

// ════════════════════════════════════════════════════════
// TENANT EN EL LOGIN (pre-auth, sin JWT del cual derivarlo)
// ════════════════════════════════════════════════════════

test('login: ?tenant= explícito manda', () => {
  assert.equal(resolveTenantForLogin({ query: { tenant: 'bioayur' }, headers: {} }), 'bioayur')
})

test('login: deriva el tenant del dominio del CRM (TENANT_ORIGINS)', () => {
  const prev = process.env.TENANT_ORIGINS
  process.env.TENANT_ORIGINS = 'crm.bioayur.com=bioayur,crm.peruexporta.com=peru_exporta'
  try {
    assert.equal(
      resolveTenantForLogin({ query: {}, headers: { origin: 'https://crm.bioayur.com' } }),
      'bioayur'
    )
    assert.equal(
      resolveTenantForLogin({ query: {}, headers: { origin: 'https://crm.peruexporta.com:443' } }),
      'peru_exporta',
      'el puerto no debe romper el match'
    )
  } finally {
    if (prev === undefined) delete process.env.TENANT_ORIGINS
    else process.env.TENANT_ORIGINS = prev
  }
})

test('login: sin pistas cae a ACTIVE_TENANT (cero regresión del deploy actual)', () => {
  const esperado = process.env.ACTIVE_TENANT || 'peru_exporta'
  assert.equal(resolveTenantForLogin({ query: {}, headers: {} }), esperado)
})

test('login: el query param gana sobre el origin', () => {
  const prev = process.env.TENANT_ORIGINS
  process.env.TENANT_ORIGINS = 'crm.bioayur.com=bioayur'
  try {
    assert.equal(
      resolveTenantForLogin({ query: { tenant: 'peru_exporta' }, headers: { origin: 'https://crm.bioayur.com' } }),
      'peru_exporta'
    )
  } finally {
    if (prev === undefined) delete process.env.TENANT_ORIGINS
    else process.env.TENANT_ORIGINS = prev
  }
})

// ════════════════════════════════════════════════════════
// OBSERVABILIDAD — el log debe delatar una resolución débil
// ════════════════════════════════════════════════════════

test('summarize: distingue resolución por canal vs fallback', () => {
  const fuerte = summarizeChannelResolution({
    resolvedBy: 'channel', externalKey: 'bioayur', tenantId: 'bioayur', provider: 'evolution'
  })
  assert.match(fuerte, /bioayur → bioayur/)

  const debil = summarizeChannelResolution({
    resolvedBy: 'active_tenant_fallback', externalKey: 'x', tenantId: 'peru_exporta', provider: 'evolution'
  })
  assert.match(debil, /fallback/, 'un fallback debe ser visible en los logs, no silencioso')
})
