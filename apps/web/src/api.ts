// Cliente HTTP fino del front. Adjunta el JWT en cada request y maneja la sesión.
// Tipado contra el contrato compartido (@shared/types) = una sola fuente de verdad.
import type {
  LoginResponse, AuthUser, LeadListItem, LeadDetail, ConversationResponse, ConversationEvent, CampaignLite, CampaignDetail, CreateCampaignRequest, CopilotResponse, DebriefPreview, AgentConfig, AgentConfigPreview, TurnoPreview, SaveAgentConfigResponse, LeadsPage,
} from '@shared/types'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3999'
const TOKEN_KEY = 'hidata_token'
const USER_KEY = 'hidata_user'
const TENANT_KEY = 'hidata_tenant'

// ── Empresa (tenant) del CRM ───────────────────────────────────────────────
// El login es el ÚNICO punto sin token del cual no se puede derivar el tenant, así que el
// navegador tiene que declararlo. Sin esto, la pantalla de perfiles listaba SIEMPRE los
// vendedores del tenant por defecto del despliegue: en una operación con tres empresas,
// entrar por el CRM de la segunda era imposible (o, peor, se列表aba el equipo de otra).
// Orden: ?tenant= en la URL (lo usa cada cliente al publicar su enlace) → valor guardado →
// variable de entorno del build.
function resolverTenant(): string | null {
  const deUrl = new URLSearchParams(window.location.search).get('tenant')
  if (deUrl) { try { localStorage.setItem(TENANT_KEY, deUrl) } catch { /* modo privado */ } return deUrl }
  try { const guardado = localStorage.getItem(TENANT_KEY); if (guardado) return guardado } catch { /* modo privado */ }
  return (import.meta.env.VITE_TENANT as string | undefined) || null
}

let TENANT: string | null = typeof window === 'undefined' ? null : resolverTenant()

/** Cambia de empresa (o limpia la selección si se pasa null). */
export function setTenant(tenant: string | null): void {
  TENANT = tenant
  try { tenant ? localStorage.setItem(TENANT_KEY, tenant) : localStorage.removeItem(TENANT_KEY) } catch { /* modo privado */ }
}

export function getTenant(): string | null { return TENANT }

/** Añade el tenant a la ruta de los endpoints que lo necesitan (login). */
function conTenant(path: string): string {
  if (!TENANT) return path
  return path + (path.includes('?') ? '&' : '?') + 'tenant=' + encodeURIComponent(TENANT)
}

// ── Sesión: una sola fuente, con aviso de expiración ──────────────────────
// El bug que motivó esto: un 401 borraba el token del almacenamiento pero NO cambiaba el
// usuario en `App`. La pantalla seguía "autenticada" con datos viejos en caché y el
// vendedor veía una bandeja que ya no era suya. Ahora el 401 (o el logout) notifica a la
// app para que vuelva al login, cancele consultas y vacíe la caché.
type SessionListener = (motivo: 'expirada' | 'logout') => void
const listeners = new Set<SessionListener>()
export function onSessionLost(cb: SessionListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function avisarPerdida(motivo: SessionListener extends never ? never : 'expirada' | 'logout') {
  for (const cb of listeners) { try { cb(motivo) } catch { /* un oyente roto no bloquea */ } }
}

/**
 * Clave de aislamiento de caché. React Query indexa por clave, y sin el tenant/usuario en
 * la clave, el vendedor que entraba después veía la lista del anterior (mismo endpoint,
 * distinto `Authorization`). Cada sesión tiene su propia clave: `qc.clearQueryData` del
 * anterior no toca la nueva, y viceversa.
 */
export function scopeDeCache(user: AuthUser | null): string {
  return user ? `${user.tenantId}:${user.id}` : 'anonimo'
}

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
export function clearSession(motivo: 'expirada' | 'logout' = 'logout'): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  avisarPerdida(motivo)
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
  if (res.status === 401) { clearSession('expirada'); throw new Error('sesión expirada') }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body, path)
  }
  return (await res.json()) as T
}

