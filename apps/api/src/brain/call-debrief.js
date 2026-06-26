// src/brain/call-debrief.js — Debrief post-llamada por voz (la superficie de voz de
// MAYOR ROI: los vendedores odian escribir notas). El vendedor DICTA cómo le fue en la
// llamada y este agente ESTRUCTURA el resultado para actualizar el CRM. Es 100% backend
// (la inteligencia); el front solo captura la voz y muestra el preview para confirmar.
// Usa Cerebras (gpt-oss-120b) → verificable local con CEREBRAS_API_KEY.
import { callCerebras } from '../lib/cerebras.js'

const DEBRIEF_MODEL = process.env.DEBRIEF_MODEL || 'gpt-oss-120b'

// Outcomes canónicos (el front los muestra como chips; el agente elige uno).
export const DEBRIEF_OUTCOMES = ['interesado', 'agendado', 'pensándolo', 'pidió_info', 'no_contesta', 'no_interesado', 'pagó', 'otro']

// Parser PURO (testable sin LLM). Normaliza y acota.
export function parsearDebrief(text) {
  let j
  try { j = typeof text === 'string' ? JSON.parse(text) : text } catch { j = null }
  const outcome = DEBRIEF_OUTCOMES.includes(j?.outcome) ? j.outcome : 'otro'
  const str = (v, max) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null
  return {
    outcome,
    objecion: str(j?.objecion, 200),
    proximoPaso: str(j?.proximoPaso, 200),
    fechaISO: str(j?.fechaISO, 40),       // el front/back validan formato si lo usan
    resumen: str(j?.resumen, 400) || '',
  }
}

function construirPrompt(lead) {
  const ahoraPeru = new Date().toLocaleString('es-PE', {
    timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `Eres un asistente que ESTRUCTURA el resumen que un vendedor DICTA después de una llamada con un lead. Tu trabajo es convertir su dictado natural en datos limpios para el CRM. NO inventes nada que el vendedor no haya dicho.

CONTEXTO: el lead es ${lead.nombre || 'sin nombre'}${lead.stage ? ` (etapa actual: ${lead.stage})` : ''}.
AHORA MISMO: hoy es ${ahoraPeru} (Perú, UTC-05:00). Úsalo para resolver "mañana", "el viernes", etc.

Extrae del dictado:
- "outcome": uno de [${DEBRIEF_OUTCOMES.join(', ')}] (cómo quedó la llamada).
- "objecion": la duda o freno principal que mencionó el lead (o null si no hubo).
- "proximoPaso": qué sigue (ej "volver a llamar", "enviarle el temario") (o null).
- "fechaISO": si el vendedor mencionó una fecha/cuándo para el próximo paso, en ISO con -05:00 (ej "2026-06-26T15:00:00-05:00"); null si no dijo fecha.
- "resumen": 1-2 frases limpias y profesionales del resultado, en español.

DEVUELVE SOLO JSON: {"outcome":"...","objecion":...,"proximoPaso":...,"fechaISO":...,"resumen":"..."}`
}

// El agente: dictado del vendedor → estructura. NUNCA tira (devuelve algo usable).
export async function extraerDebrief({ nota, lead = {} }) {
  if (!nota || typeof nota !== 'string' || !nota.trim()) {
    return { outcome: 'otro', objecion: null, proximoPaso: null, fechaISO: null, resumen: '' }
  }
  const r = await callCerebras({
    model: DEBRIEF_MODEL, systemInstruction: construirPrompt(lead), contents: nota.trim(),
    temperature: 0.2, maxOutputTokens: 600, jsonMode: true,
  })
  return { ...parsearDebrief(r.text), latencyMs: r.latencyMs }
}

export const CALL_DEBRIEF_VERSION = 'v1_cerebras_estructura'
