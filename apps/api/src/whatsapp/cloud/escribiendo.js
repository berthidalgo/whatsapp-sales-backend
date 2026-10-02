// src/whatsapp/cloud/escribiendo.js — «leído» + «escribiendo…» mientras el bot piensa (sep 2026)
//
// POR QUÉ EXISTE (lo aprendido del ejemplo oficial de Meta, Jasper's Market): el ejemplo
// marca el mensaje del cliente como leído y muestra «escribiendo…» ANTES de cada respuesta.
// En nuestro bot pesa más: entre que el cliente escribe y contesta el cerebro pasan ~6 s de
// debounce + varios de LLM, y con una nota de voz se suman la descarga y la transcripción.
// Sin señal alguna, el cliente ve silencio y a veces escribe otra vez "¿hola?", que dispara
// otro turno. Con los ✓✓ azules y «escribiendo…» sabe que está siendo atendido.
//
// REGLAS (de Meta y de sentido común):
//   · El indicador dura hasta 25 s o hasta que sale la respuesta. Meta pide mostrarlo SOLO
//     si de verdad se va a responder → se aplica la MISMA compuerta que usa el cerebro
//     (brain-pipeline): PAUSED calla siempre; HUMAN_ACTIVE calla, salvo que el cerebro vaya a
//     retomar solo porque nadie atendió en HUMAN_ACTIVE_RESUME_HORAS (debeAutoReanudar).
//   · Si el turno tarda más de 25 s, el indicador se apaga antes de la respuesta: es el techo
//     de Meta. No se "refresca" a mitad del turno a propósito — un refresco que llegue a Meta
//     DESPUÉS de la respuesta dejaría «escribiendo…» pegado 25 s sobre un chat ya contestado.
//   · Es de mejor esfuerzo: si falla (token vencido, red, mensaje muy viejo) se registra y
//     se sigue. NUNCA frena ni rompe el turno; por eso el llamador no lo espera.
//   · Apagable sin desplegar: CLOUD_TYPING_INDICATOR=false.
//   · Es gratis: marcar como leído no genera cobro.

import prismaDefault from '../../db/prisma.js'
import { MODES } from '../../state/stage-definitions.js'
import { debeAutoReanudar } from '../../brain/brain-pipeline.js'
import { marcarLeidoCloud } from './sender.js'
import { credencialesCloud } from '../transporte.js'

export function escribiendoHabilitado(env = process.env) {
  return String(env.CLOUD_TYPING_INDICATOR ?? 'true').trim().toLowerCase() !== 'false'
}

/**
 * @param {{messageId:string|null, leadId:number, canal:object|null}} a
 * @param {object} [deps] inyectables para tests
 * @returns {Promise<{enviado:boolean, motivo:string|null}>}
 */
export async function indicarEscribiendo({ messageId, leadId, canal }, deps = {}) {
  const d = { prisma: prismaDefault, enviar: marcarLeidoCloud, env: process.env, debeAutoReanudar, ...deps }
  if (!escribiendoHabilitado(d.env)) return { enviado: false, motivo: 'desactivado' }
  if (!messageId) return { enviado: false, motivo: 'sin_message_id' }
  // En coexistencia el dueño también atiende desde la app del celular, y ahí los chats sin
  // leer son su lista de pendientes: si el bot los marcara leídos al instante, se le
  // borrarían. (`canal.modo` lo trae channels.modo cuando el resolver lo seleccione.)
  if (canal?.modo === 'coexistencia') return { enviado: false, motivo: 'coexistencia' }

  try {
    const estado = await d.prisma.leadState.findUnique({ where: { leadId }, select: { currentMode: true, modeEnteredAt: true } })
    const modo = estado?.currentMode
    if (modo === MODES.PAUSED || (modo === MODES.HUMAN_ACTIVE && !d.debeAutoReanudar(estado))) {
      return { enviado: false, motivo: 'humano_o_pausa' }
    }
    const r = await d.enviar({ messageId, escribiendo: true, credenciales: credencialesCloud(canal) })
    if (!r.ok) {
      console.warn(`[CloudEscribiendo] no se pudo marcar leído ${messageId}: ${r.error} ${(r.errors || []).join(' ')}`.trim())
      return { enviado: false, motivo: r.error || 'error' }
    }
    return { enviado: true, motivo: null }
  } catch (err) {
    console.warn(`[CloudEscribiendo] error con ${messageId}: ${err.message}`)
    return { enviado: false, motivo: 'excepcion' }
  }
}

export const CLOUD_ESCRIBIENDO_VERSION = 'v2_misma_compuerta_que_el_cerebro'
