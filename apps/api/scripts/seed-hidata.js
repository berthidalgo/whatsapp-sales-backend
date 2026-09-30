// scripts/seed-hidata.js — ALTA DEL CLIENTE HIDATA IMPORTACIONES (sep 2026)
//
// 100% ADITIVO E IDEMPOTENTE: solo upserts del tenant 'hidata'. No toca a bioayur ni a
// peru_exporta. Sin --aplicar SIMULA (muestra lo que haría y no escribe nada).
//
//   node scripts/seed-hidata.js             → simula
//   node scripts/seed-hidata.js --aplicar   → escribe
//
// Crea: TenantSettings(hidata) + Vendor ADMIN (el dueño, PIN de fábrica que el CRM
// obliga a cambiar al primer ingreso) + la campaña GENERAL de la tienda (vertical
// 'tienda', marcada por defecto: la reciben los clientes que no llegan por el anuncio
// de un producto con campaña propia). El canal del número va aparte: canal-cloud.js.
//
// Modelo de Hidata: producto ganador que rota. Cada producto que se escale lleva SU
// campaña (con su ficha: precio, oferta, características) y sus triggers; esta general
// solo sabe lo del negocio (envío a todo el Perú, contraentrega) y deriva lo demás.

import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '..', '..', '.env') })
dotenv.config()
import { PrismaClient } from '@prisma/client'

const APLICAR = process.argv.includes('--aplicar')
const TENANT = 'hidata'

export const CONFIG_CAMPANA_GENERAL = {
  vertical: 'tienda',
  agente: {
    nombre: 'Joan',
    empresa: 'Hidata Importaciones',
    rol: 'asesor de ventas de Hidata Importaciones'
  },
  factSheet: {
    publicoObjetivo: 'Personas de todo el Perú que vieron un anuncio de un producto importado (juguetes, hogar o tecnología).',
    propuestaValor: 'Productos importados con envío a todo el Perú y pago contraentrega: pagas al recibir tu pedido.',
    metodosPago: ['Contraentrega: pagas al recibir tu pedido, en efectivo, Yape o Plin'],
    faqs: [
      { p: '¿Hacen envíos a provincia?', r: 'Sí, enviamos a todo el Perú y pagas al recibir.' },
      { p: '¿Tienen tienda física?', r: 'Somos una tienda online: te lo llevamos a domicilio y pagas al recibir.' },
      { p: '¿Cuánto demora el envío?', r: 'El equipo te confirma el plazo exacto por este chat según tu ciudad.' }
    ],
    reglasOro: [
      'Esta es la ficha GENERAL de la tienda: si el cliente pregunta por un producto concreto y su precio no está aquí, NO lo inventes — pregúntale qué producto vio, dile que le confirmas precio y disponibilidad, y marca debe_escalar_humano=true.',
      'Nunca pidas pagos por adelantado: siempre contraentrega.'
    ]
  },
  atribucion: { esCampanaDefault: true }
}

async function main() {
  console.log(`🌱 Alta de Hidata Importaciones (${APLICAR ? 'APLICANDO' : 'simulación: no escribe nada'})`)
  const prisma = new PrismaClient({ log: ['error'] })
  try {
    const existe = await prisma.tenantSettings.findUnique({ where: { tenantId: TENANT }, select: { tenantId: true } })
    console.log(`  TenantSettings "${TENANT}": ${existe ? 'ya existe (no se pisa)' : 'se crea'}`)
    console.log('  Vendor ADMIN: Joan (PIN de fábrica, el CRM obliga a cambiarlo)')
    console.log('  Campaña HIDATA-TIENDA: vertical tienda, por defecto, ficha general del negocio')
    if (!APLICAR) { console.log('\nSimulación. Repite con --aplicar para escribir.'); return }

    await prisma.tenantSettings.upsert({
      where: { tenantId: TENANT },
      update: {},
      create: {
        tenantId: TENANT,
        displayName: 'Hidata Importaciones',
        numVendedoresPagados: 1,
        estadoSuscripcion: 'active',
        notas: 'Tienda online propia (producto ganador que rota). WhatsApp por API oficial de Meta, número +51 923 913 984. Alta por seed sep 2026.'
      }
    })
    const joan = await prisma.vendor.upsert({
      where: { tenantId_telefono: { tenantId: TENANT, telefono: '51938188585' } },
      update: {},
      create: { tenantId: TENANT, nombre: 'Joan', telefono: '51938188585', role: 'ADMIN', activo: true }
    })
    const campana = await prisma.campaign.upsert({
      where: { tenantId_slug: { tenantId: TENANT, slug: 'HIDATA-TIENDA' } },
      update: { config: CONFIG_CAMPANA_GENERAL },
      create: {
        tenantId: TENANT,
        slug: 'HIDATA-TIENDA',
        nombre: 'Hidata Importaciones — tienda (general)',
        activa: true,
        vendorId: joan.id,
        config: CONFIG_CAMPANA_GENERAL
      }
    })
    console.log(`  ✅ tenant ${TENANT} · vendor ${joan.nombre} (id ${joan.id}) · campaña ${campana.slug} (id ${campana.id})`)
    console.log('\nFalta el canal: node scripts/canal-cloud.js --tenant hidata --phone-number-id <id> --numero +51923913984 --default --aplicar')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error('✖', e.message); process.exit(1) })
