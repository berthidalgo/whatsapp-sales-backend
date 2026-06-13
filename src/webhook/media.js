// src/webhook/media.js — Hidata v20 · Fase B.1+ (Etapa 2)
//
// Descarga y descifra una imagen/media que el lead envió por WhatsApp. La `url`
// del imageMessage de Baileys viene ENCRIPTADA (necesita la mediaKey para
// descifrar), así que no se puede bajar directo: hay que pedirle a Evolution que
// la devuelva en base64 ya descifrada.
//
// Evolution API v2.3.7: POST /chat/getBase64FromMediaMessage/{instance}
// La forma EXACTA de la respuesta varía por versión → leemos defensivo (varios
// nombres de campo posibles) y logueamos el crudo si no encontramos el base64,
// para ajustarlo con datos reales en la primera imagen de prueba.

const TIMEOUT_MS = 20000   // descargar+descifrar una imagen puede tardar algo

/**
 * @param {object} args
 * @param {string} args.instanceName
 * @param {object} args.messageKey  - { id, remoteJid, fromMe } del mensaje con la imagen
 * @returns {Promise<{ ok, base64?, mimeType?, error? }>}
 */
export async function descargarMediaBase64({ instanceName, messageKey }) {
  const baseUrl = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!baseUrl || !apiKey) return { ok: false, error: 'env_evolution_missing' }
  if (!instanceName || !messageKey?.id) return { ok: false, error: 'datos_insuficientes' }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${instanceName}`
  const body = { message: { key: messageKey }, convertToMp4: false }

  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    clearTimeout(to)
    const data = await r.json().catch(() => null)
    if (!r.ok) {
      return { ok: false, error: `http_${r.status}: ${JSON.stringify(data)?.slice(0, 200)}` }
    }
    // Lectura defensiva: distintas versiones devuelven el base64 con distinto nombre
    const base64 = data?.base64 || data?.media?.base64 || data?.media || data?.data || null
    const mimeType = data?.mimetype || data?.mimeType || data?.media?.mimetype || 'image/jpeg'
    if (!base64 || typeof base64 !== 'string') {
      console.warn(`[Media] Evolution respondió sin base64 reconocible. Crudo: ${JSON.stringify(data)?.slice(0, 300)}`)
      return { ok: false, error: 'sin_base64' }
    }
    // Algunas versiones devuelven con prefijo "data:image/...;base64,"; lo quitamos.
    const limpio = base64.includes('base64,') ? base64.split('base64,')[1] : base64
    return { ok: true, base64: limpio, mimeType }
  } catch (err) {
    clearTimeout(to)
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message }
  }
}
