// tests/guardrail-precio.test.js — EL GUARDRAIL MÁS CARO DE EQUIVOCARSE
//
// POR QUÉ EXISTE:
//   Un precio inventado es el peor error comercial del bot: compromete a la empresa
//   con una cifra que no existe. Ya pasó en producción — el bot dijo S/2,997 cuando
//   el real era S/1,500 (por eso nació el factSheet). Y en la prueba de Ministral
//   (28-sep-2026) dijo "S/ 319" por el pack de 3 de BIOAYUR, cuyo precio es S/ 329.
//
// QUÉ PROTEGE:
//   · Detección (auditoría pre-producción jul 2026): el detector solo miraba el SÍMBOLO
//     delante ("S/ 1500"); "cuesta 2500 soles" llegaba al lead sin marcar.
//   · Respaldo en la ficha (sep 2026): se comparaban dígitos como texto ("S/ 24" pasaba
//     porque "24" está en "249") y un precio por envase bien calculado se marcaba.
//   · Corrección (sep 2026): con ficha, la cifra inventada solo se MARCABA y el mensaje
//     salía igual. Ahora el modelo reescribe el borrador y, si no puede, se neutraliza.
//
//   El equilibrio es fino en las DOS direcciones y por eso está aquí congelado:
//     · si detecta de menos → precios inventados pasan sin marca
//     · si detecta de más  → "12 sesiones" o "1,300 alumnos" se marcan como precio y,
//       cuando la campaña no tiene factSheet, el motor NEUTRALIZA el mensaje: el bot
//       se comería frases sanas y sonaría roto.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  RX_DINERO, montoDe, revisarPrecios, partirOraciones, neutralizarOraciones, pensarYResponder
} from '../src/brain/agent-brain.js'
import { _resetCadena } from '../src/lib/llm-cadena.js'
import { flattenFactSheet } from '../src/response/factsheet-loader.js'
import * as colageno from '../src/brain/verticals/colageno.js'

function detecta(texto) {
  return (texto.match(new RegExp(RX_DINERO.source, RX_DINERO.flags)) || []).length > 0
}

// ── DEBE detectar: todo lo que es dinero de verdad ──
const ES_DINERO = [
  ['símbolo con espacio',        'La inversión es de S/ 1,500'],
  ['símbolo pegado',             'te queda en S/1500'],
  ['dólares con símbolo',        'son $300 al mes'],
  ['moneda detrás (el hueco)',   'cuesta 2500 soles'],
  ['moneda detrás singular',     'te lo dejo en 1 sol'],
  ['dólares escritos',           'serían 300 dolares'],
  ['dólares con tilde',          'serían 300 dólares'],
  ['código de moneda',           'el total es 2500 PEN'],
  ['dos cifras en la promo',     'precio regular S/ 757 pero hoy S/ 457'],
]

for (const [caso, texto] of ES_DINERO) {
  test(`precio: DETECTA ${caso} — "${texto}"`, () => {
    assert.ok(detecta(texto), 'una cifra de dinero sin detectar llega al lead sin validar contra la ficha')
  })
}

// ── NO debe detectar: números que no son dinero ──
// Si estos se marcaran, en una campaña sin factSheet el motor neutralizaría el
// mensaje y el bot se comería frases legítimas.
const NO_ES_DINERO = [
  ['cantidad de sesiones',   'el programa tiene 12 sesiones grabadas'],
  ['prueba social',          'ya formamos 1,300 exportadores'],
  ['número de módulo',       'eso lo ves en el módulo 3'],
  ['una hora',               'te llamo a las 3pm'],
  ['una edad',               'un alumno de 78 años lo logró'],
  ['duración en meses',      'el tratamiento completo es de 3 meses'],
  ['cantidad de envases',    'llévate 2 envases'],
]

for (const [caso, texto] of NO_ES_DINERO) {
  test(`precio: NO confunde ${caso} — "${texto}"`, () => {
    assert.ok(!detecta(texto),
      'marcar esto como precio haría que el motor neutralice mensajes sanos cuando no hay factSheet')
  })
}

// ════════════════════════════════════════════════════════
// Montos: la cifra se compara como NÚMERO, no como texto
// ════════════════════════════════════════════════════════

test('precio: montoDe entiende cómo se escribe el dinero en Perú', () => {
  assert.equal(montoDe('S/ 1,500'), 1500)
  assert.equal(montoDe('S/ 1,500.50'), 1500.5)
  assert.equal(montoDe('S/ 124.50'), 124.5)
  assert.equal(montoDe('124,50 soles'), 124.5)
  assert.equal(montoDe('S/. 139'), 139)
  assert.equal(montoDe('S/ 329.'), 329)        // punto final de la oración
  assert.equal(montoDe('$300'), 300)
  assert.equal(montoDe('2500 soles'), 2500)
  assert.equal(montoDe('sin cifra'), null)
})

