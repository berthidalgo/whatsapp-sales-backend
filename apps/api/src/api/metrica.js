// src/api/metrica.js — Métricas v1 con DEFINICIÓN y FUENTE (Hito B4).
//
// LA REGLA DE ESTA PANTALLA: una métrica que no puede explicarse no sirve para decidir. Por
// eso cada número viaja con `definicion` (qué cuenta exactamente) y `fuente` (de qué tabla o
// estado sale) y, cuando no hay dato, con `disponible: false` y `motivo`. Rellenar huecos
// con estimaciones es peor que mostrar "no disponible": una venta inventada en un panel
// decide quién cobra comisión y a quién se ledice que no.
//
// LO QUE SE MIDE Y LO QUE NO:
//   · Actividad: turnos atendidos y turnos que consumieron modelo. La cuota sigue contando
//     turnos atendidos (no se cambió la política de atención); los que gastaron modelo van
//     aparte porque son los que cuestan.
//   · Derivaciones: leads en modo humano, por estado real de lead_state.
//   · Errores de envío: outbox REJECTED e UNCERTAIN. El incierto NO se cuenta como error de
//     Meta (no lo es) ni como éxito: se cuenta aparte, porque exige una decisión humana.
//   · Conversaciones atendidas: leads con al menos un mensaje del vendedor.
//   · Ventas confirmadas: `call_events.outcome_tag = 'pagó'`. La etapa inferida por el bot
//     NO entra: no es un hecho comercial.
//
// TODO el conteo se hace en SQL sobre el alcance del usuario (scopeWhere) y acotado al
// tenant del token. No se expose PII: son conteos y, como mucho, un desglose por etiqueta.

import { scopeWhere, ROLES_VE_TODO } from '../lib/auth-guard.js'

const DIA = 24 * 3600 * 1000

/**
 * @param {object} request Fastify request (verifyJwt ya corrió)
 * @param {object} reply
 * @param {object} prisma
 */
