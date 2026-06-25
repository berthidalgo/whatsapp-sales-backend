// Tipos del módulo runtime labels.js (para que el front TS lo importe tipado sin
// necesitar allowJs global). El backend (JS) usa labels.js directo en runtime.
export const ETIQUETAS_VALIDAS: readonly string[]
export function esEtiquetaValida(v: unknown): boolean
export function normalizarEtiqueta(v: unknown): string | null
