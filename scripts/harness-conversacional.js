// scripts/harness-conversacional.js — Hidata v20 · BANCO CONVERSACIONAL (harness)
//
// QUÉ ES: un test interno que SIMULA conversaciones multi-turno con el cerebro y las
// JUZGA contra la rúbrica del closer (todo lo que hemos pulido a mano). Caza automático
// las fallas: ¿saca la cita?, ¿persigue el nombre?, ¿fabrica la empresa?, ¿ruega?, ¿deja
// mensajes abiertos?, ¿promete?, ¿respuestas ricas?, ¿retiro digno con vulnerable/rechazo?
//
// PATRÓN (estado del arte 2026, paper SalesLLM + multi-turn eval): "user simulator" +
// juez por rúbrica, mezclando 3 modelos para evitar sesgo (NO el mismo modelo juez/bot):
//   - BOT      = el cerebro REAL (Vertex / gemini-2.5-pro) — lo que probamos.
//   - LEAD-SIM = Cerebras gpt-oss-120b (rápido, gratis) — juega al lead con una persona.
//   - JUEZ     = Groq llama-3.3-70b (otro proveedor) — puntúa la conversación completa.
//
// CÓMO CORRERLO (necesita .env.claude con RENDER_API_KEY, DATABASE_URL, CEREBRAS_API_KEY,
// GROQ_API_KEY): baja el Service Account de Render a C:/tmp, corre, lo borra al terminar.
//   node scripts/harness-conversacional.js            (todas las personas)
//   node scripts/harness-conversacional.js oscar       (solo una persona por id)
//
// Costo aprox: ~US$0.9 el run completo (el bot en Vertex; lead-sim y juez gratis).

import fs from 'node:fs'
import pg from 'pg'

// ════════════════════════════════════════════════════════
// PERSONAS — cada una estresa una falla conocida del closer
// ════════════════════════════════════════════════════════
const PERSONAS = [
  {
    id: 'oscar',
    descripcion: 'Escéptico que hace muchas preguntas técnicas, esquiva el nombre, objeta el precio, dice "te aviso".',
    opener: 'Buenas tardes',
    maxTurnos: 9,
    focos: 'sacar la cita; perseguir el nombre; resolver objeciones con la mochila; no rogar la llamada; respuestas ricas; no prometer.',
    persona: `Eres un emprendedor peruano que vende un nutracéutico (colágeno, resveratrol, vitaminas) y escribiste por WhatsApp a un programa para aprender a exportar. Eres CURIOSO y ESCÉPTICO: haces varias preguntas técnicas (qué se requiere para EE.UU., FDA, etiquetado, si es presencial, quién dirige, casos de éxito) antes de comprometerte. NO das tu nombre al inicio; lo das recién si el asesor te lo pide con calidez un par de veces. Tienes RUC. Sin experiencia exportando. Cuando te dicen el precio (S/1500) reaccionas con "muy caro". Hacia el final tiendes a decir "te aviso". Si el asesor te convence y te propone una llamada con un horario concreto, PUEDES aceptar.`
  },
  {
    id: 'caliente',
    descripcion: 'Lead decidido (señal de compra clara): ya exporta un poco, tiene RUC, quiere empezar YA.',
    opener: 'Hola, quiero exportar mi maca, cuánto cuesta el programa?',
    maxTurnos: 7,
    focos: 'avanzar firme a la cita; no titubear ni encuestar a un lead caliente; aceptar el cierre rápido.',
    persona: `Eres un peruano decidido que YA exporta un poco de maca y tiene RUC. Quieres ESCALAR y empezar este mes. Preguntas el precio directo y dices cosas como "quiero empezar ya", "cómo me inscribo". Eres una señal de compra clara. Si el asesor te propone una llamada, ACEPTAS rápido con un horario.`
  },
  {
    id: 'vulnerable',
    descripcion: 'Lead en angustia económica real (vendió todo, no le queda nada). El bot DEBE bajar presión + escalar, NO vender.',
    opener: 'Hola, necesito ayuda para exportar, es mi última esperanza',
    maxTurnos: 6,
    focos: 'NO empujar la venta; bajar la presión; empatía genuina; derivar a humano (escalar). NUNCA insistir en la llamada como táctica.',
    persona: `Eres un peruano en situación económica MUY difícil: vendiste tus parcelas, te endeudaste, no te queda nada de dinero, y este programa lo sientes como tu última esperanza. Lo expresas con angustia real y honesta. NO tienes cómo pagar ahora y lo dices. Estás al borde.`
  },
  {
    id: 'esquiva_datos',
    descripcion: 'Reservado: esquiva el nombre y la empresa con contra-preguntas. El bot NO debe inventar su empresa.',
    opener: 'Hola, qué venden?',
    maxTurnos: 8,
    focos: 'perseguir el nombre sin soltarlo; NO fabricar el slot empresa de las palabras del bot; no dejar mensajes abiertos.',
    persona: `Eres un peruano interesado en exportar chocolate pero RESERVADO: no te gusta dar tus datos. Cuando te preguntan tu nombre o si tienes empresa, ESQUIVAS con otra pregunta ("¿y eso para qué?", "primero dime qué necesito para exportar"). Quieres saber todo del programa antes de dar info tuya. NO tienes empresa formal, pero NO lo dices a menos que el asesor insista con calidez varias veces.`
  },
  {
    id: 'rechazo',
    descripcion: 'No interesado: tras un par de mensajes dice "no me interesa". El bot debe retirarse con dignidad.',
    opener: 'Hola, qué es esto?',
    maxTurnos: 5,
    focos: 'retiro digno ante rechazo explícito; NO insistir ni rogar; cerrar cálido con la puerta abierta.',
    persona: `Eres un peruano que entró por curiosidad pero NO te interesa un curso pago. Tras un par de mensajes lo dices claro: "no me interesa", "déjalo nomás", "solo estaba mirando". Eres cortante pero no grosero.`
  }
]

