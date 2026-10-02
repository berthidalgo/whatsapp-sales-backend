// Cliente HTTP fino del front. Adjunta el JWT en cada request y maneja la sesión.
// Tipado contra el contrato compartido (@shared/types) = una sola fuente de verdad.
import type {
  LoginResponse, AuthUser, LeadListItem, LeadDetail, ConversationResponse, ConversationEvent, CampaignLite, CampaignDetail, CreateCampaignRequest, CopilotResponse, DebriefPreview, AgentConfig, AgentConfigPreview, TurnoPreview, SaveAgentConfigResponse, LeadsPage,
} from '@shared/types'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3999'
const TOKEN_KEY = 'hidata_token'
const USER_KEY = 'hidata_user'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function getUser(): AuthUser | null {
  const s = localStorage.getItem(USER_KEY)
  try { return s ? (JSON.parse(s) as AuthUser) : null } catch { return null }
}
export function saveSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

// Un fallo de la API que CONSERVA el cuerpo. El caso que lo hizo necesario: la ventana
// de 24 h de Meta. El backend responde 409 diciendo qué plantilla reabre el chat, y con un
// `new Error("409")` esa información se perdía antes de llegar a la pantalla.
export class ApiError extends Error {
  status: number
  body: any
  constructor(status: number, body: any, path: string) {
    super(body?.error || `${path} → ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) { clearSession(); throw new Error('sesión expirada') }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body, path)
  }
  return (await res.json()) as T
}

export interface VendorLite {
  id: number
  nombre: string
  role: string
  initials: string
  color: string
}

export const api = {
  // Público (pantalla de login, pre-auth): todos los vendedores activos.
  vendors: () => req<VendorLite[]>('/auth/vendors'),
  // Autenticado + tenant-scopeado (picker de reasignar): solo los del MISMO tenant.
  vendorsScoped: () => req<{ id: number; nombre: string; role: string }[]>('/v2/vendors'),
  login: (nombre: string, pin: string) =>
    req<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ nombre, pin }) }),
  // Sin params → array legacy. Con params → página (sobrecargas separadas para no
  // romper el tipado del Inbox actual).
  leads: () => req<LeadListItem[]>('/v2/leads'),
  leadsPage: (limit = 50, offset = 0) =>
    req<LeadsPage>(`/v2/leads?limit=${limit}&offset=${offset}`),
  campaigns: () => req<CampaignLite[]>('/v2/campaigns'),
  campaignDetail: (id: number) => req<CampaignDetail>(`/v2/campaigns/${id}`),
  createCampaign: (b: CreateCampaignRequest) =>
    req<CampaignDetail & { borrador: boolean }>('/v2/campaigns', { method: 'POST', body: JSON.stringify(b) }),
  agentConfig: (campaignId?: number) => req<AgentConfig>(`/v2/agent-config${campaignId ? `?campaignId=${campaignId}` : ''}`),
  // `version`: la que entregó agentConfig(). Sin ella → 428; vieja → 409 (el
  // borrador local NO se pierde: el 409 trae la ficha vigente para combinar).
  saveAgentConfig: (campaignId: number, factSheet: any, agente: any, version: number) =>
    req<SaveAgentConfigResponse>('/v2/agent-config', { method: 'PUT', body: JSON.stringify({ campaignId, factSheet, agente, version }) }),
  previewAgentConfig: (campaignId: number, factSheet: any, agente: any) =>
    req<AgentConfigPreview>('/v2/agent-config/preview', { method: 'POST', body: JSON.stringify({ campaignId, factSheet, agente }) }),
  flowCopilot: (campaignId: number, mensaje: string, historial: { rol: string; texto: string }[]) =>
    req<CopilotResponse>('/v2/flow/copilot', { method: 'POST', body: JSON.stringify({ campaignId, mensaje, historial }) }),
  transcribe: (audioBase64: string, mimeType: string) =>
    req<{ texto: string }>('/v2/transcribe', { method: 'POST', body: JSON.stringify({ audioBase64, mimeType }) }),
  debrief: (id: number, nota: string) =>
    req<DebriefPreview>(`/v2/leads/${id}/debrief`, { method: 'POST', body: JSON.stringify({ nota }) }),
  saveDebrief: (id: number, d: DebriefPreview) =>
    req<{ ok: true; outcome: string }>(`/v2/leads/${id}/debrief/save`, { method: 'POST', body: JSON.stringify(d) }),
  leadDetail: (id: number) => req<LeadDetail>(`/v2/leads/${id}`),
  // Pass page.cursor unchanged; its timestamp and ID are an opaque backend contract.
  conversation: (id: number, limit?: number, cursor?: string) =>
    req<ConversationResponse>(`/v2/leads/${id}/conversation${limit !== undefined || cursor ? `?${limit !== undefined ? `limit=${limit}` : ''}${limit !== undefined && cursor ? '&' : ''}${cursor ? `before=${encodeURIComponent(cursor)}` : ''}` : ''}`),
  // Simulación segura: qué haría el bot (sin enviar, sin persistir, sin LLM).
  previewTurno: (id: number, texto: string) =>
    req<TurnoPreview>(`/v2/leads/${id}/preview`, { method: 'POST', body: JSON.stringify({ texto }) }),
  // Hito 2 — acciones de escritura
  reply: (id: number, texto: string) =>
    req<{ ok: true; evento: ConversationEvent }>(`/v2/leads/${id}/reply`, { method: 'POST', body: JSON.stringify({ texto }) }),
  // Manda la plantilla aprobada que reabre la ventana de 24 h (se cobra → el vendedor confirma).
  reabrir: (id: number) =>
    req<{ ok: true; plantilla: string; evento: ConversationEvent }>(`/v2/leads/${id}/reabrir`, { method: 'POST' }),
  setMode: (id: number, mode: 'HUMAN_ACTIVE' | 'AUTO_CONSULTIVO') =>
    req<{ ok: true; mode: string }>(`/v2/leads/${id}/mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  assign: (id: number, vendorId: number) =>
    req<{ ok: true }>(`/v2/leads/${id}/assign`, { method: 'POST', body: JSON.stringify({ vendorId }) }),
  setLabel: (id: number, label: string | null) =>
    req<{ ok: true; label: string | null }>(`/v2/leads/${id}/label`, { method: 'POST', body: JSON.stringify({ label }) }),
  // Media servida con auth (no hay URL pública): bajamos el blob y lo volvemos
  // object URL para el <img>. Así el JWT viaja en el header, no en la URL.
  mediaObjectUrl: async (leadId: number, mediaId: number): Promise<string> => {
    const token = getToken()
    const res = await fetch(`${BASE}/v2/leads/${leadId}/media/${mediaId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 401) { clearSession(); throw new Error('sesión expirada') }
    if (!res.ok) throw new Error(`media → ${res.status}`)
    return URL.createObjectURL(await res.blob())
  },
}
