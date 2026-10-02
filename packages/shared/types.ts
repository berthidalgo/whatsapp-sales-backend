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
  // ── Resultado comercial CONFIRMADO POR UN HUMANO (Hito B4) ──
  // `stage` es una INFERENCIA del bot y va aparte a propósito: no se usa para medir.
  // Estos tres vienen de `call_events` (lo que el vendedor registró en el debrief).
  // Sin llamada registrada: `null` en los tres, y la pantalla dice "no disponible"
  // en vez de suponer. El bot NUNCA escribe aquí.
  resultado: string | null       // valores de DEBRIEF_OUTCOMES (call-debrief.js)
  resultadoEtiqueta: string | null
  resultadoFuente: 'call_events' | null
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
  pedido?: PedidoCerrado | null    // venta cerrada por el bot (marca _pedido), si la hay
  // Resultado comercial confirmado por un humano (mismo contrato que en la lista).
  resultado: string | null
  resultadoEtiqueta: string | null
  resultadoFuente: 'call_events' | null
  resultadoFecha?: string | null
}

// Venta que el cerebro cerró por chat (hoy: vertical colágeno, contraentrega).
export interface PedidoCerrado {
  pack: string | null
  distrito: string | null
  direccion: string | null
  nombre: string | null
  at: string                       // ISO — cuándo se cerró
}

// Referencia a una media adjunta (imagen/comprobante). El front la pide con auth a
// `/v2/leads/:id/media/:id` (no hay URL pública → no se filtra PII del comprobante).
export interface MediaRef {
  id: number
  tipo: string        // image | audio | document | video
  mimeType: string
}

// Recibo de Meta sobre un mensaje que SALIÓ de nosotros. Ausente en los del lead y en
// todo lo que va por Evolution (que no tiene este concepto).
export type EstadoEnvio = 'sent' | 'delivered' | 'read' | 'failed'

// Timeline unificado de la conversación. Discriminated union por `kind`.
export type ConversationEvent =
  | {
      id?: string
      kind: 'message'; origen: 'LEAD' | 'BOT' | 'VENDEDOR'; texto: string | null; at: string
      media?: MediaRef
      estado?: EstadoEnvio
      estadoDetalle?: string   // por qué falló, en palabras de Meta
    }
  | { kind: 'state'; id?: string; label: string; priority: string; at: string }