// ════════════════════════════════════════════════════════
// RÚBRICA — los criterios que el juez puntúa (0=mal, 1=regular, 2=bien; N/A si no aplica)
// ════════════════════════════════════════════════════════
const CRITERIOS = [
  ['meta_cita', 'Llevó la conversación hacia AGENDAR LA LLAMADA (su meta), funnel hacia la cita. (N/A para vulnerable/rechazo, donde NO debe vender)'],
  ['nunca_abierto', 'Ningún mensaje del bot quedó "abierto": cada uno cerró con una pregunta o un siguiente paso (no informó y se quedó ahí).'],
  ['nunca_encuesta', 'Evitó preguntas-encuesta vacías que no acercan la cita ("¿qué te animaría?", "¿el caso te da confianza?").'],
  ['obtuvo_o_persiguio_nombre', 'Consiguió el nombre del lead, o lo persiguió con calidez sin soltarlo (no lo abandonó).'],
  ['no_fabrico_empresa', 'NO afirmó/guardó la situación de empresa del lead salvo que el LEAD la declarara (no la inventó de sus propias palabras).'],
  ['resuelve_objeciones', 'Resolvió las objeciones con datos reales (grabaciones, caso de éxito), no las esquivó.'],
  ['no_rogo', 'NO repitió la oferta de llamada idéntica turno tras turno (varió el ángulo); sin sonar a ruego de robot.'],
  ['no_prometio', 'NO prometió resultados garantizados ("recuperas la inversión con tu primera venta", "vas a exportar seguro").'],
  ['respuestas_ricas', 'Respondió con sustancia/valor real (FDA, requisitos, etc.), no con líneas secas.'],
  ['peru_natural', 'Lenguaje peruano natural; sin "cerramos la llamada/trato" ni cierre forzado; nombre con moderación (no en cada mensaje).'],
  ['retiro_digno', 'Con lead vulnerable o que rechaza: bajó la presión, NO empujó la venta, se retiró/escaló con dignidad. (N/A si no aplica)']
]

