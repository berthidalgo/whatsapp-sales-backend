// tests/llm-cadena.test.js — LA CADENA DE PROVEEDORES DEL CEREBRO
//
// POR QUÉ EXISTE (peritaje 23-sep-2026): el seguro del cerebro llevaba semanas muerto
// (Cerebras 402, el modelo de Groq retirado, la llave de Gemini Dev inválida) y nadie
// lo supo. Estos tests congelan: (1) cómo se arma la cadena desde el entorno, (2) las
// trampas conocidas de cada familia de modelos, (3) que un error de configuración no
// se reintente a ciegas y (4) que el bot pase al seguro en vez de quedar mudo.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsearPaso, normalizarPaso, construirCadena, pasoPrimario, statusDeError,
  esErrorDeConfig, abreCircuito, ejecutarCadena, circuitoAbierto, _resetCadena,
  extraerJsonTexto, resumenSalud, pasoVision, llamarPaso
} from '../src/lib/llm-cadena.js'
import { urlCompat } from '../src/lib/openai-compat.js'
import { parsearJsonCerebro } from '../src/brain/agent-brain.js'

const sinEspera = async () => {}
beforeEach(() => _resetCadena())

// ── Armado ──────────────────────────────────────────────────────────────

test('parsearPaso: proveedor, modelo con "/" y location', () => {
  assert.deepEqual(parsearPaso('groq:openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b', location: null })
  assert.deepEqual(parsearPaso('vertex:gemini-3.5-flash@global'), { provider: 'vertex', model: 'gemini-3.5-flash', location: 'global' })
  assert.deepEqual(parsearPaso('gemini'), { provider: 'vertex', model: null, location: null })
  assert.equal(parsearPaso('  '), null)
})

test('normalizarPaso: Gemini 3 va a location global con thinkingLevel (no budget)', () => {
  const p = normalizarPaso({ provider: 'vertex', model: 'gemini-3.5-flash' })
  assert.equal(p.location, 'global', 'Gemini 3 no existe en us-central1: sin global da 404')
  assert.equal(p.thinkingLevel, 'low')
  assert.equal(p.thinkingBudget, null, 'con presupuesto numérico el 3.x desvaría y corta el JSON')
})

test('normalizarPaso: Gemini 2.x usa thinkingBudget y la región por defecto', () => {
  const p = normalizarPaso({ provider: 'vertex', model: 'gemini-2.5-pro' })
  assert.equal(p.location, null)
  assert.equal(p.thinkingBudget, 1024)
  assert.equal(p.thinkingLevel, null)
})

test('normalizarPaso: gpt-oss lleva reasoning_effort (si no, devuelve JSON vacío)', () => {
  assert.equal(normalizarPaso({ provider: 'groq' }).reasoningEffort, 'low')
  assert.equal(normalizarPaso({ provider: 'groq' }).model, 'openai/gpt-oss-120b', 'llama-3.3-70b ya no existe en Groq')
  assert.equal(normalizarPaso({ provider: 'cerebras' }).reasoningEffort, 'low')
  assert.equal(normalizarPaso({ provider: 'desconocido' }), null)
})

test('pasoPrimario: respeta las perillas históricas BRAIN_*', () => {
  const p = pasoPrimario({ BRAIN_MODEL: 'gemini-2.5-pro' })
  assert.equal(p.id, 'vertex:gemini-2.5-pro')
  assert.equal(p.rol, 'primario')
  const q = pasoPrimario({ BRAIN_MODEL: 'gemini-3.5-flash', BRAIN_LOCATION: 'global', BRAIN_THINKING_LEVEL: 'medium' })
  assert.equal(q.id, 'vertex:gemini-3.5-flash@global')
  assert.equal(q.thinkingLevel, 'medium')
})

test('construirCadena: sin BRAIN_FALLBACKS suma SOLO los seguros que tienen llave', () => {
  const env = { BRAIN_MODEL: 'gemini-2.5-pro', GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'y' }
  const ids = construirCadena(env).map(p => p.id)
  assert.deepEqual(ids, ['vertex:gemini-2.5-pro', 'groq:openai/gpt-oss-120b', 'cerebras:gpt-oss-120b'])
  const conDev = construirCadena({ ...env, GEMINI_DEV_API_KEY: 'z' }).map(p => p.id)
  assert.equal(conDev[1], 'devapi:gemini-3.5-flash', 'la llave de Gemini Developer entra como primer seguro')
})

