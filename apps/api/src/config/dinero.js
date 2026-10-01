export const RX_DINERO = /(?:(?:S\/\.?|US\$|\$|\b(?:USD|PEN|EUR))\s*\d[\d,.]*)|(?:\b\d[\d,.]*\s*(?:(?:sol|soles)|d[oó]lares?|usd|pen|euros?|eur)\b)/gi



export function montoDe(texto) {
  const m = String(texto || '').match(/\d[\d.,]*/)
  if (!m) return null
  let s = m[0].replace(/[.,]+$/, '')                                                        // "329." al cerrar la frase
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')                         // 1,500 · 1,500.50
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.') // 1.500 · 1.500,50
  else s = s.replace(',', '.')                                                               // 124,50
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}


export function montosMonetarios(texto) { return [...String(texto || "").matchAll(RX_DINERO)].map(m => montoDe(m[0])).filter(n => n !== null) }
