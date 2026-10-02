// src/routes/campaigns.js

import { Prisma } from '@prisma/client'
import { validarCampaignConfig, fusionarConfig, validarTriggers, validarSteps, buscarClavePeligrosa, validarParaActivar, normalizarTrigger, contieneBorrado } from '../config/campaign-schema.js'

// ── MURO MULTITENANT (auditoría pre-producción, jul 2026) ──
// Estos handlers operaban por `id` a secas y listaban SIN filtro. Con varios
// clientes en la misma BD eso significaba que, con un token válido de cualquier
// tenant, se podía:
//   · listar las campañas de todos los clientes (incluido el TELÉFONO de sus
//     vendedores, que viene en el include)
//   · editar el prompt del bot de otro cliente
//   · BORRAR la campaña de otro cliente (`DELETE /campaigns/:id`)
// El tenant autenticado es obligatorio; nunca se sustituye por el del deploy.
function tenantDe(req) {
  if (!req?.user?.tenantId) throw Object.assign(new Error('sin tenant en el token'), { statusCode: 403 })
  return req.user.tenantId
}

// Devuelve la campaña SOLO si es del tenant del usuario. null → el llamador 404ea.
// 404 y no 403: un 403 confirmaría que esa campaña existe en otro tenant.
async function campaignEnScope(prisma, req, id, extra = {}) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return null
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

  if (typeof activa !== 'boolean') return reply.code(400).send({ error: 'activa debe ser booleano' })
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

  // Steps (guion): forma y límites validados antes de escribir (una fila con mensaje
  // vacío o tipo inventado revienta la ejecución del flujo más adelante).
  const vs = validarSteps(steps)
  if (!vs.ok) return reply.code(400).send({ error: 'steps inválidos', detalles: vs.errores })

  // Config: si viene, debe cumplir el contrato de ficha (F1 forense).
  if (activa && !config) return reply.code(400).send({ error: 'Una campaña activa requiere ficha e identidad; usa activa=false para un borrador' })
  let configValido = null
  if (config !== undefined && config !== null) {
    const peligro = buscarClavePeligrosa(config)
    if (peligro) return reply.code(400).send({ error: `config rechazada: clave no permitida "${peligro}"` })
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
        create: vs.valores.map((s, i) => ({
          orden: i + 1,
          tipo: s.tipo,
          mensaje: s.mensaje,
          followupHrs: s.followupHrs
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
// Edición comercial con control optimista: si se toca `config` se exige `version`
// (la que entregó el GET). Sin ella → 428; con una vieja → 409 con la ficha vigente
// (el borrador del editor no se pierde). Cambios no comerciales (nombre/activa/vendor)
// siguen sin versión. Escritura atómica (updateMany id+tenant+version).
export async function updateCampaign(req, reply, prisma) {
  const { nombre, activa, vendorId, config, version } = req.body || {}
  const id = Number(req.params.id)

  const previa = await campaignEnScope(prisma, req, id, { select: { id: true, config: true, version: true, activa: true } })
  if (!previa) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }

  if (activa !== undefined && typeof activa !== 'boolean') return reply.code(400).send({ error: 'activa debe ser booleano' })

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
    if (version === undefined || version === null) {
      return reply.code(428).send({ error: 'version requerida para editar la ficha: recarga la campaña y reintenta con su version' })
    }
    if (!Number.isInteger(version)) {
      return reply.code(400).send({ error: 'version debe ser un entero (el que entregó el GET)' })
    }
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      return reply.code(400).send({ error: 'config debe ser un objeto' })
    }
    if (req.body?.force !== true && contieneBorrado(config, previa.config)) return reply.code(409).send({ error: 'Borrar datos exige force=true; desactiva primero una campaña sin ficha', codigo: 'BORRADO_REQUIERE_CONFIRMACION' })
    const actual = (previa.config && typeof previa.config === 'object') ? previa.config : {}
    // Se valida la ENTRADA, no solo el resultado del merge: fusionarConfig asigna por
    // clave (`out[k] = v`), y `out['__proto__'] = x` dispara el setter del prototipo en
    // vez de crear una propiedad propia → la clave desaparecería del resultado y el
    // guardián posterior no la vería. Por eso el corte es antes del merge.
    const peligroEntrada = buscarClavePeligrosa(config)
    if (peligroEntrada) return reply.code(400).send({ error: `config rechazada: clave no permitida "${peligroEntrada}"` })
    configFusionado = config === null ? null : fusionarConfig(actual, config)
    if (configFusionado !== null) {
      const peligro = buscarClavePeligrosa(configFusionado)
      if (peligro) return reply.code(400).send({ error: `config rechazada: clave no permitida "${peligro}"` })
      const vc = validarCampaignConfig(configFusionado, { tenantId: tenantDe(req) })
      if (!vc.ok) return reply.code(400).send({ error: 'config inválido', detalles: vc.errores })
    }
  }

  const tenantId = tenantDe(req)
  // El gate de activación también aplica aquí: `PUT {activa:true}` es la misma
  // transición que `PATCH /activar`. Se valida la ficha RESULTANTE (el merge ya
  // hecho), no solo la config que vino en el body.
  const configResultante = configFusionado !== undefined ? configFusionado : previa.config
  if (activa ?? previa.activa) {
    const v = validarCampaignConfig(configResultante, { tenantId })
    if (!v.ok) return reply.code(409).send({ error: 'una campaña activa necesita ficha válida', detalles: v.errores })
  }
  if (activa === true) {
    const resultado = await prisma.campaign.findFirst({
      where: { id, tenantId },
      select: { triggers: { select: { id: true } }, steps: true },
    })
    const gate = validarParaActivar({
      config: configResultante,
      tenantId,
      triggerCount: resultado?.triggers?.length || 0,
      steps: resultado?.steps || [],
    })
    if (!gate.ok) {
      return reply.code(409).send({ error: 'la campaña no puede activarse hasta completar su ficha', detalles: gate.errores })
    }
  }

  const escrito = await prisma.campaign.updateMany({
    where: { id, tenantId, ...(config !== undefined ? { version } : activa === true ? { version: previa.version } : {}) },
    data: {
      ...(nombre !== undefined && { nombre }),
      ...(activa !== undefined && { activa }),
      ...(vendorId !== undefined && { vendorId: Number(vendorId) }),
      ...(configFusionado !== undefined && { config: configFusionado === null ? Prisma.DbNull : configFusionado }),
      // La versión solo sube cuando cambian los DATOS QUE EL EDITOR CONTROLA (la
      // ficha). Renombrar o pausar no debe fabricar un 409 al supervisor que tiene
      // la ficha abierta: el control de concurrencia es sobre el contenido comercial.
      ...(config !== undefined ? { version: { increment: 1 } } : {})
    },
  })
  if (escrito.count === 0) {
    const vigente = await campaignEnScope(prisma, req, id, { select: { id: true, config: true, version: true } })
    if (!vigente) return reply.code(404).send({ error: 'Campaña no encontrada' })
    return reply.code(409).send({
      error: 'la campaña cambió mientras la editabas: recarga y combina tu borrador (no se perdió nada)',
      version: vigente.version,
    })
  }
  const campaign = await prisma.campaign.findFirst({
    where: { id, tenantId },
    include: {
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })
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
  // Borrado atómico acotado al tenant (la guarda previa + este predicado van juntos:
  // si la campaña cambió de tenant entre ambas, el delete no toca nada).
  const borrado = await prisma.campaign.deleteMany({ where: { id, tenantId: tenantDe(req) } })
  if (borrado.count === 0) return reply.code(404).send({ error: 'Campaña no encontrada' })
  return { ok: true }
}

// PUT /campaigns/:id/steps
export async function saveSteps(req, reply, prisma) {
  const campaignId = Number(req.params.id)
  const { steps } = req.body

  if (!Array.isArray(steps)) {
    return reply.code(400).send({ error: 'steps debe ser un array' })
  }
  const vs = validarSteps(steps)
  if (!vs.ok) return reply.code(400).send({ error: 'steps inválidos', detalles: vs.errores })

  // Los steps SON el guion del bot: reescribirlos en la campaña de otro cliente
  // le cambia lo que su bot le dice a sus clientas.
  if (!await campaignEnScope(prisma, req, campaignId, { select: { id: true } })) {
    return reply.code(404).send({ error: 'Campaña no encontrada' })
  }

  await prisma.$transaction([
    prisma.flowStep.deleteMany({ where: { campaignId } }),
    prisma.flowStep.createMany({
      data: vs.valores.map((s, i) => ({
        campaignId,
        orden: i + 1,
        tipo: s.tipo,
        mensaje: s.mensaje,
        followupHrs: s.followupHrs
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
// Pausa todas las campañas del mismo vendedor y activa solo la seleccionada.
//
// GATE DE CONTRATO (este cambio): activar es poner al bot a hablar con clientes
// reales, así que la ficha debe cumplir el contrato completo y tener ≥1 trigger (salvo la default de descubrimiento) —
// incluso si la campaña nació como borrador (que sí acepta ficha parcial). Sin este
// gate, `borrador:true` + precio incoherente + `PATCH /activar` dejaban un bot vivo
// con una ficha que el guardrail de precio jamás vio.
export async function activarCampaign(req, reply, prisma) {
  const campaignId = Number(req.params.id)

  const campaign = await campaignEnScope(prisma, req, campaignId, {
    select: { id: true, slug: true, vendorId: true, version: true, config: true, triggers: { select: { id: true } }, steps: true },
  })
  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

  const gate = validarParaActivar({
    config: campaign.config,
    tenantId: tenantDe(req),
    triggerCount: campaign.triggers?.length || 0,
    steps: campaign.steps || [],
  })
  if (!gate.ok) {
    return reply.code(409).send({
      error: 'la campaña no puede activarse hasta completar su ficha',
      detalles: gate.errores,
    })
  }

  const tenantId = tenantDe(req)
  try {
    await prisma.$transaction([
      prisma.campaign.updateMany({
        where: { vendorId: campaign.vendorId, tenantId },
        data: { activa: false },
      }),
      // Si la ficha o el vendedor cambió tras el gate, P2025 revierte el apagado.
      prisma.campaign.update({
        where: { id: campaignId, tenantId, vendorId: campaign.vendorId, version: campaign.version },
        data: { activa: true },
      }),
    ])
  } catch (e) {
    if (e.code === 'P2025') return reply.code(409).send({ error: 'la campaña cambió durante la activación; recarga y reintenta' })
    throw e
  }

  const updated = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    include: { vendor: true, steps: { orderBy: { orden: 'asc' } }, triggers: true }
  })

  return updated
}
