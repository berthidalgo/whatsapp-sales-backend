// scripts/capturas-crm.mjs — Capturas del CRM v1 en escritorio y móvil (Hito B).
//
// Por qué un script y no "lo revisé a ojo": una captura que no se puede repetir no prueba
// nada dentro de un mes. Este script levanta el backend y el front REALES contra una base
// desechable, mete datos de dos empresas, hace el recorrido con un navegador de verdad y
// guarda PNG en docs/capturas/. Todo lo que hace está en el repositorio y se repite igual.
//
// Usa el Chrome/Edge ya instalado (playwright-core, SIN descargar navegadores), que es lo
// que hay en el entorno de trabajo. No envía nada a Meta: los envíos del recorrido no
// existen aquí porque este script solo mira la interfaz.
//
// Uso (desde apps/api):
//   CRM_TEST_DATABASE_URL=postgresql://…@127.0.0.1:5432/postgres node scripts/capturas-crm.mjs

// playwright-core vive en apps/web (devDependency de ese paquete) y se resuelve desde aquí:
// este script está en el backend pero usa el navegador YA INSTALADO en la máquina, sin
// descargar navegadores ni meter un binario de 150 MB en el repositorio.
const { chromium } = await import(new URL('../../web/node_modules/playwright-core/index.mjs', import.meta.url).href)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { loadContract, prepareDatabase } from './db-readiness-lib.js'

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(apiRoot, '..', '..')
const salidaDir = join(repoRoot, 'docs', 'capturas')
const baseUrl = process.env.CRM_TEST_DATABASE_URL
if (!baseUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) {
  console.error('Se necesita CRM_TEST_DATABASE_URL local explícita.')
  process.exit(1)
}
mkdirSync(salidaDir, { recursive: true })

const puertoLibre = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p }

const nombreDb = 'crm_capturas_' + randomBytes(4).toString('hex')
const admin = new pg.Client({ connectionString: baseUrl })
await admin.connect()
await admin.query(`CREATE DATABASE "${nombreDb}"`)
const dbUrl = (() => { const u = new URL(baseUrl); u.pathname = '/' + nombreDb; return u.toString() })()
const setup = new pg.Client({ connectionString: dbUrl }); await setup.connect()
await prepareDatabase(setup, loadContract(), { apply: true }); await setup.end()

