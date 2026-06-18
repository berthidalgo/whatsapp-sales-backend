// src/brain/brain-pipeline.js — Hidata v20 · Sprint 3
//
// ════════════════════════════════════════════════════════════════════════
// EL PUENTE: conecta el cerebro unificado al pipeline real de WhatsApp.
//
// Reemplaza la cadena vieja Perception→ModeRouter→Policy→Response cuando el
// interruptor USAR_CEREBRO_NUEVO está activo. Hace 5 cosas:
// 1. Arma el historial de la conversación desde la BD (lo que el cerebro necesita)
// 2. Carga el estado del lead (stage, slots) y el config de su campaña
// 3. Llama al cerebro (pensarYResponder)
// 4. PROTEGE el stage: si el cerebro sugiere retroceder sin razón, lo ignora
// 5. Guarda el estado actualizado en la BD (lead_state) + persiste slots
//
// Devuelve un objeto con la MISMA forma que espera el handler:
// { ok, botResponse: { text, bot_responded, ... }, ... }
// para que el handler no note la diferencia y el envío por Evolution sea igual.
//
// ════════════════════════════════════════════════════════════════════════
// FIX Sprint 3 (post-producción, 02-jun-2026) — dos bugs del mismo origen:
//
// BUG #4 (crash en cada escalada): el código escribía currentMode:'HUMANO_ACTIVO'
//   (string en español, a mano). La BD solo acepta 'HUMAN_ACTIVE' (constraint
//   valid_mode). Cada vez que el cerebro escalaba a humano, el upsert reventaba
//   y el lead se quedaba sin respuesta. → Ahora se importa MODES del catálogo
//   maestro (igual que event-router) y se usa MODES.HUMAN_ACTIVE / MODES.AUTO_CONSULTIVO.
//   Si el valor está mal, ni arranca. El bug no puede renacer.
//
// BUG #5 (leads HOT atascados): el STAGE_ORDER estaba hardcodeado a mano e
//   incompleto — inventaba stages que no existen ('greeting','qualifying',
//   'objection_handling') y le FALTABA 'call_confirmed'. Como call_confirmed no
//   estaba en la lista, stageRank() devolvía 0, y el avance legítimo
//   call_scheduling→call_confirmed se interpretaba como "retroceso" y se bloqueaba.
//   → Ahora STAGE_ORDER se deriva del catálogo maestro STAGES (única fuente de verdad).
//
// DECISIÓN DE NEGOCIO (Camino 2 — validación humana del cierre):
//   Para MPX (ticket alto S/1,500, agentGoal=AGENDAR_LLAMADA), el "sí" de WhatsApp
//   NO es el cierre real — el cierre real es la llamada. Por eso el bot llega hasta
//   call_scheduling (coordina horario, su trabajo) pero NUNCA marca call_confirmed
//   por su cuenta: ese stage lo valida el humano (Joan) o el registro de la llamada.
//   Así el embudo no se infla con "confirmados" que luego no contestan el teléfono.
//   El cerebro IGUAL responde con calidez al lead que confirma; solo el dato interno
//   espera el visto bueno humano.
// ════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto'
import { pensarYResponder, summarizeBrainResult, AGENT_BRAIN_VERSION } from './agent-brain.js'
import prisma from '../db/prisma.js'
import { STAGES, MODES } from '../state/stage-definitions.js'
import { notificarEscalamiento } from '../webhook/notifications.js'
import { reportError } from '../lib/observability.js'

// ─────────────────────────────────────────────────────────────────────────
// Orden del embudo (para proteger contra retrocesos de stage).
// DERIVADO del catálogo maestro STAGES — NO hardcodear strings a mano (eso causó
// el bug #5). Índice mayor = más avanzado. El stage solo AVANZA, no retrocede,
// salvo que el cerebro escale a humano.
// ─────────────────────────────────────────────────────────────────────────
const STAGE_ORDER = [
  STAGES.FIRST_CONTACT,          // 0
  STAGES.DISCOVERY,              // 1
  STAGES.QUALIFYING_EMPRESA,     // 2
  STAGES.PRESENTING,             // 3
  STAGES.CALL_SCHEDULING,        // 4
  STAGES.CALL_CONFIRMED,         // 5
  STAGES.POST_CLOSE              // 6
]
// Nota: RETURNING_RECOGNITION se maneja por escalada/reactivación, no por el
// orden lineal del embudo, así que no entra en este array de avance.

