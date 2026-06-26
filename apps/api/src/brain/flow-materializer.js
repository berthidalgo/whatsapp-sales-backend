// src/brain/flow-materializer.js — Flow Builder (Hito A)
// MATERIALIZA el flujo IMPLÍCITO del cerebro (que vive en stage-definitions.js) a un
// grafo Flow JSON explícito = el "flow inicial" (la semilla) que se visualiza y, más
// adelante, se edita. Función PURA, derivada de la fuente de verdad → cero riesgo al
// cerebro: es un RETRATO de lo que el bot ya hace, no una segunda implementación.
import { STAGES, STAGE_TRANSITIONS, REQUIRED_SLOTS_BY_STAGE, INTENT_SUGGESTS_STAGE } from '../state/stage-definitions.js'
import { stageLabel } from '../../../../packages/shared/stages.js'
import { MOMENTOS } from './agent-brain.js'

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

// Guía/munición por momento = LOS PASOS REALES del cerebro (fieles a `agent-brain.js`,
// sección "EL FLUJO — 6 MOMENTOS"), NO resúmenes. Esto es lo que el supervisor edita y lo
// que el flujo predeterminado MUESTRA → es el flujo que el cerebro corre hoy. (En el Nivel B
// el cerebro ENSAMBLA su prompt desde acá, byte-idéntico; hoy es el reflejo fiel + editable.)
const GUIDANCE = {
  [STAGES.FIRST_CONTACT]: MOMENTOS.first_contact,
  [STAGES.DISCOVERY]: MOMENTOS.discovery,
  [STAGES.QUALIFYING_EMPRESA]: MOMENTOS.qualifying_empresa,
  [STAGES.PRESENTING]: MOMENTOS.presenting.replace('__FICHA__', '[la ficha del programa se edita aparte]'),
  [STAGES.CALL_SCHEDULING]: MOMENTOS.call_scheduling,
  [STAGES.CALL_CONFIRMED]: MOMENTOS.call_confirmed,
  [STAGES.POST_CLOSE]: 'POST-AGENDADO: refuerza la decisión, recuerda la cita y mantén al lead caliente hasta la llamada.',
  [STAGES.RETURNING_RECOGNITION]: 'LEAD QUE VUELVE: reconócelo (memoria episódica) y retoma la conversación donde quedó, sin re-saludar como si fuera nuevo.',
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
// `nombreCampana` solo personaliza el título; la estructura es la misma del cerebro.
export function materializarFlujoCerebro(nombreCampana = 'Mi Primera Exportación') {
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
    name: `Flujo del cerebro — ${nombreCampana}`,
    source: 'materialized',
    nodes,
    edges,
  }
}

// ── Overrides editables (Hito B): guardamos SOLO la guía/label por nodo, no el grafo
// entero → si el cerebro cambia su estructura, el flujo del supervisor no queda obsoleto.

// Aplica los overrides {nodeId: {guidance?, label?}} sobre la semilla. Marca source.
export function aplicarOverrides(seed, overrides) {
  if (!overrides || typeof overrides !== 'object' || !Object.keys(overrides).length) return seed
  const nodes = seed.nodes.map(n => {
    const o = overrides[n.id]
    if (!o) return n
    return {
      ...n,
      guidance: typeof o.guidance === 'string' ? o.guidance : n.guidance,
      label: typeof o.label === 'string' && o.label.trim() ? o.label : n.label,
    }
  })
  return { ...seed, nodes, source: 'custom' }
}

// Extrae los overrides de un Flow completo (lo que manda el front al guardar): solo
// los nodos cuya guía/label DIFIERE de la semilla (compacto + a prueba de drift).
export function extraerOverrides(flow) {
  const seed = materializarFlujoCerebro()
  const seedById = Object.fromEntries(seed.nodes.map(n => [n.id, n]))
  const overrides = {}
  for (const n of (flow?.nodes || [])) {
    const base = seedById[n.id]
    if (!base) continue   // ignora nodos que no son del cerebro (anti-basura)
    const o = {}
    if (typeof n.guidance === 'string' && n.guidance !== base.guidance) o.guidance = n.guidance.slice(0, 2000)
    if (typeof n.label === 'string' && n.label.trim() && n.label !== base.label) o.label = n.label.slice(0, 120)
    if (Object.keys(o).length) overrides[n.id] = o
  }
  return overrides
}

// Validación mínima del flow que manda el cliente (anti-basura/payload gigante).
export function flowValido(flow) {
  return !!flow && Array.isArray(flow.nodes) && flow.nodes.length > 0 && flow.nodes.length <= 50
}
