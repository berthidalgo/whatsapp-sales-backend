// drafts.ts — El borrador y las acciones PERTENECEN a un lead (Hito B1).
//
// EL BUG REAL, TAL COMO SE VIVÍA: el compositor tenía UN `texto` en el componente
// `Conversation`. Escribías para Ana, seleccionabas a Bruno por otra razón (un aviso, una
// notificación) y el `input` seguía con el texto de Ana. Al pulsar "Enviar", ese texto iba
// a Bruno: el vendedor creía estar respondiéndole a Ana y le escribe a otra persona. Es un
// envío erróneo a un cliente real, y no se deshace.
//
// AQUÍ NO SE ADIVINA: el borrador se guarda CON el lead al que pertenece. Al cambiar de
// lead se restaura el suyo (o queda vacío si nunca escribió) y nunca se mezcla. Un envío en
// curso queda amarrado al lead con el que arrancó: si mientras se espera el usuario cambia
// de conversación, el mensaje va al lead correcto y la pantalla no lo duplica en otro sitio.
//
// Además se conserva ante fallo: si Meta rechaza o la ventana está cerrada, el texto sigue
// ahí. Perder el texto escrito es la razón por la que los vendedores reescriben a mano y
// abandonan.

export type Drafts = Record<string, string>

const KEY = 'hidata_borradores'

function leer(): Drafts {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Drafts) : {}
  } catch { return {} }
}

function escribir(drafts: Drafts): void {
  try { localStorage.setItem(KEY, JSON.stringify(drafts)) } catch { /* modo privado: se pierde al recargar */ }
}

/** Guarda el borrador de UN lead. Un texto vacío borra su entrada (no deja basura). */
export function guardarBorrador(leadId: number, texto: string): Drafts {
  const d = { ...leer() }
  if (texto.trim()) d[String(leadId)] = texto
  else delete d[String(leadId)]
  escribir(d)
  return d
}

export function leerBorrador(leadId: number): string {
  return leer()[String(leadId)] || ''
}

/** Texto pendiente de un lead y el lead al que PERTENEECE. */
export function borradorDe(drafts: Drafts, leadId: number): string {
  return drafts[String(leadId)] || ''
}

export function limpiarBorradores(): void {
  try { localStorage.removeItem(KEY) } catch { /* nada que limpiar */ }
}

export function borrarBorrador(leadId: number): Drafts {
  return guardarBorrador(leadId, '')
}