// src/whatsapp/cloud/config.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Config del proveedor OFICIAL de Meta. TODO viene de env vars que se setean
// CUANDO tengamos el número nuevo. Hasta entonces, cloudReady() = false y el
// proveedor Cloud queda inerte (no se usa salvo que WHATSAPP_PROVIDER='cloud').
//
// Env vars a setear al enchufar el número (ninguna existe todavía):
//   CLOUD_PHONE_NUMBER_ID   - el Phone Number ID del WABA (NO el número en sí)
//   CLOUD_WABA_ID           - WhatsApp Business Account ID (para gestionar templates)
//   CLOUD_ACCESS_TOKEN      - token permanente / de System User
//   CLOUD_APP_SECRET        - app secret (para verificar la firma X-Hub-Signature-256)
//   CLOUD_VERIFY_TOKEN      - string que elegimos nosotros (handshake GET del webhook)
//   CLOUD_API_VERSION       - opcional, default v23.0 (Meta versiona; se sube sin tocar código)

const DEFAULT_VERSION = 'v23.0'

export function cloudConfig() {
  const apiVersion = process.env.CLOUD_API_VERSION || DEFAULT_VERSION
  return {
    apiVersion,
    phoneNumberId: process.env.CLOUD_PHONE_NUMBER_ID || null,
    wabaId:        process.env.CLOUD_WABA_ID || null,
    accessToken:   process.env.CLOUD_ACCESS_TOKEN || null,
    appSecret:     process.env.CLOUD_APP_SECRET || null,
    verifyToken:   process.env.CLOUD_VERIFY_TOKEN || null,
    graphBase:     `https://graph.facebook.com/${apiVersion}`
  }
}

/**
 * ¿Está Cloud API listo para ENVIAR? Necesita al menos phoneNumberId + accessToken.
 * Se usa como guard antes de cualquier llamada a Graph.
 */
export function cloudReady() {
  const c = cloudConfig()
  return !!(c.phoneNumberId && c.accessToken)
}

/** ¿Es Cloud el proveedor activo? (default = evolution, no rompe producción) */
export function isCloudProvider() {
  return (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase() === 'cloud'
}

export const CLOUD_CONFIG_VERSION = 'v1'
