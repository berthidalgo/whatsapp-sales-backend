// tests/vertical-colageno.test.js — Vertical colágeno (BIOAYUR) + registry + anti-"curar"
//
// Cubre las 3 garantías del refactor de verticales (jul 2026):
//   1. El registry resuelve el vertical correcto (campaña > tenant > default).
//   2. El prompt de colágeno tiene el ADN de BIOAYUR y CERO contaminación de exportación.
//   3. El guardrail determinista anti-"curar" (DIGEMID/Meta) neutraliza el léxico
//      prohibido sin falsos positivos ("curiosa", "vida sana" se salvan).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVertical, VERTICALES_DISPONIBLES } from '../src/brain/verticals/index.js'
import * as colageno from '../src/brain/verticals/colageno.js'
import * as exportacion from '../src/brain/verticals/exportacion.js'
import { flattenFactSheet } from '../src/response/factsheet-loader.js'

// ═══════════════ 1. REGISTRY ═══════════════

test('registry: exporta ambos verticales', () => {
  assert.deepEqual(VERTICALES_DISPONIBLES.sort(), ['colageno', 'exportacion'])
})

test('registry: default histórico = exportacion (sin config ni tenant)', () => {
  assert.equal(getVertical(null, null).VERTICAL_ID, 'exportacion')
  assert.equal(getVertical({}, undefined).VERTICAL_ID, 'exportacion')
})

test('registry: tenant bioayur → colageno; peru_exporta → exportacion', () => {
  assert.equal(getVertical(null, 'bioayur').VERTICAL_ID, 'colageno')
  assert.equal(getVertical(null, 'peru_exporta').VERTICAL_ID, 'exportacion')
})

test('registry: config.vertical de la campaña MANDA sobre el tenant', () => {
  assert.equal(getVertical({ vertical: 'colageno' }, 'peru_exporta').VERTICAL_ID, 'colageno')
  assert.equal(getVertical({ vertical: 'exportacion' }, 'bioayur').VERTICAL_ID, 'exportacion')
})

test('registry: vertical desconocido cae a exportacion (nunca muere)', () => {
  assert.equal(getVertical({ vertical: 'inmobiliaria' }, 'bioayur').VERTICAL_ID, 'exportacion')
})

// ═══════════════ 2. PROMPT COLÁGENO ═══════════════

const configBioayur = {
  vertical: 'colageno',
  agente: { nombre: 'Jhon', empresa: 'BIOAYUR', rol: 'asesor comercial de BIOAYUR', nombreProducto: 'BIOAYUR ELIXIR' },
  factSheet: {
    precio: { textoExacto: '1 envase S/139 · 2 envases S/249 (S/124.50 c/u) · 3 envases S/339 (S/113 c/u)', monto: 139, moneda: 'S/' },
    incluye: ['Colágeno hidrolizado 10g', 'Resveratrol 300mg', 'Vitamina C 500mg', 'Magnesio 400mg', 'Zinc 10mg']
  }
}

function promptColageno(estadoLead = {}) {
  const fs = flattenFactSheet(configBioayur)
  return colageno.construirSystemPrompt({ campaignConfig: configBioayur, fs, vendorNombre: 'Jhon', estadoLead })
}

test('prompt colágeno: identidad BIOAYUR + reglas clave del .md', () => {
  const p = promptColageno()
  assert.match(p, /Eres Jhon, asesor comercial de BIOAYUR/)
  assert.match(p, /EL PRECIO NO EXISTE HASTA EL MOMENTO 4/)          // espejo de "la llamada no existe hasta M5"
  assert.match(p, /PROHIBIDO "CURAR"/)                                // regla legal DIGEMID
  assert.match(p, /apoya.*favorece.*contribuye/i)                     // lenguaje permitido
  assert.match(p, /CONTRAENTREGA/i)                                   // modelo de pago
  assert.match(p, /piel.*energía.*articulaciones/is)                  // el riel del dolor
  assert.match(p, /pack de 3/i)                                       // el ancla del cierre
  assert.match(p, /UNA PREGUNTA A LA VEZ/)                            // regla universal heredada
  assert.match(p, /PROHIBIDO EL DISCO RAYADO/)                        // regla universal heredada
  assert.match(p, /1 envase S\/139/)                                  // la ficha real inyectada en M4
})

test('prompt colágeno: CERO contaminación de exportación', () => {
  const p = promptColageno()
  for (const rastro of [/exportar/i, /RUC/, /aprender a exportar/i, /empresa constituida/i, /agendar la llamada/i, /palta/i]) {
    assert.doesNotMatch(p, rastro, `el prompt colágeno NO debe contener ${rastro}`)
  }
})

test('prompt colágeno: sin ficha NO da precios (degradación segura)', () => {
  const fs = flattenFactSheet(null)
  const p = colageno.construirSystemPrompt({ campaignConfig: null, fs, vendorNombre: 'Jhon', estadoLead: {} })
  assert.match(p, /NO des ningún precio/)
})

