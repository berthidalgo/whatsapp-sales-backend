// tests/meta-activar-script.test.js — scripts/meta-activar.js de punta a punta (sep 2026)
//
// Corre el script DE VERDAD (proceso aparte) contra un Graph de Meta de mentira. Vigila las
// confusiones que en la vida real fallan en silencio: la WABA de PRUEBA en el .env en vez de
// la del número (se suscribiría la app a la cuenta equivocada y no llegaría ningún mensaje),
// el token temporal o sin permisos, y la clave secreta o el token de otra app. Y que con todo
// en orden haga los dos pasos ocultos: suscribir la app y registrar el número.
//
// Hermético: todas las variables que el script lee se pasan explícitas (vacía cuenta como
// definida), así el .env de la raíz (que tiene credenciales reales) nunca entra en juego.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(API, 'scripts', 'meta-activar.js')
const TOKEN = 'tok-usuario-sistema'
const APP = '1111'
const SECRETO = 'secreto-bueno'
const WABA_PRUEBA = '2220001'   // la que Meta crea sola al agregar WhatsApp a la app (+1 555…)
const WABA_REAL = '2220002'     // la que Meta crea al agregar el número real
const NUMERO = '3330002'
const VERIFY = 'verificame'

const NUMEROS = {
  [WABA_PRUEBA]: [{ id: '3330001', display_phone_number: '+1 555-010-0001' }],
  [WABA_REAL]: [{ id: NUMERO, display_phone_number: '+51 900 000 002' }]
}
const tokenBueno = () => ({
  app_id: APP, type: 'SYSTEM_USER', is_valid: true, expires_at: 0,
  scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'],
  granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA_PRUEBA, WABA_REAL] }]
})

let estado      // lo que "Meta" responde; cada prueba lo ajusta
let peticiones  // { method, path, auth }
let puerto

const servidor = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    peticiones.push({ method: req.method, path: p, auth: req.headers.authorization })
    const responder = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }

    if (p === '/webhook/cloud') {
      const bien = url.searchParams.get('hub.verify_token') === VERIFY
      res.writeHead(bien ? 200 : 403)
      return res.end(bien ? url.searchParams.get('hub.challenge') : 'no')
    }
    if (p === '/v23.0/debug_token') {
      if (![`Bearer ${APP}|${SECRETO}`, `Bearer ${TOKEN}`].includes(req.headers.authorization)) {
        return responder(400, { error: { message: 'Invalid OAuth access token signature.', code: 190 } })
      }
      return responder(200, { data: estado.token })
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return responder(401, { error: { message: 'Invalid OAuth access token', code: 190 } })

    let m
    if ((m = /^\/v23\.0\/(\d+)\/phone_numbers$/.exec(p))) return responder(200, { data: NUMEROS[m[1]] || [] })
    if ((m = /^\/v23\.0\/(\d+)\/subscribed_apps$/.exec(p))) {
      if (req.method === 'POST') { estado.suscrita = m[1]; return responder(200, { success: true }) }
      return responder(200, { data: estado.suscrita === m[1] ? [{ whatsapp_business_api_data: { name: 'VendeMas Hidata', id: APP } }] : [] })
    }
    if (/^\/v23\.0\/\d+\/register$/.test(p) && req.method === 'POST') { estado.registrado = true; return responder(200, { success: true }) }
    if ((m = /^\/v23\.0\/(\d+)$/.exec(p))) {
      if (m[1] in NUMEROS) return responder(200, { id: m[1], name: m[1] === WABA_REAL ? 'Hidata Importaciones' : 'Test WhatsApp Business Account' })
      if (m[1] === NUMERO) {
        return responder(200, {
          display_phone_number: '+51 900 000 002', verified_name: 'Hidata Importaciones', name_status: 'AVAILABLE_WITHOUT_REVIEW',
          code_verification_status: 'VERIFIED', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250',
          platform_type: estado.registrado ? 'CLOUD_API' : 'NOT_APPLICABLE', status: estado.registrado ? 'CONNECTED' : 'PENDING'
        })
      }
    }
    responder(404, { error: { message: `ruta desconocida ${req.method} ${p}`, code: 100 } })
  })
})

before(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r))
  puerto = servidor.address().port
})
after(() => new Promise(r => servidor.close(r)))
beforeEach(() => { estado = { token: tokenBueno(), suscrita: null, registrado: false }; peticiones = [] })

