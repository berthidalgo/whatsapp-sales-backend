// scripts/probar-cerebro.js — ¿QUÉ PROVEEDOR AGUANTA EL CEREBRO DE VERDAD? (sep 2026)
//
// El ping del arranque solo dice "la llave vale". No dice si el proveedor aguanta el
// prompt REAL del cerebro (~9-11K tokens, JSON obligatorio): así se nos pasó que el
// Groq gratis responde al ping y revienta con 413 en el primer lead. Este script le
// manda a CADA paso de la cadena el turno real (ficha de la campaña incluida) y dice,
// por proveedor: si respondió, cuánto tardó, cuántos tokens gastó y QUÉ le dijo al lead.
//
// Uso (desde apps/api; lee las llaves del .env de la RAÍZ):
//   node scripts/probar-cerebro.js                         → tenant de ACTIVE_TENANT, su campaña activa
//   node scripts/probar-cerebro.js --tenant bioayur        → otro cliente
//   node scripts/probar-cerebro.js --mensaje "cuánto cuesta?"
//   node scripts/probar-cerebro.js --solo mistral          → un solo proveedor
//
// Solo LEE de la base (la campaña). No crea leads ni manda nada por WhatsApp.
// Cada proveedor gasta 1 llamada de su cupo (el gratis de Gemini: 1 de ~500 al día).

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

// Import dinámico: agent-brain lee BRAIN_* del entorno al cargarse (después del .env).
const { construirCadena, describirCadena } = await import('../src/lib/llm-cadena.js')
const { pensarYResponder } = await import('../src/brain/agent-brain.js')
const { PrismaClient } = await import('@prisma/client')

const cadena = construirCadena().filter(p => !solo || p.provider === solo)
if (!cadena.length) {
  console.error('✖ No hay ningún proveedor con llave. Pon al menos GEMINI_DEV_API_KEY en el .env de la raíz.')
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
console.log(`Lead:     "${mensaje}"\n`)

const filas = []
for (const paso of cadena) {
  const r = await pensarYResponder({
    mensajeActual: mensaje,
    historial: [],
    estadoLead: { stage: 'greeting', slots: {}, mode: 'AUTO_CONSULTIVO', tenantId },
    campaignConfig: campana?.config || null,
    overrides: { provider: paso.provider, model: paso.model, location: paso.location, thinkingLevel: paso.thinkingLevel, fallback: false }
  })
  const err = r.ok ? null : (r.error_metadata?.parse_error || r.error_metadata?.message || r.error)
  filas.push({
    paso: paso.id,
    ok: r.ok,
    ms: r.audit?.latency_ms ?? null,
    tokens: r.audit?.tokens ?? null,
    detalle: r.ok ? r.mensaje.replace(/\s+/g, ' ').slice(0, 160) : String(err).slice(0, 160)
  })
  const f = filas[filas.length - 1]
  console.log(`${f.ok ? '✔' : '✖'} ${f.paso}  ${f.ms != null ? f.ms + ' ms' : ''}${f.tokens ? ` · ${f.tokens} tokens` : ''}`)
  console.log(`    ${f.ok ? '→ ' : ''}${f.detalle}\n`)
}

const vivos = filas.filter(f => f.ok).length
console.log(`Resultado: ${vivos}/${filas.length} proveedores aguantan el turno real.`)
if (!filas[0]?.ok) console.log('⚠ El PRIMARIO no respondió: el bot dependería de los seguros (o quedaría mudo).')
process.exit(vivos ? 0 : 1)
