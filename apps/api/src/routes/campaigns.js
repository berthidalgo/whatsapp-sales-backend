import { Prisma } from '@prisma/client'
// src/routes/campaigns.js

import { validarCampaignConfig, fusionarConfig, validarTriggers, normalizarTrigger, contieneBorrado } from '../config/campaign-schema.js'

// ── MURO MULTITENANT (auditoría pre-producción, jul 2026) ──
// Estos handlers operaban por `id` a secas y listaban SIN filtro. Con varios
// clientes en la misma BD eso significaba que, con un token válido de cualquier
// tenant, se podía:
//   · listar las campañas de todos los clientes (incluido el TELÉFONO de sus
//     vendedores, que viene en el include)
//   · editar el prompt del bot de otro cliente
//   · BORRAR la campaña de otro cliente (`DELETE /campaigns/:id`)
// Las escrituras y lecturas administrativas exigen el tenant del JWT.
function tenantDe(req) {
  if (!req?.user?.tenantId) throw Object.assign(new Error('tenant requerido en el token'), { statusCode: 403 })
  return req.user.tenantId
}

// Devuelve la campaña SOLO si es del tenant del usuario. null → el llamador 404ea.
// 404 y no 403: un 403 confirmaría que esa campaña existe en otro tenant.
async function campaignEnScope(prisma, req, id, extra = {}) {
  if (!Number.isInteger(id)) return null
  return prisma.campaign.findFirst({ where: { id, tenantId: tenantDe(req) }, ...extra })
}

const normalize = normalizarTrigger

// GET /campaigns
export async function getCampaigns(req, reply, prisma) {
  const campaigns = await prisma.campaign.findMany({
    where: { tenantId: tenantDe(req) },
    include: {
      vendor: { select: { id: true, nombre: true, telefono: true, role: true } },
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      _count: { select: { leads: true } }
    },
    orderBy: { createdAt: 'asc' }
  })
  return campaigns
}

// GET /campaigns/:id
export async function getCampaign(req, reply, prisma) {
  const campaign = await campaignEnScope(prisma, req, Number(req.params.id), {
    include: {
      vendor: true,
      triggers: true,
      steps: { orderBy: { orden: 'asc' } }
    }
  })
  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })
  return campaign
}

