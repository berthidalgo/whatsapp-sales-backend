// tests/crm-contratos.test.js — CONTRATOS QUE EL CRM NECESITA (preparación CRM)
//
// Cada test es un requisito del recorrido Operador→API→BD→cerebro:
//   · la ficha se lee con version y se escribe con control optimista (428/409);
//   · la campaña se crea desde la API (borrador parcial o activa validada);
//   · el inbox pagina sin romper el contrato legacy;
//   · el preview no envía, no persiste y no llama al LLM;
//   · el takeover humano invalida el turno en vuelo;
//   · ningún tenant toca lo ajeno (404, no 403, para no confirmar existencia).
//
// Dobles controlados: prisma falso en memoria (sin red, sin BD). Nada aquí toca
// Meta, LLM ni disco.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getAgentConfigV2, saveAgentConfigV2, previewAgentConfigV2,
  createCampaignV2, getCampaignV2, slugDesdeNombre,
} from '../src/api/flow.js'
import { listLeadsV2, conversationV2 } from '../src/api/inbox.js'
import { setModeV2, assignV2, previewTurnoV2, reabrirV2 } from '../src/api/inbox-actions.js'
import { checkAndMark } from '../src/webhook/idempotency.js'
import { updateCampaign, deleteCampaign, saveSteps, activarCampaign, createCampaign, testTrigger } from '../src/routes/campaigns.js'
import { validarSteps, buscarClavePeligrosa } from '../src/config/campaign-schema.js'
import { saveInboundMedia } from '../src/lib/mediaStore.js'
import {
  enqueueMessage, getMessageGeneration, invalidarTurnoEnVuelo, clearAllDebounces,
} from '../src/webhook/debounce.js'

// ── Fixtures ─────────────────────────────────────────────────────────────

const FICHA_V1 = {
  vertical: 'tienda',
  agente: { nombre: 'Jhon', empresa: 'Hidata Importaciones', nombreProducto: 'Producto Ganador' },
  factSheet: {
    precio: { textoExacto: '1 unidad: S/ 99 · 2 unidades: S/ 179', monto: 99, moneda: 'S/' },
    incluye: ['Envío a todo el Perú'],
    reglasOro: ['Pago contraentrega, jamás por adelantado'],
  },
}

const FICHA_V2_PRECIO = {
  precio: { textoExacto: '1 unidad: S/ 89 · 2 unidades: S/ 159', monto: 89, moneda: 'S/' },
}

function reqFake(user, { params = {}, query = {}, body = {} } = {}) {
  return { user, params, query, body }
}
function replyFake() {
  const r = { status: 200, payload: undefined }
  r.code = (s) => { r.status = s; return r }
  r.send = (p) => { r.payload = p; return r }
  return r
}

// Dobles Prisma: filtros compuestos, proyección y orden estable de consultas reales.
const igual = (a, b) => a instanceof Date || b instanceof Date
  ? new Date(a).getTime() === new Date(b).getTime() : (a ?? null) === (b ?? null)
