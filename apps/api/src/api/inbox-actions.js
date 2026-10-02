// src/api/inbox-actions.js — Hito 2 (Fase Frontend): acciones de ESCRITURA del Inbox.
// Todas asumen que verifyJwt ya corrió (request.user) y acotan con scopeWhere.
// Contrato: ../../../../packages/shared/types.ts (ReplyRequest / ModeRequest / AssignRequest).

import { scopeWhere, ROLES_VE_TODO } from '../lib/auth-guard.js'
import { MODES } from '../state/stage-definitions.js'
// Selector de proveedor (Evolution|Cloud), NO el sender de Evolution directo: así la
// respuesta del vendedor sale por el proveedor activo (default evolution = idéntico hoy;
// en cutover a Cloud no se queda atrás como pasaba al importar webhook/sender.js).
import { sendToWhatsApp, proveedorActivo } from '../whatsapp/send.js'
import { persistirMensajeSaliente, enviarPlantilla } from '../whatsapp/transporte.js'
import { defaultChannelForTenant } from '../webhook/channel-resolver.js'
import { invalidarTurnoEnVuelo } from '../webhook/debounce.js'
import { checkAndMark } from '../webhook/idempotency.js'
import { extraerDebrief, DEBRIEF_OUTCOMES } from '../brain/call-debrief.js'
// El MISMO reloj del auto-resume que usa el pipeline real: si el preview no lo
// consultara, daría "no llega al modelo" para un lead que el bot va a retomar.
import { debeAutoReanudar } from '../brain/brain-pipeline.js'
import { esEtiquetaValida, normalizarEtiqueta } from '../../../../packages/shared/labels.js'
import { ACTIVE_TENANT } from '../lib/tenant.js'

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

// Horas que el lead lleva en su modo actual (para que el preview explique el
// auto-resume en vez de dar un "sí/no" sin contexto).
export function horasEnModo(leadState) {
  const t = leadState?.modeEnteredAt ? new Date(leadState.modeEnteredAt).getTime() : null
  if (!t || Number.isNaN(t)) return null
  return Math.round(((Date.now() - t) / 3.6e6) * 10) / 10
}

// El cuerpo del 409 cuando la ventana de 24 h de Meta está cerrada. Es el contrato que
// lee el front para ofrecer la plantilla, así que vive en una función pura y con test:
// si alguien le cambia una clave, el test cae antes que la pantalla del vendedor.
// `textoPendiente` viaja de vuelta para que el front no le borre lo que había escrito.
export function cuerpoVentanaCerrada(texto, env = process.env) {
  return {
    error: 'este chat está cerrado: el cliente no escribe desde hace más de 24 h',
    ventanaCerrada: true,
    plantilla: env.CLOUD_TEMPLATE_REAPERTURA || null,
    textoPendiente: texto,
  }
}

// La plantilla y su idioma pertenecen al número del cliente. Las env solo
// describen el número propio del deploy y nunca se heredan entre tenants.
export function plantillaReapertura(canal, tenantId, env = process.env) {
  if (!canal || canal.tenantId !== tenantId) return null
  const propia = canal.credenciales?.templates?.reapertura
  const entorno = tenantId === ACTIVE_TENANT ? env : {}
  const nombre = (typeof propia === 'string' ? propia : propia?.nombre) || entorno.CLOUD_TEMPLATE_REAPERTURA
  if (!nombre) return null
  return { nombre, idioma: propia?.idioma || canal.credenciales?.templateIdioma || entorno.CLOUD_TEMPLATE_IDIOMA || 'es' }
}

// Etiquetar = cualquier vendedor sobre lo que ve (scopeWhere ya acota). La taxonomía
// válida vive en packages/shared/labels.js (fuente única back↔front). Re-export para test.
export { esEtiquetaValida }

// ── Handlers ───────────────────────────────────────────────────────────────

