// src/brain/flow-materializer.js — Flow Builder (Hito A)
// MATERIALIZA el flujo IMPLÍCITO del cerebro (que vive en stage-definitions.js) a un
// grafo Flow JSON explícito = el "flow inicial" (la semilla) que se visualiza y, más
// adelante, se edita. Función PURA, derivada de la fuente de verdad → cero riesgo al
// cerebro: es un RETRATO de lo que el bot ya hace, no una segunda implementación.
import { STAGES, STAGE_TRANSITIONS, REQUIRED_SLOTS_BY_STAGE, INTENT_SUGGESTS_STAGE } from '../state/stage-definitions.js'
import { stageLabel } from '../../../../packages/shared/stages.js'

// Orden de los momentos (M1→M7 + el especial al final).
const FLOW_ORDER = [
  STAGES.FIRST_CONTACT, STAGES.DISCOVERY, STAGES.QUALIFYING_EMPRESA, STAGES.PRESENTING,
  STAGES.CALL_SCHEDULING, STAGES.CALL_CONFIRMED, STAGES.POST_CLOSE, STAGES.RETURNING_RECOGNITION,
]

const MOMENTO = {
  [STAGES.FIRST_CONTACT]: 'M1', [STAGES.DISCOVERY]: 'M2', [STAGES.QUALIFYING_EMPRESA]: 'M3',
  [STAGES.PRESENTING]: 'M4', [STAGES.CALL_SCHEDULING]: 'M5', [STAGES.CALL_CONFIRMED]: 'M6',
  [STAGES.POST_CLOSE]: 'M7', [STAGES.RETURNING_RECOGNITION]: '★',
}

// Guía/munición por momento: qué hace el cerebro acá. Es el texto que el supervisor
// EDITARÁ en Hito B (acá es el valor por defecto, fiel al comportamiento actual).
const GUIDANCE = {
  [STAGES.FIRST_CONTACT]: 'Saludo cálido y natural. Pide nombre y producto/qué quiere exportar.',
  [STAGES.DISCOVERY]: 'Descubre la necesidad: una pregunta a la vez, responde con sustancia (FDA, requisitos) sin inventar.',
  [STAGES.QUALIFYING_EMPRESA]: 'Califica: empresa o independiente, experiencia. Solo guarda lo que el LEAD declara (anti-fabricación).',
  [STAGES.PRESENTING]: 'Presenta el programa con valor + precio. Resuelve objeciones con la mochila (grabaciones, caso de éxito). Funnel a la cita, sin rogar.',
  [STAGES.CALL_SCHEDULING]: 'Coordina día y hora para la llamada donde el humano cierra. La META es SACAR LA CITA.',
  [STAGES.CALL_CONFIRMED]: 'Confirma el horario acordado. No re-ofrecer; asegurar.',
  [STAGES.POST_CLOSE]: 'Post-agendado: refuerza, recuerda la cita, mantén caliente.',
  [STAGES.RETURNING_RECOGNITION]: 'Reconoce al lead que vuelve (memoria episódica) y retoma donde quedó.',
}

// Etiqueta legible para el intent que dispara una transición (para la condición de la arista).
const INTENT_LABEL = {
  greeting: 'saluda', providing_info: 'da nombre + producto', requesting_call: 'pide la llamada',
  confirming_schedule: 'confirma el horario', ready_to_pay: 'listo para pagar', paid: 'pagó',
  returning_lead_acknowledge: 'vuelve',
}

// Reverse: stage destino → intents que lo sugieren (de INTENT_SUGGESTS_STAGE).
function intentsHacia(stage) {
  return Object.entries(INTENT_SUGGESTS_STAGE)
    .filter(([, s]) => s === stage)
    .map(([intent]) => INTENT_LABEL[intent] || intent)
}

// Condición legible de una arista from→to: intent que la dispara, o los slots que exige el destino.
function condicionPara(to) {
  const intents = intentsHacia(to)
  if (intents.length) return `lead ${intents.join(' / ')}`
  const req = REQUIRED_SLOTS_BY_STAGE[to] || []
  return req.length ? `requiere: ${req.join(', ')}` : 'avanza'
}

function legibleTrigger(trigger) {
  return trigger === 'lead_pide_llamada_first_turn_HOT' ? 'lead pide llamada ya (HOT)' : trigger
}

// Construye el grafo Flow desde la fuente de verdad del cerebro.
export function materializarFlujoCerebro() {
  const nodes = FLOW_ORDER.map(stage => ({
    id: stage,
    stage,
    type: stage === STAGES.POST_CLOSE ? 'terminal' : 'generative',
    momento: MOMENTO[stage] || '',
    label: stageLabel(stage),
    guidance: GUIDANCE[stage] || '',
    requiredSlots: REQUIRED_SLOTS_BY_STAGE[stage] || [],
  }))

  const edges = []
  let i = 0
  for (const from of FLOW_ORDER) {
    const t = STAGE_TRANSITIONS[from]
    if (!t) continue
    for (const to of (t.allowed_next || [])) {
      if (to === from) continue   // self-loop ("se queda") → no es una arista de avance
      edges.push({ id: `e${i++}`, from, to, condition: condicionPara(to) })
    }
    for (const [trigger, to] of Object.entries(t.fast_track || {})) {
      edges.push({ id: `e${i++}`, from, to, condition: `⚡ ${legibleTrigger(trigger)}`, fastTrack: true })
    }
  }

  return {
    id: 'cerebro_default',
    name: 'Flujo del cerebro — Mi Primera Exportación',
    source: 'materialized',
    nodes,
    edges,
  }
}
