// scripts/archivar-y-limpiar-lead.js — Hidata v20 · Sprint A
//
// ARCHIVAR ANTES DE BORRAR ("Reset != Borrar", MASTER-PLAN Anexo C §6.2).
//
// El guion de pruebas exige limpiar el lead de prueba entre sesiones, pero un
// DELETE a secas destruye la conversación — y esa data es la materia prima del
// training_dataset futuro (Anexo C §6.4). Este script primero ARCHIVA la
// conversación completa del lead en `conversaciones_archivadas` (mensajes,
// slots, stage final, turn_traces si hay) y recién después borra el lead y sus
// tablas hijas, dentro de UNA transacción: o se archiva Y borra todo, o nada.
//
// Uso (DATABASE_URL en el entorno, p.ej. desde .env.claude):
//   node scripts/archivar-y-limpiar-lead.js <telefono> [motivo]
//   node scripts/archivar-y-limpiar-lead.js 51938188585 limpieza_test_sesion_1
//
// SOLO toca leads cuyo teléfono contenga el argumento — los demás leads no se
// tocan jamás. Pensado para el número de prueba; sirve para cualquier lead.

import pg from 'pg'

const TELEFONO = process.argv[2]
const MOTIVO = process.argv[3] || 'limpieza_manual'
const NUMERO_TEST = '51938188585' // número personal de Joan (tabla test_phones, Anexo C §6.6)

if (!TELEFONO) {
  console.error('Uso: node scripts/archivar-y-limpiar-lead.js <telefono> [motivo]')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en el entorno')
  process.exit(1)
}

const TABLAS_HIJAS = [
  'turn_trace', 'messages', 'commitments', 'followup_queue',
  'crm_notifications', 'call_events', 'conversations', 'lead_state'
]

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// Detecta el nombre real de la columna FK de cada tabla (BD con columnas
// mixtas camelCase/snake_case — principio del MASTER-PLAN).
async function columnaLead(tabla) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND column_name IN ('leadId', 'lead_id') LIMIT 1`,
    [tabla]
  )
  return r.rows[0]?.column_name || null
}

async function main() {
  await client.connect()

  const leads = await client.query(
    `SELECT id, telefono, "nombreDetectado", "campaignId"
     FROM leads WHERE telefono LIKE '%' || $1 || '%'`,
    [TELEFONO]
  )

  if (!leads.rows.length) {
    console.log(`Sin leads para "${TELEFONO}" — nada que archivar ni limpiar.`)
    return
  }

  for (const lead of leads.rows) {
    await client.query('BEGIN')
    try {
      const state = (await client.query(
        'SELECT current_stage, current_mode, slots_filled FROM lead_state WHERE lead_id = $1',
        [lead.id]
      )).rows[0] || {}

      const colMsg = await columnaLead('messages')
      const mensajes = colMsg
        ? (await client.query(
            `SELECT origen, texto, "createdAt" FROM messages WHERE "${colMsg}" = $1 ORDER BY "createdAt"`,
            [lead.id]
          )).rows
        : []

      const colTrace = await columnaLead('turn_trace')
      const traces = colTrace
        ? (await client.query(
            `SELECT row_to_json(t) AS fila FROM turn_trace t WHERE "${colTrace}" = $1`,
            [lead.id]
          )).rows.map(r => r.fila)
        : []

      await client.query(
        `INSERT INTO conversaciones_archivadas
           (lead_id_original, telefono, es_test, nombre_detectado, campaign_id,
            stage_final, mode_final, slots, mensajes, turn_traces, motivo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          lead.id, lead.telefono, lead.telefono.includes(NUMERO_TEST),
          lead.nombreDetectado, lead.campaignId,
          state.current_stage || null, state.current_mode || null,
          JSON.stringify(state.slots_filled || {}),
          JSON.stringify(mensajes), JSON.stringify(traces), MOTIVO
        ]
      )

      let borradas = 0
      for (const tabla of TABLAS_HIJAS) {
        const col = await columnaLead(tabla)
        if (!col) continue
        const r = await client.query(`DELETE FROM ${tabla} WHERE "${col}" = $1`, [lead.id])
        borradas += r.rowCount
      }
      await client.query('DELETE FROM leads WHERE id = $1', [lead.id])

      await client.query('COMMIT')
      console.log(
        `Lead ${lead.id} (${lead.telefono}) → ARCHIVADO ` +
        `(${mensajes.length} mensajes, ${traces.length} traces, motivo: ${MOTIVO}) ` +
        `y limpiado (${borradas} filas hijas + lead).`
      )
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`Lead ${lead.id}: ROLLBACK — no se archivó ni se borró nada:`, err.message)
      process.exitCode = 1
    }
  }

  const v = await client.query(
    `SELECT (SELECT COUNT(*) FROM leads WHERE telefono LIKE '%' || $1 || '%') AS quedan,
            (SELECT COUNT(*) FROM conversaciones_archivadas) AS archivadas_total`,
    [TELEFONO]
  )
  console.log(`Verificación → leads restantes con ese número: ${v.rows[0].quedan} | conversaciones archivadas (histórico): ${v.rows[0].archivadas_total}`)
}

main()
  .catch(err => { console.error('ERROR:', err.message); process.exit(1) })
  .finally(() => client.end())