function match(row, where) {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue // Prisma 5 omite undefined; permite detectar scopes incompletos.
    if (k === 'OR') { if (!v.some(w => match(row, w))) return false; continue }
    if (k === 'AND') { if (!(Array.isArray(v) ? v : [v]).every(w => match(row, w))) return false; continue }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      for (const [op, n] of Object.entries(v)) {
        const a = n instanceof Date ? new Date(row[k]).getTime() : row[k]
        const b = n instanceof Date ? n.getTime() : n
        if (op === 'lt' && !(a < b)) return false
        if (op === 'lte' && !(a <= b)) return false
        if (op === 'gt' && !(a > b)) return false
        if (op === 'gte' && !(a >= b)) return false
        if (op === 'in' && !n.some(x => igual(row[k], x))) return false
        if (op === 'equals' && !igual(row[k], n)) return false
      }
      continue
    }
    if (!igual(row[k], v)) return false
  }
  return true
}
function proyectar(row, select) {
  if (!row) return row
  if (Array.isArray(row)) return row.map(r => proyectar(r, select))
  if (!select) return structuredClone(row)
  const out = {}
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = structuredClone(row[k])
    else if (v?.select) out[k] = proyectar(row[k], v.select)
  }
  return out
}
function ordenar(rows, orderBy = { createdAt: 'asc' }) {
  const claves = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(Object.entries)
  return rows.sort((a, b) => {
    for (const [k, dir] of claves) {
      const x = k.endsWith('At') ? new Date(a[k]).getTime() : a[k]
      const y = k.endsWith('At') ? new Date(b[k]).getTime() : b[k]
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
}
const diferido = work => ({ then: (ok, fail) => Promise.resolve().then(work).then(ok, fail) })
function aplicarDatos(row, data) {
  for (const [k, v] of Object.entries(data || {})) {
    if (v !== null && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment
    else row[k] = k === 'config' && v?.constructor?.name === 'DbNull' ? null : v
  }
}

const ADMIN_T1 = { role: 'ADMIN', tenantId: 't1', vendorId: 10 }
const VENDOR_T1 = { role: 'VENDOR', tenantId: 't1', vendorId: 11 }
const ADMIN_T2 = { role: 'ADMIN', tenantId: 't2', vendorId: 20 }

// Prisma falso mínimo: solo lo que tocan los handlers bajo prueba.
function prismaFalso(seed = {}) {
  const campaigns = new Map()
  for (const c of (seed.campaigns || [])) campaigns.set(c.id, { triggers: [], steps: [], ...c })
  const vendors = new Map((seed.vendors || []).map(v => [v.id, v]))
  const leads = new Map((seed.leads || []).map(l => [l.id, l]))
  const messages = seed.messages || []
  const notifs = (seed.notifs || []).map((n, i) => ({ id: i + 1, ...n }))
  const medias = (seed.medias || []).map(m => ({ messageId: null, ...m }))
  const mediaRows = []
  let seq = 900
  const state = { leadState: new Map(Object.entries(seed.leadState || {}).map(([k, v]) => [Number(k), v])) }

  const doble = {
    campaign: {
      // Respetan `orderBy.id` (asc por defecto) como los handlers reales: sin esto,
      // "la primera activa" sería cualquier fila del Map y las pruebas de
      // determinismo no probarian nada.
      findFirst: async ({ where, orderBy, select } = {}) => {
        let arr = [...campaigns.values()].filter(c => match(c, where))
        if (orderBy?.id === 'asc') arr.sort((a, b) => a.id - b.id)
        return proyectar(arr[0] || null, select)
      },
      create: async ({ data, select } = {}) => {
        const id = ++seq
        const row = {
          id, version: 1, triggers: [], steps: [],
          ...data,
          ...(data.triggers?.create ? { triggers: data.triggers.create.map(t => ({ ...t })) } : {}),
          ...(data.steps?.create ? { steps: data.steps.create.map(s => ({ ...s })) } : {}),
        }
        campaigns.set(id, row)
        if (!select) return row
        const out = {}
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k]
        return out
      },
      updateMany: ({ where, data }) => diferido(() => {
        const rows = [...campaigns.values()].filter(c => match(c, where))
        for (const row of rows) aplicarDatos(row, data)
        return { count: rows.length }
      }),
      update: ({ where, data }) => diferido(() => {
        const row = [...campaigns.values()].find(c => match(c, where))
        if (!row) throw Object.assign(new Error('fila cambió'), { code: 'P2025' })
        aplicarDatos(row, data)
        return structuredClone(row)
      }),
      deleteMany: ({ where }) => diferido(() => {
        const rows = [...campaigns.values()].filter(c => match(c, where))
        for (const row of rows) campaigns.delete(row.id)
        return { count: rows.length }
      }),
    },
    vendor: {
      findFirst: async ({ where } = {}) => [...vendors.values()].find(v => match(v, where)) || null,
    },
    // Las operaciones se ejecutan al esperarlas: se comprueba orden y rollback.
    $transaction: async ops => {
      const backup = structuredClone([...campaigns])
      try { const out = []; for (const op of ops) out.push(await op); return out }
      catch (e) { campaigns.clear(); for (const [id, row] of backup) campaigns.set(id, row); throw e }
    },
    lead: {
      findFirst: async () => null, // se sobrescribe abajo (necesita leads por scope)
      findUnique: async ({ where } = {}) => leads.get(where.id) || null,
      findMany: async ({ where, take, skip, orderBy } = {}) => {
        let arr = [...leads.values()].filter(l => match(l, where))
        arr.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        if (skip) arr = arr.slice(skip)
        if (take !== undefined) arr = arr.slice(0, take)
        return arr.map(l => ({
          ...l,
          leadState: state.leadState.get(l.id) || null,
          vendor: { nombre: 'Vendedor' },
          mensajes: [{ texto: 'hola', origen: 'LEAD', createdAt: l.updatedAt }],
        }))
      },
      updateMany: async ({ where, data }) => {
        const row = [...leads.values()].find(l => match(l, where))
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    },
    leadState: {
      upsert: async ({ where, update, create }) => {
        const cur = state.leadState.get(where.leadId) || {}
        const next = { ...cur, ...update, ...create, leadId: where.leadId }
        state.leadState.set(where.leadId, next)
        return next
      },
      findUnique: async ({ where } = {}) => state.leadState.get(where.leadId) || null,
    },
    message: {
      // Respeta `orderBy.createdAt` en ambos sentidos: las pruebas de paginación
      // necesitan el DESC real, si no pasarían con un falso que solo ordena ASC
      // y no detectarían un cambio que devuelve los eventos más viejos.
      findMany: async ({ where, take, orderBy } = {}) => {
        let arr = messages.filter(m => match(m, where))
        ordenar(arr, orderBy)
        return take !== undefined ? arr.slice(0, take) : arr
      },
    },
    crmNotification: {
      findMany: async ({ where, take, orderBy } = {}) => {
        let arr = notifs.filter(n => match(n, where))
        ordenar(arr, orderBy)
        return take !== undefined ? arr.slice(0, take) : arr
      },
    },
    mediaAsset: {
      findMany: async ({ where, take, orderBy } = {}) => {
        let arr = medias.filter(m => match(m, where))
        ordenar(arr, orderBy)
        return take !== undefined ? arr.slice(0, take) : arr
      },
      create: async ({ data }) => { const row = { id: ++seq, ...data }; mediaRows.push(row); return { id: row.id } },
    },
  }
  return { ...doble, _campaigns: campaigns, _leads: leads, _mediaRows: mediaRows, _state: state }
}

// lead.findFirst con scope (los handlers mezclan scopeWhere + id) + updateMany real
// sobre el mismo mapa interno que usa el resto de los dobles: si se usara un mapa
// aparte, `updateMany({id, tenantId})` no encontraría nada y las pruebas de
// escritura atómica pasarían por el 404 en vez de verificar la escritura.
function conLeads(db, leads) {
  const mapa = db._leads
  for (const l of leads) mapa.set(l.id, l)
  const conEstado = (l) => ({ ...l, leadState: db._state.leadState.get(l.id) || null })
  db.lead.findFirst = async ({ where } = {}) => {
    const l = mapa.get(where.id)
    if (!l) return null
    if (where.tenantId && l.tenantId !== where.tenantId) return null
    if (where.vendorId !== undefined && l.vendorId !== where.vendorId) return null
    return conEstado(l)
  }
  db.lead.findUnique = async ({ where } = {}) => {
    const l = mapa.get(where.id)
    return l ? conEstado(l) : null
  }
  db.lead.updateMany = async ({ where, data }) => {
    const rows = [...mapa.values()].filter(l => match(l, where))
    for (const l of rows) Object.assign(l, data)
    return { count: rows.length }
  }
  return db
}

// ── Ficha con version ────────────────────────────────────────────────────

test('GET agent-config entrega version (el editor la devuelve en el PUT)', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 4, activa: true }] })
  const r = replyFake()
  await getAgentConfigV2(reqFake(ADMIN_T1, { query: { campaignId: 1 } }), r, db)
  assert.equal(r.status, 200)
  assert.equal(r.payload.version, 4)
  assert.equal(r.payload.agente.nombre, 'Jhon')
})

test('PUT agent-config sin version → 428 (no se escribe a ciegas)', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }] })
  const r = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO } }), r, db)
  assert.equal(r.status, 428)
  assert.equal(db._campaigns.get(1).version, 1, 'nada se escribió')
})

test('PUT agent-config con version vigente → guarda, mergea por sección y devuelve version+1', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 7, activa: true }] })
  const r = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO, version: 7 } }), r, db)
  assert.equal(r.status, 200)
  assert.deepEqual(r.payload, { ok: true, campaignId: 1, version: 8 })
  const guardada = db._campaigns.get(1).config
  assert.match(guardada.factSheet.precio.textoExacto, /S\/ 89/, 'el precio nuevo quedó')
  assert.equal(guardada.agente.nombre, 'Jhon', 'omitir agente ≠ borrarlo')
})

test('PUT agent-config con version vieja → 409 con la ficha vigente (el borrador no se pierde)', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 8, activa: true }] })
  const r = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO, version: 7 } }), r, db)
  assert.equal(r.status, 409)
  assert.equal(r.payload.version, 8, 'el front recarga esta version')
  assert.ok(r.payload.factSheet?.precio?.textoExacto, 'trae la ficha vigente para combinar')
  assert.equal(db._campaigns.get(1).version, 8, 'no se pisó al otro supervisor')
})

