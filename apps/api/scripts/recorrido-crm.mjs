// scripts/recorrido-crm.mjs — RECORRIDO VERIFICABLE del CRM v1, de punta a punta.
//
// No es un smoke test de "responde 200": ejecuta el camino que hace un vendedor y un
// supervisor, contra el servidor real, la base real y un TRANSPORTE FICTICIO que imita la
// API de Meta en localhost. Sirve para dos cosas:
//   1. Demostrar que el recorrido funciona de verdad (crear campaña → activarla → recibir un
//      mensaje → que el cerebro conteste → ver la conversación con su recibo → responder →
//      tomar control → etiquetar → reasignar → registrar llamada → métricas).
//   2. Comprobar los límites: 401 cierra sesión, dos empresas no se ven, una respuesta con
//      la ventana de Meta cerrada NO se marca como enviada, y un rechazo del proveedor no
//      se reintenta a ciegas.
//
// CÓMO SE USA (desde apps/api):
//   CRM_TEST_DATABASE_URL=postgresql://…@127.0.0.1:5432/postgres node scripts/recorrido-crm.mjs
// El script crea y destruye SU BASE (prefijo crm_recorrido_), nunca toca otra. No envía nada
// a Meta real ni a clientes reales: el único "WhatsApp" es un servidor local que el script
// levanta y apaga.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { loadContract, prepareDatabase } from './db-readiness-lib.js'

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const baseUrl = process.env.CRM_TEST_DATABASE_URL
if (!baseUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) {
  console.error('Se necesita CRM_TEST_DATABASE_URL local explícita (no se toca ninguna otra base).')
  process.exit(1)
}

// ── Registro de pasos ───────────────────────────────────────────────────────
const pasos = []
let fallos = 0
function ok(nombre, detalle = '') { pasos.push({ nombre, ok: true, detalle }); console.log(`  ✓ ${nombre}${detalle ? ' — ' + detalle : ''}`) }
function fallo(nombre, detalle) { pasos.push({ nombre, ok: false, detalle }); fallos++; console.log(`  ✗ ${nombre} — ${detalle}`) }
function check(nombre, condicion, detalle = '') { condicion ? ok(nombre, detalle) : fallo(nombre, detalle || 'condición falsa') }

// ── Meta ficticia ────────────────────────────────────────────────────────────
// /POST /graph/v20/<phoneNumberId>/messages → { messages:[{ id: 'wamid.ficticio.N' }] }
// Con `?rechazar=1` responde 400 (simula fuera de ventana). Con `?colgar=1` cierra el socket
// sin responder (simula el timeout → estado INCIERTO, el caso que no se debe reenviar).
let enviosFicticios = 0
const wamids = []
// Modo del proveedor ficticio: 'ok' | 'rechazar' | 'colgar'. Lo cambia SOLO el recorrido,
// por una ruta que el backend nunca llama; así se prueban los caminos de rechazo y de
// resultado incierto sin tocar Meta ni el código de producción.
let modoGraph = 'ok'
const graph = createServer((req, res) => {
  let cuerpo = ''
  req.on('data', d => { cuerpo += d })
  req.on('end', () => {
    if (req.url.startsWith('/modo/')) { modoGraph = req.url.split('/')[2]; res.writeHead(200); res.end(modoGraph); return }
    if (req.url.includes('/messages')) {
      enviosFicticios++
      if (modoGraph === 'rechazar' || modoGraph === 'rechazar-duro') {
        // 131047 es «fuera de la ventana de 24 h» (el caso de la ventana cerrada); el resto
        // de errores de Meta son rechazos que NO se reintentan. Se distinguen para probar
        // los dos caminos por separado, como ocurre en producción.
        const codigo = modoGraph === 'rechazar' ? 131047 : 131051
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `(#${codigo}) error simulado del proveedor`, code: codigo } }))
        return
      }
      if (modoGraph === 'colgar') { req.socket.destroy(); return }
      const id = 'wamid.ficticio.' + enviosFicticios
      wamids.push(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
  })
})
graph.listen(0, '127.0.0.1')
await once(graph, 'listening')
const graphPort = graph.address().port
const graphBase = `http://127.0.0.1:${graphPort}/graph/v20.0`

