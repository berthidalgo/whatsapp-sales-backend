// src/lib/mediaStore.js — persistencia de media ENTRANTE (costura de storage).
// Hoy storage='pg': los bytes viven en Postgres y se sirven por un endpoint propio
// con JWT+scope → CERO URL pública = no se filtra la PII financiera del comprobante
// (monto Yape, nº de operación, nombres). Migrable a Supabase Storage (bucket PRIVADO
// + signed URLs) sin tocar los call sites: solo cambia el branch por `storage`.

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024  // 8MB: las imágenes de WhatsApp son chicas; evita
                                   // meter blobs gigantes en la BD compartida con prod.
// document y video entraron en sep 2026: con la API oficial de Meta un comprobante puede
// llegar como PDF y un reclamo como video, y antes esos mensajes no dejaban ni rastro en
// la bandeja. El tope de 8MB los filtra solo: un video largo se rechaza con
// 'demasiado_grande' y el marcador del timeline igual queda (el vendedor sabe que existió).
const TIPOS_OK = new Set(['image', 'audio', 'document', 'video'])

// Valida sin guardar (pura, exportada para test). { ok, error? }.
export function validarMedia({ tipo, base64 }) {
  if (!TIPOS_OK.has(tipo)) return { ok: false, error: 'tipo_no_soportado' }
  if (!base64 || typeof base64 !== 'string') return { ok: false, error: 'sin_base64' }
  const approxBytes = Math.floor(base64.length * 3 / 4)  // base64 → bytes aprox
  if (approxBytes > MAX_MEDIA_BYTES) return { ok: false, error: 'demasiado_grande' }
  return { ok: true }
}

// Persiste media entrante. NUNCA tira (es fire-and-forget desde el webhook): devuelve
// { ok, id? , error? }. Un fallo aquí jamás debe tumbar el flujo del cerebro.
//
// Dueño obligatorio: cada fila queda con el tenantId del lead (muro multitenant).
// Si el llamador no lo trae, se resuelve desde el lead; sin lead no hay dueño
// posible y se rechaza con 'sin_tenant' (la columna es nullable solo por filas
// históricas; el serving exige el doble guard lead-en-scope + media.leadId).
export async function saveInboundMedia(prisma, { leadId, messageId, tenantId, origen = 'LEAD', tipo, mimeType, base64 }) {
  try {
    const v = validarMedia({ tipo, base64 })
    if (!v.ok) return v
    if (!leadId) return { ok: false, error: 'sin_lead' }
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { tenantId: true } })
    const dueno = lead?.tenantId || null
    if (!dueno) return { ok: false, error: 'sin_tenant' }
    if (tenantId && tenantId !== dueno) return { ok: false, error: 'tenant_incompatible' }
    if (messageId != null) {
      const mensaje = await prisma.message.findFirst({ where: { id: messageId, leadId }, select: { id: true } })
      if (!mensaje) return { ok: false, error: 'mensaje_incompatible' }
    }
    const buf = Buffer.from(base64, 'base64')
    const row = await prisma.mediaAsset.create({
      data: {
        leadId,
        messageId: messageId ?? null,
        tenantId: dueno,
        origen,
        tipo,
        mimeType: mimeType || 'application/octet-stream',
        storage: 'pg',
        bytes: buf,
        sizeBytes: buf.length,
      },
      select: { id: true },
    })
    return { ok: true, id: row.id }
  } catch (error) {
    console.error('[mediaStore] saveInboundMedia:', error.message)
    return { ok: false, error: error.message }
  }
}

// Lee una media por id (para el endpoint de serving). Trae los bytes.
export async function getMedia(prisma, id) {
  return prisma.mediaAsset.findUnique({
    where: { id },
    select: { id: true, leadId: true, tenantId: true, tipo: true, mimeType: true, storage: true, bytes: true, url: true },
  })
}
