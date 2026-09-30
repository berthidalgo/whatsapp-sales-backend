// scripts/meta-activar.js — revisa y termina la conexión del número con la API de Meta (sep 2026).
//
// El panel de Meta deja pasar dos pasos que no se ven y sin los cuales el bot no recibe
// nada: (1) suscribir la app a la cuenta de WhatsApp (WABA) — sin eso, la prueba del
// webhook funciona pero los mensajes de clientes reales NUNCA llegan — y (2) registrar
// el número en la Cloud API con un PIN de 6 dígitos. Este script revisa todo y, con
// --aplicar, hace esos dos pasos por la API.
//
// Antes de tocar nada revisa las tres confusiones que fallan en silencio: un token que
// caduca (el de "Configuración de la API" dura 24 h), una clave secreta de OTRA app (Meta
// firmaría los webhooks con otra y los rechazaríamos todos) y la WABA equivocada (Meta crea
// una de PRUEBA al agregar WhatsApp a la app, y otra NUEVA al agregar el número real).
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

// Una variable ya definida (aunque sea vacía) gana sobre el .env: así las pruebas lo dejan fuera.
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
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
const appId = process.env.CLOUD_APP_ID
const appSecret = process.env.CLOUD_APP_SECRET

// CLOUD_GRAPH_BASE existe solo para probar el script contra un Graph de mentira EN ESTA
// máquina (igual que meta-plantillas.js): el token viaja en cada llamada.
const graphBase = process.env.CLOUD_GRAPH_BASE
if (graphBase && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(graphBase)) {
  console.error(`✖ CLOUD_GRAPH_BASE solo acepta 127.0.0.1 o localhost (pruebas). Valor recibido: ${graphBase}`)
  process.exit(1)
}
const graph = (graphBase || `https://graph.facebook.com/${process.env.CLOUD_API_VERSION || 'v23.0'}`).replace(/\/+$/, '')

const faltan = ['CLOUD_ACCESS_TOKEN', 'CLOUD_PHONE_NUMBER_ID', 'CLOUD_WABA_ID'].filter(k => !process.env[k])
if (faltan.length) {
  console.error(`✖ Faltan en el .env de la raíz: ${faltan.join(', ')} (los da el panel de Meta).`)
  process.exit(1)
}
if (pin && !/^\d{6}$/.test(pin)) {
  console.error('✖ El PIN tiene que ser de 6 dígitos.')
  process.exit(1)
}

async function meta(ruta, { method = 'GET', body = null, bearer = token } = {}) {
  const res = await fetch(`${graph}/${ruta}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

// 0. El token en sí (debug_token). Con CLOUD_APP_ID + CLOUD_APP_SECRET se pregunta con el
//    token de la app, y eso de paso prueba que la clave secreta es la de ESA app.
const conApp = Boolean(appId && appSecret)
let wabasDelToken = []
try {
  const { data: t = {} } = await meta(`debug_token?input_token=${encodeURIComponent(token)}`, conApp ? { bearer: `${appId}|${appSecret}` } : {})
  if (t.is_valid === false) { mal(`Meta dice que el token no sirve: ${t.error?.message || 'sin detalle'}`); problemas++ }
  if (conApp && t.app_id && String(t.app_id) !== String(appId)) {
    mal(`El token es de la app ${t.app_id}, no de la ${appId}: genéralo eligiendo la app de CLOUD_APP_SECRET.`); problemas++
  }
  if (t.expires_at) {
    mal(`El token caduca (${new Date(t.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC): es temporal. Genera el del usuario del sistema con caducidad «Nunca».`); problemas++
  } else if (t.is_valid) ok('El token no caduca')
  const permisos = t.scopes || []
  const sinPermiso = ['whatsapp_business_messaging', 'whatsapp_business_management'].filter(p => !permisos.includes(p))
  if (sinPermiso.length) { mal(`Al token le faltan permisos: ${sinPermiso.join(', ')} → genéralo de nuevo marcándolos.`); problemas++ } else ok('El token tiene los permisos de WhatsApp (mensajes y administración)')
  if (!permisos.includes('business_management')) aviso('El token no tiene business_management: no es imprescindible, pero sin él no se ven las cuentas del portafolio.')
  if (t.type && t.type !== 'SYSTEM_USER') aviso(`El token es de tipo ${t.type}, no de un usuario del sistema: si esa persona pierde el acceso, el bot se cae.`)
  wabasDelToken = ((t.granular_scopes || []).find(g => g.scope === 'whatsapp_business_management')?.target_ids || []).map(String)
} catch (e) {
  if (conApp) {
    mal(`Meta rechazó la consulta hecha con la app ${appId} y su clave secreta: ${e.message}`)
    console.log('  → O CLOUD_APP_SECRET no es la clave de esa app, o el token se generó para otra app: las dos cosas tienen')
    console.log('    que ser de la MISMA app (si no, rechazaríamos todos los webhooks por firma inválida).')
    problemas++
  } else aviso(`No pude inspeccionar el token (${e.message}). Con CLOUD_APP_ID en el .env se revisa mejor.`)
}

// 1. El token ve la cuenta de WhatsApp
try {
  const waba = await meta(`${wabaId}?fields=id,name,currency,timezone_id`)
  ok(`El token lee la cuenta de WhatsApp "${waba.name}" (${waba.id})`)
} catch (e) {
  mal(`El token no puede leer la WABA ${wabaId}: ${e.message}`)
  console.log('  → Revisa que el usuario del sistema tenga asignada la cuenta de WhatsApp con control total')
  console.log('    y que el token tenga whatsapp_business_messaging y whatsapp_business_management.')
  if (wabasDelToken.length) console.log(`  → El token sí tiene estas cuentas: ${wabasDelToken.join(', ')}`)
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
  console.log('  → El usuario del sistema necesita control total sobre la cuenta de WhatsApp donde QUEDÓ el número')
  console.log('    (al agregar el número real Meta crea una cuenta nueva, distinta de la de prueba).')
  process.exit(1)
}

// 2b. El número tiene que estar DENTRO de CLOUD_WABA_ID. Si quedó la WABA de prueba, el
//     paso 3 suscribiría la app a la cuenta equivocada y ningún mensaje real llegaría, sin
//     un solo error. Por eso aquí se corta antes de tocar nada.
const numerosDe = async (w) => (await meta(`${w}/phone_numbers?fields=id,display_phone_number`)).data || []
try {
  const suyos = await numerosDe(wabaId)
  if (suyos.some(p => String(p.id) === String(phoneNumberId))) ok('El número pertenece a esa cuenta de WhatsApp')
  else {
    mal(`El número ${phoneNumberId} NO está en la cuenta de WhatsApp ${wabaId}${suyos.length ? ` (esa tiene: ${suyos.map(p => p.display_phone_number).join(', ')})` : ''}.`)
    console.log('  → Suele pasar al copiar la cuenta de PRUEBA que Meta crea con la app.')
    for (const w of wabasDelToken.filter(x => x !== String(wabaId))) {
      try {
        if ((await numerosDe(w)).some(p => String(p.id) === String(phoneNumberId))) console.log(`  → Tu número está en la cuenta ${w}: pon CLOUD_WABA_ID=${w} en el .env.`)
      } catch { /* sin acceso a esa cuenta */ }
    }
    console.log('  → No suscribo ni registro nada hasta que coincidan.')
    process.exit(1)
  }
} catch (e) {
  mal(`No pude listar los números de la cuenta ${wabaId}: ${e.message}`)
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
