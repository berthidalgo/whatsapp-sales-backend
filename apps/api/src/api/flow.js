// src/api/flow.js — Agent Config + Copiloto Creador.
// Gestiona la configuración de negocio del agente (factSheet + agente) y el copiloto
// que ayuda al vendedor a configurar su bot mediante conversación.
// import { materializarFlujoCerebro, aplicarOverrides, extraerOverrides, flowValido } from '../brain/flow-materializer.js' // LEGACY: ya no se usa
import { copilotoFlujo } from '../brain/flow-copilot.js'
import { transcribirAudio } from '../lib/groq.js'
import { ROLES_VE_TODO } from '../lib/auth-guard.js'
import { validarCampaignConfig, fusionarConfig, validarTriggers, buscarClavePeligrosa, validarSteps, contieneBorrado } from '../config/campaign-schema.js'

function idPositivo(valor) {
  if (!['number', 'string'].includes(typeof valor) || String(valor).trim() === '') return null
  const id = Number(valor)
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null
}

// La misma preparación valida escritura y preview: forma, prototipo, borrado y ficha.
function prepararAgentConfig(configActual, body, tenantId) {
  const { factSheet, agente } = body
  if (factSheet === undefined && agente === undefined) return { status: 400, errores: ['nada que guardar: manda factSheet y/o agente'] }
  for (const [campo, valor] of [['factSheet', factSheet], ['agente', agente]]) {
    if (valor === undefined) continue
    if (valor !== null && (typeof valor !== 'object' || Array.isArray(valor))) return { status: 400, errores: [campo + ' debe ser un objeto o null'] }
    const peligro = buscarClavePeligrosa(valor)
    if (peligro) return { status: 400, errores: [`config rechazada: clave no permitida "${campo}.${peligro}"`] }
    if (body.force !== true && contieneBorrado(valor, configActual[campo])) return { status: 409, codigo: 'BORRADO_REQUIERE_CONFIRMACION', errores: ['Borrar datos exige force=true'] }
  }
  let config
  try { config = fusionarConfig(configActual, { ...(factSheet !== undefined && { factSheet }), ...(agente !== undefined && { agente }) }) }
  catch (e) { return { status: 400, errores: [e.message] } }
  const v = validarCampaignConfig(config, { tenantId })
  return v.ok ? { config } : { status: 400, errores: v.errores }
}

// Resuelve la campaña en el scope del tenant (por id, o la primera activa si no se pide).
async function resolverCampana(prisma, tenantId, campaignId) {
  if (!tenantId) return null
  if (campaignId) {
    return prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true, nombre: true, slug: true, activa: true, config: true, version: true } })
  }
  return prisma.campaign.findFirst({ where: { tenantId, activa: true }, orderBy: { id: 'asc' }, select: { id: true, nombre: true, slug: true, activa: true, config: true, version: true } })
}

// Slug a partir del nombre (para altas desde el CRM sin slug manual).
// Mayúsculas, sin acentos ni símbolos; la unicidad por tenant la garantiza la BD.
export function slugDesdeNombre(nombre) {
  // El recorte va ANTES del trim final: al revés, un nombre largo cortado a 24
  // puede dejar el slug terminado en "_" (guion colgando).
  const base = String(nombre || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 24)
    .replace(/^_+|_+$/g, '')
  return base || 'CAMPANA'
}

// GET /v2/campaigns — programas del tenant (para el selector del Flow Builder).
export async function listCampaignsV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
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
// Entrega `version`: el editor la devuelve en el PUT (control optimista). Sin ella
// dos supervisores se pisan en silencio (last-write-wins).
export async function getAgentConfigV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    const campaignId = request.query?.campaignId === undefined ? null : idPositivo(request.query.campaignId)
    if (request.query?.campaignId !== undefined && campaignId === null) return reply.code(400).send({ error: 'campaignId debe ser un entero positivo' })
    const campana = await resolverCampana(prisma, tenantId, campaignId)
    const config = (campana?.config && typeof campana.config === 'object') ? campana.config : {}
    return reply.send({
      campaignId: campana?.id ?? null,
      nombrePrograma: campana?.nombre ?? '',
      factSheet: config.factSheet || {},
      agente: config.agente || {},
      version: campana?.version ?? null,
    })
  } catch (error) {
    console.error('[agent-config] getAgentConfigV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener la configuración' })
  }
}