/** Corre el script con un entorno TOTALMENTE controlado. */
function correr(args = [], extraEnv = {}) {
  const env = Object.fromEntries(Object.entries({
    // SystemRoot solo existe en Windows (Node lo necesita ahí); en Linux/CI queda fuera
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    CLOUD_GRAPH_BASE: `http://127.0.0.1:${puerto}/v23.0`,
    CLOUD_ACCESS_TOKEN: TOKEN, CLOUD_WABA_ID: WABA_REAL, CLOUD_PHONE_NUMBER_ID: NUMERO,
    CLOUD_APP_ID: APP, CLOUD_APP_SECRET: SECRETO, CLOUD_VERIFY_TOKEN: VERIFY,
    ...extraEnv
  }).filter(([, v]) => v !== undefined))
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--servidor', `http://127.0.0.1:${puerto}`, ...args], { cwd: API, env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) })
    })
  })
}
const yaConectado = () => { estado.suscrita = WABA_REAL; estado.registrado = true }

test('activar: todo en orden + --aplicar --pin → suscribe la app, registra el número y da el visto bueno', async () => {
  const r = await correr(['--aplicar', '--pin', '123456'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(estado.suscrita, WABA_REAL)
  assert.equal(estado.registrado, true)
  assert.match(r.out, /El token no caduca/)
  assert.match(r.out, /El número pertenece a esa cuenta/)
  assert.match(r.out, /Todo listo del lado de Meta/)
  assert.ok(peticiones.some(p => p.path.endsWith('/debug_token') && p.auth === `Bearer ${APP}|${SECRETO}`), 'revisa el token con el de la app')
})

test('activar: la WABA de PRUEBA en el .env → dice cuál es la buena y NO suscribe ni registra nada', async () => {
  const r = await correr(['--aplicar', '--pin', '123456'], { CLOUD_WABA_ID: WABA_PRUEBA })
  assert.equal(r.code, 1)
  assert.match(r.out, new RegExp(`NO está en la cuenta de WhatsApp ${WABA_PRUEBA} \\(esa tiene: \\+1 555`))
  assert.match(r.out, new RegExp(`pon CLOUD_WABA_ID=${WABA_REAL}`))
  assert.ok(peticiones.every(p => p.method === 'GET'), 'no tocó nada')
  assert.equal(estado.suscrita, null)
  assert.equal(estado.registrado, false)
})

test('activar: token temporal, de persona y sin permiso de administración → lo dice y no da el visto bueno', async () => {
  yaConectado()
  estado.token = { ...tokenBueno(), type: 'USER', expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: ['whatsapp_business_messaging'] }
  const r = await correr()
  assert.equal(r.code, 1)
  assert.match(r.out, /El token caduca/)
  assert.match(r.out, /faltan permisos: whatsapp_business_management/)
  assert.match(r.out, /tipo USER/)
  assert.doesNotMatch(r.out, /Todo listo/)
})

test('activar: clave secreta equivocada → avisa que rechazaríamos todos los webhooks', async () => {
  yaConectado()
  const r = await correr([], { CLOUD_APP_SECRET: 'secreto-de-otra-app' })
  assert.equal(r.code, 1)
  assert.match(r.out, /CLOUD_APP_SECRET no es la clave de esa app/)
  assert.match(r.out, /firma inválida/)
})

test('activar: token generado para otra app → lo detecta aunque el token funcione', async () => {
  yaConectado()
  estado.token = { ...tokenBueno(), app_id: '9999' }
  const r = await correr()
  assert.equal(r.code, 1)
  assert.match(r.out, /El token es de la app 9999, no de la 1111/)
})

test('activar: sin CLOUD_APP_ID revisa el token consigo mismo y sigue', async () => {
  yaConectado()
  const r = await correr([], { CLOUD_APP_ID: '' })
  assert.equal(r.code, 0, r.out + r.err)
  assert.ok(peticiones.some(p => p.path.endsWith('/debug_token') && p.auth === `Bearer ${TOKEN}`))
})

test('activar: CLOUD_GRAPH_BASE fuera de esta máquina → se niega sin llamar a nadie', async () => {
  const r = await correr([], { CLOUD_GRAPH_BASE: 'https://graph.ejemplo.com/v23.0' })
  assert.equal(r.code, 1)
  assert.match(r.err, /solo acepta 127\.0\.0\.1 o localhost/)
  assert.equal(peticiones.length, 0)
})
