// tests/schema-multitenant.test.js — LAS INVARIANTES DE LA BASE MULTITENANT
//
// POR QUÉ EXISTE:
//   El dueño quiere una base "robusta, robusta" para conectar cliente tras cliente sin
//   que se mezclen. Las reglas que hacen eso posible viven en el SCHEMA, y son fáciles
//   de romper sin querer al agregar un modelo o un índice. Este test lee schema.prisma
//   y falla si alguien reintroduce uno de los dos errores que ya nos costaron caro:
//
//     1. UNIQUE GLOBAL en una columna de negocio de una tabla con tenant.
//        (slug/telefono/whatsappNumber @unique global → el 2º cliente no puede dar de
//         alta una campaña "PROMO" ni un vendedor con un número ya usado por otro.)
//
//     2. @default en la columna tenant_id.
//        (un insert que olvide el tenant cae SILENCIOSAMENTE en ese default en vez de
//         fallar → fue la causa raíz de toda la contaminación entre clientes.)
//
//   No valida datos ni toca la BD: solo el contrato estructural. Es el cimiento.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma')
const fuente = readFileSync(SCHEMA, 'utf8')

// Parte el schema en bloques `model X { ... }`.
function modelos(src) {
  const out = {}
  const rx = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m
  while ((m = rx.exec(src)) !== null) out[m[1]] = m[2]
  return out
}
const MODELOS = modelos(fuente)

// Tablas que llevan tenant_id propio (el resto se aísla por FK a una de estas).
const CON_TENANT = Object.entries(MODELOS)
  .filter(([, body]) => /\btenantId\b.*@map\("tenant_id"\)|\btenantId\s+String/.test(body))
  .map(([name]) => name)

test('sanity: se parsearon los modelos con tenant', () => {
  // Si esto baja de golpe, el parser dejó de entender el schema (formato cambiado).
  assert.ok(CON_TENANT.includes('Vendor') && CON_TENANT.includes('Campaign') && CON_TENANT.includes('Lead'),
    `esperaba Vendor/Campaign/Lead entre los modelos con tenant, encontré: ${CON_TENANT.join(', ')}`)
})

// ════════════════════════════════════════════════════════
// 1. Ninguna columna de negocio con @unique GLOBAL en tabla con tenant
// ════════════════════════════════════════════════════════
test('schema: sin @unique global en columnas de tablas con tenant', () => {
  // externalKey (Channel) es la EXCEPCIÓN legítima: es la llave de routing del webhook
  // entrante y DEBE ser única global (una instancia/número no puede ser de dos tenants).
  const EXCEPCIONES = new Set(['externalKey'])
  const culpables = []

  for (const modelo of CON_TENANT) {
    const body = MODELOS[modelo]
    for (const linea of body.split('\n')) {
      const m = linea.match(/^\s*(\w+)\s+\S+.*@unique\b/)
      if (m && !EXCEPCIONES.has(m[1])) {
        culpables.push(`${modelo}.${m[1]}`)
      }
    }
  }

  assert.deepEqual(culpables, [],
    'Una columna de negocio es @unique GLOBAL en una tabla con tenant. Eso impide dar de ' +
    'alta un cliente que reutilice ese valor. Usa @@unique([tenantId, <campo>]).')
})

// ════════════════════════════════════════════════════════
// 2. tenant_id nunca tiene @default (forgotten-tenant debe FALLAR, no contaminar)
// ════════════════════════════════════════════════════════
test('schema: tenant_id sin @default en ninguna tabla', () => {
  const culpables = []
  for (const [modelo, body] of Object.entries(MODELOS)) {
    for (const linea of body.split('\n')) {
      // La línea que declara el tenant (por nombre de campo o por @map a tenant_id).
      const esTenant = /^\s*tenantId\b/.test(linea) || /@map\("tenant_id"\)/.test(linea)
      if (esTenant && /@default\(/.test(linea)) {
        culpables.push(`${modelo}: ${linea.trim()}`)
      }
    }
  }
  assert.deepEqual(culpables, [],
    'tenant_id tiene @default. Un insert que olvide el tenant caería ahí en silencio en vez ' +
    'de fallar — es la causa raíz de la contaminación entre clientes. Quita el default.')
})

// ════════════════════════════════════════════════════════
// 3. Las tablas núcleo declaran su @@unique([tenantId, ...]) esperado
// ════════════════════════════════════════════════════════
test('schema: las llaves compuestas por tenant existen donde deben', () => {
  assert.match(MODELOS.Lead,     /@@unique\(\[tenantId,\s*telefono\]\)/,       'Lead debe dedupar por [tenantId, telefono]')
  assert.match(MODELOS.Campaign, /@@unique\(\[tenantId,\s*slug\]\)/,           'Campaign debe unicar slug por tenant')
  assert.match(MODELOS.Vendor,   /@@unique\(\[tenantId,\s*telefono\]\)/,       'Vendor debe unicar telefono por tenant')
  assert.match(MODELOS.Vendor,   /@@unique\(\[tenantId,\s*whatsappNumber\]\)/, 'Vendor debe unicar whatsappNumber por tenant')
})

// ════════════════════════════════════════════════════════
// 4. Channel.externalKey SIGUE siendo único global (a propósito)
// ════════════════════════════════════════════════════════
test('schema: Channel.externalKey se mantiene único GLOBAL (routing del webhook)', () => {
  assert.match(MODELOS.Channel, /externalKey\s+String\s+@unique/,
    'externalKey debe ser único global: una instancia/número no puede pertenecer a dos tenants.')
})