// GET /v2/campaigns/:id — detalle de un programa para el editor del CRM
// (ficha + triggers + steps + version, todo en scope del tenant).
export async function getCampaignV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    const id = idPositivo(request.params.id)
    if (id === null) return reply.code(400).send({ error: 'id inválido' })
    const campana = await prisma.campaign.findFirst({
      where: { id, tenantId },
      include: { triggers: true, steps: { orderBy: { orden: 'asc' } } },
    })
    if (!campana) return reply.code(404).send({ error: 'programa no encontrado' })
    const config = (campana.config && typeof campana.config === 'object') ? campana.config : {}
    return reply.send({
      id: campana.id, slug: campana.slug, nombre: campana.nombre,
      activa: campana.activa, version: campana.version,
      factSheet: config.factSheet || {}, agente: config.agente || {},
      triggers: campana.triggers.map(t => t.texto),
      steps: campana.steps,
    })
  } catch (error) {
    console.error('[flow] getCampaignV2:', error.message)
    return reply.code(500).send({ error: 'error al obtener el programa' })
  }
}

// PUT /v2/agent-config — guarda el config de negocio en la campaña. SOLO ADMIN/SUPERVISOR.
//
// Control optimista de versión (el CRM lo necesita para no perder borradores):
//   · GET entrega `version`; el PUT debe devolver esa misma `version`.
//   · sin `version` → 428 (el editor trabaja sobre una base desconocida).
//   · con `version` vieja → 409 con la ficha vigente (el front conserva el borrador
//     local y muestra el conflicto en vez de pisar al otro supervisor).
// La escritura es atómica (updateMany con predicado id+tenant+version): el check y el
// write van en la misma sentencia, sin ventana TOCTOU.
export async function saveAgentConfigV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin edita la configuración' })
    }
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    const campaignId = idPositivo(request.body?.campaignId)
    const version = request.body?.version

    if (campaignId === null) return reply.code(400).send({ error: 'campaignId requerido (entero positivo)' })
    if (version === undefined || version === null) {
      return reply.code(428).send({ error: 'version requerida: recarga la ficha (GET) y reintenta con su version' })
    }
    if (!Number.isInteger(version)) {
      return reply.code(400).send({ error: 'version debe ser un entero (el que entregó el GET)' })
    }

    const campana = await resolverCampana(prisma, tenantId, campaignId)
    if (!campana) return reply.code(404).send({ error: 'programa no encontrado' })

    const configActual = (campana.config && typeof campana.config === 'object') ? campana.config : {}
    const preparado = prepararAgentConfig(configActual, request.body || {}, tenantId)
    if (preparado.errores) return reply.code(preparado.status).send({ error: preparado.errores[0], detalles: preparado.errores, ...(preparado.codigo && { codigo: preparado.codigo }) })
    const nuevoConfig = { ...preparado.config, updatedAt: new Date().toISOString() }

    // Escritura atómica: solo escribe si la versión sigue siendo la que vio el editor.
    const escrito = await prisma.campaign.updateMany({
      where: { id: campana.id, tenantId, version },
      data: { config: nuevoConfig, version: { increment: 1 } },
    })
    if (escrito.count === 0) {
      // ¿Conflicto (otro supervisor guardó entremedio) o la campaña desapareció?
      const vigente = await resolverCampana(prisma, tenantId, campaignId)
      if (!vigente) return reply.code(404).send({ error: 'programa no encontrado' })
      const cfgVigente = (vigente.config && typeof vigente.config === 'object') ? vigente.config : {}
      return reply.code(409).send({
        error: 'la ficha cambió mientras la editabas: recarga y combina tu borrador (no se perdió nada)',
        version: vigente.version,
        factSheet: cfgVigente.factSheet || {},
        agente: cfgVigente.agente || {},
      })
    }
    console.log(`[agent-config] config guardado en campaña ${campana.id} v${version}→v${version + 1} por user ${request.user?.vendorId}`)
    return reply.send({ ok: true, campaignId: campana.id, version: version + 1 })
  } catch (error) {
    console.error('[agent-config] saveAgentConfigV2:', error.message)
    return reply.code(500).send({ error: 'error al guardar la configuración' })
  }
}

