// tests/sitio-publico.test.js — la web pública del negocio: / y /privacidad (sep 2026)
//
// Meta restringió la cuenta de WhatsApp porque no podía leer qué vende el negocio. Si estas
// páginas dejan de responder, o pierden lo que el revisor busca, la cuenta puede volver a
// caer. Se prueban con un Fastify real (inject), sin levantar el servidor completo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { paginaInicio, paginaPrivacidad, HTML_INICIO, HTML_PRIVACIDAD, NEGOCIO } from '../src/api/sitio-publico.js'

async function pedir(url) {
  const app = Fastify()
  app.get('/', paginaInicio)
  app.get('/privacidad', paginaPrivacidad)
  const r = await app.inject({ method: 'GET', url })
  await app.close()
  return r
}

test('sitio: / dice quién es el negocio, qué vende y cómo se compra', async () => {
  const r = await pedir('/')
  assert.equal(r.statusCode, 200)
  assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/)
  for (const rubro of ['Juguetes', 'Hogar', 'Tecnología']) assert.match(r.body, new RegExp(`<h3>${rubro}</h3>`))
  assert.match(r.body, /contraentrega/)
  assert.match(r.body, /todo el Perú/)
  assert.match(r.body, new RegExp(`RUC</dt><dd>${NEGOCIO.ruc}`))
  assert.match(r.body, new RegExp(`https://wa\\.me/${NEGOCIO.whatsapp}"`))
  assert.match(r.body, /href="\/privacidad"/)
})

test('sitio: /privacidad identifica al responsable, cita la ley y explica cómo borrar datos', async () => {
  const r = await pedir('/privacidad')
  assert.equal(r.statusCode, 200)
  assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/)
  assert.match(r.body, new RegExp(`RUC ${NEGOCIO.ruc}`))
  assert.match(r.body, /Ley N\.° 29733/)
  assert.match(r.body, /id="eliminar"/)
  assert.match(r.body, /inteligencia artificial/)
})

test('sitio: páginas autocontenidas (sin scripts ni recursos externos)', () => {
  for (const html of [HTML_INICIO, HTML_PRIVACIDAD]) assert.doesNotMatch(html, /<script|<link |src=/i)
})
