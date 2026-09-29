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
import { enviarTexto, enviarPlantilla, transporteDe } from '../whatsapp/transporte.js'
import { reportError } from '../lib/observability.js'
import { defaultChannelForTenant } from './channel-resolver.js'
import { getVertical } from '../brain/verticals/index.js'

// ── ¿El destino es un humano de verdad? (fix sep 2026) ──
// El peritaje encontró que los avisos de BIOAYUR iban a un teléfono de RELLENO
// (51999000001, el placeholder del seed) — y el fallback NUMERO_JOAN era el número
// del PROPIO bot. En ambos casos el WhatsApp "salía" y nadie lo leía: 5 escalamientos
// sin atender, uno de ellos un pedido. Mejor fallar ruidosamente que avisar al vacío.
const RX_PLACEHOLDER = /^51(9{3}0{3}\d{3}|9{9}|0{9}|900000\d{3})$/
export function destinoInvalido(destino, { numerosDelBot = [] } = {}) {
  const d = String(destino || '').replace(/\D/g, '')
  if (!d || d.length < 9) return 'sin teléfono'
  if (RX_PLACEHOLDER.test(d)) return 'teléfono de relleno (placeholder del seed)'
  if (numerosDelBot.map(n => String(n || '').replace(/\D/g, '')).filter(Boolean).includes(d)) {
    return 'es el número del propio bot (el aviso se lo manda a sí mismo)'
  }
  return null
}

// Variables de la plantilla de aviso al vendedor (API de Meta). La plantilla aprobada
// tiene 3: {{1}} quién, {{2}} por qué, {{3}} enlace para escribirle. Meta rechaza
// variables con saltos de línea, tabulaciones o más de 4 espacios seguidos.
export function componentesAvisoVendedor({ nombre, motivo, telefono }) {
  const limpio = (t, max) => String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max) || '-'
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: limpio(nombre || 'Cliente sin nombre', 60) },
      { type: 'text', text: limpio(motivo, 200) },
      { type: 'text', text: `https://wa.me/${String(telefono || '').replace(/\D/g, '')}` }
    ]
  }]
}

// Líneas de perfil del briefing según el vertical (ver CAMPOS_BRIEFING en cada uno).
export function lineasPerfil(slots = {}, campos = []) {
  const out = []
  for (const [emoji, clave, siFalta] of campos) {
    const v = slots?.[clave]
    if (v != null && String(v).trim()) out.push(`${emoji}  ${String(v).trim()}`)
    else if (siFalta) out.push(`${emoji}  ${siFalta}`)
  }
  return out
}

/**
 * A QUIÉN y POR DÓNDE se avisa (fix forense jul 2026).
 *
 * ANTES era global para todos los clientes:
 *   destino  = process.env.NUMERO_JOAN
 *   instancia= process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'
 *
 * O sea: si el bot de BIOAYUR escalaba un lead, el aviso salía por el número de
 * Perú Exporta hacia el dueño de Perú Exporta. El dueño de BIOAYUR NUNCA se
 * enteraba. Eso convirtió el escalamiento en un agujero negro: el peritaje del
 * 23-jul-2026 halló 9 leads escalados sin atender, uno de 16 días, y un pedido de
 * colágeno ya cerrado (Puno) que murió 30 segundos después de escalar.
 *
 * Ahora el aviso viaja por el CANAL DEL TENANT hacia el VENDEDOR del lead. Las env
 * vars quedan solo como red de compatibilidad para el deploy single-tenant.
 */
