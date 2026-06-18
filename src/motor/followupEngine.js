// src/motor/followupEngine.js — Hidata v20 · Fase D (motor de tiempo)
//
// RECONSTRUIDO sobre el cerebro v20 (el followupEngine de la Era 1/FSM se borró en
// el commit 02743c2 — era incompatible: usaba conversation.state/steps/perfilScore).
// Aquí solo reusamos la INFRA de datos que sobrevivió: tabla followup_queue + messages
// + lead_state. El briefing al vendedor ya vive en notifications.js, no se duplica.
//
// QUÉ HACE: cuando un lead deja de responder, le manda UN recordatorio suave a las ~2h
// y otro de reenganche a las ~24h. Disparado por un cron externo vía /cron/followup.
//
// REGLAS DE SEGURIDAD (innegociables):
//   1. SILENCIO se calcula EN SQL (now() - "createdAt"). NUNCA en JS: messages.createdAt
//      está +5h desfasado vs UTC (timestamp sin zona) y el cálculo en JS daría basura.
//      Postgres resta de forma consistente y da el silencio REAL.
//   2. VENTANA HORARIA: solo se envía 9am–8pm hora Perú (UTC-5). Si el umbral cae de
//      madrugada, el cron simplemente no envía hasta que vuelva a estar en ventana.
//   3. NUNCA pisa al humano: solo leads en AUTO_CONSULTIVO (jamás HUMAN_ACTIVE/PAUSED).
//   4. Cadencia sutil (anti-baneo): tope por ciclo + pausa entre envíos.
//
// CON MIRAS A CLOUD API: el `followup_type` ('followup_2h'/'followup_24h') queda como
// la llave para mapear a templates aprobados de Meta el día que migremos (el de 24h cae
// fuera de la ventana de servicio de 24h → allá requerirá template; el de 2h no).

import { randomUUID } from 'node:crypto'
import prisma from '../db/prisma.js'
import { sendToWhatsApp, sendTemplateCloud, proveedorActivo } from '../whatsapp/send.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const PERU_OFFSET     = -5        // Perú = UTC-5, sin horario de verano
const VENTANA_INICIO  = 9         // 9am
const VENTANA_FIN     = 20        // 8pm (no se envía a las 20:00 en punto ni después)
const MAX_POR_CICLO   = 15        // anti-ráfaga: máximo de followups por corrida del cron
const PAUSA_ENTRE_MS  = 1500      // cadencia humana entre envíos (anti-baneo sutil)

// Ventanas de silencio (piso, techo) en horas. El followup solo se manda DENTRO de su
// ventana → un "recordatorio de 24h" jamás llega a los 3 días (absurdo + huele a bot), y
// al activar el cron no se dispara el lote de leads viejos acumulados. >48h = dormant:
// se dejan para una campaña de reactivación aparte, no para el followup automático.
const PISO_2H  = 2,  TECHO_2H  = 6
const PISO_24H = 24, TECHO_24H = 48
const INSTANCE        = process.env.EVOLUTION_INSTANCE_NAME || 'peru-exporta-test'

// Plantillas editables. {{nombre}}, {{producto}}, {{curso}} se interpolan.
const PLANTILLAS = {
  followup_2h:  'Hola {{nombre}} 👋 Quedé pensando en lo que conversamos sobre exportar {{producto}}. Si te quedó alguna duda, aquí estoy para ayudarte 😊',
  followup_24h: 'Hola {{nombre}}, no quiero que dejes pasar la oportunidad con {{curso}}. Si te animas, coordinamos una llamada corta y resolvemos todo. ¿Te parece? 🙌'
}

const NOMBRE_CURSO = 'Mi Primera Exportación'

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════
function horaPeru() {
  return (new Date().getUTCHours() + PERU_OFFSET + 24) % 24
}

function enVentanaHoraria() {
  const h = horaPeru()
  return h >= VENTANA_INICIO && h < VENTANA_FIN
}