test('PUT agent-config: VENDOR → 403; otro tenant → 404', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }] })
  const r1 = replyFake()
  await saveAgentConfigV2(reqFake(VENDOR_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO, version: 1 } }), r1, db)
  assert.equal(r1.status, 403)
  const r2 = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T2, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO, version: 1 } }), r2, db)
  assert.equal(r2.status, 404, '404 y no 403: no confirma existencia ajena')
})

// ── Alta de campañas ─────────────────────────────────────────────────────

test('POST /v2/campaigns: borrador guarda parcial sin validar contrato', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Promo Julio', borrador: true } }), r, db)
  assert.equal(r.status, 201)
  assert.equal(r.payload.borrador, true)
  assert.equal(r.payload.activa, false)
  assert.equal(r.payload.version, 1)
  assert.ok(r.payload.slug.length > 0, 'slug derivado del nombre')
})

test('POST /v2/campaigns: activar exige ficha + trigger', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r1 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Sin ficha', triggers: ['hola'] } }), r1, db)
  assert.equal(r1.status, 400, 'activa sin config se rechaza (usa borrador:true)')
  const r2 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Con ficha', config: FICHA_V1 } }), r2, db)
  assert.equal(r2.status, 400, 'activa sin triggers se rechaza')
})

test('POST /v2/campaigns: alta activa válida → 201 con triggers', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Promo', config: FICHA_V1, triggers: ['Precio', 'precio'] } }), r, db)
  assert.equal(r.status, 400, 'triggers duplicados (tras normalizar) se rechazan')
  const r2 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Promo', slug: 'PROMO', config: FICHA_V1, triggers: ['Precio', 'Envio'] } }), r2, db)
  assert.equal(r2.status, 201)
  assert.equal(r2.payload.slug, 'PROMO')
})

test('POST /v2/campaigns: slug duplicado en el tenant → 409; en otro tenant → ok', async () => {
  const db = prismaFalso({
    vendors: [{ id: 10, tenantId: 't1' }, { id: 20, tenantId: 't2' }],
    campaigns: [{ id: 1, tenantId: 't1', slug: 'PROMO', nombre: 'P', config: FICHA_V1, version: 1, activa: true }],
  })
  const r1 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Otra', slug: 'PROMO', config: FICHA_V1, triggers: ['x2'] } }), r1, db)
  assert.equal(r1.status, 409)
  const r2 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T2, { body: { nombre: 'Otra', slug: 'PROMO', config: FICHA_V1, triggers: ['x2'] } }), r2, db)
  assert.equal(r2.status, 201, 'los slugs son únicos POR tenant')
})

test('POST /v2/campaigns: vendor de otro tenant → 400; VENDOR → 403', async () => {
  const db = prismaFalso({ vendors: [{ id: 20, tenantId: 't2' }] })
  const r1 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'X', borrador: true, vendorId: 20 } }), r1, db)
  assert.equal(r1.status, 400)
  const r2 = replyFake()
  await createCampaignV2(reqFake(VENDOR_T1, { body: { nombre: 'X', borrador: true, vendorId: 11 } }), r2, db)
  assert.equal(r2.status, 403)
})

test('GET /v2/campaigns/:id: detalle en scope; ajeno → 404', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', slug: 'P', nombre: 'P', config: FICHA_V1, version: 3, activa: true, triggers: [{ texto: 'precio' }] }] })
  const r1 = replyFake()
  await getCampaignV2(reqFake(ADMIN_T1, { params: { id: 1 } }), r1, db)
  assert.equal(r1.status, 200)
  assert.equal(r1.payload.version, 3)
  assert.deepEqual(r1.payload.triggers, ['precio'])
  const r2 = replyFake()
  await getCampaignV2(reqFake(ADMIN_T2, { params: { id: 1 } }), r2, db)
  assert.equal(r2.status, 404)
})

// ── Gate de activación (el borrador no puede saltarse el contrato) ───────

test('activarCampaign: un borrador sin ficha NO se activa (409 con el detalle)', async () => {
  const db = prismaFalso({
    campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', slug: 'P', vendorId: 10, config: null, version: 1, activa: false }],
  })
  const r = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, query: {}, body: {} }), r, db)
  assert.equal(r.status, 409)
  assert.match(r.payload.error, /completar su ficha/)
  assert.ok(r.payload.detalles.some(d => /config/.test(d)), 'el operador recibe qué falta')
  assert.ok(r.payload.detalles.some(d => /trigger/.test(d)), 'y también lo que falta de triggers')
  assert.equal(db._campaigns.get(5).activa, false, 'no se encendió')
})

test('activarCampaign: borrador con precio incoherente NO se activa (el guardrail nunca lo vio)', async () => {
  const malaFicha = { agente: { nombre: 'Jhon', empresa: 'X' }, factSheet: { precio: { textoExacto: '3', monto: 1500 } } }
  const db = prismaFalso({
    campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', slug: 'P', vendorId: 10, config: malaFicha, version: 1, activa: false, triggers: [{ texto: 'hola' }] }],
  })
  const r = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, query: {}, body: {} }), r, db)
  assert.equal(r.status, 409)
  assert.ok(r.payload.detalles.some(d => /moneda|precio/i.test(d)))
})

test('activarCampaign: ficha válida + trigger → activa', async () => {
  const db = prismaFalso({
    campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', slug: 'P', vendorId: 10, config: FICHA_V1, version: 1, activa: false, triggers: [{ texto: 'hola' }], steps: [{ tipo: 'MSG', mensaje: 'hola', orden: 1 }] }],
  })
  const r = replyFake()
  const out = await activarCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, query: {}, body: {} }), r, db)
  assert.equal(r.status, 200)
  assert.equal(db._campaigns.get(5).activa, true)
  assert.equal(out.activa, true)
})

test('activarCampaign sin trigger → 409 (nunca dispararía)', async () => {
  const db = prismaFalso({
    campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', slug: 'P', vendorId: 10, config: FICHA_V1, version: 1, activa: false, triggers: [] }],
  })
  const r = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, query: {}, body: {} }), r, db)
  assert.equal(r.status, 409)
  assert.ok(r.payload.detalles.some(d => /trigger/.test(d)))
})

test('PUT /campaigns/:id con activa:true también pasa por el gate de contrato', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: null, version: 1, activa: false }] })
  const r = replyFake()
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { activa: true } }), r, db)
  assert.equal(r.status, 409, 'no se puede encender una campaña sin ficha por la puerta de atrás')
  assert.equal(db._campaigns.get(5).activa, false)
})

