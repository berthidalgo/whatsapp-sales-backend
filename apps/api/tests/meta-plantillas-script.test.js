// tests/meta-plantillas-script.test.js — scripts/meta-plantillas.js de punta a punta (sep 2026)
//
// Corre el script DE VERDAD (proceso aparte) contra un Graph de Meta de mentira levantado
// aquí mismo. Vigila lo que no se ve en las pruebas unitarias del catálogo: la paginación de
// Meta, que crear sea idempotente, que la simulación no toque nada, que `editar` corrija el
// texto, y las dos guardas de seguridad (el token no sale de la máquina en pruebas; el idioma
// con guion se rechaza antes de llamar a nadie).
//
// Hermético: todas las variables que el script lee se pasan explícitas, así el .env de la
// raíz (que tiene credenciales reales) nunca entra en juego.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOGO } from '../src/whatsapp/cloud/plantillas-catalogo.js'

const API = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(API, 'scripts', 'meta-plantillas.js')
const TOKEN = 'tok-de-prueba'
const WABA = '999000999'

// ── Graph de mentira ────────────────────────────────────────────────────
const store = []        // { id, name, language, status, category, rejected_reason, components }
let peticiones = []     // { method, path }
let siguienteId = 5000
let base = ''

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let cuerpo = ''
  req.on('data', c => { cuerpo += c })
  req.on('end', () => {
    peticiones.push({ method: req.method, path: url.pathname })
    const responder = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return responder(401, { error: { message: 'Invalid OAuth access token', code: 190 } })

    const lista = /^\/v23\.0\/(\d+)\/message_templates$/.exec(url.pathname)
    if (lista && req.method === 'GET') {
      // páginas de 2 para obligar a seguir paging.next
      const desde = Number(url.searchParams.get('after') || 0)
      const campos = String(url.searchParams.get('fields') || '').split(',')
      const pagina = store.slice(desde, desde + 2).map(t => Object.fromEntries(Object.entries(t).filter(([k]) => k === 'id' || campos.includes(k))))
      const out = { data: pagina }
      if (desde + 2 < store.length) out.paging = { next: `${base}/${lista[1]}/message_templates?fields=${campos.join(',')}&limit=100&after=${desde + 2}` }
      return responder(200, out)
    }
    if (lista && req.method === 'POST') {
      const b = JSON.parse(cuerpo)
      if (store.some(t => t.name === b.name && t.language === b.language)) {
        return responder(400, { error: { message: 'Invalid parameter', code: 100, error_subcode: 2388024, error_user_msg: 'Ya existe esa plantilla en ese idioma' } })
      }
      const variables = (b.components[0].text.match(/\{\{\d+\}\}/g) || []).length
      if ((b.components[0].example?.body_text?.[0] || []).length !== variables) return responder(400, { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Faltan ejemplos' } })
      // Meta "aprueba como marketing" la utility que le parece comercial: aquí, el aviso al vendedor
      const category = b.name.includes('aviso') ? 'MARKETING' : String(b.category).toUpperCase()
      const t = { id: String(++siguienteId), name: b.name, language: b.language, status: 'PENDING', category, rejected_reason: 'NONE', components: b.components.map(c => ({ ...c, type: c.type.toUpperCase() })) }
      store.push(t)
      return responder(200, { id: t.id, status: 'PENDING', category })
    }
    if (lista && req.method === 'DELETE') {
      const nombre = url.searchParams.get('name')
      for (let i = store.length - 1; i >= 0; i--) if (store[i].name === nombre) store.splice(i, 1)
      return responder(200, { success: true })
    }
    const edicion = /^\/v23\.0\/(\d+)$/.exec(url.pathname)
    if (edicion && req.method === 'POST') {
      const t = store.find(x => x.id === edicion[1])
      if (!t) return responder(404, { error: { message: 'no existe', code: 100 } })
      t.components = JSON.parse(cuerpo).components.map(c => ({ ...c, type: c.type.toUpperCase() }))
      t.status = 'PENDING'
      return responder(200, { success: true })
    }
    responder(404, { error: { message: `ruta desconocida ${req.method} ${url.pathname}`, code: 100 } })
  })
})

