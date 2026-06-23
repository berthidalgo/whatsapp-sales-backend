// scripts/examen-modelos.js — Hidata v20 · Runner del examen gpt-oss-120b vs 2.5-pro
//
// Pega a los endpoints /debug/brain-evals y /debug/brain-replay del backend en
// Render, de a UNA unidad por request (un caso de eval / una convo de replay),
// para que Render no corte la request. Maneja:
//   - throttle por proveedor (Cerebras free TPM 30K → ~33s entre llamadas)
//   - reintentos con backoff (HTTP error, 5xx, 429)
//   - detección de FALLO DEL JUEZ (flash 429 en ráfaga) → reintenta para no
//     contaminar los scores
//   - guardado parcial + resume (si se cae, retoma donde quedó)
//
// Uso:  node scripts/examen-modelos.js [cerebras|pro|both]   (default: both)
// Resultados: contexto/examen-modelos-2026-06-16/{provider}-{evals,replay}.json

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Monorepo: contexto/ vive en la RAÍZ (apps/api/scripts → 3 niveles arriba).
const ROOT = path.join(__dirname, '../../..')
const OUT_DIR = path.join(ROOT, 'contexto', process.env.EXAMEN_OUT_SUBDIR || 'examen-modelos-2026-06-16')
const BASE = 'https://whatsapp-sales-backend.onrender.com'

// ── Config de proveedores ──────────────────────────────────────────────
// cerebras: throttle duro (TPM 30K free). pro: corre libre en Vertex, pero lo
// paceamos suave para no reventar al JUEZ (2.5-flash) con 429 en ráfaga.
const PROVIDERS = {
  cerebras: {
    key: 'cerebras',
    overrides: { provider: 'cerebras', model: 'gpt-oss-120b' },
    sleepMs: 33000,        // entre requests de eval
    replayPauseMs: 33000,  // pauseMs interno del endpoint (entre turnos)
    betweenConvMs: 33000,  // entre convos de replay
  },
  pro: {
    key: 'pro',
    overrides: { provider: 'gemini', model: 'gemini-2.5-pro' },
    sleepMs: 6000,
    replayPauseMs: 5000,
    betweenConvMs: 6000,
  },
}

// Re-anclado 2026-06-22: las convos de referencia originales [1,9,10,13,14,17,18]
// fueron borradas de conversaciones_archivadas durante los tests de la saga del
// closer (la tabla es efímera: se limpia entre sesiones). Sobrevivían solo IDs
// vivos con turnos LEAD→BOT reales: 23 (palta, 4msgs), 24 (12msgs), 30 (Blanca, 34msgs).
// + GOLD STANDARD de Óscar (id 45, es_test): los 17 turnos del lead escéptico que
//   originó la saga del closer → ancla permanente. Por ser largo (17 turnos) lleva
//   maxTurns/chunkSize propios para no reventar el timeout del endpoint (300s).
// Cada item: { id, maxTurns?, chunkSize? } (default MAX_TURNS / 1).
const REPLAY_CONVS = [
  { id: 23 },
  { id: 24 },
  { id: 30 },
  { id: 45, maxTurns: 18, chunkSize: 3 },  // Óscar gold standard (17 turnos)
]
const MAX_TURNS = 6

const JUDGE_FAIL_FLAGS = new Set(['juez_sin_respuesta', 'juez_json_invalido', 'juez_exception'])

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Lee los IDs de los casos del dataset (robusto: dedupe, preserva orden) ──
function leerEvalIds() {
  const file = fs.readFileSync(path.join(ROOT, 'src', 'brain', 'brain-evals-dataset.js'), 'utf8')
  const ids = []
  const seen = new Set()
  const re = /id:\s*['"](C\d+)['"]/g
  let m
  while ((m = re.exec(file)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]) }
  }
  return ids
}

// ── POST con timeout + reintentos con backoff ──────────────────────────
async function postJSON(url, body, { maxRetries = 5 } = {}) {
  const backoffs = [5000, 15000, 30000, 60000, 90000]
  let lastErr = null
  for (let intento = 0; intento <= maxRetries; intento++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 300000) // 300s (replay puede ~193s)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      if (!res.ok) {
        // 429 (rate limit) o 5xx → reintentar con backoff (más largo si 429)
        const is429 = res.status === 429
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
        if (intento < maxRetries) {
          const wait = is429 ? Math.max(60000, backoffs[Math.min(intento, backoffs.length - 1)]) : backoffs[Math.min(intento, backoffs.length - 1)]
          console.log(`   ⚠️  ${lastErr.message} → backoff ${wait / 1000}s (intento ${intento + 1}/${maxRetries})`)
          await sleep(wait)
          continue
        }
        throw lastErr
      }
      try { return JSON.parse(text) }
      catch (e) { throw new Error(`respuesta no-JSON (posible corte de Render): ${text.slice(0, 120)}`) }
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      if (intento < maxRetries) {
        const wait = backoffs[Math.min(intento, backoffs.length - 1)]
        console.log(`   ⚠️  ${err.message} → backoff ${wait / 1000}s (intento ${intento + 1}/${maxRetries})`)
        await sleep(wait)
        continue
      }
      throw lastErr
    }
  }
  throw lastErr
}

// ¿algún caso/turno volvió con fallo del JUEZ (no del cerebro)? → reintentar
function tieneFalloJuez(items) {
  return items.some(it => {
    const flags = it.red_flags || []
    if (flags.some(f => JUDGE_FAIL_FLAGS.has(f))) return true
    const razon = (it.razon_juez || '').toLowerCase()
    return razon.includes('error del juez') || razon.includes('juez no pudo')
  })
}