// La ficha real de BIOAYUR (seed-bioayur.js): packs regulares + oferta de hoy.
const configBioayur = {
  vertical: 'colageno',
  agente: { nombre: 'Jhon', empresa: 'BIOAYUR', rol: 'asesor comercial de BIOAYUR', nombreProducto: 'BIOAYUR ELIXIR' },
  factSheet: {
    precio: {
      textoExacto: '1 envase: S/ 139 · 2 envases: S/ 249 (sale S/ 124.50 c/u) · 3 envases: S/ 339 (sale S/ 113 c/u) — EL MÁS RECOMENDADO (tratamiento completo de 3 meses). Cada envase dura 1 mes.',
      monto: 139,
      moneda: 'S/'
    },
    ofertaHoy: 'SOLO POR HOY (promo del día): 1 envase S/ 129 · 2 envases S/ 239 · 3 envases S/ 329 — ahorras S/ 10 en cualquier opción. Es el precio mínimo del día, no baja más.'
  }
}
const FS_BIOAYUR = flattenFactSheet(configBioayur)

const RESPALDADOS = [
  ['precio de la oferta de hoy',          'Con la promo de hoy el pack de 3 te queda en S/ 329 💜'],
  ['precio regular',                      'El envase suelto está a S/. 139'],
  ['moneda detrás',                       'El de 3 sale 329 soles con la promo'],
  ['precio por envase calculado',         'El de 3 queda en S/ 329, o sea S/ 109.67 por envase'],
  ['precio por envase redondeado',        'Con la promo te sale a S/ 110 cada uno'],
  ['ahorro de la ficha',                  'Hoy ahorras S/ 10 en cualquier opción'],
  ['ahorro de 3 sueltos vs el pack',      'Te ahorras S/ 58 frente a comprar 3 sueltos'],
  ['costo por día',                       'Por día son menos de S/4 por toda la fórmula'],
]

for (const [caso, texto] of RESPALDADOS) {
  test(`precio con ficha: RESPALDA ${caso} — "${texto}"`, () => {
    const r = revisarPrecios(texto, FS_BIOAYUR)
    assert.ok(r.detectados.length > 0, 'la cifra debe detectarse')
    assert.deepEqual(r.malos, [], 'una cuenta correcta con la ficha no debe gatillar la corrección')
  })
}

const INVENTADOS = [
  ['el caso real de Ministral (319 vs 329)', 'Con la promo de hoy el pack de 3 te queda en S/ 319 💜', 'S/ 319'],
  ['dígitos contenidos en otro precio',      'El pack de 2 está a S/ 24', 'S/ 24'],
  ['división sin decir que es por unidad',   'El de 2 envases te lo dejo en S/ 169', 'S/ 169'],
  ['"del día" no lo vuelve costo diario',    'Promo del día: S/ 319 el pack de 3', 'S/ 319'],
]

for (const [caso, texto, esperado] of INVENTADOS) {
  test(`precio con ficha: MARCA ${caso} — "${texto}"`, () => {
    assert.deepEqual(revisarPrecios(texto, FS_BIOAYUR).malos, [esperado])
  })
}

test('precio sin ficha: toda cifra es inventada', () => {
  const r = revisarPrecios('Cuesta 2500 soles y te llamo mañana', flattenFactSheet(null))
  assert.equal(r.sinFicha, true)
  assert.deepEqual(r.malos, ['2500 soles'])
})

// ════════════════════════════════════════════════════════
// Neutralizar la oración, sin romper precios ni párrafos
// ════════════════════════════════════════════════════════

test('oraciones: el punto decimal y "S/." no cortan la oración, y el texto se reconstruye igual', () => {
  const texto = 'Te sale a S/ 124.50 c/u. El suelto es S/. 139!\n\n¿Cuál prefieres?'
  const partes = partirOraciones(texto)
  assert.equal(partes.join(''), texto)
  assert.ok(partes.includes('Te sale a S/ 124.50 c/u.'))
  assert.ok(partes.includes(' El suelto es S/. 139!'))
})

test('neutralizar: cambia solo la oración con la cifra y conserva los párrafos del M4', () => {
  const frase = colageno.FRASE_PRECIO_SIN_FICHA
  const out = neutralizarOraciones(
    '¡Buenísimo! 😊\n\nEl pack de 3 queda en S/ 319. Y el envío es gratis.\n\n¿Te lo separo?',
    (o) => o.includes('S/ 319'),
    frase
  )
  assert.equal(out, `¡Buenísimo! 😊\n\n${frase.trim()} Y el envío es gratis.\n\n¿Te lo separo?`)
})

