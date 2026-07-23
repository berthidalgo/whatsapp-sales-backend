import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

console.log('▶ Creando tabla channels (idempotente)...')
await c.query(`
CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenant_settings(tenant_id) ON DELETE CASCADE,
  provider       TEXT NOT NULL DEFAULT 'evolution',
  external_key   TEXT NOT NULL UNIQUE,
  numero_display TEXT,
  credenciales   JSONB,
  activo         BOOLEAN NOT NULL DEFAULT true,
  es_default     BOOLEAN NOT NULL DEFAULT false,
  notas          TEXT,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)
await c.query(`CREATE INDEX IF NOT EXISTS channels_tenant_id_idx ON channels(tenant_id)`)
await c.query(`CREATE INDEX IF NOT EXISTS channels_provider_activo_idx ON channels(provider, activo)`)
console.log('  ✓ tabla + índices')

// Sembrar desde la verdad que YA existe: vendors.instanciaEvolution
console.log('\n▶ Sembrando canales desde vendors.instanciaEvolution...')
const { rows: vendors } = await c.query(`
  SELECT DISTINCT ON ("instanciaEvolution")
         "instanciaEvolution" AS instancia, tenant_id, "whatsappNumber" AS numero, nombre, role
  FROM vendors
  WHERE activo = true AND "instanciaEvolution" IS NOT NULL AND "instanciaEvolution" <> ''
  ORDER BY "instanciaEvolution", CASE WHEN role='ADMIN' THEN 0 ELSE 1 END, id`)

for (const v of vendors) {
  const esDefault = v.role === 'ADMIN'
  const r = await c.query(`
    INSERT INTO channels (id, tenant_id, provider, external_key, numero_display, activo, es_default, notas)
    VALUES (gen_random_uuid()::text, $1, 'evolution', $2, $3, true, $4, $5)
    ON CONFLICT (external_key) DO NOTHING
    RETURNING id`,
    [v.tenant_id, v.instancia, v.numero, esDefault,
     `Sembrado jul 2026 desde vendors.instanciaEvolution (${v.nombre}/${v.role})`])
  console.log(`  ${r.rowCount ? '✓ creado ' : '· ya existía '} ${v.instancia.padEnd(24)} → ${v.tenant_id}${esDefault ? ' [default]' : ''}`)
}

console.log('\n▶ Estado final de channels:')
const { rows } = await c.query(`
  SELECT c.tenant_id, c.external_key, c.provider, c.numero_display, c.es_default, c.activo, t.display_name
  FROM channels c JOIN tenant_settings t ON t.tenant_id = c.tenant_id
  ORDER BY c.tenant_id, c.es_default DESC`)
console.table(rows)
await c.end()