// ── Persistencia (resume) ──────────────────────────────────────────────
function cargar(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function guardar(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

// ── Correr EVALS de un proveedor ───────────────────────────────────────
async function correrEvals(prov, evalIds) {
  const file = path.join(OUT_DIR, `${prov.key}-evals.json`)
  const store = cargar(file, { meta: { provider: prov.key, model: prov.overrides.model, startedAt: new Date().toISOString() }, casos: {} })
  const pendientes = evalIds.filter(id => !store.casos[id])
  console.log(`\n[${prov.key}] EVALS: ${pendientes.length} pendientes de ${evalIds.length} (${Object.keys(store.casos).length} ya hechos)`)

  for (let i = 0; i < pendientes.length; i++) {
    const id = pendientes[i]
    let intentosJuez = 0
    let caso = null
    while (intentosJuez < 3) {
      const resp = await postJSON(`${BASE}/debug/brain-evals`, {
        idFilter: [id], overrides: prov.overrides, chunkSize: 1, pauseMs: 0,
      })
      caso = resp.todos_los_casos?.[0] || null
      if (caso && tieneFalloJuez([caso])) {
        intentosJuez++
        console.log(`   ↻ ${id}: fallo del juez (${caso.red_flags?.join(',')}) → reintento ${intentosJuez}/3`)
        await sleep(prov.key === 'cerebras' ? prov.sleepMs : 8000)
        continue
      }
      break
    }
    store.casos[id] = caso
    guardar(file, store)
    const v = caso?.veredicto, s = caso?.score, lat = caso?.latency_ms
    console.log(`   ${id}: ${v} ${s} (${lat}ms) ${caso?.red_flags?.length ? '⚑ ' + caso.red_flags.join(',') : ''}`)
    if (i < pendientes.length - 1) await sleep(prov.sleepMs)
  }
  console.log(`[${prov.key}] EVALS done.`)
}

// ── Correr REPLAY de un proveedor ──────────────────────────────────────
async function correrReplay(prov) {
  const file = path.join(OUT_DIR, `${prov.key}-replay.json`)
  const store = cargar(file, { meta: { provider: prov.key, model: prov.overrides.model, startedAt: new Date().toISOString() }, convs: {} })
  const pendientes = REPLAY_CONVS.filter(c => !store.convs[String(c.id)])
  console.log(`\n[${prov.key}] REPLAY: ${pendientes.length} convos pendientes de ${REPLAY_CONVS.length} (${Object.keys(store.convs).length} ya hechas)`)

  // reconstruirEstado: mide UN modelo con FIDELIDAD (reconstruye nombre+stage del
  // historial → disparan los guardrails deterministas). Inerte en evals; solo el
  // replay lo lee. (peritaje de Óscar: sin esto el nombre salía 14/17 = artefacto.)
  const replayOverrides = { ...prov.overrides, reconstruirEstado: true }

  for (let i = 0; i < pendientes.length; i++) {
    const convId = pendientes[i].id
    const maxTurns = pendientes[i].maxTurns || MAX_TURNS
    const chunkSize = pendientes[i].chunkSize || 1
    let intentosJuez = 0
    let resp = null
    while (intentosJuez < 2) {
      resp = await postJSON(`${BASE}/debug/brain-replay`, {
        convFilter: [convId], maxTurns, overrides: replayOverrides,
        chunkSize, pauseMs: prov.replayPauseMs,
      })
      const turnos = resp.todos || []
      if (tieneFalloJuez(turnos)) {
        intentosJuez++
        console.log(`   ↻ conv ${convId}: fallo del juez en algún turno → reintento ${intentosJuez}/2`)
        await sleep(prov.betweenConvMs)
        continue
      }
      break
    }
    store.convs[String(convId)] = { resumen: resp.resumen, turnos: resp.todos }
    guardar(file, store)
    const r = resp.resumen || {}
    console.log(`   conv ${convId}: ${r.total_turnos}t · PASS ${r.PASS}/PARCIAL ${r.PARCIAL}/FAIL ${r.FAIL} · score ${r.score_promedio} · ${r.latencia_prom_ms}ms · flags ${JSON.stringify(r.red_flags || {})}`)
    if (i < pendientes.length - 1) await sleep(prov.betweenConvMs)
  }
  console.log(`[${prov.key}] REPLAY done.`)
}

async function correrProveedor(prov, evalIds) {
  console.log(`\n══════════ PROVEEDOR: ${prov.key} (${prov.overrides.model}) ══════════`)
  await correrEvals(prov, evalIds)
  await correrReplay(prov)
}

async function main() {
  const arg = (process.argv[2] || 'both').toLowerCase()
  const evalIds = leerEvalIds()
  fs.mkdirSync(OUT_DIR, { recursive: true })   // crea la carpeta fresca si no existe (antes solo escribía)
  console.log(`Dataset: ${evalIds.length} casos de eval. Replay: ${REPLAY_CONVS.length} convos. Out: ${OUT_DIR}`)
  const t0 = Date.now()

  // Cerebras primero (recurso escaso TPD 1M); luego pro (libre en Vertex).
  if (arg === 'cerebras' || arg === 'both') await correrProveedor(PROVIDERS.cerebras, evalIds)
  if (arg === 'pro' || arg === 'both') await correrProveedor(PROVIDERS.pro, evalIds)

  console.log(`\n✅ TERMINADO en ${Math.round((Date.now() - t0) / 60000)} min. Corre el reporte: node scripts/examen-reporte.js`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
