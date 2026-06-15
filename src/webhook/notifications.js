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
 * @param {object?} args.dataExtra          - data extra para el payload/briefing. Campos opcionales: { briefingLinea } (data del comprobante leído) · { comoCerrarlo } (inteligencia comercial IA del cerebro → bloque 🎯 CÓMO CERRARLO)
 * @returns {Promise<{ sent: boolean, persisted: boolean }>}
 */
export async function notificarEscalamiento({
  leadId, telefono, nombre = null, slots = {}, vendorId = 1,
  motivo, ultimoMensajeLead = null, respuestaBot = null, stage = null, dataExtra = null,
  nombrePrograma = 'Mi Primera Exportación'
}) {
  // Formato RICO (recuperado del sistema viejo): perfil del lead + sus palabras +
  // motivo + data del comprobante si aplica. Solo se muestran las líneas con dato.
  const DIV = '━━━━━━━━━━━━━━━━━━━━━━━━━━'
  const nom = nombre || slots.nombre || null
  const lineas = [
    DIV,
    `🟡 *LEAD PARA ATENDER* · ${nombrePrograma}`,
    DIV,
    `https://wa.me/${String(telefono).replace(/\D/g, '')}`,
    DIV,
    `👤  ${nom || '(nombre por confirmar)'}`,
    `📦  ${slots.producto || '(producto por confirmar)'}`,
    `🏢  ${slots.empresa || '(situación por confirmar)'}`,
    `🌱  ${slots.experiencia || '(experiencia por confirmar)'}`
  ]
  if (slots.pais_destino) lineas.push(`🌍  ${slots.pais_destino}`)
  lineas.push(DIV)
  lineas.push(`📌  ${motivo}`)
  if (dataExtra?.briefingLinea) lineas.push(`    ${dataExtra.briefingLinea}`)
  if (slots.fecha_hora) lineas.push(`📅  Cita: ${slots.fecha_hora}`)
  if (ultimoMensajeLead) {
    lineas.push(DIV)
    lineas.push(`💬  Con sus palabras:`)
    lineas.push(`    "${String(ultimoMensajeLead).slice(0, 220)}"`)
  }
  // Inteligencia comercial (la genera el cerebro en el turno del escalamiento).
  // Solo aparece si vino con contenido — el camino del comprobante no la trae.
  if (dataExtra?.comoCerrarlo) {
    lineas.push(DIV)
    lineas.push(`🎯  CÓMO CERRARLO`)
    // Cap defensivo: si el modelo se desboca, no empujamos el cierre del briefing
    // contra el límite de 4096 del sender.
    const consejo = String(dataExtra.comoCerrarlo).trim().slice(0, 600)
    for (const l of consejo.split('\n')) {
      if (l.trim()) lineas.push(`    ${l.trim()}`)
    }
  }
  lineas.push(DIV)
  lineas.push(`⚡  Atiéndelo pronto, no lo dejes enfriar`)
  lineas.push(DIV)
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