/**
 * Claves de caché con ámbito de sesión (Hito B1).
 *
 * React Query guarda por clave. Si dos sesiones distintas usan `['leads']`, la segunda ve
 * la lista del primero hasta que el refetch responde, y —peor— una respuesta tardía de la
 * sesión vieja puede escribir en la clave compartida después del login nuevo. Prefijando
 * con `scopeDeCache(usuario)` (tenant + id) cada sesión tiene su propio espacio, y al
 * cambiar de sesión se cancela y limpia el anterior explícitamente.
 */
export function claveDeCache(user: AuthUser | null, ...partes: (string | number | null | undefined)[]): (string | number)[] {
  return [scopeDeCache(user), ...partes.filter((p): p is string | number => p !== null && p !== undefined)]
}

export interface VendorLite {
  id: number
  nombre: string
  role: string
  initials: string
  color: string
}

// Parámetros de la bandeja paginada. `q`, `stage` y `label` los resuelve el servidor sobre
// TODA la bandeja, no sobre la página cargada.
export interface LeadsPageQuery {
  limit?: number
  offset?: number
  q?: string
  stage?: string
  label?: string
}

// Métricas v1 (Hito B4). Cada métrica explica QUÉ cuenta y de DÓNDE sale; si no hay dato,
// `disponible:false` explica por qué. Es la diferencia entre un panel y una colección de
// números que nadie puede defender.
export interface Metrica {
  clave: string
  valor: number | null
  unidad: string
  definicion: string
  fuente: string
  disponible?: boolean
  motivoSiNo?: string
}

export interface MetricasResponse {
  periodo: { dias: number; desde: string }
  alcance: 'tenant' | 'propio'
  metricas: Metrica[]
  resultadosConfirmados: { resultado: string; total: number }[]
  nota: string
}

