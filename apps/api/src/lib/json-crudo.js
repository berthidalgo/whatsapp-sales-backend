// src/lib/json-crudo.js — parser de JSON que CONSERVA el cuerpo crudo (sep 2026)
//
// Meta firma cada webhook con HMAC-SHA256 sobre los bytes EXACTOS del cuerpo
// (header X-Hub-Signature-256). Una vez parseado a objeto ya no se puede recalcular esa
// firma: hay que guardar los bytes antes. Este parser reemplaza al de JSON por defecto
// de Fastify, deja los bytes en `req.rawBody` y luego parsea con el MISMO parser seguro
// de Fastify (el que bloquea __proto__ / constructor en el JSON).
//
// Un cuerpo vacío se trata como "sin cuerpo" (el de Fastify devolvía 400 si el cliente
// mandaba el header Content-Type: application/json sin cuerpo, p.ej. en un DELETE).

export function registrarJsonConCuerpoCrudo(app) {
  const parserSeguro = app.getDefaultJsonParser('error', 'ignore')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    if (!body || body.length === 0) return done(null, undefined)
    parserSeguro(req, body.toString('utf8'), done)
  })
}