before(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${servidor.address().port}/v23.0`
})
after(() => new Promise(r => servidor.close(r)))

/** Corre el script con un entorno TOTALMENTE controlado. */
function correr(args = [], extraEnv = {}) {
  const env = Object.fromEntries(Object.entries({
    // SystemRoot solo existe en Windows (Node lo necesita ahí); en Linux/CI queda fuera
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    CLOUD_GRAPH_BASE: base, CLOUD_ACCESS_TOKEN: TOKEN, CLOUD_WABA_ID: WABA, CLOUD_TEMPLATE_IDIOMA: 'es',
    // Explícitas para que el .env real de la raíz no pueda colarse (el script solo lo usa si falta la variable)
    ...Object.fromEntries(CATALOGO.map(t => [t.env, t.nombre])),
    ...extraEnv
  }).filter(([, v]) => v !== undefined))
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: API, env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) })
    })
  })
}

const cuerpoDe = (t) => t.components.find(c => c.type === 'BODY')?.text

test('script: estado con la cuenta vacía → las 4 faltan y sugiere crearlas', async () => {
  const r = await correr()
  assert.equal(r.code, 0, r.err)
  assert.equal((r.out.match(/NO existe en Meta/g) || []).length, 4)
  assert.match(r.out, /crear --aplicar/)
})

test('script: `crear` sin --aplicar SIMULA — muestra el JSON y no crea nada', async () => {
  peticiones = []
  const r = await correr(['crear', '--solo', 'compromiso'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /simulación → POST 999000999\/message_templates/)
  assert.match(r.out, /"category": "utility"/)
  assert.equal(store.length, 0)
  assert.ok(peticiones.every(p => p.method === 'GET'), 'solo lecturas')
})

test('script: `crear --aplicar` crea las 4, avisa la recategorización, y repetirlo no duplica', async () => {
  const r = await correr(['crear', '--aplicar'])
  assert.equal(r.code, 0, r.err)
  assert.equal(store.length, 4)
  assert.deepEqual(store.map(t => t.name).sort(), CATALOGO.map(t => t.nombre).sort())
  assert.match(r.out, /Meta la aprobará como MARKETING \(pedimos utility\)/)
  assert.ok(store.every(t => t.language === 'es'))

  const otra = await correr(['crear', '--aplicar'])
  assert.equal(otra.code, 0, otra.err)
  assert.equal(store.length, 4, 'idempotente: lo que ya existe no se vuelve a crear')
})

test('script: estado lee TODAS las páginas, avisa el texto que ya no coincide e imprime solo las aprobadas', async () => {
  for (const t of store) t.status = 'APPROVED'
  store.find(t => t.name === 'hidata_reapertura').status = 'PENDING'
  const editadaEnElPanel = store.find(t => t.name === 'hidata_followup_24h')
  editadaEnElPanel.components = [{ type: 'BODY', text: 'Hola {{1}}, alguien cambió este texto en el panel sobre {{2}}.' }]
  // una quinta plantilla ajena, para que haya 3 páginas de 2
  store.push({ id: '1', name: 'promo_ajena', language: 'es', status: 'APPROVED', category: 'MARKETING', rejected_reason: 'NONE', components: [] })

  const r = await correr()
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /5 plantilla\(s\) en Meta/, 'siguió paging.next hasta el final')
  assert.equal((r.out.match(/NO es el del catálogo/g) || []).length, 1)
  assert.match(r.out, /CLOUD_TEMPLATE_FOLLOWUP_24H=hidata_followup_24h/)
  assert.match(r.out, /CLOUD_TEMPLATE_COMPROMISO=hidata_compromiso/)
  assert.doesNotMatch(r.out, /CLOUD_TEMPLATE_REAPERTURA=/, 'la pendiente no se imprime como lista')
})

test('script: `editar` simula (con el aviso del límite de Meta) y `editar --aplicar` pone el texto del catálogo', async () => {
  const antes = cuerpoDe(store.find(t => t.name === 'hidata_followup_24h'))
  const sim = await correr(['editar'])
  assert.equal(sim.code, 0, sim.err)
  assert.match(sim.out, /simulación → POST \d+/)
  assert.match(sim.out, /1 edición cada 24 h/)
  assert.equal(cuerpoDe(store.find(t => t.name === 'hidata_followup_24h')), antes, 'la simulación no tocó nada')

  const r = await correr(['editar', '--aplicar'])
  assert.equal(r.code, 0, r.err)
  const followup = store.find(t => t.name === 'hidata_followup_24h')
  assert.equal(cuerpoDe(followup), CATALOGO.find(t => t.clave === 'followup_24h').cuerpo)
  assert.equal(followup.status, 'PENDING', 'Meta la vuelve a revisar')

  const despues = await correr()
  assert.doesNotMatch(despues.out, /NO es el del catálogo/)
})

test('script: si existe en OTRO idioma lo dice, en vez de solo "no existe"', async () => {
  const r = await correr(['--idioma', 'es_PE'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /EXISTE en es: ¿querías --idioma es\?/)
})

test('script: `borrar` avisa que el nombre de una aprobada queda bloqueado 30 días; con --aplicar borra', async () => {
  const sim = await correr(['borrar', '--nombre', 'hidata_compromiso'])
  assert.match(sim.out, /30 días/)
  assert.ok(store.some(t => t.name === 'hidata_compromiso'))
  const r = await correr(['borrar', '--nombre', 'hidata_compromiso', '--aplicar'])
  assert.equal(r.code, 0, r.err)
  assert.ok(!store.some(t => t.name === 'hidata_compromiso'))
})

test('script: CLOUD_GRAPH_BASE fuera de esta máquina se rechaza SIN mandar el token a ningún lado', async () => {
  peticiones = []
  const r = await correr([], { CLOUD_GRAPH_BASE: 'https://graph.facebook.com.evil.example/v23.0' })
  assert.equal(r.code, 1)
  assert.match(r.err, /solo acepta 127\.0\.0\.1 o localhost/)
  assert.equal(peticiones.length, 0)
})

test('script: idioma con guion o token malo → error claro y código de salida 1', async () => {
  const idioma = await correr(['--idioma', 'es-PE'])
  assert.equal(idioma.code, 1)
  assert.match(idioma.err, /guion bajo/)

  const token = await correr([], { CLOUD_ACCESS_TOKEN: 'otro' })
  assert.equal(token.code, 1)
  assert.match(token.err, /190/)
  assert.match(token.err, /whatsapp_business_management/)
})
