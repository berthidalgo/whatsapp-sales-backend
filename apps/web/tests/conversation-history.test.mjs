import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeLatestConversation, mergeEarlierConversation } from '../src/conversation-history.ts'

const at = '2026-10-01T12:00:00.000Z'
const message = (id, extras = {}) => ({ id: `message:${id}`, kind: 'message', origen: 'BOT', texto: `Mensaje ${id}`, at, ...extras })
const response = (eventos, cursor = 'c1.opaque-cursor', hayMas = true, leadId = 1) => ({ leadId, eventos, page: { limit: 2, hayMas, cursor, cursorAntesDe: at } })

test('same timestamp pages keep every distinct event and deduplicate IDs', () => {
  const current = response([message(3), message(4)])
  const earlier = response([{ id: 'state:a', kind: 'state', label: 'Cambio', priority: 'low', at }, { id: 'media:2', kind: 'message', origen: 'LEAD', texto: null, at }, message(2), message(3)], 'c1.next-opaque')
  const merged = mergeEarlierConversation(current, earlier)
  assert.deepEqual(merged.eventos.map(event => event.id), ['state:a', 'media:2', 'message:2', 'message:3', 'message:4'])
  assert.equal(merged.page.cursor, 'c1.next-opaque')
})

test('polling retains previously loaded history and its opaque pagination boundary', () => {
  const current = response([message(1), message(2), message(3)], 'c1.oldest-loaded')
  const merged = mergeLatestConversation(current, response([message(3), message(4)], 'c1.new-window'))
  assert.deepEqual(merged.eventos.map(event => event.id), ['message:1', 'message:2', 'message:3', 'message:4'])
  assert.equal(merged.page.cursor, 'c1.oldest-loaded')
})

test('poll updates an existing receipt and removes obsolete failure details', () => {
  const current = response([message(1, { estado: 'failed', estadoDetalle: 'Error anterior' })])
  const merged = mergeLatestConversation(current, response([message(1, { estado: 'read' })]))
  assert.equal(merged.eventos.length, 1)
  assert.equal(merged.eventos[0].estado, 'read')
  assert.equal(merged.eventos[0].estadoDetalle, undefined)
})

test('an older page completing after a poll cannot downgrade its current receipt', () => {
  const current = response([message(2, { estado: 'read' })])
  const merged = mergeEarlierConversation(current, response([message(1), message(2, { estado: 'sent' })], null, false))
  assert.equal(merged.eventos.find(event => event.id === 'message:2').estado, 'read')
  assert.equal(merged.page.hayMas, false)
  assert.equal(merged.page.cursor, null)
})

test('switching leads never merges another lead timeline', () => {
  const current = response([message(1)], 'c1.first', true, 1)
  const other = response([message(2)], 'c1.second', true, 2)
  assert.deepEqual(mergeLatestConversation(current, other), other)
  assert.deepEqual(mergeEarlierConversation(current, other), current)
})
