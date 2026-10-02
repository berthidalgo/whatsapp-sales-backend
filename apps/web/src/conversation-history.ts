import type { ConversationEvent, ConversationResponse } from '@shared/types'

export function conversationEventId(event: ConversationEvent): string {
  if (event.id) return event.id
  // Compatibility with earlier responses that did not include timeline IDs.
  return `legacy:${JSON.stringify(event)}`
}

function compareEvents(a: ConversationEvent, b: ConversationEvent): number {
  const time = new Date(a.at).getTime() - new Date(b.at).getTime()
  if (time) return time
  const type = (event: ConversationEvent) => event.kind === 'state' ? 0 : event.id?.startsWith('media:') ? 1 : 2
  const order = type(a) - type(b)
  if (order) return order
  const idA = a.id?.split(':').slice(1).join(':') || ''
  const idB = b.id?.split(':').slice(1).join(':') || ''
  if (idA && idB && /^\d+$/.test(idA) && /^\d+$/.test(idB)) return Number(idA) - Number(idB)
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

// The incoming payload replaces a duplicate ID, including its delivery receipt.
export function mergeConversationEvents(existing: ConversationEvent[], incoming: ConversationEvent[]): ConversationEvent[] {
  const events = new Map<string, ConversationEvent>()
  for (const event of [...existing, ...incoming]) events.set(conversationEventId(event), event)
  return [...events.values()].sort(compareEvents)
}

export function mergeLatestConversation(current: ConversationResponse | undefined, latest: ConversationResponse): ConversationResponse {
  if (!current || current.leadId !== latest.leadId) return latest
  return {
    ...latest,
    eventos: mergeConversationEvents(current.eventos, latest.eventos),
    // This remains the boundary of the oldest page already loaded.
    page: current.page ?? latest.page,
  }
}

export function mergeEarlierConversation(current: ConversationResponse | undefined, earlier: ConversationResponse): ConversationResponse {
  if (!current) return earlier
  if (current.leadId !== earlier.leadId) return current
  return {
    ...current,
    // A concurrent poll may already have a newer receipt for the same event.
    eventos: mergeConversationEvents(earlier.eventos, current.eventos),
    page: earlier.page,
  }
}