test('PUT /campaigns/:id: renombrar NO sube la version (no fabrica 409 por contenido intacto)', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'Viejo', config: FICHA_V1, version: 5, activa: true }] })
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { nombre: 'Nuevo' } }), replyFake(), db)
  assert.equal(db._campaigns.get(5).version, 5, 'el control de concurrencia es sobre la ficha')
  assert.equal(db._campaigns.get(5).nombre, 'Nuevo')
})

test('PUT /campaigns/:id: editar la ficha SÍ sube la version', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 5, activa: true }] })
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { config: { factSheet: FICHA_V2_PRECIO }, version: 5 } }), replyFake(), db)
  assert.equal(db._campaigns.get(5).version, 6)
})

test('slugDesdeNombre: mayúsculas sin acentos; nunca vacío', () => {
  assert.equal(slugDesdeNombre('Promo Julio ☀️'), 'PROMO_JULIO')
  assert.equal(slugDesdeNombre('Colágeno BIOAYUR'), 'COLAGENO_BIOAYUR')
  assert.equal(slugDesdeNombre('!!!'), 'CAMPANA')
})

// ── Legacy con versión ───────────────────────────────────────────────────

test('PUT /campaigns/:id: tocar config sin version → 428; con vieja → 409; vigente → guarda', async () => {
  const mk = () => prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 2, activa: true }] })
  const r1 = replyFake()
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { config: { factSheet: FICHA_V2_PRECIO } } }), r1, mk())
  assert.equal(r1.status, 428)
  const db2 = mk()
  const r2 = replyFake()
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { config: { factSheet: FICHA_V2_PRECIO }, version: 1 } }), r2, db2)
  assert.equal(r2.status, 409)
  assert.equal(r2.payload.version, 2)
  // Nota: el handler legacy DEVUELVE el objeto (Fastify lo serializa); solo los
  // errores usan reply.code().send(). Por eso se captura el valor de retorno.
  const db3 = mk()
  const out3 = await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { config: { factSheet: FICHA_V2_PRECIO }, version: 2 } }), replyFake(), db3)
  assert.equal(out3.version, 3)
  assert.match(db3._campaigns.get(5).config.factSheet.precio.textoExacto, /S\/ 89/)
})

test('PUT /campaigns/:id: solo nombre no exige version; ajeno → 404', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 2, activa: true }] })
  const out1 = await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { nombre: 'Nuevo' } }), replyFake(), db)
  assert.equal(out1.nombre, 'Nuevo')
  const r2 = replyFake()
  await updateCampaign(reqFake(ADMIN_T2, { params: { id: 5 }, body: { nombre: 'Otro' } }), r2, db)
  assert.equal(r2.status, 404)
})

test('DELETE /campaigns/:id: ajeno → 404 y no borra', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: false }] })
  const r = replyFake()
  await deleteCampaign(reqFake(ADMIN_T2, { params: { id: 5 }, query: {}, body: {} }), r, db)
  assert.equal(r.status, 404)
  assert.ok(db._campaigns.has(5), 'la campaña ajena sigue intacta')
})

// ── Inbox: paginación compatible ─────────────────────────────────────────

function leadsSeed(n, tenant) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, tenantId: tenant, telefono: `51900${i}`, vendorId: 10,
    nombreDetectado: null, productoDetectado: null,
    createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, i + 1),
  }))
}

test('GET /v2/leads sin params → array legacy (compat front actual)', async () => {
  const db = prismaFalso({}); db.lead.findMany = async () => []
  const r = replyFake()
  await listLeadsV2(reqFake(ADMIN_T1, { query: {} }), r, db)
  assert.ok(Array.isArray(r.payload), 'el front viejo sigue recibiendo array')
})

test('GET /v2/leads?limit&offset → página con hasMore', async () => {
  const db = prismaFalso({})
  db.lead.findMany = async ({ take, skip } = {}) => {
    const todos = leadsSeed(5, 't1').map(l => ({
      ...l, leadState: null, vendor: { nombre: 'V' }, mensajes: [],
    }))
    return todos.slice(skip || 0, (skip || 0) + take)
  }
  const r1 = replyFake()
  await listLeadsV2(reqFake(ADMIN_T1, { query: { limit: '2', offset: '0' } }), r1, db)
  assert.equal(r1.payload.items.length, 2)
  assert.equal(r1.payload.page.hasMore, true)
  assert.deepEqual(r1.payload.page, { limit: 2, offset: 0, hasMore: true })
  const r2 = replyFake()
  await listLeadsV2(reqFake(ADMIN_T1, { query: { limit: '2', offset: '4' } }), r2, db)
  assert.equal(r2.payload.items.length, 1)
  assert.equal(r2.payload.page.hasMore, false)
})

test('GET conversation: la ventana por defecto trae lo MÁS RECIENTE (no los más viejos)', async () => {
  const msgs = [1, 2, 3, 4, 5, 6].map(i => ({
    id: i, leadId: 9, origen: 'LEAD', texto: `m${i}`, createdAt: new Date(2026, 0, i),
    status: null, errorDetalle: null,
  }))
  const db = conLeads(prismaFalso({ messages: msgs }), [{ id: 9, tenantId: 't1' }])
  const r = replyFake()
  await conversationV2(reqFake(ADMIN_T1, { params: { id: 9 }, query: { limit: '3' } }), r, db)
  // Orden cronológico de salida, pero el CONTENIDO es la cola reciente.
  assert.deepEqual(r.payload.eventos.map(e => e.texto), ['m4', 'm5', 'm6'])
  assert.equal(r.payload.page.hayMas, true, 'y avisa que hay historial más atrás')
  assert.equal(r.payload.page.cursorAntesDe, new Date(2026, 0, 4).toISOString())
})

test('GET conversation: seguir el cursor trae el tramo ANTERIOR sin repetir', async () => {
  const msgs = [1, 2, 3, 4, 5, 6].map(i => ({
    id: i, leadId: 9, origen: 'LEAD', texto: `m${i}`, createdAt: new Date(2026, 0, i),
    status: null, errorDetalle: null,
  }))
  const db = conLeads(prismaFalso({ messages: msgs }), [{ id: 9, tenantId: 't1' }])
  const primera = replyFake()
  await conversationV2(reqFake(ADMIN_T1, { params: { id: 9 }, query: { limit: '3' } }), primera, db)
  const segunda = replyFake()
  await conversationV2(reqFake(ADMIN_T1, { params: { id: 9 }, query: { limit: '3', before: primera.payload.page.cursorAntesDe } }), segunda, db)
  assert.deepEqual(segunda.payload.eventos.map(e => e.texto), ['m1', 'm2', 'm3'])
  assert.equal(segunda.payload.page.hayMas, false, 'se llegó al inicio del historial')
  assert.equal(segunda.payload.page.cursorAntesDe, null)
})

