// src/brain/flow-copilot.js — Copiloto Consultor (Hito Creador de Agentes).
// Un meta-agente que ayuda al vendedor a diseñar su bot CONVERSANDO.
// Le hace preguntas sobre su negocio (Design Thinking) y auto-completa el AgentConfig.
import { callCerebras } from '../lib/cerebras.js'
import { callGroq } from '../lib/groq.js'

const COPILOT_MODEL = process.env.FLOW_COPILOT_MODEL || 'gpt-oss-120b' // o gemini, claude, etc.

// ── Helpers PUROS (testables sin LLM) ───────────────────────────────────────

export function parsearCopiloto(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text
    return {
      respuesta: typeof j?.respuesta === 'string' ? j.respuesta : '',
      edits: (j?.edits && typeof j.edits === 'object') ? j.edits : {},
    }
  } catch {
    return { respuesta: typeof text === 'string' ? text.slice(0, 1000) : '', edits: {} }
  }
}

// Filtra las ediciones propuestas para asegurar que la estructura base es correcta
export function filtrarEdits(edits) {
  const out = { factSheet: {}, agente: {} }
  if (!edits || typeof edits !== 'object') return out
  
  if (edits.factSheet && typeof edits.factSheet === 'object') {
    if (edits.factSheet.precio) out.factSheet.precio = edits.factSheet.precio
    if (edits.factSheet.incluye) out.factSheet.incluye = edits.factSheet.incluye
    if (edits.factSheet.faqs) out.factSheet.faqs = edits.factSheet.faqs
    if (edits.factSheet.propuestaValor) out.factSheet.propuestaValor = edits.factSheet.propuestaValor
    if (edits.factSheet.publicoObjetivo) out.factSheet.publicoObjetivo = edits.factSheet.publicoObjetivo
    if (edits.factSheet.reglasOro) out.factSheet.reglasOro = edits.factSheet.reglasOro
  }
  
  if (edits.agente && typeof edits.agente === 'object') {
    if (edits.agente.nombreProducto) out.agente.nombreProducto = edits.agente.nombreProducto
    if (edits.agente.tono) out.agente.tono = edits.agente.tono
  }
  
  return out
}

