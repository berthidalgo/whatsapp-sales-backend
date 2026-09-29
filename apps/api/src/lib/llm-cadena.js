// src/lib/llm-cadena.js — LA CADENA DE PROVEEDORES DEL CEREBRO (sep 2026)
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE (peritaje del 23-sep-2026):
//   El cerebro tenía UN primario y UN seguro, cableados en agent-brain.js:
//     Gemini (Vertex)  →  Cerebras gpt-oss-120b
//   Cuando se auditó, el seguro estaba MUERTO sin que nadie se enterara:
//     · Cerebras respondía 402 (el plan gratis pasó a exigir pago).
//     · Groq —que el dueño creía que era el seguro— ni siquiera estaba en la
//       cadena, y su modelo (llama-3.3-70b) ya no existía.
//     · La llave de Gemini Developer API daba 401.
//   O sea: si Vertex fallaba, el bot quedaba MUDO. Y Vertex corre gemini-2.5-pro,
//   que Google retira en octubre de 2026.
//
// QUÉ HACE:
//   1. La cadena se ARMA POR ENTORNO, sin tocar código:
//        BRAIN_PROVIDER / BRAIN_MODEL / BRAIN_LOCATION / BRAIN_THINKING_LEVEL → primario
//        BRAIN_FALLBACKS="devapi:gemini-3.5-flash,groq:openai/gpt-oss-120b"   → seguros
//      Sin BRAIN_FALLBACKS se arma sola con los proveedores que tengan llave.
//   2. Clasifica cada error: un 401/402/404/413 NO se reintenta (es de configuración
//      o de plan, reintentar solo suma latencia) y ABRE EL CIRCUITO de ese paso por
//      10 min; un 429/5xx/timeout/JSON roto sí se reintenta.
//   3. Guarda el ÚLTIMO ESTADO de cada paso (llamadas reales + pings) → /health y
//      /debug/brain-health dicen la verdad en vez de suponerla.
//
// Contrato de cada paso: { id, provider, model, location, thinkingLevel,
//   thinkingBudget, reasoningEffort, rol }. provider ∈ vertex | devapi | groq | cerebras
//   | mistral | openrouter | deepseek | nvidia | compat (los 5 últimos: openai-compat.js).
// ─────────────────────────────────────────────────────────────────────────

import { callGemini } from './gemini.js'
import { callGroq, schemaToPrompt } from './groq.js'
import { callCerebras } from './cerebras.js'
import { callCompat, esProveedorCompat, compatConfigurado, modeloCompatDefault } from './openai-compat.js'

const THINKING_BUDGET_2X = 1024          // tope de pensamiento para los Gemini 2.x
const MAX_OUT_GEMINI = 8000              // el thinking consume del MISMO presupuesto
const MAX_OUT_OPENAI_COMPAT = 3072       // gpt-oss con reasoning 'low' + el JSON del cerebro
const CIRCUITO_MS = 10 * 60 * 1000       // cuánto se aparta un paso con error de config/plan

// Modelo por defecto de cada proveedor cuando la config solo nombra el proveedor.
const MODELO_DEFAULT = {
  vertex: 'gemini-3.5-flash',
  devapi: 'gemini-3.5-flash',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'gpt-oss-120b'
}

const ALIAS = { gemini: 'vertex', 'gemini-dev': 'devapi', google: 'vertex', 'openai-compat': 'compat' }

/** Modelo por defecto del proveedor (los OpenAI-compatibles lo leen de su preset). */
function modeloDefault(provider, env) {
  return MODELO_DEFAULT[provider] || (esProveedorCompat(provider) ? modeloCompatDefault(provider, env) : null)
}

function proveedorConocido(provider) {
  return !!MODELO_DEFAULT[provider] || esProveedorCompat(provider)
}

// ════════════════════════════════════════════════════════
// ARMADO DE LA CADENA (funciones puras sobre `env` → testeables)
// ════════════════════════════════════════════════════════

