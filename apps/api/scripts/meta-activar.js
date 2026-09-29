// scripts/meta-activar.js — revisa y termina la conexión del número con la API de Meta (sep 2026).
//
// El panel de Meta deja pasar dos pasos que no se ven y sin los cuales el bot no recibe
// nada: (1) suscribir la app a la cuenta de WhatsApp (WABA) — sin eso, la prueba del
// webhook funciona pero los mensajes de clientes reales NUNCA llegan — y (2) registrar
// el número en la Cloud API con un PIN de 6 dígitos. Este script revisa todo y, con
// --aplicar, hace esos dos pasos por la API.
//
// Uso (desde apps/api; lee CLOUD_* del .env de la RAÍZ, el token nunca se imprime):
//   node scripts/meta-activar.js                         → solo revisa
//   node scripts/meta-activar.js --aplicar               → suscribe la app a la WABA si falta
//   node scripts/meta-activar.js --aplicar --pin 123456  → además registra el número
//
// ⚠️ Meta permite 10 intentos de registro por número cada 72 h (error 133016 = bloqueado
// 72 h). Si el número ya tenía verificación en dos pasos, el PIN es ESE, no uno nuevo.

import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* sin .env: variables del entorno */ }

const args = process.argv.slice(2)
const valor = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const aplicar = args.includes('--aplicar')
const pin = valor('--pin')
const servidor = (valor('--servidor') || 'https://whatsapp-sales-backend.onrender.com').replace(/\/+$/, '')

const token = process.env.CLOUD_ACCESS_TOKEN
const phoneNumberId = process.env.CLOUD_PHONE_NUMBER_ID
const wabaId = process.env.CLOUD_WABA_ID
const graph = `https://graph.facebook.com/${process.env.CLOUD_API_VERSION || 'v23.0'}`

const faltan = ['CLOUD_ACCESS_TOKEN', 'CLOUD_PHONE_NUMBER_ID', 'CLOUD_WABA_ID'].filter(k => !process.env[k])
if (faltan.length) {
  console.error(`✖ Faltan en el .env de la raíz: ${faltan.join(', ')} (los da el panel de Meta).`)
  process.exit(1)
}
if (pin && !/^\d{6}$/.test(pin)) {
  console.error('✖ El PIN tiene que ser de 6 dígitos.')
  process.exit(1)
}

async function meta(ruta, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${graph}/${ruta}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    const e = data.error || {}
    throw new Error(`${res.status} ${e.code || ''}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.message || 'sin detalle'}`)
  }
  return data
}

const ok = (m) => console.log(`✔ ${m}`)
const mal = (m) => console.log(`✖ ${m}`)
const aviso = (m) => console.log(`⚠ ${m}`)
let problemas = 0

// 1. El token sirve y ve la cuenta de WhatsApp
try {
  const waba = await meta(`${wabaId}?fields=id,name,currency,timezone_id`)
  ok(`Token válido · cuenta de WhatsApp "${waba.name}" (${waba.id})`)
} catch (e) {
  mal(`El token no puede leer la WABA ${wabaId}: ${e.message}`)
  console.log('  → Revisa que el usuario del sistema tenga asignada la cuenta de WhatsApp con control total')
  console.log('    y que el token tenga whatsapp_business_messaging y whatsapp_business_management.')
  process.exit(1)
}

// 2. El número
let registrado = false
try {
  const n = await meta(`${phoneNumberId}?fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type,status,messaging_limit_tier`)
  console.log(`  Número: ${n.display_phone_number} · nombre "${n.verified_name}" (${n.name_status || '?'}) · calidad ${n.quality_rating || '?'} · límite ${n.messaging_limit_tier || '?'}`)
  if (n.code_verification_status !== 'VERIFIED') { mal(`El número no está verificado por SMS/llamada (${n.code_verification_status}). Hazlo en WhatsApp Manager.`); problemas++ }
  registrado = n.platform_type === 'CLOUD_API' && n.status === 'CONNECTED'
  if (registrado) ok('Número registrado en la Cloud API (CONNECTED)')
  else aviso(`Número aún no registrado en la Cloud API (platform_type=${n.platform_type}, status=${n.status})`)
  if (n.name_status && !/APPROVED|AVAILABLE_WITHOUT_REVIEW/.test(n.name_status)) aviso(`El nombre visible está en "${n.name_status}": los mensajes salen, pero con el número en vez del nombre hasta que Meta lo apruebe.`)
} catch (e) {
  mal(`No se pudo leer el número ${phoneNumberId}: ${e.message}`)
  process.exit(1)
}

// 3. La app suscrita a la WABA (sin esto no llegan los mensajes reales)
try {
  const subs = await meta(`${wabaId}/subscribed_apps`)
  const apps = (subs.data || []).map(a => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id || '?')
  if (apps.length) ok(`App suscrita a la cuenta de WhatsApp: ${apps.join(', ')}`)
  else if (aplicar) {
    await meta(`${wabaId}/subscribed_apps`, { method: 'POST' })
    ok('App suscrita a la cuenta de WhatsApp (recién hecho)')
  } else { aviso('La app NO está suscrita a la cuenta de WhatsApp → repite con --aplicar'); problemas++ }
} catch (e) {
  mal(`Suscripción de la app: ${e.message}`); problemas++
}

// 4. Registro del número con PIN
if (!registrado) {
  if (aplicar && pin) {
    try {
      await meta(`${phoneNumberId}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin } })
      ok('Número registrado en la Cloud API (recién hecho). Guarda el PIN: es la verificación en dos pasos del número.')
    } catch (e) {
      mal(`Registro: ${e.message}`); problemas++
      if (/133016/.test(e.message)) console.log('  → Demasiados intentos: Meta bloquea el registro 72 h.')
      if (/133005|PIN/i.test(e.message)) console.log('  → PIN incorrecto: si el número ya tenía verificación en dos pasos, usa ese PIN.')
    }
  } else {
    aviso('Para registrarlo: --aplicar --pin <6 dígitos> (máximo 10 intentos cada 72 h)'); problemas++
  }
}

// 5. Nuestro servidor responde el saludo del webhook (lo que Meta prueba al guardar la URL)
if (process.env.CLOUD_VERIFY_TOKEN) {
  try {
    const reto = String(Date.now())
    const url = `${servidor}/webhook/cloud?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.CLOUD_VERIFY_TOKEN)}&hub.challenge=${reto}`
    const res = await fetch(url)
    const txt = await res.text()
    if (res.ok && txt.trim() === reto) ok(`El servidor responde el saludo de Meta (${servidor}/webhook/cloud)`)
    else { mal(`El servidor no devolvió el reto (HTTP ${res.status}). ¿Está CLOUD_VERIFY_TOKEN en Render, igual que aquí, y desplegado el código nuevo?`); problemas++ }
  } catch (e) {
    mal(`No se pudo llegar al servidor: ${e.message}`); problemas++
  }
} else {
  aviso('Sin CLOUD_VERIFY_TOKEN en el .env local: no pude probar el saludo del webhook.')
}

console.log(problemas ? `\n${problemas} pendiente(s).` : '\nTodo listo del lado de Meta. Falta registrar el canal: node scripts/canal-cloud.js --tenant <cliente> --phone-number-id <id> --aplicar')
process.exit(problemas ? 1 : 0)
