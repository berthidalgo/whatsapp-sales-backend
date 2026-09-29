// tests/contrato-vertical.test.js — EL CONTRATO DE TODO VERTICAL (jul 2026)
//
// POR QUÉ EXISTE:
//   El cerebro de Perú Exporta es ~3 meses de destilado: 9 sesiones de prueba,
//   5 chats reales analizados, los 3 cierres de Francisco y una lista de
//   incidentes en vivo (Óscar, JH, nicobtez, Julio, Gabriel). Ese aprendizaje son
//   las reglas de nucleo-comun.js.
//
//   Cuando se portó a BIOAYUR, esas reglas se COPIARON a mano — y se perdieron 9
//   por el camino, entre ellas "SALUDAS UNA SOLA VEZ". Nadie se enteró: la suite
//   pasaba en verde y el guardrail del motor tapaba el síntoma. Con 3 clientes más
//   en cola, ese error se repite seguro.
//
// QUÉ GARANTIZA:
//   Que CUALQUIER vertical registrado —incluidos los que no existen todavía—
//   hereda el núcleo completo. Si alguien escribe un vertical nuevo copiando y
//   pegando, o borra una regla sin querer, esta suite falla y dice CUÁL falta.
//
// CÓMO SE AÑADE UN CLIENTE NUEVO (que este test no bloquee, sino que guíe):
//   1. crear src/brain/verticals/<negocio>.js
//   2. importar y componer los bloques de nucleo-comun.js
//   3. escribir SOLO lo propio del negocio (momentos, slots, reglas legales)
//   4. registrarlo en verticals/index.js
//   5. `npm test` → si falta una regla base, este test la nombra.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REGLAS_OBLIGATORIAS, NUCLEO_VERSION } from '../src/brain/verticals/nucleo-comun.js'
import { VERTICALES_DISPONIBLES, getVertical } from '../src/brain/verticals/index.js'

// Config mínima realista: un vertical debe poder construir su prompt aunque la
// campaña venga pelada (degradación segura — ya probado en vertical-colageno).
const CAMPAIGN = { agente: { nombre: 'Jhon', nombreProducto: 'Producto' }, nombreProducto: 'Producto' }
const FS = { precioTexto: 'S/ 100', precioMonto: 100, nombrePrograma: 'Programa' }
const ESTADO = { stage: 'presenting', slots: { nombre: 'María' }, yaSaludo: true }

function promptDe(vertical) {
  return vertical.construirSystemPrompt({
    campaignConfig: CAMPAIGN, fs: FS, vendorNombre: 'Jhon', estadoLead: ESTADO
  })
}

// ════════════════════════════════════════════════════════
// 1. Contrato de módulo — qué debe exportar todo vertical
// ════════════════════════════════════════════════════════

for (const id of VERTICALES_DISPONIBLES) {
  test(`contrato [${id}]: exporta lo que el motor necesita`, () => {
    const v = getVertical({ vertical: id }, null)

    assert.equal(v.VERTICAL_ID, id, 'VERTICAL_ID debe coincidir con su clave en el registry')
    assert.ok(v.RESPONSE_SCHEMA?.properties, 'debe traer RESPONSE_SCHEMA con properties')
    assert.equal(typeof v.construirSystemPrompt, 'function', 'debe traer construirSystemPrompt')
    assert.ok(v.MOMENTOS && Object.keys(v.MOMENTOS).length > 0, 'debe traer sus MOMENTOS')
    // La memoria del lead que vuelve habla el idioma del negocio (qué slots, qué etapas).
    assert.ok(Array.isArray(v.MEMORIA_EPISODICA?.datos) && v.MEMORIA_EPISODICA.etapas,
      'debe traer MEMORIA_EPISODICA { datos, etapas }: sin ella, un cliente que vuelve se recuerda con palabras de otro negocio')

    // El contrato de salida que el pipeline lee en CADA turno. Si un vertical no
    // los declara, el motor no sabe avanzar de etapa ni cuándo escalar.
    for (const campo of ['mensaje', 'stage_sugerido', 'debe_escalar_humano', 'temperatura_lead']) {
      assert.ok(v.RESPONSE_SCHEMA.properties[campo],
        `RESPONSE_SCHEMA debe declarar "${campo}" — el pipeline lo lee en cada turno`)
    }
  })
}

// ════════════════════════════════════════════════════════
// 2. Contrato del NÚCLEO — las reglas de los 3 meses, en todos
// ════════════════════════════════════════════════════════

for (const id of VERTICALES_DISPONIBLES) {
  test(`contrato [${id}]: hereda TODAS las reglas del núcleo`, () => {
    const prompt = promptDe(getVertical({ vertical: id }, null))
    const faltantes = REGLAS_OBLIGATORIAS
      .filter(([, fragmento]) => !prompt.includes(fragmento))
      .map(([nombre]) => nombre)

    assert.deepEqual(faltantes, [],
      `Al vertical "${id}" le faltan reglas del núcleo. Compón desde nucleo-comun.js ` +
      `en vez de copiar el texto a mano — es exactamente así como colágeno perdió ` +
      `"saluda una sola vez" sin que nadie lo notara.`)
  })
}

