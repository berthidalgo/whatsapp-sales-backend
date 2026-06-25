// Estado "visto" por lead (no-leídos), persistido en localStorage POR vendedor.
// Sin backend: un lead está "no leído" si su ÚLTIMO mensaje es del LEAD y es más nuevo
// que la última vez que el vendedor abrió ese chat. Foco en lo que NECESITA atención
// humana: en AUTO el bot responde → ultimoOrigen=BOT → NO marca no-leído; el indicador
// resalta sobre todo los chats donde el lead escribió y nadie le respondió aún
// (HUMAN_ACTIVE, o la ventana antes de que el bot conteste).
import type { LeadListItem } from '@shared/types'

export type SeenMap = Record<number, string>  // leadId → ISO del último mensaje visto

const key = (vendorId: number) => `hidata_seen_${vendorId}`

export function loadSeen(vendorId: number): SeenMap {
  try { return JSON.parse(localStorage.getItem(key(vendorId)) || '{}') as SeenMap } catch { return {} }
}

export function saveSeen(vendorId: number, seen: SeenMap): void {
  try { localStorage.setItem(key(vendorId), JSON.stringify(seen)) } catch { /* quota: ignorar */ }
}

export function isUnread(lead: LeadListItem, seen: SeenMap): boolean {
  if (lead.ultimoOrigen !== 'LEAD' || !lead.ultimoMensajeAt) return false
  const vistoAt = seen[lead.id]
  return !vistoAt || new Date(lead.ultimoMensajeAt) > new Date(vistoAt)
}