test('neutralizar: la frase va una sola vez aunque haya varias oraciones malas', () => {
  const out = neutralizarOraciones('Cuesta S/ 99. Y con descuento S/ 79. ¿Te animas?', (o) => /S\//.test(o), ' Te confirmo el precio.')
  assert.equal(out, 'Te confirmo el precio. ¿Te animas?')
})

// ════════════════════════════════════════════════════════
// El turno completo: borrador con precio inventado → corrección
// Proveedor OpenAI-compatible falso en localhost (sin red, sin llaves).
// ════════════════════════════════════════════════════════

const pedidos = []
let guion = []
const servidor = createServer((req, res) => {
  let cuerpo = ''
  req.on('data', (c) => { cuerpo += c })
  req.on('end', () => {
    pedidos.push(JSON.parse(cuerpo))
    const mensaje = guion.shift() ?? 'sin guion'
    const content = JSON.stringify({ mensaje, stage_sugerido: 'presenting', debe_escalar_humano: false, temperatura_lead: 'warm' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }))
  })
})
await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
const baseAnterior = process.env.OPENAI_COMPAT_BASE_URL
process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${servidor.address().port}/v1`
after(() => {
  servidor.close()
  if (baseAnterior === undefined) delete process.env.OPENAI_COMPAT_BASE_URL
  else process.env.OPENAI_COMPAT_BASE_URL = baseAnterior
})

function turno(respuestas) {
  _resetCadena()
  pedidos.length = 0
  guion = [...respuestas]
  return pensarYResponder({
    mensajeActual: '¿Y cuánto está el de 3?',
    historial: [{ rol: 'lead', texto: 'Hola, quiero la oferta' }, { rol: 'agente', texto: 'Soy Jhon 😊 ¿Por la piel, la energía o las articulaciones?' }],
    estadoLead: { stage: 'presenting', slots: {}, tenantId: 'bioayur', agenteNombre: 'Jhon' },
    campaignConfig: configBioayur,
    vendorNombre: 'Jhon',
    overrides: { provider: 'compat', model: 'modelo-falso' }
  })
}

test('turno: precio inventado → el modelo corrige el borrador y sale el precio real', async () => {
  const r = await turno([
    'Con la promo de hoy el pack de 3 te queda en S/ 319 💜 ¿Te lo separo?',
    'Con la promo de hoy el pack de 3 te queda en S/ 329 💜 ¿Te lo separo?'
  ])
  assert.equal(r.ok, true)
  assert.match(r.mensaje, /S\/ 329/)
  assert.doesNotMatch(r.mensaje, /319/)
  assert.ok(r.guardrail_flags.includes('precio_corregido_por_reintento:S/ 319'), r.guardrail_flags.join(','))
  assert.equal(pedidos.length, 2, 'una sola corrección')

  const correccion = pedidos[1].messages.at(-1).content
  assert.match(correccion, /CORRIGE TU BORRADOR/)
  assert.match(correccion, /S\/ 319/, 'le dice qué cifra estaba mal')
  assert.match(correccion, /3 envases S\/ 329/, 'y le da los precios reales de la ficha')
  assert.equal(pedidos[1].messages[0].content, pedidos[0].messages[0].content, 'mismo system prompt (caché)')
  assert.equal(r.audit.tokens, 240, 'la corrección también se cobra: se suman los dos pedidos')
})

test('turno: si la corrección vuelve a inventar, la oración se neutraliza (no sale un precio falso)', async () => {
  const r = await turno([
    'Te cuento 😊\n\nEl pack de 3 te queda en S/ 319. ¿Te lo separo?',
    'Te cuento 😊\n\nEl pack de 3 te queda en S/ 315. ¿Te lo separo?'
  ])
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.mensaje, /31[59]/)
  assert.ok(r.mensaje.includes(colageno.FRASE_PRECIO_SIN_FICHA.trim()))
  assert.match(r.mensaje, /^Te cuento 😊\n\n/, 'el resto del mensaje y sus párrafos se conservan')
  assert.ok(r.guardrail_flags.includes('precio_neutralizado_oracion_completa'))
})

test('turno: precio correcto → un solo pedido, sin corrección', async () => {
  const r = await turno(['Con la promo de hoy el pack de 3 te queda en S/ 329 💜 ¿Te lo separo?'])
  assert.equal(r.ok, true)
  assert.equal(pedidos.length, 1)
  assert.ok(!r.guardrail_flags.some(f => f.startsWith('precio_')), r.guardrail_flags.join(','))
})