export async function metricasV2(request, reply, prisma) {
  try {
    const tenantId = request.user?.tenantId
    if (!tenantId) return reply.code(403).send({ error: 'sin tenant en el token' })
    // Días: por defecto 30. Tope alto para poder comparar trimestres sin depender de un
    // rango arbitrario en la URL.
    const dias = Math.min(Math.max(Number(request.query?.dias) || 30, 1), 365)
    const desde = new Date(Date.now() - dias * DIA)

    // Un VENDOR solo ve SUS leads; ADMIN/SUPERVISOR, todo su tenant. Se aplica el mismo
    // alcance que en el inbox: las métricas no pueden ser un hueco por el que se vea el
    // volumen de otro vendedor.
    const alcance = scopeWhere(request.user)
    const idsDeAlcance = () => prisma.lead.findMany({ where: alcance, select: { id: true } }).then(r => r.map(x => x.id))
    const leadIds = await idsDeAlcance()
    const enAlcance = leadIds.length ? { leadId: { in: leadIds } } : { leadId: { in: [-1] } }

    const [turnos, turnosIa, derivaciones, rechazos, inciertos, atendidos, ventas, followups] = await Promise.all([
      prisma.turnTrace.count({ where: { createdAt: { gte: desde }, leadId: { in: leadIds.length ? leadIds : [-1] } } }),
      prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { turnosConsumidosMesActual: true, turnosIaMesActual: true, turnosIncluidosPorVendedorMes: true, numVendedoresPagados: true },
      }),
      prisma.leadState.groupBy({
        by: ['currentMode'],
        where: { leadId: { in: leadIds.length ? leadIds : [-1] } },
        _count: { _all: true },
      }),
      prisma.outboundMessage.count({ where: { ...enAlcance, estado: 'REJECTED', createdAt: { gte: desde } } }),
      prisma.outboundMessage.count({ where: { ...enAlcance, estado: 'UNCERTAIN', createdAt: { gte: desde } } }),
      prisma.lead.count({ where: { ...alcance, mensajes: { some: { origen: 'VENDEDOR', createdAt: { gte: desde } } } } }),
      prisma.callEvent.groupBy({
        by: ['outcomeTag'],
        where: { ...enAlcance, occurredAt: { gte: desde }, outcomeTag: { not: null } },
        _count: { _all: true },
      }),
      prisma.followupReservation.count({ where: { ...enAlcance, executed: true, createdAt: { gte: desde } } }),
    ])

    const modo = Object.fromEntries(derivaciones.map(d => [d.currentMode, d._count._all]))
    const resultados = Object.fromEntries(ventas.map(v => [v.outcomeTag, v._count._all]))

    return reply.send({
      periodo: { dias, desde: desde.toISOString() },
      alcance: ROLES_VE_TODO.has(request.user?.role) ? 'tenant' : 'propio',
      metricas: [
        {
          clave: 'turnos_atendidos',
          valor: turnos,
          unidad: 'turnos',
          definicion: 'Turnos del bot registrados en turn_trace en el periodo. Incluye los resueltos por regla sin llamar a un modelo.',
          fuente: 'turn_trace',
        },
        {
          clave: 'turnos_con_ia',
          valor: turnosIa?.turnosIaMesActual ?? null,
          unidad: 'turnos',
          definicion: 'Turnos que llamaron a un proveedor de IA este mes (el contador se reinicia cada mes). Un turno resuelto por regla cuenta 0.',
          fuente: 'tenant_settings.turnos_ia_mes_actual',
          disponible: turnosIa?.turnosIaMesActual != null,
          // Antes de este cambio no se separaba: sin esto la cifra no existe y se dice.
          motivoSiNo: 'contador nuevo (Hito A4): solo cuenta desde el despliegue que lo introduce',
        },
        {
          clave: 'cuota_turnos',
          valor: turnosIa?.turnosIncluidosPorVendedorMes && turnosIa?.numVendedoresPagados
            ? turnosIa.turnosIncluidosPorVendedorMes * turnosIa.numVendedoresPagados
            : null,
          unidad: 'turnos/mes',
          definicion: 'Plan de turnos incluidos (vendedores de pago × turnos por vendedor). La cuota NO corta la atención: avisa.',
          fuente: 'tenant_settings',
          disponible: !!(turnosIa?.turnosIncluidosPorVendedorMes && turnosIa?.numVendedoresPagados),
        },
        {
          clave: 'derivaciones_humano',
          valor: modo.HUMAN_ACTIVE ?? 0,
          unidad: 'leads',
          definicion: 'Leads con un humano a cargo ahora mismo (modo HUMAN_ACTIVE). No son ventas.',
          fuente: 'lead_state.current_mode',
        },
        {
          clave: 'derivaciones_pausados',
          valor: modo.PAUSED ?? 0,
          unidad: 'leads',
          definicion: 'Leads en pausa (cierre o rechazo). Es terminal: el bot no vuelve solo.',
          fuente: 'lead_state.current_mode',
        },
        {
          clave: 'envios_rechazados',
          valor: rechazos,
          unidad: 'envíos',
          definicion: 'Envíos que Meta rechazó con un error explícito (fuera de ventana, número sin WhatsApp, plantilla no aprobada). No se reintentan solos.',
          fuente: 'outbound_messages.estado=REJECTED',
        },
        {
          clave: 'envios_inciertos',
          valor: inciertos,
          unidad: 'envíos',
          definicion: 'Envíos en los que no se puede saber si salieron (timeout, caída, 5xx). NO se reenvían: esperan una decisión humana. No se cuentan como éxito ni como error de Meta.',
          fuente: 'outbound_messages.estado=UNCERTAIN',
        },
        {
          clave: 'conversaciones_atendidas',
          valor: atendidos,
          unidad: 'leads',
          definicion: 'Leads con al menos un mensaje escrito por un vendedor en el periodo. Cuenta atención, no resultado.',
          fuente: 'messages.origen=VENDEDOR',
        },
        {
          clave: 'ventas_confirmadas',
          valor: resultados['pagó'] ?? 0,
          unidad: 'leads',
          definicion: 'Leads con una llamada registrada cuyo resultado es "pagó". Es lo ÚNICO que se cuenta como venta.',
          fuente: 'call_events.outcome_tag',
        },
        {
          clave: 'seguimientos_enviados',
          valor: followups,
          unidad: 'envíos',
          definicion: 'Recordatorios automáticos que salieron de verdad en el periodo (reservas marcadas como ejecutadas).',
          fuente: 'followup_reservations.executed',
        },
      ],
      resultadosConfirmados: Object.entries(resultados).map(([resultado, n]) => ({ resultado, total: n })),
      // Recordatorio de método: la etapa del bot NO es una venta y no se usa para medir.
      nota: 'La etapa del bot (first_contact, post_close…) es una inferencia y no se usa en ninguna métrica. Las ventas salen de call_events, registradas por una persona.',
    })
  } catch (error) {
    console.error('[metrica] metricasV2:', error.message)
    return reply.code(500).send({ error: 'error al calcular métricas' })
  }
}