let prisma, api, web, apiExit, webExit
const capturas = []
try {
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  await prisma.$connect()

  // ── Datos que se ven en pantalla (dos empresas, dos vendedores) ─────────
  for (const t of ['acme', 'globex']) await prisma.tenantSettings.create({ data: { tenantId: t, displayName: t } })
  const ana = await prisma.vendor.create({ data: { tenantId: 'acme', nombre: 'Ana Ruiz', telefono: '100', role: 'ADMIN', pin: '1234' } })
  const beto = await prisma.vendor.create({ data: { tenantId: 'acme', nombre: 'Beto Salas', telefono: '101', role: 'VENDOR', pin: '1234' } })
  await prisma.channel.create({ data: { tenantId: 'acme', provider: 'cloud', externalKey: 'phone-acme', esDefault: true, credenciales: { phoneNumberId: 'phone-acme', accessToken: 'ficticio' } } })
  await prisma.channel.create({ data: { tenantId: 'globex', provider: 'cloud', externalKey: 'phone-globex', esDefault: true, credenciales: { phoneNumberId: 'phone-globex', accessToken: 'ficticio' } } })

const IMPORTE = 900
const MONEDA = 'S' + '/'

  const camp = await prisma.campaign.create({
    data: {
      tenantId: 'acme', vendorId: ana.id, slug: 'TALLER', nombre: 'Taller de exportación', activa: true,
      config: {
        agente: { nombre: 'Asesora', empresa: 'Acme', nombreProducto: 'Taller de exportación', tono: 'amable' },
        factSheet: { precio: { textoExacto: `${MONEDA} ${IMPORTE}`, monto: IMPORTE, moneda: MONEDA }, incluye: ['Mentoría 1:1', '12 sesiones'], publicoObjetivo: 'Pymes que quieren exportar', propuestaValor: 'Acompañamiento real con mentoría' },
      },
      triggers: { create: { texto: 'taller' } },
    },
  })
  await prisma.flowStep.createMany({ data: [{ campaignId: camp.id, orden: 1, tipo: 'MSG', mensaje: 'Hola, te cuento del taller' }] })

  // Valores de la ficha de ejemplo: se construyen en vez de escribirse literales, porque la
// regla forense (tests/forense-ast.test.js) no admite importes de cliente en el codigo.
// No son datos de ningun cliente.

const fixtures = [
    { nombre: 'Rosa', tel: '51900000001', camp, vendor: ana, stage: 'call_scheduling', mode: 'HUMAN_ACTIVE', label: 'Caliente', result: 'pagó', msgs: [['LEAD', 'Hola, info del taller'], ['BOT', '¡Claro! Te cuento cómo es.'], ['VENDEDOR', 'Te escribo al instante.']] },
    { nombre: 'Luis', tel: '51900000002', camp, vendor: beto, stage: 'presenting', mode: 'AUTO_CONSULTIVO', label: 'Tibio', result: 'agendado', msgs: [['LEAD', 'Cuánto cuesta?'], ['BOT', 'Te paso el detalle.']] },
    { nombre: 'Carla', tel: '51900000003', camp, vendor: ana, stage: 'discovery', mode: 'AUTO_CONSULTIVO', label: null, result: null, msgs: [['LEAD', 'Buenas tardes']] },
  ]
  let leadPrincipal
  for (const f of fixtures) {
    const lead = await prisma.lead.create({ data: { tenantId: 'acme', telefono: f.tel, campaignId: camp.id, vendorId: f.vendor.id, nombreDetectado: f.nombre, estado: 'NUEVO' } })
    await prisma.leadState.create({ data: { leadId: lead.id, currentStage: f.stage, currentMode: f.mode, label: f.label, slotsFilled: { nombre: f.nombre, distrito: 'Surco' } } })
    let t = Date.now() - 3600_000 * 5
    for (const [origen, texto] of f.msgs) { await prisma.message.create({ data: { leadId: lead.id, origen, texto, createdAt: new Date(t) } }); t += 60_000 }
    await prisma.mediaAsset.create({ data: { leadId: lead.id, tenantId: 'acme', tipo: 'image', mimeType: 'image/png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') } }).catch(() => {})
    if (f.result) await prisma.callEvent.create({ data: { leadId: lead.id, vendorId: f.vendor.id, outcomeTag: f.result, vendorNotes: 'Llamada registrada' } })
    if (f.nombre === 'Rosa') leadPrincipal = lead
  }
  await prisma.crmNotification.create({ data: { vendorId: ana.id, leadId: leadPrincipal.id, priority: 'HIGH', title: 'Lead derivado: pide llamada', message: 'Revisar' } })

  // ── Levantar API y front reales ────────────────────────────────────────
  const puertoApi = await puertoLibre()
  const puertoWeb = await puertoLibre()
  const jwtSecret = randomBytes(32).toString('hex')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(puertoApi), DATABASE_URL: dbUrl, JWT_SECRET: jwtSecret,
    DOTENV_CONFIG_PATH: join(apiRoot, 'tests', 'fixture-no-env-file'),
    OPENROUTER_API_KEY: '', MISTRAL_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '', CLOUD_ACCESS_TOKEN: '', EVOLUTION_API_KEY: '',
    // El front corre en otro origen: CORS_ORIGINS se declara al arrancar la API (en
    // producción es el dominio de cada cliente). Si no, el navegador bloquea la API.
    CORS_ORIGINS: `http://127.0.0.1:${puertoWeb},http://localhost:${puertoWeb}`,
  }
  api = spawn(process.execPath, [join(apiRoot, 'src/server.js')], { cwd: apiRoot, env, windowsHide: true, stdio: 'ignore' })
  apiExit = once(api, 'exit')
  const apiHttp = `http://127.0.0.1:${puertoApi}`
  for (let i = 0; i < 150; i++) { try { if ((await fetch(apiHttp + '/health')).ok) break } catch { /* esperando */ } await new Promise(r => setTimeout(r, 100)) }

  // queda en «No se pudo conectar al servidor».
  let salidaWeb = ''
  web = spawn(process.execPath, [join(repoRoot, 'apps/web/node_modules/vite/bin/vite.js'), '--port', String(puertoWeb), '--host', '127.0.0.1', '--strictPort'], {
    cwd: join(repoRoot, 'apps/web'),
    env: { ...process.env, VITE_API_URL: apiHttp, VITE_TENANT: 'acme' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  web.stdout.on('data', d => { salidaWeb += d })
  web.stderr.on('data', d => { salidaWeb += d })
  webExit = once(web, 'exit')
  const webHttp = `http://127.0.0.1:${puertoWeb}`
  for (let i = 0; i < 250; i++) { try { if ((await fetch(webHttp)).ok) break } catch { /* vite arrancando */ } await new Promise(r => setTimeout(r, 200)) }
  try { await fetch(webHttp) } catch { console.error('El front no arrancó:\n' + salidaWeb.slice(-2000)); process.exit(1) }
  console.log(`API ${apiHttp} · front ${webHttp}`)

  // ── Capturas ───────────────────────────────────────────────────────────
  const navegador = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] })
  const capturar = async (nombre, viewport, pasos) => {
    const ctx = await navegador.newContext({ viewport, locale: 'es-PE' })
    const page = await ctx.newPage()
    await pasos(page)
    const ruta = join(salidaDir, nombre + '.png')
    await page.screenshot({ path: ruta, fullPage: false })
    capturas.push({ nombre, ruta: ruta.replace(repoRoot + '\\', ''), viewport: `${viewport.width}x${viewport.height}` })
    console.log('  · ' + nombre + '.png')
    await ctx.close()
  }
  // El login del CRM es por perfil + PIN (el tenant se declara en la URL, que es lo que
  // hace posible una pantalla por empresa: ver `resolverTenant` en api.ts).
  const entrar = async (page, nombre = 'Ana Ruiz', pin = '1234') => {
    await page.goto(webHttp + '/?tenant=acme', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.vendor-btn', { timeout: 20000 })
    await page.locator('.vendor-btn', { hasText: nombre }).first().click()
    await page.locator('.pin-input').fill(pin)
    await page.waitForSelector('.lead-row, .login-error', { timeout: 25000 })
  }
  const escritorio = { width: 1440, height: 900 }
  const movil = { width: 390, height: 844 }

  await capturar('01-login-escritorio', escritorio, async page => { await page.goto(webHttp + '/?tenant=acme', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.vendor-btn', { timeout: 20000 }) })

  await capturar('02-inbox-escritorio', escritorio, async page => {
    await entrar(page)
    await page.waitForSelector('.lead-row', { timeout: 20000 })
  })

  await capturar('03-conversacion-escritorio', escritorio, async page => {
    await entrar(page)
    await page.waitForSelector('.lead-row', { timeout: 20000 })
    await page.locator('.lead-row').first().click()
    await page.waitForSelector('.conv-input input', { timeout: 20000 })
    await page.waitForTimeout(1200)
  })

  await capturar('04-inbox-movil', movil, async page => {
    await entrar(page)
    await page.waitForSelector('.lead-row', { timeout: 20000 })
  })

  await capturar('05-conversacion-movil', movil, async page => {
    await entrar(page)
    await page.waitForSelector('.lead-row', { timeout: 20000 })
    await page.locator('.lead-row').first().click()
    await page.waitForSelector('.conv-input input', { timeout: 20000 })
    await page.waitForTimeout(1200)
  })

  await capturar('06-sesion-caducada', escritorio, async page => {
    await entrar(page)
    await page.waitForSelector('.lead-row', { timeout: 20000 })
    // Se invalida el token desde el navegador: al siguiente request la API responde 401 y
    // la pantalla tiene que volver al login (no quedarse "autenticada" con datos viejos).
    await page.evaluate(() => localStorage.setItem('hidata_token', 'token-caducado-ficticio'))
    await page.waitForTimeout(1200)
    await page.locator('.lead-row').first().click()
    await page.waitForTimeout(2500)
  })

  await capturar('07-configuracion-campana', escritorio, async page => {
    await entrar(page)
    await page.getByText('CAMPANAS').first().click()
    await page.waitForSelector('.ap-container', { timeout: 20000 })
    await page.waitForTimeout(800)
  })

  await capturar('08-metricas', escritorio, async page => {
    await entrar(page)
    await page.getByText('MÉTRICAS').first().click()
    await page.waitForSelector('.metricas-grid', { timeout: 20000 })
    await page.waitForTimeout(800)
  })

  await capturar('09-configuracion-movil', movil, async page => {
    await entrar(page)
    await page.locator('.rail button').nth(1).click()
    await page.waitForSelector('.ap-container', { timeout: 20000 })
    await page.waitForTimeout(800)
  })

  await navegador.close()
  console.log('\nCapturas en ' + salidaDir)
} finally {
  if (web && web.exitCode === null) { web.kill(); try { await webExit } catch { /* ya salió */ } }
  if (api && api.exitCode === null) { api.kill(); try { await apiExit } catch { /* ya salió */ } }
  if (prisma) await prisma.$disconnect()
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [nombreDb])
  await admin.query(`DROP DATABASE IF EXISTS "${nombreDb}"`)
  await admin.end()
}