test('GET conversation: sin ?limit devuelve todo (compat con el front actual)', async () => {
  const msgs = [1, 2, 3].map(i => ({
    id: i, leadId: 9, origen: 'LEAD', texto: `m${i}`, createdAt: new Date(2026, 0, i),
    status: null, errorDetalle: null,
  }))
  const db = conLeads(prismaFalso({ messages: msgs }), [{ id: 9, tenantId: 't1' }])
  const r = replyFake()
  await conversationV2(reqFake(ADMIN_T1, { params: { id: 9 }, query: {} }), r, db)
  assert.equal(r.payload.eventos.length, 3)
})

test('GET conversation: before inválido → 400; lead ajeno → 404', async () => {
  const msgs = [1].map(i => ({ id: i, leadId: 9, origen: 'LEAD', texto: `m${i}`, createdAt: new Date(2026, 0, i), status: null, errorDetalle: null }))
  const db = conLeads(prismaFalso({ messages: msgs }), [{ id: 9, tenantId: 't1' }])
  const r1 = replyFake()
  await conversationV2(reqFake(ADMIN_T1, { params: { id: 9 }, query: { before: 'no-fecha' } }), r1, db)
  assert.equal(r1.status, 400)
  const r2 = replyFake()
  await conversationV2(reqFake(ADMIN_T2, { params: { id: 9 }, query: {} }), r2, db)
  assert.equal(r2.status, 404)
})

// ── Preview seguro ─────────────────────────────────────────────────────

test('POST preview ficha: inválido informa sin escribir; válido no escribe', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 2, activa: true }] })
  const r1 = replyFake()
  await previewAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, factSheet: { precio: { textoExacto: 'promo increíble' } } } }), r1, db)
  assert.equal(r1.payload.ok, false)
  assert.ok(r1.payload.errores.length > 0)
  const r2 = replyFake()
  await previewAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO } }), r2, db)
  assert.equal(r2.payload.ok, true)
  assert.match(r2.payload.precioTexto, /S\/ 89/)
  assert.equal(db._campaigns.get(1).version, 2, 'el preview jamás escribe')
  const r3 = replyFake()
  await previewAgentConfigV2(reqFake(VENDOR_T1, { body: { campaignId: 1, factSheet: FICHA_V2_PRECIO } }), r3, db)
  assert.equal(r3.status, 403)
})

test('POST preview turno: humano vigente → no llega al modelo; auto con precio → sí; sin ficha → advierte', async () => {
  const hace2h = new Date(Date.now() - 2 * 3.6e6)
  const db = conLeads(prismaFalso({
    campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }],
    leadState: {
      1: { currentMode: 'HUMAN_ACTIVE', currentStage: 'presenting', modeEnteredAt: hace2h },
      2: { currentMode: 'AUTO_CONSULTIVO', currentStage: 'first_contact', modeEnteredAt: hace2h },
    },
  }), [
    { id: 1, tenantId: 't1', campaignId: 1 },
    { id: 2, tenantId: 't1', campaignId: 1 },
    { id: 3, tenantId: 't1', campaignId: 99 },
  ])
  const r1 = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 1 }, body: { texto: 'hola' } }), r1, db)
  assert.equal(r1.payload.llegariaAlModelo, false)
  assert.equal(r1.payload.motivo, 'humano_tiene_control')
  const r2 = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 2 }, body: { texto: 'precio?' } }), r2, db)
  assert.equal(r2.payload.llegariaAlModelo, true)
  assert.equal(r2.payload.fichaTienePrecio, true)
  const r3 = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 3 }, body: { texto: 'hola' } }), r3, db)
  assert.equal(r3.payload.llegariaAlModelo, true)
  assert.ok(r3.payload.advertencias.length > 0, 'avisa que hablará genérico')
  const r4 = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T2, { params: { id: 2 }, body: { texto: 'hola' } }), r4, db)
  assert.equal(r4.status, 404)
  const r5 = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 2 }, body: { texto: '  ' } }), r5, db)
  assert.equal(r5.status, 400)
})

test('POST preview turno: PAUSED nunca se reanuda (es terminal, aunque venza el auto-resume)', async () => {
  const hace99h = new Date(Date.now() - 99 * 3.6e6)
  const db = conLeads(prismaFalso({
    campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }],
    leadState: { 5: { currentMode: 'PAUSED', currentStage: 'cierre', modeEnteredAt: hace99h } },
  }), [{ id: 5, tenantId: 't1', campaignId: 1 }])
  const r = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 5 }, body: { texto: 'hola' } }), r, db)
  assert.equal(r.payload.llegariaAlModelo, false)
  assert.equal(r.payload.motivo, 'conversacion_pausada')
})

test('POST preview turno: humano ABANDONADO sí llega al modelo (mismo reloj que el pipeline)', async () => {
  // El caso que el review destapó: reportar "humano tiene control" cuando el bot
  // va a retomar por auto-resume hace que el operador saque conclusiones falsas.
  const hace99h = new Date(Date.now() - 99 * 3.6e6)
  const db = conLeads(prismaFalso({
    campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }],
    leadState: { 6: { currentMode: 'HUMAN_ACTIVE', currentStage: 'presenting', modeEnteredAt: hace99h } },
  }), [{ id: 6, tenantId: 't1', campaignId: 1 }])
  const r = replyFake()
  await previewTurnoV2(reqFake(ADMIN_T1, { params: { id: 6 }, body: { texto: 'sigue?' } }), r, db)
  assert.equal(r.payload.llegariaAlModelo, true, 'el bot retoma: no puede decir que no llega')
  assert.equal(r.payload.motivo, 'auto_resume_del_bot')
  assert.ok(r.payload.autoResumeHoras > 6, 'y dice cuántas horas lleva abandonado')
})

// ── Takeover invalida lo obsoleto ────────────────────────────────────────

test('invalidarTurnoEnVuelo sube la generación y cancela el buffer', () => {
  clearAllDebounces()
  const noop = () => {}
  enqueueMessage({ leadId: 50, text: 'hola', processFn: noop })
  const gen = getMessageGeneration(50)
  const r = invalidarTurnoEnVuelo(50)
  assert.equal(r.cancelled, true, 'había buffer pendiente y se canceló')
  assert.ok(getMessageGeneration(50) > gen, 'el pipeline en vuelo verá generación mayor → descarta')
  clearAllDebounces()
})

