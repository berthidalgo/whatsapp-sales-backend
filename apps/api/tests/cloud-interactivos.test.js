// tests/cloud-interactivos.test.js — LO APRENDIDO DEL EJEMPLO DE META (Jasper's Market), sep 2026
//
// Congela las piezas que se traen del ejemplo oficial de Meta para vender más por WhatsApp:
//   · mensajes interactivos (botones, lista, botón de enlace) con los límites de Meta,
//   · parámetros de plantillas de oferta por tiempo limitado y de carrusel,
//   · «leído» + «escribiendo…» antes de que conteste el bot,
//   · el catálogo de plantillas que el bot necesita, validado contra las reglas de Meta.
// Ninguna prueba toca la red ni la base: fetch y prisma son de mentira.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  botonesDeRespuesta, listaDeOpciones, botonDeEnlace, interactivoDeOpciones, opcionesComoTexto, ErrorInteractivo, LIMITES
} from '../src/whatsapp/cloud/interactivos.js'
import {
  componenteCuerpo, componenteEncabezadoImagen, componenteBotonCupon, componenteBotonUrl, componenteBotonRespuesta,
  componentesOfertaLimitada, componentesCarrusel, sanearComponentes, ErrorPlantilla
} from '../src/whatsapp/cloud/plantillas.js'
import { sendInteractiveCloud, sendTemplateCloud, marcarLeidoCloud } from '../src/whatsapp/cloud/sender.js'
import { indicarEscribiendo, escribiendoHabilitado } from '../src/whatsapp/cloud/escribiendo.js'
import { procesarMensajeCloud, procesarWebhookCloud } from '../src/whatsapp/cloud/router.js'
import { parseCloudWebhook, eventoDePlantilla } from '../src/whatsapp/cloud/parser.js'
import { enviarOpciones } from '../src/whatsapp/interactivo.js'
import {
  CATALOGO, validarPlantilla, payloadDeCreacion, payloadDeEdicion, variablesDelCuerpo, nombreConfigurado, idiomaValido,
  textoDePlantilla, planificarPlantillas, lineasDeEntorno, cuerpoEnMeta, describirEventoDePlantilla, plantillaPorNombre
} from '../src/whatsapp/cloud/plantillas-catalogo.js'
import { componentesAvisoVendedor } from '../src/webhook/notifications.js'
import { MODES } from '../src/state/stage-definitions.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ── utilidades de prueba ────────────────────────────────────────────────

/** Reemplaza fetch por una función que registra las llamadas y responde `respuesta`. */
async function conFetchFalso(respuesta, fn) {
  const original = globalThis.fetch
  const llamadas = []
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null })
    return { ok: respuesta.ok ?? true, status: respuesta.status ?? 200, json: async () => respuesta.json }
  }
  try { return await fn(llamadas) } finally { globalThis.fetch = original }
}

const CRED = { phoneNumberId: '1111', accessToken: 'tok' }
const throwsErr = (fn, clase, rx) => assert.throws(fn, (e) => e instanceof clase && rx.test(e.message), `debía lanzar ${clase.name} ${rx}`)

// ════════════════════════════════════════════════════════
// BOTONES DE RESPUESTA
// ════════════════════════════════════════════════════════

test('botones: arma el objeto que Meta espera (id propio + título por botón)', () => {
  const i = botonesDeRespuesta({
    cuerpo: '¿Quieres que te reserve el pedido?',
    botones: [{ id: 'cierre:si', titulo: 'Sí, pedirlo' }, { id: 'cierre:duda', titulo: 'Tengo una duda' }],
    pie: 'Pagas al recibir'
  })
  assert.deepEqual(i, {
    type: 'button',
    footer: { text: 'Pagas al recibir' },
    body: { text: '¿Quieres que te reserve el pedido?' },
    action: { buttons: [
      { type: 'reply', reply: { id: 'cierre:si', title: 'Sí, pedirlo' } },
      { type: 'reply', reply: { id: 'cierre:duda', title: 'Tengo una duda' } }
    ] }
  })
})

test('botones: respeta los límites de Meta (máx. 3, título 20, ids únicos, cuerpo obligatorio)', () => {
  const b = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, titulo: `Opción ${i}` }))
  assert.equal(botonesDeRespuesta({ cuerpo: 'x', botones: b(3) }).action.buttons.length, 3)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: b(4) }), ErrorInteractivo, /de 1 a 3/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: [] }), ErrorInteractivo, /de 1 a 3/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'x'.repeat(21) }] }), ErrorInteractivo, /pasa de 20/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'Uno' }, { id: 'a', titulo: 'Dos' }] }), ErrorInteractivo, /repetido/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: '  ', botones: b(1) }), ErrorInteractivo, /cuerpo es obligatorio/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ titulo: 'Sin id' }] }), ErrorInteractivo, /falta el id/)
})

test('botones: la cuenta de caracteres es la ESTRICTA (un emoji como 🙌 vale 2), porque Meta no documenta la suya', () => {
  // Meta no dice si un emoji vale 1 o 2. Contar de más solo cuesta un carácter y, como mucho,
  // que el mensaje salga como texto; contar de menos es un 400 de Graph y un cliente sin respuesta.
  assert.doesNotThrow(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'a'.repeat(18) + '🙌' }] }))
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'a'.repeat(19) + '🙌' }] }), ErrorInteractivo, /pasa de 20/)
  // Los del plano básico (✅, acentos) valen 1 en cualquier cuenta: no se penalizan.
  assert.doesNotThrow(() => botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'Sí, lo pido ahora ✅' + 'x' }] }))
})

test('límites por formato: el cuerpo de una lista admite 4096; el de los botones, 1024', () => {
  const fila = [{ filas: [{ id: 'a', titulo: 'A' }] }]
  assert.doesNotThrow(() => listaDeOpciones({ cuerpo: 'x'.repeat(4096), boton: 'Ver', secciones: fila }))
  throwsErr(() => listaDeOpciones({ cuerpo: 'x'.repeat(4097), boton: 'Ver', secciones: fila }), ErrorInteractivo, /4096/)
  throwsErr(() => botonesDeRespuesta({ cuerpo: 'x'.repeat(1025), botones: [{ id: 'a', titulo: 'A' }] }), ErrorInteractivo, /1024/)
  assert.equal(LIMITES.cuerpoLista, 4096)
})

// ════════════════════════════════════════════════════════
// LISTA
// ════════════════════════════════════════════════════════

test('lista: una sola sección no necesita título; las filas llevan id, título y descripción', () => {
  const i = listaDeOpciones({
    cuerpo: '¿Qué presentación te interesa?',
    boton: 'Ver opciones',
    secciones: [{ filas: [
      { id: 'p:30', titulo: 'Frasco x30', descripcion: 'Para 1 mes' },
      { id: 'p:90', titulo: 'Pack x90' }
    ] }]
  })
  assert.equal(i.type, 'list')
  assert.equal(i.action.button, 'Ver opciones')
  assert.deepEqual(i.action.sections[0], { rows: [
    { id: 'p:30', title: 'Frasco x30', description: 'Para 1 mes' },
    { id: 'p:90', title: 'Pack x90' }
  ] })
})

