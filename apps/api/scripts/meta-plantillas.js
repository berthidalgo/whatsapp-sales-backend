// scripts/meta-plantillas.js — revisa, crea y corrige en Meta las plantillas que el bot necesita (sep 2026).
//
// Con la API oficial, escribirle a un cliente fuera de la ventana de 24 h SOLO se puede con
// una plantilla aprobada. El catálogo (src/whatsapp/cloud/plantillas-catalogo.js) dice cuáles
// necesita el bot y con qué variables; este script las compara con lo que hay en la cuenta de
// WhatsApp (WABA) y crea o corrige las que hagan falta.
//
// Uso (desde apps/api; lee CLOUD_* del .env de la RAÍZ, el token nunca se imprime):
//   node scripts/meta-plantillas.js                          → estado: qué hay en Meta vs el catálogo
//   node scripts/meta-plantillas.js crear                    → SIMULA: muestra lo que enviaría
//   node scripts/meta-plantillas.js crear --aplicar          → crea las que faltan
//   node scripts/meta-plantillas.js editar --aplicar         → pone el texto del catálogo en las que difieren
//   node scripts/meta-plantillas.js crear --solo followup_24h --aplicar
//   node scripts/meta-plantillas.js borrar --nombre hidata_x --aplicar   → borra (todos los idiomas)
//   Opciones: --waba <id> (otra cuenta; por defecto CLOUD_WABA_ID) · --idioma es_PE (por defecto es)
//
// Necesita en el .env: CLOUD_ACCESS_TOKEN (permiso whatsapp_business_management) y CLOUD_WABA_ID.
// Meta revisa cada plantilla: de minutos a 24 h. Hasta que esté APPROVED no se puede enviar
// (error 132001). Este script NO cambia variables de entorno: al final imprime las líneas
// CLOUD_TEMPLATE_* para pegarlas en Render. Meta permite crear hasta 100 plantillas por hora.
//
// Para corregir el texto, EDITAR, no borrar: si se borra una plantilla aprobada, Meta no deja
// reusar su nombre por 30 días. Una rechazada o pausada se edita sin límite; una aprobada,
// 1 vez cada 24 h y 10 cada 30 días (y vuelve a revisión).

