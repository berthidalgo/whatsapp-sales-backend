// src/whatsapp/send.js — Hidata v20 · SELECTOR de proveedor de envío
//
// Punto único de envío a WhatsApp para quien NO tiene el canal a mano (compatibilidad).
// Si el llamador pasa `canal`, manda el canal (ver transporte.js): así un cliente en la
// API oficial de Meta y otro en Evolution conviven en el mismo deploy. Sin `canal`, se
// usa el interruptor global WHATSAPP_PROVIDER (default 'evolution'), como antes.
//
// Contrato de retorno idéntico en ambos proveedores:
// { ok, sent, messageId, status, latency_ms, error, errors }.

import { summarizeSendResult } from '../webhook/sender.js'
import { sendTemplateCloud } from './cloud/sender.js'
import { isCloudProvider } from './cloud/config.js'
import { enviarTexto, transporteDe } from './transporte.js'

export async function sendToWhatsApp({ telefono, text, instanceName = null, canal = null }) {
  return enviarTexto({ canal, telefono, texto: text, instancia: instanceName })
}

// Reexports: para mensajes fuera de ventana 24h (solo Cloud) y el resumen de logs.
export { sendTemplateCloud, summarizeSendResult }

/** Proveedor efectivo: el del canal si se pasa; si no, el interruptor global. */
export function proveedorActivo(canal = null) {
  return canal ? transporteDe(canal) : (isCloudProvider() ? 'cloud' : 'evolution')
}