// POST /campaigns
export async function createCampaign(req, reply, prisma) {
  const { slug, nombre, vendorId, triggers = [], steps = [], config = null, activa = true } = req.body || {}

  if (!slug || !nombre || !vendorId) {
    return reply.code(400).send({ error: 'slug, nombre y vendorId son requeridos' })
  }

  // El vendedor asignado DEBE ser del mismo tenant: sin esta guarda se podía crear
  // una campaña colgada del vendedor de otro cliente (y sus leads caerían allá).
  const vendor = await prisma.vendor.findFirst({
    where: { id: Number(vendorId), tenantId: tenantDe(req) }, select: { id: true }
  })
  if (!vendor) return reply.code(400).send({ error: 'vendorId no pertenece a este tenant' })

  // Triggers: normalizados y sin duplicados (una campaña sin trigger nunca dispara).
  const vt = validarTriggers(triggers, { permitirVacios: !activa || config?.atribucion?.esCampanaDefault === true })
  if (!vt.ok) return reply.code(400).send({ error: 'triggers inválidos', detalles: vt.errores })

  // Config: si viene, debe cumplir el contrato de ficha (F1 forense).
  if (typeof activa !== "boolean") return reply.code(400).send({ error: "activa debe ser booleano" })
  if (activa && !config) return reply.code(400).send({ error: "Una campaña activa requiere ficha e identidad; usa activa=false para un borrador" })
  let configValido = null
  if (config !== undefined && config !== null) {
    const vc = validarCampaignConfig(config, { tenantId: tenantDe(req) })
    if (!vc.ok) return reply.code(400).send({ error: 'config inválido', detalles: vc.errores })
    configValido = config
  }

  const campaign = await prisma.campaign.create({
    data: {
      // El tenant se sella al crear (antes caía al default del schema,
      // 'peru_exporta', así que las campañas de cualquier cliente nacían allí).
      tenantId: tenantDe(req),
      slug: String(slug).toUpperCase(),
      nombre,
      activa,
      vendorId: Number(vendorId),
      ...(configValido ? { config: configValido } : {}),
      triggers: { create: vt.valores.map(texto => ({ texto })) },
      steps: {
        create: steps.map((s, i) => ({
          orden: i + 1,
          tipo: s.tipo,
          mensaje: s.mensaje,
          followupHrs: s.followupHrs || null
        }))
      }
    },
    include: {
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })

  return reply.code(201).send(campaign)
}

// PUT /campaigns/:id
export async function updateCampaign(req, reply, prisma) {
  const { nombre, activa, vendorId, config, version } = req.body || {}
  const id = Number(req.params.id)

  const previa = await campaignEnScope(prisma, req, id, { select: { id: true, config: true, version: true, activa: true } })
  if (!previa) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }

  if (config !== undefined && !Number.isInteger(version)) return reply.code(428).send({ error: 'version requerida: recarga la campaña' })
  if (version !== undefined && version !== previa.version) return reply.code(409).send({ error: 'La campaña cambió; recarga antes de guardar', version: previa.version })
  if (activa !== undefined && typeof activa !== 'boolean') return reply.code(400).send({ error: 'activa debe ser booleano' })
  if (config !== undefined && contieneBorrado(config, previa.config) && req.body?.force !== true) return reply.code(409).send({ error: 'Borrar datos exige force=true; desactiva primero una campaña sin ficha' })
  // El vendedor reasignado DEBE ser del mismo tenant (misma guarda que al crear).
  if (vendorId !== undefined) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: Number(vendorId), tenantId: tenantDe(req) }, select: { id: true }
    })
    if (!vendor) return reply.code(400).send({ error: 'vendorId no pertenece a este tenant' })
  }

  // Config parcial → merge por sección + contrato (omitir ≠ borrar).
  let configFusionado = undefined
  if (config !== undefined) {
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      return reply.code(400).send({ error: 'config debe ser un objeto' })
    }
    const actual = (previa.config && typeof previa.config === 'object') ? previa.config : {}
    try { configFusionado = config === null ? null : fusionarConfig(actual, config) } catch (e) { return reply.code(400).send({ error: e.message }) }
    if (configFusionado !== null) {
      const vc = validarCampaignConfig(configFusionado, { tenantId: tenantDe(req) })
      if (!vc.ok) return reply.code(400).send({ error: 'config inválido', detalles: vc.errores })
    }
  }

  if ((activa ?? previa.activa) && !validarCampaignConfig(configFusionado === undefined ? previa.config : configFusionado, { tenantId: tenantDe(req) }).ok) return reply.code(400).send({ error: 'No se puede activar sin ficha válida' })
  let campaign
  try { campaign = await prisma.campaign.update({
    where: { id, tenantId: tenantDe(req), version: previa.version },
    data: {
      ...(nombre !== undefined && { nombre }),
      ...(activa !== undefined && { activa }),
      ...(vendorId !== undefined && { vendorId: Number(vendorId) }),
      ...(configFusionado !== undefined && { config: configFusionado === null ? Prisma.DbNull : configFusionado }),
      version: { increment: 1 }
    },
    include: {
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })
  } catch (e) { if (e.code === 'P2025') return reply.code(409).send({ error: 'La campaña cambió; recarga antes de guardar' }); throw e }
  return campaign
}

// DELETE /campaigns/:id
export async function deleteCampaign(req, reply, prisma) {
  const id = Number(req.params.id)
  // Lo más destructivo del archivo: borrar la campaña de otro cliente le apaga el bot.
  const previa = await campaignEnScope(prisma, req, id, {
    select: { id: true, slug: true, config: true, _count: { select: { leads: true } } }
  })
  if (!previa) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }
  // Guarda anti-borrado accidental (F1 forense): con leads o siendo la default,
  // el borrado exige ?force=true explícito. Borrar la ficha con historial o la
  // campaña que atiende a los perdidos apaga ventas sin avisar.
  const esDefault = !!(previa.config && typeof previa.config === 'object' && previa.config.atribucion?.esCampanaDefault)
  const conLeads = (previa._count?.leads || 0) > 0
  const force = req.query?.force === 'true' || req.body?.force === true
  if ((conLeads || esDefault) && !force) {
    return reply.code(409).send({
      error: 'la campaña tiene historial o es la default: confirma con ?force=true',
      leads: previa._count?.leads || 0,
      esCampanaDefault: esDefault
    })
  }
  await prisma.campaign.delete({ where: { id } })
  return { ok: true }
}

