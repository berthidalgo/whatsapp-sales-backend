// scripts/canal-cloud.js — registra un número de WhatsApp (API oficial de Meta) como canal
// de un cliente (sep 2026).
//
// El webhook de Meta trae el phone_number_id del número que recibió el mensaje; con esta
// fila el backend sabe de QUÉ cliente es y por dónde responder. Sin ella, los mensajes
// de ese número se ignoran (event-router y cloud/router rechazan canales desconocidos).
//
// Uso (desde apps/api):
//   node scripts/canal-cloud.js --tenant hidata --phone-number-id 123456789012345 --numero +51999999999
//   node scripts/canal-cloud.js ... --aplicar          ← recién aquí escribe en la base
//
// Opcionales:
//   --default        lo marca como canal por defecto del cliente (followups y avisos salen por él)
//   --modo X         nube_pura (default) o coexistencia. Es la MISMA API en los dos casos; en
//                    coexistencia el número sigue vivo en el celular del cliente y Meta nos manda
//                    copia de lo que él contesta desde ahí (el bot se calla solo cuando pasa).
//   --token-propio   guarda el token del .env (CLOUD_ACCESS_TOKEN) en el canal. Úsalo solo para
//                    clientes con SU cuenta de Meta; para el número de Hidata basta el .env.
//
// Lee DATABASE_URL del .env de la raíz del repo. Sin --aplicar no escribe nada.

import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* sin .env: variables del entorno */ }

const args = process.argv.slice(2)
const valor = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const flag = (k) => args.includes(k)

const tenantId = valor('--tenant')
const phoneNumberId = valor('--phone-number-id')
const numero = valor('--numero')
const modo = valor('--modo') || 'nube_pura'
const aplicar = flag('--aplicar')

function salir(msg) { console.error(`✖ ${msg}`); process.exit(1) }
if (!tenantId) salir('falta --tenant (identificador del cliente)')
if (!phoneNumberId || !/^\d{8,20}$/.test(phoneNumberId)) salir('falta --phone-number-id (el ID numérico que muestra Meta, NO el teléfono)')
if (!['nube_pura', 'coexistencia'].includes(modo)) salir('--modo debe ser nube_pura o coexistencia')

const prisma = new PrismaClient({ log: ['error'] })
try {
  const tenant = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { tenantId: true, displayName: true } })
  if (!tenant) salir(`el cliente "${tenantId}" no existe en tenant_settings. Créalo primero.`)

  const existente = await prisma.channel.findUnique({ where: { externalKey: phoneNumberId } })
  if (existente && existente.tenantId !== tenantId) {
    salir(`ese phone_number_id ya pertenece al cliente "${existente.tenantId}". Un número no puede ser de dos clientes.`)
  }

  const credenciales = { phoneNumberId }
  if (flag('--token-propio')) {
    if (!process.env.CLOUD_ACCESS_TOKEN) salir('--token-propio pide CLOUD_ACCESS_TOKEN en el .env')
    credenciales.accessToken = process.env.CLOUD_ACCESS_TOKEN
  }

  const datos = {
    tenantId,
    provider: 'cloud',
    externalKey: phoneNumberId,
    numeroDisplay: numero || null,
    modo,
    credenciales,
    activo: true,
    esDefault: flag('--default'),
    notas: `WhatsApp Cloud API (Meta). Registrado por scripts/canal-cloud.js el ${new Date().toISOString().slice(0, 10)}.`
  }

  console.log(`Cliente: ${tenant.displayName} (${tenantId})`)
  console.log(`Canal:   Meta · phone_number_id ${phoneNumberId}${numero ? ` · ${numero}` : ''}${datos.esDefault ? ' · por defecto' : ''}`)
  console.log(`Modo:    ${modo === 'coexistencia' ? 'coexistencia (el número sigue en la app del celular; sus respuestas llegan como eco y pausan al bot)' : 'nube pura (el número vive solo en Meta)'}`)
  console.log(`Token:   ${credenciales.accessToken ? 'propio del canal' : 'el del entorno (CLOUD_ACCESS_TOKEN en Render)'}`)
  console.log(existente ? 'Acción:  actualizar el canal existente' : 'Acción:  crear el canal')

  if (!aplicar) {
    console.log('\nSimulación: no se escribió nada. Repite con --aplicar para guardarlo.')
  } else {
    if (datos.esDefault) {
      await prisma.channel.updateMany({ where: { tenantId, esDefault: true, NOT: { externalKey: phoneNumberId } }, data: { esDefault: false } })
    }
    const ch = existente
      ? await prisma.channel.update({ where: { externalKey: phoneNumberId }, data: datos })
      : await prisma.channel.create({ data: datos })
    console.log(`\n✔ Canal guardado (id ${ch.id}). El backend lo toma en menos de 1 minuto (caché del resolver).`)
  }
} finally {
  await prisma.$disconnect()
}
