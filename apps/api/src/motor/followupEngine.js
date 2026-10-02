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
import { enviarTexto, enviarPlantilla, transporteDe, persistirMensajeSaliente } from '../whatsapp/transporte.js'
import { textoDePlantilla } from '../whatsapp/cloud/plantillas-catalogo.js'
import { readFileSync } from 'node:fs'
import { ACTIVE_TENANT, verticalPorTenant } from '../lib/tenant.js'
import { defaultChannelForTenant } from '../webhook/channel-resolver.js'

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

// ── Plantillas POR VERTICAL (defaults genéricos) + override POR CAMPAÑA ──
// El motor de followups tenía copy de EXPORTACIÓN hardcodeado → le hablaba de
// "exportar tu producto" a leads de colágeno (bug real cazado con Gabriel). Luego
// tuvo el defecto espejo: el producto ("ELIXIR") quemado en la plantilla de colágeno.
// Ahora: (1) las plantillas del vertical son genéricas — el producto viaja en
// {{producto}}/{{curso}} y se resuelve de la campaña del lead; (2) cada campaña
// puede traer su propio copy en config.followups (editable por API, sin deploy),
// que GANA sobre el default del vertical. {{nombre}} = PRIMER nombre.
const FOLLOWUPS = JSON.parse(readFileSync(new URL('../../data/followups.json',import.meta.url),'utf8'))

// ── Plantillas POR TENANT, resueltas EN CADA LEAD (fix forense jul 2026) ──
//
// ANTES esto se resolvía UNA VEZ al cargar el módulo, con `ACTIVE_TENANT`:
//     const VERTICAL_ACTIVO = verticalPorTenant(ACTIVE_TENANT)
//     const PLANTILLAS = PLANTILLAS_POR_VERTICAL[VERTICAL_ACTIVO]
// Es decir: TODOS los followups de TODOS los clientes salían con la plantilla del
// tenant de una env var global. Con ACTIVE_TENANT=bioayur, un lead de Perú Exporta
// habría recibido el copy del colágeno. Mismo defecto que arrastraba vision.js: el
// multitenant se implementó en el webhook y no en los motores de fondo.
//
// Ahora el vertical se deduce del TENANT DEL LEAD, en cada envío.
export function plantillasDe(tenantId, vertical = null) {
  return { ...FOLLOWUPS.default, ...FOLLOWUPS.verticales[vertical || verticalPorTenant(tenantId)] }
}

// ── Datos comerciales POR LEAD, desde su campaña en BD (F2 forense) ──
// El producto y el copy pertenecen a la campaña, no al código: se cargan en UN
// query para todos los candidatos del ciclo (sin N+1). Sin campaña o sin
// config, los placeholders caen a genéricos neutros (jamás a otra marca).
export async function datosComercialesPorLead(leadIds, db = prisma) {
  const mapa = new Map()
  const ids = [...new Set(leadIds)].filter(Boolean)
  if (!ids.length) return mapa
  let filas = []
  try {
    filas = await db.lead.findMany({
      where: { id: { in: ids } },
      select: { id: true, tenantId: true, campaign: { select: { nombre: true, config: true, tenantId: true } } }
    })
  } catch (err) {
    console.warn(`[Followup] no se pudo cargar campañas de ${ids.length} leads: ${err.message}`)
    return mapa
  }
  for (const f of filas) {
    const config = (f.campaign?.config && typeof f.campaign.config === 'object') ? f.campaign.config : {}
    const followups = (config.followups && typeof config.followups === 'object') ? config.followups : null
    // Sin campaña es válido; una asociación ajena o no resuelta se omite.
    if (!f.tenantId || (f.campaign !== null && f.campaign?.tenantId !== f.tenantId)) continue
    mapa.set(f.id, {
      tenantId: f.tenantId, vertical: config.vertical || verticalPorTenant(f.tenantId),
      producto: config.agente?.nombreProducto || null,
      curso: f.campaign?.nombre || null,
      followups
    })
  }
  return mapa
}