// POST /v2/agent-config/preview — valida un borrador SIN escribir (dry-run).
// SOLO ADMIN/SUPERVISOR. El CRM lo usa para mostrar errores de contrato y el precio
// que vería el cerebro antes de que el operador decida guardar.
export async function previewAgentConfigV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin previsualiza la configuración' })
    }
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    const campaignId = idPositivo(request.body?.campaignId)
    if (campaignId === null) return reply.code(400).send({ error: 'campaignId requerido (entero positivo)' })
    const campana = await resolverCampana(prisma, tenantId, campaignId)
    if (!campana) return reply.code(404).send({ error: 'programa no encontrado' })
    const configActual = (campana.config && typeof campana.config === 'object') ? campana.config : {}
    const preparado = prepararAgentConfig(configActual, request.body || {}, tenantId)
    if (preparado.errores) return reply.send({ ok: false, errores: preparado.errores, version: campana.version })
    const fusionado = preparado.config
    // Sin LLM, sin escritura, sin envío: solo contrato + lo que el cerebro leería.
    return reply.send({
      ok: true,
      version: campana.version,
      factSheet: fusionado.factSheet || {},
      agente: fusionado.agente || {},
      precioTexto: fusionado?.factSheet?.precio?.textoExacto || null,
    })
  } catch (error) {
    console.error('[agent-config] previewAgentConfigV2:', error.message)
    return reply.code(500).send({ error: 'error al previsualizar' })
  }
}

