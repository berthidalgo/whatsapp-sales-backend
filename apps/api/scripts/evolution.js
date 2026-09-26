// scripts/evolution.js — operar la instancia de Evolution API desde la terminal (sep 2026)
//
// POR QUÉ EXISTE: cada caída de Evolution (trial de Railway vencido en jul, instancia
// desconectada, Baileys que suelta la sesión) se resolvía a mano con curl sueltos. Esto
// deja los 3 pasos repetibles y SIN pegar secretos en la terminal:
//
//   node scripts/evolution.js estado  [instancia]   → ¿la API responde? ¿la instancia está conectada?
//   node scripts/evolution.js qr      [instancia]   → genera el QR y lo guarda en el Escritorio (QR-<instancia>.png)
//   node scripts/evolution.js webhook [instancia]   → apunta el webhook de la instancia a este backend,
//                                                     con el header x-webhook-secret (WEBHOOK_SECRET)
//
// Lee del .env de la raíz del repo: EVOLUTION_API_URL, EVOLUTION_API_KEY, WEBHOOK_SECRET y
// BACKEND_URL (default: el de Render). Instancia por defecto: EVOLUTION_INSTANCE_NAME o 'bioayur'.
// No imprime llaves.

import fs from 'node:fs'
import os from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* sin .env local: se usan las variables del entorno */ }

const [, , accion = 'estado', instArg] = process.argv
const API = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const KEY = process.env.EVOLUTION_API_KEY
const INST = instArg || process.env.EVOLUTION_INSTANCE_NAME || 'bioayur'
const BACKEND = (process.env.BACKEND_URL || 'https://whatsapp-sales-backend.onrender.com').replace(/\/$/, '')

function salir(msg) { console.error(`✖ ${msg}`); process.exit(1) }
if (!API) salir('falta EVOLUTION_API_URL (URL pública de la Evolution API) en el .env')
if (!KEY) salir('falta EVOLUTION_API_KEY (la AUTHENTICATION_API_KEY global de Evolution) en el .env')

async function evo(metodo, ruta, body) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const texto = await r.text()
  let json = null
  try { json = JSON.parse(texto) } catch { /* no es JSON */ }
  return { status: r.status, json, texto }
}

async function estado() {
  const raiz = await fetch(API).then(r => r.status).catch(e => `sin respuesta (${e.message})`)
  console.log(`API ${API} → ${raiz}`)
  if (raiz !== 200) {
    console.log('  La API no responde. Si es el 404 "Application not found" de Railway, el servicio no tiene deploy activo (plan vencido o proyecto borrado).')
    return
  }
  const r = await evo('GET', `/instance/connectionState/${INST}`)
  const st = r.json?.instance?.state || r.json?.state || `HTTP ${r.status}`
  console.log(`Instancia "${INST}" → ${st}`)
  if (st !== 'open') console.log(`  No está conectada. Genera el QR: node scripts/evolution.js qr ${INST}`)
}

async function qr() {
  let r = await evo('GET', `/instance/connect/${INST}`)
  if (r.status === 404) {
    console.log(`La instancia "${INST}" no existe: se crea (Baileys).`)
    const c = await evo('POST', '/instance/create', { instanceName: INST, integration: 'WHATSAPP-BAILEYS', qrcode: true })
    if (c.status >= 300) salir(`no se pudo crear la instancia: HTTP ${c.status} ${c.texto.slice(0, 200)}`)
    r = await evo('GET', `/instance/connect/${INST}`)
  }
  const b64 = r.json?.base64 || r.json?.qrcode?.base64
  if (!b64) {
    if (r.json?.instance?.state === 'open') return console.log(`"${INST}" ya está conectada, no hace falta QR.`)
    salir(`Evolution no devolvió QR: HTTP ${r.status} ${r.texto.slice(0, 200)}`)
  }
  const destino = join(os.homedir(), 'Desktop', `QR-${INST}.png`)
  fs.writeFileSync(destino, Buffer.from(b64.replace(/^data:image\/png;base64,/, ''), 'base64'))
  console.log(`QR guardado en ${destino} → WhatsApp del número del cliente → Dispositivos vinculados → Vincular. Caduca en ~40 s; si vence, vuelve a correr el comando.`)
}

async function webhook() {
  const secreto = process.env.WEBHOOK_SECRET
  if (!secreto) salir('falta WEBHOOK_SECRET en el .env (el mismo valor que en Render)')
  const cuerpo = {
    webhook: {
      enabled: true,
      url: `${BACKEND}/webhook`,
      headers: { 'x-webhook-secret': secreto },
      byEvents: false,
      base64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'LOGOUT_INSTANCE', 'QRCODE_UPDATED', 'SEND_MESSAGE']
    }
  }
  const r = await evo('POST', `/webhook/set/${INST}`, cuerpo)
  if (r.status >= 300) salir(`Evolution rechazó la config del webhook: HTTP ${r.status} ${r.texto.slice(0, 200)}`)
  const v = await evo('GET', `/webhook/find/${INST}`)
  const conHeader = !!(v.json?.headers && Object.keys(v.json.headers).length)
  console.log(`Webhook de "${INST}" → ${BACKEND}/webhook (${v.json?.enabled ? 'activo' : 'INACTIVO'})`)
  if (!conHeader) {
    console.log('  ⚠️ Esta versión de Evolution no guardó el header. Alternativa: poner la URL como')
    console.log(`     ${BACKEND}/webhook?secret=<WEBHOOK_SECRET>  (el backend también acepta el secreto por query).`)
  }
}

const ACCIONES = { estado, qr, webhook }
if (!ACCIONES[accion]) salir(`acción desconocida "${accion}". Usa: estado | qr | webhook`)
await ACCIONES[accion]()