// PUT /campaigns/:id/steps
export async function saveSteps(req, reply, prisma) {
  const campaignId = Number(req.params.id)
  const { steps } = req.body

  if (!Array.isArray(steps)) {
    return reply.code(400).send({ error: 'steps debe ser un array' })
  }

  // Los steps SON el guion del bot: reescribirlos en la campaña de otro cliente
  // le cambia lo que su bot le dice a sus clientas.
  if (!await campaignEnScope(prisma, req, campaignId, { select: { id: true } })) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }

  await prisma.$transaction([
    prisma.flowStep.deleteMany({ where: { campaignId } }),
    prisma.flowStep.createMany({
      data: steps.map((s, i) => ({
        campaignId,
        orden: i + 1,
        tipo: s.tipo,
        mensaje: s.mensaje,
        followupHrs: s.followupHrs || null
      }))
    })
  ])

  const updated = await prisma.flowStep.findMany({
    where: { campaignId },
    orderBy: { orden: 'asc' }
  })

  return updated
}

// POST /campaigns/:id/triggers
export async function addTrigger(req, reply, prisma) {
  const { texto } = req.body
  if (!texto) return reply.code(400).send({ error: 'texto requerido' })

  const campaignId = Number(req.params.id)
  if (!await campaignEnScope(prisma, req, campaignId, { select: { id: true } })) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }

  const vt = validarTriggers([texto])
  if (!vt.ok) return reply.code(400).send({ error: 'trigger inválido', detalles: vt.errores })
  const yaExiste = await prisma.trigger.findFirst({ where: { campaignId, texto: vt.valores[0] }, select: { id: true } })
  if (yaExiste) return reply.code(409).send({ error: 'ese trigger ya existe en esta campaña' })

  const trigger = await prisma.trigger.create({
    data: { texto: vt.valores[0], campaignId }
  })
  return reply.code(201).send(trigger)
}

// DELETE /campaigns/:id/triggers/:tid
export async function deleteTrigger(req, reply, prisma) {
  const campaignId = Number(req.params.id)
  const tid = Number(req.params.tid)

  // Doble guarda: la campaña es de este tenant Y el trigger es DE ESA campaña
  // (si no, con una campaña propia se borraban triggers de cualquier otra).
  if (!await campaignEnScope(prisma, req, campaignId, { select: { id: true } })) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }
  const trigger = await prisma.trigger.findFirst({ where: { id: tid, campaignId }, select: { id: true } })
  if (!trigger) return reply.code(404).send({ error: 'Trigger no encontrado' })

  await prisma.trigger.delete({ where: { id: tid } })
  return { ok: true }
}

// POST /campaigns/test-trigger
export async function testTrigger(req, reply, prisma) {
  const { mensaje, campaignId } = req.body

  const campaign = await campaignEnScope(prisma, req, Number(campaignId), {
    include: { triggers: true }
  })

  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

  const normalizedMsg = normalize(mensaje)
  const matched = campaign.triggers.find(t =>
    normalizedMsg.includes(normalize(t.texto))
  )

  return {
    match: !!matched,
    trigger: matched?.texto || null,
    campaign: matched ? { slug: campaign.slug, nombre: campaign.nombre } : null
  }
}

// Sprint 3 Bug 4: activar campaña exclusiva en producción
// Pausa todas las campañas del mismo vendedor y activa solo la seleccionada
export async function activarCampaign(req, reply, prisma) {
  const campaignId = Number(req.params.id)

  const campaign = await campaignEnScope(prisma, req, campaignId)
  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

  const vc = validarCampaignConfig(campaign.config, { tenantId: tenantDe(req) })
  if (!vc.ok) return reply.code(400).send({ error: 'No se puede activar sin ficha válida', detalles: vc.errores })
  await prisma.$transaction([
    prisma.campaign.updateMany({
      // El tenant también acota el APAGADO masivo: sin él, activar una campaña
      // desactivaba las de otro cliente que compartiera vendorId por accidente.
      where: { vendorId: campaign.vendorId, tenantId: tenantDe(req) },
      data: { activa: false, version: { increment: 1 } }
    }),
    prisma.campaign.update({
      where: { id: campaignId },
      data: { activa: true, version: { increment: 1 } }
    })
  ])

  const updated = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { vendor: true, steps: { orderBy: { orden: 'asc' } }, triggers: true }
  })

  return updated
}
