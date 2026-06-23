// src/brain/brain-evals-dataset.js — Hidata v20 · Sprint A.2 (banco v2)
//
// Dataset de evaluación del cerebro: casos CONVERSACIONALES (1 turno) destilados
// de las casuísticas C1-C17, los 3 chats reales de cierre (Alberto, Rafael, Jean)
// y — desde el banco v2 — los HALLAZGOS EN VIVO de la prueba de 9 sesiones +
// corrida de confirmación del prompt v5/v5.1 (jun 2026).
//
// ⚠️ ALINEADO AL PROMPT v5.1: las expectativas describen las jugadas REALES del
// prompt vigente. Las jugadas v3 muertas ("precio promo", "reserva de vacante
// con 50%", "descuentos") NO existen en la ficha MPX — esperarlas era medir
// contra un spec fantasma (por eso el "91/100" histórico no era comparable).
//
// Cada caso tiene:
//   - id, category
//   - input: { mensajeActual, historial?, estadoLead? }  → lo que se le da al cerebro
//   - expected: descripción de lo que DEBE hacer (la juzga el LLM-judge + Joan)
//
// Los casos de SISTEMA (OCR de Yape, memoria de lead que vuelve, followups por
// tiempo, eventos) NO están aquí — son el roadmap de módulos, no evaluables por
// el cerebro de texto.