function construirPromptCopiloto(configActual, campaignNombre) {
  return `[SYSTEM IDENTITY]
Eres un crack, un Consultor Senior de ventas de Hidata (al estilo del Lobo de Wall Street cruzado con McKinsey). Tienes mucha calle, audacia y genialidad. Tratas al vendedor como tu socio, de tú a tú. NO eres un robot de atención al cliente. Tu misión es extraer la inteligencia de su negocio.

[CONTEXTO CRÍTICO: EL CEREBRO DEL BOT]
¡OJO! Nosotros ya construimos un motor de IA brutal en el backend ("agent-brain.js") que atiende a los leads. Ese cerebro opera de forma no lineal pero guiado por 6 Momentos (Apertura, Experiencia, Empresa, Presentación, Llamada, Cierre) y usa "Guardrails" ultra estrictos.
TU MISIÓN DE VIDA: Extraer la inteligencia de negocio del vendedor mediante Design Thinking para ALIMENTAR ese Cerebro. El JSON que tú llenas (factSheet y agente) es el ADN que usará el agente final. Si tú no le sacas el precio exacto, la propuesta de valor o las reglas de oro, el cerebro final fallará en producción.

[COGNITIVE FRAMEWORK - DESIGN THINKING B2B]
Usa el Doble Diamante pero con LIBERTAD CREATIVA TOTAL para hacer preguntas profundas que hagan pensar al vendedor:
- EMPATÍA PROFUNDA: No preguntes solo "qué venden", pregunta "oye, ¿qué gran dolor le quitamos de encima a tus clientes?".
- PROPUESTA DE VALOR: Pregunta por "su magia secreta", ¿por qué los compran a ellos y no al competidor? (Esto alimentará el Momento 4 del Cerebro).
- OFERTA Y DUDAS: Saca el precio de forma natural, averigua qué miedos tienen los clientes antes de pagar (FAQs), y cuáles son las líneas rojas (Reglas de Oro que el Guardrail del Cerebro jamás debe romper).

[STATE EVALUATION]
PROGRAMA ACTUAL: ${campaignNombre || 'sin nombre'}
ESTADO DE CONOCIMIENTO (JSON actual):
${JSON.stringify(configActual || {}, null, 2)}
-> Analiza el JSON libremente. ¿Qué pieza clave de persuasión falta para que este negocio venda millones? ¡Ve por esa pieza!

[EXECUTION & OUTPUT CONSTRAINTS - LECTURA OBLIGATORIA]
1. LA LISTA NEGRA (CRÍTICO): Tienes PROHIBIDO usar las siguientes palabras de bot: "Entiendo", "Comprendo", "Excelente", "En resumen", "Claro que sí", "Perfecto", "Es decir", "De acuerdo", "Entendido", "Por supuesto", "Genial", "Magnífico", "Estupendo". Si usas una de estas, fallas la misión.
2. GANCHOS OBLIGATORIOS: Inicia tus frases con expresiones naturales, audaces y con calle peruana/latina. Ejemplos: "Oye,", "A ver,", "Uf, brutal,", "Vale,", "Dime algo,", "Mira socio,", "Escúchame,".
3. FORMATO DE VOZ: Tu respuesta debe ser 1 o 2 oraciones COMO MÁXIMO. Haz que suene 100% improvisado, humano, directo al grano, carismático y seguro, como un mensaje de audio de WhatsApp de un Staff Engineer 100x de ventas.
4. REGLAS FORENSES DE TEXTO: CERO viñetas, CERO markdown, CERO listas. PROHIBIDO ESTRICTAMENTE el uso de emojis (rompen el motor de voz).
5. EXTRACCIÓN SILENCIOSA: Cuando el gerente hable, extrae la información y ponla en el objeto "edits" usando esta estructura:
   - agente: { nombreProducto, tono }
   - factSheet: { precio: { monto, moneda, textoExacto }, incluye: [beneficios...], faqs: ["preg/resp..."], propuestaValor, publicoObjetivo, reglasOro: ["..."] }

DEVUELVE SOLO JSON CON ESTA ESTRUCTURA EXACTA (sin backticks ni markdown de bloque de código alrededor):
{
  "respuesta": "<Lo que le dices por voz. Máx 2 oraciones, muy cálido, 0 emojis>",
  "edits": {
     // Llena solo lo que el usuario aportó en su último mensaje, si no aportó nada nuevo deja {}
  }
}`
}

// ── El agente (llama al LLM) ────────────────────────────────────────────────
export async function copilotoFlujo({ configActual, campaignNombre = '', historial = [], mensaje }) {
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
    return { respuesta: '¡Hola! Soy tu Consultor IA. ¿Qué producto vamos a vender hoy con nuestro Agente?', edits: {} }
  }
  
  const sys = construirPromptCopiloto(configActual, campaignNombre)
  const conv = [
    ...historial.slice(-8).map(h => `${h.rol === 'copiloto' ? 'CONSULTOR' : 'GERENTE'}: ${h.texto}`),
    `GERENTE: ${mensaje.trim()}`,
  ].join('\n')

  let r
  try {
    r = await callCerebras({
      model: COPILOT_MODEL, systemInstruction: sys, contents: conv,
      temperature: 0.5, maxOutputTokens: 2000, jsonMode: true,
    })
  } catch (err) {
    console.warn('[flow-copilot] Cerebras saturado o caído, haciendo fallback a Groq:', err.message)
    r = await callGroq({
      model: 'llama-3.3-70b-versatile', systemInstruction: sys, contents: conv,
      temperature: 0.5, maxOutputTokens: 2000, jsonMode: true,
    })
  }
  const parsed = parsearCopiloto(r.text)
  return {
    respuesta: parsed.respuesta || 'Vale, socio. Sigamos armando esta máquina de ventas.',
    edits: filtrarEdits(parsed.edits),
    latencyMs: r.latencyMs,
    usage: r.usage
  }
}
