// tests/event-router.test.js — parseo PURO del transporte (sin BD/LLM)
// Cubre la lógica de parseo de Evolution que nos mordió en vivo:
// caption de imagen, tipo de mensaje (audio/imagen → ruteo), addressing @lid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectMessageType,
  extractText,
  extractAddressing,
  extractAdContext
} from '../src/webhook/event-router.js'
import { summarizeEventResult } from '../src/webhook/event-router.js'

test('detectMessageType clasifica cada tipo de mensaje', () => {
  assert.equal(detectMessageType({ conversation: 'hola' }), 'text')
  assert.equal(detectMessageType({ extendedTextMessage: { text: 'hola' } }), 'text')
  assert.equal(detectMessageType({ audioMessage: {} }), 'audio')
  assert.equal(detectMessageType({ imageMessage: {} }), 'image')
  assert.equal(detectMessageType({ videoMessage: {} }), 'video')
  assert.equal(detectMessageType({ documentMessage: {} }), 'document')
  assert.equal(detectMessageType({ stickerMessage: {} }), 'sticker')
  assert.equal(detectMessageType({ locationMessage: {} }), 'location')
  assert.equal(detectMessageType({ contactMessage: {} }), 'contact')
})

test('detectMessageType: vacío / no-objeto → unknown', () => {
  assert.equal(detectMessageType(null), 'unknown')
  assert.equal(detectMessageType(undefined), 'unknown')
  assert.equal(detectMessageType('texto'), 'unknown')
  assert.equal(detectMessageType({}), 'unknown')
  assert.equal(detectMessageType({ algoRaro: {} }), 'unknown')
})

test('extractText: conversación y texto extendido (trim)', () => {
  assert.equal(extractText({ conversation: '  hola  ' }), 'hola')
  assert.equal(extractText({ extendedTextMessage: { text: ' qué tal ' } }), 'qué tal')
})

test('extractText: CAPTION de imagen/video/documento (el fix que nos mordió)', () => {
  // antes "exporto esto 👇 [foto]" se trataba como imagen muda → se perdía el texto
  assert.equal(extractText({ imageMessage: { caption: 'exporto mango 👇' } }), 'exporto mango 👇')
  assert.equal(extractText({ videoMessage: { caption: ' mira ' } }), 'mira')
  assert.equal(extractText({ documentMessage: { caption: 'mi RUC' } }), 'mi RUC')
})

test('extractText: imagen sin caption / vacío → string vacío', () => {
  assert.equal(extractText({ imageMessage: {} }), '')
  assert.equal(extractText({ audioMessage: {} }), '')
  assert.equal(extractText(null), '')
  assert.equal(extractText({}), '')
})

test('extractText: conversación tiene prioridad sobre caption', () => {
  assert.equal(extractText({ conversation: 'texto', imageMessage: { caption: 'pie' } }), 'texto')
})

test('extractAddressing: arma jid + senderPn con cascada de fuentes', () => {
  const a = extractAddressing(
    { remoteJid: '51999@s.whatsapp.net', addressingMode: 'pn' },
    { senderPn: '51999' },
    {}
  )
  assert.equal(a.remoteJid, '51999@s.whatsapp.net')
  assert.equal(a.senderPn, '51999')
  assert.equal(a.addressingMode, 'pn')
})

test('extractAddressing: senderPn cae a data y luego a key (@lid)', () => {
  // sin senderPn en el envelope → toma el de data
  const a = extractAddressing({ remoteJid: 'x@lid' }, {}, { senderPn: '51888' })
  assert.equal(a.senderPn, '51888')
  // sin nada → null (no inventa)
  const b = extractAddressing({ remoteJid: 'x@lid' }, {}, {})
  assert.equal(b.senderPn, null)
  assert.equal(b.addressingMode, null)
})

test('extractAdContext: sin contexto de anuncio → null', () => {
  assert.equal(extractAdContext({ conversation: 'hola' }), null)
  assert.equal(extractAdContext({}), null)
})

test('extractAdContext: anuncio CTWA (Meta Ads) → extrae title/source', () => {
  const ctx = extractAdContext({
    extendedTextMessage: {
      contextInfo: { externalAdReply: { title: 'Curso Export', sourceId: 'ad123' } }
    }
  })
  assert.equal(ctx.adReplyTitle, 'Curso Export')
  assert.equal(ctx.sourceId, 'ad123')
  assert.equal(ctx.hasAdContext, true)
})

test('summarizeEventResult: ok / error / vacío', () => {
  assert.match(summarizeEventResult({ ok: true, action: 'lead_message_queued', latency_ms: 5 }), /✅ lead_message_queued/)
  assert.match(summarizeEventResult({ ok: false, error: 'boom', latency_ms: 5 }), /❌ event error: boom/)
  assert.equal(summarizeEventResult(null), 'no result')
})
