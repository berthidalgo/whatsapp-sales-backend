import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validarMedia } from '../src/lib/mediaStore.js'

test('validarMedia: acepta image/audio con base64; rechaza tipo, vacío y tamaño', () => {
  assert.equal(validarMedia({ tipo: 'image', base64: 'AAAA' }).ok, true)
  assert.equal(validarMedia({ tipo: 'audio', base64: 'AAAA' }).ok, true)
  assert.equal(validarMedia({ tipo: 'video', base64: 'AAAA' }).ok, false)  // tipo no soportado
  assert.equal(validarMedia({ tipo: 'image', base64: '' }).ok, false)       // sin base64
  assert.equal(validarMedia({ tipo: 'image', base64: null }).ok, false)
  // Cap 8MB: base64 ≈ 4/3 de los bytes → 12MB de base64 ≈ 9MB reales → rechazo
  const grande = 'A'.repeat(12 * 1024 * 1024)
  assert.equal(validarMedia({ tipo: 'image', base64: grande }).ok, false)
})