test('setMode (takeover del CRM) invalida el turno en vuelo', async () => {
  clearAllDebounces()
  const db = conLeads(prismaFalso({}), [{ id: 60, tenantId: 't1' }])
  const r = replyFake()
  await setModeV2(reqFake(ADMIN_T1, { params: { id: 60 }, body: { mode: 'HUMAN_ACTIVE' } }), r, db)
  assert.equal(r.status, 200)
  // El invariante es "> 0" (subió la generación), no un valor absoluto: el mapa es
  // global al proceso y un número fijo dependería del orden de ejecución.
  assert.ok(getMessageGeneration(60) > 0, 'el modo humano descarta respuestas generadas antes')
  clearAllDebounces()
})

test('assign: escribe con predicado id+tenant; si no matchea, 404 (no "ok" fantasma)', async () => {
  const lead = { id: 70, tenantId: 't1', vendorId: 10 }
  const db = conLeads(prismaFalso({ vendors: [{ id: 11, tenantId: 't1', activo: true, nombre: 'Juan' }] }), [lead])
  const r = replyFake()
  await assignV2(reqFake(ADMIN_T1, { params: { id: 70 }, body: { vendorId: 11 } }), r, db)
  assert.equal(r.status, 200)
  assert.equal(lead.vendorId, 11, 'la escritura se aplicó sobre el lead del tenant')

  // Mismo handler, pero el updateMany no encuentra la fila (borrado concurrente):
  // debe ser 404, no un 200 que el CRM leería como "reasignado".
  const db2 = conLeads(prismaFalso({ vendors: [{ id: 11, tenantId: 't1', activo: true, nombre: 'Juan' }] }), [lead])
  db2.lead.updateMany = async () => ({ count: 0 })
  const r2 = replyFake()
  await assignV2(reqFake(ADMIN_T1, { params: { id: 70 }, body: { vendorId: 11 } }), r2, db2)
  assert.equal(r2.status, 404)
})

test('assign: destino de otro tenant → 400 y la fila NO cambia', async () => {
  const lead = { id: 70, tenantId: 't1', vendorId: 10 }
  const db = conLeads(prismaFalso({ vendors: [{ id: 99, tenantId: 't2', activo: true, nombre: 'Otro' }] }), [lead])
  const r = replyFake()
  await assignV2(reqFake(ADMIN_T1, { params: { id: 70 }, body: { vendorId: 99 } }), r, db)
  assert.equal(r.status, 400)
  assert.equal(lead.vendorId, 10, 'nadie se quedó con el lead')
})

test('assign: VENDOR no puede reasignar → 403', async () => {
  const db = conLeads(prismaFalso({ vendors: [{ id: 11, tenantId: 't1', activo: true, nombre: 'Juan' }] }), [
    { id: 70, tenantId: 't1', vendorId: 11 },
  ])
  const r = replyFake()
  await assignV2(reqFake(VENDOR_T1, { params: { id: 70 }, body: { vendorId: 11 } }), r, db)
  assert.equal(r.status, 403)
})

// ── Envío de PAGADO: la reapertura no se puede cobrar dos veces ──────────
// La ruta completa de reabrirV2 termina en una llamada de red a Meta; doblarla
// exigiría interceptar fetch en este archivo. Se prueban las dos piezas que sí son
// comprobables sin red: el comportamiento del candado, y el ORDEN en el handler
// (marcar antes de enviar es lo que impide el doble cobro).

test('candado de reapertura: la segunda marca dentro de la ventana se rechaza', () => {
  const clave = 'reabrir:test:1234'
  assert.equal(checkAndMark(clave), true, 'primer intento: se permite enviar')
  assert.equal(checkAndMark(clave), false, 'segundo intento en <5min: no se cobra otra vez')
})

test('candado de reapertura: es POR lead (otro lead sí puede reabrir)', () => {
  assert.equal(checkAndMark('reabrir:test:1001'), true)
  assert.equal(checkAndMark('reabrir:test:1002'), true, 'no es un candado global')
})

test('reabrirV2: marca el candado ANTES de enviar (si no, el doble clic cobra dos veces)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', 'inbox-actions.js'), 'utf8')
  const ini = src.indexOf('export async function reabrirV2')
  assert.ok(ini > 0, 'no se encuentra reabrirV2')
  const cuerpo = src.slice(ini, src.indexOf('\nexport ', ini + 10))
  const marca = cuerpo.indexOf('checkAndMark')
  const envio = cuerpo.indexOf('enviarPlantilla')
  assert.ok(marca > 0 && envio > 0, 'deben existir el candado y el envío')
  assert.ok(marca < envio, 'el candado va ANTES del envío: es lo que evita el doble cobro')
})

test('reabrirV2: sin plantilla aprobada devuelve 409 sin tocar nada', async () => {
  const previa = process.env.CLOUD_TEMPLATE_REAPERTURA
  delete process.env.CLOUD_TEMPLATE_REAPERTURA
  try {
    const db = conLeads(prismaFalso({}), [{ id: 90, tenantId: 't1' }])
    const r = replyFake()
    await reabrirV2(reqFake(ADMIN_T1, { params: { id: 90 }, body: {} }), r, db, {defaultChannelForTenant:async()=>({tenantId:'t1',provider:'cloud',externalKey:'test-phone'})})
    assert.equal(r.status, 409)
    assert.match(r.payload.error, /plantilla/)
  } finally {
    if (previa !== undefined) process.env.CLOUD_TEMPLATE_REAPERTURA = previa
  }
})

test('saveInboundMedia: hereda el tenant del lead; sin lead → se rechaza', async () => {
  const db = prismaFalso({})
  db.lead.findUnique = async ({ where }) => (where.id === 5 ? { tenantId: 't1' } : null)
  const ok = await saveInboundMedia(db, { leadId: 5, tipo: 'image', mimeType: 'image/jpeg', base64: 'AAAA' })
  assert.equal(ok.ok, true)
  assert.equal(db._mediaRows[0].tenantId, 't1', 'la media queda con dueño aunque el llamador no lo traiga')
  const sinLead = await saveInboundMedia(db, { tipo: 'image', mimeType: 'image/jpeg', base64: 'AAAA' })
  assert.equal(sinLead.ok, false)
  const huerfana = await saveInboundMedia(db, { leadId: 999, tipo: 'image', mimeType: 'image/jpeg', base64: 'AAAA' })
  assert.equal(huerfana.ok, false, 'lead inexistente → sin dueño → se rechaza, no se guarda huérfana')
})

// ── Validación de entrada (steps + prototype pollution) ──────────────────