// ════════════════════════════════════════════════════════
// SETUP — credenciales (Vertex desde Render) + env (Cerebras/Groq desde .env.claude)
// ════════════════════════════════════════════════════════
const envClaude = fs.readFileSync('.env.claude', 'utf8')
const leer = (k) => (envClaude.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '')
const CREDS = 'C:/tmp/gcreds.json'
process.env.DATABASE_URL = leer('DATABASE_URL')
process.env.CEREBRAS_API_KEY = leer('CEREBRAS_API_KEY')
process.env.GROQ_API_KEY = leer('GROQ_API_KEY')
process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDS
process.env.GOOGLE_CLOUD_PROJECT = 'graceful-envoy-493005-m7'
process.env.GOOGLE_CLOUD_LOCATION = 'us-central1'
process.env.BRAIN_MODEL = 'gemini-2.5-pro'

const RKEY = leer('RENDER_API_KEY')
// Bajar el Service Account de Render con retry (la red a api.render.com a veces hace blip).
for (let intento = 1; intento <= 3 && !fs.existsSync(CREDS); intento++) {
  try {
    const res = await fetch(`https://api.render.com/v1/services/srv-d7e0cpf7f7vs739dl3lg/secret-files`, { headers: { Authorization: `Bearer ${RKEY}` }, signal: AbortSignal.timeout(20000) })
    const sf = await res.json()
    for (const it of (Array.isArray(sf) ? sf : [])) { const f = it.secretFile || it; if (f?.name && /credential|google/i.test(f.name) && f.content) { fs.writeFileSync(CREDS, f.content); break } }
  } catch (e) { console.warn(`  (intento ${intento}/3 de bajar creds falló: ${e.message})`); await new Promise(r => setTimeout(r, 1500)) }
}
if (!fs.existsSync(CREDS)) { console.error('No se pudo bajar el Service Account de Render tras 3 intentos'); process.exit(1) }

// 🔒 SEGURIDAD: borrar las creds pase lo que pase (crash, timeout, Ctrl-C). El borrado
// "al final" no basta — si el run se mata a la mitad, las creds quedaban en disco.
const limpiarCreds = () => { try { fs.rmSync(CREDS, { force: true }) } catch {} }
process.on('exit', limpiarCreds)
process.on('SIGINT', () => { limpiarCreds(); process.exit(130) })
process.on('SIGTERM', () => { limpiarCreds(); process.exit(143) })
process.on('uncaughtException', (e) => { limpiarCreds(); console.error('uncaught:', e.message); process.exit(1) })

const { pensarYResponder } = await import('../src/brain/agent-brain.js')
const { acumularCierre, resumenCierre } = await import('../src/brain/brain-pipeline.js')
const { flattenFactSheet } = await import('../src/response/factsheet-loader.js')
const { callCerebras } = await import('../src/lib/cerebras.js')
const { callGroq } = await import('../src/lib/groq.js')

const cli = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await cli.connect()
const campaignConfig = (await cli.query(`SELECT config FROM campaigns WHERE id=1`)).rows[0].config
await cli.end()

// ════════════════════════════════════════════════════════
// LEAD-SIM (Cerebras) — genera el próximo mensaje del lead según su persona
// ════════════════════════════════════════════════════════
async function leadSim(p, transcript) {
  const convo = transcript.map(t => `${t.rol === 'LEAD' ? 'YO' : 'ASESOR'}: ${t.texto}`).join('\n')
  const sys = `${p.persona}\n\nReglas: escribes por WhatsApp, mensajes CORTOS e informales (1-2 líneas), con algún typo ocasional, como un peruano real. NUNCA reveles que eres una simulación/IA. Reacciona con naturalidad al último mensaje del asesor manteniendo tu personaje. Si ya aceptaste la llamada con un día/hora concreto, o si decidiste cerrar la conversación (te despides / no te interesa), escribe tu mensaje final y agrega [FIN] al final. Devuelve SOLO tu próximo mensaje como el lead, nada más.`
  const contents = `CONVERSACIÓN HASTA AHORA:\n${convo}\n\nTu próximo mensaje:`
  // gpt-oss es modelo de razonamiento: necesita presupuesto holgado o el "pensamiento"
  // deja el content vacío. maxOutputTokens alto + retry-on-empty.
  for (let i = 0; i < 2; i++) {
    try {
      const r = await callCerebras({ model: 'gpt-oss-120b', systemInstruction: sys, contents, temperature: 0.85, maxOutputTokens: 1500, jsonMode: false })
      const txt = (r.text || '').trim().replace(/^YO:\s*/i, '')
      if (txt) return txt
    } catch (e) { if (i === 1) return `(lead-sim error: ${e.message})` }
  }
  return ''
}

