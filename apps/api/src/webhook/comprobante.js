// src/webhook/comprobante.js — la regla del COMPROBANTE de pago, en UN solo sitio.
//
// POR QUÉ EXISTE (sep 2026). Esta lógica vivía dentro de event-router.js, o sea dentro
// del camino de Evolution. Cuando el mismo lead manda su captura de Yape por la API
// oficial de Meta, el webhook es otro (whatsapp/cloud/router.js) y ese camino NO la
// tenía: la foto se describía como una foto cualquiera, el bot seguía vendiendo como si
// nada y NADIE avisaba al vendedor de que el lead ya había pagado. Con el cutover a
// Cloud API pura eso dejaba de ser un detalle: era perder la venta ya cerrada.
//
// Aquí queda la regla compartida por los dos proveedores:
//   · esPosibleComprobante() — decide si la imagen merece el camino de pago.
//   · escalarAHumano()       — lo CRÍTICO y síncrono: el bot se calla, manda un humano.
//   · avisarComprobante()    — el enriquecimiento: leer la imagen y avisar al vendedor.

import { STAGES, MODES } from '../state/stage-definitions.js'
import { leerComprobante } from '../lib/vision.js'
import { notificarEscalamiento } from './notifications.js'

// Solo en estas etapas tiene sentido esperar un pago.
export const STAGES_ESPERANDO_COMPROBANTE = new Set([
  STAGES.CALL_SCHEDULING,
  STAGES.CALL_CONFIRMED,
  STAGES.POST_CLOSE
])

/**
 * ¿Esta imagen es probablemente el COMPROBANTE de pago?
 *
 * Se exigen AMBAS condiciones (criterio original, jun 2026):
 *   a) la etapa es de pago (call_scheduling en adelante), Y
 *   b) el BOT pidió el comprobante hace poco (sus últimos 3 mensajes lo mencionan).
 *
 * Sin (b), CUALQUIER imagen en esas etapas (un pantallazo, un meme) escalaría a
 * HUMAN_ACTIVE y dejaría al lead muerto para el bot. Forense > entusiasmo.
 */
export async function esPosibleComprobante(prisma, leadId, leadState = undefined) {
  try {
    const st = leadState === undefined
      ? await prisma.leadState.findUnique({ where: { leadId } })
      : leadState
    const stage = st?.currentStage || STAGES.FIRST_CONTACT
    if (!STAGES_ESPERANDO_COMPROBANTE.has(stage)) return false

    const ultimosBot = await prisma.message.findMany({
      where: { leadId, origen: 'BOT' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { texto: true }
    })
    return ultimosBot.some(m => /comprobante|captura|voucher|yape|constancia de pago/i.test(m.texto || ''))
  } catch (err) {
    // Ante la duda, NO es comprobante: la foto va al cerebro (camino seguro) en vez
    // de escalar por error y dejar al lead sin bot.
    console.error(`[Comprobante] esPosibleComprobante(${leadId}) falló:`, err.message)
    return false
  }
}

/**
 * Lo crítico y SÍNCRONO: el bot se calla y el lead queda a cargo de un humano.
 * Se hace antes que cualquier lectura de imagen para que un fallo de Gemini o de la
 * descarga jamás deje un pago sin dueño.
 */
export async function escalarAHumano(prisma, leadId) {
  // HITO A4 (oct 2026): PAUSED es TERMINAL y no se toca. Antes este update escribía
  // HUMAN_ACTIVE sin condición: un lead en pausa (rechazo/cierre del cerebro) que mandaba
  // su comprobante se reanimaba solo — un cambio de modo NO autorizado, hecho por una regla
  // automática, sobre una conversación que el operador había cerrado. Ahora solo se escala
  // lo que está en modo bot; PAUSED se queda quieto (y su aviso al humano se manda igual,
  // porque un pago sigue siendo un pago).
  const r = await prisma.leadState.updateMany({
    where: { leadId, NOT: { currentMode: MODES.PAUSED } },
    data: { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() }
  })
  return { escalado: r.count > 0 }
}

/**
 * El enriquecimiento: lee la imagen con el modelo multimodal y avisa al vendedor.
 * NUNCA tira — el escalamiento ya ocurrió, esto solo mejora el briefing. Si no se pudo
 * leer (o no hay bytes), el vendedor igual recibe el aviso con "revisar manualmente".
 *
 * Seguridad: los datos del comprobante (monto, nº de operación, nombres) NO se loguean.
 * Van solo a la notificación del vendedor — los logs de Render son un sitio público.
 */
export async function avisarComprobante({
  leadId, telefono, nombre = null, slots = {}, vendorId = 1, stage,
  tenantId = null, base64 = null, mimeType = null
}) {
  let briefingLinea = '⚠️ No pude leer la imagen automáticamente — revísala manualmente.'
  let motivo = '💰 Posible COMPROBANTE de pago recibido — validar y confirmar inscripción'

  try {
    if (base64) {
      const lectura = await leerComprobante({ base64, mimeType: mimeType || 'image/jpeg', tenantId })
      if (lectura.ok && lectura.esComprobante) {
        const d = lectura.datos
        const partes = [
          d.metodo, d.monto,
          d.nombreDestino ? `a ${d.nombreDestino}` : '',
          d.numeroOperacion ? `op ${d.numeroOperacion}` : '',
          d.fecha
        ].filter(Boolean)
        briefingLinea = `🧾 ${partes.join(' · ') || lectura.resumen}`
        motivo = '💰 COMPROBANTE de pago recibido y LEÍDO — validar y confirmar inscripción'
        console.log(`[Comprobante] 🧾 Leído lead ${leadId} (datos extraídos OK → notificación al vendedor)`)
      } else if (lectura.ok && !lectura.esComprobante) {
        briefingLinea = `🤔 La imagen NO parece un comprobante (${lectura.resumen}). El lead está en etapa de pago — revisar.`
        console.log(`[Comprobante] 🤔 Imagen no parece comprobante lead ${leadId} (en etapa de pago → revisar)`)
      }
    }
  } catch (err) {
    console.error(`[Comprobante] Error leyendo comprobante lead ${leadId}:`, err.message)
  }

  await notificarEscalamiento({
    leadId, telefono, nombre, slots, vendorId,
    motivo, stage: stage || STAGES.FIRST_CONTACT,
    dataExtra: { briefingLinea }
  })
}

// Acuse NEUTRO al lead que acaba de mandar su pago. Sin marca ni vertical: el discurso
// de venta lo redacta el cerebro, aquí solo se acusa recibo para que no quede en visto.
export const ACUSE_COMPROBANTE =
  '¡Recibido! 🙌 Dame un momento para revisarlo y te confirmo, ¿ya? Gracias por la espera 🙏'

export const COMPROBANTE_VERSION = 'v1_compartido_evolution_y_cloud'