function interpolar(plantilla, { nombre, producto }) {
  return plantilla
    .replace(/\{\{nombre\}\}/g, (nombre && String(nombre).trim()) || 'qué tal')
    .replace(/\{\{producto\}\}/g, (producto && String(producto).trim()) || 'tu producto')
    .replace(/\{\{curso\}\}/g, NOMBRE_CURSO)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ════════════════════════════════════════════════════════
// CONSULTA — candidatos a followup
// El SILENCIO se mide desde el último mensaje del LEAD (no del bot: así los propios
// followups, que son mensajes BOT, no resetean el reloj). "del ciclo" = followups
// posteriores a ese último mensaje del lead → si el lead responde, el ciclo se reinicia.
// ════════════════════════════════════════════════════════
const SQL_CANDIDATOS = `
  SELECT
    ls.lead_id                                                   AS "leadId",
    l.telefono                                                   AS telefono,
    COALESCE(NULLIF(l."nombreDetectado",''), ls.slots_filled->>'nombre') AS nombre,
    ls.slots_filled->>'producto'                                 AS producto,
    EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600        AS horas_silencio,
    last_any.origen                                              AS ultimo_origen,
    (SELECT count(*) FROM followup_queue fq
       WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_2h'
         AND fq.created_at > lead_msg.last_at)                   AS ya_2h,
    (SELECT count(*) FROM followup_queue fq
       WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_24h'
         AND fq.created_at > lead_msg.last_at)                   AS ya_24h
  FROM lead_state ls
  JOIN leads l ON l.id = ls.lead_id
  JOIN LATERAL (
    SELECT max("createdAt") AS last_at FROM messages
    WHERE "leadId" = ls.lead_id AND origen = 'LEAD'
  ) lead_msg ON true
  JOIN LATERAL (
    SELECT origen FROM messages WHERE "leadId" = ls.lead_id
    ORDER BY "createdAt" DESC LIMIT 1
  ) last_any ON true
  WHERE ls.current_mode = 'AUTO_CONSULTIVO'
    AND l.archived_at IS NULL
    AND lead_msg.last_at IS NOT NULL
    AND last_any.origen <> 'LEAD'
    AND now() - lead_msg.last_at >= interval '${PISO_2H} hours'
  ORDER BY lead_msg.last_at ASC
  LIMIT ${MAX_POR_CICLO}
`

// ════════════════════════════════════════════════════════
// ENTRY POINT — ejecutarFollowups()
// ════════════════════════════════════════════════════════
export async function ejecutarFollowups() {
  const t0 = Date.now()

  // Guard de ventana horaria: si es de madrugada en Perú, no molestamos a nadie.
  if (!enVentanaHoraria()) {
    return { ok: true, skipped: 'fuera_de_ventana_horaria', hora_peru: horaPeru(), enviados: 0 }
  }

  let candidatos = []
  try {
    candidatos = await prisma.$queryRawUnsafe(SQL_CANDIDATOS)
  } catch (err) {
    console.error('[Followup] Error consultando candidatos:', err.message)
    return { ok: false, error: 'query_failed', detail: err.message }
  }

  let enviados = 0, errores = 0, omitidos = 0
  const detalle = []

  for (const c of candidatos) {
    const horas = Number(c.horas_silencio)
    const ya2h = Number(c.ya_2h) > 0
    const ya24h = Number(c.ya_24h) > 0

    // Decidir qué followup toca. Cada uno SOLO dentro de su ventana [piso, techo):
    // fuera de ventana no se manda (followup tardío = absurdo + huele a bot).
    let tipo = null
    if (horas >= PISO_24H && horas < TECHO_24H && !ya24h) tipo = 'followup_24h'
    else if (horas >= PISO_2H && horas < TECHO_2H && !ya2h && !ya24h) tipo = 'followup_2h'

    if (!tipo) { omitidos++; continue }

    const texto = interpolar(PLANTILLAS[tipo], { nombre: c.nombre, producto: c.producto })

    try {
      // En Cloud API el followup_24h cae FUERA de la ventana de servicio de 24h →
      // Meta exige TEMPLATE aprobado (el de 2h va como texto, sigue dentro de ventana).
      // Con Evolution, ambos van como texto normal (sin cambio).
      let r
      if (proveedorActivo() === 'cloud' && tipo === 'followup_24h') {
        r = await sendTemplateCloud({
          telefono: c.telefono,
          templateName: process.env.CLOUD_TEMPLATE_FOLLOWUP_24H || 'followup_24h',
          languageCode: 'es',
          components: [{ type: 'body', parameters: [
            { type: 'text', text: (c.nombre && String(c.nombre).trim()) || 'qué tal' },
            { type: 'text', text: (c.producto && String(c.producto).trim()) || 'tu producto' }
          ]}]
        })
      } else {
        r = await sendToWhatsApp({ telefono: c.telefono, text: texto, instanceName: INSTANCE })
      }
      if (!r.ok) { errores++; detalle.push({ leadId: c.leadId, tipo, error: r.error }); continue }

      // Persistir el followup como mensaje BOT (queda en el historial; no afecta el
      // reloj de silencio, que se mide desde el último mensaje del LEAD).
      await prisma.message.create({ data: { leadId: c.leadId, origen: 'BOT', texto } })

      // Registrar el followup ejecutado (idempotencia por ciclo + auditoría).
      await prisma.$executeRaw`
        INSERT INTO followup_queue (id, lead_id, scheduled_for, context_snapshot, followup_type, executed, executed_at, result, created_at)
        VALUES (${randomUUID()}::uuid, ${c.leadId}, now(),
                ${JSON.stringify({ horas_silencio: Number(horas.toFixed(2)), hora_peru: horaPeru() })}::jsonb,
                ${tipo}, ${true}, now(), ${'sent:' + (r.messageId || 'ok')}, now())`

      enviados++
      detalle.push({ leadId: c.leadId, tipo, horas: Number(horas.toFixed(1)) })
      console.log(`[Followup] ✅ ${tipo} a lead ${c.leadId} (${horas.toFixed(1)}h silencio)`)

      if (enviados < candidatos.length) await sleep(PAUSA_ENTRE_MS) // cadencia humana
    } catch (err) {
      errores++
      console.error(`[Followup] Error enviando ${tipo} a lead ${c.leadId}:`, err.message)
    }
  }

  const resumen = { ok: true, candidatos: candidatos.length, enviados, omitidos, errores, hora_peru: horaPeru(), ms: Date.now() - t0 }
  console.log(`[Followup] 🔔 ciclo: ${JSON.stringify(resumen)}`)
  return resumen
}

// ════════════════════════════════════════════════════════
// MOTOR DE COMPROMISOS — recordatorios de promesas FECHADAS (Fase D)
// El cerebro detecta "te pago el viernes" y lo guarda en `commitments` con due_date.
// Aquí, cuando un compromiso VENCE sin cumplirse, mandamos UN recordatorio suave y
// marcamos reminder_sent (una sola vez por compromiso). MISMAS reglas de seguridad que
// los followups: ventana horaria, solo AUTO_CONSULTIVO, no archivados, cadencia anti-baneo.
// Distinto del followup por silencio: aquí el disparo es la FECHA del compromiso, no el silencio.
// ════════════════════════════════════════════════════════
const PLANTILLA_COMPROMISO =
  'Hola {{nombre}} 👋 ¿Cómo vas? Quedó algo pendiente de lo que conversamos — sin apuro, pero aquí estoy si quieres que lo cerremos juntos 😊'

const SQL_COMPROMISOS_VENCIDOS = `
  SELECT c.id AS commitment_id, c.lead_id AS "leadId", l.telefono,
         COALESCE(NULLIF(l."nombreDetectado",''), ls.slots_filled->>'nombre') AS nombre
  FROM commitments c
  JOIN leads l ON l.id = c.lead_id
  JOIN lead_state ls ON ls.lead_id = c.lead_id
  WHERE c.fulfilled = false
    AND c.reminder_sent = false
    AND c.due_date <= now()
    AND ls.current_mode = 'AUTO_CONSULTIVO'
    AND l.archived_at IS NULL
  ORDER BY c.due_date ASC
  LIMIT ${MAX_POR_CICLO}
`

export async function ejecutarRecordatoriosCompromiso() {
  const t0 = Date.now()

  // Misma guarda de ventana horaria: nada de recordatorios de madrugada.
  if (!enVentanaHoraria()) {
    return { ok: true, skipped: 'fuera_de_ventana_horaria', hora_peru: horaPeru(), enviados: 0 }
  }

  let vencidos = []
  try {
    vencidos = await prisma.$queryRawUnsafe(SQL_COMPROMISOS_VENCIDOS)
  } catch (err) {
    console.error('[Compromiso] Error consultando vencidos:', err.message)
    return { ok: false, error: 'query_failed', detail: err.message }
  }

  let enviados = 0, errores = 0
  for (const c of vencidos) {
    const texto = interpolar(PLANTILLA_COMPROMISO, { nombre: c.nombre })
    try {
      // Nota Cloud API (futuro): un compromiso vencido suele caer FUERA de la ventana de
      // servicio de 24h → allá requerirá template aprobado (igual que followup_24h). Con
      // Evolution va como texto normal. Por ahora (Evolution) se envía texto.
      const r = await sendToWhatsApp({ telefono: c.telefono, text: texto, instanceName: INSTANCE })
      if (!r.ok) { errores++; continue }

      // Marcar PRIMERO el recordatorio como enviado (idempotencia: si el insert del mensaje
      // falla, no reintentamos el envío en el próximo ciclo).
      await prisma.$executeRaw`
        UPDATE commitments SET reminder_sent = true, reminder_sent_at = now(), updated_at = now()
        WHERE id = ${c.commitment_id}::uuid`
      await prisma.message.create({ data: { leadId: c.leadId, origen: 'BOT', texto } })

      enviados++
      console.log(`[Compromiso] ✅ recordatorio a lead ${c.leadId} (commitment ${c.commitment_id})`)
      if (enviados < vencidos.length) await sleep(PAUSA_ENTRE_MS)   // cadencia humana
    } catch (err) {
      errores++
      console.error(`[Compromiso] Error enviando a lead ${c.leadId}:`, err.message)
    }
  }

  const resumen = { ok: true, vencidos: vencidos.length, enviados, errores, hora_peru: horaPeru(), ms: Date.now() - t0 }
  console.log(`[Compromiso] 🔔 ciclo: ${JSON.stringify(resumen)}`)
  return resumen
}

export const FOLLOWUP_ENGINE_VERSION = 'v5_cerebro_v20_followups_+_compromisos'