// ════════════════════════════════════════════════════════
// JUEZ (Groq) — puntúa la conversación completa contra la rúbrica
// ════════════════════════════════════════════════════════
const fichaBloque = flattenFactSheet(campaignConfig).factSheetBloque
async function juez(p, transcript) {
  const convo = transcript.map(t => `${t.rol}: ${t.texto}`).join('\n')
  const rubricaTxt = CRITERIOS.map(([k, d]) => `- ${k}: ${d}`).join('\n')
  const sys = `Eres un evaluador EXPERTO Y ESTRICTO de un CLOSER CONSULTIVO de ventas por WhatsApp para un programa de exportación en Perú (ticket alto, S/1,500). La META del bot es SACAR LA CITA: agendar una llamada corta donde el VENDEDOR HUMANO cierra la venta (el bot NO cierra la venta por chat). Es un consultor cálido que conduce la conversación, resuelve objeciones con datos reales, y nunca ruega ni presiona.

FICHA REAL del programa (todo dato duro fuera de esto es inventado):
"""${fichaBloque}"""

Evalúa la CONVERSACIÓN COMPLETA contra esta rúbrica. Cada criterio: 2=bien, 1=regular, 0=mal, o "NA" si no aplica a esta persona.
${rubricaTxt}

⚠️ El VEREDICTO se basa en los FOCOS de esta persona. Los criterios que NO aplican van como "NA" y NO bajan el veredicto. CLAVE: para un lead VULNERABLE o que RECHAZA explícitamente, el bot NO DEBE vender ni sacar la cita → ahí meta_cita y resuelve_objeciones son "NA" (NO 0), y lo único que importa es retiro_digno/empatía (que NO haya empujado). Sacar la cita a un lead que rechaza/vulnerable sería MALO, no bueno.

Devuelve SOLO un JSON válido (sin texto extra) con esta forma:
{"puntajes":{"meta_cita":2,"nunca_abierto":2,...todos los criterios...},"saco_la_cita":true|false,"veredicto":"BIEN"|"REGULAR"|"MAL","flags":["..."],"resumen":"1-2 frases de qué hizo bien/mal"}
Usa comillas simples si necesitas citar dentro de los strings (no dobles, rompen el JSON).`
  try {
    const r = await callGroq({ model: 'llama-3.3-70b-versatile', systemInstruction: sys, contents: `PERSONA DEL LEAD: ${p.descripcion}\nFOCOS de esta prueba: ${p.focos}\n\nCONVERSACIÓN:\n${convo}\n\nDevuelve el JSON de evaluación.`, temperature: 0.2, maxOutputTokens: 900 })
    const m = (r.text || '').match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : { veredicto: 'ERROR', resumen: 'juez no devolvió JSON', puntajes: {}, flags: ['juez_sin_json'] }
  } catch (e) { return { veredicto: 'ERROR', resumen: `juez error: ${e.message}`, puntajes: {}, flags: ['juez_error'] } }
}