test('validarSteps: acepta guion válido; rechaza tipo/mensaje/tope', () => {
  const ok = validarSteps([{ tipo: 'MSG', mensaje: 'Hola' }, { tipo: 'followup', mensaje: '¿Todo bien?', followupHrs: 24 }])
  assert.equal(ok.ok, true)
  assert.equal(ok.valores[1].tipo, 'FOLLOWUP', 'el tipo se normaliza a mayúsculas')
  assert.equal(ok.valores[1].followupHrs, 24)
  assert.match(validarSteps([{ tipo: 'SQL', mensaje: 'x' }]).errores.join('|'), /tipo/)
  assert.match(validarSteps([{ tipo: 'MSG', mensaje: '  ' }]).errores.join('|'), /mensaje/)
  assert.match(validarSteps([{ tipo: 'MSG', mensaje: 'x', followupHrs: -5 }]).errores.join('|'), /followupHrs/)
  assert.equal(validarSteps(Array.from({ length: 51 }, () => ({ tipo: 'MSG', mensaje: 'x' }))).ok, false)
  assert.equal(validarSteps('nope').ok, false)
})

test('buscarClavePeligrosa: encuentra __proto__/constructor en cualquier nivel; null si es limpio', () => {
  assert.equal(buscarClavePeligrosa({ agente: { nombre: 'x' } }), null)
  assert.equal(buscarClavePeligrosa(JSON.parse('{"__proto__":{"admin":true}}')), '__proto__')
  assert.match(buscarClavePeligrosa({ factSheet: { incluye: [{ constructor: 1 }] } }), /constructor/)
  assert.match(buscarClavePeligrosa({ a: { b: { c: JSON.parse('{"__proto__":{}}') } } }), /__proto__/)
  assert.equal(buscarClavePeligrosa(null), null)
  assert.equal(buscarClavePeligrosa('texto'), null)
})

test('la ficha del CRM con clave de prototipo se RECHAZA (no se guarda a medias)', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }] })
  const r = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T1, {
    body: { campaignId: 1, agente: JSON.parse('{"nombre":"x","__proto__":{"admin":true}}'), version: 1 },
  }), r, db)
  assert.equal(r.status, 400)
  assert.match(r.payload.error, /no permitida/)
  assert.equal(db._campaigns.get(1).version, 1, 'nada se escribió')
  assert.equal({}.admin, undefined, 'Object.prototype intacto')
})

test('alta con config de prototipo → 400 (borrador y activa)', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r1 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'X', borrador: true, config: JSON.parse('{"__proto__":{"x":1}}') } }), r1, db)
  assert.equal(r1.status, 400)
  const r2 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'X', config: JSON.parse('{"constructor":1}'), triggers: ['a1'] } }), r2, db)
  assert.equal(r2.status, 400)
})

test('alta con steps inválidos → 400 en ambos modos', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r1 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'X', borrador: true, steps: [{ tipo: 'MSG' }] } }), r1, db)
  assert.equal(r1.status, 400)
  const r2 = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Y', config: FICHA_V1, triggers: ['a2'], steps: [{ tipo: 'NOPE', mensaje: 'x' }] } }), r2, db)
  assert.equal(r2.status, 400)
})

test('alta con steps válidos los persiste normalizados', async () => {
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, {
    body: { nombre: 'Con guion', borrador: true, steps: [{ tipo: 'msg', mensaje: 'Hola', followupHrs: 2 }] },
  }), r, db)
  assert.equal(r.status, 201)
  const creada = [...db._campaigns.values()].find(c => c.slug.includes('CON'))
  assert.equal(creada.steps[0].tipo, 'MSG')
  assert.equal(creada.steps[0].followupHrs, 2)
})

test('legacy PUT /campaigns y saveSteps también rechazan config y steps peligrosos', async () => {
  const db = prismaFalso({ campaigns: [{ id: 5, tenantId: 't1', nombre: 'P', config: FICHA_V1, version: 1, activa: true }] })
  const r1 = replyFake()
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 5 }, body: { config: JSON.parse('{"__proto__":{"x":1}}'), version: 1 } }), r1, db)
  assert.equal(r1.status, 400)
  const r2 = replyFake()
  await saveSteps(reqFake(ADMIN_T1, { params: { id: 5 }, body: { steps: [{ tipo: 'MSG', mensaje: '' }] } }), r2, db)
  assert.equal(r2.status, 400)
  assert.ok(Array.isArray(r2.payload.detalles) && r2.payload.detalles.length > 0,
    'el front recibe el detalle del problema')
})

// ── Rutas nuevas protegidas ──────────────────────────────────────────────

test('las rutas CRM nuevas están registradas y las comerciales exigen ADMIN', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'), 'utf8')

  // Se parsean los REGISTROS (no se busca un substring: un substring también
  // "pasa" si la ruta aparece dentro de un comentario, y no detectaría que alguien
  // la moviera a /v2/ sin protección).
  const rx = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*(,\s*\{[^}]*\})?/g
  const rutas = new Map()
  let m
  while ((m = rx.exec(src)) !== null) rutas.set(`${m[1].toUpperCase()} ${m[2]}`, m[3] || '')

  const requeridas = [
    "POST /v2/campaigns", "GET /v2/campaigns/:id", "GET /v2/campaigns",
    "GET /v2/agent-config", "PUT /v2/agent-config", "POST /v2/agent-config/preview",
    "POST /v2/leads/:id/preview", "POST /v2/flow/copilot",
    "POST /v2/leads/:id/reply", "POST /v2/leads/:id/reabrir", "POST /v2/leads/:id/mode",
    "GET /v2/leads", "GET /v2/leads/:id/conversation", "GET /v2/leads/:id/media/:mediaId",
  ]
  for (const r of requeridas) {
    assert.ok(rutas.has(r), `no registrada: ${r}`)
    assert.match(rutas.get(r), /verifyJwt/, `${r} sin verifyJwt`)
  }

  // Lectura Y escritura de lo comercial exigen rol (precios + guion del bot).
  for (const r of [
    "POST /v2/campaigns", "GET /v2/campaigns/:id",
    "PUT /v2/agent-config", "POST /v2/agent-config/preview", "POST /v2/flow/copilot",
  ]) {
    assert.match(rutas.get(r), /requireAdmin/, `${r} debe exigir rol ADMIN/SUPERVISOR en la ruta`)
  }

  // El preview del turno es de lectura de estado: cualquier vendedor del scope va bien.
  assert.doesNotMatch(rutas.get("POST /v2/leads/:id/preview"), /requireAdmin/)
})

// Regresiones del handoff frente al baseline validado 76616fe.
test('activar mantiene campañas de otros vendedores y otros tenants encendidas', async () => {
  const db = prismaFalso({ campaigns: [
    { id: 1, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: false, triggers: [{ id: 1 }] },
    { id: 2, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: true, triggers: [{ id: 2 }] },
    { id: 3, tenantId: 't1', vendorId: 11, version: 1, config: FICHA_V1, activa: true, triggers: [{ id: 3 }] },
    { id: 4, tenantId: 't2', vendorId: 20, version: 1, config: FICHA_V1, activa: true, triggers: [{ id: 4 }] },
  ] })
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 1 } }), replyFake(), db)
  assert.equal(db._campaigns.get(1).activa, true)
  assert.equal(db._campaigns.get(2).activa, false)
  assert.equal(db._campaigns.get(3).activa, true)
  assert.equal(db._campaigns.get(4).activa, true)
})

