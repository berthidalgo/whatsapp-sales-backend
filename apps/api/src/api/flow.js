// src/api/flow.js — Agent Config + Copiloto Creador.
// Gestiona la configuración de negocio del agente (factSheet + agente) y el copiloto
// que ayuda al vendedor a configurar su bot mediante conversación.
// import { materializarFlujoCerebro, aplicarOverrides, extraerOverrides, flowValido } from '../brain/flow-materializer.js' // LEGACY: ya no se usa
import { copilotoFlujo } from '../brain/flow-copilot.js'
import { transcribirAudio } from '../lib/groq.js'
import { ROLES_VE_TODO } from '../lib/auth-guard.js'
import { validarCampaignConfig, fusionarConfig, contieneBorrado } from '../config/campaign-schema.js'

// Resuelve la campaña en el scope del tenant (por id, o la primera activa si no se pide).
async function resolverCampana(prisma, tenantId, campaignId) {
  if (!tenantId) return null
  if (campaignId) {
    return prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true, nombre: true, config: true, version: true } })
  }
  return prisma.campaign.findFirst({ where: { tenantId, activa: true }, orderBy: { id: 'asc' }, select: { id: true, nombre: true, config: true, version: true } })
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

// GET /v2/agent-config?campaignId= — obtiene la configuración de negocio del agente
export async function getAgentConfigV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    const campaignId = request.query?.campaignId ? Number(request.query.campaignId) : null
    const campana = await resolverCampana(prisma, tenantId, campaignId)
    const config = (campana?.config && typeof campana.config === 'object') ? campana.config : {}
    return reply.send({ 
      campaignId: campana?.id ?? null,
      version: campana?.version ?? null,
      nombrePrograma: campana?.nombre ?? '',
      factSheet: config.factSheet || {},
      agente: config.agente || {}
    })
  } catch (error) {
    console.error('[agent-config] getAgentConfigV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener la configuración' })
  }
}

// PUT /v2/agent-config — guarda el config de negocio en la campaña. SOLO ADMIN/SUPERVISOR.
export async function saveAgentConfigV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin edita la configuración' })
    }
    const tenantId = request.user?.tenantId
    const campaignId = Number(request.body?.campaignId)
    const version = request.body?.version
    const factSheet = request.body?.factSheet
    const agente = request.body?.agente

    if (!campaignId) return reply.code(400).send({ error: 'campaignId requerido' })

    const campana = await resolverCampana(prisma, tenantId, campaignId)
    if (!campana) return reply.code(404).send({ error: 'programa no encontrado' })

    if (!Number.isInteger(version)) return reply.code(428).send({ error: 'version requerida: recarga la ficha' })
    if (version !== campana.version) return reply.code(409).send({ error: 'La ficha cambió; recarga antes de guardar', version: campana.version })
    // Merge POR SECCIÓN (omitir ≠ borrar) + contrato validado (F1 forense):
    // antes un spread ciego permitía guardar precio sin texto, monto incoherente
    // o borrar la ficha por accidente al omitir un campo.
    if (factSheet === undefined && agente === undefined) {
      return reply.code(400).send({ error: 'nada que guardar: manda factSheet y/o agente' })
    }
    if (factSheet !== undefined && (typeof factSheet !== 'object' || factSheet === null || Array.isArray(factSheet))) {
      return reply.code(400).send({ error: 'factSheet debe ser un objeto' })
    }
    if (agente !== undefined && (typeof agente !== 'object' || agente === null || Array.isArray(agente))) {
      return reply.code(400).send({ error: 'agente debe ser un objeto' })
    }
    const configActual = (campana.config && typeof campana.config === 'object') ? campana.config : {}
    if (request.body?.force !== true && (contieneBorrado(factSheet, configActual.factSheet) || contieneBorrado(agente, configActual.agente))) return reply.code(409).send({ error: 'Borrar datos exige force=true' })
    let fusionado
    try { fusionado = fusionarConfig(configActual, { ...(factSheet !== undefined && { factSheet }), ...(agente !== undefined && { agente }) }) } catch (e) { return reply.code(400).send({ error: e.message }) }
    const nuevoConfig = {
      ...fusionado,
      updatedAt: new Date().toISOString()
    }
    const v = validarCampaignConfig(nuevoConfig, { tenantId })
    if (!v.ok) return reply.code(400).send({ error: 'config inválido', detalles: v.errores })

    await prisma.campaign.update({ where: { id: campana.id, tenantId, version }, data: { config: nuevoConfig, version: { increment: 1 } } })
    console.log(`[agent-config] config guardado en campaña ${campana.id} por user ${request.user?.vendorId}`)
    return reply.send({ ok: true, campaignId: campana.id, version: version + 1 })
  } catch (error) {
    if (error.code === 'P2025') return reply.code(409).send({ error: 'La ficha cambió; recarga antes de guardar' })
    console.error('[agent-config] saveAgentConfigV2:', error.message)
    return reply.code(500).send({ error: 'error al guardar la configuración' })
  }
}

// POST /v2/flow/copilot — el copiloto conversacional propone ediciones de la configuración.
// SOLO ADMIN/SUPERVISOR. Devuelve { respuesta, edits } — el front muestra el
// preview de `edits` autocompletando el formulario.
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
    const configActual = (campana?.config && typeof campana.config === 'object') ? campana.config : {}

    const r = await copilotoFlujo({ configActual, campaignNombre: campana?.nombre || '', historial, mensaje })
    return reply.send({ respuesta: r.respuesta, edits: r.edits, usage: r.usage })
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