// POST /v2/leads/:id/reply — el vendedor responde: persiste como VENDEDOR, TOMA
// CONTROL (HUMAN_ACTIVE, el bot se calla) y manda por WhatsApp si hay instancia.
export async function replyV2(request, reply, prisma, deps = {}) {
  try {
    const id = Number(request.params.id)
    const texto = typeof request.body?.texto === 'string' ? request.body.texto.trim() : ''
    if (!texto) return reply.code(400).send({ error: 'texto requerido' })
    if (texto.length > 4096) return reply.code(400).send({ error: 'texto de máx 4096 caracteres' })

    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      include: {
        vendor: { select: { instanciaEvolution: true } },
        conversations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
      },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    // 1) ENVIAR primero, y esperar el resultado (fix sep 2026). Antes se guardaba el
    //    mensaje, se respondía ok:true y el envío iba "fire-and-forget": el sender no
    //    lanza, devuelve {ok:false}, así que el .catch nunca veía nada. Con Evolution
    //    caído (o un vendedor sin instancia) el vendedor veía su mensaje "enviado" en el
    //    Inbox y el lead jamás lo recibía. Ahora un envío fallido es un error visible.
    //    Canal: el canal por defecto del cliente decide si sale por Meta o por Evolution.
    //    En Evolution, la instancia: la del vendedor → la del canal → la del entorno.
    const canal = await (deps.defaultChannelForTenant || defaultChannelForTenant)(lead.tenantId)
    if (!canal || canal.tenantId !== lead.tenantId) {
      return reply.code(409).send({ error: 'este cliente no tiene un canal de WhatsApp configurado' })
    }
    let instancia = null
    if (proveedorActivo(canal) === 'evolution') {
      instancia = lead.vendor?.instanciaEvolution || canal.externalKey || null
      if (!instancia) {
        return reply.code(409).send({ error: 'este cliente no tiene un canal de WhatsApp configurado' })
      }
    }
    const envio = await (deps.sendToWhatsApp || sendToWhatsApp)({ telefono: lead.telefono, text: texto, instanceName: instancia, canal })

    // VENTANA DE 24 H (sep 2026). Meta solo deja mandar texto libre si el lead escribió
    // en las últimas 24 h; pasado eso hay que reabrir con una plantilla aprobada. Antes
    // esto caía en el 502 genérico ("no se pudo enviar") y el vendedor no tenía idea de
    // por qué ni qué hacer: reescribía el mensaje, fallaba otra vez, y abandonaba.
    // Ahora es un caso propio, con el nombre de la plantilla que SÍ se puede usar.
    if (!envio?.ok && envio?.error === 'fuera_de_ventana_24h') {
      const propia = plantillaReapertura(canal, lead.tenantId)
      const cuerpo = cuerpoVentanaCerrada(texto, { CLOUD_TEMPLATE_REAPERTURA: propia?.nombre })
      console.log(`[inbox-actions] reply lead ${id}: ventana de 24 h cerrada (plantilla ${cuerpo.plantilla || 'NO configurada'})`)
      return reply.code(409).send(cuerpo)
    }

    if (!envio?.ok) {
      console.error(`[inbox-actions] reply lead ${id}: WhatsApp no salió (${envio?.error})`)
      return reply.code(502).send({ error: 'no se pudo enviar por WhatsApp', detalle: envio?.error || null })
    }

    // Takeover, AHORA que sabemos que el mensaje salió: invalida el turno del bot en
    // vuelo (su respuesta se descarta por obsoleta) y cancela el buffer pendiente.
    //
    // Por qué NO antes del envío: invalidar cancela el buffer del lead, y si luego el
    // envío falla (409 de ventana, 502) el lead se queda sin respuesta del bot Y sin
    // takeover humano — se perdía su mensaje. Con este orden, un envío fallido deja
    // el estado intacto y el bot sigue atendiendo, que es lo que esperaba el vendedor.
    // El costo es una ventana de carrera acotada por el propio envío: si el bot
    // termina y envía en esos segundos, el operador ve dos respuestas. Se acepta
    // porque perder el mensaje del lead es peor que una doble respuesta.
    (deps.invalidarTurnoEnVuelo || invalidarTurnoEnVuelo)(id)

    // 2) Persistir el mensaje del VENDEDOR (solo lo que de verdad salió).
    const msg = await (deps.persistirMensajeSaliente || persistirMensajeSaliente)(prisma, {
      data: { leadId: id, conversationId: lead.conversations?.[0]?.id ?? null, origen: 'VENDEDOR', texto },
      resultado: envio, canal, tenantId: lead.tenantId,
    })

    // 3) Tomar control: el bot se calla y se refresca el reloj de auto-resume.
    await prisma.leadState.upsert({
      where: { leadId: id },
      update: { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
      create: { leadId: id, currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
    })

    return reply.send({ ok: true, evento: { kind: 'message', origen: 'VENDEDOR', texto, at: msg.createdAt } })
  } catch (error) {
    console.error('[inbox-actions] replyV2:', error.message)
    return reply.code(500).send({ error: 'error al responder' })
  }
}

// POST /v2/leads/:id/reabrir — manda la plantilla aprobada que REABRE la ventana de 24 h.
//
// Es un endpoint aparte y no un reintento automático dentro de replyV2 a propósito: cada
// plantilla que sale SE COBRA. Un closer apurado dándole a "enviar" sobre treinta leads
// dormidos infla la factura de Meta y nadie se entera hasta el corte del mes. Así el
// vendedor ve el aviso, confirma, y el gasto es una decisión y no un accidente.
//
// La plantilla (CLOUD_TEMPLATE_REAPERTURA) debe estar aprobada en Meta y tener DOS
// variables en el cuerpo: {{1}} el nombre del lead, {{2}} el producto. Misma convención
// que CLOUD_TEMPLATE_FOLLOWUP_24H, para no inventar un formato por cada sitio.
export async function reabrirV2(request, reply, prisma, deps = {}) {
  try {
    const id = Number(request.params.id)
    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      include: {
        leadState: { select: { slotsFilled: true } },
        conversations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
      },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    const canal = await (deps.defaultChannelForTenant || defaultChannelForTenant)(lead.tenantId)
    if (!canal || canal.tenantId !== lead.tenantId) {
      return reply.code(409).send({ error: 'este cliente no tiene un canal de WhatsApp configurado' })
    }
    if (proveedorActivo(canal) !== 'cloud') {
      return reply.code(409).send({ error: 'las plantillas solo existen en la API oficial de Meta' })
    }
    const propia = plantillaReapertura(canal, lead.tenantId)
    if (!propia) return reply.code(409).send({ error: 'no hay plantilla de reapertura aprobada configurada para este canal' })
    const plantilla = propia.nombre

    // Idempotencia del envío DE PAGADO (este endpoint cobra): un doble clic, un retry
    // impaciente o un replay facturan dos veces a Meta. La marca se pone ANTES de
    // enviar (fail-safe: si el envío falla, el vendedor ve el error y reintenta a
    // propósito). Ventana corta a propósito (5 min): solo evita el doble toque, no
    // bloquea una reapertura legítima más tarde.
    const clave = `reabrir:${lead.tenantId}:${id}`
    if (!(deps.checkAndMark || checkAndMark)(clave, { plantilla, user: request.user?.vendorId })) {
      console.warn(`[inbox-actions] reabrir lead ${id}: envío ya intentado hace <5min — no se cobra dos veces`)
      return reply.code(409).send({ error: 'ya se intentó reabrir este chat hace un momento; espera unos minutos antes de reintentar' })
    }

    const slots = (lead.leadState?.slotsFilled && typeof lead.leadState.slotsFilled === 'object') ? lead.leadState.slotsFilled : {}
    const nombre = primerNombreLead(lead.nombreDetectado || slots.nombre)
    const producto = (lead.productoDetectado || slots.producto || '').toString().trim() || 'tu pedido'

    const envio = await (deps.enviarPlantilla || enviarPlantilla)({
      canal,
      telefono: lead.telefono,
      templateName: plantilla,
      languageCode: propia.idioma,
      components: [{ type: 'body', parameters: [
        { type: 'text', text: nombre || 'qué tal' },
        { type: 'text', text: producto },
      ]}],
    })
    if (!envio?.ok) {
      console.error(`[inbox-actions] reabrir lead ${id}: plantilla "${plantilla}" falló (${envio?.error})`)
      return reply.code(502).send({ error: 'no se pudo enviar la plantilla', detalle: envio?.error || null })
    }

    // El operador intervino y la plantilla SALE: el turno del bot queda obsoleto.
    (deps.invalidarTurnoEnVuelo || invalidarTurnoEnVuelo)(id)

    // Queda en el historial como lo que es: un mensaje del vendedor. El marcador dice que
    // fue plantilla para que nadie lo lea después como si el vendedor lo hubiera escrito.
    const texto = `[plantilla de reapertura enviada: ${plantilla}]`
    const msg = await (deps.persistirMensajeSaliente || persistirMensajeSaliente)(prisma, {
      data: { leadId: id, conversationId: lead.conversations?.[0]?.id ?? null, origen: 'VENDEDOR', texto },
      resultado: envio, canal, tenantId: lead.tenantId,
    })

    // El vendedor acaba de intervenir: toma control, igual que en una respuesta normal.
    await prisma.leadState.upsert({
      where: { leadId: id },
      update: { currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
      create: { leadId: id, currentMode: MODES.HUMAN_ACTIVE, modeEnteredAt: new Date() },
    })

    console.log(`[inbox-actions] plantilla "${plantilla}" enviada al lead ${id}; esperando respuesta del cliente`)
    return reply.send({ ok: true, plantilla, evento: { kind: 'message', origen: 'VENDEDOR', texto, at: msg.createdAt } })
  } catch (error) {
    console.error('[inbox-actions] reabrirV2:', error.message)
    return reply.code(500).send({ error: 'error al reabrir la conversación' })
  }
}

// Primer nombre, capitalizado. Una plantilla que saluda "Hola Jesus Gabriel Martínez Fl"
// suena a base de datos; descarta también basura tipo "51" o iniciales sueltas.
export function primerNombreLead(nombre) {
  const t = (nombre && String(nombre).trim()) || ''
  if (!t) return ''
  const tok = t.split(/\s+/)[0]
  if (tok.length < 2 || /\d/.test(tok)) return ''
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()
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
    // Al tomar control se calla lo pendiente; al devolver al bot se descarta lo
    // obsoleto para que el próximo turno lea el estado fresco.
    invalidarTurnoEnVuelo(id)
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

    // Escritura atómica acotada al tenant (check-then-act sin ventana TOCTOU).
    const escrito = await prisma.lead.updateMany({ where: { id, tenantId: lead.tenantId }, data: { vendorId, updatedAt: new Date() } })
    if (escrito.count === 0) return reply.code(404).send({ error: 'lead no encontrado' })
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

// POST /v2/leads/:id/preview — simulación SEGURA de un turno entrante.
//
// El CRM la usa para mostrar "qué haría el bot si el lead escribiera esto" SIN
// efectos: no envía WhatsApp, no persiste mensajes, no toca el estado y NO llama al
// LLM. Reproduce los gates deterministas previos al modelo en el MISMO orden que el
// pipeline real (brain-pipeline.js:444-454):
//   1. HUMAN_ACTIVE vencido por el auto-resume (debeAutoReanudar) → el bot retoma;
//   2. HUMAN_ACTIVE vigente → el bot se calla (llegariaAlModelo=false);
//   3. PAUSED → terminal, el bot se calla siempre;
//   4. resto → llega al modelo; si la ficha no tiene precio, hablaría genérico.
// El preview NO replica las reglas deterministas de negocio ni el LLM: corren en el
// turno real. El preview con inferencia vive en POST /debug/brain-test (gasta, solo ADMIN).
//
// body: { texto }.
export async function previewTurnoV2(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const texto = typeof request.body?.texto === 'string' ? request.body.texto.trim() : ''
    if (!texto) return reply.code(400).send({ error: 'texto requerido' })
    if (texto.length > 2000) return reply.code(400).send({ error: 'texto de máx 2000 caracteres' })

    const lead = await prisma.lead.findFirst({
      where: { ...scopeWhere(request.user), id },
      select: {
        id: true, tenantId: true, campaignId: true,
        leadState: { select: { currentMode: true, currentStage: true, modeEnteredAt: true } },
      },
    })
    if (!lead) return reply.code(404).send({ error: 'lead no encontrado' })

    const campana = lead.campaignId
      ? await prisma.campaign.findFirst({ where: { id: lead.campaignId, tenantId: lead.tenantId }, select: { id: true, config: true, version: true } })
      : await prisma.campaign.findFirst({ where: { tenantId: lead.tenantId, activa: true }, orderBy: { id: 'asc' }, select: { id: true, config: true, version: true } })
    const config = (campana?.config && typeof campana.config === 'object') ? campana.config : {}
    const precioTexto = config?.factSheet?.precio?.textoExacto
    const fichaTienePrecio = typeof precioTexto === 'string' && precioTexto.trim().length > 0
    const modo = lead.leadState?.currentMode || 'AUTO_CONSULTIVO'

    const advertencias = []
    if (!campana) advertencias.push('sin campaña (ni la del lead ni una activa): el bot hablaría genérico')
    else if (!fichaTienePrecio) advertencias.push('la ficha no tiene precio: el bot hablaría genérico hasta completar la ficha')

    const stage = lead.leadState?.currentStage || 'first_contact'
    const comun = {
      stage,
      campaignId: campana?.id ?? null, versionCampana: campana?.version ?? null,
      fichaTienePrecio, advertencias,
    }

    if (modo === 'PAUSED') {
      // Terminal: el auto-resume NUNCA revive un PAUSED (brain-pipeline:444-454).
      return reply.send({ ...comun, llegariaAlModelo: false, motivo: 'conversacion_pausada', modo })
    }

    if (modo === 'HUMAN_ACTIVE') {
      // Mismo reloj que el pipeline: si venció el auto-resume, el bot RETOMA (y en el
      // turno real también cambiaría el modo a AUTO_CONSULTIVO). Reportarlo como
      // "humano tiene control" cuando en realidad el bot va a hablar sería una
      // mentira Operativa para quien está ajustando la campaña.
      const reanuda = debeAutoReanudar(lead.leadState)
      if (reanuda) {
        return reply.send({
          ...comun,
          llegariaAlModelo: true,
          motivo: 'auto_resume_del_bot',
          modo,
          autoResumeHoras: horasEnModo(lead.leadState),
          nota: 'el humano lleva más del umbral sin actividad: el bot retoma este turno (y cambia el modo a AUTO_CONSULTIVO)',
        })
      }
      return reply.send({
        ...comun, llegariaAlModelo: false, motivo: 'humano_tiene_control', modo,
        horasEnControl: horasEnModo(lead.leadState),
      })
    }

    return reply.send({
      ...comun,
      llegariaAlModelo: true, motivo: 'llegaria_al_modelo', modo,
      nota: 'las reglas deterministas (vulnerabilidad, precio, slots) y el LLM corren en el turno real',
    })
  } catch (error) {
    console.error('[inbox-actions] previewTurnoV2:', error.message)
    return reply.code(500).send({ error: 'error al previsualizar el turno' })
  }
}