// ── Instancia de salida POR TENANT, con caché por ciclo ──
// Un followup no nace de un webhook entrante, así que no hay instancia que heredar:
// se busca el canal por defecto del tenant (para eso existe defaultChannelForTenant).
// No se utiliza una instancia global cuando falta el canal del cliente. Antes había un literal 'peru-exporta-test': mandar el followup de un cliente
// por el número de otro es peor que no mandarlo.
export async function canalDeTenant(tenantId, cache, resolver = defaultChannelForTenant) {
  if (cache.has(tenantId)) return cache.get(tenantId)
  let canal = null
  try {
    canal = await resolver(tenantId)
  } catch (err) {
    console.warn(`[Followup] no se pudo resolver canal de ${tenantId}: ${err.message}`)
  }
  if (!canal || canal.tenantId !== tenantId) canal = null
  // Evolution: la instancia pertenece al canal del cliente.
  const instancia = transporteDe(canal) === 'evolution'
    ? (canal?.externalKey || null)
    : null
  const r = { canal, instancia }
  cache.set(tenantId, r)
  return r
}

// ── Política de WhatsApp oficial (Meta) por tipo de envío (sep 2026) ──
// Meta solo acepta TEXTO LIBRE dentro de las 24 h desde el último mensaje del cliente.
// Fuera de esa ventana exige una PLANTILLA aprobada (y la cobra). Sin plantilla
// configurada, el envío se OMITE: intentarlo solo daría error 131047 en cada ciclo.
//   followup_2h  → cae dentro de la ventana (2-6 h de silencio): texto.
//   followup_24h → cae fuera (24-48 h): solo con CLOUD_TEMPLATE_FOLLOWUP_24H.
//   compromiso   → la fecha prometida suele quedar fuera: solo con CLOUD_TEMPLATE_COMPROMISO.
// Con Evolution no hay ventana: todo va como texto, igual que siempre.
export function politicaEnvio(transporte, tipo, env = process.env, canal = null) {
  if (transporte !== 'cloud') return { accion: 'texto' }
  if (tipo === 'followup_2h') return { accion: 'texto' }
  const propia = canal?.credenciales?.templates?.[tipo]
  const plantilla = (typeof propia === 'string' ? propia : propia?.nombre) || (tipo === 'followup_24h' ? env.CLOUD_TEMPLATE_FOLLOWUP_24H : env.CLOUD_TEMPLATE_COMPROMISO)
  const idioma = propia?.idioma || canal?.credenciales?.templateIdioma || env.CLOUD_TEMPLATE_IDIOMA || 'es'
  const cuerpo = typeof propia === 'object' ? propia.cuerpo : null
  return plantilla ? { accion: 'plantilla', plantilla, idioma, cuerpo } : { accion: 'omitir', motivo: 'fuera de la ventana de 24 h y sin plantilla aprobada' }
}

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

// PRIMER nombre, capitalizado (fix forense jul 2026): antes se usaba el nombre
// COMPLETO del perfil de WhatsApp ("Jesus Gabriel Martínez Fl") → sonaba a base de
// datos. Ahora solo el primer token. Vacío si no hay nombre usable.
function primerNombre(nombre) {
  const t = (nombre && String(nombre).trim()) || ''
  if (!t) return ''
  const tok = t.split(/\s+/)[0]
  if (tok.length < 2 || /\d/.test(tok)) return ''   // basura tipo "51" o iniciales sueltas → sin nombre
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()
}