// ─────────────────────────────────────────────────────────────────────────
// CAMINO 2 — Stages que el CEREBRO NO puede asignar por su cuenta.
// Estos los valida un humano (o el registro real del evento). Si el cerebro los
// sugiere, respondemos normal pero mantenemos el stage anterior.
// Para MPX: call_confirmed = "el lead confirmó la llamada DE VERDAD" → lo marca Joan.
// ─────────────────────────────────────────────────────────────────────────
const STAGES_SOLO_HUMANO = new Set([
  STAGES.CALL_CONFIRMED,
  // Sprint A.2 (inflación de stage, S8): el cerebro marcaba post_close solo porque
  // el lead DIJO "ya pagué" — sin comprobante validado. El cierre real lo valida
  // el humano (mismo principio Camino 2 que call_confirmed).
  STAGES.POST_CLOSE
])

export function stageRank(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? 0 : i
}

// ─────────────────────────────────────────────────────────────────────────
// AUTO-RESUME de HUMAN_ACTIVE (Bloque #4, jun 2026)
// Cuando el cerebro (o un comprobante, o el vendedor) deja al lead en
// HUMAN_ACTIVE, el bot se calla para no pisar al humano. Pero si NADIE atiende,
// el lead quedaba mudo PARA SIEMPRE (dolor visto en vivo 2026-06-15: el lead
// insistió tras escalar y recibió silencio). Este timer lo arregla:
//   modeEnteredAt = "última vez que un humano tocó la conversación" — se refresca
//   en CADA mensaje del vendedor (event-router) y en CADA escalada. Si pasaron
//   más de HUMAN_ACTIVE_RESUME_HORAS sin actividad humana, el cerebro RETOMA
//   cuando el lead vuelve a escribir (event-driven, sin cron).
// Seguro por diseño: si el humano está atendiendo, modeEnteredAt se refresca y
// el timer nunca vence → cero interrupción. Solo reanuda conversaciones
// ABANDONADAS. PAUSED (rechazo/cierre) NO se reanuda jamás — es terminal.
// Knob: HUMAN_ACTIVE_RESUME_HORAS (env, default 6; 0 = desactivado = pánico).
// ─────────────────────────────────────────────────────────────────────────
const HUMAN_ACTIVE_RESUME_HORAS = Number(process.env.HUMAN_ACTIVE_RESUME_HORAS ?? 6)

export function debeAutoReanudar(leadState) {
  if (!(HUMAN_ACTIVE_RESUME_HORAS > 0)) return false  // desactivado o valor inválido
  const entered = leadState?.modeEnteredAt ? new Date(leadState.modeEnteredAt).getTime() : null
  if (!entered) return false
  return (Date.now() - entered) >= HUMAN_ACTIVE_RESUME_HORAS * 3.6e6
}

/**
 * Arma el historial de la conversación para el cerebro.
 * Jala los últimos N mensajes del lead desde la BD, ordenados cronológicamente.
 */
/**
 * Persiste un mensaje del LEAD en la BD (FIX jun 2026 — LA MEMORIA del cerebro).
 * Hasta este fix, NADIE escribía en `messages` en el flujo del webhook: el único
 * create vivía en el endpoint manual del CRM. Resultado: construirHistorial()
 * devolvía SIEMPRE vacío y el cerebro veía "(esta es la primera interacción)"
 * en cada turno — operaba solo con stage+slots, amnésico a la conversación.
 * Un fallo aquí NO debe tumbar el turno: se loguea y se sigue.
 */
async function persistirMensajeLead(leadId, texto) {
  try {
    await prisma.message.create({ data: { leadId, origen: 'LEAD', texto } })
  } catch (err) {
    console.error(`[BrainPipeline] No se pudo persistir mensaje LEAD ${leadId}:`, err.message)
  }
}

// Pure: ¿el compromiso es FECHABLE? (tiene fecha_iso parseable y a FUTURO). Exportado para test.
export function compromisoEsValido(compromiso, ahoraMs = Date.now()) {
  if (!compromiso?.fecha_iso) return false
  const t = new Date(compromiso.fecha_iso).getTime()
  return !isNaN(t) && t > ahoraMs
}