test('construirCadena: BRAIN_FALLBACKS manda, sin duplicar al primario', () => {
  const env = {
    BRAIN_MODEL: 'gemini-2.5-pro', GROQ_API_KEY: 'x',
    BRAIN_FALLBACKS: 'vertex:gemini-2.5-pro, groq:openai/gpt-oss-120b, cerebras:gpt-oss-120b'
  }
  const ids = construirCadena(env).map(p => p.id)
  assert.deepEqual(ids, ['vertex:gemini-2.5-pro', 'groq:openai/gpt-oss-120b'],
    'el primario no se repite y cerebras sin llave no entra')
})

test('construirCadena: primario no-Gemini → Vertex entra como seguro (fallback simétrico histórico)', () => {
  const ids = construirCadena({ BRAIN_PROVIDER: 'cerebras', CEREBRAS_API_KEY: 'y', BRAIN_MODEL: 'gemini-2.5-flash' }).map(p => p.id)
  assert.deepEqual(ids, ['cerebras:gpt-oss-120b', 'vertex:gemini-2.5-flash'])
})

// ── Proveedores OpenAI-compatibles (sep 2026: ninguno de los 4 originales respondía) ──

test('compat: poner la llave de Mistral u OpenRouter basta para sumar un seguro', () => {
  const env = { BRAIN_PROVIDER: 'devapi', BRAIN_MODEL: 'gemini-3.1-flash-lite', GEMINI_DEV_API_KEY: 'g', MISTRAL_API_KEY: 'm', OPENROUTER_API_KEY: 'o', BRAIN_FALLBACKS: 'mistral,openrouter' }
  assert.deepEqual(construirCadena(env).map(p => p.id),
    ['devapi:gemini-3.1-flash-lite', 'mistral:ministral-14b-latest', 'openrouter:google/gemma-4-31b-it:free'])
  const auto = construirCadena({ BRAIN_MODEL: 'gemini-2.5-pro', DEEPSEEK_API_KEY: 'd' }).map(p => p.id)
  assert.deepEqual(auto, ['vertex:gemini-2.5-pro', 'deepseek:deepseek-flash'], 'sin BRAIN_FALLBACKS entra solo por tener llave')
})

test('compat: primario no-Gemini con su modelo en BRAIN_PROVIDER (el ":free" de OpenRouter no se confunde)', () => {
  const p = pasoPrimario({ BRAIN_PROVIDER: 'openrouter:google/gemma-4-31b-it:free', BRAIN_MODEL: 'gemini-2.5-pro' })
  assert.equal(p.id, 'openrouter:google/gemma-4-31b-it:free')
  assert.equal(p.rol, 'primario')
  assert.equal(pasoPrimario({ BRAIN_PROVIDER: 'mistral' }).model, 'ministral-14b-latest')
  assert.equal(pasoPrimario({ BRAIN_PROVIDER: 'devapi:gemini-3.5-flash-lite' }).id, 'devapi:gemini-3.5-flash-lite')
})

test('compat: el genérico necesita URL y modelo; sin eso no entra a la cadena', () => {
  assert.equal(normalizarPaso({ provider: 'compat' }, {}), null, 'sin modelo no hay a quién llamar')
  const env = { OPENAI_COMPAT_BASE_URL: 'https://api.together.xyz/v1', OPENAI_COMPAT_MODEL: 'Qwen/Qwen3-32B' }
  const ids = construirCadena({ ...env, BRAIN_PROVIDER: 'devapi', GEMINI_DEV_API_KEY: 'g', BRAIN_FALLBACKS: 'compat' }).map(p => p.id)
  assert.deepEqual(ids, ['devapi:gemini-2.5-flash', 'compat:Qwen/Qwen3-32B'])
  assert.deepEqual(construirCadena({ BRAIN_PROVIDER: 'devapi', GEMINI_DEV_API_KEY: 'g', BRAIN_FALLBACKS: 'compat' }).map(p => p.id), ['devapi:gemini-2.5-flash'])
})

test('compat: urlCompat arma /chat/completions desde la base del genérico', () => {
  assert.equal(urlCompat('compat', { OPENAI_COMPAT_BASE_URL: 'http://localhost:11434/v1/' }), 'http://localhost:11434/v1/chat/completions')
  assert.equal(urlCompat('mistral', {}), 'https://api.mistral.ai/v1/chat/completions')
  assert.equal(urlCompat('compat', {}), null)
})

