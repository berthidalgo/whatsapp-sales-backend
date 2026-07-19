// scripts/seed-bioayur.js — SEED DEL TENANT BIOAYUR (jul 2026)
//
// 100% ADITIVO E IDEMPOTENTE: solo upserts de entidades del tenant 'bioayur'.
// NO toca ni una fila de peru_exporta (que queda dormido con su config intacta).
// Correr:  node scripts/seed-bioayur.js   (usa DATABASE_URL del entorno/.env raíz)
//
// Crea: TenantSettings(bioayur) + Vendor Jhon + Campaign BIOAYUR-ELIXIR con
// vertical 'colageno', el factSheet completo (arte de precios + .md del dueño)
// y los triggers de atribución del anuncio.

import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// El .env vive en la RAÍZ del monorepo (no en apps/api) → carga explícita.
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '..', '..', '.env') })
dotenv.config()   // y el local si existiera (no pisa valores ya seteados)
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient({ log: ['error'] })

async function main() {
  console.log('🌱 Seed BIOAYUR — tenant + vendor + campaña (aditivo, no toca peru_exporta)')

  // ─── 1. TenantSettings ───
  const tenant = await prisma.tenantSettings.upsert({
    where: { tenantId: 'bioayur' },
    update: {},   // si ya existe, no pisar ajustes hechos a mano
    create: {
      tenantId: 'bioayur',
      displayName: 'BIOAYUR (DermaLab)',
      numVendedoresPagados: 1,
      estadoSuscripcion: 'active',
      notas: 'Cliente real #1 del vertical colágeno (e-commerce nutracéutico, Lima). Producto: ELIXIR. Contraentrega. Creado por seed jul 2026.'
    }
  })
  console.log(`  ✅ TenantSettings: ${tenant.tenantId} (${tenant.displayName})`)

  // ─── 2. Vendor Jhon (el asesor de BIOAYUR) ───
  // El teléfono es UNIQUE global y 51924104066 ya pertenece al vendor histórico
  // "Joan" (peru_exporta) → usamos un placeholder único para el registro del CRM.
  // Las notificaciones de escalamiento salen por NUMERO_JOAN (env) = el número
  // real del dueño, así que operativamente los pedidos le llegan igual.
  const jhon = await prisma.vendor.upsert({
    where: { telefono: '51999000001' },
    update: {},
    create: {
      tenantId: 'bioayur',
      nombre: 'Jhon',
      telefono: '51999000001',
      role: 'ADMIN',
      activo: true
    }
  })
  console.log(`  ✅ Vendor: ${jhon.nombre} (id ${jhon.id}, tenant ${jhon.tenantId})`)

  // ─── 3. Campaña BIOAYUR ELIXIR ───
  const config = {
    vertical: 'colageno',
    agente: {
      nombre: 'Jhon',
      empresa: 'BIOAYUR',
      rol: 'asesor comercial de BIOAYUR',
      nombreProducto: 'BIOAYUR ELIXIR'
    },
    comportamiento: {
      agentGoal: 'CERRAR_PEDIDO_CONTRAENTREGA'
    },
    factSheet: {
      precio: {
        // El texto exacto lista LOS 3 PACKS → el guardrail de precio fantasma
        // valida cualquier cifra del mensaje contra estos dígitos.
        textoExacto: '1 envase: S/ 139 · 2 envases: S/ 249 (sale S/ 124.50 c/u) · 3 envases: S/ 339 (sale S/ 113 c/u) — EL MÁS RECOMENDADO (tratamiento completo de 3 meses). Cada envase dura 1 mes.',
        monto: 139,
        moneda: 'S/'
      },
      incluye: [
        'Colágeno hidrolizado 10g por porción',
        'Resveratrol 300mg',
        'Vitamina C 500mg',
        'Magnesio 400mg',
        'Zinc 10mg',
        'Antioxidantes de frutos rojos 3g'
      ],
      fechasReales: {
        modalidad: 'Envío GRATIS en Lima · pago CONTRAENTREGA (pagas al recibir; si no llega, no pagas)'
      },
      metodosPago: ['Contraentrega: pagas en efectivo o Yape AL RECIBIR tu pedido en tu puerta (nunca por adelantado)'],
      pildorasValor: [
        'Registro Sanitario DIGEMID P2908325N · elaborado bajo BPM',
        'Sin azúcar, sin gluten, sin lactosa — endulzado con stevia',
        'Sabor frutos rojos · envase de 300g (~20 porciones = 1 mes)',
        'Se toma 1 porción (15g) al día, disuelta en agua fría, jugo o batido',
        'El colágeno funciona con CONSTANCIA: resultados se notan a partir de los 3 meses (por eso el pack de 3 es el recomendado)',
        'PIEL: colágeno + vitamina C · CABELLO/UÑAS: zinc · ARTICULACIONES: colágeno + magnesio · ENERGÍA: magnesio + antioxidantes',
        'Muy pocos colágenos en Perú traen la fórmula completa (la mayoría vende colágeno solo)'
      ],
      publicoObjetivo: 'Mujeres de 30 a 60 años, Lima (también sirve para hombres)',
      propuestaValor: 'ELIXIR no es un colágeno más: es LA FÓRMULA COMPLETA — 5 activos en un solo vaso que reemplazan comprar colágeno, magnesio, zinc y antioxidantes por separado',
      reglasOro: [
        'PROHIBIDO decir "curar/cura/sana/trata enfermedades" — SOLO "apoya/favorece/contribuye/ayuda a" (regla legal DIGEMID + Meta)',
        'NUNCA pedir pago por adelantado ni dar cuentas/Yape: el modelo es contraentrega',
        'NUNCA inventar descuentos, regalos ni promos fuera de esta ficha — "la oferta de hoy" son exactamente estos packs'
      ]
    },
    atribucion: {
      // Plan C del campaign-resolver: si el texto libre no matchea ningún trigger,
      // esta campaña es la default del tenant y responde con el riel del dolor.
      esCampanaDefault: true,
      mensajeDescubrimiento: '¡Con gusto te cuento todo! 😊 Para dártelo exacto y no marearte con info de más — cuéntame, ¿qué es lo que más te gustaría mejorar: tu piel, tu energía o tus articulaciones? 👀'
    }
  }

  const campana = await prisma.campaign.upsert({
    where: { slug: 'BIOAYUR-ELIXIR' },
    update: { config },   // el config SÍ se actualiza al re-correr (fuente de verdad = este seed hasta que exista dashboard)
    create: {
      tenantId: 'bioayur',
      slug: 'BIOAYUR-ELIXIR',
      nombre: 'BIOAYUR ELIXIR — Colágeno Fórmula Completa',
      activa: true,
      vendorId: jhon.id,
      config
    }
  })
  console.log(`  ✅ Campaign: ${campana.slug} (id ${campana.id}, vertical ${config.vertical})`)

  // ─── 4. Triggers de atribución (los textos que disparan ESTA campaña) ───
  // El resolver matchea por CONTENCIÓN normalizada (sin tildes/símbolos) del
  // primer mensaje del lead. El predeterminado del anuncio es:
  // "Hola ✨ Vi la promoción de ELIXIR y quiero aprovechar la oferta de hoy"
  const triggers = [
    'elixir',                          // la palabra ancla del producto (cubre el predeterminado)
    'quiero aprovechar la oferta',     // el predeterminado B aunque borren "ELIXIR"
    'vi la promocion',                 // variante corta
    'colageno'                         // orgánico: "info del colageno"
  ]
  const existentes = await prisma.trigger.findMany({
    where: { campaignId: campana.id },
    select: { texto: true }
  })
  const yaTiene = new Set(existentes.map(t => t.texto))
  for (const texto of triggers) {
    if (!yaTiene.has(texto)) {
      await prisma.trigger.create({ data: { texto, campaignId: campana.id } })
      console.log(`  ✅ Trigger: "${texto}"`)
    } else {
      console.log(`  ↩︎ Trigger ya existía: "${texto}"`)
    }
  }

  console.log('\n🎉 Seed BIOAYUR completo. peru_exporta intacto (ni una fila tocada).')
  console.log('   Para activar el tenant en Render: ACTIVE_TENANT=bioayur')
}

main()
  .catch(e => { console.error('❌ Seed falló:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