test('prompt colágeno: memoria episódica y resumen de cierre entran cuando existen', () => {
  const p = promptColageno({ memoriaEpisodica: '# 🧠 MEMORIA — bloque de prueba', cierreResumen: 'ya propusiste la llamada 2 veces' })
  assert.match(p, /MEMORIA — bloque de prueba/)
  assert.match(p, /TU HISTORIAL DE CIERRE/)
  // Sin ellos, los bloques NO aparecen (prompt limpio para lead nuevo)
  const p2 = promptColageno()
  assert.doesNotMatch(p2, /TU HISTORIAL DE CIERRE/)
})

test('schema colágeno: slots del negocio y contrato del motor intactos', () => {
  const s = colageno.RESPONSE_SCHEMA
  // Contrato compartido con el motor (brain-pipeline espera estos campos)
  for (const campo of ['mensaje', 'momento_actual', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead', 'slots_detectados', 'compromiso', 'cierre', 'razonamiento']) {
    assert.ok(s.properties[campo], `falta campo ${campo}`)
  }
  assert.deepEqual(s.required, ['mensaje', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead'])
  // Slots de colágeno (no de exportación)
  const slots = Object.keys(s.properties.slots_detectados.properties)
  assert.deepEqual(slots.sort(), ['detalle_dolor', 'direccion', 'distrito', 'dolor', 'experiencia_colageno', 'nombre', 'pack'])
  // El acumulador de cierre del motor lee estas claves — no renombrar
  const cierre = Object.keys(s.properties.cierre.properties)
  assert.deepEqual(cierre.sort(), ['objecion_trabajada', 'ofrecio_llamada', 'palanca'])
})

test('exportación: schema re-extraído conserva su contrato (byte-nivel de claves)', () => {
  const s = exportacion.RESPONSE_SCHEMA
  const slots = Object.keys(s.properties.slots_detectados.properties)
  assert.deepEqual(slots.sort(), ['empresa', 'experiencia', 'fecha_hora', 'nombre', 'pais_destino', 'producto'])
})

// ═══════════════ 3. GUARDRAIL ANTI-"CURAR" (determinista) ═══════════════

test('anti-curar: neutraliza "cura" y variantes (la oración entera, no la palabra)', () => {
  const casos = [
    'ELIXIR cura las arrugas en semanas. ¿Te lo mando?',
    'Este producto te va a curar el dolor de rodillas 😊 ¿Qué distrito?',
    'Con constancia logra la curación de tu piel. ¿Te animas?',
    'Es un producto curativo natural. ¿Te muestro las opciones?',
    'Te sanará las articulaciones. ¿Va?'
  ]
  for (const c of casos) {
    const r = colageno.validarMensajeExtra(c)
    assert.equal(r.flags.length, 1, `debe flaggear: "${c}"`)
    assert.match(r.flags[0], /curar_neutralizado/)
    assert.doesNotMatch(r.mensaje, /\bcura|\bsanará|curación|curativo/i, `léxico prohibido sobrevivió en: "${r.mensaje}"`)
    assert.match(r.mensaje, /suplemento que apoya/, 'debe insertar el reencuadre seguro')
  }
})

test('anti-curar: preserva las oraciones sanas del mensaje', () => {
  const r = colageno.validarMensajeExtra('¡Buenísima elección! Esto cura la artritis. El envío es gratis en Lima 📦 ¿Para qué distrito sería?')
  assert.match(r.mensaje, /envío es gratis en Lima/)
  assert.match(r.mensaje, /qué distrito/)
  assert.doesNotMatch(r.mensaje, /cura la artritis/)
})

test('anti-curar: CERO falsos positivos (curiosa, procura, vida sana, seguro)', () => {
  const sanos = [
    'Qué curiosa tu pregunta 😊 El colágeno apoya tu piel desde adentro.',
    'Procura tomarlo a la misma hora todos los días 💜',
    'Es parte de una vida sana y activa. ¿Te muestro las opciones?',
    'La compra es 100% segura: pagas al recibir 📦',
    'Apoya la firmeza de tu piel y favorece tu energía. ¿Con cuál te animas?'
  ]
  for (const s of sanos) {
    const r = colageno.validarMensajeExtra(s)
    assert.equal(r.flags.length, 0, `falso positivo en: "${s}"`)
    assert.equal(r.mensaje, s, 'el mensaje sano no debe tocarse')
  }
})

test('anti-curar: mensaje 100% prohibido no queda vacío (envía el reencuadre)', () => {
  const r = colageno.validarMensajeExtra('Te cura todo.')
  assert.ok(r.mensaje.length > 20)
  assert.match(r.mensaje, /suplemento que apoya/)
})

test('anti-curar: tolera null/vacío sin crashear', () => {
  assert.deepEqual(colageno.validarMensajeExtra(null).flags, [])
  assert.deepEqual(colageno.validarMensajeExtra('').flags, [])
})

test('exportación: validarMensajeExtra es no-op (cero cambio de comportamiento)', () => {
  const m = 'Este programa garantiza que aprendas.'  // exportación tiene su propio flag de promesas, no este
  const r = exportacion.validarMensajeExtra(m)
  assert.equal(r.mensaje, m)
  assert.deepEqual(r.flags, [])
})
