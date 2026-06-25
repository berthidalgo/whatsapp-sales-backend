// packages/shared/stages.js — Etapas del cerebro (los "momentos" M1-M7 + especiales)
// con label amigable para el front. FUENTE ÚNICA del display: la usan el Inbox (lista
// + filtro) y el header de la conversación. El valor es el `stage` real que devuelve el
// backend (string abierto): si llega uno desconocido se muestra tal cual.
export const STAGE_LABELS = {
  first_contact: 'Primer contacto',
  discovery: 'Descubrimiento',
  qualifying_empresa: 'Calificando',
  presenting: 'Presentando',
  call_scheduling: 'Agendando',
  call_confirmed: 'Cita confirmada',
  post_close: 'Post-cierre',
  returning_recognition: 'Reactivado',
}

// Orden de momentos (para el dropdown de filtro).
export const STAGE_ORDER = Object.keys(STAGE_LABELS)

// Label amigable o el valor crudo si no es conocido.
export function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage
}