test('lista: máx. 10 filas EN TOTAL; varias secciones exigen título; ids únicos entre secciones', () => {
  const fila = (i) => ({ id: `f${i}`, titulo: `Fila ${i}` })
  assert.doesNotThrow(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ filas: Array.from({ length: 10 }, (_, i) => fila(i)) }] }))
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ filas: Array.from({ length: 11 }, (_, i) => fila(i)) }] }), ErrorInteractivo, /hasta 10 filas|de 1 a 10 filas/)
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ filas: [fila(1)] }, { titulo: 'B', filas: [fila(2)] }] }), ErrorInteractivo, /título/)
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ titulo: 'A', filas: [fila(1)] }, { titulo: 'B', filas: [fila(1)] }] }), ErrorInteractivo, /repetido/)
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ filas: [{ id: 'a', titulo: 'x'.repeat(25) }] }] }), ErrorInteractivo, /pasa de 24/)
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'Ver', secciones: [{ filas: [{ id: 'a', titulo: 'ok', descripcion: 'y'.repeat(73) }] }] }), ErrorInteractivo, /pasa de 72/)
  throwsErr(() => listaDeOpciones({ cuerpo: 'x', boton: 'z'.repeat(21), secciones: [{ filas: [fila(1)] }] }), ErrorInteractivo, /pasa de 20/)
})

// ════════════════════════════════════════════════════════
// BOTÓN DE ENLACE
// ════════════════════════════════════════════════════════

test('botón de enlace: arma cta_url y exige una URL http(s) completa', () => {
  const i = botonDeEnlace({ cuerpo: 'Aquí puedes ver el producto', texto: 'Ver producto', url: 'https://tienda.pe/elixir' })
  assert.deepEqual(i, {
    type: 'cta_url',
    body: { text: 'Aquí puedes ver el producto' },
    action: { name: 'cta_url', parameters: { display_text: 'Ver producto', url: 'https://tienda.pe/elixir' } }
  })
  throwsErr(() => botonDeEnlace({ cuerpo: 'x', texto: 'Ver', url: 'tienda.pe' }), ErrorInteractivo, /URL http/)
  throwsErr(() => botonDeEnlace({ cuerpo: 'x', texto: 'y'.repeat(21), url: 'https://a.pe' }), ErrorInteractivo, /pasa de 20/)
})

// ════════════════════════════════════════════════════════
// ELECCIÓN AUTOMÁTICA + FALLBACK DE TEXTO
// ════════════════════════════════════════════════════════

test('opciones: hasta 3 → botones; más de 3 (o títulos largos) → lista; más de 10 → error', () => {
  const op = (n, titulo = 'Opción') => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, titulo: `${titulo} ${i}` }))
  assert.equal(interactivoDeOpciones({ cuerpo: 'x', opciones: op(3) }).type, 'button')
  assert.equal(interactivoDeOpciones({ cuerpo: 'x', opciones: op(4) }).type, 'list')
  // 23 caracteres: no cabe en un botón (20) pero sí en una fila de lista (24)
  assert.equal(interactivoDeOpciones({ cuerpo: 'x', opciones: op(2, 'Frasco de 30 cápsulas') }).type, 'list')
  assert.equal(interactivoDeOpciones({ cuerpo: 'x', opciones: [{ id: 'a', titulo: 'Corto', descripcion: 'con detalle' }] }).type, 'list')
  throwsErr(() => interactivoDeOpciones({ cuerpo: 'x', opciones: op(11) }), ErrorInteractivo, /filas/)
  throwsErr(() => interactivoDeOpciones({ cuerpo: 'x', opciones: [] }), ErrorInteractivo, /opciones/)
})

test('opciones como texto: lista numerada para canales sin botones', () => {
  assert.equal(
    opcionesComoTexto('¿Qué prefieres?', [{ id: 'a', titulo: 'Frasco x30', descripcion: '1 mes' }, { id: 'b', titulo: 'Pack x90' }]),
    '¿Qué prefieres?\n\n1) Frasco x30 — 1 mes\n2) Pack x90'
  )
  assert.equal(opcionesComoTexto('Hola', []), 'Hola')
})

// ════════════════════════════════════════════════════════
// ENVÍO (fetch de mentira)
// ════════════════════════════════════════════════════════

test('sendInteractiveCloud: POST /messages con type interactive; un BSUID va en "recipient"', async () => {
  const interactive = botonesDeRespuesta({ cuerpo: 'x', botones: [{ id: 'a', titulo: 'Sí' }] })
  await conFetchFalso({ json: { messages: [{ id: 'wamid.OUT1' }] } }, async (llamadas) => {
    const r = await sendInteractiveCloud({ telefono: '51987654321', interactive, credenciales: CRED })
    assert.equal(r.ok, true)
    assert.equal(r.messageId, 'wamid.OUT1')
    assert.match(llamadas[0].url, /\/1111\/messages$/)
    assert.equal(llamadas[0].init.headers.Authorization, 'Bearer tok')
    assert.deepEqual(llamadas[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '51987654321', type: 'interactive', interactive })

    await sendInteractiveCloud({ telefono: 'PE.8f3a2b', interactive, credenciales: CRED })
    assert.equal(llamadas[1].body.recipient, 'PE.8f3a2b')
    assert.equal(llamadas[1].body.to, undefined)
  })
})

test('sendInteractiveCloud: sin teléfono, sin interactivo o sin credenciales NO llama a Meta', async () => {
  await conFetchFalso({ json: {} }, async (llamadas) => {
    assert.equal((await sendInteractiveCloud({ telefono: '', interactive: { type: 'button' }, credenciales: CRED })).error, 'telefono_required')
    assert.equal((await sendInteractiveCloud({ telefono: '5199', interactive: null, credenciales: CRED })).error, 'interactive_required')
    assert.equal((await sendInteractiveCloud({ telefono: '5199', interactive: { type: 'button' }, credenciales: { phoneNumberId: null, accessToken: null } })).error, 'cloud_not_configured')
    assert.equal(llamadas.length, 0)
  })
})

test('marcarLeidoCloud: status read + typing_indicator; sin escribiendo solo marca leído', async () => {
  await conFetchFalso({ json: { success: true } }, async (llamadas) => {
    const r = await marcarLeidoCloud({ messageId: 'wamid.IN1', escribiendo: true, credenciales: CRED })
    assert.equal(r.ok, true)
    assert.equal(r.messageId, null, 'Meta contesta { success: true }, sin wamid')
    assert.deepEqual(llamadas[0].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } })

    await marcarLeidoCloud({ messageId: 'wamid.IN2', credenciales: CRED })
    assert.deepEqual(llamadas[1].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN2' })

    assert.equal((await marcarLeidoCloud({ messageId: '', credenciales: CRED })).error, 'message_id_required')
    assert.equal(llamadas.length, 2)
  })
})

test('marcarLeidoCloud: un error de Meta se devuelve, no se lanza', async () => {
  await conFetchFalso({ ok: false, status: 400, json: { error: { message: 'Message too old', code: 100 } } }, async () => {
    const r = await marcarLeidoCloud({ messageId: 'wamid.VIEJO', escribiendo: true, credenciales: CRED })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'graph_400')
  })
})

// ════════════════════════════════════════════════════════
// «ESCRIBIENDO…» — cuándo sí y cuándo no
// ════════════════════════════════════════════════════════

