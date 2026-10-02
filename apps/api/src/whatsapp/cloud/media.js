// src/whatsapp/cloud/media.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Descarga de media (imágenes/comprobantes) en Cloud API. A diferencia de Evolution
// (que da el base64 directo), Meta da un media_id y son DOS pasos:
//   1. GET /{media_id}        → devuelve una URL temporal + mime_type
//   2. GET {esa URL}          → el binario (requiere el Bearer token igual)
// Devuelve { ok, base64, mimeType } — mismo shape que consume vision.js (leerComprobante).

import { resolverCredencialesCloud, cloudReady } from './config.js'
import { MAX_MEDIA_BYTES } from '../../lib/mediaStore.js'

const TIMEOUT_MS = 15000

// credenciales: las del canal del cliente (multitenant); sin ellas, las del entorno.
export async function descargarMediaCloud(mediaId, credenciales = null) {
  if (!mediaId) return { ok: false, error: 'media_id_required' }
  const c = resolverCredencialesCloud(credenciales)
  if (!cloudReady(c)) return { ok: false, error: 'cloud_not_configured' }

  // ── Paso 1: metadata del media (URL temporal) ──
  const meta = await getJson(`${c.graphBase}/${mediaId}`, c.accessToken)
  if (!meta.ok) return { ok: false, error: `media_meta_${meta.status || 'err'}`, detail: meta.error }
  const url = meta.data?.url
  const mimeType = meta.data?.mime_type || null
  if (!url) return { ok: false, error: 'media_url_missing' }
  if (Number(meta.data?.file_size) > MAX_MEDIA_BYTES) return { ok: false, error: 'demasiado_grande' }

  // ── Paso 2: descargar el binario (la URL de Meta también exige el token) ──
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${c.accessToken}` }, signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `media_bin_${res.status}` }
    if (Number(res.headers.get('content-length')) > MAX_MEDIA_BYTES) {
      await res.body?.cancel()
      return { ok: false, error: 'demasiado_grande' }
    }
    const chunks = []; let total = 0
    for await (const chunk of res.body || []) {
      total += chunk.length
      if (total > MAX_MEDIA_BYTES) { ctrl.abort(); return { ok: false, error: 'demasiado_grande' } }
      chunks.push(Buffer.from(chunk))
    }
    const buf = Buffer.concat(chunks, total)
    return { ok: true, base64: buf.toString('base64'), mimeType }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'fetch_error', detail: e.message }
  } finally { clearTimeout(timer) }
}

async function getJson(url, token) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
    clearTimeout(timer)
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error?.message || `http_${res.status}`) }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, status: null, data: null, error: e.message }
  }
}

export const CLOUD_MEDIA_VERSION = 'v2_credenciales_por_canal'