export const api = {
  // Público (pantalla de login, pre-auth): los vendedores del tenant declarado.
  vendors: () => req<VendorLite[]>(conTenant('/auth/vendors')),
  // Autenticado + tenant-scopeado (picker de reasignar): solo los del MISMO tenant.
  vendorsScoped: () => req<{ id: number; nombre: string; role: string }[]>('/v2/vendors'),
  login: (nombre: string, pin: string) =>
    req<LoginResponse>(conTenant('/auth/login'), { method: 'POST', body: JSON.stringify({ nombre, pin }) }),
  // Sin params → array legacy. Con params → página (sobrecargas separadas para no
  // romper el tipado del Inbox actual).
  leads: () => req<LeadListItem[]>('/v2/leads'),
  // Búsqueda y filtros van al SERVIDOR, no en el cliente (Hito B2). La lista paginada de la
  // pantalla era solo la primera página: filtrar en el navegador daba un resultado
  // "completo" que en realidad no lo era (si el lead buscado estaba en la página 3, no
  // aparecía nunca). Con filtros en el backend, `items` trae exactamente los leads que
  // cumplen y `page.total`/`page.totalPages` permiten decirlo con verdad en pantalla.
  leadsPage: (params: LeadsPageQuery = {}) => {
    const q = new URLSearchParams()
    q.set('limit', String(Math.min(Math.max(params.limit ?? 50, 1), 200)))
    q.set('offset', String(Math.max(params.offset ?? 0, 0)))
    if (params.q?.trim()) q.set('q', params.q.trim())
    if (params.stage) q.set('stage', params.stage)
    if (params.label) q.set('label', params.label)
    return req<LeadsPage>(`/v2/leads?${q.toString()}`)
  },
  campaigns: () => req<CampaignLite[]>('/v2/campaigns'),
  campaignDetail: (id: number) => req<CampaignDetail>(`/v2/campaigns/${id}`),
  createCampaign: (b: CreateCampaignRequest) =>
    req<CampaignDetail & { borrador: boolean }>('/v2/campaigns', { method: 'POST', body: JSON.stringify(b) }),
  agentConfig: (campaignId?: number) => req<AgentConfig>(`/v2/agent-config${campaignId ? `?campaignId=${campaignId}` : ''}`),
  // `version`: la que entregó agentConfig(). Sin ella → 428; vieja → 409 (el
  // borrador local NO se pierde: el 409 trae la ficha vigente para combinar).
  // `force`: solo para la petición que borra un dato existente y el operador confirmó.
  // No es un permiso general de escritura: enviarlo siempre desactiva la protección.
  saveAgentConfig: (campaignId: number, factSheet: any, agente: any, version: number, force = false) =>
    req<SaveAgentConfigResponse>('/v2/agent-config', { method: 'PUT', body: JSON.stringify({ campaignId, factSheet, agente, version, ...(force ? { force: true } : {}) }) }),
  previewAgentConfig: (campaignId: number, factSheet: any, agente: any) =>
    req<AgentConfigPreview>('/v2/agent-config/preview', { method: 'POST', body: JSON.stringify({ campaignId, factSheet, agente }) }),

  // ── Recorrido de campañas (Hito B3) ────────────────────────────────────
  // Estas rutas son las legacy `/campaigns/*`, ya protegidas por JWT + rol administrativo y
  // con alcance por tenant. Se usan para lo que NO tiene equivalente v2: pasos, triggers y
  // activación. Guardar la ficha comercial sigue pasando por `/v2/agent-config` (que tiene
  // el control de versión por ficha).
  saveCampaign: (id: number, body: { nombre?: string; config?: any; version?: number; force?: boolean }) =>
    req<{ id: number; version: number }>(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  saveSteps: (id: number, steps: { tipo: string; mensaje: string; followupHrs?: number | null }[]) =>
    req<unknown[]>(`/campaigns/${id}/steps`, { method: 'PUT', body: JSON.stringify({ steps }) }),
  addTrigger: (id: number, texto: string) =>
    req<{ id: number; texto: string }>(`/campaigns/${id}/triggers`, { method: 'POST', body: JSON.stringify({ texto }) }),
  deleteTrigger: (id: number, triggerId: number) =>
    req<{ ok: true }>(`/campaigns/${id}/triggers/${triggerId}`, { method: 'DELETE' }),
  activateCampaign: (id: number) =>
    req<{ id: number; activa: boolean }>(`/campaigns/${id}/activar`, { method: 'PATCH' }),
  testTrigger: (id: number, mensaje: string) =>
    req<{ match: boolean; trigger: string | null }>('/campaigns/test-trigger', { method: 'POST', body: JSON.stringify({ campaignId: id, mensaje }) }),
  flowCopilot: (campaignId: number, mensaje: string, historial: { rol: string; texto: string }[]) =>
    req<CopilotResponse>('/v2/flow/copilot', { method: 'POST', body: JSON.stringify({ campaignId, mensaje, historial }) }),
  transcribe: (audioBase64: string, mimeType: string) =>
    req<{ texto: string }>('/v2/transcribe', { method: 'POST', body: JSON.stringify({ audioBase64, mimeType }) }),
  debrief: (id: number, nota: string) =>
    req<DebriefPreview>(`/v2/leads/${id}/debrief`, { method: 'POST', body: JSON.stringify({ nota }) }),
  saveDebrief: (id: number, d: DebriefPreview) =>
    req<{ ok: true; outcome: string }>(`/v2/leads/${id}/debrief/save`, { method: 'POST', body: JSON.stringify(d) }),
  // Métricas v1 (Hito B4): cada número con definición y fuente. Lo que no tiene dato llega
  // con `disponible:false`, y la pantalla lo dice en vez de inventar un valor.
  metricas: (dias = 30) => req<MetricasResponse>(`/v2/metricas?dias=${dias}`),
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
