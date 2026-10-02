// Reglas del turno compartidas por todos los modelos. Solo usan datos del lead y la ficha.
const normalizar = texto => String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const clausulas = texto => normalizar(texto).split(/[.!?;\n]+|,|\bpero\b|\bsin embargo\b/).map(s => s.trim()).filter(Boolean)

function afirmado(texto, patron) {
  const rx = new RegExp(patron.source, patron.flags.replace('g', '') + 'g')
  for (const m of normalizar(texto).matchAll(rx)) {
    const antes = normalizar(texto).slice(Math.max(0, m.index - 35), m.index)
    if (!/\b(?:no|nunca|ya no|no es que)\s*$/.test(antes)) return true
  }
  return false
}

export function detectarVulnerabilidadGrave(mensaje) {
  const t = normalizar(mensaje)
  // Falta de necesidades básicas y pérdida personal explícita. No confundir inventario.
  const hambre = /\bno (?:tengo|tenemos|me queda|nos queda)(?: (?:dinero|ni))? para (?:comer|alimentar (?:a )?(?:mis|los) hijos)\b/
  const perdida = /\b(?:no me queda nada|me quede sin nada|lo perdi todo)\b(?!\s+(?:de|del)\s+(?!(?:dinero|plata|recursos|ahorros)\b))(?!\s+(?:stock|inventario|mercaderia|productos?|existencias)\b)/
  if (afirmado(t, hambre) || afirmado(t, perdida)) return true
  const vendioBienes = afirmado(t, /\bvendi\s+(?:(?:mis|mi|todas mis|todos mis)\s+)?(?:parcelas?|terrenos?|tierras?|casa|cosas|todo)\b(?!\s+(?:mi |el |nuestro )?(?:stock|inventario|mercaderia|productos?|existencias)\b)/)
  const deuda = afirmado(t, /\b(?:estoy endeudad[oa]|me endeude)\b/)
  const desesperacion = afirmado(t, /\b(?:es mi ultima esperanza|estoy desesperad[oa]|no tengo como pagar|no puedo pagar mis deudas)\b/)
  return (vendioBienes || deuda) && desesperacion
}

const RX_RECHAZA = /\b(?:no|nunca)\s+(?:(?:quiero|quisiera|deseo|necesito|acepto|puedo|podemos)\b.{0,55}(?:llam|telefono)|(?:me|nos)\s+(?:(?:pueden|puedes|van a)\s+)?llam|llam)|\b(?:prefiero|mejor)\s+(?:solo\s+)?(?:por\s+)?(?:chat|escrito)\b/
const RX_PIDE = /\b(?:llamame|llamenme)\b|\b(?:quiero|quisiera|necesito|deseo)\s+(?:que me llamen|(?:una )?llamada|hablar por telefono)\b|\b(?:puede ser por (?:una )?llamada|(?:me )?pueden llamar|(?:me )?puedes llamar|que me llamen|me van a llamar|podemos hablar por telefono|podemos hablar por (?:una )?llamada)\b/

function intencionLlamada(mensaje) {
  let ultima = null
  for (const texto of clausulas(mensaje)) {
    if (RX_RECHAZA.test(texto)) ultima = { tipo: 'rechaza', texto }
    else if (RX_PIDE.test(texto)) ultima = { tipo: 'pide', texto }
  }
  return ultima
}

export function detectarPideLlamada(mensaje) {
  return intencionLlamada(mensaje)?.tipo === 'pide'
}

export function aplicarNudgeLlamada(prompt, mensaje, vertical) {
  if (vertical?.VERTICAL_ID !== 'exportacion' || !detectarPideLlamada(mensaje)) return prompt
  return `${prompt}\n\n# El lead PIDE la llamada él mismo. Atiende la solicitud sin volver al cuestionario; respeta el horario que indicó y no inventes disponibilidad.`
}

function respuestaRegla(model, startTime, datos) {
  return {
    ok: true, mensaje: '', razonamiento: '', slots_detectados: {}, momento_actual: null,
    stage_sugerido: 'discovery', debe_escalar_humano: false, razon_escalamiento: null,
    como_cerrarlo: null, temperatura_lead: 'warm', compromiso: null, cierre: null,
    enviar_imagen: null, guardrail_flags: [], via_fallback: false,
    ...datos,
    audit: { model, fallback: false, proveedor: 'regla', tokens: 0, cost_usd: 0, latency_ms: Date.now() - startTime }
  }
}

