// src/brain/flow-copilot.js — Flow Builder Hito D: COPILOTO de flujos.
// Un meta-agente (DISTINTO del agente de ventas Jhon) que ayuda al supervisor a diseñar
// el flujo CONVERSANDO (texto o voz). Conoce los principios del cerebro → asesora dentro
// de los guardrails: si el supervisor pide algo que rompe la calibración (rogar, inventar
// precio, prometer resultados), lo ADVIERTE y propone una alternativa que sí funciona.
// Usa Cerebras (gpt-oss-120b) → verificable local con CEREBRAS_API_KEY.
import { callCerebras } from '../lib/cerebras.js'

const COPILOT_MODEL = process.env.FLOW_COPILOT_MODEL || 'gpt-oss-120b'

// ── Helpers PUROS (testables sin LLM) ───────────────────────────────────────

// Parsea la salida del copiloto. jsonMode fuerza JSON; igual toleramos basura.
export function parsearCopiloto(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text
    return {
      respuesta: typeof j?.respuesta === 'string' ? j.respuesta : '',
      edits: (j?.edits && typeof j.edits === 'object') ? j.edits : {},
      aviso: (typeof j?.aviso === 'string' && j.aviso.trim()) ? j.aviso.trim() : null,
    }
  } catch {
    return { respuesta: typeof text === 'string' ? text.slice(0, 1000) : '', edits: {}, aviso: null }
  }
}

// SEGURIDAD: filtra las ediciones propuestas → solo nodos que EXISTEN en el flujo, solo
// guidance/label, con tope de tamaño. Un LLM podría alucinar ids o texto gigante; acá lo
// cortamos antes de que llegue al config del cerebro.
export function filtrarEdits(edits, flow) {
  const out = {}
  if (!edits || typeof edits !== 'object' || !flow?.nodes) return out
  const validos = new Set(flow.nodes.map(n => n.id))
  for (const [id, e] of Object.entries(edits)) {
    if (!validos.has(id) || !e || typeof e !== 'object') continue
    const clean = {}
    if (typeof e.guidance === 'string' && e.guidance.trim()) clean.guidance = e.guidance.trim().slice(0, 1500)
    if (typeof e.label === 'string' && e.label.trim()) clean.label = e.label.trim().slice(0, 120)
    if (Object.keys(clean).length) out[id] = clean
  }
  return out
}

// El prompt experto: le da al copiloto el flujo actual + los principios del cerebro.
function construirPromptCopiloto(flow, campaignNombre) {
  const momentos = (flow?.nodes || [])
    .map(n => `- ${n.momento} · id="${n.id}" · "${n.label}": ${n.guidance}`)
    .join('\n')
  return `Eres el COPILOTO DE FLUJOS de Hidata, un asistente experto que ayuda a un SUPERVISOR a diseñar el flujo de su agente de ventas de WhatsApp (un bot consultivo llamado "Jhon"). El supervisor te habla en lenguaje natural (por texto o voz) y tú lo ayudas a afinar la GUÍA de cada momento del flujo.

NO eres el vendedor. Eres su asesor: traduces lo que quiere a ediciones concretas de la guía de los momentos, Y le das recomendaciones porque CONOCES cómo trabaja el cerebro.

PROGRAMA: ${campaignNombre || 'sin nombre'}

EL FLUJO ACTUAL (los momentos del agente y su guía vigente):
${momentos}

PRINCIPIOS DEL CEREBRO (NO se pueden romper — si el supervisor pide algo que choca con esto, ADVIÉRTELO en "aviso" y propón una alternativa que SÍ funcione):
1. El bot NO ruega ni presiona; conduce con calidez hacia la cita (la venta la cierra el humano en la llamada).
2. Una pregunta a la vez (de M2 en adelante). Nada de interrogatorios.
3. Del M4 en adelante, cada mensaje acerca la cita, pero con ángulo nuevo (anti-disco-rayado), nunca calcado.
4. NUNCA inventar precio, fechas, módulos ni descuentos (solo lo que está en la ficha del programa).
5. NUNCA prometer resultados ("vas a vender seguro", "lo recuperas") ni dar números de cuenta.
6. Lenguaje peruano natural, mensajes cortos de WhatsApp, sin markdown.

TU TAREA cuando el supervisor te pide un cambio:
- Si es bueno: propón la edición de la guía del momento que corresponde (usa el id exacto, ej "presenting").
- Si choca con un principio: NO lo apliques tal cual; explica el riesgo en "aviso" y propón una versión que funcione.
- Sé conversacional y breve en "respuesta" (es para leer o ESCUCHAR por voz): di qué hiciste y por qué, como un colega experto.
- Si el supervisor solo pregunta o conversa (no pide cambio), responde sin editar (edits vacío).

DEVUELVE SOLO JSON con esta forma EXACTA:
{
  "respuesta": "<lo que le dices al supervisor, breve y natural, para voz>",
  "edits": { "<id_del_momento>": { "guidance": "<nueva guía>" } },
  "aviso": "<si advertiste algo de los principios, ponlo aquí; si no, null>"
}
edits vacío ({}) si no hay cambio. Solo edita momentos que existen en el flujo de arriba.`
}

// ── El agente (llama al LLM) ────────────────────────────────────────────────
export async function copilotoFlujo({ flow, campaignNombre = '', historial = [], mensaje }) {
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
    return { respuesta: '¿Qué te gustaría ajustar del flujo?', edits: {}, aviso: null }
  }
  const sys = construirPromptCopiloto(flow, campaignNombre)
  const conv = [
    ...historial.slice(-8).map(h => `${h.rol === 'copiloto' ? 'COPILOTO' : 'SUPERVISOR'}: ${h.texto}`),
    `SUPERVISOR: ${mensaje.trim()}`,
  ].join('\n')

  const r = await callCerebras({
    model: COPILOT_MODEL, systemInstruction: sys, contents: conv,
    temperature: 0.4, maxOutputTokens: 1500, jsonMode: true,
  })
  const parsed = parsearCopiloto(r.text)
  return {
    respuesta: parsed.respuesta || 'Listo.',
    edits: filtrarEdits(parsed.edits, flow),
    aviso: parsed.aviso,
    latencyMs: r.latencyMs,
  }
}

export const FLOW_COPILOT_VERSION = 'v1_cerebras_experto'
