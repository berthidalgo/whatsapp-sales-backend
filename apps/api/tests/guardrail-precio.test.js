// tests/guardrail-precio.test.js — EL GUARDRAIL MÁS CARO DE EQUIVOCARSE
//
// POR QUÉ EXISTE:
//   Un precio inventado es el peor error comercial del bot: compromete a la empresa
//   con una cifra que no existe. Ya pasó en producción — el bot dijo S/2,997 cuando
//   el real era S/1,500 (por eso nació el factSheet).
//
// QUÉ PROTEGE (auditoría pre-producción jul 2026):
//   El detector solo miraba el SÍMBOLO delante ("S/ 1500", "$300"). En cuanto el bot
//   de un cliente nuevo escribiera "cuesta 2500 soles" —sin símbolo, que es como
//   habla la gente— el guardrail no veía nada y la cifra llegaba al lead sin marcar.
//
//   El equilibrio es fino en las DOS direcciones y por eso está aquí congelado:
//     · si detecta de menos → precios inventados pasan sin marca
//     · si detecta de más  → "12 sesiones" o "1,300 alumnos" se marcan como precio y,
//       cuando la campaña no tiene factSheet, el motor NEUTRALIZA el mensaje: el bot
//       se comería frases sanas y sonaría roto.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// El regex vive dentro de validarSalida (función interna). Se extrae del fuente para
// testearlo aislado sin exportar tripas del cerebro solo para el test.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'brain', 'agent-brain.js')
const fuente = readFileSync(SRC, 'utf8')

const m = fuente.match(/const RX_DINERO = (\/[\s\S]*?\/[gimsuy]*)\s*\n/)
assert.ok(m, 'no se encontró RX_DINERO en agent-brain.js — ¿se renombró el guardrail de precio?')
// eslint-disable-next-line no-eval
const RX_DINERO = eval(m[1])

function detecta(texto) {
  const rx = new RegExp(RX_DINERO.source, RX_DINERO.flags)
  const hits = texto.match(rx)
  return !!(hits && hits.length)
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

test('precio: el guardrail sigue cableado en validarSalida', () => {
  // Que el regex exista no basta: tiene que seguir usándose para producir los flags.
  assert.match(fuente, /preciosEnMensaje\s*=\s*mensaje\.match\(RX_DINERO\)/,
    'RX_DINERO debe seguir alimentando la detección de precio fantasma')
  assert.match(fuente, /precio_inventado_sin_factsheet/,
    'debe seguir marcando el caso más peligroso: cifra sin ficha que la respalde')
})