function interpolar(plantilla, { nombre, producto, curso }) {
  return plantilla
    .replace(/\{\{nombre\}\}/g, primerNombre(nombre))
    .replace(/\{\{producto\}\}/g, (producto && String(producto).trim()) || 'tu producto')
    .replace(/\{\{curso\}\}/g, (curso && String(curso).trim()) || 'nuestro programa')
    // Si no había nombre, "Hola  👋" / "Hola , ..." quedan feos → limpiar a "¡Hola! ..."
    .replace(/\bHola\s+([👋😊💜📦,])/g, (m, s) => s === ',' ? '¡Hola!' : `¡Hola! ${s}`)
    .replace(/ {2,}/g, ' ')
    .trim()
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ════════════════════════════════════════════════════════════════════════
// HITO A4 — RESERVA ATÓMICA DEL FOLLOWUP (oct 2026)
//
// El flag `cronEjecutandose` de server.js serializa las corridas DENTRO del proceso. No
// alcanza: dos procesos, o dos disparos que se solapan tras un reintento, leen el mismo lead
// y mandan el mismo texto dos veces. La garantía tiene que estar en la BD.
//
// Aquí se reserva el trabajo ANTES de enviar, con una clave única
// (lead_id, followup_type, último mensaje del lead, ciclo). Si otra corrida —o la misma, en
// paralelo— intenta reservar lo mismo, el índice único la rechaza y esa sigue con el
// siguiente lead. La reserva se completa (executed) si el envío salió, o se libera si al
// revalidar descubrimos que el lead ya no era elegible.
//
// NO se confunde con `followup_queue`: esa tabla es el REGISTRO de lo ejecutado (auditoría y
// la regla "no repetir el mismo followup tras el último mensaje del lead"). Esta reserva es
// el candado de "nadie más está trabajando en esto ahora mismo".
// ════════════════════════════════════════════════════════════════════════

/** Clave de reserva: qué silencio se está atendiendo, para qué lead y con qué tipo. */
function claveReserva({ leadId, tipo, ultimoLeadAt }) {
  return `${leadId}:${tipo}:${ultimoLeadAt ? new Date(ultimoLeadAt).toISOString() : 'sin-mensaje'}`
}

/**
 * Intenta reservar el followup. Devuelve `{reservado:true, id}` o `{reservado:false, motivo}`.
 * El INSERT condicional (`WHERE NOT EXISTS`) hace la comprobación y la escritura en una
 * sola sentencia atómica: no hay ventana entre "comprobaré que nadie lo tiene" y "lo tomo".
 */
export async function reservarFollowup(prisma, { leadId, tipo, horas = null, ahora = null, cycle = null, db = null }) {
  const client = db || prisma
  const ciclo = cycle || new Date().toISOString().slice(0, 13)   // hora ISO: agrupa por hora
  try {
    const r = await client.$executeRaw`
      INSERT INTO followup_reservations (id, lead_id, followup_type, cycle_key, context_snapshot, created_at)
      SELECT ${randomUUID()}::uuid, ${leadId}, ${tipo}, ${ciclo},
             ${JSON.stringify({ horas_silencio: horas, hora_peru: ahora })}::jsonb, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM followup_reservations
        WHERE lead_id = ${leadId} AND followup_type = ${tipo} AND cycle_key = ${ciclo}
      )
    `
    if (r === 0) return { reservado: false, motivo: 'ya_reservado_en_este_ciclo' }
    const fila = await client.$queryRaw`
      SELECT id FROM followup_reservations
      WHERE lead_id = ${leadId} AND followup_type = ${tipo} AND cycle_key = ${ciclo}
      ORDER BY created_at DESC LIMIT 1
    `
    return { reservado: true, id: fila?.[0]?.id || null }
  } catch (err) {
    // Conflicto de unicidad = otra corrida ganó la carrera entre el NOT EXISTS y el INSERT.
    if (err?.code === 'P2002' || /unique|duplicate/i.test(String(err.message || ''))) {
      return { reservado: false, motivo: 'carrera_otro_worker' }
    }
    // Sin tabla (instalación anterior al upgrade) no se bloquea el cron, pero tampoco se
    // finge protección: se avisa y se sigue con la lógica de siempre.
    console.error(`[Followup] reserva no disponible (${err.message}); siguiendo sin candado de BD`)
    return { reservado: true, id: null, sinCandado: true }
  }
}

/** Revalida antes de enviar: el mundo pudo cambiar entre la consulta y ahora. */
export async function revalidarParaEnvio(prisma, leadId, db = null) {
  const client = db || prisma
  const st = await client.leadState.findUnique({ where: { leadId }, select: { currentMode: true, slotsFilled: true } })
  if (!st) return { ok: false, motivo: 'sin_estado' }
  if (st.currentMode !== 'AUTO_CONSULTIVO') return { ok: false, motivo: `modo_${st.currentMode}` }
  if (st.slotsFilled && typeof st.slotsFilled === 'object' && st.slotsFilled._pedido) {
    return { ok: false, motivo: 'pedido_registrado' }
  }
  const lead = await client.lead.findFirst({ where: { id: leadId }, select: { archivedAt: true } })
  if (lead?.archivedAt) return { ok: false, motivo: 'lead_archivado' }
  return { ok: true }
}

export async function completarReserva(prisma, id, messageId = null, db = null) {
  if (!id) return { count: 0 }
  const client = db || prisma
  return client.$executeRaw`
    UPDATE followup_reservations
       SET executed = true, executed_at = now(), message_id = ${messageId ? String(messageId) : null},
           result = ${'sent:' + (messageId || 'ok')}
     WHERE id = ${id}::uuid
  `
}

export async function marcarReservaFallida(prisma, id, motivo, db = null) {
  if (!id) return { count: 0 }
  const client = db || prisma
  return client.$executeRaw`
    UPDATE followup_reservations SET result = ${'failed:' + String(motivo || '').slice(0, 300)}
     WHERE id = ${id}::uuid
  `
}

/** Libera la reserva cuando la revalidación dice que ya no toca (nada se envió). */
export async function liberarReserva(prisma, id, db = null) {
  if (!id) return { count: 0 }
  const client = db || prisma
  return client.$executeRaw`DELETE FROM followup_reservations WHERE id = ${id}::uuid`
}

// ════════════════════════════════════════════════════════
// CONSULTA — candidatos a followup
// El SILENCIO se mide desde el último mensaje del LEAD (no del bot: así los propios
// followups, que son mensajes BOT, no resetean el reloj). "del ciclo" = followups
// posteriores a ese último mensaje del lead → si el lead responde, el ciclo se reinicia.
// ════════════════════════════════════════════════════════
// HITO A4 (oct 2026) — EL FILTRO VA EN SQL, ANTES DEL LÍMITE.
//
// El bug: el SELECT traía cualquier lead en silencio ≥ 2 h y el `LIMIT 15` se aplicaba
// ANTES de decidir si el lead era elegible. Los 15 primeros filas solían ser leads viejísimos
// (48 h, semanas) que no entran en ninguna ventana, así que el lote se llenaba de inelegibles
// y los elegibles de verdad nunca recibían su followup. El tipo se decide AHORA en SQL y el
// límite aplica a candidatos YA filtrados por ventana, y el segundo turno usa un techo
// mayor porque su ventana es más estrecha (24-48 h) y, al empezar más tarde, acumulaba más.
//
// `horas_silencio` se devuelve ya acotado por el tipo elegido, así que el JS solo lo registra.
const SQL_CANDIDATOS = `
  SELECT
    ls.lead_id                                                   AS "leadId",
    l.telefono                                                   AS telefono,
    l.tenant_id                                                  AS "tenantId",
    COALESCE(NULLIF(ls.slots_filled->>'nombre',''), NULLIF(l."nombreDetectado",'')) AS nombre,
    ls.slots_filled->>'producto'                                 AS producto,
    EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600        AS horas_silencio,
    CASE
      WHEN EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 >= ${PISO_24H}
       AND EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 < ${TECHO_24H}
       AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                        WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_24h'
                          AND fq.created_at > lead_msg.last_at)
      THEN 'followup_24h'
      WHEN EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 >= ${PISO_2H}
       AND EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 < ${TECHO_2H}
       AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                        WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_2h'
                          AND fq.created_at > lead_msg.last_at)
       AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                        WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_24h'
                          AND fq.created_at > lead_msg.last_at)
      THEN 'followup_2h'
      ELSE NULL
    END                                                         AS tipo,
    last_any.origen                                              AS ultimo_origen
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
    -- Quien YA COMPRÓ no recibe "no se te pase la promo" (fix sep 2026): la marca
    -- _pedido la pone el pipeline cuando el vertical reconoce el cierre.
    AND NOT (ls.slots_filled ? '_pedido')
    -- SIN filtro de tenant (fix jul 2026): antes decía l.tenant_id = '<ACTIVE_TENANT>',
    -- así que el cron solo atendía al cliente de la env var y los demás NO recibían
    -- followups en absoluto. El tenant viaja en el SELECT y decide plantilla + canal
    -- de salida en cada lead, que es lo correcto en multitenant.
    AND l.archived_at IS NULL
    AND lead_msg.last_at IS NOT NULL
    AND last_any.origen <> 'LEAD'
  -- El filtro de ELEGIBILIDAD va antes del límite: sin tipo, un lead fuera de ventana
  -- ocupa una plaza del lote y desplaza a los que sí la cumplen.
  AND (
    (EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 >= ${PISO_24H}
     AND EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 < ${TECHO_24H}
     AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                      WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_24h'
                        AND fq.created_at > lead_msg.last_at))
    OR
    (EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 >= ${PISO_2H}
     AND EXTRACT(EPOCH FROM (now() - lead_msg.last_at)) / 3600 < ${TECHO_2H}
     AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                      WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_2h'
                        AND fq.created_at > lead_msg.last_at)
     AND NOT EXISTS (SELECT 1 FROM followup_queue fq
                      WHERE fq.lead_id = ls.lead_id AND fq.followup_type = 'followup_24h'
                        AND fq.created_at > lead_msg.last_at))
  )
  ORDER BY lead_msg.last_at DESC
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
  const canalPorTenant = new Map()   // caché por ciclo: 1 query por tenant, no por lead
  const datosPorLead = await datosComercialesPorLead(candidatos.map(c => c.leadId))

  for (const c of candidatos) {
    const horas = Number(c.horas_silencio)
    // El tipo ya viene decidido y filtrado en SQL (ventana + no repetido). Si por lo que sea
    // no hay tipo, el lead no es elegible: se omite y se libera la plaza para otro.
    const tipo = c.tipo || null
    if (!tipo) { omitidos++; continue }

    // Sin tenant no se envía: adivinarlo es como mandarlo por otro número.
    const tenantId = c.tenantId || null
    if (!tenantId) { omitidos++; continue }
    // Copy de LA CAMPAÑA de este lead (config.followups) o default del vertical;
    // el producto, de su campaña (o de lo que el lead dijo, o genérico neutro).
    const datos = datosPorLead.get(c.leadId) || {}
    if (datos.tenantId !== tenantId) { omitidos++; continue }
    const base = plantillasDe(tenantId, datos.vertical)[tipo]
    const plantilla = (datos.followups && datos.followups[tipo]) || base
    const texto = interpolar(plantilla, { nombre: c.nombre, producto: datos.producto || c.producto, curso: datos.curso })

    // Y por el número de ESTE cliente. Sin canal resoluble no se envía: prefiero
    // perder un followup a que el lead de un cliente reciba un WhatsApp de otro.
    const { canal, instancia } = await canalDeTenant(tenantId, canalPorTenant)
    const transporte = transporteDe(canal)
    if (!canal || (transporte === 'evolution' && !instancia)) {
      omitidos++
      console.warn(`[Followup] ⏭️ lead ${c.leadId} (${tenantId}) sin canal de salida → omitido. Sembrá un Channel para este tenant.`)
      continue
    }
    const politica = politicaEnvio(transporte, tipo, tenantId === ACTIVE_TENANT ? process.env : {}, canal)
    if (politica.accion === 'omitir') { omitidos++; continue }

    // ═══ HITO A4 — RESERVA ATÓMICA ANTES DE ENVIAR ═══
    // El cron puede solaparse (UptimeRobot reintenta, dos deployments, un retry manual) y el
    // flag en memoria solo protege dentro del proceso. Con dos corridas simultáneas, ambas
    // leen el mismo lead como "en silencio" y ambas envían: el cliente recibe el mismo
    // recordatorio dos veces con segundos de diferencia (pasó real con Óscar).
    //
    // La reserva es un INSERT con una clave única derivada de (lead, tipo, último mensaje del
    // lead): si la segunda corrida intenta reservar lo ya reservado, el índice la rechaza y
    // sigue. No es una marque de memoria: es la BD, y funciona entre procesos e instancias.
    const reservation = await reservarFollowup(prisma, {
      leadId: c.leadId, tipo, horas, ahora: horaPeru(),
    })
    if (!reservation.reservado) {
      omitidos++
      detalle.push({ leadId: c.leadId, tipo, omitido: reservation.motivo })
      continue
    }

    // Re-validación JUSTO antes de enviar. Entre la consulta y este punto pudo pasar: que el
    // lead escribiera, que un humano tomara el control, que se cerrara el pedido. Enviar un
    // followup de venta a un lead que acaba de responder, o que ya tiene a un humano encima,
    // es exactamente el fallo que más daña la confianza. Si algo cambió, se libera la reserva.
    const reval = await revalidarParaEnvio(prisma, c.leadId)
    if (!reval.ok) {
      await liberarReserva(prisma, reservation.id)
      omitidos++
      detalle.push({ leadId: c.leadId, tipo, omitido: `revalidacion: ${reval.motivo}` })
      continue
    }

    try {
      let r
      // Por plantilla, lo que el cliente lee es el texto APROBADO en Meta, no `texto` (el copy
      // del vertical). Se guarda ese: si no, la bandeja muestra algo que nunca se envió y el
      // cerebro "recuerda" promesas (envío, pago contra entrega…) que el cliente no leyó.
      let enviado = texto
      if (politica.accion === 'plantilla') {
        const variables = [primerNombre(c.nombre) || 'qué tal', (datos.producto || c.producto || 'tu producto')]
        enviado = textoDePlantilla(tipo, variables, politica)
        r = await enviarPlantilla({
          canal,
          telefono: c.telefono,
          templateName: politica.plantilla,
          languageCode: politica.idioma,
          components: [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: v })) }]
        })
      } else {
        r = await enviarTexto({ canal, telefono: c.telefono, texto, instancia })
      }
      if (!r.ok) {
        // Falló el envío: NO se marca como enviado (no lo salió). La reserva queda con su
        // motivo; se puede reintentar en otro ciclo, pero solo si la revalidación sigue valiendo.
        errores++
        await marcarReservaFallida(prisma, reservation.id, r.error)
        detalle.push({ leadId: c.leadId, tipo, error: r.error })
        continue
      }

      // Persistir el followup como mensaje BOT (queda en el historial; no afecta el
      // reloj de silencio, que se mide desde el último mensaje del LEAD).
      await persistirMensajeSaliente(prisma, { data: { leadId: c.leadId, origen: 'BOT', texto: enviado }, resultado: r, canal, tenantId: c.tenantId })

      // La reserva pasa a ejecutada (auditoría + idempotencia por ciclo).
      await completarReserva(prisma, reservation.id, r.messageId)

      enviados++
      detalle.push({ leadId: c.leadId, tipo, horas: Number(horas.toFixed(1)) })
      console.log(`[Followup] ${tipo} a lead ${c.leadId} (${horas.toFixed(1)}h silencio)`)

      if (enviados < candidatos.length) await sleep(PAUSA_ENTRE_MS) // cadencia humana
    } catch (err) {
      errores++
      await marcarReservaFallida(prisma, reservation.id, err.message)
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
const PLANTILLA_COMPROMISO = FOLLOWUPS.default.compromiso

const SQL_COMPROMISOS_VENCIDOS = `
  SELECT c.id AS commitment_id, c.lead_id AS "leadId", l.telefono,
         l.tenant_id AS "tenantId",
         COALESCE(NULLIF(l."nombreDetectado",''), ls.slots_filled->>'nombre') AS nombre
  FROM commitments c
  JOIN leads l ON l.id = c.lead_id
  JOIN lead_state ls ON ls.lead_id = c.lead_id
  WHERE c.fulfilled = false
    AND c.reminder_sent = false
    AND c.due_date <= now()
    AND ls.current_mode = 'AUTO_CONSULTIVO'
    AND NOT (ls.slots_filled ? '_pedido')
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
  const canalPorTenant = new Map()
  const datosPorLead = await datosComercialesPorLead(vencidos.map(c => c.leadId))
  for (const c of vencidos) {
    if (!c.tenantId) continue
    // La campaña puede afinar el recordatorio (config.followups.compromiso); el
    // default es NEUTRO (no nombra producto ni vertical) y sirve a cualquiera.
    const datos = datosPorLead.get(c.leadId) || {}
    if (datos.tenantId !== c.tenantId) continue
    const texto = interpolar((datos.followups && datos.followups.compromiso) || PLANTILLA_COMPROMISO, { nombre: c.nombre, producto: datos.producto, curso: datos.curso })
    // Lo que sí debe ser del tenant es el NÚMERO por el que sale.
    const { canal, instancia } = await canalDeTenant(c.tenantId, canalPorTenant)
    const transporte = transporteDe(canal)
    if (!canal || (transporte === 'evolution' && !instancia)) {
      console.warn(`[Compromiso] ⏭️ lead ${c.leadId} (${c.tenantId}) sin canal de salida → omitido.`)
      continue
    }
    const politica = politicaEnvio(transporte, 'compromiso', c.tenantId === ACTIVE_TENANT ? process.env : {}, canal)
    if (politica.accion === 'omitir') continue

    // Misma reserva y misma revalidación que los followups por silencio: el recordatorio de
    // compromiso también es un envío a un cliente real y no puede duplicarse por dos corridas
    // simultáneas del cron.
    const reserva = await reservarFollowup(prisma, { leadId: c.leadId, tipo: 'compromiso', ahora: horaPeru(), cycle: `compromiso:${c.commitment_id}` })
    if (!reserva.reservado) continue
    const reval = await revalidarParaEnvio(prisma, c.leadId)
    if (!reval.ok) {
      await liberarReserva(prisma, reserva.id)
      continue
    }

    try {
      const porPlantilla = politica.accion === 'plantilla'
      const variables = [primerNombre(c.nombre) || 'qué tal']
      // Por plantilla se guarda el texto APROBADO en Meta (mismo motivo que en ejecutarFollowups).
      const enviado = porPlantilla ? textoDePlantilla('compromiso', variables, politica) : texto
      const r = porPlantilla
        ? await enviarPlantilla({ canal, telefono: c.telefono, templateName: politica.plantilla,
            languageCode: politica.idioma,
            components: [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: v })) }] })
        : await enviarTexto({ canal, telefono: c.telefono, texto, instancia })
      if (!r.ok) { errores++; await marcarReservaFallida(prisma, reserva.id, r.error); continue }

      // Marcar PRIMERO el recordatorio como enviado (idempotencia: si el insert del mensaje
      // falla, no reintentamos el envío en el próximo ciclo).
      await prisma.$executeRaw`
        UPDATE commitments SET reminder_sent = true, reminder_sent_at = now(), updated_at = now()
        WHERE id = ${c.commitment_id}::uuid`
      await persistirMensajeSaliente(prisma, { data: { leadId: c.leadId, origen: 'BOT', texto: enviado }, resultado: r, canal, tenantId: c.tenantId })
      await completarReserva(prisma, reserva.id, r.messageId)

      enviados++
      console.log(`[Compromiso] recordatorio a lead ${c.leadId} (commitment ${c.commitment_id})`)
      if (enviados < vencidos.length) await sleep(PAUSA_ENTRE_MS)   // cadencia humana
    } catch (err) {
      errores++
      await marcarReservaFallida(prisma, reserva.id, err.message)
      console.error(`[Compromiso] Error enviando a lead ${c.leadId}:`, err.message)
    }
  }

  const resumen = { ok: true, vencidos: vencidos.length, enviados, errores, hora_peru: horaPeru(), ms: Date.now() - t0 }
  console.log(`[Compromiso] 🔔 ciclo: ${JSON.stringify(resumen)}`)
  return resumen
}

