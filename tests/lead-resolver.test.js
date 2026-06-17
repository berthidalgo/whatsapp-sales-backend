// tests/lead-resolver.test.js — identidad y filtro de no-leads (que el bot NO
// responda a grupos/canales/broadcast). Funciones PURAS de JID/teléfono.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhone, isNonLeadJid, isGroupJid, isLidJid, isPnJid } from '../src/webhook/lead-resolver.js'

test('normalizePhone extrae solo dígitos (quita @sufijo y whatsapp:)', () => {
  assert.equal(normalizePhone('51938188585@s.whatsapp.net'), '51938188585')
  assert.equal(normalizePhone('whatsapp:+51938188585'), '51938188585')
  assert.equal(normalizePhone('12345@lid'), '12345')
  assert.equal(normalizePhone(null), '')
  assert.equal(normalizePhone(''), '')
})

test('isNonLeadJid: true para grupo/canal/broadcast, false para lead real', () => {
  assert.equal(isNonLeadJid('123@g.us'), true)
  assert.equal(isNonLeadJid('123@newsletter'), true)
  assert.equal(isNonLeadJid('123@broadcast'), true)
  assert.equal(isNonLeadJid('51938188585@s.whatsapp.net'), false)
  assert.equal(isNonLeadJid('123@lid'), false)
  assert.equal(isNonLeadJid(null), false)
})

test('clasificadores de JID (group / lid / pn)', () => {
  assert.equal(isGroupJid('123@g.us'), true)
  assert.equal(isGroupJid('123@s.whatsapp.net'), false)
  assert.equal(isLidJid('123@lid'), true)
  assert.equal(isLidJid('123@g.us'), false)
  assert.equal(isPnJid('123@s.whatsapp.net'), true)
  assert.equal(isPnJid('123@lid'), false)
})