const prismaConModo = (currentMode) => ({ leadState: { findUnique: async () => (currentMode === undefined ? null : { currentMode }) } })
const canal = { provider: 'cloud', externalKey: '1111', credenciales: { accessToken: 'tok' } }

test('escribiendo: con el bot a cargo marca leído + escribiendo, con las credenciales DEL CANAL', async () => {
  const enviadas = []
  const r = await indicarEscribiendo({ messageId: 'wamid.IN1', leadId: 7, canal }, {
    prisma: prismaConModo(MODES.AUTO_CONSULTIVO), env: {},
    enviar: async (a) => { enviadas.push(a); return { ok: true } }
  })
  assert.deepEqual(r, { enviado: true, motivo: null })
  assert.deepEqual(enviadas, [{ messageId: 'wamid.IN1', escribiendo: true, credenciales: { phoneNumberId: '1111', accessToken: 'tok' } }])
})

test('escribiendo: NO se muestra si un humano tiene el chat, si el lead está en pausa o si no hay wamid', async () => {
  const enviar = async () => { throw new Error('no debía enviar') }
  for (const modo of [MODES.HUMAN_ACTIVE, MODES.PAUSED]) {
    assert.deepEqual(await indicarEscribiendo({ messageId: 'w', leadId: 1, canal }, { prisma: prismaConModo(modo), env: {}, enviar }), { enviado: false, motivo: 'humano_o_pausa' })
  }
  assert.deepEqual(await indicarEscribiendo({ messageId: null, leadId: 1, canal }, { prisma: prismaConModo(), env: {}, enviar }), { enviado: false, motivo: 'sin_message_id' })
})

test('escribiendo: misma compuerta que el cerebro — si va a retomar solo un HUMAN_ACTIVE abandonado, SÍ se muestra', async () => {
  // brain-pipeline retoma un lead que lleva HUMAN_ACTIVE_RESUME_HORAS sin atención humana. Si
  // aquí se callara, ese cliente recibiría la respuesta del bot sin «escribiendo…» previo.
  const consultas = []
  const prisma = { leadState: { findUnique: async (q) => { consultas.push(q); return { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date(0) } } } }
  const r = await indicarEscribiendo({ messageId: 'w', leadId: 5, canal }, { prisma, env: {}, debeAutoReanudar: () => true, enviar: async () => ({ ok: true }) })
  assert.equal(r.enviado, true)
  assert.deepEqual(consultas[0].select, { currentMode: true, modeEnteredAt: true }, 'necesita modeEnteredAt para decidir igual que el cerebro')

  const noToca = await indicarEscribiendo({ messageId: 'w', leadId: 5, canal }, { prisma, env: {}, debeAutoReanudar: () => false, enviar: async () => { throw new Error('no debía enviar') } })
  assert.equal(noToca.motivo, 'humano_o_pausa')

  // PAUSED es terminal: ni con auto-reanudación
  const pausado = { leadState: { findUnique: async () => ({ currentMode: MODES.PAUSED, modeEnteredAt: new Date(0) }) } }
  const p = await indicarEscribiendo({ messageId: 'w', leadId: 5, canal }, { prisma: pausado, env: {}, debeAutoReanudar: () => true, enviar: async () => { throw new Error('no debía enviar') } })
  assert.equal(p.motivo, 'humano_o_pausa')
})

test('escribiendo: en coexistencia NO marca leído (al dueño se le borrarían los chats pendientes del celular)', async () => {
  const enviar = async () => { throw new Error('no debía enviar') }
  const r = await indicarEscribiendo({ messageId: 'w', leadId: 1, canal: { ...canal, modo: 'coexistencia' } }, { prisma: prismaConModo(), env: {}, enviar })
  assert.deepEqual(r, { enviado: false, motivo: 'coexistencia' })
  // nube pura (o sin el dato) sí lo muestra
  const ok = await indicarEscribiendo({ messageId: 'w', leadId: 1, canal: { ...canal, modo: 'nube_pura' } }, { prisma: prismaConModo(), env: {}, enviar: async () => ({ ok: true }) })
  assert.equal(ok.enviado, true)
})

test('escribiendo: se apaga con CLOUD_TYPING_INDICATOR=false (sin desplegar) y viene encendido por defecto', async () => {
  assert.equal(escribiendoHabilitado({}), true)
  assert.equal(escribiendoHabilitado({ CLOUD_TYPING_INDICATOR: 'false' }), false)
  assert.equal(escribiendoHabilitado({ CLOUD_TYPING_INDICATOR: ' FALSE ' }), false)
  const r = await indicarEscribiendo({ messageId: 'w', leadId: 1, canal }, { env: { CLOUD_TYPING_INDICATOR: 'false' }, enviar: async () => { throw new Error('no debía enviar') } })
  assert.deepEqual(r, { enviado: false, motivo: 'desactivado' })
})

test('escribiendo: es de mejor esfuerzo — un fallo de Meta o de la base NUNCA lanza', async () => {
  const meta = await indicarEscribiendo({ messageId: 'w', leadId: 1, canal }, { prisma: prismaConModo(), env: {}, enviar: async () => ({ ok: false, error: 'graph_400', errors: ['Message too old'] }) })
  assert.deepEqual(meta, { enviado: false, motivo: 'graph_400' })
  const base = await indicarEscribiendo({ messageId: 'w', leadId: 1, canal }, { prisma: { leadState: { findUnique: async () => { throw new Error('base caída') } } }, env: {}, enviar: async () => ({ ok: true }) })
  assert.deepEqual(base, { enviado: false, motivo: 'excepcion' })
})

// ── cableado en el router ───────────────────────────────────────────────

const canalHidata = { resolvedBy: 'channel', tenantId: 'hidata', provider: 'cloud', externalKey: '1111111111', estadoSuscripcion: 'trial', activo: true }
const depsRouter = (extra = {}) => ({
  checkAndMark: () => true,
  resolveChannel: async () => canalHidata,
  tenantAtiende: () => ({ atiende: true }),
  resolveLead: async () => ({ ok: true, leadId: 42, telefono: '51987654321', isArchived: false }),
  enqueueMessage: () => ({ queued: true }),
  procesarTurno: async () => {},
  manejarMedia: async () => ({ texto: null, mediaAssetId: null, escalado: false }),
  responderNoTexto: async () => {},
  ...extra
})
const evTexto = { tipo: 'message', messageId: 'wamid.1', telefono: '51987654321', bsuid: null, pushName: 'María', messageType: 'text', text: 'hola', phoneNumberId: '1111111111' }

test('router: al encolar el mensaje avisa «escribiendo» con el wamid, el lead y el canal — sin esperarlo', async () => {
  const llamadas = []
  let terminado = false
  const deps = depsRouter({ indicarEscribiendo: (a) => { llamadas.push(a); return new Promise(res => setTimeout(() => { terminado = true; res() }, 30)) } })
  const r = await procesarMensajeCloud(evTexto, deps)
  assert.equal(r.queued, true)
  assert.equal(terminado, false, 'el turno no espera al indicador: es de mejor esfuerzo')
  assert.deepEqual(llamadas, [{ messageId: 'wamid.1', leadId: 42, canal: canalHidata }])
})

test('router: si el indicador falla el turno sigue igual (rechazo silenciado)', async () => {
  const r = await procesarMensajeCloud(evTexto, depsRouter({ indicarEscribiendo: () => Promise.reject(new Error('Meta caído')) }))
  assert.equal(r.queued, true)
})

