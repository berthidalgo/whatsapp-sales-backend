// src/whatsapp/send.js — Hidata v20 · SELECTOR de proveedor de envío
//
// Punto único de envío a WhatsApp. Según WHATSAPP_PROVIDER (default 'evolution')
// usa Evolution (lo de hoy) o Cloud API (Meta). Ambos senders tienen la MISMA firma
// y el MISMO contrato de retorno, así que es transparente para quien envía
// (notifications.js, followupEngine.js, event-router.js).
//
// Default = evolution → CERO cambio de comportamiento hoy. Al tener el número nuevo:
// WHATSAPP_PROVIDER=cloud + credenciales → todo sale por Meta sin tocar a quien llama.

import { sendToWhatsApp as sendEvolution, summarizeSendResult } from '../webhook/sender.js'
import { sendToWhatsAppCloud, sendTemplateCloud } from './cloud/sender.js'
import { isCloudProvider } from './cloud/config.js'

export async function sendToWhatsApp(args) {
  return isCloudProvider() ? sendToWhatsAppCloud(args) : sendEvolution(args)
}

// Reexports: para mensajes fuera de ventana 24h (solo Cloud) y el resumen de logs.
export { sendTemplateCloud, summarizeSendResult }

export function proveedorActivo() {
  return isCloudProvider() ? 'cloud' : 'evolution'
}