/** "groq:openai/gpt-oss-120b" · "vertex:gemini-3.5-flash@global" · "devapi" → paso crudo. */
export function parsearPaso(txt) {
  const s = String(txt || '').trim()
  if (!s) return null
  const i = s.indexOf(':')
  const provider = (i === -1 ? s : s.slice(0, i)).trim().toLowerCase()
  let resto = i === -1 ? '' : s.slice(i + 1).trim()
  let location = null
  const at = resto.lastIndexOf('@')
  if (at !== -1) { location = resto.slice(at + 1).trim() || null; resto = resto.slice(0, at).trim() }
  return { provider: ALIAS[provider] || provider, model: resto || null, location }
}

/**
 * Completa un paso con los defaults correctos de su familia de modelo. Aquí viven
 * las trampas conocidas para que nadie las vuelva a pisar:
 *   · Gemini 3.x vive SOLO en la location 'global' de Vertex (las regionales dan 404)
 *     y usa thinkingLevel; con presupuesto numérico desvaría y corta el JSON.
 *   · Gemini 2.x usa thinkingBudget.
 *   · gpt-oss necesita reasoning_effort o se come la respuesta razonando.
 */
export function normalizarPaso(paso, env = process.env) {
  if (!paso?.provider) return null
  const provider = ALIAS[paso.provider] || paso.provider
  if (!proveedorConocido(provider)) return null
  const model = paso.model || modeloDefault(provider, env)
  if (!model) return null   // "compat" sin modelo: no hay a quién llamar
  const esGemini = provider === 'vertex' || provider === 'devapi'
  const esGemini3 = /^gemini-3/.test(model)

  let location = null
  if (provider === 'vertex') location = paso.location || (esGemini3 ? 'global' : null)

  let thinkingLevel = null
  let thinkingBudget = null
  if (esGemini) {
    thinkingLevel = paso.thinkingLevel || (esGemini3 ? 'low' : null)
    thinkingBudget = thinkingLevel ? null : (paso.thinkingBudget ?? THINKING_BUDGET_2X)
  }
  const reasoningEffort = !esGemini && /gpt-oss/.test(model) ? (paso.reasoningEffort || 'low') : null

  return {
    id: `${provider}:${model}${location ? '@' + location : ''}`,
    provider, model, location, thinkingLevel, thinkingBudget, reasoningEffort,
    rol: paso.rol || 'seguro'
  }
}

/** ¿Hay con qué autenticar este paso? Vertex usa ADC (service account): no se puede saber sin llamar. */
export function pasoConfigurado(paso, env = process.env) {
  if (!paso) return false
  if (paso.provider === 'vertex') return true
  if (paso.provider === 'devapi') return !!env.GEMINI_DEV_API_KEY
  if (paso.provider === 'groq') return !!env.GROQ_API_KEY
  if (paso.provider === 'cerebras') return !!env.CEREBRAS_API_KEY
  if (esProveedorCompat(paso.provider)) return compatConfigurado(paso.provider, env)
  return false
}

/**
 * El primario, respetando las perillas históricas (BRAIN_PROVIDER + BRAIN_MODEL...).
 * BRAIN_MODEL es SIEMPRE de Gemini (también nombra al Vertex de seguro cuando el
 * primario es otro); un primario no-Gemini lleva su modelo en BRAIN_PROVIDER:
 *   BRAIN_PROVIDER=mistral:mistral-small-latest · BRAIN_PROVIDER=openrouter:google/gemma-4-31b-it:free
 */
export function pasoPrimario(env = process.env) {
  const pedido = parsearPaso(env.BRAIN_PROVIDER || 'gemini') || { provider: 'vertex', model: null }
  const provider = pedido.provider
  const esGemini = provider === 'vertex' || provider === 'devapi'
  return normalizarPaso({
    provider,
    model: esGemini ? (pedido.model || env.BRAIN_MODEL || 'gemini-2.5-flash') : pedido.model,
    location: esGemini ? (pedido.location || env.BRAIN_LOCATION || null) : null,
    thinkingLevel: esGemini ? (env.BRAIN_THINKING_LEVEL || null) : null,
    rol: 'primario'
  }, env)
}

