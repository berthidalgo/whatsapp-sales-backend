// tests/anti-contaminacion-tenant.test.js — EL GUARDIÁN ANTI-CONTAMINACIÓN (jul 2026)
//
// POR QUÉ EXISTE (incidente 2026-07-23, peritaje forense):
//   Una clienta de COLÁGENO mandó fotos por WhatsApp y el bot le respondió
//   "para ayudarte con lo de la EXPORTACIÓN". No fue una alucinación del modelo:
//   `vision.js` tenía la persona de Perú Exporta escrita a mano en el prompt y
//   `tenantId: 'peru_exporta'` como literal.
//
//   La causa de fondo NO fue ese archivo. Fue que el multitenant se implementó en
//   el camino del webhook de texto y NO en los caminos de fondo. El mismo defecto
//   apareció, el mismo día, en TRES sitios distintos:
//     1. vision.js         → persona + tenant hardcodeados
//     2. event-router.js   → fallback 'peru-exporta-test' (el número de un cliente)
//     3. followupEngine.js → SQL filtrado por ACTIVE_TENANT + plantillas resueltas
//                            una sola vez al cargar el módulo
//
// QUÉ PROTEGE: que ningún módulo COMPARTIDO conozca a un cliente concreto. El
// conocimiento del negocio vive SOLO en `brain/verticals/` (y en la config del
// tenant en BD); todo lo demás debe ser agnóstico.
//
// Por eso estos tests leen el CÓDIGO FUENTE en vez de ejecutarlo: el bug no es un
// valor en runtime, es una dependencia que no debería existir. Si alguien vuelve a
// cablear un cliente en el motor, esto falla antes de llegar a producción.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Quita comentarios: solo nos importa el CÓDIGO. Los comentarios SÍ pueden (y deben)
// nombrar a Perú Exporta o BIOAYUR para explicar la historia de cada fix.
function soloCodigo(fuente) {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')   // bloque
    .replace(/^\s*\/\/.*$/gm, '')       // línea completa
    .replace(/\s\/\/.*$/gm, '')         // trailing
}

function listarJs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listarJs(full, acc)
    else if (entry.endsWith('.js')) acc.push(full)
  }
  return acc
}

// Los ÚNICOS lugares donde un cliente concreto puede nombrarse. Cada exención es una
// decisión consciente, no un "lo dejamos pasar":
//
//   · brain/verticals/*        el manual de venta de cada negocio; su razón de ser ES la marca
//   · lib/tenant.js            el registro que mapea tenant → vertical
//   · brain-evals-dataset.js   casos de prueba históricos de Perú Exporta (no corre en prod)
//   · brain-judge.js           el juez de evals; evalúa contra la rúbrica de Perú Exporta.
//                              DEUDA: al 3er cliente hay que parametrizarlo por vertical.
//   · motor/followupEngine.js  PLANTILLAS_POR_VERTICAL: el copy sí nombra el producto, pero
//                              está INDEXADO por vertical y se elige con el tenant del lead.
//                              DEUDA: mudarlo a brain/verticals/ para que el motor quede limpio.
//   · lib/assets.js            nombres de ARCHIVO de imágenes por cliente (precios-bioayur.png).
//                              DEUDA: pasar a assets por tenant en BD.
//   · server.js                la URL del CRM en la allowlist de CORS: infraestructura, no discurso.
const EXENTOS = [
  ['brain', 'verticals'],
  ['lib', 'tenant.js'],
  ['brain', 'brain-evals-dataset.js'],
  ['brain', 'brain-judge.js'],
  ['motor', 'followupEngine.js'],
  ['lib', 'assets.js'],
  ['server.js']
]

function estaExento(archivo) {
  const rel = relative(SRC, archivo)
  return EXENTOS.some(partes => rel.includes(join(...partes)))
}

const ARCHIVOS = listarJs(SRC).filter(f => !estaExento(f))

// ════════════════════════════════════════════════════════
// 1. Ningún módulo compartido responde CON LA MARCA de un cliente
// ════════════════════════════════════════════════════════

test('anti-contaminación: ningún módulo compartido nombra a un cliente en un string', () => {
  // El bug exacto: `Eres Jhon, asesor humano de Perú Exporta TV...` dentro de vision.js.
  const MARCAS = /(Perú|Peru) Exporta|BIOAYUR|DermaLab|ELIXIR/i
  const culpables = []

  for (const archivo of ARCHIVOS) {
    const codigo = soloCodigo(readFileSync(archivo, 'utf8'))
    // Solo dentro de literales de string: así no saltan nombres de variables.
    const strings = codigo.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) || []
    for (const s of strings) {
      if (MARCAS.test(s)) {
        culpables.push(`${relative(SRC, archivo)} → ${s.slice(0, 90)}`)
      }
    }
  }

  assert.deepEqual(culpables, [],
    'Un módulo compartido nombra a un cliente concreto. Eso pertenece a brain/verticals/, ' +
    'no al motor: es exactamente lo que hizo que una clienta de colágeno recibiera el ' +
    'discurso de exportación.')
})

