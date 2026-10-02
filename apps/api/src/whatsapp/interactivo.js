// src/whatsapp/interactivo.js — opciones que el cliente puede TOCAR, por el transporte del canal (sep 2026)
//
// Es la contraparte de transporte.js para mensajes interactivos. Quien quiera "preguntar y
// ofrecer opciones" no debería saber si el canal es Meta o Evolution:
//   · Meta (Cloud API)  → botones (hasta 3) o lista (hasta 10): el cliente toca y listo.
//   · Evolution         → las mismas opciones como texto numerado ("1) …  2) …").
//
// LÍMITE que sigue valiendo: los interactivos son mensajes LIBRES, así que solo entran
// dentro de la ventana de 24 h (igual que el texto). Fuera de ella, Meta responde 131047
// y hace falta una plantilla (ver cloud/plantillas.js).
//
// PERSISTENCIA: el resultado trae `texto` — las opciones como texto numerado. Es lo que el
// llamador debe guardar en `messages` (con reciboDeEnvio), para que la bandeja muestre qué
// se ofreció y el cerebro, que arma su memoria con esa tabla, sepa qué opciones dio.
// Cuando el cliente toca una, el webhook trae el título como texto y el id en
// `interactiveId` (llega al turno en la metadata del debounce).
//
// Nada llama a esto todavía: es la pieza lista para que el cerebro o el flow-builder
// ofrezcan opciones. La decisión de DÓNDE conviene (p. ej. el cierre: «Sí, pedirlo» /
// «Tengo una duda» / «Hablar con un asesor») es de producto, no de infraestructura.

import { sendInteractiveCloud } from './cloud/sender.js'
import { interactivoDeOpciones, opcionesComoTexto } from './cloud/interactivos.js'
import { transporteDe, credencialesCloud, enviarTexto } from './transporte.js'

/**
 * @param {object} a
 * @param {object|null} a.canal        canal resuelto (channel-resolver)
 * @param {string} a.telefono          teléfono del lead (o su BSUID en Meta)
 * @param {string} a.cuerpo            el texto que acompaña a las opciones
 * @param {{id:string,titulo:string,descripcion?:string}[]} a.opciones
 * @param {string} [a.pie]
 * @param {string|null} [a.instancia]  instancia de Evolution (solo aplica a Evolution)
 * @returns el contrato de enviarTexto ({ ok, sent, messageId, status, latency_ms, error, errors })
 *          + `texto` (qué guardar en el historial) + `formato` ('botones'|'lista'|'texto')
 */
export async function enviarOpciones({ canal = null, telefono, cuerpo, opciones, pie, instancia = null }) {
  const texto = opcionesComoTexto(cuerpo, opciones)
  const comoTexto = async () => ({ ...(await enviarTexto({ canal, telefono, texto, instancia })), texto, formato: 'texto' })

  if (transporteDe(canal) !== 'cloud') return comoTexto()
  let interactive
  try {
    interactive = interactivoDeOpciones({ cuerpo, opciones, pie })
  } catch (err) {
    // Opciones mal armadas (título largo, id repetido…): mejor texto plano que nada.
    console.warn(`[Interactivo] opciones inválidas (${err.message}) → se envía como texto`)
    return comoTexto()
  }
  const r = await sendInteractiveCloud({ telefono, interactive, credenciales: credencialesCloud(canal) })
  return { ...r, texto, formato: interactive.type === 'list' ? 'lista' : 'botones' }
}

export const INTERACTIVO_VERSION = 'v2_devuelve_texto_para_el_historial'
