// tests/cloud-api.test.js — WHATSAPP API OFICIAL (Meta) MULTITENANT
//
// Congela el adaptador de Meta reescrito en sep-2026 para el número de Hidata:
//   · el tenant sale del número que recibió el mensaje (phone_number_id → channels),
//   · el turno es el MISMO que el de Evolution (procesarTurno), no una copia,
//   · audios y fotos se convierten en texto antes del cerebro,
//   · la firma de Meta se valida sobre los bytes crudos del cuerpo,
//   · usuarios con username (BSUID, sin teléfono) también se atienden,
//   · fuera de la ventana de 24 h no se intenta texto libre.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { parseCloudWebhook } from '../src/whatsapp/cloud/parser.js'
import { destinatarioCloud } from '../src/whatsapp/cloud/sender.js'
import { verifySignature } from '../src/whatsapp/cloud/webhook.js'
import { transporteDe, credencialesCloud } from '../src/whatsapp/transporte.js'
import { resolveIdentity } from '../src/webhook/lead-resolver.js'
import { politicaEnvio } from '../src/motor/followupEngine.js'
import { procesarMensajeCloud } from '../src/whatsapp/cloud/router.js'
import { registrarJsonConCuerpoCrudo } from '../src/lib/json-crudo.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ── Payloads de ejemplo con la forma real de Meta ───────────────────────
const envoltura = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }] })
const meta = { metadata: { phone_number_id: '1111111111', display_phone_number: '51999999999' } }

// ── Parser ──────────────────────────────────────────────────────────────

test('parser: texto normal trae teléfono, nombre y el número que lo recibió', () => {
  const [ev] = parseCloudWebhook(envoltura({ ...meta,
    contacts: [{ wa_id: '51987654321', profile: { name: 'María' } }],
    messages: [{ from: '51987654321', id: 'wamid.1', type: 'text', text: { body: 'hola' } }] }))
  assert.equal(ev.telefono, '51987654321')
  assert.equal(ev.pushName, 'María')
  assert.equal(ev.text, 'hola')
  assert.equal(ev.phoneNumberId, '1111111111')
  assert.equal(ev.bsuid, null)
})

test('parser: usuario con username llega SIN teléfono, solo con BSUID', () => {
  const [ev] = parseCloudWebhook(envoltura({ ...meta,
    contacts: [{ user_id: 'PE.8f3a2b', profile: { name: 'Rosa' } }],
    messages: [{ from_user_id: 'PE.8f3a2b', id: 'wamid.2', type: 'text', text: { body: 'precio?' } }] }))
  assert.equal(ev.telefono, null)
  assert.equal(ev.bsuid, 'PE.8f3a2b')
  assert.equal(ev.pushName, 'Rosa')
})

test('parser: foto con pie → el pie es el texto; audio → mediaId para transcribir', () => {
  const evs = parseCloudWebhook(envoltura({ ...meta, messages: [
    { from: '519', id: 'a', type: 'image', image: { id: 'MEDIA1', caption: 'así tengo la piel' } },
    { from: '519', id: 'b', type: 'audio', audio: { id: 'MEDIA2' } }
  ] }))
  assert.equal(evs[0].text, 'así tengo la piel')
  assert.equal(evs[1].text, null)
  assert.equal(evs[1].mediaId, 'MEDIA2')
})

test('parser: quien llega de un anuncio (Click-to-WhatsApp) trae el titular, el ID del anuncio y el ctwa_clid', () => {
  const [ev] = parseCloudWebhook(envoltura({ ...meta, messages: [{
    from: '51987654321', id: 'wamid.ad', type: 'text', text: { body: 'Hola, quiero más información' },
    referral: { source_url: 'https://fb.me/x', source_id: '120210000000', source_type: 'ad', headline: 'Colágeno Premium 2x1', body: 'Solo esta semana', ctwa_clid: 'ARAkLmN0' }
  }] }))
  assert.equal(ev.adContext.adReplyTitle, 'Colágeno Premium 2x1', 'el Campaign Resolver (Plan B) matchea por el titular')
  assert.equal(ev.adContext.sourceId, '120210000000')
  assert.equal(ev.adContext.ctwaClid, 'ARAkLmN0')
  assert.equal(ev.adContext.conversionSource, 'FB_Ads')
  const [organico] = parseCloudWebhook(envoltura({ ...meta, messages: [{ from: '519', id: 'o', type: 'text', text: { body: 'hola' } }] }))
  assert.equal(organico.adContext, null)
})

test('parser: solo procesa webhooks de WhatsApp Business', () => {
  assert.deepEqual(parseCloudWebhook({ object: 'page', entry: [] }), [])
})

// ── Destinatario y transporte ───────────────────────────────────────────

test('destinatario: teléfono va en "to"; BSUID en "recipient"', () => {
  assert.deepEqual(destinatarioCloud('51987654321'), { to: '51987654321' })
  assert.deepEqual(destinatarioCloud('51987654321@s.whatsapp.net'), { to: '51987654321' })
  assert.deepEqual(destinatarioCloud('PE.8f3a2b'), { recipient: 'PE.8f3a2b' })
  assert.equal(destinatarioCloud(''), null)
})