test('activar revierte el apagado si la ficha cambia entre gate y escritura', async () => {
  const db = prismaFalso({ campaigns: [
    { id: 1, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: false, triggers: [{ id: 1 }] },
    { id: 2, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: true },
  ] })
  const transaction = db.$transaction
  db.$transaction = async ops => { db._campaigns.get(1).version++; return transaction(ops) }
  const r = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 1 } }), r, db)
  assert.equal(r.status, 409)
  assert.equal(db._campaigns.get(1).activa, false)
  assert.equal(db._campaigns.get(2).activa, true)
})

test('default con descubrimiento se crea y activa sin trigger', async () => {
  const config = { ...FICHA_V1, atribucion: { esCampanaDefault: true, mensajeDescubrimiento: '¿Qué producto te interesa?' } }
  const db = prismaFalso({ vendors: [{ id: 10, tenantId: 't1' }] })
  const r = replyFake()
  await createCampaignV2(reqFake(ADMIN_T1, { body: { nombre: 'Default', config } }), r, db)
  assert.equal(r.status, 201)
  const paused = db._campaigns.get(r.payload.id); paused.activa = false
  const activation = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: paused.id } }), activation, db)
  assert.equal(activation.status, 200)
  assert.equal(paused.activa, true)
  const legacy = replyFake()
  await createCampaign(reqFake(ADMIN_T1, { body: { slug: 'DEFAULT2', nombre: 'Default2', vendorId: 10, config } }), legacy, db)
  assert.equal(legacy.status, 201)
})

test('una activa no pierde factSheet ni config, incluso con force', async () => {
  for (const config of [{ factSheet: null }, null]) {
    const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
    const r = replyFake()
    await updateCampaign(reqFake(ADMIN_T1, { params: { id: 1 }, body: { config, version: 1, force: true } }), r, db)
    assert.ok([400, 409].includes(r.status))
    assert.deepEqual(db._campaigns.get(1).config, FICHA_V1)
    assert.equal(db._campaigns.get(1).activa, true)
  }
})

test('borrar config exige confirmación y pausa en la misma escritura', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
  const no = replyFake()
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 1 }, body: { config: null, version: 1, activa: false } }), no, db)
  assert.equal(no.status, 409)
  assert.equal(no.payload.codigo, 'BORRADO_REQUIERE_CONFIRMACION')
  await updateCampaign(reqFake(ADMIN_T1, { params: { id: 1 }, body: { config: null, version: 1, activa: false, force: true } }), replyFake(), db)
  assert.equal(db._campaigns.get(1).config, null)
  assert.equal(db._campaigns.get(1).activa, false)
})

test('preview y save comparten borrado explícito y contrato resultante', async () => {
  for (const body of [
    { factSheet: null }, { factSheet: null, force: true },
    { factSheet: { precio: null } }, { factSheet: { precio: null }, force: true },
    { factSheet: { precio: { textoExacto: 'S/ 99' } } },
  ]) {
    const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
    const p = replyFake(), w = replyFake()
    await previewAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, ...body } }), p, db)
    await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, version: 1, ...body } }), w, db)
    assert.equal(p.payload.ok, w.status === 200, JSON.stringify(body))
  }
})

test('IDs vacíos/cero/inválidos no escriben la primera campaña activa', async () => {
  for (const campaignId of [0, null, '', false, -1, 'nope', 1.5, 2147483648]) {
    const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
    const r = replyFake()
    await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId, version: 1, agente: { nombre: 'WrongID' } } }), r, db)
    assert.equal(r.status, 400, String(campaignId))
    assert.equal(db._campaigns.get(1).version, 1)
  }
})

test('ficha con monto parcial o imagen ajena se rechaza antes de guardar', async () => {
  for (const factSheet of [
    { precio: { textoExacto: 'S/ 199', monto: 99 } },
    { imagenes: { precios: { archivo: 't2/precios.png' } } },
  ]) {
    const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
    const r = replyFake()
    await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, version: 1, factSheet } }), r, db)
    assert.equal(r.status, 400)
    assert.equal(db._campaigns.get(1).version, 1)
  }
})

test('parche parcial de precio conserva monto y moneda en escritura', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', config: FICHA_V1, version: 1, activa: true }] })
  const r = replyFake()
  await saveAgentConfigV2(reqFake(ADMIN_T1, { body: { campaignId: 1, version: 1, factSheet: { precio: { textoExacto: 'S/ 99' } } } }), r, db)
  assert.equal(r.status, 200)
  assert.equal(db._campaigns.get(1).config.factSheet.precio.monto, 99)
  assert.equal(db._campaigns.get(1).config.factSheet.precio.moneda, 'S/')
})

test('test-trigger coincide con la normalización de escritura para pack-3', async () => {
  const db = prismaFalso({ campaigns: [{ id: 1, tenantId: 't1', triggers: [{ texto: 'pack3' }] }] })
  const out = await testTrigger(reqFake(ADMIN_T1, { body: { campaignId: 1, mensaje: 'Quiero Páck-3' } }), replyFake(), db)
  assert.equal(out.match, true)
})

test('campañas sin tenant autenticado fallan antes de consultar', async () => {
  const db = { campaign: { findFirst: () => assert.fail('No consultar sin tenant') } }
  await assert.rejects(() => updateCampaign(reqFake({ role: 'ADMIN' }, { params: { id: 1 }, body: { nombre: 'x' } }), replyFake(), db), e => e.statusCode === 403)
  const r = replyFake()
  await getCampaignV2(reqFake({ role: 'ADMIN' }, { params: { id: 1 } }), r, db)
  assert.equal(r.status, 403)
})

test('activar revierte el apagado si el vendedor cambia durante la activación', async () => {
  const db = prismaFalso({ campaigns: [
    { id: 1, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: false, triggers: [{ id: 1 }] },
    { id: 2, tenantId: 't1', vendorId: 10, version: 1, config: FICHA_V1, activa: true },
  ] })
  const transaction = db.$transaction
  db.$transaction = async ops => { db._campaigns.get(1).vendorId = 11; return transaction(ops) }
  const r = replyFake()
  await activarCampaign(reqFake(ADMIN_T1, { params: { id: 1 } }), r, db)
  assert.equal(r.status, 409)
  assert.equal(db._campaigns.get(1).activa, false)
  assert.equal(db._campaigns.get(2).activa, true)
})