/**
 * La cadena viva: primario + seguros, sin duplicados y sin pasos sin llave.
 * Sin BRAIN_FALLBACKS: Vertex (si el primario no lo es) → Gemini Developer API →
 * Groq → Cerebras → Mistral → OpenRouter → DeepSeek → NVIDIA → compat, cada uno solo
 * si tiene llave. Así, poner una llave en Render basta para sumar un seguro.
 */
export function construirCadena(env = process.env) {
  const primario = pasoPrimario(env)
  const crudos = (env.BRAIN_FALLBACKS || '').trim()
    ? env.BRAIN_FALLBACKS.split(',').map(parsearPaso)
    : [
        primario?.provider !== 'vertex' ? { provider: 'vertex', model: env.BRAIN_MODEL || null, location: env.BRAIN_LOCATION || null } : null,
        { provider: 'devapi', model: null },
        { provider: 'groq', model: null },
        { provider: 'cerebras', model: null },
        { provider: 'mistral', model: null },
        { provider: 'openrouter', model: null },
        { provider: 'deepseek', model: null },
        { provider: 'nvidia', model: null },
        { provider: 'compat', model: null }
      ]
  const cadena = primario ? [primario] : []
  for (const c of crudos) {
    const p = normalizarPaso(c, env)
    if (!p || !pasoConfigurado(p, env)) continue
    if (cadena.some(x => x.id === p.id)) continue
    cadena.push(p)
  }
  return cadena
}

// ════════════════════════════════════════════════════════
// CLASIFICACIÓN DE ERRORES + CIRCUIT BREAKER
// ════════════════════════════════════════════════════════

/** Extrae el HTTP status de los errores de los 3 SDK/clientes (Gemini SDK, groq_413, cerebras_402...). */
export function statusDeError(err) {
  if (!err) return null
  if (Number.isInteger(err.status)) return err.status
  if (Number.isInteger(err.code) && err.code >= 100 && err.code < 600) return err.code
  const msg = String(err.message || err)
  const m = msg.match(/\b(?:groq|cerebras|mistral|openrouter|deepseek|nvidia|compat)_(\d{3})\b/) || msg.match(/"code"\s*:\s*(\d{3})/) || msg.match(/\bstatus(?:Code)?\s*[:=]?\s*(\d{3})\b/i)
  return m ? Number(m[1]) : null
}

/**
 * ¿Reintentar sirve de algo? No, si el error es de CONFIGURACIÓN o de PLAN: llave
 * inválida (401/403), sin pago (402), modelo inexistente o retirado (404), prompt más
 * grande que el cupo del plan (413). Eso no se arregla en 1,2 segundos; se abre el
 * circuito y se pasa al siguiente proveedor.
 */
export function esErrorDeConfig(err) {
  const s = statusDeError(err)
  return s === 400 || s === 401 || s === 402 || s === 403 || s === 404 || s === 413
}

/**
 * ¿Apartar el paso para TODOS los turnos (circuito)? Solo si el error es sistémico.
 * Un 400 puede ser propio de ESTE prompt: se salta el paso en este turno, sin apagarlo
 * para el resto de leads.
 */
export function abreCircuito(err) {
  const s = statusDeError(err)
  return s === 401 || s === 402 || s === 403 || s === 404 || s === 413
}

const circuitos = new Map()   // id → { hasta, motivo }
const estados = new Map()     // id → { ok, at, latencyMs, error, origen }

export function circuitoAbierto(id, ahora = Date.now()) {
  const c = circuitos.get(id)
  if (!c) return false
  if (ahora > c.hasta) { circuitos.delete(id); return false }
  return true
}

function abrirCircuito(id, motivo) {
  circuitos.set(id, { hasta: Date.now() + CIRCUITO_MS, motivo })
}

function registrarEstado(id, estado) {
  estados.set(id, { ...estado, at: new Date().toISOString() })
}