// Registra/actualiza el COMPROMISO fechado del lead (motor de compromisos, Fase D).
// El cerebro detecta "te pago el viernes" y lo normaliza a ISO (compromiso.fecha_iso);
// aquí se guarda en `commitments` para que el motor lo recuerde al vencer. UPSERT del
// compromiso ACTIVO (sin cumplir + sin recordar): si el lead reprograma, se ACTUALIZA en
// vez de duplicar. Tabla por SQL crudo (no está en el schema de Prisma, igual que followup_queue).
async function persistirCompromiso(leadId, compromiso) {
  if (!compromisoEsValido(compromiso)) return   // sin fecha, inválida o pasada → ignorar
  const due = new Date(compromiso.fecha_iso)
  const desc = `${compromiso.tipo || 'otro'}: ${(compromiso.descripcion || 'compromiso del lead').trim()}`.slice(0, 300)
  try {
    const activo = await prisma.$queryRaw`
      SELECT id FROM commitments
      WHERE lead_id = ${leadId} AND fulfilled = false AND reminder_sent = false
      LIMIT 1`
    if (activo.length) {
      await prisma.$executeRaw`
        UPDATE commitments SET due_date = ${due.toISOString()}::timestamptz, description = ${desc}, updated_at = now()
        WHERE id = ${activo[0].id}::uuid`
    } else {
      await prisma.$executeRaw`
        INSERT INTO commitments (id, lead_id, description, due_date, fulfilled, reminder_sent, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${leadId}, ${desc}, ${due.toISOString()}::timestamptz, false, false, now(), now())`
    }
    console.log(`[BrainPipeline] 📌 compromiso lead ${leadId}: ${desc} @ ${due.toISOString()}`)
  } catch (err) {
    console.error(`[BrainPipeline] No se pudo registrar compromiso lead ${leadId}:`, err.message)
  }
}

