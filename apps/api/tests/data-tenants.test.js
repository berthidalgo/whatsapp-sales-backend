import { validarDatos } from '../src/config/seed-datos.js'
// tests/data-tenants.test.js — LOS DATOS VIVEN EN JSON, NO EN .js (F3/F4 forense)
//
// Dos garantías:
//   1. Toda ficha en data/tenants/*.json + data/*.json cumple el contrato de
//      ficha ANTES de llegar a la BD (el seed-generico valida de nuevo al aplicar).
//   2. Los scripts de alta ya no contienen dato comercial: si alguien vuelve a
//      quemar un precio o una marca en un seed, esto falla antes del deploy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validarCampaignConfig, validarTriggers } from '../src/config/campaign-schema.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR_TENANTS = join(RAIZ, 'data', 'tenants')

function soloCodigo(fuente) {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '')
}

const fichas = readdirSync(DIR_TENANTS).filter(f => f.endsWith('.json'))

test('datos: hay al menos una ficha por tenant', () => {
  assert.ok(fichas.length >= 1, 'data/tenants/*.json vacío')
})

for (const f of fichas) {
  test(`datos: ${f} — config de cada campaña cumple el contrato`, () => {
    const d = JSON.parse(readFileSync(join(DIR_TENANTS, f), 'utf8'))
    assert.deepEqual(validarDatos(d),[])
    assert.ok(d.tenant?.tenantId, 'sin tenant.tenantId')
    assert.ok(Array.isArray(d.vendors) && d.vendors.length > 0, 'sin vendors')
    assert.ok(Array.isArray(d.campaigns) && d.campaigns.length > 0, 'sin campaigns')
    const telefonos = new Set(d.vendors.map(v => String(v.telefono)))
    for (const c of d.campaigns) {
      assert.ok(telefonos.has(String(c.vendorTelefono)), `vendorTelefono ${c.vendorTelefono} sin vendor`)
      if (c.config) {
        const vc = validarCampaignConfig(c.config, { tenantId: d.tenant.tenantId })
        assert.equal(vc.ok, true, `${f}/${c.slug}: ${vc.errores.join(' | ')}`)
      }
      if (c.triggers?.length) {
        const vt = validarTriggers(c.triggers, { permitirVacios: c.config?.atribucion?.esCampanaDefault === true || c.activa === false })
        assert.equal(vt.ok, true, `${f}/${c.slug}: ${vt.errores.join(' | ')}`)
      }
    }
  })
}

test('datos: assets-legacy y sitio-publico tienen forma válida', () => {
  const legacy = JSON.parse(readFileSync(join(RAIZ, 'data', 'assets-legacy.json'), 'utf8'))
  for (const [tenant, claves] of Object.entries(legacy)) {
    if (tenant.startsWith('_')) continue
    for (const [clave, def] of Object.entries(claves)) {
      assert.ok(def.archivo || def.storageKey, `assets-legacy ${tenant}.${clave} sin archivo ni storageKey`)
    }
  }
  const sitio = JSON.parse(readFileSync(join(RAIZ, 'data', 'sitio-publico.json'), 'utf8'))
  assert.ok(sitio.negocio?.ruc, 'sitio sin negocio.ruc')
  assert.ok(Array.isArray(sitio.rubros) && sitio.rubros.length > 0, 'sitio sin rubros')
})

// Los seeds son cargadores, no fichas: ni precios ni marcas en su código.
const SEEDS = [
  join(RAIZ, 'scripts', 'seed-generico.js'),
  join(RAIZ, 'scripts', 'seed-bioayur.js'),
  join(RAIZ, 'scripts', 'seed-hidata.js'),
  join(RAIZ, 'prisma', 'seed.cjs')
]

test('gate: ningún script de alta quema precios en código', () => {
  const culpables = []
  for (const archivo of SEEDS) {
    const codigo = soloCodigo(readFileSync(archivo, 'utf8'))
    const strings = codigo.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) || []
    for (const s of strings) {
      if (/S\/\s?\d/.test(s)) culpables.push(`${archivo} → ${s.slice(0, 80)}`)
    }
  }
  assert.deepEqual(culpables, [], 'un seed volvió a quemar un precio en código: va en data/tenants/*.json')
})

test('gate: ningún script de alta nombra una marca en código', () => {
  const culpables = []
  for (const archivo of SEEDS) {
    const codigo = soloCodigo(readFileSync(archivo, 'utf8'))
    const strings = codigo.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) || []
    for (const s of strings) {
      // Las rutas a data/tenants/*.json no son marcas: son la dirección del dato.
      if (/data\/tenants\//.test(s)) continue
      if (/BIOAYUR|DermaLab|ELIXIR/i.test(s)) culpables.push(`${archivo} → ${s.slice(0, 80)}`)
    }
  }
  assert.deepEqual(culpables, [], 'un seed volvió a quemar una marca en código: va en data/tenants/*.json')
})