/** Solo para tests. */
export function _resetCadena() { circuitos.clear(); estados.clear() }

// ════════════════════════════════════════════════════════
// LLAMADA A UN PASO
// ════════════════════════════════════════════════════════

/**
 * Llama a UN paso con el prompt del cerebro. Devuelve { text, usage, latencyMs, model }
 * (contrato común de los 3 clientes) o lanza.
 */
export async function llamarPaso(paso, { systemInstruction, userPrompt, schema = null, temperature = 0.6, tenantId, jsonMode = true, env = process.env }) {
  if (paso.provider === 'vertex' || paso.provider === 'devapi') {
    return callGemini({
      model: paso.model,
      systemInstruction,
      contents: userPrompt,
      temperature,
      maxOutputTokens: MAX_OUT_GEMINI,
      thinkingBudget: paso.thinkingBudget,
      thinkingLevel: paso.thinkingLevel,
      responseSchema: schema,
      location: paso.location,
      apiKey: paso.provider === 'devapi' ? (env.GEMINI_DEV_API_KEY || null) : null,
      tenantId
    })
  }
  // OpenAI-compatibles: sin responseSchema nativo → el schema va descrito en el prompt.
  const sys = schema ? `${systemInstruction}\n\n${schemaToPrompt(schema)}` : systemInstruction
  if (esProveedorCompat(paso.provider)) {
    return callCompat({
      provider: paso.provider,
      model: paso.model,
      systemInstruction: sys,
      contents: userPrompt,
      temperature,
      maxOutputTokens: MAX_OUT_OPENAI_COMPAT,
      reasoningEffort: paso.reasoningEffort,
      jsonMode,
      env
    })
  }
  const fn = paso.provider === 'groq' ? callGroq : callCerebras
  return fn({
    model: paso.model,
    systemInstruction: sys,
    contents: userPrompt,
    temperature,
    maxOutputTokens: MAX_OUT_OPENAI_COMPAT,
    reasoningEffort: paso.reasoningEffort,
    jsonMode
  })
}

// ════════════════════════════════════════════════════════
// EJECUCIÓN DE LA CADENA
// ════════════════════════════════════════════════════════

/**
 * Recorre la cadena hasta obtener una respuesta PARSEABLE.
 *
 * @param {object} args
 * @param {Array}    args.cadena
 * @param {Function} args.llamar   - async (paso) => result  ({ text, ... })
 * @param {Function} args.parsear  - (text) => objeto | null (null = JSON inusable → reintentar)
 * @param {number}   [args.intentosPrimario=3]
 * @param {number}   [args.intentosSeguro=2]
 * @param {Function} [args.esperar] - inyectable para tests
 * @returns {Promise<{ parsed, result, paso, indice, errores, ultimoTexto }>}
 */
