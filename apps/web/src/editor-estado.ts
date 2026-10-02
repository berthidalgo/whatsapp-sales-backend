// editor-estado.ts — Estado del editor de campañas, aislado del JSX (Hito B1/B3).
//
// EL AGUJERO QUE ESTE MÓDULO CIERRA. El editor de la ficha tenía el borrador, la versión y
// la petición del copiloto mezclados en el componente, con estas tres fallas:
//
//   1. CAMBIAR DE CAMPAÑA DESCARTABA EL BORRADOR. `campaignId` cambiar → el `useEffect` que
//      carga la configuración volvía a pintar los valores del servidor y el trabajo sin
//      guardar desaparecía sin preguntar. En un taller de medio día eso es pérdida de
//      tiempo real, y a veces de datos.
//
//   2. UNA RESPUESTA TARDÍA DEL COPILOTO APLICABA CAMBIOS DE OTRA CAMPAÑA. Se pedía la
//      propuesta para la campaña A; el operador cambió a la B; cuando llegó la respuesta,
//      el deepMerge la aplicó al borrador de la B. Ficha de un producto con datos de otro.
//
//   3. UNA EDICIÓN HECHA DURANTE EL GUARDADO SE PERDÍA. El guardado tomaba un volcado del
//      estado; si el usuario escribía mientras volaba la petición, al volver se pisaba con
//      lo guardado.
//
// AQUÍ hay estado explícito por campaña, una generación monótona para ignorar respuestas
//      obsoletas y una revisión para no perder lo escrito durante un guardado. Sin IA, sin
//      red: es lógica de pantalla y por eso se puede probar sola.

import type { AgentConfig } from '@shared/types'

export interface Borrador {
  campaignId: number
  version: number | null
  factSheet: any
  agente: any
  /** Cambios sin guardar respecto de la versión cargada. */
  dirty: boolean
  /** Generación de la última edición (para detectar escrituras durante un guardado). */
  revision: number
}

export type Borradores = Record<number, Borrador>

export function borradorVacio(campaignId: number): Borrador {
  return { campaignId, version: null, factSheet: {}, agente: {}, dirty: false, revision: 0 }
}

/** ¿El borrador pertenece a la campaña que se está mostrando? */
export function borradorDe(borradores: Borradores, campaignId: number | null): Borrador | null {
  if (campaignId == null) return null
  return borradores[campaignId] || null
}

/**
 * Carga la ficha del servidor en el borrador de SU campaña, salvo que ya haya cambios sin
 * guardar: en ese caso devuelve el borrador intacto y `descartado: false`, que es lo que
 * impide que un refetch del polling pise lo que el operador está escribiendo.
 */
export function cargarFicha(borradores: Borradores, config: AgentConfig | undefined, campaignId: number | null): { borradores: Borradores; descartado: boolean } {
  if (campaignId == null || !config || config.campaignId !== campaignId) return { borradores, descartado: false }
  const actual = borradores[campaignId]
  if (actual?.dirty) return { borradores, descartado: false }
  return {
    borradores: {
      ...borradores,
      [campaignId]: {
        campaignId,
        version: config.version ?? null,
        factSheet: config.factSheet || {},
        agente: config.agente || {},
        dirty: false,
        revision: (actual?.revision || 0) + 1,
      },
    },
    descartado: true,
  }
}

/** Edita un campo del borrador (incrementa la revisión: hay escritura pendiente). */
export function editar(borradores: Borradores, campaignId: number, patch: Partial<Pick<Borrador, 'factSheet' | 'agente'>>): Borradores {
  const b = borradores[campaignId] || borradorVacio(campaignId)
  return {
    ...borradores,
    [campaignId]: { ...b, ...patch, dirty: true, revision: b.revision + 1 },
  }
}

/**
 * Prepara un guardado: congela versión, contenido y revisión. Devuelve un descriptor que
 * permite decidir, cuando llegue la respuesta, si el resultado sigue siendo el guardado que
 * se pidió o si el operador escribió mientras tanto.
 */
export function prepararGuardado(borradores: Borradores, campaignId: number | null) {
  if (campaignId == null) return null
  const b = borradores[campaignId]
  if (!b) return null
  return { campaignId, version: b.version, factSheet: b.factSheet, agente: b.agente, revision: b.revision }
}

/**
 * ¿Este guardado todavía describe el borrador vigente? Si el operador editó después de
 * pulsar Guardar, la respuesta NO debe limpiar el flag de cambios pendientes.
 */