async function construirHistorial(prisma, leadId, limite = 12) {
  const mensajes = await prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: limite,
    select: { origen: true, texto: true, createdAt: true }
  })

  // Vienen en desc (más nuevo primero); los invertimos a orden cronológico
  return mensajes.reverse().map(m => ({
    rol: m.origen === 'LEAD' ? 'lead' : 'agente',
    texto: m.texto
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// MEMORIA EPISÓDICA — lead que vuelve (jun 2026)
// Cuando un contacto que YA conversó antes (su conversación quedó en
// `conversaciones_archivadas`, p.ej. tras un reset) vuelve a escribir, el cerebro
// arrancaba de CERO (bug Rafael/Alberto). Esto le da "memoria entre sesiones":
// carga un RESUMEN DE HECHOS de sus conversaciones previas (nombre, producto,
// experiencia, hasta dónde llegó), NO el transcript crudo (memoria de hechos,
// estilo agent-memory 2026). SIN vector DB: a esta escala leer de Postgres es lo
// correcto y más barato (investigación 2026: long-context < stack vectorial para
// pocos usuarios/sesiones). ADDITIVE: si no hay historial previo devuelve null y
// el prompt queda IDÉNTICO (cero regresión para leads nuevos).
// ─────────────────────────────────────────────────────────────────────────
const STAGE_LEGIBLE_MEMORIA = {
  first_contact:         'apenas se estaban saludando',
  discovery:             'estaban conociéndose (qué quería exportar)',
  qualifying_empresa:    'ya habían hablado de su experiencia y empresa',
  presenting:            'ya le habías presentado el programa',
  call_scheduling:       'ya estaban coordinando una llamada',
  call_confirmed:        'ya habían confirmado una llamada',
  post_close:            'ya había avanzado al cierre',
  returning_recognition: 'ya había vuelto antes'
}

// Función PURA (testeable sin BD): arma el bloque de memoria desde filas archivadas.
export function construirResumenMemoria(filas, ahora = Date.now()) {
  if (!Array.isArray(filas) || filas.length === 0) return null
  const ult = filas[0]  // la conversación archivada más reciente
  const slots = ult.slots || {}
  // Filtra valores-basura para no "recordar" datos vacíos o de descarte.
  const limpio = (v) => (v && typeof v === 'string' && v.trim() && !/no especificad|no tengo|explorando|descart/i.test(v)) ? v.trim() : null

  const nombre = limpio(slots.nombre) || (ult.nombre_detectado && ult.nombre_detectado !== 'null' ? ult.nombre_detectado : null)
  const datos = []
  if (nombre) datos.push(`Nombre: ${nombre}`)
  if (limpio(slots.producto))    datos.push(`Le interesaba exportar: ${limpio(slots.producto)}`)
  if (limpio(slots.experiencia)) datos.push(`Experiencia: ${limpio(slots.experiencia)}`)
  if (limpio(slots.empresa))     datos.push(`Situación: ${limpio(slots.empresa)}`)

  let cuando = ''
  if (ult.archived_at) {
    const dias = Math.floor((ahora - new Date(ult.archived_at).getTime()) / 86400000)
    cuando = dias <= 0 ? ', hoy mismo' : dias === 1 ? ', hace 1 día' : `, hace ${dias} días`
  }

  const lineas = [
    `# 🧠 MEMORIA — ESTE CONTACTO NO ES NUEVO (ya conversaron antes${cuando})`,
    `⚠️ MUY IMPORTANTE — LEE ESTO ANTES DE RESPONDER: aunque el historial de mensajes de abajo esté vacío, este lead YA habló contigo en una sesión anterior (se archivó). Por lo tanto NO estás en el Momento 1 y este lead NO es un desconocido. Esto es lo que YA sabes de él/ella:`,
    ...datos.map(d => `- ${d}`)
  ]
  const hastaDonde = STAGE_LEGIBLE_MEMORIA[ult.stage_final]
  if (hastaDonde) lineas.push(`- La última vez ${hastaDonde}.`)
  lineas.push(`→ PROHIBIDO presentarte desde cero o preguntar su nombre/producto: YA los sabes (arriba). Salúdalo como un REENCUENTRO cálido y por su nombre (ej: "¡${nombre || 'Hola de nuevo'}! Qué gusto que vuelvas 😊"), y retoma con naturalidad desde donde quedaron. Trátalo como alguien CONOCIDO, no como un lead nuevo. (Este bloque MANDA sobre la apertura del Momento 1.)`)
  return lineas.join('\n')
}

async function cargarMemoriaEpisodica(prisma, telefono, leadIdActual) {
  if (!telefono) return null
  try {
    const filas = await prisma.$queryRawUnsafe(
      `SELECT nombre_detectado, slots, stage_final, archived_at
         FROM conversaciones_archivadas
        WHERE telefono = $1 AND lead_id_original <> $2
        ORDER BY id DESC LIMIT 3`,
      String(telefono), Number(leadIdActual) || 0
    )
    return construirResumenMemoria(filas)
  } catch (err) {
    // Degradación elegante (ADN #11): si la memoria falla, el cerebro sigue normal.
    console.error(`[BrainPipeline] memoria episódica falló (lead ${leadIdActual}):`, err.message)
    return null
  }
}

/**
 * Procesa un mensaje entrante usando el cerebro unificado.
 *
 * @param {object} args
 * @param {number} args.leadId - id del lead
 * @param {string} args.telefono - teléfono del lead
 * @param {string} args.mensajeActual - el texto que el lead acaba de enviar (combinado)
 * @param {string} args.tenantId - tenant
 * @param {string} args.vendorNombre - nombre del agente/vendedor (la identidad del bot)
 * @returns {Promise<object>} { ok, botResponse, brainResult, stateAfter }
 */
export async function procesarConCerebro({ leadId, telefono, mensajeActual, tenantId = 'peru_exporta', vendorNombre = 'Jhon' }) {
  const startTime = Date.now()

  try {
    // ─── 1. Cargar estado del lead + su campaña (en paralelo) ───
    const [leadState, lead] = await Promise.all([
      prisma.leadState.findUnique({ where: { leadId } }),
      prisma.lead.findUnique({
        where: { id: leadId },
        select: { campaignId: true, nombreDetectado: true, vendorId: true }
      })
    ])

    // ─── 1b. COMPUERTA DE MODO (FIX jun 2026) ───
    // Si un humano tiene la conversación (HUMAN_ACTIVE, por handoff fromMe o por
    // escalamiento del propio cerebro) o el lead está PAUSED, el cerebro NO
    // interviene. Sin esta compuerta, el bot respondía igual al siguiente mensaje
    // del lead e interrumpía al vendedor humano (el handoff solo cancelaba el
    // buffer del instante, no los turnos siguientes). El mensaje del lead SÍ se
    // persiste: la conversación no pierde memoria mientras el humano atiende.
    let modoActual = leadState?.currentMode || MODES.AUTO_CONSULTIVO

    // ─── 1c. AUTO-RESUME (Bloque #4) ───
    // Si el lead lleva HUMAN_ACTIVE_RESUME_HORAS en HUMAN_ACTIVE sin que ningún
    // humano lo atendiera (modeEnteredAt congelado), el cerebro RETOMA en vez de
    // seguir mudo. Solo HUMAN_ACTIVE (PAUSED es terminal). Ver debeAutoReanudar.
    if (modoActual === MODES.HUMAN_ACTIVE && debeAutoReanudar(leadState)) {
      const horas = ((Date.now() - new Date(leadState.modeEnteredAt).getTime()) / 3.6e6).toFixed(1)
      await prisma.leadState.update({
        where: { leadId },
        data: { currentMode: MODES.AUTO_CONSULTIVO, modeEnteredAt: new Date() }
      })
      console.log(`[BrainPipeline] ▶️ Auto-resume lead ${leadId}: ${horas}h sin actividad humana en HUMAN_ACTIVE → el cerebro retoma (umbral ${HUMAN_ACTIVE_RESUME_HORAS}h)`)
      modoActual = MODES.AUTO_CONSULTIVO
    }

    if (modoActual === MODES.HUMAN_ACTIVE || modoActual === MODES.PAUSED) {
      await persistirMensajeLead(leadId, mensajeActual)
      console.log(`[BrainPipeline] 🔇 Lead ${leadId} en modo ${modoActual} → cerebro en silencio (handoff)`)
      return {
        ok: true,
        botResponse: {
          text: null,
          bot_responded: false,
          generation: {
            method: `agent_brain_${AGENT_BRAIN_VERSION}`,
            reason: `modo_${modoActual.toLowerCase()}`
          }
        },
        brainResult: null,
        stateAfter: null,
        _pipeline_ms: Date.now() - startTime
      }
    }

    // Cargar el config de la campaña (el factSheet + comportamiento/agentGoal)
    let campaignConfig = null
    if (lead?.campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: lead.campaignId },
        select: { config: true, slug: true, nombre: true }
      })
      campaignConfig = campaign?.config || null
    }

    // ─── 2. Armar el historial desde la BD ───
    const historial = await construirHistorial(prisma, leadId)

    // ─── 2b. Persistir el mensaje del LEAD ───
    // DESPUÉS de armar el historial (el mensaje actual va aparte en el prompt
    // como "ÚLTIMO MENSAJE"; si entrara también al historial, se duplicaría).
    // Se persiste ANTES de llamar al cerebro: si el cerebro falla, el mensaje
    // del lead igual quedó registrado (sí lo recibimos).
    await persistirMensajeLead(leadId, mensajeActual)

    // ─── 3. Armar el estadoLead que el cerebro espera ───
    // Memoria episódica: si este contacto ya conversó antes (conversación
    // archivada), cargamos un resumen de hechos para que el cerebro lo RECONOZCA
    // (lead que vuelve). null si es nuevo → el prompt queda idéntico.
    const memoriaEpisodica = await cargarMemoriaEpisodica(prisma, telefono, leadId)
    if (memoriaEpisodica) {
      console.log(`[BrainPipeline] 🧠 Memoria episódica activa para lead ${leadId} (contacto ya conocido)`)
    }
    const estadoLead = {
      stage: leadState?.currentStage || STAGES.FIRST_CONTACT,
      slots: leadState?.slotsFilled || {},
      tenantId,
      vendorNombre,
      // Etiqueta del agente en el historial del prompt (nombreCorto). El nombre
      // real lo manda config.agente.nombre (Jhon); sin esto salía "AGENTE".
      agenteNombre: campaignConfig?.agente?.nombre || vendorNombre,
      memoriaEpisodica
    }

    // ─── 4. Llamar al CEREBRO ───
    const brainResult = await pensarYResponder({
      mensajeActual,
      historial,
      estadoLead,
      campaignConfig,
      vendorNombre
    })

    console.log(`[BrainPipeline] ${summarizeBrainResult(brainResult)}`)

    // Si el cerebro falló, devolvemos sin romper (el handler maneja el "no response")
    if (!brainResult.ok || !brainResult.mensaje) {
      return {
        ok: false,
        error: brainResult.error || 'brain_no_message',
        botResponse: null,
        brainResult
      }
    }

    // ─── 5. PROTEGER EL STAGE (no retroceder sin razón + bloqueo Camino 2) ───
    const stageActual = leadState?.currentStage || STAGES.FIRST_CONTACT
    const stageSugerido = brainResult.stage_sugerido || stageActual
    let stageFinal = stageActual

    if (brainResult.debe_escalar_humano) {
      // Si escala a humano, aceptamos el stage del cerebro — salvo que sea un stage
      // de solo-humano (no tendría sentido auto-asignarlo) O un RETROCESO.
      // FIX v5.1 (Sesión 2 de confirmación): al escalar tras hostilidad sostenida,
      // el cerebro sugirió "first_contact" y este camino se lo aceptó — degradó
      // call_scheduling → first_contact (dato corrupto en el embudo). La escalada
      // cambia el MODO, no borra el avance del lead.
      const candidato = STAGES_SOLO_HUMANO.has(stageSugerido) ? stageActual : stageSugerido
      stageFinal = stageRank(candidato) >= stageRank(stageActual) ? candidato : stageActual
    } else if (STAGES_SOLO_HUMANO.has(stageSugerido) && stageSugerido !== stageActual) {
      // CAMINO 2: el cerebro quiere marcar call_confirmed por su cuenta → NO se lo
      // permitimos. Respondemos normal (con calidez), pero el stage espera validación
      // humana. Esto evita inflar el embudo con confirmaciones de WhatsApp no validadas.
      console.log(`[BrainPipeline] 🔒 Stage de validación humana: cerebro sugirió "${stageSugerido}", se mantiene "${stageActual}" (lo marca el humano)`)
      stageFinal = stageActual
    } else if (stageRank(stageSugerido) >= stageRank(stageActual)) {
      // Solo avanza o se mantiene. NUNCA retrocede sin razón.
      stageFinal = stageSugerido
    } else {
      // El cerebro sugirió retroceder → lo ignoramos, mantenemos el avanzado
      console.log(`[BrainPipeline] ⚠️ Stage protegido: cerebro sugirió "${stageSugerido}" (retroceso desde "${stageActual}"), se mantiene "${stageActual}"`)
      stageFinal = stageActual
    }

    // ─── 6. Fusionar slots (los nuevos del cerebro sobre los existentes) ───
    const slotsExistentes = leadState?.slotsFilled || {}
    const slotsNuevos = brainResult.slots_detectados || {}
    const slotsFusionados = { ...slotsExistentes }
    for (const [k, v] of Object.entries(slotsNuevos)) {
      // Solo guardamos slots con valor real (no vacíos ni explicaciones raras)
      if (v && typeof v === 'string' && v.trim() && !v.toLowerCase().includes('vacío')) {
        slotsFusionados[k] = v
      }
    }

    // ─── 7. Guardar el estado actualizado en la BD ───
    // currentMode usa el catálogo MODES (NO strings a mano — eso causó el bug #4).
    await prisma.leadState.upsert({
      where: { leadId },
      update: {
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        lastMessageAt: new Date(),
        // Al escalar arrancamos el reloj del auto-resume (modeEnteredAt = ahora).
        // Sin esto el reloj quedaba en la fecha de creación del lead → el bot
        // retomaría casi al instante (bug cazado al diseñar el Bloque #4). El
        // comprobante (event-router) y el handoff del vendedor ya lo seteaban.
        ...(brainResult.debe_escalar_humano ? { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() } : {})
      },
      create: {
        leadId,
        currentStage: stageFinal,
        slotsFilled: slotsFusionados,
        currentMode: brainResult.debe_escalar_humano ? MODES.HUMAN_ACTIVE : MODES.AUTO_CONSULTIVO
      }
    })

    // ─── 7b. Sincronizar lead.nombreDetectado con el slot nombre (Sprint A.2) ───
    // Antes leads.nombreDetectado se quedaba con el pushName de WhatsApp ("JH")
    // mientras el cerebro ya sabía el nombre real ("Jorge") — el CRM mostraba el
    // dato viejo. El slot del cerebro (dicho por el lead) manda sobre el pushName.
    // Un fallo aquí no tumba el turno: es dato de vitrina, no de flujo.
    const nombreSlot = slotsFusionados.nombre
    if (nombreSlot && nombreSlot !== lead?.nombreDetectado) {
      try {
        await prisma.lead.update({ where: { id: leadId }, data: { nombreDetectado: nombreSlot } })
      } catch (err) {
        console.error(`[BrainPipeline] No se pudo sincronizar nombreDetectado del lead ${leadId}:`, err.message)
      }
    }

    // ─── 7c. NOTIFICAR AL VENDEDOR si el cerebro escaló (Fase B.1+) ───
    // Fire-and-forget: NO bloquea la respuesta al lead (el lead recibe su mensaje
    // cálido ya; el ping al vendedor viaja en paralelo). Sin esto, el lead escalado
    // quedaba en un agujero negro (HUMAN_ACTIVE sin que nadie se entere).
    if (brainResult.debe_escalar_humano) {
      notificarEscalamiento({
        leadId, telefono, nombre: nombreSlot || lead?.nombreDetectado || null,
        slots: slotsFusionados,
        vendorId: lead?.vendorId || 1,
        motivo: brainResult.razon_escalamiento || 'El asistente derivó este lead a un humano',
        ultimoMensajeLead: mensajeActual,
        respuestaBot: brainResult.mensaje,
        stage: stageFinal,
        // Inteligencia comercial: el cerebro la generó en ESTE mismo turno (cero
        // llamada extra). Solo viaja si vino con contenido; si no, el briefing
        // sale igual sin el bloque 🎯.
        dataExtra: brainResult.como_cerrarlo ? { comoCerrarlo: brainResult.como_cerrarlo } : null,
        nombrePrograma: campaignConfig?.agente?.nombreProducto || campaignConfig?.nombreProducto || 'el programa'
      }).catch(err => console.error(`[BrainPipeline] Notificación de escalamiento falló (lead ${leadId}):`, err.message))
    }

    // ─── 7d. Registrar COMPROMISO del lead (motor de compromisos, Fase D) ───
    // Fire-and-forget: si el lead prometió algo con fecha ("te pago el viernes"), lo
    // guardamos para que el motor lo recuerde al vencer. NO bloquea la respuesta al lead.
    // null en la inmensa mayoría de turnos → cero efecto.
    if (brainResult.compromiso?.fecha_iso) {
      persistirCompromiso(leadId, brainResult.compromiso)
        .catch(err => console.error(`[BrainPipeline] compromiso lead ${leadId}:`, err.message))
    }

    // ─── 8. Devolver con la forma que espera el handler ───
    return {
      ok: true,
      botResponse: {
        text: brainResult.mensaje,
        // FIX jun 2026: al escalar, el mensaje cálido del cerebro TAMBIÉN se envía
        // (regla 8 del prompt: "respóndele algo cálido para que no quede mudo").
        // Antes bot_responded=false silenciaba al lead vulnerable/HOT justo cuando
        // más importaba. El silencio de los turnos SIGUIENTES lo garantiza la
        // compuerta de modo (el upsert de abajo deja el lead en HUMAN_ACTIVE).
        bot_responded: true,
        generation: {
          // FIX jun 2026: la marca era 'agent_brain_v1' hardcodeada — los logs
          // decían v1 con el v4 vivo (falsa alarma del protocolo de pruebas).
          // Ahora se deriva de AGENT_BRAIN_VERSION: una sola fuente de verdad.
          method: `agent_brain_${AGENT_BRAIN_VERSION}`,
          reason: brainResult.debe_escalar_humano ? 'escalado_a_humano' : 'brain_response'
        },
        audit: brainResult.audit
      },
      brainResult,
      stateAfter: { stage: stageFinal, slots: slotsFusionados, escalado: brainResult.debe_escalar_humano },
      _pipeline_ms: Date.now() - startTime
    }

  } catch (err) {
    console.error('[BrainPipeline] Error:', err.message)
    reportError(err, { module: 'brain-pipeline', leadId })
    return {
      ok: false,
      error: `brain_pipeline_exception: ${err.message}`,
      botResponse: null,
      brainResult: null
    }
  }
}

export const BRAIN_PIPELINE_VERSION = 'v4_2_bloque4_autoresume_human_active'