export async function ejecutarCadena({
  cadena, llamar, parsear,
  intentosPrimario = 3, intentosSeguro = 2,
  esperar = (ms) => new Promise(r => setTimeout(r, ms))
}) {
  const errores = []
  let ultimoTexto = null

  for (let indice = 0; indice < cadena.length; indice++) {
    const paso = cadena[indice]
    if (circuitoAbierto(paso.id)) {
      errores.push({ paso: paso.id, error: `circuito abierto (${circuitos.get(paso.id)?.motivo})` })
      continue
    }
    const intentos = indice === 0 ? intentosPrimario : intentosSeguro
    for (let intento = 0; intento < intentos; intento++) {
      const t0 = Date.now()
      let result
      try {
        result = await llamar(paso)
      } catch (err) {
        const status = statusDeError(err)
        const msg = String(err?.message || err).slice(0, 240)
        errores.push({ paso: paso.id, intento: intento + 1, status, error: msg })
        registrarEstado(paso.id, { ok: false, latencyMs: Date.now() - t0, error: status ? `HTTP ${status}` : msg.slice(0, 80), origen: 'turno' })
        if (esErrorDeConfig(err)) {
          if (abreCircuito(err)) abrirCircuito(paso.id, `HTTP ${status}`)
          console.warn(`[LLM] ⛔ ${paso.id} → HTTP ${status}: no se reintenta${abreCircuito(err) ? ', circuito abierto 10 min' : ''} (${msg.slice(0, 120)})`)
          break
        }
        if (intento < intentos - 1) await esperar(1200)
        continue
      }

      const texto = result?.text
      if (!texto) {
        const fr = result?.response?.candidates?.[0]?.finishReason || 'desconocido'
        errores.push({ paso: paso.id, intento: intento + 1, error: `sin texto (finishReason=${fr})` })
        registrarEstado(paso.id, { ok: false, latencyMs: Date.now() - t0, error: `sin texto (${fr})`, origen: 'turno' })
        if (intento < intentos - 1) await esperar(1200)
        continue
      }

      ultimoTexto = texto
      const parsed = parsear(texto)
      if (parsed) {
        registrarEstado(paso.id, { ok: true, latencyMs: result?.latencyMs ?? (Date.now() - t0), error: null, origen: 'turno' })
        if (indice > 0) console.warn(`[LLM] 🛟 respondió el seguro #${indice} (${paso.id}) — el primario falló: ${errores.map(e => `${e.paso} ${e.status || e.error}`).join(' | ').slice(0, 300)}`)
        return { parsed, result, paso, indice, errores, ultimoTexto }
      }
      errores.push({ paso: paso.id, intento: intento + 1, error: 'JSON inválido' })
      console.warn(`[LLM] JSON roto de ${paso.id} (intento ${intento + 1}), reintentando…`)
      if (intento < intentos - 1) await esperar(1200)
    }
  }

  return { parsed: null, result: null, paso: null, indice: -1, errores, ultimoTexto }
}

// ════════════════════════════════════════════════════════
// AGENTES SECUNDARIOS (copiloto de flujos, debrief de llamadas)
// ════════════════════════════════════════════════════════

/** Devuelve el JSON limpio (string) si el texto trae un objeto JSON parseable, o null. */
export function extraerJsonTexto(texto) {
  if (!texto || typeof texto !== 'string') return null
  const limpio = texto.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  try { JSON.parse(limpio); return limpio } catch (_) { /* sigue */ }
  const m = texto.match(/\{[\s\S]*\}/)
  if (m) { try { JSON.parse(m[0]); return m[0] } catch (_) { /* irrescatable */ } }
  return null
}

/**
 * Completa un prompt que pide JSON usando la MISMA cadena del cerebro. Antes el
 * copiloto y el debrief llamaban a Cerebras directo (402) con un fallback a un modelo
 * de Groq que ya no existe: los dos estaban muertos. Devuelve el JSON como texto
 * limpio (el parser de cada agente lo interpreta). Lanza si nadie respondió.
 */
export async function completarJsonConCadena({ systemInstruction, userPrompt, temperature = 0.4, env = process.env }) {
  const cadena = construirCadena(env)
  const r = await ejecutarCadena({
    cadena,
    llamar: (paso) => llamarPaso(paso, { systemInstruction, userPrompt, schema: null, temperature, env }),
    parsear: extraerJsonTexto,
    intentosPrimario: 2,
    intentosSeguro: 1
  })
  if (!r.parsed) {
    const e = new Error(`ningún proveedor LLM respondió (${r.errores.map(x => `${x.paso} ${x.status || x.error}`).join(' | ').slice(0, 300)})`)
    e.errores = r.errores
    throw e
  }
  return { text: r.parsed, latencyMs: r.result?.latencyMs ?? null, usage: r.result?.usage ?? null, proveedor: r.paso?.id }
}

// ════════════════════════════════════════════════════════
// SALUD — ping mínimo a cada paso (texto plano, sin modo JSON)
// ════════════════════════════════════════════════════════
//
// Mide "¿el proveedor está VIVO y autenticado?". NO mide si aguanta el prompt real
// del cerebro (~9-11K tokens): eso lo revela el primer turno real (un 413 de un plan
// gratis abre el circuito y queda registrado en el estado). Por eso el estado de cada
// paso se alimenta de las DOS fuentes: pings y turnos reales.

