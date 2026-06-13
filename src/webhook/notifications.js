// src/webhook/notifications.js — Hidata v20 · Fase B.1+ (notificación al escalar)
//
// Cuando el cerebro escala a humano (HUMAN_ACTIVE), HOY nadie se entera → el lead
// queda en un agujero negro (el bot se calla por la compuerta de modo y ningún
// humano sabe que debe atenderlo). Este módulo cierra ese hueco:
//   1. Le manda un WhatsApp al vendedor (NUMERO_JOAN) con un briefing.
//   2. Escribe una fila en crm_notifications (para el CRM futuro).
// Ambas cosas son BEST-EFFORT: si una falla, se loguea y NO tumba el turno del
// lead (la notificación es secundaria al flujo de la conversación).

import { randomUUID } from 'node:crypto'
import prisma from '../db/prisma.js'
import { sendToWhatsApp } from './sender.js'

/**
 * Notifica al vendedor que un lead necesita atención humana.
 *
 * @param {object} args
 * @param {number} args.leadId
 * @param {string} args.telefono            - teléfono del lead
 * @param {string?} args.nombre             - nombre del lead (slot)
 * @param {number?} args.vendorId           - vendedor asignado (default 1)
 * @param {string} args.motivo              - por qué escala (razon_escalamiento o genérico)
 * @param {string?} args.ultimoMensajeLead  - último mensaje del lead (contexto)
 * @param {string?} args.respuestaBot       - lo que el bot le respondió
 * @param {string?} args.stage              - etapa del funnel
 * @param {object?} args.dataExtra          - data extra para el payload/briefing (ej: comprobante leído)
 * @returns {Promise<{ sent: boolean, persisted: boolean }>}
 */
export async function notificarEscalamiento({
  leadId, telefono, nombre = null, vendorId = 1,
  motivo, ultimoMensajeLead = null, respuestaBot = null, stage = null, dataExtra = null
}) {
  const nombreTxt = nombre ? ` (${nombre})` : ''
  const lineas = [
    `🚨 *Lead para atender*${nombreTxt}`,
    `📱 ${telefono}`,
    `📌 ${motivo}`
  ]
  if (stage) lineas.push(`📊 Etapa: ${stage}`)
  if (dataExtra?.briefingLinea) lineas.push(dataExtra.briefingLinea)
  if (ultimoMensajeLead) lineas.push(`💬 Lead: "${String(ultimoMensajeLead).slice(0, 220)}"`)
  lineas.push('— Hidata 🤖')
  const briefing = lineas.join('\n')

  // ─── 1. WhatsApp al vendedor ───
  let sent = false
  const destino = process.env.NUMERO_JOAN
  if (destino) {
    try {
      const r = await sendToWhatsApp({
        telefono: destino,
        text: briefing,
        instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'
      })
      sent = !!r.ok
      if (!sent) console.error(`[Notif] WhatsApp al vendedor falló (lead ${leadId}): ${r.error}`)
    } catch (err) {
      console.error(`[Notif] Excepción enviando WhatsApp al vendedor (lead ${leadId}):`, err.message)
    }
  } else {
    console.warn('[Notif] NUMERO_JOAN no seteado → no se envía ping de WhatsApp al vendedor')
  }

  // ─── 2. Fila en crm_notifications (best-effort) ───
  let persisted = false
  try {
    const payload = JSON.stringify({ motivo, stage, telefono, nombre, ultimoMensajeLead, respuestaBot, ...(dataExtra || {}) })
    await prisma.$executeRaw`
      INSERT INTO crm_notifications (id, vendor_id, lead_id, priority, title, message, payload, acknowledged, created_at)
      VALUES (${randomUUID()}::uuid, ${vendorId || 1}, ${leadId}, ${'action_required'},
              ${`Lead escalado: ${motivo}`.slice(0, 120)}, ${briefing}, ${payload}::jsonb, ${false}, now())`
    persisted = true
  } catch (err) {
    console.error(`[Notif] No se pudo escribir crm_notifications (lead ${leadId}):`, err.message)
  }

  console.log(`[Notif] 🔔 Vendedor notificado del lead ${leadId} | wa:${sent ? 'ok' : 'no'} | crm:${persisted ? 'ok' : 'no'} | ${motivo}`)
  return { sent, persisted }
}
