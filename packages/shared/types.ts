// shared/types.ts — Contrato de API v2 (Hidata Sales OS)
// FUENTE DE VERDAD del seam back↔front. El backend (JS) implementa estos shapes;
// el frontend (TS) los importa. Si cambia un endpoint, se cambia AQUÍ primero.

export type Role = 'ADMIN' | 'VENDOR' | 'SUPERVISOR'

export interface AuthUser {
  id: number
  nombre: string
  role: Role
  tenantId: string
  initials: string
  color: string
  whatsappNumber?: string
}

export interface LoginResponse {
  ok: true
  token: string
  vendor: AuthUser
}

// Etapa del cerebro (los "momentos" consultivos). String abierto: el backend puede
// agregar stages; el front mapea los conocidos y cae a un default para el resto.
export type LeadStage = string
export type LeadMode = 'AUTO_CONSULTIVO' | 'HUMAN_ACTIVE' | 'PAUSED' | (string & {})

export interface LeadListItem {
  id: number
  nombre: string                 // nombre detectado o, si no hay, el teléfono
  telefono: string
  producto: string | null
  stage: LeadStage
  mode: LeadMode
  temperatura: string | null
  objecion: string | null
  ultimoMensaje: string | null
  ultimoMensajeAt: string | null              // ISO
  ultimoOrigen: 'LEAD' | 'BOT' | 'VENDEDOR' | null
  vendedor: string | null
  esRecurrente: boolean
  label: string | null           // etiqueta MANUAL del vendedor (tag CRM, ver labels.js)
}

export interface LeadDetail {
  id: number
  nombre: string
  telefono: string
  stage: LeadStage
  mode: LeadMode
  slots: Record<string, unknown>   // slotsFilled del cerebro, SIN claves internas (_)
  cierreResumen: string | null     // resumen legible del estado del closer (_cierre)
  esRecurrente: boolean
  vendedor: string | null
  label: string | null             // etiqueta MANUAL del vendedor (tag CRM, ver labels.js)
  creadoEn: string                 // ISO
}

// Referencia a una media adjunta (imagen/comprobante). El front la pide con auth a
// `/v2/leads/:id/media/:id` (no hay URL pública → no se filtra PII del comprobante).
export interface MediaRef {
  id: number
  tipo: string        // image | audio
  mimeType: string
}

// Timeline unificado de la conversación. Discriminated union por `kind`.
export type ConversationEvent =
  | { kind: 'message'; origen: 'LEAD' | 'BOT' | 'VENDEDOR'; texto: string; at: string; media?: MediaRef }
  | { kind: 'state'; label: string; priority: string; at: string }

export interface ConversationResponse {
  leadId: number
  eventos: ConversationEvent[]
}

// ── Hito 2: acciones de escritura del Inbox ──
export interface ReplyRequest { texto: string }
export interface ReplyResponse { ok: true; evento: ConversationEvent }

// Toggle manual: tomar control (HUMAN_ACTIVE) o devolver al bot (AUTO_CONSULTIVO).
// PAUSED es terminal (rechazo/cierre del cerebro), NO un toggle del vendedor.
export interface ModeRequest { mode: 'HUMAN_ACTIVE' | 'AUTO_CONSULTIVO' }

export interface AssignRequest { vendorId: number }

// Etiqueta manual del lead. `null` (o '') = limpiar. La taxonomía válida vive en
// packages/shared/labels.js (ETIQUETAS_VALIDAS).
export interface LabelRequest { label: string | null }

export interface OkResponse { ok: true; [k: string]: unknown }