export async function pingPaso(paso, env = process.env) {
  const t0 = Date.now()
  try {
    const r = await llamarPaso(paso, {
      systemInstruction: null,
      userPrompt: 'Responde solo con la palabra: OK',
      schema: null,
      temperature: 0,
      jsonMode: false,   // Groq rechaza json_object si el prompt no menciona "json"
      env
    })
    const ok = !!(r?.text && r.text.trim())
    const estado = { ok, latencyMs: Date.now() - t0, error: ok ? null : 'respuesta vacía', origen: 'ping' }
    registrarEstado(paso.id, estado)
    return { id: paso.id, rol: paso.rol, ...estado }
  } catch (err) {
    const status = statusDeError(err)
    const estado = { ok: false, latencyMs: Date.now() - t0, error: status ? `HTTP ${status}: ${String(err.message).slice(0, 120)}` : String(err.message).slice(0, 160), origen: 'ping' }
    registrarEstado(paso.id, estado)
    if (abreCircuito(err)) abrirCircuito(paso.id, `HTTP ${status}`)
    return { id: paso.id, rol: paso.rol, ...estado }
  }
}

/** Pinguea toda la cadena en paralelo. overall: ok (primario vivo) · degraded · down. */
export async function verificarCadena(env = process.env) {
  const cadena = construirCadena(env)
  const pasos = await Promise.all(cadena.map(p => pingPaso(p, env)))
  const primarioOk = pasos[0]?.ok === true
  const vivos = pasos.filter(p => p.ok).length
  return {
    overall: primarioOk ? 'ok' : vivos ? 'degraded' : 'down',
    vivos, total: pasos.length, checkedAt: new Date().toISOString(), pasos
  }
}

/**
 * Resumen para /health (público): solo conteos y estado, NUNCA llaves ni errores
 * crudos (pueden traer el id de organización del proveedor).
 */
export function resumenSalud(env = process.env) {
  const cadena = construirCadena(env)
  const pasos = cadena.map(p => ({ paso: p, e: estados.get(p.id) }))
  const conDato = pasos.filter(x => x.e)
  if (!conDato.length) return { estado: 'sin_verificar', seguros: cadena.length - 1 }
  const vivo = (x) => x.e?.ok === true && !circuitoAbierto(x.paso.id)
  const primarioOk = vivo(pasos[0])
  const vivos = pasos.filter(vivo).length
  return {
    estado: primarioOk ? 'ok' : vivos ? 'degradado' : 'caido',
    vivos, total: cadena.length,
    verificadoEn: conDato.map(x => x.e.at).sort().pop()
  }
}

/** Estado detallado (para /debug/brain-health, que va con JWT de ADMIN). */
export function estadoDetallado(env = process.env) {
  return construirCadena(env).map(p => ({
    id: p.id, rol: p.rol,
    circuitoAbierto: circuitoAbierto(p.id),
    ultimo: estados.get(p.id) || null
  }))
}

/**
 * Paso para VISIÓN (leer comprobantes, describir fotos): el primer Gemini de la cadena,
 * porque es el único multimodal. Hereda location/thinking correctos de normalizarPaso
 * (antes vision.js leía BRAIN_MODEL a mano y no sabía que Gemini 3 exige 'global').
 */
export function pasoVision(env = process.env) {
  return construirCadena(env).find(p => p.provider === 'vertex' || p.provider === 'devapi')
    || normalizarPaso({ provider: 'vertex', model: env.BRAIN_MODEL || null, location: env.BRAIN_LOCATION || null }, env)
}

export function describirCadena(cadena) {
  return cadena.map((p, i) => `${i === 0 ? 'primario' : 'seguro' + i}=${p.id}`).join(' → ')
}

export const LLM_CADENA_VERSION = 'v2_cadena_con_openai_compat'
