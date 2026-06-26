// src/api/inbox-actions.js — Hito 2 (Fase Frontend): acciones de ESCRITURA del Inbox.
// Todas asumen que verifyJwt ya corrió (request.user) y acotan con scopeWhere.
// Contrato: ../../../../packages/shared/types.ts (ReplyRequest / ModeRequest / AssignRequest).

import { scopeWhere, ROLES_VE_TODO } from '../lib/auth-guard.js'
import { MODES } from '../state/stage-definitions.js'
// Selector de proveedor (Evolution|Cloud), NO el sender de Evolution directo: así la
// respuesta del vendedor sale por el proveedor activo (default evolution = idéntico hoy;
// en cutover a Cloud no se queda atrás como pasaba al importar webhook/sender.js).
import { sendToWhatsApp } from '../whatsapp/send.js'
import { extraerDebrief, DEBRIEF_OUTCOMES } from '../brain/call-debrief.js'
import { esEtiquetaValida, normalizarEtiqueta } from '../../../../packages/shared/labels.js'

// ── Helpers puros (exportados para test) ───────────────────────────────────

// El toggle del vendedor solo permite tomar control / devolver al bot.
// PAUSED queda fuera a propósito (es terminal del cerebro, no un botón del CRM).
export function modoValido(mode) {
  return mode === MODES.HUMAN_ACTIVE || mode === MODES.AUTO_CONSULTIVO
}

// Reasignar leads = solo ADMIN/SUPERVISOR (un agente no mueve leads de otros).
export function puedeReasignar(user) {
  return ROLES_VE_TODO.has(user?.role)
}

// Etiquetar = cualquier vendedor sobre lo que ve (scopeWhere ya acota). La taxonomía
// válida vive en packages/shared/labels.js (fuente única back↔front). Re-export para test.
export { esEtiquetaValida }

// ── Handlers ───────────────────────────────────────────────────────────────

// POST /v2/leads/:id/reply — el vendedor responde: persiste como VENDEDOR, TOMA
// CONTROL (HUMAN_ACTIVE, el bot se calla) y manda por WhatsApp si hay instancia.
export async function replyV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const texto = (request.body?.texto || '').trim()
    if (!texto) return reply.code(400).send({ error: 'texto requerido' })

    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      include: {
        vendor: { select: { instanciaEvolution: true } },
        conversations: { orderBy: { updatedAt: 'desc' }, take: 1, select: { id: true } },
      },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    // 1) Persistir el mensaje del VENDEDOR.
    const msg = await prisma.message.create({
      data: { leadId: id, conversationId: lead.conversations?.[0]?.id ?? null, origen: 'VENDEDOR', texto },
    })

    // 2) Tomar control: el bot se calla y se refresca el reloj de auto-resume.
    await prisma.leadState.upsert({
      where: { leadId: id },
      update: { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
      create: { leadId: id, currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
    })

    // 3) Enviar por WhatsApp (si el vendedor tiene instancia). Fire-and-forget.
    const instancia = lead.vendor?.instanciaEvolution
    if (instancia) {
      sendToWhatsApp({ telefono: lead.telefono, text: texto, instanceName: instancia })
        .catch(e => console.error('[inbox-actions] reply WhatsApp:', e.message))
    }

    return reply.send({ ok: true, evento: { kind: 'message', origen: 'VENDEDOR', texto, at: msg.createdAt } })
  } catch (error) {
    console.error('[inbox-actions] replyV2:', error.message)
    return reply.code(500).send({ error: 'error al responder' })
  }
}

// POST /v2/leads/:id/mode — tomar control / devolver al bot.
export async function setModeV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const mode = request.body?.mode
    if (!modoValido(mode)) {
      return reply.code(400).send({ error: 'mode inválido (HUMAN_ACTIVE | AUTO_CONSULTIVO)' })
    }
    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    await prisma.leadState.upsert({
      where: { leadId: id },
      update: { currentMode: mode, modeEnteredAt: new Date() },
      create: { leadId: id, currentMode: mode, modeEnteredAt: new Date() },
    })
    return reply.send({ ok: true, mode })
  } catch (error) {
    console.error('[inbox-actions] setModeV2:', error.message)
    return reply.code(500).send({ error: 'error al cambiar el modo' })
  }
}