test('router: sin indicador inyectado (tests, otros llamadores) no hace nada extra', async () => {
  const r = await procesarMensajeCloud(evTexto, depsRouter())
  assert.equal(r.queued, true)
})

test('router: un indicador que lanza de forma SÍNCRONA tampoco rompe el turno', async () => {
  const r = await procesarMensajeCloud(evTexto, depsRouter({ indicarEscribiendo: () => { throw new Error('bug síncrono') } }))
  assert.equal(r.queued, true)
})

test('router: duplicados, canal desconocido y lead archivado NO muestran «escribiendo»', async () => {
  let n = 0
  const cuenta = () => { n++ }
  await procesarMensajeCloud(evTexto, depsRouter({ checkAndMark: () => false, indicarEscribiendo: cuenta }))
  await procesarMensajeCloud(evTexto, depsRouter({ resolveChannel: async () => ({ resolvedBy: 'active_tenant_fallback', tenantId: 'x' }), indicarEscribiendo: cuenta }))
  await procesarMensajeCloud(evTexto, depsRouter({ resolveLead: async () => ({ ok: true, leadId: 42, isArchived: true }), indicarEscribiendo: cuenta }))
  assert.equal(n, 0)
})

test('router: stickers, reacciones, ubicaciones y contactos NO muestran «escribiendo» (el bot no les contesta)', async () => {
  let n = 0
  for (const messageType of ['sticker', 'reaction', 'location', 'contacts', 'unsupported']) {
    await procesarMensajeCloud({ ...evTexto, messageId: `w-${messageType}`, messageType, text: null, mediaId: messageType === 'sticker' ? 'M9' : null },
      depsRouter({ indicarEscribiendo: () => { n++ } }))
  }
  assert.equal(n, 0)
})

test('router: con una nota de voz, «escribiendo…» sale ANTES de terminar de bajar y transcribir (cuando más se nota el silencio)', async () => {
  const orden = []
  const deps = depsRouter({
    indicarEscribiendo: () => { orden.push('escribiendo') },
    manejarMedia: async () => { orden.push('media:inicio'); await new Promise(r => setTimeout(r, 20)); orden.push('media:fin'); return { texto: 'texto de la nota de voz', mediaAssetId: 7, escalado: false } },
    enqueueMessage: () => { orden.push('encolado'); return { queued: true } }
  })
  const r = await procesarMensajeCloud({ ...evTexto, messageType: 'audio', text: null, mediaId: 'M1' }, deps)
  assert.equal(r.queued, true)
  assert.deepEqual(orden, ['escribiendo', 'media:inicio', 'media:fin', 'encolado'])
})

test('router: si el debounce rechaza (sobrecarga) el «escribiendo…» ya salió — costo aceptado a cambio de mostrarlo durante la media', async () => {
  let n = 0
  const r = await procesarMensajeCloud(evTexto, depsRouter({ enqueueMessage: () => ({ queued: false, error: 'cap' }), indicarEscribiendo: () => { n++ } }))
  assert.equal(r.queued, false)
  assert.equal(n, 1)
})

test('router: el id del botón o fila que tocó el cliente viaja con el mensaje hasta el turno', async () => {
  const encolados = []
  await procesarMensajeCloud({ ...evTexto, messageType: 'interactive', text: 'Sí, pedirlo', interactiveId: 'cierre:si' },
    depsRouter({ enqueueMessage: (a) => { encolados.push(a); return { queued: true } } }))
  assert.equal(encolados[0].text, 'Sí, pedirlo', 'al cerebro le llega el título, como siempre')
  assert.equal(encolados[0].metadata.interactiveId, 'cierre:si')
  await procesarMensajeCloud({ ...evTexto, messageId: 'wamid.2' }, depsRouter({ enqueueMessage: (a) => { encolados.push(a); return { queued: true } } }))
  assert.equal(encolados[1].metadata.interactiveId, null, 'un texto normal viaja sin id')
})

// ── el parser entrega el id de lo que el cliente tocó ────────────────────

const envoltura = (messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1111111111' }, messages } }] }] })

test('parser: un toque en botón o lista trae el id que pusimos, además del título', () => {
  const [boton] = parseCloudWebhook(envoltura([{ from: '5199', id: 'w1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'cierre:si', title: 'Sí, pedirlo' } } }]))
  assert.equal(boton.text, 'Sí, pedirlo')
  assert.equal(boton.interactiveId, 'cierre:si')

  const [fila] = parseCloudWebhook(envoltura([{ from: '5199', id: 'w2', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'p:90', title: 'Pack x90', description: '3 meses' } } }]))
  assert.equal(fila.text, 'Pack x90')
  assert.equal(fila.interactiveId, 'p:90')

  const [plantilla] = parseCloudWebhook(envoltura([{ from: '5199', id: 'w3', type: 'button', button: { text: 'Quiero más', payload: 'mas-como-este' } }]))
  assert.equal(plantilla.text, 'Quiero más')
  assert.equal(plantilla.interactiveId, 'mas-como-este')

  const [texto] = parseCloudWebhook(envoltura([{ from: '5199', id: 'w4', type: 'text', text: { body: 'hola' } }]))
  assert.equal(texto.interactiveId, null, 'un texto normal no tiene id: la forma del evento es estable')
})

// ── transporte: Meta = botones; otro canal = texto numerado ─────────────

test('enviarOpciones: por Meta manda botones; con opciones mal armadas cae a texto numerado', async () => {
  await conFetchFalso({ json: { messages: [{ id: 'wamid.OUT' }] } }, async (llamadas) => {
    const c = { provider: 'cloud', externalKey: '1111', credenciales: { accessToken: 'tok' } }
    const ok = await enviarOpciones({ canal: c, telefono: '51987654321', cuerpo: '¿Lo pedimos?', opciones: [{ id: 'si', titulo: 'Sí' }, { id: 'no', titulo: 'No' }] })
    assert.equal(ok.ok, true)
    assert.equal(ok.messageId, 'wamid.OUT', 'el wamid vuelve para enganchar los recibos (reciboDeEnvio)')
    assert.equal(llamadas[0].body.type, 'interactive')
    assert.equal(llamadas[0].body.interactive.type, 'button')

    // 12 opciones no caben ni en lista → se envía como texto, no se pierde el mensaje
    const muchas = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, titulo: `Opción ${i + 1}` }))
    const texto = await enviarOpciones({ canal: c, telefono: '51987654321', cuerpo: 'Elige', opciones: muchas })
    assert.equal(llamadas[1].body.type, 'text')
    assert.match(llamadas[1].body.text.body, /^Elige\n\n1\) Opción 1\n2\) Opción 2/)
    assert.equal(texto.formato, 'texto')
  })
})