// ════════════════════════════════════════════════════════
// RESCATE DE ESCALADOS HUÉRFANOS (fix forense jul 2026)
//
// EL AGUJERO NEGRO QUE CERRAMOS:
//   Cuando el cerebro escala a HUMAN_ACTIVE (pedido a provincia, lead vulnerable,
//   comprobante...), el bot se calla para no pisar al vendedor. Correcto. Pero si
//   NADIE atiende, el lead quedaba muerto para siempre:
//     · la compuerta de modo lo silencia en cada turno,
//     · el followup lo excluye (solo mira AUTO_CONSULTIVO),
//     · y el auto-resume de brain-pipeline es EVENT-DRIVEN: solo despierta si el
//       lead vuelve a escribir. Si se cansó y no escribió más, no despierta nunca.
//
//   El peritaje del 23-jul-2026 encontró 9 leads así en producción — uno de 383h
//   (16 días) y varios en `call_scheduling`, o sea con el pedido casi cerrado. Un
//   lead de Puno con su pack ya elegido murió a los 30 segundos de escalar.
//
// QUÉ HACE: barre los HUMAN_ACTIVE que llevan más de UMBRAL horas SIN que ningún
// humano los tocara y los devuelve a AUTO_CONSULTIVO. No manda nada por sí mismo:
// solo los vuelve elegibles para el followup normal, que ya tiene todas las guardas
// (ventana horaria, cadencia, plantilla por vertical, canal del tenant).
//
// SEGURO POR DISEÑO: `modeEnteredAt` se refresca en CADA mensaje del vendedor
// (event-router) y en cada escalada. Si el humano está atendiendo, el reloj nunca
// vence → cero interrupción. Solo revive conversaciones ABANDONADAS.
// PAUSED jamás se toca: es terminal (rechazo/cierre).
// Mismo umbral que el auto-resume para que ambos caminos sean coherentes.
// ════════════════════════════════════════════════════════
const RESCATE_HORAS = Number(process.env.HUMAN_ACTIVE_RESUME_HORAS ?? 6)

