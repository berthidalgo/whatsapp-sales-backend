// tests/rutas-protegidas.test.js — NINGUNA RUTA DE DATOS SIN AUTENTICAR
//
// POR QUÉ EXISTE (auditoría pre-producción, 23-jul-2026):
//   Cuando el CRM migró a /v2/*, las rutas viejas quedaron registradas y ABIERTAS.
//   Sin token y sin scoping de tenant, cualquiera con la URL del backend obtenía:
//     · GET  /leads              → nombre + TELÉFONO de los leads de TODOS los clientes.
//                                  Su "auth" era `?role=ADMIN` en la query — es decir,
//                                  lo declaraba el propio atacante (ver api/leads.js).
//     · GET  /leads/:id/mensajes → la conversación completa de cualquier lead.
//     · POST /leads/:id/mensaje  → ENVIAR WhatsApp desde el número de un cliente.
//     · /config/*, /campaigns/*  → leer y MODIFICAR el bot y las campañas.
//     · /debug/brain-evals       → correr el dataset completo contra el LLM = quemar
//                                  el presupuesto de Gemini del dueño en un bucle.
//
//   Son datos personales de leads reales (Ley 29733 de protección de datos) y control
//   del canal de WhatsApp de clientes que pagan. No es una fuga teórica.
//
// QUÉ GARANTIZA:
//   Que toda ruta registrada en server.js declare `preHandler: verifyJwt`, salvo las
//   de la allowlist pública de abajo — que está escrita a mano, una por una, con su
//   motivo. Añadir una ruta nueva sin token hace fallar esta suite.
//
// Se lee el CÓDIGO FUENTE en vez de levantar el server: no necesita BD ni secretos,
// corre en cualquier CI y describe exactamente lo que un revisor vería al leer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js')
const fuente = readFileSync(SERVER, 'utf8')

// ── Allowlist PÚBLICA: cada entrada necesita un motivo real ──
// No agregar nada aquí sin entender que queda expuesto a internet.
const PUBLICAS = new Map([
  ['GET /health',         'UptimeRobot lo llama para mantener Render despierto; no devuelve datos'],
  ['GET /webhook',        'ping de verificación de Evolution; solo devuelve un status'],
  ['POST /webhook',       'lo llama Evolution API, que no maneja JWT (el tenant se deduce del canal)'],
  ['GET /webhook/cloud',  'handshake hub.challenge de Meta (compara verify_token)'],
  ['POST /webhook/cloud', 'entrante de Meta; fail-closed: si Cloud está activo EXIGE firma HMAC válida, si no lo está no procesa'],
  ['GET /auth/vendors',   'pantalla de login: necesita listar nombres ANTES de que exista token'],
  ['POST /auth/login',    'emite el token; por definición no puede exigirlo'],
  ['GET /cron/followup',  'cron externo sin JWT; protegido por CRON_SECRET'],
  ['POST /cron/followup', 'cron externo sin JWT; protegido por CRON_SECRET'],
])

// Extrae las rutas registradas: app.get('/x', ...) / app.post('/x', { preHandler... }, ...)
function rutasRegistradas(src) {
  const rx = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*(,\s*\{[^}]*\})?/g
  const out = []
  let m
  while ((m = rx.exec(src)) !== null) {
    out.push({
      metodo: m[1].toUpperCase(),
      ruta: m[2],
      opciones: m[3] || '',
      clave: `${m[1].toUpperCase()} ${m[2]}`
    })
  }
  return out
}

const RUTAS = rutasRegistradas(fuente)

test('sanity: se detectaron las rutas del server', () => {
  assert.ok(RUTAS.length > 30, `esperaba >30 rutas, encontré ${RUTAS.length} — ¿cambió la forma de registrarlas?`)
})

test('ninguna ruta de datos queda sin verifyJwt', () => {
  const desprotegidas = RUTAS
    .filter(r => !PUBLICAS.has(r.clave))
    .filter(r => !/preHandler:\s*verifyJwt/.test(r.opciones))
    .map(r => r.clave)

  assert.deepEqual(desprotegidas, [],
    'Estas rutas están ABIERTAS a internet. Añade `{ preHandler: verifyJwt }` o, si de ' +
    'verdad deben ser públicas, agrégalas a PUBLICAS con su motivo.')
})

test('la allowlist pública no creció sin querer', () => {
  // Candado de intención: si alguien mete una ruta en PUBLICAS para "que pase el test",
  // este contador falla y obliga a justificarlo en la revisión.
  assert.equal(PUBLICAS.size, 9,
    'Cambió la cantidad de rutas públicas. Revisa UNA POR UNA que deban serlo y ' +
    'actualiza este número a conciencia.')
})

test('las rutas públicas que exponen datos están justificadas', () => {
  // Ninguna pública debe servir datos de leads: son PII.
  const sospechosas = [...PUBLICAS.keys()].filter(k => /\/leads|\/config|\/campaigns|\/reportes|\/v2\//.test(k))
  assert.deepEqual(sospechosas, [],
    'Una ruta que sirve datos de negocio no puede estar en la allowlist pública.')
})

test('JWT_SECRET es obligatorio en producción (fail-closed)', () => {
  // Sin esto, el server arrancaría con el secreto de dev que está en el repo y
  // cualquiera podría forjarse un token de ADMIN.
  assert.match(fuente, /JWT_SECRET.*obligatorio en producción[\s\S]{0,80}process\.exit\(1\)/,
    'el boot debe abortar en producción si falta JWT_SECRET')
})