test('enviarOpciones: devuelve QUÉ guardar en el historial, sea cual sea el formato', async () => {
  // Sin esto, quien lo llame no tiene qué persistir: la bandeja no mostraría lo que se ofreció
  // y el cerebro no sabría qué opciones dio.
  await conFetchFalso({ json: { messages: [{ id: 'wamid.X' }] } }, async () => {
    const c = { provider: 'cloud', externalKey: '1111', credenciales: { accessToken: 'tok' } }
    const opciones = [{ id: 'si', titulo: 'Sí, pedirlo' }, { id: 'duda', titulo: 'Tengo una duda' }]
    const botones = await enviarOpciones({ canal: c, telefono: '5199', cuerpo: '¿Te separo el pedido?', opciones })
    assert.equal(botones.formato, 'botones')
    assert.equal(botones.texto, '¿Te separo el pedido?\n\n1) Sí, pedirlo\n2) Tengo una duda')

    const cuatro = [...opciones, { id: 'a', titulo: 'Asesor' }, { id: 'b', titulo: 'Más tarde' }]
    const lista = await enviarOpciones({ canal: c, telefono: '5199', cuerpo: 'Elige', opciones: cuatro })
    assert.equal(lista.formato, 'lista')
    assert.match(lista.texto, /4\) Más tarde$/)
  })
})

// ════════════════════════════════════════════════════════
// PLANTILLAS: parámetros al ENVIAR
// ════════════════════════════════════════════════════════

test('plantillas: el cuerpo limpia saltos de línea y espacios (Meta rechaza variables con \\n o 5 espacios)', () => {
  assert.deepEqual(componenteCuerpo(['María', 'colágeno\nen   polvo']), [{ type: 'body', parameters: [{ type: 'text', text: 'María' }, { type: 'text', text: 'colágeno en polvo' }] }])
  assert.deepEqual(componenteCuerpo([]), [])
  assert.equal(componenteCuerpo([null])[0].parameters[0].text, '-', 'una variable vacía no puede viajar vacía')
})

test('plantillas: la imagen va por id (media subida) o por link https; sin ninguna, error', () => {
  assert.deepEqual(componenteEncabezadoImagen({ id: 123 }), { type: 'header', parameters: [{ type: 'image', image: { id: '123' } }] })
  assert.deepEqual(componenteEncabezadoImagen({ link: 'https://x.pe/a.jpg' }).parameters[0].image, { link: 'https://x.pe/a.jpg' })
  throwsErr(() => componenteEncabezadoImagen({}), ErrorPlantilla, /id|link/)
  throwsErr(() => componenteEncabezadoImagen({ link: 'http://inseguro.pe/a.jpg' }), ErrorPlantilla, /https/)
})

test('oferta por tiempo limitado: mismo orden y forma que el ejemplo oficial (header, body, oferta, cupón, url)', () => {
  const expira = Date.now() + 48 * 3600 * 1000
  const c = componentesOfertaLimitada({ variables: ['María', '20%'], imagen: { id: '999' }, expiraEn: expira, cupon: 'FRESA20', sufijoUrl: 'promo-fresas' })
  assert.deepEqual(c.map(x => x.type), ['header', 'body', 'limited_time_offer', 'button', 'button'])
  assert.deepEqual(c[2], { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: expira } }] })
  assert.deepEqual(c[3], { type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: 'FRESA20' }] })
  assert.deepEqual(c[4], { type: 'button', sub_type: 'url', index: 1, parameters: [{ type: 'text', text: 'promo-fresas' }] })
})

test('oferta por tiempo limitado: sin cupón el botón de URL es el índice 0; acepta Date; no acepta fechas vencidas', () => {
  const ahora = 1_700_000_000_000
  const c = componentesOfertaLimitada({ imagen: { id: '1' }, expiraEn: new Date(ahora + 3600_000), sufijoUrl: 'x', ahora })
  assert.equal(c.find(x => x.sub_type === 'url').index, 0)
  assert.equal(c.some(x => x.type === 'body'), false, 'sin variables no se manda cuerpo')
  assert.equal(c.find(x => x.type === 'limited_time_offer').parameters[0].limited_time_offer.expiration_time_ms, ahora + 3600_000)
  throwsErr(() => componentesOfertaLimitada({ imagen: { id: '1' }, expiraEn: ahora - 1, ahora }), ErrorPlantilla, /venció/)
  throwsErr(() => componentesOfertaLimitada({ imagen: { id: '1' }, expiraEn: 'mañana', ahora }), ErrorPlantilla, /no es una fecha válida/)
  throwsErr(() => componentesOfertaLimitada({ imagen: { id: '1' }, ahora }), ErrorPlantilla, /falta `expiraEn`/)
  assert.doesNotThrow(() => componenteBotonCupon('X'.repeat(20)), 'desde dic-2025 Meta acepta cupones de hasta 20 caracteres')
  throwsErr(() => componenteBotonCupon('X'.repeat(21)), ErrorPlantilla, /20/)
  throwsErr(() => componenteBotonCupon(''), ErrorPlantilla, /obligatorio/)
})

test('carrusel: las tarjetas conservan su orden y todas llevan los mismos botones (regla de Meta)', () => {
  const c = componentesCarrusel({
    variables: ['María'],
    tarjetas: [
      { imagen: { id: 'A' }, payload: 'mas-piel', sufijoUrl: 'piel' },
      { imagen: { id: 'B' }, payload: 'mas-huesos', sufijoUrl: 'huesos' }
    ]
  })
  assert.deepEqual(c.map(x => x.type), ['body', 'carousel'])
  const tarjetas = c[1].cards
  assert.deepEqual(tarjetas.map(t => t.card_index), [0, 1])
  assert.deepEqual(tarjetas[1].components, [
    { type: 'header', parameters: [{ type: 'image', image: { id: 'B' } }] },
    { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'mas-huesos' }] },
    { type: 'button', sub_type: 'url', index: 1, parameters: [{ type: 'text', text: 'huesos' }] }
  ])
})

test('carrusel: 2 a 10 tarjetas; mezclar tarjetas con y sin botón se rechaza', () => {
  const t = (n) => Array.from({ length: n }, (_, i) => ({ imagen: { id: `I${i}` } }))
  assert.equal(componentesCarrusel({ tarjetas: t(2) })[0].cards.length, 2)
  assert.equal(componentesCarrusel({ tarjetas: t(10) })[0].cards.length, 10)
  throwsErr(() => componentesCarrusel({ tarjetas: t(1) }), ErrorPlantilla, /2 a 10/)
  throwsErr(() => componentesCarrusel({ tarjetas: t(11) }), ErrorPlantilla, /2 a 10/)
  throwsErr(() => componentesCarrusel({ tarjetas: [{ imagen: { id: 'A' }, sufijoUrl: 'a' }, { imagen: { id: 'B' } }] }), ErrorPlantilla, /mismos/)
  throwsErr(() => componenteBotonRespuesta(''), ErrorPlantilla, /payload/)
  throwsErr(() => componenteBotonUrl(' '), ErrorPlantilla, /reemplaza/)
})

// ════════════════════════════════════════════════════════
// CATÁLOGO: las plantillas que el bot necesita en Meta
// ════════════════════════════════════════════════════════

test('catálogo: cada plantilla cumple las reglas de Meta (sin esto, Meta las rechaza a los minutos)', () => {
  assert.ok(CATALOGO.length >= 4)
  for (const t of CATALOGO) assert.deepEqual(validarPlantilla(t), [], `plantilla ${t.clave}`)
  assert.equal(new Set(CATALOGO.map(t => t.nombre)).size, CATALOGO.length, 'nombres únicos')
  assert.equal(new Set(CATALOGO.map(t => t.env)).size, CATALOGO.length, 'una env var por plantilla')
})

