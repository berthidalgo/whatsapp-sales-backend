// src/whatsapp/transporte.js — POR DÓNDE SALE CADA MENSAJE (sep 2026)
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   El proveedor de WhatsApp era un interruptor GLOBAL (WHATSAPP_PROVIDER): todo el
//   deploy hablaba por Evolution o todo por Meta. En un SaaS multitenant eso no sirve:
//   un cliente puede estar en la API oficial de Meta y otro todavía en Evolution, y
//   cada uno tiene SUS credenciales. La tabla `channels` ya lo modelaba
//   (provider + externalKey + credenciales); faltaba que el envío lo respetara.
//
//   Además, el camino de Meta tenía su propio pipeline copiado a mano, sin kill-stale,
//   sin lock y sin la foto de precios. Ahora los dos proveedores comparten el MISMO
//   turno (webhook/handler.js) y solo difieren aquí, en el último metro.
//
// REGLA: el canal del turno manda (channel.provider). Sin canal, cae al interruptor
// global (compatibilidad con los followups y con el deploy de un solo cliente).
// ─────────────────────────────────────────────────────────────────────────

import { sendToWhatsApp as enviarEvolution, sendMediaToWhatsApp as enviarImagenEvolution } from '../webhook/sender.js'
import { sendToWhatsAppCloud, sendImageCloud, sendTemplateCloud } from './cloud/sender.js'
import { isCloudProvider } from './cloud/config.js'

/** 'cloud' | 'evolution' para este canal. */
export function transporteDe(canal) {
  const p = String(canal?.provider || '').toLowerCase()
  if (p === 'cloud' || p === 'evolution') return p
  return isCloudProvider() ? 'cloud' : 'evolution'
}

/**
 * Credenciales de Meta del canal. El phone_number_id ES la llave de routing del canal
 * (externalKey), así que se toma de ahí si `credenciales` no lo trae. El token puede
 * venir del canal (cliente con su propia cuenta de Meta) o del entorno (número propio).
 */
export function credencialesCloud(canal) {
  if (!canal) return null
  const c = canal.credenciales || {}
  const phoneNumberId = c.phoneNumberId || (transporteDe(canal) === 'cloud' ? canal.externalKey : null) || null
  const accessToken = c.accessToken || null
  if (!phoneNumberId && !accessToken) return null
  return { phoneNumberId, accessToken }
}

/**
 * Envía un texto por el transporte del canal.
 * @param {object} args
 * @param {object|null} args.canal     - canal resuelto (channel-resolver) o null
 * @param {string}      args.telefono  - teléfono del lead (o su BSUID en Meta)
 * @param {string}      args.texto
 * @param {string|null} args.instancia - instancia de Evolution (solo aplica a Evolution)
 */
export async function enviarTexto({ canal = null, telefono, texto, instancia = null }) {
  if (transporteDe(canal) === 'cloud') {
    return sendToWhatsAppCloud({ telefono, text: texto, credenciales: credencialesCloud(canal) })
  }
  return enviarEvolution({ telefono, text: texto, instanceName: instancia })
}

/** Envía una imagen (base64) por el transporte del canal. */
export async function enviarImagen({ canal = null, telefono, base64, mimetype, fileName, caption = '', instancia = null }) {
  if (transporteDe(canal) === 'cloud') {
    return sendImageCloud({ telefono, base64, mimetype, fileName, caption, credenciales: credencialesCloud(canal) })
  }
  return enviarImagenEvolution({ telefono, base64, mimetype, fileName, caption, instanceName: instancia })
}

/** Plantilla aprobada (solo Meta; Evolution no tiene ese concepto). */
export async function enviarPlantilla({ canal = null, telefono, templateName, languageCode = 'es', components = [] }) {
  return sendTemplateCloud({ telefono, templateName, languageCode, components, credenciales: credencialesCloud(canal) })
}

export const TRANSPORTE_VERSION = 'v1_por_canal'