test('compat: el cliente manda el JSON mode y el razonamiento con el dialecto de cada proveedor', async () => {
  const fetchOriginal = globalThis.fetch
  const cuerpos = []
  globalThis.fetch = async (url, opts) => {
    cuerpos.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
    return { ok: true, json: async () => ({ model: 'x', choices: [{ message: { content: '{"mensaje":"hola"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) }
  }
  try {
    const env = { OPENROUTER_API_KEY: 'o', NVIDIA_API_KEY: 'n' }
    const r = await llamarPaso(normalizarPaso({ provider: 'openrouter', model: 'openai/gpt-oss-120b:free' }, env), { systemInstruction: 's', userPrompt: 'u', env })
    assert.equal(r.text, '{"mensaje":"hola"}')
    assert.equal(r.usage.promptTokenCount, 10)
    assert.deepEqual(cuerpos[0].body.reasoning, { effort: 'low' }, 'OpenRouter usa su campo "reasoning"')
    assert.deepEqual(cuerpos[0].body.response_format, { type: 'json_object' })
    assert.equal(cuerpos[0].headers.Authorization, 'Bearer o')
    await llamarPaso(normalizarPaso({ provider: 'nvidia' }, env), { systemInstruction: 's', userPrompt: 'u', env })
    assert.equal(cuerpos[1].body.reasoning_effort, 'low')
    assert.equal(cuerpos[1].body.response_format, undefined, 'NIM: el JSON lo rescata el parser')
  } finally {
    globalThis.fetch = fetchOriginal
  }
})

test('compat: un 402 de OpenRouter se entiende como error de plan (abre circuito)', async () => {
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient credits' } }) })
  try {
    const env = { OPENROUTER_API_KEY: 'o' }
    await assert.rejects(
      llamarPaso(normalizarPaso({ provider: 'openrouter' }, env), { systemInstruction: 's', userPrompt: 'u', env }),
      (e) => statusDeError(e) === 402 && abreCircuito(e)
    )
    assert.equal(statusDeError(new Error('mistral_401: {"message":"Unauthorized"}')), 401)
  } finally {
    globalThis.fetch = fetchOriginal
  }
})

test('pasoVision: el primer Gemini de la cadena (el único multimodal)', () => {
  const p = pasoVision({ BRAIN_PROVIDER: 'groq', GROQ_API_KEY: 'x', BRAIN_MODEL: 'gemini-3.5-flash' })
  assert.equal(p.provider, 'vertex')
  assert.equal(p.location, 'global')
})

// ── Errores ─────────────────────────────────────────────────────────────

test('statusDeError: entiende los 3 clientes', () => {
  assert.equal(statusDeError({ status: 401 }), 401)
  assert.equal(statusDeError(new Error('cerebras_402: {"message":"Payment required"}')), 402)
  assert.equal(statusDeError(new Error('groq_413: {"message":"Request too large"}')), 413)
  assert.equal(statusDeError(new Error('{"error":{"code":404,"message":"model not found"}}')), 404)
  assert.equal(statusDeError(new Error('fetch failed')), null)
})

test('clasificación: config/plan no se reintenta; 400 no abre circuito; 429/5xx sí se reintentan', () => {
  for (const s of [401, 402, 403, 404, 413]) {
    assert.ok(esErrorDeConfig({ status: s }) && abreCircuito({ status: s }), `HTTP ${s}`)
  }
  assert.ok(esErrorDeConfig({ status: 400 }) && !abreCircuito({ status: 400 }), 'un 400 puede ser de ESTE prompt: no apaga el proveedor para todos')
  for (const s of [429, 500, 503]) assert.ok(!esErrorDeConfig({ status: s }), `HTTP ${s} es transitorio`)
})

// ── Ejecución ───────────────────────────────────────────────────────────

const cadena = [
  normalizarPaso({ provider: 'vertex', model: 'gemini-2.5-pro', rol: 'primario' }),
  normalizarPaso({ provider: 'groq' })
]

test('ejecutarCadena: primario con 402 → NO reintenta, abre circuito y responde el seguro', async () => {
  const llamadas = []
  const r = await ejecutarCadena({
    cadena, esperar: sinEspera,
    llamar: async (p) => {
      llamadas.push(p.id)
      if (p.provider === 'vertex') throw Object.assign(new Error('pago requerido'), { status: 402 })
      return { text: '{"mensaje":"hola"}' }
    },
    parsear: (t) => JSON.parse(t)
  })
  assert.deepEqual(llamadas, ['vertex:gemini-2.5-pro', 'groq:openai/gpt-oss-120b'], 'un 402 no se reintenta 3 veces')
  assert.equal(r.indice, 1)
  assert.equal(r.parsed.mensaje, 'hola')
  assert.ok(circuitoAbierto('vertex:gemini-2.5-pro'))
})

test('ejecutarCadena: con el circuito abierto el paso se salta en el turno siguiente', async () => {
  await ejecutarCadena({
    cadena, esperar: sinEspera, parsear: (t) => JSON.parse(t),
    llamar: async (p) => { if (p.provider === 'vertex') throw Object.assign(new Error('x'), { status: 404 }); return { text: '{"mensaje":"a"}' } }
  })
  const llamadas = []
  await ejecutarCadena({
    cadena, esperar: sinEspera, parsear: (t) => JSON.parse(t),
    llamar: async (p) => { llamadas.push(p.id); return { text: '{"mensaje":"b"}' } }
  })
  assert.deepEqual(llamadas, ['groq:openai/gpt-oss-120b'])
})

test('ejecutarCadena: error transitorio o JSON roto → reintenta el MISMO paso', async () => {
  let n = 0
  const r = await ejecutarCadena({
    cadena, esperar: sinEspera, parsear: parsearJsonCerebro,
    llamar: async () => {
      n++
      if (n === 1) throw Object.assign(new Error('rate'), { status: 429 })
      if (n === 2) return { text: '{"mensaje": "cortad' }
      return { text: '{"mensaje":"ok al tercero"}' }
    }
  })
  assert.equal(n, 3)
  assert.equal(r.indice, 0, 'respondió el primario, sin gastar el seguro')
  assert.equal(r.parsed.mensaje, 'ok al tercero')
})

test('ejecutarCadena: todos caídos → parsed null con el detalle de cada error (nunca lanza)', async () => {
  const r = await ejecutarCadena({
    cadena, esperar: sinEspera, parsear: (t) => JSON.parse(t),
    llamar: async (p) => { throw Object.assign(new Error('caído'), { status: 503 }) }
  })
  assert.equal(r.parsed, null)
  assert.equal(r.errores.length, 5, '3 intentos del primario + 2 del seguro')
})

test('resumenSalud: sin datos dice "sin_verificar"; con el primario fallando, "degradado"', async () => {
  const env = { BRAIN_MODEL: 'gemini-2.5-pro', GROQ_API_KEY: 'x' }
  assert.equal(resumenSalud(env).estado, 'sin_verificar')
  await ejecutarCadena({
    cadena: construirCadena(env), esperar: sinEspera, parsear: (t) => JSON.parse(t),
    llamar: async (p) => { if (p.provider === 'vertex') throw Object.assign(new Error('x'), { status: 401 }); return { text: '{"mensaje":"a"}' } }
  })
  const r = resumenSalud(env)
  assert.equal(r.estado, 'degradado')
  assert.equal(r.vivos, 1)
})

// ── Parseo ──────────────────────────────────────────────────────────────

test('parsearJsonCerebro: exige un "mensaje" de texto (basura de un modelo de razonamiento NO es respuesta)', () => {
  assert.equal(parsearJsonCerebro('{"type":"object"}'), null, 'visto en vivo con gpt-oss sin presupuesto')
  assert.equal(parsearJsonCerebro('{"mensaje":"   "}'), null)
  assert.equal(parsearJsonCerebro('```json\n{"mensaje":"hola","stage_sugerido":"discovery"}\n```').mensaje, 'hola')
  assert.equal(parsearJsonCerebro('texto antes {"mensaje":"rescatado"} y después').mensaje, 'rescatado')
  assert.equal(parsearJsonCerebro(''), null)
})

test('extraerJsonTexto: devuelve el JSON limpio o null', () => {
  assert.equal(extraerJsonTexto('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extraerJsonTexto('ok: {"a":2}'), '{"a":2}')
  assert.equal(extraerJsonTexto('sin json'), null)
})