test('catálogo: el ORDEN y la cantidad de variables coinciden con el código que las llena', () => {
  const por = Object.fromEntries(CATALOGO.map(t => [t.clave, t]))
  // followup_24h y reapertura: {{1}} nombre, {{2}} producto (followupEngine.js e inbox-actions.js mandan 2 parámetros)
  for (const k of ['followup_24h', 'reapertura']) {
    assert.deepEqual(variablesDelCuerpo(por[k].cuerpo), [1, 2], k)
    assert.match(por[k].variables[0], /nombre/); assert.match(por[k].variables[1], /producto/)
  }
  // compromiso: 1 parámetro (nombre)
  assert.deepEqual(variablesDelCuerpo(por.compromiso.cuerpo), [1])
  // aviso al vendedor: tantas variables como parámetros arma componentesAvisoVendedor
  const parametros = componentesAvisoVendedor({ nombre: 'María', motivo: 'quiere pagar', telefono: '51987654321' })[0].parameters
  assert.equal(variablesDelCuerpo(por.aviso_vendedor.cuerpo).length, parametros.length)
  assert.match(parametros[2].text, /^https:\/\/wa\.me\//, 'la 3.ª variable es el enlace wa.me')
})

test('catálogo: detecta lo que Meta rechazaría (variable al inicio o al final, ejemplos que no calzan, nombre inválido)', () => {
  const base = { nombre: 'ok_nombre', categoria: 'utility', cuerpo: 'Hola {{1}} 👋 gracias', variables: ['nombre'], ejemplos: ['María'] }
  assert.deepEqual(validarPlantilla(base), [])
  assert.match(validarPlantilla({ ...base, cuerpo: '{{1}} te saluda' }).join(), /EMPEZAR/)
  assert.match(validarPlantilla({ ...base, cuerpo: 'Te saluda {{1}}' }).join(), /TERMINAR/)
  assert.match(validarPlantilla({ ...base, ejemplos: [] }).join(), /ejemplo/)
  assert.match(validarPlantilla({ ...base, cuerpo: 'Hola {{2}} 👋 gracias' }).join(), /correlativas/)
  assert.match(validarPlantilla({ ...base, nombre: 'Mal Nombre' }).join(), /nombre inválido/)
  assert.match(validarPlantilla({ ...base, categoria: 'promo' }).join(), /categoría/)
  assert.match(validarPlantilla({ ...base, cuerpo: 'x'.repeat(1025) }).join(), /1024/)
})

test('catálogo: el POST de creación lleva idioma, categoría, cuerpo y UN ejemplo por variable', () => {
  const t = CATALOGO.find(x => x.clave === 'followup_24h')
  const p = payloadDeCreacion(t)
  assert.equal(p.name, 'hidata_followup_24h')
  assert.equal(p.language, 'es')
  assert.equal(p.category, 'marketing')
  assert.equal(p.parameter_format, 'positional')
  assert.deepEqual(p.components[0].example, { body_text: [['María', 'tu pedido']] })
  assert.equal(payloadDeCreacion(t, { idioma: 'es_PE' }).language, 'es_PE')
  assert.throws(() => payloadDeCreacion({ ...t, nombre: 'MAL' }), /inválida/)
})

test('catálogo: si la env var ya apunta a otro nombre de plantilla, ese manda', () => {
  const t = CATALOGO.find(x => x.clave === 'compromiso')
  assert.equal(nombreConfigurado(t, {}), 'hidata_compromiso')
  assert.equal(nombreConfigurado(t, { CLOUD_TEMPLATE_COMPROMISO: ' recordatorio_v2 ' }), 'recordatorio_v2')
})

test('catálogo: el idioma se valida con el formato de Meta (guion bajo; es_PE existe)', () => {
  for (const ok of ['es', 'es_PE', 'es_MX', 'pt_BR', 'zh_CN', 'fil']) assert.equal(idiomaValido(ok), true, ok)
  for (const mal of ['es-PE', 'ES', 'es_pe', '', 'español', null]) assert.equal(idiomaValido(mal), false, String(mal))
  const t = CATALOGO.find(x => x.clave === 'compromiso')
  assert.throws(() => payloadDeCreacion(t, { idioma: 'es-PE' }), /idioma inválido/)
})

test('catálogo: el recordatorio de compromiso está redactado SIN persuasión, para poder quedar como utility', () => {
  // Desde abr-2025 Meta aprueba como MARKETING toda "utility" con intención comercial: se
  // cobra más y queda sujeta al tope de marketing por usuario (131049). Esta guarda evita que
  // un cambio de copy la vuelva promocional sin que nadie lo note.
  const t = CATALOGO.find(x => x.clave === 'compromiso')
  assert.equal(t.categoria, 'utility')
  assert.doesNotMatch(t.cuerpo, /cerr|promo|oferta|descuento|no te lo pierdas|aprovecha|compra|precio|gratis/i)
  const aviso = CATALOGO.find(x => x.clave === 'aviso_vendedor')
  assert.equal(aviso.categoria, 'utility')
})

// ════════════════════════════════════════════════════════
// ÍNDICE DE BOTONES — el detalle que más envíos rompe
// ════════════════════════════════════════════════════════

test('botones de plantilla: los casos del ejemplo de Meta salen bien SIN configurar nada', () => {
  const ahora = 1_700_000_000_000
  // Jasper's Market, oferta: [copiar cupón, URL fija] → solo viaja el cupón, con index 0
  const oferta = componentesOfertaLimitada({ imagen: { id: '1' }, expiraEn: ahora + 1000, cupon: 'BERRIES20', ahora })
  assert.deepEqual(oferta.filter(c => c.type === 'button'), [{ type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: 'BERRIES20' }] }])
  // Jasper's Market, carrusel: cada tarjeta con una URL FIJA → ningún componente de botón
  const carrusel = componentesCarrusel({ tarjetas: [{ imagen: { id: 'A' } }, { imagen: { id: 'B' } }] })
  assert.deepEqual(carrusel[0].cards[0].components.map(c => c.type), ['header'])
})

test('botones de plantilla: con un botón FIJO delante, ordenBotones corrige el índice (si no, Meta rechaza el envío)', () => {
  const ahora = 1_700_000_000_000
  // plantilla [URL fija, copiar cupón]: el cupón es el SEGUNDO botón → index 1
  const oferta = componentesOfertaLimitada({ imagen: { id: '1' }, expiraEn: ahora + 1000, cupon: 'X1', ordenBotones: ['url', 'cupon'], ahora })
  assert.equal(oferta.find(c => c.sub_type === 'copy_code').index, 1)
  // carrusel con [URL fija, respuesta rápida] en cada tarjeta → la respuesta es index 1
  const carrusel = componentesCarrusel({ ordenBotones: ['url', 'respuesta'], tarjetas: [{ imagen: { id: 'A' }, payload: 'a' }, { imagen: { id: 'B' }, payload: 'b' }] })
  assert.deepEqual(carrusel[0].cards[1].components[1], { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'b' }] })
})