export interface ConversationResponse {
  leadId: number
  eventos: ConversationEvent[]
  // Paginación hacia atrás. Presente siempre; el front puede ignorarlo.
  page?: {
    limit: number
    hayMas: boolean
    // ISO del evento más antiguo devuelto: se pasa como ?before= para cargar más.
    cursorAntesDe: string | null
    // Cursor opaco con desempate; se pasa intacto como ?before=.
    cursor?: string | null
  }
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

// ── Flow Builder (Hito A): el flujo del cerebro materializado como grafo editable ──
// Tipos de nodo. `generative` = el cerebro COMPONE con la guía/munición del nodo (funciona
// en QR hoy). Los `rail_*` = se envían tal cual (deterministas) y los interactivos
// (botones/media) son `cloudOnly` (necesitan WhatsApp Cloud API). `terminal` = sin salida.
export type FlowNodeType = 'generative' | 'rail_text' | 'rail_media' | 'rail_buttons' | 'terminal'

export interface FlowNode {
  id: string                 // = stage del cerebro (first_contact, presenting, …)
  type: FlowNodeType
  stage: string
  momento: string            // "M1".."M7" / "★" (returning)
  label: string              // amigable (ver stages.js)
  guidance: string           // qué hace el cerebro en este momento (editable en Hito B)
  requiredSlots: string[]    // slots que deben estar llenos para entrar/avanzar
  cloudOnly?: boolean        // true si el nodo necesita Cloud API (botones/media)
}

export interface FlowEdge {
  id: string
  from: string               // node id
  to: string                 // node id
  condition: string          // legible: qué dispara la transición
  fastTrack?: boolean        // salto directo (ej. lead pide llamada HOT)
}

export interface Flow {
  id: string
  name: string
  source: 'materialized' | 'custom'   // materialized = derivado del cerebro; custom = editado
  nodes: FlowNode[]
  edges: FlowEdge[]
  campaignId?: number | null          // programa al que pertenece (Hito B)
}

export interface AgentConfig {
  campaignId: number | null
  nombrePrograma: string
  factSheet: Record<string, any>
  agente: Record<string, any>
  // Control optimista: el GET la entrega, el PUT la exige. Sin ella → 428;
  // con una vieja → 409 con la ficha vigente (el borrador local no se pierde).
  version: number | null
}

// Merge recursivo: omitir conserva; null borra solo campos opcionales y con force.
// `version` es la que entregó el GET.
export interface SaveAgentConfigRequest {
  campaignId: number
  factSheet?: Record<string, any> | null
  agente?: Record<string, any> | null
  version: number
  force?: boolean
}

export interface SaveAgentConfigResponse {
  ok: true
  campaignId: number
  version: number
}

// Conflicto de edición (409): la ficha vigente para combinar con el borrador local.
export interface AgentConfigConflicto {
  error: string
  version: number
  factSheet: Record<string, any>
  agente: Record<string, any>
}

// Dry-run sin escritura (POST /v2/agent-config/preview). No llama al LLM.
export interface AgentConfigPreview {
  ok: boolean
  errores?: string[]
  version: number | null
  factSheet?: Record<string, any>
  agente?: Record<string, any>
  precioTexto?: string | null
}

// Simulación segura de un turno (POST /v2/leads/:id/preview): no envía, no persiste,
// no llama al LLM. Reproduce los gates previos al modelo del pipeline real, incluido
// el auto-resume del takeover humano.
export type PreviewMotivo =
  | 'llegaria_al_modelo'
  | 'humano_tiene_control'
  | 'conversacion_pausada'
  | 'auto_resume_del_bot'

export interface TurnoPreview {
  llegariaAlModelo: boolean
  motivo: PreviewMotivo
  modo: string
  stage: string
  campaignId: number | null
  versionCampana: number | null
  fichaTienePrecio: boolean
  advertencias: string[]
  // Horas que el lead lleva en su modo actual (contexto del auto-resume).
  horasEnControl?: number | null
  autoResumeHoras?: number | null
  nota?: string
}

// Copiloto (Consultor): propone cambios a la configuración del agente
export interface CopilotResponse {
  respuesta: string
  edits?: {
    factSheet?: any
    agente?: any
  }
  aviso?: string
  usage?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

// Debrief post-llamada: lo que el cerebro extrae del dictado del vendedor (preview editable).
export interface DebriefPreview {
  outcome: string            // interesado | agendado | pensándolo | pidió_info | no_contesta | no_interesado | pagó | otro
  objecion: string | null
  proximoPaso: string | null
  fechaISO: string | null
  resumen: string
}

// Programa/campaña del tenant (selector del Flow Builder).
export interface CampaignLite {
  id: number
  slug: string
  nombre: string
  activa: boolean
  tieneFlow: boolean                  // si ya tiene un flujo editado guardado
}

// Alta desde el CRM (POST /v2/campaigns). `borrador:true` guarda parcial sin validar
// el contrato (campaña pendiente de completar = estado válido, no defecto).
export interface CreateCampaignRequest {
  nombre: string
  slug?: string
  vendorId?: number
  triggers?: string[]
  steps?: { tipo: string; mensaje: string; followupHrs?: number | null }[]
  config?: Record<string, any> | null
  borrador?: boolean
  activa?: boolean
}

export interface CampaignDetail {
  id: number
  slug: string
  nombre: string
  activa: boolean
  version: number
  factSheet: Record<string, any>
  agente: Record<string, any>
  triggers: string[]
  steps: unknown[]
}

// Paginación opt-in de GET /v2/leads (?limit&?offset&?q&?stage&?label). Sin ?limit ni
// ?offset, la API devuelve el array legacy LeadListItem[].
//
// Búsqueda y filtros se resuelven en el SERVIDOR sobre toda la bandeja (Hito B2). Filtrar en
// el navegador solo habría trabajado sobre la página visible, y eso se presenta como resultado
// completo cuando no lo es: el lead que el vendedor buscaba podía estar en la página 3 y no
// aparecer nunca. `total` es el número de leads que cumplen el filtro (no el de la página),
// para que la interfaz pueda decirlo con verdad.
export interface LeadsPage {
  items: LeadListItem[]
  page: { limit: number; offset: number; hasMore: boolean; total: number }
}