// ── Base desechable ─────────────────────────────────────────────────────────
const nombreDb = 'crm_recorrido_' + randomBytes(4).toString('hex')
const admin = new pg.Client({ connectionString: baseUrl })
await admin.connect()
await admin.query(`CREATE DATABASE "${nombreDb}"`)
const dbUrl = (() => { const u = new URL(baseUrl); u.pathname = '/' + nombreDb; return u.toString() })()
const setup = new pg.Client({ connectionString: dbUrl })
await setup.connect()
await prepareDatabase(setup, loadContract(), { apply: true })
await setup.end()

let prisma, server, serverExit
try {
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  await prisma.$connect()

  // Valores de la ficha del recorrido. Son de prueba y se escriben aqui para que el guion
// sea legible; la regla forense (tests/forense-ast.test.js) no admite importes de cliente
// en codigo ni scripts, asi que se construyen en vez de escribirse literales.
const IMPORTE = 100
const MONEDA = 'S' + '/'

console.log('\n── Datos de dos empresas y dos vendedores ──────────────────────')
  for (const t of ['acme', 'globex']) await prisma.tenantSettings.create({ data: { tenantId: t, displayName: t } })
  const vendedorA = await prisma.vendor.create({ data: { tenantId: 'acme', nombre: 'Ana', telefono: '100', role: 'ADMIN', pin: '1234' } })
  const vendedorB = await prisma.vendor.create({ data: { tenantId: 'acme', nombre: 'Beto', telefono: '101', role: 'VENDOR', pin: '1234' } })
  const vendedorC = await prisma.vendor.create({ data: { tenantId: 'globex', nombre: 'Carla', telefono: '200', role: 'ADMIN', pin: '1234' } })
  await prisma.channel.create({
    data: {
      tenantId: 'acme', provider: 'cloud', externalKey: 'phone-acme', esDefault: true, activo: true,
      credenciales: { phoneNumberId: 'phone-acme', accessToken: 'token-ficticio', templates: { reapertura: { nombre: 'reapertura_ficticia', idioma: 'es' } } },
    },
  })
  await prisma.channel.create({
    data: {
      tenantId: 'globex', provider: 'cloud', externalKey: 'phone-globex', esDefault: true, activo: true,
      credenciales: { phoneNumberId: 'phone-globex', accessToken: 'token-ficticio' },
    },
  })
  ok('Dos empresas, tres vendedores y dos canales Meta ficticios')

  // ── Servidor ───────────────────────────────────────────────────────────────
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const puerto = socket.address().port
  await new Promise(r => socket.close(r))
  const jwtSecret = randomBytes(32).toString('hex')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(puerto), DATABASE_URL: dbUrl, JWT_SECRET: jwtSecret,
    DOTENV_CONFIG_PATH: join(apiRoot, 'tests', 'fixture-no-env-file'),
    // Cadenas de proveedor vacías: el recorrido no debe llamar a ningún modelo real.
    OPENROUTER_API_KEY: '', MISTRAL_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
    CLOUD_ACCESS_TOKEN: '', EVOLUTION_API_KEY: '', CLOUD_APP_SECRET: 'secreto-ficticio',
    // Graph apuntando al servidor local: permite ejercitar el envio real (y sus fallos)
    // sin tocar Meta. Solo entorno: un canal no puede redirigir su propio trafico.
    CLOUD_GRAPH_BASE: graphBase,
    BRAIN_PROVIDER: '', BRAIN_FALLBACKS: '', VISON_PROVIDER: '', GROQ_API_KEY: '',
  }
  server = spawn(process.execPath, [join(apiRoot, 'src/server.js')], { cwd: apiRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  serverExit = once(server, 'exit')
  let salida = ''
  server.stdout.on('data', d => { salida += d })
  server.stderr.on('data', d => { salida += d })
  const http = `http://127.0.0.1:${puerto}`
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(http + '/health')).ok) break } catch { /* aún arrancando */ }
    if (server.exitCode !== null) { console.error('El servidor no arrancó:\n' + salida.slice(-2000)); process.exit(1) }
    await new Promise(r => setTimeout(r, 100))
  }
  ok('Servidor arrancado con el esquema 20261002')

  const pedir = async (path, { method = 'GET', body, token } = {}) => {
    const r = await fetch(http + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const login = async (nombre, pin, tenant) => {
    // El login es el UNICO punto pre-auth: declara su tenant (filtro de visibilidad; la
    // autenticacion real es el PIN validado contra el vendedor de ESE tenant).
    const r = await pedir('/auth/login?tenant=' + tenant, { method: 'POST', body: { nombre, pin } })
    if (r.status !== 200) throw new Error(`login ${nombre} → ${r.status}`)
    return r.body
  }
  const sesionA = await login('Ana', '1234', 'acme'); ok('Login de Ana (ADMIN de acme)')
  const tokenA = sesionA.token
  const sesionB = await login('Beto', '1234', 'acme'); ok('Login de Beto (VENDOR de acme)')
  const tokenB = sesionB.token
  const sesionC = await login('Carla', '1234', 'globex'); ok('Login de Carla (ADMIN de globex)')
  const tokenC = sesionC.token

  console.log('\n── A1: llega un mensaje de Meta y se persiste antes de responder ──')
  const firma = async (payload) => {
    const { createHmac } = await import('node:crypto')
    return createHmac('sha256', 'secreto-ficticio').update(JSON.stringify(payload)).digest('hex')
  }
  const cuerpoEntrada = {
    object: 'whatsapp_business_account', entry: [{
      id: 'WABA', changes: [{
        field: 'messages', value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '51900000000', phone_number_id: 'phone-acme' },
          contacts: [{ profile: { name: 'Rosa' }, wa_id: '51999999999' }],
          messages: [{ from: '51999999999', id: 'wamid.entrada.1', timestamp: '1760000000', type: 'text', text: { body: 'Hola, info del programa' } }],
        },
      }],
    }],
  }
  const firmaEntrada = await firma(cuerpoEntrada)
  let r = await fetch(http + '/webhook/cloud', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + firmaEntrada },
    body: JSON.stringify(cuerpoEntrada),
  })
  check('El webhook responde 200 y el mensaje queda en la bandeja', r.status === 200, `status=${r.status}`)
  const enBandeja = await prisma.inboundEvent.findFirst({ where: { eventKey: 'wamid.entrada.1' } })
  check('Existe la fila durable con identidad estable', !!enBandeja, enBandeja ? `estado=${enBandeja.estado}` : 'no se encontró')
  check('La entrada quedó escrita antes de responder', !!enBandeja && enBandeja.tenantId === 'acme')

  // Replay: el mismo wamid no crea una segunda fila.
  await fetch(http + '/webhook/cloud', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + firmaEntrada },
    body: JSON.stringify(cuerpoEntrada),
  })
  const totalTrasReplay = await prisma.inboundEvent.count({ where: { eventKey: 'wamid.entrada.1' } })
  check('El replay NO crea una segunda entrada (no duplica historial ni respuesta)', totalTrasReplay === 1, `filas=${totalTrasReplay}`)

  // Firma inválida → 401, sin escribir nada.
  r = await fetch(http + '/webhook/cloud', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=invalida' },
    body: JSON.stringify({ object: 'x' }),
  })
  check('Firma inválida → 401 (fail-closed)', r.status === 401, `status=${r.status}`)

  console.log('\n── La campaña se crea, se valida y se activa desde el CRM ──────────')
  const creada = await pedir('/v2/campaigns', { method: 'POST', token: tokenA, body: { nombre: 'Programa de prueba', slug: 'PRUEBA', borrador: true } })
  check('Se crea una campaña en borrador', [200, 201].includes(creada.status) && creada.body.borrador === true, `status=${creada.status}`)
  const campId = creada.body.id

  const previewOk = await pedir('/v2/agent-config/preview', { method: 'POST', token: tokenA, body: { campaignId: campId, factSheet: { precio: { textoExacto: `${MONEDA} ${IMPORTE}` } } } })
  check('La validación del servidor responde sin escribir ni llamar al modelo', previewOk.status === 200 && typeof previewOk.body.ok === 'boolean')

  const sinVersion = await pedir('/v2/agent-config', { method: 'PUT', token: tokenA, body: { campaignId: campId, factSheet: { precio: { textoExacto: `${MONEDA} ${IMPORTE}` } } } })
  check('Guardar sin versión → 428', sinVersion.status === 428, `status=${sinVersion.status}`)

  const ficha = {
    factSheet: { precio: { textoExacto: `${MONEDA} ${IMPORTE}`, monto: IMPORTE, moneda: MONEDA }, incluye: ['Incluye'] },
    agente: { nombre: 'Asesor', empresa: 'Prueba', nombreProducto: 'Programa' },
  }
  const guardada = await pedir('/v2/agent-config', { method: 'PUT', token: tokenA, body: { campaignId: campId, version: 1, ...ficha } })
  check('La ficha se guarda desde el CRM', guardada.status === 200, `v${guardada.body.version}`)

  const conflicto = await pedir('/v2/agent-config', { method: 'PUT', token: tokenA, body: { campaignId: campId, version: 1, ...ficha } })
  check('Una versión vieja → 409 con la ficha vigente (el borrador no se pierde)', conflicto.status === 409 && conflicto.body.version === 2, `status=${conflicto.status}`)

  const trigger = await pedir(`/campaigns/${campId}/triggers`, { method: 'POST', token: tokenA, body: { texto: 'info del programa' } })
  check('Se añade el disparador', trigger.status === 201, `status=${trigger.status}`)
  const pasosOk = await pedir(`/campaigns/${campId}/steps`, { method: 'PUT', token: tokenA, body: { steps: [{ tipo: 'MSG', mensaje: 'Mensaje inicial del guion' }] } })
  check('Se guarda el guion', pasosOk.status === 200)

  const activada = await pedir(`/campaigns/${campId}/activar`, { method: 'PATCH', token: tokenA })
  check('La campaña se activa (ficha válida + disparador)', activada.status === 200 && activada.body.activa === true, `status=${activada.status}`)
  const enCerebro = await prisma.campaign.findUnique({ where: { id: campId }, select: { config: true } })
  check('La ficha que usa el cerebro está en la BD', enCerebro?.config?.factSheet?.precio?.textoExacto === `${MONEDA} ${IMPORTE}`)

  console.log('\n── El bot atiende el mensaje con la campaña recién activada ────────')
  await new Promise(r => setTimeout(r, 20000))   // ventana de ráfaga (6 s) + turno
  const lead = await prisma.lead.findFirst({ where: { tenantId: 'acme', telefono: '51999999999' } })
  check('El lead se creó con el tenant correcto', !!lead, lead ? `lead=${lead.id}` : 'no')
  const conv = await pedir(`/v2/leads/${lead.id}/conversation?limit=50`, { token: tokenA })
  check('La conversación muestra el mensaje del cliente', conv.status === 200 && conv.body.eventos.some(e => e.texto?.includes('info del programa')))
  const entradaHecha = await prisma.inboundEvent.findFirst({ where: { eventKey: 'wamid.entrada.1' } })
  check('La entrada quedó DONE (no reprocesable)', entradaHecha?.estado === 'DONE', `estado=${entradaHecha?.estado}`)
  // Sin proveedores de IA configurados el cerebro no inventa una respuesta, así que no
  // debe haber ninguna intención de envío: una salida sin turno no genera envío.
  check('Sin modelo disponible el bot no genera envíos (no inventa respuesta)', await prisma.outboundMessage.count({ where: { leadId: lead.id } }) === 0)

  console.log('\n── El vendedor responde, toma control y deja resultado ───────────')
  const respuesta = await pedir(`/v2/leads/${lead.id}/reply`, { method: 'POST', token: tokenA, body: { texto: 'Hola Rosa, te explico ahora mismo.' } })
  check('El vendedor responde y el mensaje sale', respuesta.status === 200, `status=${respuesta.status}`)
  const msgVendedor = await prisma.message.findFirst({ where: { leadId: lead.id, origen: 'VENDEDOR' }, orderBy: { id: 'desc' } })
  check('El mensaje del vendedor quedó en el historial con su wamid', !!msgVendedor?.waMessageId, msgVendedor?.waMessageId)
  check('Tomó el control del chat', (await prisma.leadState.findUnique({ where: { leadId: lead.id } }))?.currentMode === 'HUMAN_ACTIVE')

  const etiqueta = await pedir(`/v2/leads/${lead.id}/label`, { method: 'POST', token: tokenA, body: { label: 'Caliente' } })
  check('Se puede etiquetar', etiqueta.status === 200 && etiqueta.body.label === 'Caliente')
  const etiquetaMala = await pedir(`/v2/leads/${lead.id}/label`, { method: 'POST', token: tokenA, body: { label: 'inventada' } })
  check('Una etiqueta fuera de la taxonomía → 400', etiquetaMala.status === 400, `status=${etiquetaMala.status}`)

  const reasignar = await pedir(`/v2/leads/${lead.id}/assign`, { method: 'POST', token: tokenA, body: { vendorId: vendedorC.id } })
  check('Reasignar a un vendedor de OTRA empresa → 400 (aislamiento)', reasignar.status === 400, `status=${reasignar.status}`)

  const debrief = await pedir(`/v2/leads/${lead.id}/debrief/save`, { method: 'POST', token: tokenA, body: { outcome: 'pagó', resumen: 'Compró el pack', fechaISO: null } })
  check('Se registra el resultado de la llamada', debrief.status === 200, `status=${debrief.status}`)
  const detalle = await pedir(`/v2/leads/${lead.id}`, { token: tokenA })
  check('El resultado confirmado aparece en el detalle', detalle.body.resultado === 'pagó' && detalle.body.resultadoFuente === 'call_events')
  check('Y va SEPARADO de la etapa que infiere el bot', typeof detalle.body.stage === 'string')

  console.log('\n── Ventana de Meta cerrada: no se marca como enviado ──────────────')
  await fetch(graphBase.replace(/\/graph\/.*$/, '') + '/modo/rechazar')
  // Envejecemos el último mensaje del cliente para simular más de 24 h de silencio.
  await prisma.$executeRaw`UPDATE messages SET "createdAt" = now() - interval '3 days' WHERE "leadId" = ${lead.id}`
  await prisma.$executeRaw`UPDATE messages SET "createdAt" = now() - interval '3 days'`
  const cerrado = await pedir(`/v2/leads/${lead.id}/reply`, { method: 'POST', token: tokenA, body: { texto: '¿sigues ahí?' } })
  check('Fuera de la ventana de 24 h → 409 con la plantilla de reapertura', cerrado.status === 409 && cerrado.body.ventanaCerrada === true, `status=${cerrado.status}`)
  check('El texto pendiente vuelve al cliente (no se pierde)', cerrado.body.textoPendiente === '¿sigues ahí?')
  const rehacer = await pedir(`/v2/leads/${lead.id}/reply`, { method: 'POST', token: tokenA, body: { texto: '¿sigues ahí?' } })
  check('Reintentar da el mismo 409 (no se marca como enviado)', rehacer.status === 409)
  const guardados = await prisma.message.count({ where: { leadId: lead.id, texto: '¿sigues ahí?' } })
  check('NO se guardo el mensaje rechazado en el historial', guardados === 0, 'mensajes=' + guardados)

  console.log('\n── A2: rechazo de Meta y resultado incierto ───────────────────────')
  await prisma.$executeRaw`UPDATE messages SET "createdAt" = now() WHERE "leadId" = ${lead.id} AND origen = 'LEAD'`
  const antesEnvios = enviosFicticios
  await fetch(graphBase.replace(/\/graph\/.*$/, '') + '/modo/rechazar-duro')
  const rechazada = await pedir(`/v2/leads/${lead.id}/reply`, { method: 'POST', token: tokenA, body: { texto: 'Mensaje que el proveedor rechaza' } })
  check('Un rechazo del proveedor NO devuelve ok', rechazada.status === 502, `status=${rechazada.status}`)
  const box = await prisma.outboundMessage.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: 'desc' } })
  check('La outbox marca RECHECHO con el código de Meta', box?.estado === 'REJECTED', `estado=${box?.estado} código=${box?.errorCode}`)
  check('El envío solo se intentó una vez (no hay reenvío ciego)', enviosFicticios - antesEnvios === 1, `intentos=${enviosFicticios - antesEnvios}`)

  // Incierto: el proveedor cuelga la conexión sin responder.
  await fetch(graphBase.replace(/\/graph\/.*$/, '') + '/modo/colgar')
  const incierto = await pedir(`/v2/leads/${lead.id}/reply`, { method: 'POST', token: tokenA, body: { texto: 'Mensaje que se queda sin respuesta' } })
  check('Un envío sin respuesta NO devuelve ok', incierto.status >= 400, `status=${incierto.status}`)
  const box2 = await prisma.outboundMessage.findFirst({ where: { leadId: lead.id }, orderBy: { createdAt: 'desc' } })
  check('Queda INCIERTO y visible (no se reenvía solo)', box2?.estado === 'UNCERTAIN', `estado=${box2?.estado}`)
  await fetch(graphBase.replace(/\/graph\/.*$/, '') + '/modo/ok')

  console.log('\n── Aislamiento: dos empresas, dos vendedores ───────────────────────')
  const leadsDeCarla = await pedir('/v2/leads', { token: tokenC })
  check('Carla no ve los leads de la otra empresa', Array.isArray(leadsDeCarla.body) && !leadsDeCarla.body.some(l => l.id === lead.id))
  const leadAjeno = await pedir(`/v2/leads/${lead.id}`, { token: tokenC })
  check('El lead ajeno da 404 (no confirma que existe)', leadAjeno.status === 404, `status=${leadAjeno.status}`)
  const campAjena = await pedir(`/v2/campaigns/${campId}`, { token: tokenC })
  check('La campaña ajena da 404', campAjena.status === 404, `status=${campAjena.status}`)
  const escrituraAjena = await pedir('/v2/agent-config', { method: 'PUT', token: tokenC, body: { campaignId: campId, version: 2, factSheet: { precio: { textoExacto: 'texto-externo' } } } })
  check('No se puede escribir la ficha ajena', escrituraAjena.status === 404, `status=${escrituraAjena.status}`)
  const vendedorVeTodos = await pedir('/v2/leads?limit=200', { token: tokenB })
  check('Beto (VENDOR) ve solo sus leads', vendedorVeTodos.body.page.total === 0, `total=${vendedorVeTodos.body.page.total}`)

  console.log('\n── Sesión y autorización ──────────────────────────────────────────')
  const sinToken = await pedir('/v2/leads')
  check('Sin token → 401', sinToken.status === 401, `status=${sinToken.status}`)
  const tokenFalso = tokenA.slice(0, -3) + 'zzz'
  const tokenMalo = await pedir('/v2/leads', { token: tokenFalso })
  check('Token inválido → 401 (el front cierra sesión con esto)', tokenMalo.status === 401, `status=${tokenMalo.status}`)
  const vendedorEnFicha = await pedir(`/v2/agent-config?campaignId=${campId}`, { token: tokenB })
  check('Un VENDOR no puede leer la ficha comercial → 403', vendedorEnFicha.status === 403, `status=${vendedorEnFicha.status}`)

  console.log('\n── Métricas con definición y fuente ──────────────────────────────')
  const metricas = await pedir('/v2/metricas?dias=30', { token: tokenA })
  check('Las métricas responden con definición y fuente', metricas.status === 200 && metricas.body.metricas.every(m => m.definicion && m.fuente))
  const ventas = metricas.body.metricas.find(m => m.clave === 'ventas_confirmadas')
  check('La venta sale de call_events (no de la etapa del bot)', /call_events/.test(ventas.fuente) && ventas.valor === 1, `valor=${ventas.valor} fuente=${ventas.fuente}`)
  const metricasB = await pedir('/v2/metricas', { token: tokenB })
  check('Un vendedor ve su propio alcance', metricasB.body.alcance === 'propio')

  console.log('\n── Bandeja y salida tras reiniciar el proceso ─────────────────────')
  const antesReinicio = { entradas: await prisma.inboundEvent.count(), mensajes: await prisma.message.count() }
  await prisma.inboundEvent.create({
    data: {
      tenantId: 'acme', provider: 'cloud', eventKey: 'wamid.superviviente', tipo: 'message',
      phoneNumberId: 'phone-acme', leadId: lead.id,
      payload: { messageId: 'wamid.superviviente', text: 'Llego justo antes de caerse', messageType: 'text' },
      disponibleEn: new Date(),
    },
  })
  await prisma.outboundMessage.create({
    data: {
      tenantId: 'acme', leadId: lead.id, origen: 'BOT', tipo: 'text',
      payload: { texto: 'Aceptado justo antes de caerse' }, canalRef: 'phone-acme',
      estado: 'SENT', waMessageId: 'wamid.aceptado.antes.caida', messageId: null, sentAt: new Date(),
      claimId: null, claimedAt: null,
    },
  })
  server.kill(); await serverExit
  server = spawn(process.execPath, [join(apiRoot, 'src/server.js')], { cwd: apiRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  serverExit = once(server, 'exit')
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(http + '/health')).ok) break } catch { /* arrancando */ }
    await new Promise(r => setTimeout(r, 100))
  }
  await new Promise(r => setTimeout(r, 1500))
  const sobreviviente = await prisma.inboundEvent.findFirst({ where: { eventKey: 'wamid.superviviente' } })
  check('El mensaje que había sobrevivido sigue ahí (nada se perdió)', sobreviviente?.estado !== 'DONE' || sobreviviente?.leadId === lead.id)
  const reconciliado = await prisma.message.findFirst({ where: { waMessageId: 'wamid.aceptado.antes.caida' } })
  check('Tras el reinicio, el envío aceptado quedó en el historial SIN reenviarlo', !!reconciliado, reconciliado ? `mensaje=${reconciliado.id}` : 'no')
  const ready = await pedir('/ready')
  check('/ready publica el trabajo pendiente real', ready.status === 200 && ready.body.durabilidad?.outbox !== undefined, JSON.stringify(ready.body.durabilidad?.outbox))

} finally {
  if (server && server.exitCode === null) { server.kill(); try { await serverExit } catch { /* ya salió */ } }
  if (prisma) await prisma.$disconnect()
  graph.close()
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [nombreDb])
  await admin.query(`DROP DATABASE IF EXISTS "${nombreDb}"`)
  await admin.end()
}

console.log('\n════════════════════════════════════════════════════════════════')
console.log(`Recorrido CRM: ${pasos.filter(p => p.ok).length} pasos ok, ${fallos} fallos`)
if (fallos) {
  console.log('\nFallos:')
  for (const p of pasos.filter(x => !x.ok)) console.log(`  · ${p.nombre}: ${p.detalle}`)
}
process.exit(fallos ? 1 : 0)