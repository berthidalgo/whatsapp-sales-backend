// tests/vision-compat.test.js — las fotos sin llave de Google (sep 2026)
//
// Las llaves nuevas de AI Studio ("AQ.") dan 401 y Vertex pide facturación, así que
// Gemini llega por OpenRouter. Con VISION_PROVIDER, las fotos (comprobantes, capturas
// del anuncio) viajan por ese proveedor OpenAI-compatible en vez de Gemini directo.
// Proveedor falso en localhost: sin red, sin llaves.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { describirImagen, leerComprobante, pasoVisionCompat } from '../src/lib/vision.js'

const pedidos = []
let respuesta = {}
const servidor = createServer((req, res) => {
  let cuerpo = ''
  req.on('data', (c) => { cuerpo += c })
  req.on('end', () => {
    pedidos.push(JSON.parse(cuerpo))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(respuesta) } }], usage: { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330 } }))
  })
})
await new Promise((r) => servidor.listen(0, '127.0.0.1', r))

const anterior = { base: process.env.OPENAI_COMPAT_BASE_URL, vision: process.env.VISION_PROVIDER }
// Se fija en cada test, no al cargar el archivo: los tests comparten proceso
// (--test-isolation=none) y otro archivo puede tener su propio servidor falso.
function usarServidorFalso() {
  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${servidor.address().port}/v1`
  process.env.VISION_PROVIDER = 'compat:gemini-falso'
}
after(() => {
  servidor.close()
  for (const [k, v] of [['OPENAI_COMPAT_BASE_URL', anterior.base], ['VISION_PROVIDER', anterior.vision]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const FOTO = Buffer.from('foto-de-prueba').toString('base64')

test('visión: VISION_PROVIDER elige el proveedor compatible solo si tiene con qué autenticar', () => {
  usarServidorFalso()
  assert.equal(pasoVisionCompat()?.model, 'gemini-falso')
  assert.equal(pasoVisionCompat({ VISION_PROVIDER: 'openrouter:google/gemini-3.1-flash-lite' }), null,
    'sin OPENROUTER_API_KEY no hay a quién llamar: sigue Gemini directo')
  assert.equal(pasoVisionCompat({}), null, 'sin la variable, todo igual que antes')
})

test('visión: la foto viaja como image_url y el schema va en las instrucciones', async () => {
  usarServidorFalso()
  pedidos.length = 0
  respuesta = { categoria: 'captura_pantalla', descripcion: 'una captura de un anuncio de suplemento' }
  const r = await describirImagen({ base64: FOTO, mimeType: 'image/png', tenantId: 'demo' })

  assert.deepEqual(r, { ok: true, categoria: 'captura_pantalla', descripcion: 'una captura de un anuncio de suplemento' })
  const msgs = pedidos[0].messages
  assert.equal(pedidos[0].model, 'gemini-falso')
  assert.match(msgs[0].content, /FORMATO DE SALIDA/, 'sin schema nativo, el formato va en el system prompt')
  const partes = msgs[1].content
  assert.equal(partes[0].type, 'text')
  assert.equal(partes[1].image_url.url, `data:image/png;base64,${FOTO}`)
})

test('visión: el comprobante también se lee por el proveedor compatible', async () => {
  usarServidorFalso()
  pedidos.length = 0
  respuesta = { es_comprobante: true, metodo: 'Yape', monto: 'S/ 329.00', resumen: 'Yape S/ 329' }
  const r = await leerComprobante({ base64: FOTO, mimeType: 'image/jpeg', tenantId: 'demo' })
  assert.equal(r.ok, true)
  assert.equal(r.esComprobante, true)
  assert.equal(r.datos.monto, 'S/ 329.00')
  assert.equal(pedidos.length, 1)
})
