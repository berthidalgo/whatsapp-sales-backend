// src/api/flow.js — Flow Builder. El flujo es POR PROGRAMA (campaña): el supervisor
// elige cuál editar. Se guarda en `campaign.config.flow` como OVERRIDES (guía/label por
// nodo), no el grafo entero → a prueba de drift si el cerebro cambia su estructura.
import { materializarFlujoCerebro, aplicarOverrides, extraerOverrides, flowValido } from '../brain/flow-materializer.js'
import { copilotoFlujo } from '../brain/flow-copilot.js'
import { transcribirAudio } from '../lib/groq.js'
import { ROLES_VE_TODO } from '../lib/auth-guard.js'

// Resuelve la campaña en el scope del tenant (por id, o la primera activa si no se pide).
async function resolverCampana(prisma, tenantId, campaignId) {
  if (!tenantId) return null
  if (campaignId) {
    return prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true, nombre: true, config: true } })
  }
  return prisma.campaign.findFirst({ where: { tenantId, activa: true }, orderBy: { id: 'asc' }, select: { id: true, nombre: true, config: true } })
}

// GET /v2/campaigns — programas del tenant (para el selector del Flow Builder).
export async function listCampaignsV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.send([])
    const campaigns = await prisma.campaign.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: { id: true, slug: true, nombre: true, activa: true, config: true },
    })
    return reply.send(campaigns.map(c => ({
      id: c.id, slug: c.slug, nombre: c.nombre, activa: c.activa,
      tieneFlow: !!(c.config && typeof c.config === 'object' && c.config.flow),
    })))
  } catch (error) {
    console.error('[flow] listCampaignsV2:', error.message)
    return reply.code(500).send({ error: 'error al listar programas' })
  }
}

// GET /v2/flow?campaignId= — flujo del programa: semilla del cerebro + overrides guardados.
export async function getFlowV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    const campaignId = request.query?.campaignId ? Number(request.query.campaignId) : null
    const campana = await resolverCampana(prisma, tenantId, campaignId)
    const seed = materializarFlujoCerebro(campana?.nombre || undefined)
    const overrides = (campana?.config && typeof campana.config === 'object' && campana.config.flow?.nodes) || null
    const flow = aplicarOverrides(seed, overrides)
    return reply.send({ ...flow, campaignId: campana?.id ?? null })
  } catch (error) {
    console.error('[flow] getFlowV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener el flujo' })
  }
}

// PUT /v2/flow — guarda los overrides del flujo en la campaña. SOLO ADMIN/SUPERVISOR.
export async function saveFlowV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin edita el flujo' })
    }
    const tenantId = request.user?.tenantId
    const campaignId = Number(request.body?.campaignId)
    const flow = request.body?.flow
    if (!campaignId) return reply.code(400).send({ error: 'campaignId requerido' })
    if (!flowValido(flow)) return reply.code(400).send({ error: 'flujo inválido' })

    const campana = await resolverCampana(prisma, tenantId, campaignId)
    if (!campana) return reply.code(404).send({ error: 'programa no encontrado' })

    const overrides = extraerOverrides(flow)
    const configActual = (campana.config && typeof campana.config === 'object') ? campana.config : {}
    const nuevoConfig = { ...configActual, flow: { source: 'custom', updatedAt: new Date().toISOString(), nodes: overrides } }

    await prisma.campaign.update({ where: { id: campana.id }, data: { config: nuevoConfig } })
    console.log(`[flow] flujo guardado en campaña ${campana.id} (${Object.keys(overrides).length} nodos editados) por user ${request.user?.vendorId}`)
    return reply.send({ ok: true, campaignId: campana.id, nodosEditados: Object.keys(overrides).length })
  } catch (error) {
    console.error('[flow] saveFlowV2:', error.message)
    return reply.code(500).send({ error: 'error al guardar el flujo' })
  }
}

// POST /v2/flow/copilot — el copiloto conversacional propone ediciones del flujo.
// SOLO ADMIN/SUPERVISOR. Devuelve { respuesta, edits, aviso } — el front muestra el
// preview de `edits` y, si el supervisor confirma, los guarda con saveFlowV2.
export async function copilotV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin usa el copiloto' })
    }
    const tenantId = request.user?.tenantId
    const campaignId = request.body?.campaignId ? Number(request.body.campaignId) : null
    const mensaje = request.body?.mensaje
    const historial = Array.isArray(request.body?.historial) ? request.body.historial : []
    if (!mensaje || typeof mensaje !== 'string') return reply.code(400).send({ error: 'mensaje requerido' })

    const campana = await resolverCampana(prisma, tenantId, campaignId)
    const seed = materializarFlujoCerebro(campana?.nombre || undefined)
    const overrides = (campana?.config && typeof campana.config === 'object' && campana.config.flow?.nodes) || null
    const flow = aplicarOverrides(seed, overrides)

    const r = await copilotoFlujo({ flow, campaignNombre: campana?.nombre || '', historial, mensaje })
    return reply.send({ respuesta: r.respuesta, edits: r.edits, aviso: r.aviso })
  } catch (error) {
    console.error('[flow] copilotV2:', error.message)
    return reply.code(500).send({ error: 'error en el copiloto' })
  }
}

// POST /v2/transcribe — voz → texto (Whisper/Groq). Genérico para cualquier vendedor
// autenticado (lo usan el copiloto del supervisor Y el debrief del vendedor). Transcribir
// tu propia voz no es sensible; lo sensible (copilot/debrief) se gatea aguas abajo.
// body: { audioBase64, mimeType }.
export async function transcribeV2(request, reply) {
  try {
    const base64 = request.body?.audioBase64
    const mimeType = request.body?.mimeType || 'audio/webm'
    if (!base64 || typeof base64 !== 'string') return reply.code(400).send({ error: 'audioBase64 requerido' })

    const tr = await transcribirAudio({ base64, mimeType, language: 'es' })
    if (!tr.ok) return reply.code(502).send({ error: 'no se pudo transcribir', detalle: tr.error })
    return reply.send({ texto: tr.texto })
  } catch (error) {
    console.error('[flow] transcribeV2:', error.message)
    return reply.code(500).send({ error: 'error al transcribir' })
  }
}
