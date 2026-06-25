// packages/shared/labels.js — Taxonomía de ETIQUETAS MANUALES del vendedor (tag CRM).
// FUENTE ÚNICA en runtime: la importa el backend (JS, para validar) y el front (TS,
// para los botones), así no se desincronizan. Distinta de la `temperatura` que detecta
// el cerebro: esto es el tag que pone el HUMANO. En la BD `lead_state.label` es texto
// libre; este set es el permitido a nivel app → sumar una etiqueta = editar esta lista,
// sin tocar la BD.
export const ETIQUETAS_VALIDAS = ['Caliente', 'Tibio', 'Frío', 'Agendado', 'Pagó', 'Ganado', 'Perdido']

const SET = new Set(ETIQUETAS_VALIDAS)

// null / '' = limpiar la etiqueta (válido). Cualquier otro valor debe estar en el set.
export function esEtiquetaValida(v) {
  return v == null || v === '' || SET.has(v)
}

// Normaliza el input del cliente a valor de BD: null para limpiar, o el string tal cual.
export function normalizarEtiqueta(v) {
  return v == null || v === '' ? null : v
}
