// src/lib/mediaStore.js — persistencia de media ENTRANTE (costura de storage).
// Hoy storage='pg': los bytes viven en Postgres y se sirven por un endpoint propio
// con JWT+scope → CERO URL pública = no se filtra la PII financiera del comprobante
// (monto Yape, nº de operación, nombres). Migrable a Supabase Storage (bucket PRIVADO
// + signed URLs) sin tocar los call sites: solo cambia el branch por `storage`.

const MAX_BYTES = 8 * 1024 * 1024  // 8MB: las imágenes de WhatsApp son chicas; evita
                                   // meter blobs gigantes en la BD compartida con prod.
const TIPOS_OK = new Set(['image', 'audio'])

// Valida sin guardar (pura, exportada para test). { ok, error? }.
export function validarMedia({ tipo, base64 }) {
  if (!TIPOS_OK.has(tipo)) return { ok: false, error: 'tipo_no_soportado' }
  if (!base64 || typeof base64 !== 'string') return { ok: false, error: 'sin_base64' }
  const approxBytes = Math.floor(base64.length * 3 / 4)  // base64 → bytes aprox
  if (approxBytes > MAX_BYTES) return { ok: false, error: 'demasiado_grande' }
  return { ok: true }
}

// Persiste media entrante. NUNCA tira (es fire-and-forget desde el webhook): devuelve
// { ok, id? , error? }. Un fallo aquí jamás debe tumbar el flujo del cerebro.
export async function saveInboundMedia(prisma, { leadId, messageId, tenantId, origen = 'LEAD', tipo, mimeType, base64 }) {
  try {
    const v = validarMedia({ tipo, base64 })
    if (!v.ok) return v
    const buf = Buffer.from(base64, 'base64')
    const row = await prisma.mediaAsset.create({
      data: {
        leadId,
        messageId: messageId ?? null,
        tenantId: tenantId ?? null,
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
    select: { id: true, leadId: true, tipo: true, mimeType: true, storage: true, bytes: true, url: true },
  })
}