import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATALOGO, IDIOMA_DEFAULT, ESTADOS_EDITABLES, idiomaValido, payloadDeCreacion, payloadDeEdicion,
  planificarPlantillas, lineasDeEntorno, validarPlantilla
} from '../src/whatsapp/cloud/plantillas-catalogo.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
try {
  for (const l of fs.readFileSync(join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* sin .env: variables del entorno */ }

const args = process.argv.slice(2)
const comando = ['crear', 'editar', 'borrar'].includes(args[0]) ? args[0] : 'estado'
const valor = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const aplicar = args.includes('--aplicar')
const solo = valor('--solo')
const idioma = valor('--idioma') || process.env.CLOUD_TEMPLATE_IDIOMA || IDIOMA_DEFAULT
const waba = valor('--waba') || process.env.CLOUD_WABA_ID
const token = process.env.CLOUD_ACCESS_TOKEN

// CLOUD_GRAPH_BASE existe solo para probar el script contra un Graph de mentira EN ESTA
// máquina. Cualquier otro destino se rechaza: el token viaja en cada llamada, y un valor mal
// copiado lo mandaría a un servidor ajeno.
const graphBase = process.env.CLOUD_GRAPH_BASE
if (graphBase && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(graphBase)) {
  console.error(`✖ CLOUD_GRAPH_BASE solo acepta 127.0.0.1 o localhost (pruebas). Valor recibido: ${graphBase}`)
  process.exit(1)
}
const graph = (graphBase || `https://graph.facebook.com/${process.env.CLOUD_API_VERSION || 'v23.0'}`).replace(/\/+$/, '')

if (!idiomaValido(idioma)) {
  console.error(`✖ Idioma «${idioma}» inválido: Meta usa guion bajo (es, es_PE, es_MX, pt_BR…), nunca guion.`)
  process.exit(1)
}
const faltan = [['CLOUD_ACCESS_TOKEN', token], ['CLOUD_WABA_ID (o --waba)', waba]].filter(([, v]) => !v).map(([k]) => k)
if (faltan.length) {
  console.error(`✖ Faltan en el .env de la raíz: ${faltan.join(', ')} (los da el panel de Meta).`)
  process.exit(1)
}
if (solo && !CATALOGO.some(t => t.clave === solo)) {
  console.error(`✖ «${solo}» no está en el catálogo. Claves: ${CATALOGO.map(t => t.clave).join(', ')}`)
  process.exit(1)
}
for (const t of CATALOGO) {
  const p = validarPlantilla(t)
  if (p.length) { console.error(`✖ El catálogo tiene un error en «${t.clave}»: ${p.join('; ')}`); process.exit(1) }
}

async function meta(ruta, { method = 'GET', body = null } = {}) {
  const res = await fetch(ruta.startsWith('http') ? ruta : `${graph}/${ruta}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) {
    const e = data.error || {}
    const detalle = e.error_user_msg || e.message || 'sin detalle'
    throw new Error(`${res.status} ${e.code || ''}${e.error_subcode ? '/' + e.error_subcode : ''}: ${detalle}`)
  }
  return data
}

/** Todas las plantillas de la cuenta (sigue la paginación de Meta). */
async function plantillasDeMeta() {
  const todas = []
  let ruta = `${waba}/message_templates?fields=name,status,category,language,rejected_reason,quality_score,components&limit=100`
  for (let pagina = 0; pagina < 20 && ruta; pagina++) {
    const r = await meta(ruta)
    todas.push(...(r.data || []))
    ruta = r.paging?.next || null   // URL completa de la página siguiente (Meta la da armada)
  }
  return todas
}

let existentes
try {
  existentes = await plantillasDeMeta()
} catch (e) {
  console.error(`✖ No pude leer las plantillas de la cuenta ${waba}: ${e.message}`)
  console.error('  → Revisa que el token tenga whatsapp_business_management y la cuenta asignada al usuario del sistema.')
  process.exit(1)
}

// ─────────────────────────────── borrar ───────────────────────────────
if (comando === 'borrar') {
  const nombre = valor('--nombre')
  if (!nombre) { console.error('✖ Falta --nombre <plantilla>'); process.exit(1) }
  const hay = existentes.filter(e => e.name === nombre)
  if (!hay.length) { console.log(`No existe «${nombre}» en la cuenta ${waba}.`); process.exit(0) }
  console.log(`«${nombre}» existe en: ${hay.map(h => `${h.language} (${h.status})`).join(', ')}`)
  const aprobada = hay.some(h => h.status === 'APPROVED')
  if (!aplicar) {
    console.log('\nSimulación: agrega --aplicar para borrarla (se borra en TODOS los idiomas y no se puede deshacer).')
    if (aprobada) console.log('⚠ Está aprobada: si la borras, Meta no deja volver a crear ese nombre por 30 días. Para cambiar el texto usa `editar`.')
    process.exit(0)
  }
  try {
    await meta(`${waba}/message_templates?name=${encodeURIComponent(nombre)}`, { method: 'DELETE' })
    console.log(`✔ «${nombre}» borrada.${aprobada ? ' Su nombre queda bloqueado 30 días.' : ''}`)
  } catch (e) { console.error(`✖ No se pudo borrar: ${e.message}`); process.exit(1) }
  process.exit(0)
}

// ─────────────────────────────── estado / crear / editar ───────────────────────────────
const ICONO = { APPROVED: '✔', PENDING: '⏳', IN_REVIEW: '⏳', IN_APPEAL: '⏳', REJECTED: '✖', PAUSED: '⚠', DISABLED: '✖', FALTA: '✖' }
const plan = planificarPlantillas({ existentes, idioma, solo })
console.log(`Cuenta de WhatsApp ${waba} · idioma «${idioma}» · ${existentes.length} plantilla(s) en Meta\n`)

let errores = 0, creadas = 0, editadas = 0
for (const p of plan) {
  const { t, nombre, enMeta, estado } = p
  const cabecera = `${ICONO[estado] || '?'} ${nombre} [${idioma}] — `

  if (!p.gestionada) console.log(`ℹ ${t.env} apunta a «${nombre}», que no es la del catálogo («${t.nombre}»): la maneja tu equipo en el panel; aquí solo se informa.`)

  if (!enMeta) {
    const otros = p.otrosIdiomas.length ? ` — pero EXISTE en ${p.otrosIdiomas.join(', ')}: ¿querías --idioma ${p.otrosIdiomas[0]}?` : ''
    console.log(`${cabecera}NO existe en Meta  (${t.uso})${otros}`)
    if (comando !== 'crear' || !p.gestionada) continue
    const payload = payloadDeCreacion(t, { idioma })
    if (!aplicar) {
      console.log(`  simulación → POST ${waba}/message_templates\n${JSON.stringify(payload, null, 2).replace(/^/gm, '    ')}`)
      continue
    }
    try {
      const r = await meta(`${waba}/message_templates`, { method: 'POST', body: payload })
      creadas++
      console.log(`  ✔ creada (id ${r.id}) · estado ${r.status} · categoría ${r.category}`)
      if (r.category && r.category.toLowerCase() !== t.categoria) console.log(`  ⚠ Meta la aprobará como ${r.category} (pedimos ${t.categoria}): se cobra como ${r.category}.`)
    } catch (e) {
      errores++
      console.error(`  ✖ Meta la rechazó: ${e.message}`)
    }
    continue
  }

  const motivo = enMeta.rejected_reason && enMeta.rejected_reason !== 'NONE' ? ` · motivo: ${enMeta.rejected_reason}` : ''
  const calidad = p.calidad && p.calidad !== 'UNKNOWN' ? ` · calidad ${p.calidad}` : ''
  console.log(`${cabecera}${estado} · categoría ${enMeta.category}${motivo}${calidad}`)
  if (p.calidad === 'RED') console.log('  ⚠ Calidad baja: si sigue así, Meta la pausa y los envíos fallan (132015). Revisa el texto y a quién se le envía.')
  if (estado === 'REJECTED') console.log('  → Corrige el texto en el catálogo y usa `editar` (no borres: una borrada aprobada bloquea el nombre 30 días).')
  if (!p.textoDifiere) continue

  console.log('  ⚠ El texto en Meta NO es el del catálogo: el historial guardaría un texto que el cliente no ve.')
  if (comando !== 'editar') { console.log('  → `editar --aplicar` pone el texto del catálogo en Meta (o ajusta el catálogo al de Meta).'); continue }
  if (!ESTADOS_EDITABLES.includes(estado)) { console.log(`  → En estado ${estado} Meta no deja editarla todavía.`); continue }
  const payload = payloadDeEdicion(t)
  if (!aplicar) {
    console.log(`  simulación → POST ${enMeta.id}\n${JSON.stringify(payload, null, 2).replace(/^/gm, '    ')}`)
    if (estado === 'APPROVED') console.log('  ⚠ Está aprobada: la edición vuelve a revisión y Meta solo permite 1 edición cada 24 h (10 cada 30 días).')
    continue
  }
  try {
    await meta(enMeta.id, { method: 'POST', body: payload })
    editadas++
    console.log('  ✔ texto actualizado: Meta la vuelve a revisar.')
  } catch (e) {
    errores++
    console.error(`  ✖ Meta no aceptó la edición: ${e.message}`)
  }
}

if (comando === 'estado' && plan.some(p => p.estado === 'FALTA' && p.gestionada)) {
  console.log('\nPara crear las que faltan: node scripts/meta-plantillas.js crear --aplicar')
}
if (comando !== 'estado' && !aplicar) console.log('\nSimulación: nada se cambió. Repite con --aplicar.')
if (creadas || editadas) console.log('\nMeta las está revisando (minutos a 24 h). Vuelve a correr sin argumentos para ver el estado.')
const lineas = lineasDeEntorno(plan, idioma)
if (lineas.length) {
  console.log('\nAprobadas — pega esto en las variables de entorno de Render (este script no las toca):')
  for (const l of lineas) console.log(`  ${l}`)
}
process.exit(errores ? 1 : 0)