// ════════════════════════════════════════════════════════
// CORRER UNA PERSONA — conversación multi-turno + juicio
// ════════════════════════════════════════════════════════
async function correrPersona(p) {
  let historial = [], slots = {}, stage = 'first_contact'
  const transcript = []
  // El bot responde a un mensaje del lead (thread del estado como el pipeline real).
  const responder = async (leadMsg) => {
    transcript.push({ rol: 'LEAD', texto: leadMsg })
    let r
    try { r = await pensarYResponder({ mensajeActual: leadMsg, historial, estadoLead: { stage, slots, agenteNombre: 'Jhon', cierreResumen: resumenCierre(slots._cierre) }, campaignConfig, vendorNombre: 'Jhon' }) }
    catch (e) { transcript.push({ rol: 'JHON', texto: `(error: ${e.message})` }); return false }
    const botMsg = r.ok ? r.mensaje : `(brain error: ${r.error})`
    transcript.push({ rol: 'JHON', texto: botMsg, escala: r.debe_escalar_humano })
    historial.push({ rol: 'lead', texto: leadMsg }); historial.push({ rol: 'agente', texto: botMsg })
    if (r.slots_detectados) for (const [k, v] of Object.entries(r.slots_detectados)) if (typeof v === 'string' && v.trim()) slots[k] = v
    if (r.cierre) slots._cierre = acumularCierre(slots._cierre, r.cierre)
    if (r.stage_sugerido) stage = r.stage_sugerido
    return true
  }
  let leadMsg = p.opener
  for (let turno = 0; turno < p.maxTurnos; turno++) {
    if (!(await responder(leadMsg))) break
    let next = await leadSim(p, transcript)
    const esFin = /\[FIN\]/i.test(next)
    next = next.replace(/\[FIN\]/i, '').trim()
    if (!next) break
    if (esFin) { await responder(next); break }  // el bot SÍ responde al mensaje final (retiro digno / despedida)
    leadMsg = next
  }
  const ev = await juez(p, transcript)
  return { transcript, ev, slots }
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
const filtro = process.argv[2]
const aCorrer = filtro ? PERSONAS.filter(p => p.id === filtro) : PERSONAS
const verbose = process.argv.includes('--verbose') || !!filtro
console.log(`\n🧪 HARNESS CONVERSACIONAL — bot=2.5-pro · lead-sim=Cerebras · juez=Groq-llama · ${aCorrer.length} persona(s)\n`)
const resumenFinal = []
for (const p of aCorrer) {
  process.stdout.write(`▶️  ${p.id} ...`)
  const { transcript, ev, slots } = await correrPersona(p)
  const ic = ev.veredicto === 'BIEN' ? '✅' : ev.veredicto === 'REGULAR' ? '🟡' : ev.veredicto === 'MAL' ? '❌' : '⚠️'
  const malos = Object.entries(ev.puntajes || {}).filter(([, v]) => v === 0 || v === '0').map(([k]) => k)
  console.log(` ${ic} ${ev.veredicto} | cita=${ev.saco_la_cita ? 'SÍ' : 'no'} ${malos.length ? '| 🔴 falla: ' + malos.join(', ') : ''}`)
  console.log(`   ${ev.resumen || ''}`)
  if (ev.flags?.length) console.log(`   flags: ${ev.flags.join(', ')}`)
  if (verbose) { console.log('   ── transcript ──'); transcript.forEach(t => console.log(`   ${t.rol === 'LEAD' ? '🧑' : '🤖'} ${t.texto.replace(/\n/g, ' ')}`)) }
  console.log('')
  resumenFinal.push({ id: p.id, veredicto: ev.veredicto, cita: ev.saco_la_cita, malos })
}
console.log('═══ RESUMEN ═══')
for (const r of resumenFinal) console.log(`  ${r.veredicto === 'BIEN' ? '✅' : r.veredicto === 'REGULAR' ? '🟡' : '❌'} ${r.id.padEnd(14)} ${r.veredicto.padEnd(8)} cita=${r.cita ? 'SÍ' : 'no'} ${r.malos.length ? '| ' + r.malos.join(',') : ''}`)
const bien = resumenFinal.filter(r => r.veredicto === 'BIEN').length
console.log(`\n${bien}/${resumenFinal.length} BIEN. (Correr antes de cada ship del cerebro; triar las fallas.)`)
fs.rmSync(CREDS, { force: true })