test('transporte: lo decide el canal de cada cliente, no un interruptor global', () => {
  assert.equal(transporteDe({ provider: 'cloud' }), 'cloud')
  assert.equal(transporteDe({ provider: 'evolution' }), 'evolution')
  const antes = process.env.WHATSAPP_PROVIDER
  process.env.WHATSAPP_PROVIDER = 'cloud'
  assert.equal(transporteDe(null), 'cloud', 'sin canal, cae al interruptor global')
  if (antes === undefined) delete process.env.WHATSAPP_PROVIDER; else process.env.WHATSAPP_PROVIDER = antes
})

test('credenciales: el phone_number_id sale de la llave del canal; el token puede ser propio', () => {
  assert.deepEqual(credencialesCloud({ provider: 'cloud', externalKey: '1111' }), { phoneNumberId: '1111', accessToken: null })
  assert.deepEqual(credencialesCloud({ provider: 'cloud', externalKey: '1111', credenciales: { accessToken: 'tok' } }), { phoneNumberId: '1111', accessToken: 'tok' })
  assert.equal(credencialesCloud({ provider: 'evolution', externalKey: 'bioayur' }), null)
  assert.equal(credencialesCloud(null), null)
})

test('identidad: un BSUID se guarda tal cual (no se le quitan letras como a un teléfono)', () => {
  const id = resolveIdentity({ remoteJid: 'PE.8f3a2b@bsuid' })
  assert.equal(id.phone, null)
  assert.equal(id.bsuid, 'PE.8f3a2b')
  assert.equal(id.addressingMode, 'bsuid')
  assert.equal(resolveIdentity({ remoteJid: '51987654321@s.whatsapp.net' }).phone, '51987654321')
})

// ── Ventana de 24 h ─────────────────────────────────────────────────────

test('ventana 24 h: con Meta, fuera de ventana solo sale con plantilla; con Evolution, siempre texto', () => {
  assert.deepEqual(politicaEnvio('evolution', 'followup_24h', {}), { accion: 'texto' })
  assert.deepEqual(politicaEnvio('cloud', 'followup_2h', {}), { accion: 'texto' })
  assert.equal(politicaEnvio('cloud', 'followup_24h', {}).accion, 'omitir')
  assert.deepEqual(politicaEnvio('cloud', 'followup_24h', { CLOUD_TEMPLATE_FOLLOWUP_24H: 'seguimiento' }), { accion: 'plantilla', plantilla: 'seguimiento' })
  assert.equal(politicaEnvio('cloud', 'compromiso', {}).accion, 'omitir')
})

// ── Router: del webhook al turno ────────────────────────────────────────

const canalHidata = { resolvedBy: 'channel', tenantId: 'hidata', provider: 'cloud', externalKey: '1111111111', estadoSuscripcion: 'trial', activo: true }

function depsFalsas(extra = {}) {
  const llamadas = { enqueue: [], turno: [], resolveLead: [], noTexto: 0, media: 0 }
  const deps = {
    checkAndMark: () => true,
    resolveChannel: async () => canalHidata,
    tenantAtiende: () => ({ atiende: true }),
    resolveLead: async (a) => { llamadas.resolveLead.push(a); return { ok: true, leadId: 42, telefono: a.senderPn ? '51987654321' : 'PE.8f3a2b', isArchived: false } },
    enqueueMessage: (a) => { llamadas.enqueue.push(a); return { queued: true } },
    procesarTurno: async (leadInfo, texto) => { llamadas.turno.push({ leadInfo, texto }) },
    convertirMediaATexto: async () => { llamadas.media++; return 'texto de la nota de voz' },
    responderNoTexto: async () => { llamadas.noTexto++ },
    ...extra
  }
  return { deps, llamadas }
}
const evTexto = { tipo: 'message', messageId: 'wamid.1', telefono: '51987654321', bsuid: null, pushName: 'María', messageType: 'text', text: 'hola', phoneNumberId: '1111111111' }

test('router: un texto entra al MISMO turno que Evolution, con el canal y el tenant del número', async () => {
  const { deps, llamadas } = depsFalsas()
  const r = await procesarMensajeCloud(evTexto, deps)
  assert.equal(r.queued, true)
  assert.equal(llamadas.resolveLead[0].tenantId, 'hidata', 'el tenant sale del canal, no de ACTIVE_TENANT')
  await llamadas.enqueue[0].processFn('hola', {})
  const { leadInfo } = llamadas.turno[0]
  assert.equal(leadInfo.channel.provider, 'cloud', 'la respuesta sale por Meta')
  assert.equal(leadInfo.tenantId, 'hidata')
})

test('router: el contexto del anuncio llega al Campaign Resolver (antes se perdía con Meta)', async () => {
  const { deps, llamadas } = depsFalsas()
  const adContext = { adReplyTitle: 'Colágeno Premium 2x1', sourceId: '1202', hasAdContext: true }
  await procesarMensajeCloud({ ...evTexto, adContext }, deps)
  assert.equal(llamadas.resolveLead[0].adContext, adContext)
})