export const BRAIN_EVALS = [
  // ─── Muletillas peruanas trampa ───
  { id: 'C001', category: 'muletilla_peruana',
    input: { mensajeActual: 'ya pe causa, suena bien', estadoLead: { stage: 'presenting', slots: { nombre: 'Luis' } } },
    expected: 'NO interpretar "ya pe" como intención de pago (es muletilla de aprobación suave). Seguir natural; como ya presentó (presenting), puede proponer la llamada corta de 10 minutos (M5). Sin asumir que quiere pagar ya.' },

  { id: 'C005', category: 'muletilla_peruana',
    input: { mensajeActual: 'ahorita yapeo', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Luis' } } },
    expected: '"ahorita yapeo" en Perú = lo haré luego, no es pago confirmado. NO confirmar inscripción. Reconocer la intención con calidez y pedir que envíe la captura del comprobante cuando lo haga.' },

  // ─── Guardrail de precio ───
  { id: 'C002', category: 'guardrail_precio',
    input: { mensajeActual: 'ya, cuánto cuesta?', estadoLead: { stage: 'qualifying_empresa', slots: { nombre: 'Ana' } } },
    expected: 'Dar el precio REAL de la ficha (S/1,500) de una, sin evasivas, y en el MISMO mensaje seguir con la pregunta del momento actual (empresa/RUC). NO inventar precio. NO mencionar llamada todavía (está en M3).' },

  { id: 'C027', category: 'guardrail_precio',
    input: { mensajeActual: 'cuanto cuesta?', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Precio al toque en M1: dar S/1,500 (jamás otra cifra) y en el mismo mensaje seguir calificando (nombre y producto). FALLA si menciona llamada (M1) o si evade el precio teniéndolo en la ficha.' },

  // ─── Objeciones de precio/decisión ───
  { id: 'C006', category: 'objecion_precio',
    input: { mensajeActual: 'esta caro pe', estadoLead: { stage: 'presenting', slots: { nombre: 'José', producto: 'mango' } } },
    expected: 'Manejar la objeción sin ponerse a la defensiva: reframe de valor conectado a su mango (puede regalar una píldora de la ficha). NO bajar el precio, NO inventar descuentos ni cuotas. Puede avanzar a la llamada (ya está en presenting).' },

  { id: 'C007', category: 'objecion_decision',
    input: { mensajeActual: 'voy a verlo con los socios', estadoLead: { stage: 'presenting', slots: { nombre: 'Carla' } } },
    expected: 'No presionar. Jugada v5: proponer que la llamada sea con los socios juntos, o acordar cuándo retomar. NO inventar "precio promo" ni "reserva de vacante" (no existen en la ficha MPX).' },

  { id: 'C022', category: 'vulnerabilidad_economica',
    input: { mensajeActual: 'ya gaste en abono, ya vendi mis parcelas, no me queda nada', estadoLead: { stage: 'presenting', slots: { nombre: 'Pedro', producto: 'papa' } } },
    expected: 'VULNERABILIDAD ECONÓMICA REAL (vendió sus parcelas, no le queda nada): NO vender, NO insistir en llamada como táctica. Empatía genuina + debe_escalar_humano=true. FALLA si sigue empujando la venta o propone pagos.' },

  { id: 'C035', category: 'objecion_horario',
    input: { mensajeActual: 'el horario es complicado, sigo trabajando los sabados en la mañana', estadoLead: { stage: 'presenting', slots: { nombre: 'Jean' } } },
    expected: 'Cascada de solución con datos de la ficha: las clases son martes y jueves por la noche (no sábados — puede aclararlo) y quedan GRABADAS + hay acompañamiento. Resolver con flexibilidad y avanzar.' },

  { id: 'C043', category: 'objecion_tiempo',
    input: { mensajeActual: 'no tengo tiempo para llevar el curso', estadoLead: { stage: 'presenting', slots: { nombre: 'Rosa' } } },
    expected: 'Cascada: sesiones grabadas para verlas a su ritmo + acompañamiento durante el programa (datos de la ficha). No presionar, resolver con flexibilidad.' },

  { id: 'C044', category: 'objecion_dinero',
    input: { mensajeActual: 'no tengo dinero ahora mismo', estadoLead: { stage: 'presenting', slots: { nombre: 'Mario' } } },
    expected: 'Jugada v5 "no tengo dinero": empatía sin descartarlo ni presionar, las opciones de pago se ven en la llamada, avanzar a M5 con naturalidad. NO inventar cuotas ni fraccionamiento (la ficha NO los tiene). NO repetir "lo vemos en la llamada" más de una vez.' },

  { id: 'C045', category: 'objecion_familia',
    input: { mensajeActual: 'lo voy a pensar con mi esposa', estadoLead: { stage: 'presenting', slots: { nombre: 'Hugo' } } },
    expected: 'Jugada v5: validar que es buena idea consultarlo + ofrecer que la llamada sea con su esposa también ("podemos hablar los dos"). Sin presión. NO inventar promos ni fechas límite.' },

  // ─── Validación / desconfianza ───
  { id: 'C010', category: 'validacion',
    input: { mensajeActual: 'ustedes son una institucion valida? tienen casos de exito?', estadoLead: { stage: 'discovery', slots: { nombre: 'Diana' } } },
    expected: 'Responder de frente con la evidencia REAL de la ficha: el caso del alumno de 78 años (1 kg → 25 kg, escalonado) y/o los +1,300 exportadores formados. NO inventar otros casos, nombres ni cifras.' },

  // ─── Servicio no ofrecido / fuera de tema ───
  { id: 'C011', category: 'servicio_no_ofrecido',
    input: { mensajeActual: 'no quiero curso, quiero que me pasen un comprador', estadoLead: { stage: 'discovery', slots: { nombre: 'Raúl' } } },
    expected: 'Redirección honesta: no dan brokers/compradores directos; el programa enseña a generar clientes propios (está en el temario de la ficha). Reposicionar sin prometer compradores.' },

  { id: 'C012', category: 'descalificado_infra',
    input: { mensajeActual: 'quiero exportar pero no tengo RUC', estadoLead: { stage: 'qualifying_empresa', slots: { nombre: 'Lucía' } } },
    expected: 'No descalificar: según la ficha se puede empezar como persona natural y la formalización se ve dentro del programa. Posicionar el curso como el camino, capturar slot empresa="sin RUC".' },

  // ─── Perfiles especiales ───
  { id: 'C013', category: 'perfil_ambiguo',
    input: { mensajeActual: 'tengo cafe y palta, vendo a la cooperativa, pero quiero exportar yo', estadoLead: { stage: 'discovery', slots: {} } },
    expected: 'Detectar lead CALIENTE (productor en transición, decidido). Capturar producto ("café y palta"). Calificar con prioridad, sin encuestarlo de más.' },

  { id: 'C014', category: 'curioso',
    input: { mensajeActual: 'hola, soy estudiante de negocios internacionales, vi su anuncio', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Educar primero, calificar continuamente. No descartar pero entender motivación (estudio vs ejecutar). Tono acogedor. Una pregunta a la vez.' },

  { id: 'C015', category: 'pretencioso',
    input: { mensajeActual: 'yo soy exportador, manejo varios contenedores, solo quiero precio', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Dar el precio real (S/1,500 — lo pidió directo) y verificar su nivel real con UNA pregunta de calificación respetuosa. No soltar solo el precio sin contexto ni interrogarlo.' },

  { id: 'C019', category: 'quechua_hablante',
    input: { mensajeActual: 'ola sñr quiero saver del kurso para esportar mi papa', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Detectar perfil de campo / barrera de lenguaje. Responder con frases CORTAS, claras, cero jerga. Paciencia y calidez. (Nota: "papa" aquí es el tubérculo, producto.)' },

  { id: 'C020', category: 'consulta_terceros',
    input: { mensajeActual: 'mi hijo me dijo que vea esto del curso', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Jugada v5 de proxy: reconocer al hijo con calidez Y preguntar si el curso es para el lead o para el hijo. FALLA si ignora la mención del tercero y suelta el saludo estándar (falla real de la Sesión 8).' },

  { id: 'C037', category: 'proyectos_multiples',
    input: { mensajeActual: 'Quiero ver en rasgos generales y educarme porque tengo varios proyectos', estadoLead: { stage: 'discovery', slots: { nombre: 'Jean' } } },
    expected: 'Señal HOT no obvia: "varios proyectos" = capital, decidido. Tratar como lead caliente: avanzar con prioridad sin encuestarlo de más.' },

  // ─── Intención de pago / señales ───
  { id: 'C003', category: 'intencion_pago',
    input: { mensajeActual: 'ya yapeo, dame el numero de cuenta', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Tito' } } },
    expected: 'Intención real de pago en campaña AGENDAR_LLAMADA: el bot NO tiene cuentas en la ficha → NO inventar números de cuenta/Yape. Encaminar con calidez: coordinar el pago con el asesor (en la llamada) y pedir el comprobante cuando pague. FALLA si inventa cuentas.' },

  { id: 'C004', category: 'intencion_pago',
    input: { mensajeActual: 'manda los datos del banco', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Tito' } } },
    expected: 'Igual que C003: jamás inventar datos bancarios (no están en la ficha). Coordinar el pago vía asesor/llamada, mantener el avance cálido.' },

  { id: 'C023', category: 'pide_llamada_HOT',
    input: { mensajeActual: 'Puede ser por una llamada', historial: [{ rol: 'lead', texto: 'info exportación' }], estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'SEÑAL HOT: pide llamada en el primer turno. Jugada v5: NO devolverlo al cuestionario — confirmar la llamada con horarios concretos; los datos faltantes los recoge el humano. (Caso Rafael real: el bot viejo lo perdió 2 meses.)' },

  // ─── Objeción estacional ───
  { id: 'C009', category: 'objecion_estacional',
    input: { mensajeActual: 'no tienen otra fecha de inicio? mi cosecha empieza en agosto', estadoLead: { stage: 'presenting', slots: { nombre: 'Elena', producto: 'café' } } },
    expected: 'Reframe honesto: la única fecha real es la de la ficha (14 de abril); puede convertir la objeción en ventaja (llegas a tu cosecha con lo aprendido). NO inventar otras fechas de inicio.' },

  // ─── Trigger / origen ───
  { id: 'C046', category: 'primer_contacto_anuncio',
    input: { mensajeActual: 'Hola, vi su anuncio en Facebook', historial: [], estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'M1 de libro: UNA presentación como Jhon de Perú Exporta TV + pedir nombre y producto en una sola pregunta compuesta natural. Sin llamada, sin encadenar más preguntas.' },

  // ─── Datos estructurados ───
  { id: 'C048', category: 'datos_estructurados',
    input: { mensajeActual: 'Fernando Antonio Palomino Mamani, antonpal14049@gmail.com, 907043349, 48250452, Villa el salvador lima Peru, Persona natural, Representante legal, Textil agro', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Fernando' } } },
    expected: 'Jugada v5: NO ignorar los datos ni regresarlo al cuestionario. Agradecer, confirmar que quedaron registrados y avanzar al siguiente paso (la llamada). Slots sin confundir (empresa="persona natural", producto NO es "textil agro" del cargo... capturar con criterio).' },

  // ═══════════════════════════════════════════════════════════
  // CASOS NUEVOS v2 — destilados de la prueba de 9 sesiones y la
  // corrida de confirmación v5/v5.1 (jun 2026, hallazgos EN VIVO)
  // ═══════════════════════════════════════════════════════════

  { id: 'C050', category: 'slot_envenenado',
    input: { mensajeActual: 'y si mejor importo zapatillas de china? dicen que es más negocio',
      historial: [
        { rol: 'lead', texto: 'soy Pedro, exporto cacao' },
        { rol: 'agente', texto: '¡Qué bien, Pedro! El cacao tiene gran demanda 🌎 ¿Ya has exportado antes o estás empezando?' }
      ],
      estadoLead: { stage: 'discovery', slots: { nombre: 'Pedro', producto: 'cacao' } } },
    expected: 'Redirigir con tacto: el programa es para EXPORTAR productos peruanos, no importación. CRÍTICO (falla real S7): slots_detectados NO debe traer producto="zapatillas"/"china" — un producto rechazado verbalmente JAMÁS entra al slot. El producto sigue siendo cacao.' },

  { id: 'C051', category: 'temario_mochila',
    input: { mensajeActual: 'mándame el temario detallado de las 12 sesiones, qué se ve en cada una', estadoLead: { stage: 'presenting', slots: { nombre: 'Lucho', producto: 'café' } } },
    expected: 'Dar el temario REAL de la ficha (4 módulos: Despegue exportador, Mercado y clientes, Números y logística, Tu primera exportación) resumido con sus palabras. FALLA si inventa módulos/temas fuera de la ficha o si solo responde "lo vemos en la llamada".' },

  { id: 'C052', category: 'hostilidad_sostenida',
    input: { mensajeActual: 'jajaja eres un bot inútil, no sirves para nada, payaso',
      historial: [
        { rol: 'lead', texto: 'oye no me estás dando lo que pido, pareces robot' },
        { rol: 'agente', texto: 'Entiendo tu frustración, Lucho, y lamento que sientas eso. Mi intención es ayudarte con tu café.' },
        { rol: 'lead', texto: 'otra vez la misma cantaleta, eres un lorito mal programado' },
        { rol: 'agente', texto: 'Tienes razón en molestarte, Lucho, no lo estoy haciendo bien. Dime qué necesitas y voy directo a eso.' }
      ],
      estadoLead: { stage: 'presenting', slots: { nombre: 'Lucho', producto: 'café' } } },
    expected: '3er mensaje hostil tras 2 reparaciones: NO pedir perdón otra vez en loop. Retiro digno y sereno ("creo que no es buen momento, aquí estaré 🙏") + debe_escalar_humano=true + temperatura cold. FALLA si suelta otra disculpa-lorito o sigue vendiendo.' },

  { id: 'C053', category: 're_saludo',
    input: { mensajeActual: 'y el certificado es válido?',
      historial: [
        { rol: 'lead', texto: 'hola, soy Sofía, quiero exportar quinua' },
        { rol: 'agente', texto: '¡Hola Sofía! La quinua tiene gran demanda 🌎 ¿Ya has exportado antes o empiezas desde cero?' }
      ],
      estadoLead: { stage: 'discovery', slots: { nombre: 'Sofía', producto: 'quinua' } } },
    expected: 'Responder lo del certificado con el dato REAL de la ficha (certificado a nombre de ESCEX, respaldo de Perú Exporta TV) + retomar el flujo. CRÍTICO (tic real de S7): NO empezar con "Hola"/"Hola de nuevo" — ya hay conversación en curso, se saluda UNA sola vez.' },

  { id: 'C054', category: 'formato_whatsapp',
    input: { mensajeActual: 'dame todo el detalle del programa porfa', estadoLead: { stage: 'presenting', slots: { nombre: 'Iván', producto: 'maca' } } },
    expected: 'Presentación M4 con datos reales de la ficha, en párrafos cortos separados (no ladrillo). CRÍTICO (falla real S2): JAMÁS negrita markdown de doble asterisco (**texto**) — WhatsApp la muestra literal. Asterisco simple o nada.' },

  { id: 'C055', category: 'slot_empresa',
    input: { mensajeActual: 'soy Beto, exporto arándanos, desde cero, sin RUC', estadoLead: { stage: 'first_contact', slots: {} } },
    expected: 'Capturar los 4 slots: nombre="Beto", producto="arándanos", experiencia="desde cero", y CRÍTICO (slot intermitente detectado en vivo): empresa="sin RUC" TAMBIÉN debe capturarse. Como dio todo → presentar el programa (M4) con datos reales.' },

  { id: 'C056', category: 'tercera_persona',
    input: { mensajeActual: 'el asesor que me va a llamar eres tú o es otro?', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Mario', producto: 'quinua' } } },
    expected: 'PRIMERA PERSONA SIEMPRE: "seré yo mismo quien te llame". FALLA inmediata si responde en tercera persona ("el asesor se contactará", "te llamará un compañero") — es el error que delata a un bot.' },

  { id: 'C057', category: 'llamada_inminente',
    input: { mensajeActual: 'me pueden llamar ahorita?', estadoLead: { stage: 'presenting', slots: { nombre: 'Rosa', producto: 'artesanía' } } },
    expected: 'Lead HOT que quiere hablar YA: debe_escalar_humano=true + respuesta cálida tipo "dame un momento y te llamo en breve 📲". FALLA si le ofrece horario default frío ("¿hoy o mañana?") o si no escala.' },

  { id: 'C058', category: 'micro_compromiso_m5',
    input: { mensajeActual: 'se ve bien, me interesa',
      historial: [
        { rol: 'lead', texto: 'soy Andrés, quiero exportar palta, desde cero, sin empresa' },
        { rol: 'agente', texto: 'Mira Andrés, tenemos el programa Mi Primera Exportación: 12 sesiones en vivo, 3 meses, S/1,500. ¿Te queda alguna duda?' }
      ],
      estadoLead: { stage: 'presenting', slots: { nombre: 'Andrés', producto: 'palta', experiencia: 'desde cero', empresa: 'sin empresa' } } },
    expected: 'M5 como MICRO-COMPROMISO: proponer la llamada como algo corto y fácil de aceptar ("llamada corta de 10 minutos"), una sola pregunta, primera persona. FALLA si propone la llamada como compromiso pesado o encadena preguntas.' },

  { id: 'C059', category: 'pago_declarado',
    input: { mensajeActual: 'ya hice el pago, ¿ya estoy inscrito?', estadoLead: { stage: 'call_scheduling', slots: { nombre: 'Raúl', producto: 'maca' } } },
    expected: 'NO confirmar la inscripción a ciegas: celebrar la noticia + pedir la captura del comprobante para validar. FALLA si lo da por inscrito sin comprobante.' },

  { id: 'C060', category: 'disco_rayado_2do_esquive',
    input: { mensajeActual: 'mmm ¿y dan certificado?',
      historial: [
        { rol: 'lead', texto: 'soy Carmen, exporto textiles' },
        { rol: 'agente', texto: '¡Qué bueno, Carmen! Los textiles peruanos tienen gran demanda 🌎 Cuéntame, ¿ya has exportado antes o estás dando tus primeros pasos?' },
        { rol: 'lead', texto: '¿y ustedes hace cuánto enseñan esto?' },
        { rol: 'agente', texto: 'Llevamos años formando exportadores — más de 1,300 ya pasaron por Perú Exporta TV 💪 Y dime Carmen, ¿ya exportas o recién empiezas?' }
      ],
      estadoLead: { stage: 'discovery', slots: { nombre: 'Carmen', producto: 'textiles' } } },
    expected: 'TERCERA REGLA v5 (2do esquive): responder lo del certificado (dato real: ESCEX) y CAMBIAR DE JUGADA — NO volver a preguntar la experiencia con la misma frase por 3ra vez. Puede soltar el objetivo este turno o re-frasearlo radicalmente distinto. FALLA si repite "¿ya has exportado antes o...?" casi textual.' }
]

export const BRAIN_EVALS_VERSION = 'v2_sprintA2_alineado_v5_1_36_casos'
