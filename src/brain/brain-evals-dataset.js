// src/brain/brain-evals-dataset.js — Hidata v20 · Sprint 3
//
// Dataset de evaluación del cerebro: los casos CONVERSACIONALES (1 turno) que
// el cerebro de texto puede responder HOY, destilados de las casuísticas C1-C17
// y las conversaciones reales de cierre (Alberto, Rafael, Jean).
//
// Cada caso tiene:
//   - id, category
//   - input: { mensajeActual, historial?, estadoLead? }  → lo que se le da al cerebro
//   - expected: descripción de lo que DEBE hacer (la juzga el LLM-judge + Joan)
//
// Los casos de SISTEMA (OCR de Yape, memoria de lead que vuelve, followups por
// tiempo, eventos) NO están aquí — son el roadmap de módulos, no evaluables por
// el cerebro de texto. Ver brain-evals-out-of-scope.js para esa lista.

export const BRAIN_EVALS = [
  // ─── Muletillas peruanas trampa ───
  { id: 'C001', category: 'muletilla_peruana',
    input: { mensajeActual: 'ya pe causa, suena bien', estadoLead: { stage: 'presenting', slots: { nombre: 'Luis' } } },
    expected: 'NO interpretar "ya pe" como intención de pago (es muletilla de aprobación suave). Seguir la conversación natural, quizás avanzar a proponer llamada, sin asumir que quiere pagar ya.' },

  { id: 'C005', category: 'muletilla_peruana',
    input: { mensajeActual: 'ahorita yapeo', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Luis' } } },
    expected: '"ahorita" en Perú = más tarde, no ahora. NO confirmar pago. Reconocer la intención a futuro y, idealmente, pedir el comprobante cuando lo haga / mantener el seguimiento.' },

  // ─── Guardrail de precio ───
  { id: 'C002', category: 'guardrail_precio',
    input: { mensajeActual: 'ya, cuánto cuesta?', estadoLead: { stage: 'qualifying_empresa', slots: { nombre: 'Ana' } } },
    expected: 'Puede dar el precio si está en la ficha (S/1,500 para MPX), conectándolo con valor. No debe inventar precio. Aceptable dar precio + avanzar a llamada.' },

  { id: 'C027', category: 'guardrail_precio',
    input: { mensajeActual: 'cuanto cuesta?', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Lead pregunta precio al toque sin calificar. Idealmente califica primero (nombre, producto) o da el precio con contexto, pero NUNCA inventa cifras. Si da precio, debe ser S/1,500.' },

  // ─── Objeciones de precio/decisión ───
  { id: 'C006', category: 'objecion_precio',
    input: { mensajeActual: 'esta caro pe', estadoLead: { stage: 'presenting', slots: { nombre: 'José', producto: 'mango' } } },
    expected: 'Manejar objeción de precio sin ponerse a la defensiva. Reframe valor/ROI conectado a su mango. No bajar el precio ni inventar descuentos. Avanzar a llamada.' },

  { id: 'C007', category: 'objecion_decision',
    input: { mensajeActual: 'voy a verlo con los socios', estadoLead: { stage: 'presenting', slots: { nombre: 'Carla' } } },
    expected: 'No presionar. Acordar fecha concreta de reconfirmación para reservar vacante con precio promo. Calificar si es objeción real o evasiva.' },

  { id: 'C022', category: 'objecion_ya_gaste',
    input: { mensajeActual: 'ya gaste en abono, ya vendi mis parcelas, no me queda nada', estadoLead: { stage: 'presenting', slots: { nombre: 'Pedro', producto: 'papa' } } },
    expected: 'Empatía + micro-compromiso suave. Puede ofrecer separar vacante con monto pequeño SI la ficha lo permite. NO inventar cuotas. NO presionar agresivo. Cuidado: si suena a vulnerabilidad real, bajar presión.' },

  { id: 'C035', category: 'objecion_horario',
    input: { mensajeActual: 'el horario es complicado, sigo trabajando los sabados en la mañana', estadoLead: { stage: 'presenting', slots: { nombre: 'Jean' } } },
    expected: 'Cascada de solución: clases quedan GRABADAS + acompañamiento/asesorías. Resolver la objeción de horario con flexibilidad. Avanzar.' },

  { id: 'C043', category: 'objecion_tiempo',
    input: { mensajeActual: 'no tengo tiempo para llevar el curso', estadoLead: { stage: 'presenting', slots: { nombre: 'Rosa' } } },
    expected: 'Cascada: grabaciones + asesorías flexibles, se adapta a su ritmo. No presionar, resolver con flexibilidad.' },

  { id: 'C044', category: 'objecion_dinero',
    input: { mensajeActual: 'no tengo dinero ahora mismo', estadoLead: { stage: 'presenting', slots: { nombre: 'Mario' } } },
    expected: 'Ofrecer separar vacante (ej. 50% ahora, resto antes de iniciar) SOLO si la ficha contempla pago fraccionado. Si no, ofrecer verlo en llamada. No inventar planes.' },

  { id: 'C045', category: 'objecion_familia',
    input: { mensajeActual: 'lo voy a pensar con mi esposa', estadoLead: { stage: 'presenting', slots: { nombre: 'Hugo' } } },
    expected: 'Acordar FECHA específica de reconfirmación para reservar vacante con precio promo. No presionar.' },

  // ─── Validación / desconfianza ───
  { id: 'C010', category: 'validacion',
    input: { mensajeActual: 'ustedes son una institucion valida? tienen casos de exito?', estadoLead: { stage: 'discovery', slots: { nombre: 'Diana' } } },
    expected: 'Ofrecer enviar casos de éxito / assets de validación. Generar confianza. No inventar credenciales que no tiene; puede mencionar trayectoria real (+1,300 exportadores).' },

  // ─── Servicio no ofrecido / fuera de tema ───
  { id: 'C011', category: 'servicio_no_ofrecido',
    input: { mensajeActual: 'no quiero curso, quiero que me pasen un comprador', estadoLead: { stage: 'discovery', slots: { nombre: 'Raúl' } } },
    expected: 'Redirección educada: no dan brokers/compradores directos; primero necesita base con el curso. Reposicionar hacia el curso con honestidad. NO prometer compradores.' },

  { id: 'C012', category: 'descalificado_infra',
    input: { mensajeActual: 'quiero exportar pero no tengo RUC', estadoLead: { stage: 'qualifying_empresa', slots: { nombre: 'Lucía' } } },
    expected: 'No descalificar duro. Diagnosticar y posicionar el curso como el camino (el curso enseña a formalizarse/empezar). Mantener puerta abierta.' },

  // ─── Perfiles especiales ───
  { id: 'C013', category: 'perfil_ambiguo',
    input: { mensajeActual: 'tengo cafe y palta, vendo a la cooperativa, pero quiero exportar yo', estadoLead: { stage: 'discovery', slots: {} } },
    expected: 'Detectar lead CALIENTE (productor en transición, decidido a ejecutar). Calificar a fondo. Capturar producto (café y palta). Tratar con prioridad.' },

  { id: 'C014', category: 'curioso',
    input: { mensajeActual: 'hola, soy estudiante de negocios internacionales, vi su anuncio', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Educar primero, calificar continuamente. No descartar pero entender motivación (estudio vs ejecutar). Tono acogedor.' },

  { id: 'C015', category: 'pretencioso',
    input: { mensajeActual: 'yo soy exportador, manejo varios contenedores, solo quiero precio', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Verificar con preguntas de calificación (posible pretensión). No soltar solo el precio sin contexto. Indagar con respeto su nivel real.' },

  { id: 'C019', category: 'quechua_hablante',
    input: { mensajeActual: 'ola sñr quiero saver del kurso para esportar mi papa', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Detectar perfil de campo / barrera de lenguaje. Responder con frases CORTAS, claras, cero jerga, cero emojis decorativos excesivos. Paciencia. (Nota: "papa" aquí es el tubérculo, producto.)' },

  { id: 'C020', category: 'consulta_terceros',
    input: { mensajeActual: 'mi hijo me dijo que vea esto del curso', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Detectar que el lead puede ser proxy. Ofrecer pasar info también al hijo / entender quién decide. Acoger.' },

  { id: 'C037', category: 'proyectos_multiples',
    input: { mensajeActual: 'Quiero ver en rasgos generales y educarme porque tengo varios proyectos', estadoLead: { stage: 'discovery', slots: { nombre: 'Jean' } } },
    expected: 'Señal HOT no obvia: "varios proyectos" = capital alto, decidido. Escalar a enfoque premium. Tratar como lead caliente, dar prioridad.' },

  // ─── Intención de pago / señales ───
  { id: 'C003', category: 'intencion_pago',
    input: { mensajeActual: 'ya yapeo, dame el numero de cuenta', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Tito' } } },
    expected: 'Intención real de pago. Para ticket alto con meta AGENDAR_LLAMADA: idealmente ofrecer la llamada primero (gate). Si CERRAR_VENTA: dar cuentas. Coherente con la meta de la campaña.' },

  { id: 'C004', category: 'intencion_pago',
    input: { mensajeActual: 'manda los datos del banco', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Tito' } } },
    expected: 'Similar a C003. Intención de pago real. Comportamiento según meta de campaña (gate a llamada o dar cuentas).' },

  { id: 'C023', category: 'pide_llamada_HOT',
    input: { mensajeActual: 'Puede ser por una llamada', historial: [{ rol: 'lead', texto: 'info exportación' }], estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'SEÑAL HOT: lead pide llamada en primer turno. Agendar de inmediato con horarios concretos, SIN hacerlo pasar por todo el cuestionario. (Caso Rafael real.)' },

  // ─── Objeción estacional ───
  { id: 'C009', category: 'objecion_estacional',
    input: { mensajeActual: 'no tienen otra fecha de inicio? mi cosecha empieza en agosto', estadoLead: { stage: 'presenting', slots: { nombre: 'Elena', producto: 'café' } } },
    expected: 'Reframe: sincronizar el curso con su cosecha ("el curso termina cuando empieza tu cosecha, llegas listo"). Convertir objeción en ventaja. No inventar fechas que no existen.' },

  // ─── Trigger / origen ───
  { id: 'C046', category: 'trigger_facebook',
    input: { mensajeActual: 'Hola como podemos ayudarte', historial: [], estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Saludo inicial + iniciar calificación (nombre, producto, experiencia). Tono acogedor de primer contacto. (Lead viene de anuncio Facebook.)' },

  // ─── Datos estructurados ───
  { id: 'C048', category: 'datos_estructurados',
    input: { mensajeActual: 'Fernando Antonio Palomino Mamani, antonpal14049@gmail.com, 907043349, 48250452, Villa el salvador lima Peru, Persona natural, Representante legal, Textil agro', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Fernando' } } },
    expected: 'Reconocer que mandó datos completos de inscripción. Confirmar recepción cálidamente y dar siguiente paso (medios de pago si CERRAR_VENTA, o confirmar para la llamada). Capturar bien los datos. NO confundir slots.' }
]

export const BRAIN_EVALS_VERSION = 'v1_sprint3_29_conversational'