// POST /v2/campaigns — alta de programa desde el CRM. SOLO ADMIN/SUPERVISOR.
//
// Dos modos:
//   · borrador (borrador=true o activa=false): guarda la ficha parcial SIN validar el
//     contrato comercial. Una campaña pendiente de completar es un estado de negocio
//     válido, no un defecto: el cerebro hablará genérico hasta que tenga ficha.
//   · activa (por defecto): exige ficha válida + trigger, salvo la default de descubrimiento.
// El tenant se sella del JWT; el slug es único por tenant (409 si colisiona).
export async function createCampaignV2(request, reply, prisma) {
  try {
    if (!ROLES_VE_TODO.has(request.user?.role)) {
      return reply.code(403).send({ error: 'solo un supervisor/admin crea programas' })
    }
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(400).send({ error: 'sin tenant en el token' })
    const b = request.body || {}
    if (b.activa !== undefined && typeof b.activa !== 'boolean') return reply.code(400).send({ error: 'activa debe ser booleano' })
    if (b.borrador !== undefined && typeof b.borrador !== 'boolean') return reply.code(400).send({ error: 'borrador debe ser booleano' })
    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : ''
    if (!nombre) return reply.code(400).send({ error: 'nombre requerido' })

    // Vendedor dueño: el indicado (del mismo tenant) o el del creador.
    const vendorId = idPositivo(b.vendorId !== undefined ? b.vendorId : request.user?.vendorId)
    if (vendorId === null) return reply.code(400).send({ error: 'vendorId requerido' })
    const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId }, select: { id: true } })
    if (!vendor) return reply.code(400).send({ error: 'vendorId no pertenece a este tenant' })

    const esBorrador = b.borrador === true || b.activa === false
    const activa = esBorrador ? false : true

    // Config: en borrador se acepta parcial (objeto); activa exige contrato completo.
    let configValido = null
    if (b.config !== undefined && b.config !== null) {
      if (typeof b.config !== 'object' || Array.isArray(b.config)) {
        return reply.code(400).send({ error: 'config debe ser un objeto' })
      }
      const peligro = buscarClavePeligrosa(b.config)
      if (peligro) return reply.code(400).send({ error: `config rechazada: clave no permitida "${peligro}"` })
      if (!esBorrador) {
        const vc = validarCampaignConfig(b.config, { tenantId })
        if (!vc.ok) return reply.code(400).send({ error: 'config inválido', detalles: vc.errores })
      }
      configValido = b.config
    } else if (!esBorrador) {
      return reply.code(400).send({ error: 'config requerido para activar (usa borrador:true para guardar parcial)' })
    }

    // Steps (guion): forma y límites validados también en borrador (una fila de BD
    // con mensaje vacío o tipo inventado rompe la ejecución del flujo más tarde).
    let stepValores = []
    if (b.steps !== undefined && b.steps !== null) {
      const vs = validarSteps(b.steps)
      if (!vs.ok) return reply.code(400).send({ error: 'steps inválidos', detalles: vs.errores })
      stepValores = vs.valores
    }

    // Triggers: el alta activa exige al menos 1; el borrador puede no tener.
    const vt = validarTriggers(b.triggers === undefined ? [] : b.triggers, {
      permitirVacios: esBorrador || configValido?.atribucion?.esCampanaDefault === true,
    })
    if (!vt.ok) return reply.code(400).send({ error: 'triggers inválidos', detalles: vt.errores })
    const triggerValores = vt.valores

    // Slug: manual o derivado del nombre; único por tenant.
    let slug = (b.slug && String(b.slug).trim().toUpperCase()) || slugDesdeNombre(nombre)
    const existeSlug = await prisma.campaign.findFirst({ where: { slug, tenantId }, select: { id: true } })
    if (existeSlug) return reply.code(409).send({ error: `el slug "${slug}" ya existe en este tenant` })

    const campana = await prisma.campaign.create({
      data: {
        tenantId,
        slug,
        nombre,
        activa,
        vendorId,
        ...(configValido ? { config: configValido } : {}),
        ...(triggerValores.length ? { triggers: { create: triggerValores.map(texto => ({ texto })) } } : {}),
        ...(stepValores.length ? {
          steps: {
            create: stepValores.map((s, i) => ({
              orden: i + 1,
              tipo: s.tipo,
              mensaje: s.mensaje,
              followupHrs: s.followupHrs,
            })),
          },
        } : {}),
      },
      select: { id: true, slug: true, nombre: true, activa: true, version: true },
    })
    console.log(`[campaigns] programa creado ${campana.id} (${slug}, borrador=${esBorrador}) por user ${request.user?.vendorId}`)
    // Se devuelve el detalle completo (como GET /v2/campaigns/:id) para que el CRM
    // pueda abrir el editor recién creado sin una segunda ida: el `select` del
    // create solo trae los campos del alta.
    const creado = await prisma.campaign.findFirst({
      where: { id: campana.id, tenantId },
      include: { triggers: true, steps: { orderBy: { orden: 'asc' } } },
    })
    const cfg = (creado?.config && typeof creado.config === 'object') ? creado.config : {}
    return reply.code(201).send({
      id: creado.id, slug: creado.slug, nombre: creado.nombre,
      activa: creado.activa, version: creado.version, borrador: esBorrador,
      factSheet: cfg.factSheet || {}, agente: cfg.agente || {},
      triggers: (creado.triggers || []).map(t => t.texto),
      steps: creado.steps || [],
    })
  } catch (error) {
    // Conflicto de unicidad del slug (dos altas simultáneas del mismo slug en el
    // tenant): el pre-check no alcanza para cerrar la carrera, pero la BD sí la
    // rechaza. Sin esto, el P2002 se reportaría como 500 genérico.
    if (error?.code === 'P2002' && String(error?.meta?.target || '').includes('slug')) {
      return reply.code(409).send({ error: 'ese slug ya existe en este tenant' })
    }
    console.error('[campaigns] createCampaignV2:', error.message)
    return reply.code(500).send({ error: 'error al crear el programa' })
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
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    const campaignId = request.body?.campaignId === undefined ? null : idPositivo(request.body.campaignId)
    if (request.body?.campaignId !== undefined && campaignId === null) return reply.code(400).send({ error: 'campaignId debe ser un entero positivo' })
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
