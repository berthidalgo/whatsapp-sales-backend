// src/whatsapp/cloud/config.js — Hidata v20 · WhatsApp Cloud API (Meta)
//
// Config del proveedor oficial de Meta, operativo en este proyecto. El número
// del despliegue usa el entorno; los demás canales usan sus credenciales de BD.
// La recepción exige firma válida y el envío exige las credenciales del número.
//
// Variables del número del despliegue:
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

// Un canal ajeno al número del deploy requiere su propio token; nunca mezcla
// un phone_number_id del cliente con las credenciales globales de otro número.
export function resolverCredencialesCloud(credenciales = null) {
  const env = cloudConfig()
  const phoneNumberId = credenciales ? credenciales.phoneNumberId : env.phoneNumberId
  const accessToken = credenciales?.accessToken || (phoneNumberId === env.phoneNumberId ? env.accessToken : null)
  return { ...env, phoneNumberId, accessToken }
}

/**
 * ¿Está Cloud API listo para ENVIAR? Necesita al menos phoneNumberId + accessToken.
 * Se usa como guard antes de cualquier llamada a Graph.
 */
export function cloudReady(credenciales = null) {
  const c = credenciales || cloudConfig()
  return !!(c.phoneNumberId && c.accessToken)
}

/**
 * ¿Recibimos webhooks de Meta? Basta con tener el app secret (la firma es obligatoria).
 * Es independiente de WHATSAPP_PROVIDER: con varios clientes, unos pueden estar en Cloud
 * y otros en Evolution a la vez; el proveedor de cada uno lo dice su canal.
 */
export function cloudWebhookHabilitado() {
  return !!cloudConfig().appSecret
}

/** ¿Es Cloud el proveedor activo? (default = evolution, no rompe producción) */
export function isCloudProvider() {
  return (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase() === 'cloud'
}

export const CLOUD_CONFIG_VERSION = 'v1'
