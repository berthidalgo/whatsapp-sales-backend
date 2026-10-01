// scripts/seed-generico.js — ALTA DE CLIENTES DESDE DATO (F3 forense)
//
// Los datos comerciales dejaron de vivir en .js: viven en data/tenants/*.json.
// Este script es el ÚNICO que escribe altas (tenants, vendors, campañas,
// triggers, steps). 100% aditivo e idempotente: jamás toca a otros tenants,
// jamás reescribe steps en vivo y jamás pisa el config que el equipo lleva
// por CRM (configFuente=dashboard).
//
//   node scripts/seed-generico.js --json data/tenants/bioayur.json             → simula
//   node scripts/seed-generico.js --json data/tenants/bioayur.json --aplicar   → escribe
//
// Reglas de escritura por campaña (ver data/tenants/*.json → configFuente):
//   seed       el JSON es la fuente de verdad: re-correr actualiza el config.
//   dashboard  el CRM manda: solo se crea lo que falta (config, triggers
//              ausentes); el config existente NO se pisa.
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '..', '..', '.env') })
dotenv.config()
import { PrismaClient } from '@prisma/client'
import { validarTriggers } from '../src/config/campaign-schema.js'
import { validarDatos, normalizarTelefono } from '../src/config/seed-datos.js'

function argValor(nombre) {
  const i = process.argv.indexOf(nombre)
  return i >= 0 ? process.argv[i + 1] : null
}


async function main() {
  const jsonPath = argValor('--json')
  const APLICAR = process.argv.includes('--aplicar')
  if (!jsonPath) {
    console.error('Uso: node scripts/seed-generico.js --json data/tenants/<tenant>.json [--aplicar]')
    process.exitCode = 2
    return
  }
  const ruta = resolve(process.cwd(), jsonPath)
  let datos
  try {
    datos = JSON.parse(readFileSync(ruta, 'utf8'))
  } catch (e) {
    console.error(`✖ no se pudo leer ${jsonPath}: ${e.message}`)
    process.exitCode = 2
    return
  }
  const errores = validarDatos(datos)
  if (errores.length) {
    console.error(`✖ ${jsonPath} inválido:`)
    for (const e of errores) console.error(`  · ${e}`)
    process.exitCode = 1
    return
  }

  if (!APLICAR) { console.log(JSON.stringify({ tenant: datos.tenant.tenantId, campaigns: datos.campaigns.length, modo: 'simulación sin BD' })); return }
  const prisma = new PrismaClient({ log: ['error'] })
  try {
    const TENANT = datos.tenant.tenantId
    console.log(`🌱 Alta de ${datos.tenant.displayName} (${TENANT}) — ${APLICAR ? 'APLICANDO' : 'simulación: no escribe nada'}`)

    await prisma.$transaction(async tx => {
    await tx.tenantSettings.upsert({
      where: { tenantId: TENANT },
      update: {},
      create: {
        tenantId: TENANT,
        displayName: datos.tenant.displayName,
        numVendedoresPagados: datos.tenant.numVendedoresPagados ?? 1,
        estadoSuscripcion: datos.tenant.estadoSuscripcion || 'active',
        notas: datos.tenant.notas || null
      }
    })
    console.log(`  ✅ TenantSettings: ${TENANT}`)

    const vendorPorTelefono = new Map()
    for (const v of datos.vendors) {
      const row = await tx.vendor.upsert({
        where: { tenantId_telefono: { tenantId: TENANT, telefono: normalizarTelefono(v.telefono) } },
        update: {},
        create: { tenantId: TENANT, nombre: v.nombre, telefono: String(v.telefono), role: v.role || 'VENDOR', activo: true }
      })
      vendorPorTelefono.set(String(v.telefono), row)
      console.log(`  ✅ Vendor: ${row.nombre} (id ${row.id})`)
    }

    for (const c of datos.campaigns) {
      const vendor = vendorPorTelefono.get(normalizarTelefono(c.vendorTelefono))
      const slug = String(c.slug).toUpperCase()
      const existente = await tx.campaign.findFirst({ where: { tenantId: TENANT, slug }, select: { id: true, config: true, version: true } })
      const fuente = c.configFuente || 'seed'
      let campana
      if (!existente) {
        campana = await tx.campaign.create({
          data: {
            tenantId: TENANT, slug, nombre: c.nombre, activa: c.activa !== false,
            vendorId: vendor.id,
            ...(c.config ? { config: c.config } : {}),
            ...(c.steps?.length ? {
              steps: {
                create: c.steps.map((s, i) => ({ orden: i + 1, tipo: s.tipo, mensaje: s.mensaje, followupHrs: s.followupHrs || null }))
              }
            } : {})
          }
        })
        console.log(`  ✅ Campaign creada: ${slug} (id ${campana.id})`)
      } else {
        campana = existente
        // El guion en vivo no se reescribe; el config solo si el JSON manda.
        if (c.config && fuente === 'seed') {
          await tx.campaign.update({ where: { id: existente.id, tenantId: TENANT, version: existente.version }, data: { config: c.config, version: { increment: 1 } } })
          console.log(`  ✅ Campaign ${slug}: config actualizado (fuente=seed)`)
        } else if (c.config && existente.config) {
          console.log(`  ↩︎ Campaign ${slug}: config de BD intacto (fuente=dashboard)`)
        } else if (c.config && !existente.config) {
          await tx.campaign.update({ where: { id: existente.id, tenantId: TENANT, version: existente.version }, data: { config: c.config, version: { increment: 1 } } })
          console.log(`  ✅ Campaign ${slug}: config inicial creado (no tenía)`)
        } else {
          console.log(`  ↩︎ Campaign ${slug}: ya existía`)
        }
      }
      const vt = (c.triggers || []).length ? validarTriggers(c.triggers).valores : []
      if (vt.length) {
        const existentes = await tx.trigger.findMany({ where: { campaignId: campana.id }, select: { texto: true } })
        const yaTiene = new Set(existentes.map(t => t.texto))
        for (const texto of vt) {
          if (!yaTiene.has(texto)) {
            await tx.trigger.create({ data: { texto, campaignId: campana.id } })
            console.log(`  ✅ Trigger: "${texto}"`)
          }
        }
      }
    }
    }, { timeout: 30000 })
    console.log('\n🎉 Alta completa (aditiva: ningún otro tenant tocado).')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error('✖', e.message); process.exitCode = 1 })