test('router: Meta reintenta webhooks → el mensaje repetido no se procesa dos veces', async () => {
  const vistos = new Set()
  const { deps, llamadas } = depsFalsas({ checkAndMark: (id) => vistos.has(id) ? false : (vistos.add(id), true) })
  await procesarMensajeCloud(evTexto, deps)
  const r2 = await procesarMensajeCloud(evTexto, deps)
  assert.equal(r2.reason, 'duplicado')
  assert.equal(llamadas.enqueue.length, 1)
})

test('router: un número que no está en channels se ignora (no cae al cliente por defecto)', async () => {
  const { deps, llamadas } = depsFalsas({ resolveChannel: async () => ({ resolvedBy: 'active_tenant_fallback', tenantId: 'peru_exporta' }) })
  const r = await procesarMensajeCloud(evTexto, deps)
  assert.equal(r.reason, 'canal_desconocido')
  assert.equal(llamadas.resolveLead.length, 0, 'ni siquiera se crea el lead')
})

test('router: cliente con la suscripción cortada no se atiende', async () => {
  const { deps, llamadas } = depsFalsas({ tenantAtiende: () => ({ atiende: false, motivo: 'suscripción vencido' }) })
  const r = await procesarMensajeCloud(evTexto, deps)
  assert.match(r.reason, /sin_servicio/)
  assert.equal(llamadas.enqueue.length, 0)
})

test('router: usuario con username (solo BSUID) se atiende igual', async () => {
  const { deps, llamadas } = depsFalsas()
  const r = await procesarMensajeCloud({ ...evTexto, telefono: null, bsuid: 'PE.8f3a2b' }, deps)
  assert.equal(r.queued, true)
  assert.equal(llamadas.resolveLead[0].remoteJid, 'PE.8f3a2b@bsuid')
})

test('router: una nota de voz se transcribe y entra como texto; un sticker no', async () => {
  const { deps, llamadas } = depsFalsas()
  const r = await procesarMensajeCloud({ ...evTexto, messageType: 'audio', text: null, mediaId: 'M1' }, deps)
  assert.equal(r.queued, true)
  assert.equal(llamadas.media, 1)
  assert.equal(llamadas.enqueue[0].text, 'texto de la nota de voz')
  const r2 = await procesarMensajeCloud({ ...evTexto, messageId: 'wamid.9', messageType: 'sticker', text: null, mediaId: 'M2' }, deps)
  assert.equal(r2.queued, false)
  assert.equal(llamadas.noTexto, 1)
})

// ── Firma de Meta sobre el cuerpo crudo ─────────────────────────────────

async function appDePrueba() {
  const app = Fastify()
  registrarJsonConCuerpoCrudo(app)
  app.post('/webhook/cloud', async (req) => ({ firma: verifySignature(req.rawBody, req.headers['x-hub-signature-256']), body: req.body ?? null }))
  return app
}

test('firma: se valida sobre los bytes exactos; un cuerpo alterado no pasa', async () => {
  const antes = process.env.CLOUD_APP_SECRET
  process.env.CLOUD_APP_SECRET = 'secreto-de-la-app'
  try {
    const app = await appDePrueba()
    const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [], nota: 'ñandú 💜' })
    const firma = 'sha256=' + crypto.createHmac('sha256', 'secreto-de-la-app').update(cuerpo).digest('hex')
    const ok = await app.inject({ method: 'POST', url: '/webhook/cloud', payload: cuerpo, headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma } })
    assert.equal(ok.json().firma.ok, true, 'con acentos y emojis los bytes deben coincidir')
    const alterado = await app.inject({ method: 'POST', url: '/webhook/cloud', payload: cuerpo.replace('ñandú', 'nandu'), headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma } })
    assert.equal(alterado.json().firma.reason, 'signature_mismatch')
    await app.close()
  } finally {
    if (antes === undefined) delete process.env.CLOUD_APP_SECRET; else process.env.CLOUD_APP_SECRET = antes
  }
})

test('parser JSON: sigue bloqueando __proto__ y acepta cuerpo vacío', async () => {
  const app = await appDePrueba()
  const envenenado = await app.inject({ method: 'POST', url: '/webhook/cloud', payload: '{"__proto__":{"admin":true}}', headers: { 'content-type': 'application/json' } })
  assert.equal(envenenado.statusCode, 400)
  const vacio = await app.inject({ method: 'POST', url: '/webhook/cloud', payload: '', headers: { 'content-type': 'application/json' } })
  assert.equal(vacio.statusCode, 200)
  await app.close()
})

test('server: el webhook de Meta exige firma sobre req.rawBody y no depende del interruptor global', () => {
  const server = readFileSync(join(SRC, 'server.js'), 'utf8')
  assert.match(server, /registrarJsonConCuerpoCrudo\(app\)/)
  assert.match(server, /if \(!cloudWebhookHabilitado\(\)\)/)
  assert.match(server, /verifySignature\(req\.rawBody, sig\)/)
})
