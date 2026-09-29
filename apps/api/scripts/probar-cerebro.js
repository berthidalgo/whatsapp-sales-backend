// scripts/probar-cerebro.js — ¿QUÉ PROVEEDOR AGUANTA EL CEREBRO DE VERDAD? (sep 2026)
//
// El ping del arranque solo dice "la llave vale". No dice si el proveedor aguanta el
// prompt REAL del cerebro (~11K tokens, JSON obligatorio): así se nos pasó que el
// Groq gratis responde al ping y revienta con 413 en el primer lead. Este script le
// manda a CADA paso de la cadena el turno real (ficha de la campaña incluida) y dice,
// por proveedor: si respondió, cuánto tardó, cuántos tokens gastó y QUÉ le dijo al lead.
//
// Uso (desde apps/api; lee las llaves del .env de la RAÍZ):
//   node scripts/probar-cerebro.js                         → tenant de ACTIVE_TENANT, su campaña activa
//   node scripts/probar-cerebro.js --tenant bioayur        → otro cliente
//   node scripts/probar-cerebro.js --mensaje "cuánto cuesta?"
//   node scripts/probar-cerebro.js --solo mistral          → un solo proveedor
//   node scripts/probar-cerebro.js --solo mistral --modelos ministral-14b-latest,ministral-8b-latest
//   node scripts/probar-cerebro.js --conversacion          → 4 turnos (saludo, precio, objeción, pedido)
//                                                            para juzgar CALIDAD, no solo si responde
//   node scripts/probar-cerebro.js --guion "hola|por la piel|¿cuánto el de 3?"   → conversación propia
//
// Solo LEE de la base (la campaña). No crea leads ni manda nada por WhatsApp.
// Cada turno gasta 1 llamada del cupo del proveedor (el gratis de Gemini: 1 de ~500 al día).

import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* sin .env: variables del entorno */ }

const args = process.argv.slice(2)
const valor = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const tenantId = valor('--tenant') || process.env.ACTIVE_TENANT || 'bioayur'
const mensaje = valor('--mensaje') || 'Hola, vi su anuncio y quiero más información 😊'
const solo = valor('--solo')
const modelos = (valor('--modelos') || '').split(',').map(x => x.trim()).filter(Boolean)
// Un lead de anuncio típico: llega tibio, pregunta el precio, lo objeta y pide comprar.
// --guion "msg1|msg2|..." arma una conversación propia (ej. una que sí llegue al precio).
const GUION = valor('--guion')
  ? valor('--guion').split('|').map(x => x.trim()).filter(Boolean)
  : args.includes('--conversacion')
    ? [mensaje, '¿Cuánto cuesta?', 'Mmm está un poco caro, lo voy a pensar', 'Ok, ¿cómo hago el pedido?']
    : [mensaje]

// Import dinámico: agent-brain lee BRAIN_* del entorno al cargarse (después del .env).
const { construirCadena, describirCadena, normalizarPaso } = await import('../src/lib/llm-cadena.js')
const { pensarYResponder } = await import('../src/brain/agent-brain.js')
const { PrismaClient } = await import('@prisma/client')

const cadena = solo && modelos.length
  ? modelos.map(m => normalizarPaso({ provider: solo, model: m })).filter(Boolean)
  : construirCadena().filter(p => !solo || p.provider === solo)
if (!cadena.length) {
  console.error('✖ No hay ningún proveedor con llave. Pon al menos una llave (GEMINI_DEV_API_KEY, MISTRAL_API_KEY...) en el .env de la raíz.')
  process.exit(1)
}

const prisma = new PrismaClient({ log: ['error'] })
let campana = null
try {
  campana = await prisma.campaign.findFirst({
    where: { tenantId, activa: true },
    orderBy: { id: 'asc' },
    select: { slug: true, nombre: true, config: true }
  })
} catch (e) {
  console.warn(`⚠ No pude leer la campaña (${e.message.slice(0, 80)}). Sigo sin ficha: el prompt será más chico que el real.`)
} finally {
  await prisma.$disconnect()
}

console.log(`Cliente:  ${tenantId}${campana ? ` · campaña "${campana.nombre}" (${campana.slug})` : ' · SIN campaña'}`)
console.log(`Cadena:   ${describirCadena(cadena)}`)
console.log(`Guion:    ${GUION.length} turno(s) del lead\n`)

const filas = []
for (const paso of cadena) {
  // Cada proveedor corre el guion completo con SU propia conversación: el historial y la
  // etapa salen de sus respuestas, como en vivo.
  const historial = []
  let estadoLead = { stage: 'greeting', slots: {}, mode: 'AUTO_CONSULTIVO', tenantId }
  const fila = { paso: paso.id, ok: true, ms: 0, tokens: 0 }
  console.log(`── ${paso.id}`)
  for (const texto of GUION) {
    const r = await pensarYResponder({
      mensajeActual: texto,
      historial: [...historial],
      estadoLead,
      campaignConfig: campana?.config || null,
      overrides: { provider: paso.provider, model: paso.model, location: paso.location, thinkingLevel: paso.thinkingLevel, fallback: false }
    })
    fila.ms += r.audit?.latency_ms || 0
    fila.tokens += r.audit?.tokens || 0
    if (!r.ok) {
      const err = r.error_metadata?.parse_error || r.error_metadata?.message || r.error
      fila.ok = false
      console.log(`   LEAD: ${texto}\n   ✖ ${String(err).slice(0, 180)}\n`)
      break
    }
    const largo = GUION.length > 1 ? 600 : 220
    // Los guardianes de salida (precio que no está en la ficha, promesas prohibidas...)
    // marcan lo que el modelo dijo mal: es la mejor señal de calidad de un modelo barato.
    const flags = (r.guardrail_flags || []).length ? `\n   ⚠ guardianes: ${r.guardrail_flags.join(' | ').slice(0, 300)}` : ''
    console.log(`   LEAD: ${texto}\n   BOT (${r.audit?.latency_ms} ms · ${r.stage_sugerido}): ${r.mensaje.replace(/\s+/g, ' ').slice(0, largo)}${flags}\n`)
    historial.push({ rol: 'lead', texto }, { rol: 'agente', texto: r.mensaje })
    estadoLead = { ...estadoLead, stage: r.stage_sugerido || estadoLead.stage, slots: { ...estadoLead.slots, ...(r.slots_detectados || {}) } }
  }
  filas.push(fila)
  console.log(`   ${fila.ok ? '✔' : '✖'} total ${fila.ms} ms${fila.tokens ? ` · ${fila.tokens} tokens` : ''}\n`)
}

const vivos = filas.filter(f => f.ok).length
console.log(`Resultado: ${vivos}/${filas.length} proveedores aguantan ${GUION.length > 1 ? 'la conversación completa' : 'el turno real'}.`)
if (!solo && !filas[0]?.ok) console.log('⚠ El PRIMARIO no respondió: el bot dependería de los seguros (o quedaría mudo).')
process.exit(vivos ? 0 : 1)