export function guardadoSigueVigente(borradores: Borradores, intento: ReturnType<typeof prepararGuardado>): boolean {
  if (!intento) return false
  const b = borradores[intento.campaignId]
  return !!b && b.revision === intento.revision
}

/** Aplica la versión devuelta por el servidor sin tocar lo editado durante el vuelo. */
export function confirmarGuardado(borradores: Borradores, intento: ReturnType<typeof prepararGuardado>, nuevaVersion: number): { borradores: Borradores; followUpsPendientes: boolean } {
  if (!intento) return { borradores, followUpsPendientes: false }
  const b = borradores[intento.campaignId] || borradorVacio(intento.campaignId)
  const vigente = b.revision === intento.revision
  return {
    borradores: {
      ...borradores,
      [intento.campaignId]: {
        ...b,
        version: Math.max(b.version ?? 0, nuevaVersion),
        // Si hubo edición durante el vuelo, los cambios siguen SIN guardar (y visibles).
        dirty: vigente ? false : true,
      },
    },
    followUpsPendientes: !vigente,
  }
}

/** Descarta los cambios locales y adopta lo que hay en el servidor. */
export function descartarBorrador(borradores: Borradores, campaignId: number | null, config?: AgentConfig): Borradores {
  if (campaignId == null) return borradores
  const b = borradores[campaignId] || borradorVacio(campaignId)
  return {
    ...borradores,
    [campaignId]: {
      ...b,
      version: config?.version ?? b.version,
      factSheet: config?.factSheet || {},
      agente: config?.agente || {},
      dirty: false,
      revision: b.revision + 1,
    },
  }
}

// ── Petición del copiloto ────────────────────────────────────────────────

export interface PeticionCopiloto {
  /** Campaña para la que se pidió. Una respuesta de otra campaña se descarta. */
  campaignId: number
  /** Revisión del borrador en el momento de pedir (para no aplicar sobre otro estado). */
  revision: number
  /** Token único: identifica ESTA respuesta. */
  token: number
}

export type Copiloto = { vigente: PeticionCopiloto | null; cargando: boolean }

/**
 * ¿Esta respuesta se aplica al borrador? Solo si es de la campaña abierta y no hubo
 * ediciones posteriores a la petición. Es el cierre de "una respuesta tardía de A no
 * modifica el borrador de B".
 */
export function respuestaEsAplicable(peticion: PeticionCopiloto | null, campaignId: number | null, revisionActual: number): boolean {
  if (!peticion || campaignId == null) return false
  if (peticion.campaignId !== campaignId) return false
  return peticion.revision === revisionActual
}

/** Merge recursivo: omitir conserva, objetos combinan, arrays y escalares reemplazan. */
export function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target
  const out = { ...target }
  for (const key of Object.keys(source)) {
    const sv = (source as any)[key]
    if (sv === null || sv === undefined) continue
    if (Array.isArray(sv)) out[key] = sv
    else if (typeof sv === 'object') out[key] = deepMerge(out[key] || {}, sv)
    else out[key] = sv
  }
  return out
}

/** Aplica una propuesta del copiloto SOLO si sigue siendo aplicable. */
export function aplicarPropuesta(
  borradores: Borradores,
  peticion: PeticionCopiloto | null,
  campaignId: number | null,
  edits: { factSheet?: any; agente?: any } | undefined,
): Borradores {
  if (!edits || campaignId == null) return borradores
  if (!respuestaEsAplicable(peticion, campaignId, borradores[campaignId]?.revision ?? -1)) return borradores
  const b = borradores[campaignId] || borradorVacio(campaignId)
  return {
    ...borradores,
    [campaignId]: {
      ...b,
      factSheet: edits.factSheet ? deepMerge(b.factSheet, edits.factSheet) : b.factSheet,
      agente: edits.agente ? deepMerge(b.agente, edits.agente) : b.agente,
      dirty: true,
      revision: b.revision + 1,
    },
  }
}

/** ¿El borrador pide borrar algo que ya existe? (exige confirmación del operador) */
export function pideBorrado(borrador: Borrador, actual: AgentConfig | undefined): string[] {
  const actuales = { ...(actual?.factSheet || {}), ...(actual?.agente || {}) }
  const pedidas: any = { ...(borrador.factSheet || {}), ...(borrador.agente || {}) }
  const fuera: string[] = []
  for (const [k, v] of Object.entries(pedidas)) {
    if (v !== null) continue
    const previo = (actuales as any)[k]
    if (previo !== undefined && previo !== null) fuera.push(k)
  }
  return fuera
}