test('botones de plantilla: los errores de configuración se detectan antes de llamar a Meta', () => {
  const ahora = 1_700_000_000_000
  const base = { imagen: { id: '1' }, expiraEn: ahora + 1000, ahora }
  throwsErr(() => componentesOfertaLimitada({ ...base, cupon: 'X', ordenBotones: ['url'] }), ErrorPlantilla, /no está en ordenBotones/)
  throwsErr(() => componentesOfertaLimitada({ ...base, cupon: 'X', ordenBotones: ['cupon', 'llamar'] }), ErrorPlantilla, /desconocido/)
  throwsErr(() => componentesOfertaLimitada({ ...base, sufijoUrl: 'a', ordenBotones: ['url', 'url'] }), ErrorPlantilla, /mismo tipo/)
  throwsErr(() => componentesOfertaLimitada({ ...base, ordenBotones: 'url' }), ErrorPlantilla, /lista/)
})

// ════════════════════════════════════════════════════════
// SANEO DEL ÚLTIMO METRO — vale para TODOS los envíos de plantilla
// ════════════════════════════════════════════════════════

test('saneo: limpia saltos y espacios en cuerpo y botones, rellena vacíos del cuerpo, no toca lo demás y no muta', () => {
  const entrada = [
    { type: 'header', parameters: [{ type: 'image', image: { id: '9' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'María\nPérez' }, { type: 'text', text: '   ' }, { type: 'text', text: 'pack   x3\t' }] },
    { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: ' promo\n' }] },
    { type: 'button', sub_type: 'copy_code', index: 1, parameters: [{ type: 'coupon_code', coupon_code: 'X 1' }] },
    { type: 'carousel', cards: [{ card_index: 0, components: [{ type: 'body', parameters: [{ type: 'text', text: '' }] }] }] }
  ]
  const copia = JSON.parse(JSON.stringify(entrada))
  const s = sanearComponentes(entrada)
  assert.deepEqual(entrada, copia, 'no muta lo que recibe')
  assert.deepEqual(s[0], entrada[0], 'la imagen no se toca')
  assert.deepEqual(s[1].parameters.map(p => p.text), ['María Pérez', '-', 'pack x3'])
  assert.equal(s[2].parameters[0].text, 'promo', 'botón de URL: se limpia pero NO se inventa un valor')
  assert.deepEqual(s[3], entrada[3], 'el cupón no se toca')
  assert.equal(s[4].cards[0].components[0].parameters[0].text, '-', 'también dentro de las tarjetas del carrusel')
  assert.deepEqual(sanearComponentes(undefined), [])
})

test('sendTemplateCloud: aplica el saneo a lo que arme cualquier llamador (followups, reapertura, aviso)', async () => {
  await conFetchFalso({ json: { messages: [{ id: 'wamid.T' }] } }, async (llamadas) => {
    const r = await sendTemplateCloud({
      telefono: '51987654321', templateName: 'hidata_followup_24h', languageCode: 'es_PE', credenciales: CRED,
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana\n' }, { type: 'text', text: '' }] }]
    })
    assert.equal(r.ok, true)
    assert.deepEqual(llamadas[0].body.template, {
      name: 'hidata_followup_24h',
      language: { code: 'es_PE' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '-' }] }]
    })
    // sin idioma (o vacío) cae a "es", nunca a un código vacío que Meta no encuentra
    await sendTemplateCloud({ telefono: '5199', templateName: 'x', languageCode: '', credenciales: CRED })
    assert.deepEqual(llamadas[1].body.template, { name: 'x', language: { code: 'es' } })
  })
})

// ════════════════════════════════════════════════════════
// EL HISTORIAL GUARDA LO QUE EL CLIENTE LEYÓ
// ════════════════════════════════════════════════════════

test('texto de plantilla: se guarda el texto aprobado con sus variables, saneadas igual que al enviar', () => {
  assert.equal(textoDePlantilla('followup_24h', ['María', 'colágeno\nhidrolizado'], {}),
    'Hola María 👋 Quedó pendiente tu consulta sobre colágeno hidrolizado. Si te animas, coordinamos tu pedido con gusto. ¿Lo vemos? 😊')
  assert.match(textoDePlantilla('compromiso', [], {}), /^Hola - 👋/, 'una variable que falta no deja un {{1}} crudo')
})

test('texto de plantilla: si la env var apunta a OTRA plantilla, se guarda un marcador honesto (no un texto inventado)', () => {
  assert.equal(textoDePlantilla('followup_24h', ['María', 'x'], { CLOUD_TEMPLATE_FOLLOWUP_24H: 'mi_seguimiento' }), '[plantilla «mi_seguimiento» enviada]')
  assert.equal(textoDePlantilla('no_existe', ['x'], {}), '[plantilla «no_existe» enviada]', 'NUNCA lanza: se usa junto a un envío real')
})

test('historial de plantilla conserva nombre, idioma y texto propios de otro tenant', () => {
  assert.equal(textoDePlantilla('followup_24h',['Ana','producto'],{plantilla:'otro_seguimiento',idioma:'es_PE'}),'[plantilla «otro_seguimiento» enviada]')
  assert.equal(textoDePlantilla('followup_24h',['Ana','producto'],{plantilla:'otro_seguimiento',idioma:'es_PE',cuerpo:'Hola {{1}}, consulta de {{2}}.'}),'Hola Ana, consulta de producto.')
  assert.equal(textoDePlantilla('followup_24h',['Ana'],{plantilla:CATALOGO[0].nombre,idioma:'es_PE'}),'[plantilla «'+CATALOGO[0].nombre+'» enviada]')
})

// ════════════════════════════════════════════════════════
// PLAN CONTRA META (lo que usa scripts/meta-plantillas.js)
// ════════════════════════════════════════════════════════

const enMeta = (name, extra = {}) => ({ id: `id_${name}`, name, language: 'es', status: 'APPROVED', category: 'MARKETING', ...extra })

test('plan: detecta faltantes, aprobadas, calidad y la plantilla que existe en OTRO idioma', () => {
  const existentes = [
    enMeta('hidata_followup_24h', { quality_score: { score: 'RED' } }),
    enMeta('hidata_reapertura', { language: 'es_PE' }),
    enMeta('hidata_compromiso', { status: 'PENDING', category: 'UTILITY' })
  ]
  const plan = planificarPlantillas({ existentes, idioma: 'es', env: {} })
  const por = Object.fromEntries(plan.map(p => [p.clave, p]))
  assert.equal(por.followup_24h.estado, 'APPROVED')
  assert.equal(por.followup_24h.calidad, 'RED')
  assert.equal(por.reapertura.estado, 'FALTA')
  assert.deepEqual(por.reapertura.otrosIdiomas, ['es_PE'], 'el error más común: creada en es_PE, buscada en es')
  assert.equal(por.compromiso.estado, 'PENDING')
  assert.equal(por.aviso_vendedor.estado, 'FALTA')
  assert.deepEqual(lineasDeEntorno(plan, 'es'), ['CLOUD_TEMPLATE_FOLLOWUP_24H=hidata_followup_24h'])
  assert.deepEqual(lineasDeEntorno(plan, 'es_PE'), ['CLOUD_TEMPLATE_FOLLOWUP_24H=hidata_followup_24h', 'CLOUD_TEMPLATE_IDIOMA=es_PE'])
  assert.equal(planificarPlantillas({ existentes, env: {}, solo: 'compromiso' }).length, 1)
})