export async function rescatarEscaladosHuerfanos() {
  // isFinite además de >0: el valor se interpola en el SQL (`interval 'N hours'`). No hay
  // inyección —es una env var numérica, no input de usuario— pero un env mal tecleado que
  // diera Infinity pasaría `>0` y rompería la query. isFinite bloquea NaN e Infinity.
  if (!(Number.isFinite(RESCATE_HORAS) && RESCATE_HORAS > 0)) {
    return { ok: true, skipped: 'rescate_desactivado', rescatados: 0 }
  }

  try {
    // Un humano "tocó" la conversación si hay algún mensaje VENDEDOR posterior a la
    // escalada. Si no lo hay y venció el reloj, nadie lo atendió.
    const huerfanos = await prisma.$queryRawUnsafe(`
      SELECT ls.lead_id AS "leadId", l.tenant_id AS "tenantId", ls.current_stage AS "stage",
             EXTRACT(EPOCH FROM (now() - ls.mode_entered_at)) / 3600 AS horas
      FROM lead_state ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE ls.current_mode = 'HUMAN_ACTIVE'
        AND l.archived_at IS NULL
        -- Un pedido escalado NO es un escalado huérfano: el humano lo despacha sin
        -- necesidad de escribirle por WhatsApp, así que "sin mensaje del vendedor"
        -- no significa "abandonado". Devolverlo al bot le mandaba followups de venta
        -- a una clienta que ya había comprado (fix sep 2026).
        AND NOT (ls.slots_filled ? '_pedido')
        AND ls.mode_entered_at IS NOT NULL
        AND now() - ls.mode_entered_at >= interval '${RESCATE_HORAS} hours'
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m."leadId" = ls.lead_id
            AND m.origen = 'VENDEDOR'
            AND m."createdAt" >= ls.mode_entered_at
        )
      LIMIT 50
    `)

    if (!huerfanos.length) return { ok: true, rescatados: 0 }

    const ids = huerfanos.map(h => h.leadId)
    await prisma.leadState.updateMany({
      where: { leadId: { in: ids } },
      data: { currentMode: 'AUTO_CONSULTIVO', modeEnteredAt: new Date() }
    })

    for (const h of huerfanos) {
      console.log(`[Rescate] ▶️ lead ${h.leadId} (${h.tenantId}, ${h.stage}) llevaba ${Number(h.horas).toFixed(1)}h escalado sin atención humana → vuelve al bot`)
    }
    return { ok: true, rescatados: ids.length, leads: ids }
  } catch (err) {
    console.error('[Rescate] Error rescatando escalados huérfanos:', err.message)
    return { ok: false, error: err.message, rescatados: 0 }
  }
}

export const FOLLOWUP_ENGINE_VERSION = 'v10_filtro_antes_de_limit_y_reserva_atomica'
