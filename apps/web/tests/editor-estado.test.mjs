// tests/editor-estado.test.mjs — Estado del editor de campañas (Hito B1/B3).
//
// Sin React: son funciones puras de estado, así que se prueban directamente. Los tres
// escenarios que se comprueban son los que la lectura del componente señalaba como riesgos:
// borrador que se pierde al cambiar de campaña, respuesta tardía del copiloto que aplica
// cambios de una campaña en otra, y edición que se pierde durante un guardado.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cargarFicha, editar, prepararGuardado, confirmarGuardado, guardadoSigueVigente,
  descartarBorrador, borradorDe, respuestaEsAplicable, aplicarPropuesta, pideBorrado,
} from '../src/editor-estado.ts'

const fichaA = { campaignId: 1, version: 4, factSheet: { precio: { monto: 90 } }, agente: { nombreProducto: 'A' } }
const fichaB = { campaignId: 2, version: 1, factSheet: { precio: { monto: 500 } }, agente: { nombreProducto: 'B' } }

test('cambiar de campaña NO descarta el borrador: cada una tiene el suyo', () => {
  let b = {}
  b = cargarFicha(b, fichaA, 1).borradores
  b = editar(b, 1, { factSheet: { precio: { monto: 99 } } })
  assert.equal(borradorDe(b, 1).dirty, true)

  // Cambio a la campaña 2: entra con su ficha y el borrador de la 1 sigue intacto.
  b = cargarFicha(b, fichaB, 2).borradores
  assert.equal(borradorDe(b, 2).factSheet.precio.monto, 500)
  assert.equal(borradorDe(b, 1).factSheet.precio.monto, 99, 'el trabajo de la campaña 1 no se pierde')
  assert.equal(borradorDe(b, 1).dirty, true)

  // Y al volver a la 1, sigue ahí lo que se había escrito.
  b = cargarFicha(b, fichaA, 1).borradores
  assert.equal(borradorDe(b, 1).factSheet.precio.monto, 99)
})

test('un refetch del servidor NO pisa un borrador con cambios sin guardar', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  b = editar(b, 1, { factSheet: { precio: { monto: 120 } } })
  const recarga = { campaignId: 1, version: 5, factSheet: { precio: { monto: 90 } }, agente: {}}
  const r = cargarFicha(b, recarga, 1)
  assert.equal(r.descartado, false)
  assert.equal(borradorDe(r.borradores, 1).factSheet.precio.monto, 120, 'el polling no puede perder lo escrito')
})

test('una respuesta tardía del copiloto de la campaña A NO se aplica en la B', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  const peticionA = { campaignId: 1, revision: borradorDe(b, 1).revision, token: 1 }

  // El operador cambió a la campaña 2 mientras el copiloto pensaba.
  b = cargarFicha(b, fichaB, 2).borradores

  const conEdits = aplicarPropuesta(b, peticionA, 2, { factSheet: { precio: { monto: 1 } } })
  assert.equal(borradorDe(conEdits, 2).factSheet.precio.monto, 500, 'la propuesta de A no toca la ficha de B')

  // Y sobre su propia campaña sigue aplicando (con la revisión intacta).
  const sobreA = aplicarPropuesta(b, peticionA, 1, { factSheet: { incluye: ['nuevo'] } })
  assert.deepEqual(borradorDe(sobreA, 1).factSheet.incluye, ['nuevo'])
})

test('respuestaEsAplicable exige misma campaña Y misma revisión', () => {
  const peticion = { campaignId: 7, revision: 3, token: 9 }
  assert.equal(respuestaEsAplicable(peticion, 7, 3), true)
  assert.equal(respuestaEsAplicable(peticion, 8, 3), false, 'otra campaña')
  assert.equal(respuestaEsAplicable(peticion, 7, 4), false, 'el operador editó después de pedir')
  assert.equal(respuestaEsAplicable(null, 7, 3), false)
})

test('una edición hecha DURANTE el guardado sigue pendiente al terminar', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  b = editar(b, 1, { factSheet: { precio: { monto: 111 } } })
  const intento = prepararGuardado(b, 1)
  assert.equal(guardadoSigueVigente(b, intento), true)

  // El operador escribe otra vez mientras la petición está en el aire.
  b = editar(b, 1, { factSheet: { incluye: ['lo añadí durante el guardado'] } })
  assert.equal(guardadoSigueVigente(b, intento), false)

  const r = confirmarGuardado(b, intento, 5)
  assert.equal(r.followUpsPendientes, true)
  const guardado = borradorDe(r.borradores, 1)
  assert.equal(guardado.version, 5, 'la versión del servidor sí se adopta')
  assert.equal(guardado.dirty, true, 'pero lo escrito durante el vuelo sigue sin guardar')
  assert.deepEqual(guardado.factSheet.incluye, ['lo añadí durante el guardado'])
})

test('un guardado sin ediciones durante el vuelo deja el borrador limpio', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  b = editar(b, 1, { factSheet: { precio: { monto: 111 } } })
  const intento = prepararGuardado(b, 1)
  const r = confirmarGuardado(b, intento, 5)
  assert.equal(r.followUpsPendientes, false)
  assert.equal(borradorDe(r.borradores, 1).dirty, false)
})

test('descartar vuelve a lo que hay en el servidor, solo para esa campaña', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  b = cargarFicha(b, fichaB, 2).borradores
  b = editar(b, 1, { factSheet: { precio: { monto: 999 } } })
  b = editar(b, 2, { agente: { nombreProducto: 'B2' } })
  const tras = descartarBorrador(b, 1, { campaignId: 1, version: 9, factSheet: { precio: { monto: 90 } }, agente: { nombreProducto: 'A' } })
  assert.equal(borradorDe(tras, 1).factSheet.precio.monto, 90)
  assert.equal(borradorDe(tras, 1).version, 9)
  assert.equal(borradorDe(tras, 1).dirty, false)
  assert.equal(borradorDe(tras, 2).agente.nombreProducto, 'B2', 'descartar una campaña no toca la otra')
})

test('el copiloto propone y el borrador queda como cambio sin guardar (nunca guardado solo)', () => {
  let b = cargarFicha({}, fichaA, 1).borradores
  const peticion = { campaignId: 1, revision: borradorDe(b, 1).revision, token: 1 }
  b = aplicarPropuesta(b, peticion, 1, { agente: { nombreProducto: 'Propuesto' } })
  assert.equal(borradorDe(b, 1).agente.nombreProducto, 'Propuesto')
  assert.equal(borradorDe(b, 1).dirty, true, 'una propuesta NUNCA se guarda por sí sola: la confirma una persona')
})

test('pideBorrado detecta qué campos se quieren borrar sobre datos existentes', () => {
  const actual = { factSheet: { precio: { monto: 90 }, incluye: ['a'] }, agente: { tono: 'amable' } }
  const b = { campaignId: 1, version: 4, factSheet: { precio: { monto: 90 }, incluye: ['a'] }, agente: { tono: 'amable' }, dirty: true, revision: 1 }
  // El borrador no marca nada como null todavía → no pide confirmación.
  assert.deepEqual(pideBorrado(b, actual), [])
  // Borrar un dato que existe exige confirmación explícita (force en el PUT).
  assert.deepEqual(pideBorrado({ ...b, factSheet: { precio: null } }, actual), ['precio'])
  // Un null sobre algo que ya no existe no es pérdida de datos: no pide confirmación.
  assert.deepEqual(pideBorrado({ ...b, factSheet: { nuevoCampo: null } }, { factSheet: {}, agente: {} }), [])
})