// ════════════════════════════════════════════════════════
// 2. Nadie cablea un tenant al llamar al modelo
// ════════════════════════════════════════════════════════

test('anti-contaminación: tenantId nunca es un literal al llamar al LLM', () => {
  // El bug exacto: `tenantId: 'peru_exporta'` en las dos llamadas de vision.js. Eso
  // manda la telemetría/quota de un cliente a la cuenta de otro.
  const culpables = []

  for (const archivo of ARCHIVOS) {
    const codigo = soloCodigo(readFileSync(archivo, 'utf8'))
    const matches = codigo.match(/tenantId:\s*['"][a-z_][a-z0-9_]*['"]/gi) || []
    for (const m of matches) culpables.push(`${relative(SRC, archivo)} → ${m}`)
  }

  assert.deepEqual(culpables, [],
    'tenantId debe VIAJAR desde el canal entrante (o el lead), nunca escribirse a mano.')
})

// ════════════════════════════════════════════════════════
// 3. El número de un cliente no puede ser el fallback de nadie
// ════════════════════════════════════════════════════════

test('anti-contaminación: cero fallbacks a la instancia de un cliente concreto', () => {
  // El bug exacto: `process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'`.
  // Ante cualquier fallo de resolución, los leads de un cliente recibían WhatsApp
  // desde el número de OTRO. Prefiero que el envío falle ruidosamente.
  const culpables = []

  for (const archivo of ARCHIVOS) {
    const codigo = soloCodigo(readFileSync(archivo, 'utf8'))
    const strings = codigo.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) || []
    for (const s of strings) {
      if (/peru-exporta-|bioayur-/i.test(s)) culpables.push(`${relative(SRC, archivo)} → ${s}`)
    }
  }

  assert.deepEqual(culpables, [],
    'Una instancia de Evolution de un cliente concreto aparece en el motor. ' +
    'La instancia se resuelve del canal entrante o del canal por defecto del tenant.')
})

// ════════════════════════════════════════════════════════
// 4. Los motores de fondo atienden a TODOS los tenants
// ════════════════════════════════════════════════════════

test('anti-contaminación: el motor de followups no filtra por ACTIVE_TENANT', () => {
  // El bug exacto: `AND l.tenant_id = '${ACTIVE_TENANT}'` en el SQL de candidatos.
  // Con eso, el cron solo atendía al cliente de la env var y TODOS los demás se
  // quedaban sin followups — sin ningún error visible.
  const codigo = soloCodigo(readFileSync(join(SRC, 'motor', 'followupEngine.js'), 'utf8'))

  assert.ok(!/tenant_id\s*=\s*'\$\{ACTIVE_TENANT\}'/.test(codigo),
    'El SQL de followups volvió a filtrar por ACTIVE_TENANT: los demás clientes se quedan sin followups.')

  assert.ok(/l\.tenant_id\s+AS\s+"tenantId"/.test(codigo),
    'El SQL debe TRAER el tenant de cada lead para elegir su plantilla y su canal de salida.')

  // followupEngine está exento del barrido de marcas (sus plantillas nombran el
  // producto por vertical), así que la instancia se verifica aquí a mano.
  assert.ok(!/peru-exporta-|bioayur-/i.test(codigo),
    'El motor de followups volvió a cablear la instancia de un cliente.')
})

test('anti-contaminación: la notificación de escalamiento va al vendedor DEL tenant', () => {
  // El bug exacto: destino = NUMERO_JOAN e instancia = 'peru-exporta-test', globales.
  // Si BIOAYUR escalaba un lead, el aviso salía por el número de Perú Exporta hacia el
  // dueño de Perú Exporta. Por eso 9 leads escalados murieron sin que nadie se enterara.
  const codigo = soloCodigo(readFileSync(join(SRC, 'webhook', 'notifications.js'), 'utf8'))

  assert.ok(/defaultChannelForTenant/.test(codigo),
    'La notificación debe salir por el canal del tenant, no por una env var global.')
  assert.ok(/prisma\.vendor\.findUnique/.test(codigo),
    'El destino debe ser el teléfono del vendedor del lead, no un número global.')
})

// ════════════════════════════════════════════════════════
// 5. vision.js DESCRIBE, no redacta
// ════════════════════════════════════════════════════════

test('vision: describe la imagen y NO genera la respuesta al lead', async () => {
  // La corrección de fondo: mientras este módulo redactara mensajes de venta, iba a
  // necesitar saber de qué negocio habla — y ahí nace la contaminación. Ahora solo
  // describe; el mensaje lo redacta el cerebro con el vertical del tenant.
  const vision = await import('../src/lib/vision.js')

  assert.equal(typeof vision.describirImagen, 'function',
    'describirImagen es el contrato nuevo: describir, no responder')
  assert.equal(vision.responderAImagen, undefined,
    'responderAImagen redactaba con la persona de un cliente hardcodeada — no debe volver')

  const codigo = soloCodigo(readFileSync(join(SRC, 'lib', 'vision.js'), 'utf8'))
  assert.ok(!/respuesta:\s*\{/.test(codigo),
    'El schema de visión no debe pedirle al modelo una "respuesta" para el lead.')
})
