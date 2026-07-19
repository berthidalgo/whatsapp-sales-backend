// src/lib/tenant.js — EL SWITCH DE TENANT (jul 2026)
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   Hasta hoy el runtime asumía 'peru_exporta' HARDCODEADO en 6 lugares
//   (handler, lead-resolver, campaign-resolver, brain-pipeline, gemini,
//   agent-brain). Con BIOAYUR como cliente real, el tenant activo pasa a
//   ser una PERILLA de entorno:
//
//     ACTIVE_TENANT=bioayur       → el bot atiende BIOAYUR (colágeno)
//     ACTIVE_TENANT=peru_exporta  → vuelve a Perú Exporta (o sin la var)
//
//   Cambiar de negocio = editar la env var en Render (redeploy ~30s).
//   Los DATOS de ambos tenants conviven en la misma BD sin chocar (todo
//   está particionado por tenantId: leads [tenantId,telefono], campañas,
//   auth, quotas). Nada se borra al switchear: el tenant inactivo queda
//   DORMIDO con su config intacta.
//
//   Default seguro = 'peru_exporta': sin la env var, el comportamiento es
//   byte-idéntico al de siempre (cero regresión en el deploy actual).
// ─────────────────────────────────────────────────────────────────────────

export const ACTIVE_TENANT = process.env.ACTIVE_TENANT || 'peru_exporta'

// ── Vertical por tenant ──
// El "vertical" es el MANUAL DE VENTA que usa el cerebro (persona, momentos,
// slots, filosofía de cierre). El tenant define su default; una campaña puede
// sobreescribirlo con config.vertical (gana la campaña sobre el tenant).
//   exportacion → edtech consultiva, meta = agendar llamada (Perú Exporta)
//   colageno    → e-commerce nutracéutico, meta = cerrar pedido por chat (BIOAYUR)
const VERTICAL_POR_TENANT = {
  peru_exporta: 'exportacion',
  bioayur: 'colageno'
}

export function verticalPorTenant(tenantId) {
  return VERTICAL_POR_TENANT[tenantId] || 'exportacion'
}

export const TENANT_VERSION = 'v1_switch_active_tenant'