// POST /v2/leads/:id/assign — reasignar a otro vendedor (solo ADMIN/SUPERVISOR).
export async function assignV2(request, reply, prisma) {
  try {
    if (!puedeReasignar(request.user)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin puede reasignar' })
    }
    const id = Number(request.params.id)
    const vendorId = Number(request.body?.vendorId)
    if (!vendorId) return reply.code(400).send({ error: 'vendorId requerido' })

    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true, tenantId: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    // El vendedor destino debe existir, estar activo y ser del MISMO tenant (muro duro).
    const dest = await prisma.vendor.findFirst({
      where: { id: vendorId, tenantId: lead.tenantId, activo: true },
      select: { id: true, nombre: true },
    })
    if (!dest) return reply.code(400).send({ error: 'vendedor destino inválido' })

    await prisma.lead.update({ where: { id }, data: { vendorId, updatedAt: new Date() } })
    // Audit mínimo (tabla de auditoría dedicada = deuda futura).
    console.log(`[inbox-actions] reasignación: lead ${id} → vendor ${vendorId} (${dest.nombre}) por user ${request.user?.vendorId}`)

    return reply.send({ ok: true, vendorId, vendedor: dest.nombre })
  } catch (error) {
    console.error('[inbox-actions] assignV2:', error.message)
    return reply.code(500).send({ error: 'error al reasignar' })
  }
}

// POST /v2/leads/:id/label — etiqueta manual del vendedor (tag CRM, columna propia
// `lead_state.label`, inmune al upsert del bot). Texto libre en BD validado contra la
// taxonomía; label vacío/null = limpiar. Cualquier vendedor etiqueta lo que ve.
export async function setLabelV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const raw = request.body?.label
    if (!esEtiquetaValida(raw)) {
      return reply.code(400).send({ error: 'etiqueta inválida' })
    }
    const label = normalizarEtiqueta(raw)

    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    await prisma.leadState.upsert({
      where: { leadId: id },
      update: { label },
      create: { leadId: id, label },
    })
    return reply.send({ ok: true, label })
  } catch (error) {
    console.error('[inbox-actions] setLabelV2:', error.message)
    return reply.code(500).send({ error: 'error al etiquetar' })
  }
}

// POST /v2/leads/:id/debrief — el vendedor DICTA cómo le fue en la llamada; el cerebro lo
// estructura. Devuelve el PREVIEW {outcome, objecion, proximoPaso, fechaISO, resumen} para
// que el vendedor confirme antes de escribirlo al CRM (apply = paso futuro). Cualquier
// vendedor sobre su lead (scopeWhere).
export async function debriefV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const nota = request.body?.nota
    if (!nota || typeof nota !== 'string' || !nota.trim()) return reply.code(400).send({ error: 'nota requerida' })

    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      select: { id: true, nombreDetectado: true, telefono: true, leadState: { select: { currentStage: true } } },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    const d = await extraerDebrief({ nota, lead: { nombre: lead.nombreDetectado || lead.telefono, stage: lead.leadState?.currentStage } })
    return reply.send({ outcome: d.outcome, objecion: d.objecion, proximoPaso: d.proximoPaso, fechaISO: d.fechaISO, resumen: d.resumen })
  } catch (error) {
    console.error('[inbox-actions] debriefV2:', error.message)
    return reply.code(500).send({ error: 'error al procesar el debrief' })
  }
}

// POST /v2/leads/:id/debrief/save — el vendedor CONFIRMA el debrief (posiblemente editado)
// → se escribe un CallEvent (el registro canónico de "qué pasó en la llamada"). De paso
// alimenta el embudo/analytics (CallEvent.outcomeTag). Cualquier vendedor sobre su lead.
export async function saveDebriefV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const b = request.body || {}
    const outcome = DEBRIEF_OUTCOMES.includes(b.outcome) ? b.outcome : 'otro'

    const lead = await prisma.lead.findFirst({ where: { ...scopeWhere(request.user), id }, select: { id: true, vendorId: true } })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })
    const vendorId = request.user?.vendorId || lead.vendorId
    if (!vendorId) return reply.code(400).send({ error: 'sin vendedor para registrar la llamada' })

    const fechaProx = (typeof b.fechaISO === 'string' && !Number.isNaN(Date.parse(b.fechaISO))) ? new Date(b.fechaISO) : null
    const notas = [b.resumen, b.proximoPaso ? `Próximo: ${b.proximoPaso}` : null].filter(Boolean).join(' · ').slice(0, 1000)
    const objecion = (typeof b.objecion === 'string' && b.objecion.trim()) ? b.objecion.trim().slice(0, 300) : null

    await prisma.callEvent.create({
      data: {
        leadId: id, vendorId, occurredAt: new Date(), outcomeTag: outcome,
        vendorNotes: notas || null, condicionesEspeciales: objecion, fechaProximoEvento: fechaProx,
      },
    })
    console.log(`[inbox-actions] debrief guardado: lead ${id} outcome=${outcome} por vendor ${vendorId}`)
    return reply.send({ ok: true, outcome })
  } catch (error) {
    console.error('[inbox-actions] saveDebriefV2:', error.message)
    return reply.code(500).send({ error: 'error al guardar el debrief' })
  }
}