// ════════════════════════════════════════════════════════
// 2b. System prompt FIJO — la caché de prefijo del proveedor
// ════════════════════════════════════════════════════════
// Los proveedores cobran más barato la parte del pedido idéntica a un pedido anterior,
// pero solo si es idéntica desde el primer carácter. Hasta sep 2026 la hora iba en la
// segunda línea del prompt: ~70 de ~11K tokens eran reutilizables. Lo que cambia por
// turno (hora, memoria del contacto, historial de cierre) va en el mensaje del turno.

for (const id of VERTICALES_DISPONIBLES) {
  test(`contrato [${id}]: el system prompt no cambia entre leads ni turnos`, () => {
    const v = getVertical({ vertical: id }, null)
    const conDatosDelLead = v.construirSystemPrompt({
      campaignConfig: CAMPAIGN, fs: FS, vendorNombre: 'Jhon',
      estadoLead: { ...ESTADO, memoriaEpisodica: '# 🧠 MEMORIA — contacto que vuelve', cierreResumen: 'ya propusiste la llamada 3 veces' }
    })
    assert.equal(conDatosDelLead, promptDe(v),
      'la memoria y el historial de cierre van en el mensaje del turno (agent-brain → construirUserPrompt)')
    assert.doesNotMatch(promptDe(v), /Hoy es /,
      'la hora va en el mensaje del turno: dentro del system prompt rompe la caché del proveedor')
    assert.equal(typeof v.textoHistorialCierre, 'function',
      'debe traer textoHistorialCierre: el historial de cierre se dice distinto en cada negocio')
  })
}

// ════════════════════════════════════════════════════════
// 3. Degradación segura — un vertical no puede morir sin config
// ════════════════════════════════════════════════════════

for (const id of VERTICALES_DISPONIBLES) {
  test(`contrato [${id}]: construye el prompt aunque la campaña venga vacía`, () => {
    const v = getVertical({ vertical: id }, null)
    let prompt
    assert.doesNotThrow(() => {
      prompt = v.construirSystemPrompt({
        campaignConfig: null, fs: {}, vendorNombre: null, estadoLead: null
      })
    }, 'sin config el vertical debe degradar, no reventar')

    assert.ok(prompt.length > 1000, 'el prompt degradado sigue siendo un prompt completo')

    // Sin ficha NO puede haber precios AFIRMADOS en el texto base: si el prompt
    // trae una cifra, el modelo la repetirá como si fuera el precio real.
    // Se excluyen los EJEMPLOS DE FORMATO (marcados con "ej:"), que enseñan cómo
    // mostrar un descuento y no afirman ningún precio — verificado a mano en
    // exportación: `(ej: "~S/ 757~ → S/ 457")`.
    // Se extrae el contexto por ÍNDICE sobre el texto original (no con match/g, que
    // no solapa: en "(ej: "~S/ 757~ → S/ 457")" el primer match se come el "(ej:" y
    // la segunda cifra se quedaría sin su marca de ejemplo).
    const preciosAfirmados = [...prompt.matchAll(/S\/\s?\d{3,}/g)]
      .map(m => prompt.slice(Math.max(0, m.index - 140), m.index + m[0].length))
      .filter(frag => !/\(?ej[:.]/i.test(frag))

    assert.deepEqual(preciosAfirmados, [],
      'sin factSheet el prompt no debe afirmar precios cableados')
  })
}

// ════════════════════════════════════════════════════════
// 4. Aislamiento — ningún vertical contamina a otro
// ════════════════════════════════════════════════════════

test('contrato: los verticales no se contaminan entre sí', () => {
  // Marcas de cada negocio. El prompt de uno JAMÁS debe contener las del otro:
  // ese fue el bug del 23-jul (una clienta de colágeno oyó hablar de exportación).
  const MARCAS = {
    exportacion: [/colágeno/i, /DIGEMID/i, /contraentrega/i],
    colageno: [/exportar/i, /exportación/i, /aduana/i]
  }

  for (const id of VERTICALES_DISPONIBLES) {
    const ajenas = MARCAS[id]
    if (!ajenas) continue
    const prompt = promptDe(getVertical({ vertical: id }, null))
    for (const rx of ajenas) {
      assert.ok(!rx.test(prompt),
        `El prompt de "${id}" menciona ${rx} — eso es de otro vertical.`)
    }
  }
})

test('contrato: el núcleo está versionado (trazabilidad de cambios)', () => {
  assert.match(NUCLEO_VERSION, /^v\d+_/, 'el núcleo debe declarar versión')
})