test('plan: avisa si el texto en Meta ya no es el del catálogo (el historial guardaría un texto que el cliente no ve)', () => {
  const t = CATALOGO.find(x => x.clave === 'followup_24h')
  const igual = enMeta('hidata_followup_24h', { components: [{ type: 'BODY', text: t.cuerpo, example: {} }] })
  const editada = enMeta('hidata_followup_24h', { components: [{ type: 'HEADER', text: 'x' }, { type: 'BODY', text: 'Hola {{1}}, otro texto {{2}} ya.' }] })
  assert.equal(cuerpoEnMeta(editada), 'Hola {{1}}, otro texto {{2}} ya.')
  assert.equal(planificarPlantillas({ existentes: [igual], env: {}, solo: 'followup_24h' })[0].textoDifiere, false)
  assert.equal(planificarPlantillas({ existentes: [editada], env: {}, solo: 'followup_24h' })[0].textoDifiere, true)
  // sin `components` en la respuesta no se afirma nada
  assert.equal(planificarPlantillas({ existentes: [enMeta('hidata_followup_24h')], env: {}, solo: 'followup_24h' })[0].textoDifiere, false)
  // una plantilla que maneja el equipo (env var apunta a otra) no se compara ni se toca
  const ajena = planificarPlantillas({ existentes: [enMeta('mi_seguimiento', { components: [{ type: 'BODY', text: 'otro' }] })], env: { CLOUD_TEMPLATE_FOLLOWUP_24H: 'mi_seguimiento' }, solo: 'followup_24h' })[0]
  assert.equal(ajena.gestionada, false)
  assert.equal(ajena.textoDifiere, false)
  assert.deepEqual(payloadDeEdicion(t).components[0].example, { body_text: [t.ejemplos] })
})

// ════════════════════════════════════════════════════════
// AVISOS DE META SOBRE PLANTILLAS (pausada, rechazada, recategorizada, calidad)
// ════════════════════════════════════════════════════════

const avisoDePlantilla = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA_1', time: 1, changes: [{ field, value }] }] })

test('parser: los tres avisos de plantilla salen como eventos propios, con la cuenta (WABA) que los mandó', () => {
  const [estado] = parseCloudWebhook(avisoDePlantilla('message_template_status_update', {
    event: 'PAUSED', message_template_id: 278077987957091, message_template_name: 'hidata_followup_24h',
    message_template_language: 'es', reason: 'NONE', other_info: { title: 'FIRST_PAUSE', description: 'Pausada 3 h por calidad' }
  }))
  assert.deepEqual(estado, {
    tipo: 'plantilla', wabaId: 'WABA_1', plantillaId: '278077987957091', nombre: 'hidata_followup_24h', idioma: 'es',
    cambio: 'estado', estado: 'PAUSED', motivo: 'NONE', detalle: 'Pausada 3 h por calidad', categoria: null
  })
  const [cat] = parseCloudWebhook(avisoDePlantilla('template_category_update', {
    message_template_id: 1, message_template_name: 'hidata_compromiso', message_template_language: 'es', previous_category: 'UTILITY', new_category: 'MARKETING'
  }))
  assert.equal(cat.cambio, 'categoria')
  assert.equal(cat.categoriaNueva, 'MARKETING')
  const [cal] = parseCloudWebhook(avisoDePlantilla('message_template_quality_update', {
    previous_quality_score: 'GREEN', new_quality_score: 'RED', message_template_id: 2, message_template_name: 'x', message_template_language: 'es'
  }))
  assert.deepEqual([cal.cambio, cal.calidadAnterior, cal.calidadNueva], ['calidad', 'GREEN', 'RED'])
  assert.equal(eventoDePlantilla('messages', {}), null, 'los mensajes siguen su camino de siempre')
})

test('avisos: una plantilla PAUSADA que usa el bot dice QUÉ deja de funcionar', () => {
  const { nivel, linea } = describirEventoDePlantilla({ cambio: 'estado', nombre: 'hidata_followup_24h', idioma: 'es', estado: 'PAUSED', motivo: 'NONE' }, {})
  assert.equal(nivel, 'warn')
  assert.match(linea, /PAUSED/)
  assert.match(linea, /CLOUD_TEMPLATE_FOLLOWUP_24H/)
  assert.match(linea, /FALLAN/)
  // la misma pausa en una plantilla que el bot no usa: se registra, pero sin culpar a nadie
  const ajena = describirEventoDePlantilla({ cambio: 'estado', nombre: 'promo_navidad', idioma: 'es', estado: 'PAUSED' }, {})
  assert.doesNotMatch(ajena.linea, /CLOUD_TEMPLATE_/)
  assert.equal(plantillaPorNombre('hidata_compromiso', {}).clave, 'compromiso')
})

test('avisos: aprobada (info), recategorizada (warn con el nuevo cobro) y calidad roja (warn)', () => {
  const ok = describirEventoDePlantilla({ cambio: 'estado', nombre: 'hidata_compromiso', idioma: 'es', estado: 'APPROVED', categoria: 'utility' }, {})
  assert.equal(ok.nivel, 'info')
  assert.match(ok.linea, /APPROVED como UTILITY/)
  const va = describirEventoDePlantilla({ cambio: 'categoria', nombre: 'hidata_compromiso', idioma: 'es', categoriaNueva: 'UTILITY', categoriaCorrecta: 'MARKETING', desde: 1746169200 }, {})
  assert.equal(va.nivel, 'warn')
  assert.match(va.linea, /va a pasar .* de UTILITY a MARKETING el 2025-05-02/)
  const fue = describirEventoDePlantilla({ cambio: 'categoria', nombre: 'hidata_compromiso', idioma: 'es', categoriaAnterior: 'UTILITY', categoriaNueva: 'MARKETING' }, {})
  assert.match(fue.linea, /UTILITY → MARKETING .* se cobra como MARKETING/)
  const roja = describirEventoDePlantilla({ cambio: 'calidad', nombre: 'x', idioma: 'es', calidadAnterior: 'YELLOW', calidadNueva: 'RED' }, {})
  assert.equal(roja.nivel, 'warn')
  assert.equal(describirEventoDePlantilla({ cambio: 'calidad', calidadNueva: 'GREEN' }, {}).nivel, 'info')
})

test('webhook: un aviso de plantilla se registra y NO abre turnos ni toca la base', async () => {
  const warns = []
  const original = console.warn
  console.warn = (...a) => { warns.push(a.join(' ')) }
  try {
    const r = await procesarWebhookCloud(avisoDePlantilla('message_template_status_update', {
      event: 'DISABLED', message_template_id: 9, message_template_name: 'hidata_aviso_vendedor', message_template_language: 'es', reason: 'NONE'
    }))
    // Hito A1: el webhook devuelve también el resumen de la escritura durable. Un aviso de
    // plantilla no abre turnos NI toca la bandeja, así que no debe guardar nada.
    assert.equal(r.ok, true)
    assert.equal(r.queued, 0); assert.equal(r.skipped, 0); assert.equal(r.errores, 0)
    assert.deepEqual({ guardadas: r.persistencia.guardadas, duplicadas: r.persistencia.duplicadas, fallidas: r.persistencia.fallidas }, { guardadas: 0, duplicadas: 0, fallidas: 0 })
  } finally {
    console.warn = original
  }
  assert.equal(warns.length, 1)
  assert.match(warns[0], /\[CloudRouter\] ⚠ plantilla «hidata_aviso_vendedor» \[es\] DISABLED/)
  assert.match(warns[0], /CLOUD_TEMPLATE_AVISO_VENDEDOR/)
})
