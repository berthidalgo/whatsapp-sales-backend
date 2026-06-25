// Cliente HTTP fino del front. Adjunta el JWT en cada request y maneja la sesión.
// Tipado contra el contrato compartido (@shared/types) = una sola fuente de verdad.
import type {
  LoginResponse, AuthUser, LeadListItem, LeadDetail, ConversationResponse, ConversationEvent,
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
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
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
  leads: () => req<LeadListItem[]>('/v2/leads'),
  leadDetail: (id: number) => req<LeadDetail>(`/v2/leads/${id}`),
  conversation: (id: number) => req<ConversationResponse>(`/v2/leads/${id}/conversation`),
  // Hito 2 — acciones de escritura
  reply: (id: number, texto: string) =>
    req<{ ok: true; evento: ConversationEvent }>(`/v2/leads/${id}/reply`, { method: 'POST', body: JSON.stringify({ texto }) }),
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