const mostrarDia = dia => String(dia || '').replace(/manana/g, 'mañana').replace(/miercoles/g, 'miércoles').replace(/sabado/g, 'sábado')
const RX_DIA = /\b(?:pasado manana|manana|hoy|(?:el )?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/
const RX_HORA = /\b(?:a las?\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)\b|\ba las?\s+(?:[01]?\d|2[0-3])(?::[0-5]\d)?\b/
const RX_INMINENTE = /\b(?:ahorita|ahora(?: mismo)?|en (?:[1-9]|[12]\d|30) minutos?)\b|\b(?:llamame|llamenme|me llamen)\s+ya\b/

function preferenciaLlamada(mensaje, historial, slots = {}) {
  let preferencia = slots._canal_contacto === 'chat' ? { tipo: 'rechaza' } : slots._canal_contacto === 'llamada' ? { tipo: 'pide' } : null
  if (preferencia) return intencionLlamada(mensaje) || preferencia
  for (const m of historial || []) if (m?.rol === 'lead') preferencia = intencionLlamada(m.texto) || preferencia
  return intencionLlamada(mensaje) || preferencia
}

function reglaLlamada(ctx) {
  if (ctx.vertical?.VERTICAL_ID !== 'exportacion') return null
  const t = normalizar(ctx.mensajeActual).replace(/(\d)\s*([ap])\.?\s*m\.?\b/g, '$1$2m')
  const intencion = intencionLlamada(t)
  const preferencia = preferenciaLlamada('', ctx.historial, ctx.estadoLead.slots)
  const contextoCita = ['call_scheduling','call_confirmed'].includes(ctx.estadoLead.stage) && (ctx.estadoLead.slots?.fecha_hora || preferencia?.tipo === 'pide')
  const horaInmediata = /^(?:ahorita|ahora(?: mismo)?|en (?:[1-9]|[12]\d|30) minutos?)[!?\s]*$/.test(t)
  const sigueCoordinando = !intencion && contextoCita && preferencia?.tipo !== 'rechaza' && (RX_DIA.test(t) || RX_HORA.test(t) || horaInmediata)
  if (intencion?.tipo !== 'pide' && !sigueCoordinando) return null
  const base = { slots_detectados: { _canal_contacto: 'llamada' }, stage_sugerido: 'call_scheduling', momento_actual: 'M5', temperatura_lead: 'hot', cierre: { ofrecio_llamada: true, objecion_trabajada: 'ninguna', palanca: 'cierre_suave' } }
  const tiempoSolicitado = (intencion?.texto || t).replace(/\bahora si\b/g, '').replace(/\bno\s+(?:ahora(?: mismo)?|ahorita|ya)\b/g, '')
  const diaFuturo = /\b(?:manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(tiempoSolicitado)
  if (RX_INMINENTE.test(tiempoSolicitado) && !diaFuturo) {
    return respuestaRegla('regla_llamada', ctx.startTime, { ...base,
      mensaje: '¡Claro! Paso tu solicitud al equipo para que puedan llamarte lo antes posible 📲 Te confirmarán por aquí.',
      debe_escalar_humano: true, razon_escalamiento: 'llamada inmediata solicitada por el lead',
      como_cerrarlo: 'El lead quiere hablar ahora. Contactarlo y confirmar disponibilidad, sin prometer una hora no verificada.',
      guardrail_flags: ['llamada_inminente_derivada'] })
  }
  let dia = t.match(RX_DIA)?.[0]
  const hora = t.match(RX_HORA)?.[0]
  if (!dia && hora) {
    dia = normalizar(ctx.estadoLead.slots?.fecha_hora).match(RX_DIA)?.[0]
    if (!dia && sigueCoordinando) {
      for (const m of [...(ctx.historial || [])].reverse()) {
        if (m?.rol === 'lead' && (dia = normalizar(m.texto).match(RX_DIA)?.[0])) break
      }
    }
  }
  if (dia && hora) {
    const horario = `${mostrarDia(dia)} ${hora}`
    return respuestaRegla('regla_llamada', ctx.startTime, { ...base,
      mensaje: `Anoto tu solicitud de llamada para ${horario} 📲 Paso el horario al equipo para que te confirme disponibilidad por aquí.`,
      slots_detectados: { _canal_contacto: 'llamada', fecha_hora: horario }, debe_escalar_humano: true,
      razon_escalamiento: 'horario de llamada solicitado por el lead', como_cerrarlo: `Confirmar disponibilidad para ${horario}.`,
      guardrail_flags: ['llamada_horario_derivado'] })
  }
  return respuestaRegla('regla_llamada', ctx.startTime, { ...base,
    mensaje: dia ? `¡Claro! Coordinemos la llamada para ${mostrarDia(dia)} 📲 ¿A qué hora te viene bien?`
      : hora ? `¡Claro! Anoto que prefieres ${hora} 📲 ¿Qué día te viene bien?`
        : '¡Claro! Coordinemos una llamada corta 📲 ¿Te acomoda mañana a las 10am o prefieres otro horario? El equipo confirmará disponibilidad.',
    guardrail_flags: ['llamada_solicitada_sin_cuestionario'] })
}

function datosPedido(mensaje, estado, detectados, config) {
  const t = String(mensaje || '')
  const n = normalizar(t)
  const producto = config?.agente?.nombreProducto || config?.nombreProducto
  if (!config?.factSheet || !producto) return null
  const compra = afirmado(n, /\b(?:quiero|deseo|me llevo|llevame|enviame|mandame|pido|compro|confirmo)\s+(?:(?:el|la|los|las|de)\s+)*(?:[1-9]\d?|un[oa]?|dos|tres|cuatro|cinco)\b/)
  const anteriores = estado?.slots || {}
  if (anteriores._pedido) return null
  if (/\bno\s+(?:quiero|deseo|compro|confirmo)|\b(?:cancela|cancelar|cancelo)\b/.test(n)) return null
  const aportaDatos = /\b(?:soy|me llamo|vivo en|av\.?|jr\.?|calle|direccion)\b/.test(n)
  if (!compra && !(estado?.stage === 'call_scheduling' && anteriores.cantidad && aportaDatos)) return null
  // Un producto distinto al de la campaña nunca se convierte en el producto de la ficha.
  const objeto = n.match(/\b(?:quiero|deseo|me llevo|llevame|enviame|mandame|pido|compro|confirmo)\s+(?:(?:el|la|los|las|de)\s+)*(?:[1-9]\d?|un[oa]?|dos|tres|cuatro|cinco)\b\s*([^,.;\n]*)/)?.[1]?.trim()
  if (objeto && !/^(?:soy|vivo|para|unidades?\b|y\b)/.test(objeto) && !normalizar(producto).includes(objeto) && !objeto.includes(normalizar(producto))) return null
  if (anteriores.producto && normalizar(anteriores.producto) !== normalizar(producto)) return null
  const s = { ...anteriores }
  for (const [k, v] of Object.entries(detectados || {})) {
    if (['nombre','ciudad','distrito','direccion','referencia'].includes(k) && typeof v === 'string' && v.trim() && n.includes(normalizar(v).trim())) s[k] = v.trim()
  }
  const nombre = t.match(/\b(?:soy|me llamo|mi nombre es)\s+([\p{L}][\p{L}\s'-]{0,70}?)(?=\s*(?:[,.;\n]|\by vivo\b|\bvivo\b|$))/iu)?.[1]?.trim()
  if (nombre) s.nombre = nombre
  const cantidad = n.match(/\b(?:quiero|deseo|me llevo|llevame|enviame|mandame|pido|compro|confirmo)\s+(?:(?:el|la|los|las|de)\s+)*(\d{1,2}|un[oa]?|dos|tres|cuatro|cinco)\b/)?.[1]
  if (compra && cantidad) s.cantidad = String(({ un:1, uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5 })[cantidad] || Number(cantidad))
  const direccion = t.match(/\b(?:av(?:enida)?|jr|jir[oó]n|calle|pasaje|psje|carretera|manzana|mz)\.?\s+[^,;\n]+/iu)?.[0]?.trim()
  if (direccion && /\d|\bs\/?n\b/i.test(direccion)) s.direccion = direccion
  const lugar = t.match(/\b(?:vivo en|env[ií](?:o|alo) a)\s+(.+?)(?=\s*(?:\b(?:av(?:enida)?|jr|jir[oó]n|calle|pasaje|psje|carretera|manzana|mz)\.?\s)|$)/iu)?.[1]
  if (lugar) {
    const partes = lugar.split(',').map(x=>x.trim()).filter(Boolean)
    if (partes.length === 2) { s.distrito = partes[0]; s.ciudad = partes[1] }
    else if (partes.length === 1) s.distrito = partes[0]
  }
  s.producto = producto
  if (!s.cantidad || !s.nombre || !(s.ciudad || s.distrito) || !s.direccion) return null
  return s
}

function reglaPedido(ctx, detectados = {}) {
  if (ctx.vertical?.VERTICAL_ID !== 'tienda' || ctx.campaignConfig?.atribucion?.esCampanaDefault === true) return null
  const s = datosPedido(ctx.mensajeActual, ctx.estadoLead, detectados, ctx.campaignConfig)
  if (!s) return null
  const lugar = [s.distrito, s.ciudad].filter(Boolean).join(', ')
  return respuestaRegla('regla_pedido', ctx.startTime, {
    mensaje: `¡Listo! Registro tu pedido de ${s.cantidad} unidades de ${s.producto} para ${s.direccion}, ${lugar} 🙌 Lo paso al equipo para que confirme los detalles y coordine la entrega por este chat.`,
    razonamiento: 'Pedido explícito con datos completos: derivar, sin pedir referencia obligatoria.',
    slots_detectados: Object.fromEntries(Object.entries(s).filter(([k])=>!k.startsWith('_'))),
    momento_actual: 'M6', stage_sugerido: 'call_confirmed', debe_escalar_humano: true,
    razon_escalamiento: `PEDIDO: ${s.cantidad} unidades de ${s.producto} — coordinar entrega`,
    como_cerrarlo: `Confirmar pedido y entrega. ${s.nombre}; ${s.direccion}, ${lugar}. Precio: ${ctx.fs?.precioTexto || 'confirmar con la ficha'}.`,
    temperatura_lead: 'hot', guardrail_flags: ['pedido_completo_derivado'] })
}

export function resolverReglasAntesDelModelo(ctx) {
  if (detectarVulnerabilidadGrave(ctx.mensajeActual)) return respuestaRegla('regla_vulnerabilidad', ctx.startTime, {
    mensaje: 'Gracias por confiarme lo que estás pasando 🙏 Siento que estés en esta situación. No voy a presionarte para comprar: paso tu caso al equipo para que te acompañe con calma.',
    razonamiento: 'Vulnerabilidad grave: empatía neutral y derivación, sin venta.',
    stage_sugerido: ctx.estadoLead.stage || 'discovery', debe_escalar_humano: true,
    razon_escalamiento: 'vulnerabilidad económica — acompañar sin presión comercial',
    como_cerrarlo: 'Escuchar y revisar el caso con cuidado. No presionar para comprar.',
    temperatura_lead: 'cold', guardrail_flags: ['vulnerabilidad_grave_derivada'] })
  const llamada = reglaLlamada(ctx)
  if (llamada) return llamada
  const pedido = reglaPedido(ctx)
  if (pedido) return pedido
  // C010: compartir evidencia literal de la ficha, sin inventar nombres ni avales.
  if (ctx.vertical?.VERTICAL_ID === 'exportacion' && /\b(?:casos? de exito|testimonios?|institucion valida|aval(?:ado)?|respaldo oficial)\b/.test(normalizar(ctx.mensajeActual))) {
    const evidencia = [ctx.fs.casoExitoTexto, ctx.fs.testimoniosTexto].filter(Boolean).join('\n\n')
    return respuestaRegla('regla_evidencia', ctx.startTime, {
      mensaje: evidencia ? `Te comparto la evidencia que tenemos documentada:\n\n${evidencia}\n\nSi necesitas comprobar un aval o acreditación oficial, el equipo te ayudará a revisar el documento correspondiente.`
        : 'Para darte información verificable, paso tu consulta al equipo: te compartirán la documentación disponible y los casos de éxito que puedan respaldar.',
      stage_sugerido: ctx.estadoLead.stage || 'discovery', debe_escalar_humano: true,
      razon_escalamiento: 'consulta de evidencia o acreditación — compartir documentación verificada',
      guardrail_flags: ['evidencia_solo_de_ficha'] })
  }
  return null
}

export function protegerSalidaDeterminista(parsed, ctx) {
  const pedido = reglaPedido(ctx, parsed.slots_detectados)
  if (pedido) {
    const { audit, ok, guardrail_flags, via_fallback, ...datos } = pedido
    return { parsed: { ...parsed, ...datos }, flags: guardrail_flags }
  }
  if (ctx.vertical?.VERTICAL_ID !== 'exportacion' || preferenciaLlamada(ctx.mensajeActual, ctx.historial, ctx.estadoLead.slots)?.tipo !== 'rechaza') return { parsed, flags: [] }
  const mensaje = String(parsed.mensaje || '').split(/(?<=[.!?])\s+|\n+/).filter(o => !/\b(?:llam(?:ada\w*|ar\w*|o|amos|e|es|en)|telefon\w*)\b/.test(normalizar(o))).join(' ').trim()
  const slots = { ...(parsed.slots_detectados || {}) }
  delete slots.fecha_hora
  slots._canal_contacto = 'chat'
  const cancelar = ['call_scheduling','call_confirmed'].includes(ctx.estadoLead.stage) && !!ctx.estadoLead.slots?.fecha_hora
  return { parsed: { ...parsed, mensaje: mensaje || 'Entendido, seguimos por este chat y no coordinaremos una llamada.',
    slots_detectados: slots, stage_sugerido: ctx.estadoLead.stage || 'discovery',
    debe_escalar_humano: cancelar || parsed.debe_escalar_humano === true,
    razon_escalamiento: cancelar ? 'cancelación de llamada solicitada por el lead' : parsed.debe_escalar_humano === true ? 'atender la consulta por chat, sin llamada' : null,
    como_cerrarlo: cancelar || parsed.debe_escalar_humano === true ? 'Atender por chat. Respetar que el lead rechazó llamadas.' : null,
    cierre: { ...(parsed.cierre || {}), ofrecio_llamada: false } }, flags: ['llamada_rechazada'] }
}

export function respaldoNoVerificado(oracion, fs) {
  const t = normalizar(oracion), fuente = normalizar(fs?.factSheetBloque)
  const aval = /\b(?:avalad[oa]s?|respaldad[oa]s?|certificad[oa]s?|reconocid[oa]s?|aprobad[oa]s?)\s+(?:oficialmente\s+)?(?:por|del)\s+(?:el\s+)?(?:estado|gobierno|sunat|promperu|min[\w ]+)/
  const claim = t.match(aval)?.[0]
  if (claim && afirmado(t, aval) && !fuente.includes(claim)) return true
  const nombreCaso = t.match(/\bdon\s+([\p{L}]+)/u)?.[0]
  return !!(nombreCaso && /\b(?:alumno|caso|exporto|aprendio|exportador)\b/.test(t) && !fuente.includes(nombreCaso))
}
// El pipeline conserva los slots ya conocidos, excepto una cita que el lead rechazó.
export function fusionarSlotsConReglas(anteriores, nuevos, flags = []) {
  const slots = { ...(anteriores || {}) }
  for (const [k,v] of Object.entries(nuevos || {})) {
    const canalDerivado = k === '_canal_contacto' && flags.some(f => ['llamada_rechazada','llamada_inminente_derivada','llamada_horario_derivado','llamada_solicitada_sin_cuestionario'].includes(f))
    if (k.startsWith('_') && !canalDerivado) continue
    if (!['__proto__','constructor','prototype'].includes(k) && v && typeof v === 'string' && v.trim() && !v.toLowerCase().includes('vacío')) slots[k] = v
  }
  if (flags.includes('llamada_rechazada')) delete slots.fecha_hora
  return slots
}
