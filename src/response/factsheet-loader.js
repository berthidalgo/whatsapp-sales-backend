// src/response/factsheet-loader.js — Hidata v20 · Sprint 2 (oleada 2)
//
// FACTSHEET LOADER — carga el factSheet de la campaña de un lead y lo convierte
// en variables planas para inyectar en los prompts (que ahora son AGNÓSTICOS).
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   Antes el precio (S/2,997), el nombre del producto y qué incluye estaban
//   HARDCODEADOS dentro de los prompts. Eso causó que el bot le dijera a un
//   lead real un precio FALSO (S/2,997 cuando el real es S/1,500).
//
//   Ahora el precio vive en campaign.config.factSheet (editable por el vendedor
//   desde su dashboard). Este módulo:
//     1. Lee la campaña del lead (vía leadId → campaignId → config).
//     2. Extrae el factSheet.
//     3. Lo aplana en variables {precio}, {nombreProducto}, {incluye}, etc.
//        que los prompts agnósticos consumen vía substituteVariables().
//
//   Si el lead no tiene campaña o la campaña no tiene factSheet, devuelve
//   defaults SEGUROS y GENÉRICOS (nunca un precio inventado). El bot, sin
//   factSheet, habla de forma genérica y deriva a humano para el precio.
//
//   ⚠️ El guardrail R2 (validar que el LLM no diga un precio fuera del
//      factSheet) es de la OLEADA 3. Este módulo solo ALIMENTA el precio
//      correcto; todavía no VALIDA la salida.
// ─────────────────────────────────────────────────────────────────────────

import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// DEFAULTS GENÉRICOS Y SEGUROS
// Si no hay factSheet, el bot NUNCA inventa un precio: habla genérico.
// ════════════════════════════════════════════════════════
const SAFE_FACTSHEET_VARS = {
  nombreProducto:   'nuestro programa',
  precioTexto:      null,   // null → los prompts NO mencionan precio, derivan a humano
  precioMonto:      null,
  incluyeTexto:     'acompañamiento y material del programa',
  noIncluyeTexto:   '',
  metodosPagoTexto: '',
  modalidadTexto:   '',
  duracionTexto:    '',
  // Bloque consolidado listo para pegar en un prompt
  factSheetBloque:  'No tengo la ficha comercial exacta de este programa a la mano.',
  tieneFactSheet:   false
}

// ════════════════════════════════════════════════════════
// API PÚBLICA — loadFactSheetVars()
// ════════════════════════════════════════════════════════

/**
 * Carga el factSheet de la campaña de un lead y lo aplana en variables.
 *
 * @param {object} args
 * @param {number} args.leadId
 * @param {object?} args.campaignConfig - si ya tienes el config cargado, pásalo
 *        y evitamos la query (optimización). Si no, lo buscamos por leadId.
 * @returns {Promise<object>} variables planas para los prompts
 */
export async function loadFactSheetVars({ leadId, campaignConfig = null }) {
  try {
    let config = campaignConfig

    // Si no nos pasaron el config, lo buscamos vía leadId → campaign.config
    if (!config && leadId) {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          campaign: { select: { config: true, nombre: true } }
        }
      })
      config = lead?.campaign?.config || null
    }

    return flattenFactSheet(config)

  } catch (err) {
    console.error('[FactSheetLoader] Error:', err.message)
    return { ...SAFE_FACTSHEET_VARS }
  }
}

// ════════════════════════════════════════════════════════
// NÚCLEO — flattenFactSheet()  (función pura, testeable sin BD)
// ════════════════════════════════════════════════════════

/**
 * Convierte un campaign.config en variables planas para los prompts.
 * Tolera config null, factSheet ausente o campos faltantes → defaults seguros.
 *
 * @param {object|null} config - el campaign.config (la "pizarra")
 * @returns {object} variables planas
 */
export function flattenFactSheet(config) {
  const fs = config?.factSheet
  if (!fs) return { ...SAFE_FACTSHEET_VARS }

  // ─── Precio ───
  const precioTexto =
    fs.precio?.textoExacto ||
    (fs.precio?.monto ? `${fs.precio?.moneda || ''} ${fs.precio.monto}`.trim() : null)
  const precioMonto = fs.precio?.monto ?? null

  // ─── Nombre del producto (del agente.rol o el nombre de campaña) ───
  const nombreProducto =
    config?.agente?.nombreProducto ||
    config?.nombreProducto ||
    SAFE_FACTSHEET_VARS.nombreProducto

  // ─── Listas → texto legible ───
  const incluyeTexto = Array.isArray(fs.incluye) && fs.incluye.length
    ? fs.incluye.join(', ')
    : SAFE_FACTSHEET_VARS.incluyeTexto

  const noIncluyeTexto = Array.isArray(fs.NO_incluye) && fs.NO_incluye.length
    ? fs.NO_incluye.join(', ')
    : ''

  const metodosPagoTexto = Array.isArray(fs.metodosPago) && fs.metodosPago.length
    ? fs.metodosPago.join(', ')
    : ''

  const modalidadTexto = fs.fechasReales?.modalidad || ''
  const duracionTexto = fs.fechasReales?.duracion || ''

  // ─── Bloque consolidado (lo que el prompt pega como "ficha comercial") ───
  const lineas = []
  if (precioTexto) lineas.push(`Precio: ${precioTexto}`)
  if (incluyeTexto) lineas.push(`Incluye: ${incluyeTexto}`)
  if (modalidadTexto) lineas.push(`Modalidad: ${modalidadTexto}`)
  if (duracionTexto) lineas.push(`Duración: ${duracionTexto}`)
  if (metodosPagoTexto) lineas.push(`Métodos de pago: ${metodosPagoTexto}`)
  const factSheetBloque = lineas.length
    ? lineas.join('\n')
    : SAFE_FACTSHEET_VARS.factSheetBloque

  return {
    nombreProducto,
    precioTexto,                      // null si no hay → el prompt NO da precio
    precioMonto,
    incluyeTexto,
    noIncluyeTexto,
    metodosPagoTexto,
    modalidadTexto,
    duracionTexto,
    factSheetBloque,
    tieneFactSheet: true
  }
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const FACTSHEET_LOADER_VERSION = 'v1_sprint2_oleada2'