async function destinoDeNotificacion(vendorId) {
  let vendor = null
  try {
    if (vendorId) {
      vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { telefono: true, whatsappNumber: true, tenantId: true, nombre: true }
      })
    }
  } catch (err) {
    console.warn(`[Notif] no se pudo leer el vendor ${vendorId}: ${err.message}`)
  }

  // whatsappNumber = el WhatsApp personal del vendedor (si lo cargó); si no, su teléfono.
  const destino = vendor?.whatsappNumber || vendor?.telefono || process.env.NUMERO_JOAN || null

  let canal = null
  let instancia = null
  let numeroCanal = null
  if (vendor?.tenantId) {
    try {
      canal = await defaultChannelForTenant(vendor.tenantId)
      instancia = transporteDe(canal) === 'evolution' ? (canal?.externalKey || null) : null
      numeroCanal = canal?.numeroDisplay || null
    } catch (err) {
      console.warn(`[Notif] no se pudo resolver canal de ${vendor.tenantId}: ${err.message}`)
    }
  }
  if (!instancia && transporteDe(canal) === 'evolution') instancia = process.env.EVOLUTION_INSTANCE_NAME || null

  const motivoInvalido = destinoInvalido(destino, {
    numerosDelBot: [numeroCanal, process.env.NUMERO_BOT]
  })

  return { destino, canal, instancia, motivoInvalido, tenantId: vendor?.tenantId || null, vendorNombre: vendor?.nombre || null }
}

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
  nombrePrograma = '', verticalId = null, tenantId = null
}) {
  // El vendedor se resuelve ANTES de armar el texto: su tenant define el vertical
  // (y con él qué datos le sirven al humano para cerrar o despachar).
  const { destino, canal, instancia, motivoInvalido, tenantId: tenantVendor, vendorNombre } = await destinoDeNotificacion(vendorId)
  const vertical = getVertical(verticalId ? { vertical: verticalId } : null, tenantId || tenantVendor)

  // Formato RICO (recuperado del sistema viejo): perfil del lead + sus palabras +
  // motivo + data del comprobante si aplica. Solo se muestran las líneas con dato.
  const DIV = '━━━━━━━━━━━━━━━━━━━━━━━━━━'
  const nom = nombre || slots.nombre || null
  const lineas = [
    DIV,
    `🟡 *LEAD PARA ATENDER*${nombrePrograma ? ` · ${nombrePrograma}` : ''}`,
    DIV,
    `https://wa.me/${String(telefono).replace(/\D/g, '')}`,
    DIV,
    `👤  ${nom || '(nombre por confirmar)'}`,
    ...lineasPerfil(slots, vertical.CAMPOS_BRIEFING || [])
  ]
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

  // ─── 1. WhatsApp al vendedor DEL TENANT, por el canal DEL TENANT ───
  let sent = false
  const tenantAviso = tenantId || tenantVendor

  if (motivoInvalido) {
    console.error(`[Notif] ❌ Lead ${leadId} escaló pero el aviso NO sale: el destino del vendedor ${vendorNombre || vendorId} (${tenantAviso}) es inválido — ${motivoInvalido}. Carga su WhatsApp personal (vendors.whatsappNumber) o el aviso nunca llega.`)
  } else if (destino && (instancia || transporteDe(canal) === 'cloud')) {
    try {
      // Con la API oficial de Meta, este aviso es un mensaje que INICIA el negocio: solo
      // entra si el vendedor le escribió al número en las últimas 24 h, y el rechazo
      // (131047) puede llegar DESPUÉS por webhook, con el envío ya dado por bueno. Para
      // un pedido confirmado eso es una venta perdida. Con una plantilla de utilidad
      // aprobada (CLOUD_TEMPLATE_AVISO_VENDEDOR) el aviso corto llega siempre; el
      // briefing completo va detrás y entra si la ventana está abierta.
      const plantilla = transporteDe(canal) === 'cloud' ? process.env.CLOUD_TEMPLATE_AVISO_VENDEDOR : null
      if (plantilla) {
        const p = await enviarPlantilla({
          canal, telefono: destino, templateName: plantilla,
          languageCode: process.env.CLOUD_TEMPLATE_IDIOMA || 'es',
          components: componentesAvisoVendedor({ nombre: nom, motivo, telefono })
        })
        sent = !!p.ok
        if (!p.ok) console.error(`[Notif] Plantilla "${plantilla}" al vendedor falló (lead ${leadId}): ${p.error} ${(p.errors || []).join(' ')}`)
      }
      const r = await enviarTexto({ canal, telefono: destino, texto: briefing, instancia })
      sent = sent || !!r.ok
      if (sent) {
        console.log(`[Notif] 🔔 Escalamiento del lead ${leadId} avisado a ${vendorNombre || 'vendedor'} (${tenantAviso || 'tenant?'}) vía ${instancia || 'Meta'}`)
      } else {
        console.error(`[Notif] WhatsApp al vendedor falló (lead ${leadId}): ${r.error}`)
      }
    } catch (err) {
      console.error(`[Notif] Excepción enviando WhatsApp al vendedor (lead ${leadId}):`, err.message)
      reportError(err, { module: 'notifications:whatsapp', leadId })
    }
  } else {
    // Ruidoso a propósito: un escalamiento que nadie recibe es un lead que se muere.
    console.error(`[Notif] ❌ Lead ${leadId} escaló pero NO hay a quién avisar (destino=${destino ? 'ok' : 'FALTA'}, instancia=${instancia ? 'ok' : 'FALTA'}, tenant=${tenantAviso}). Revisá el teléfono del vendor y el Channel del tenant.`)
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
    reportError(err, { module: 'notifications:crm', leadId })
  }

  console.log(`[Notif] 🔔 Vendedor notificado del lead ${leadId} | wa:${sent ? 'ok' : 'no'} | crm:${persisted ? 'ok' : 'no'} | ${motivo}`)
  return { sent, persisted }
}
