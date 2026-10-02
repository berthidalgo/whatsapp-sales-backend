// Pure schema contract + public PostgreSQL catalog checks. Never loads .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export class ReadinessError extends Error {}

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_PATH = path.join(API_ROOT, 'prisma', 'schema.prisma');
export const SQL_PATH = path.join(API_ROOT, 'prisma', 'sql', '20261002_crm_schema.sql');
// Versión del contrato de esquema. Cambia cuando cambian las tablas/columnas/índices y se
// bumpea junto con el nombre del archivo SQL+JSON. `/ready` lo publica: un despliegue con
// un contrato distinto al que espera su código se ve antes de atender tráfico.
export const CONTRACT_VERSION = '20261002';
const CONTRACT_PATH = path.join(API_ROOT, 'prisma', 'sql', '20261002_crm_contract.json');
export const hash = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const tableSql = name => 'public.' + quote(name);
const list = value => [...value.matchAll(/"([^"]+)"/g)].map(m => m[1]);
const namePattern = '(?:public\\.|"public"\\.)?"([^";]+)"';

export function qualifySql(sql) {
  return sql.replace(/(CREATE TABLE|ALTER TABLE|REFERENCES|\bON) "(?!public")([^";]+)"/g, (_match, action, name) => action + ' public.' + quote(name));
}

export function parseSchemaSql(sql, schemaSource = '') {
  const statements = sql.replace(/^--.*$/gm, '').split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  const tables = [];
  const indexes = [];
  const foreignKeys = [];
  for (const statement of statements) {
    const table = statement.match(new RegExp('^CREATE TABLE ' + namePattern + ' \\(([\\s\\S]*)\\)$'));
    if (table) {
      const columns = [];
      const primary = [];
      for (const raw of table[2].split(/\r?\n/)) {
        const line = raw.trim().replace(/,$/, '');
        const pk = line.match(/^CONSTRAINT "([^"]+)" PRIMARY KEY \((.*)\)$/);
        if (pk) { primary.push({ name: pk[1], columns: list(pk[2]) }); continue; }
        const col = line.match(/^"([^"]+)" (.+)$/);
        if (!col) continue;
        const declaration = col[2];
        const type = declaration.split(/ NOT NULL| DEFAULT /)[0];
        const defaultValue = declaration.match(/ DEFAULT ([\s\S]+)$/)?.[1] ?? null;
        columns.push({ name: col[1], type, nullable: !declaration.includes(' NOT NULL'), default: type === 'SERIAL' ? '__serial__' : defaultValue, declaration,
          forbidDefault: ['tenant_id', 'tenantId'].includes(col[1]) && defaultValue === null,
          allowSetNotNull: table[1] === 'messages' && col[1] === 'createdAt' });
      }
      tables.push({ name: table[1], columns, primary, sql: statement + ';' });
      continue;
    }
    const index = statement.match(new RegExp('^CREATE (UNIQUE )?INDEX "([^"]+)" ON ' + namePattern + '\\((.*)\\)$'));
    if (index) { indexes.push({ name: index[2], table: index[3], unique: !!index[1], columns: list(index[4]), sql: statement + ';' }); continue; }
    const fk = statement.match(new RegExp('^ALTER TABLE ' + namePattern + ' ADD CONSTRAINT "([^"]+)" FOREIGN KEY \\((.*?)\\) REFERENCES ' + namePattern + '\\((.*?)\\) ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION) ON UPDATE (CASCADE|SET NULL|RESTRICT|NO ACTION)$'));
    if (fk) foreignKeys.push({ table: fk[1], name: fk[2], columns: list(fk[3]), target: fk[4], targetColumns: list(fk[5]), onDelete: fk[6], onUpdate: fk[7], sql: statement + ';' });
  }
  if (!tables.length) throw new ReadinessError('Contrato SQL vacío: no se reconoció ningún modelo');
  const recognized = tables.length + indexes.length + foreignKeys.length;
  if (recognized !== statements.length) throw new ReadinessError('Contrato SQL contiene sentencias no reconocidas');
  return { version: CONTRACT_VERSION, schemaHash: hash(schemaSource), sqlHash: hash(sql), tables, indexes, foreignKeys };
}

export function loadContract() {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  if (contract.schemaHash !== hash(fs.readFileSync(SCHEMA_PATH, 'utf8')) || contract.sqlHash !== hash(fs.readFileSync(SQL_PATH, 'utf8'))) {
    throw new ReadinessError('Contrato DB desactualizado: ejecutar generar-contrato-db.js --actualizar');
  }
  return contract;
}

export function selectProfile(contract, profile = 'full') {
  if (profile === 'full') return contract;
  const names = profile === 'receipts' ? ['messages', 'pending_cloud_receipts'] : profile === 'channel-mode' ? ['channels'] : null;
  if (!names) throw new ReadinessError('Perfil DB desconocido');
  return { ...contract, tables: contract.tables.filter(t => names.includes(t.name)), indexes: contract.indexes.filter(i => names.includes(i.table)), foreignKeys: contract.foreignKeys.filter(f => names.includes(f.table)) };
}

export function normalizeType(type) {
  const normalized = type.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized === 'serial') return 'integer';
  if (/^timestamp\(\d+\)$/.test(normalized)) return normalized.replace('(6)', '') + ' without time zone';
  if (normalized.startsWith('decimal(')) return normalized.replace('decimal(', 'numeric(');
  if (/^timestamptz\(\d+\)$/.test(normalized)) return normalized.replace(/^timestamptz\((\d+)\)$/, (_match, precision) => 'timestamp' + (precision === '6' ? '' : '(' + precision + ')') + ' with time zone');
  if (/^timestamp\(6\)/.test(normalized)) return normalized.replace('(6)', '');
  return normalized;
}

function canonicalDefault(value) {
  if (value === null || value === undefined) return null;
  let v = value.replace(/::[a-zA-Z_][a-zA-Z0-9_ ]*(?:\[\])?/g, '').replace(/\s+/g, '');
  if (!v.startsWith("'")) v = v.toLowerCase();
  if (v === 'current_timestamp' || v === 'now()') return '__now__';
  if (v === 'array[]' || v === "'{}'") return '__empty__';
  if (/^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
  return v;
}
const sameColumns = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ruleCode = { CASCADE: 'c', 'SET NULL': 'n', RESTRICT: 'r', 'NO ACTION': 'a' };

export function compareCatalog(contract, catalog) {
  const issues = [];
  const add = (kind, table, name, message) => issues.push({ kind, table, name, message });
  for (const table of contract.tables) {
    if (!catalog.tables.includes(table.name)) { add('missing_table', table.name, table.name, 'falta tabla public.' + table.name); continue; }
    for (const col of table.columns) {
      const actual = catalog.columns.find(c => c.table === table.name && c.name === col.name);
      if (!actual) { add('missing_column', table.name, col.name, 'falta columna ' + table.name + '.' + col.name); continue; }
      if (normalizeType(actual.type) !== normalizeType(col.type)) add('column_type', table.name, col.name, 'tipo incompatible ' + table.name + '.' + col.name);
      if (actual.nullable !== col.nullable && !(col.type.endsWith('[]') && !actual.nullable)) {
        add(col.allowSetNotNull && actual.nullable && !col.nullable ? 'missing_not_null' : 'column_nullable', table.name, col.name, 'nulabilidad incompatible ' + table.name + '.' + col.name);
      }
      if (col.default === '__serial__') {
        if (!/^nextval\(/.test(actual.default || '')) add('column_default', table.name, col.name, 'falta secuencia de ' + table.name + '.' + col.name);
      } else if (col.default !== null && canonicalDefault(actual.default) !== canonicalDefault(col.default)) {
        add('column_default', table.name, col.name, 'default incompatible ' + table.name + '.' + col.name);
      }
      if (col.forbidDefault && actual.default !== null) add('tenant_default', table.name, col.name, 'tenant con default implícito en ' + table.name + '.' + col.name);
    }
    for (const pk of table.primary) {
      const actual = catalog.constraints.find(c => c.table === table.name && c.name === pk.name) || catalog.constraints.find(c => c.table === table.name && c.type === 'p');
      const index = catalog.indexes.find(i => i.table === table.name && i.name === actual?.name);
      if (!actual) add('missing_primary', table.name, pk.name, 'falta primary key de ' + table.name);
      else if (actual.type !== 'p' || !sameColumns(actual.columns, pk.columns) || !actual.valid || !index?.valid || !index?.unique) add('primary_definition', table.name, pk.name, 'primary key incompatible de ' + table.name);
    }
  }
  for (const index of contract.indexes) {
    if (!catalog.tables.includes(index.table)) continue;
    const actual = catalog.indexes.find(i => i.table === index.table && i.name === index.name);
    if (!actual) add('missing_index', index.table, index.name, 'falta índice ' + index.name);
    else if (!actual.valid || actual.unique !== index.unique || actual.method !== 'btree' || actual.nullsNotDistinct === true || actual.predicate !== null || !sameColumns(actual.columns, index.columns)) add('index_definition', index.table, index.name, 'índice incompatible ' + index.name);
  }
  for (const fk of contract.foreignKeys) {
    if (!catalog.tables.includes(fk.table)) continue;
    const actual = catalog.constraints.find(c => c.table === fk.table && c.name === fk.name);
    if (!actual) add('missing_foreign_key', fk.table, fk.name, 'falta foreign key ' + fk.name);
    else if (actual.type !== 'f' || !actual.valid || actual.targetSchema !== 'public' || actual.target !== fk.target || !sameColumns(actual.columns, fk.columns) || !sameColumns(actual.targetColumns, fk.targetColumns) || actual.onDelete !== ruleCode[fk.onDelete] || actual.onUpdate !== ruleCode[fk.onUpdate]) add('foreign_key_definition', fk.table, fk.name, 'foreign key incompatible ' + fk.name);
  }
  return issues;
}

// Adds missing objects only. Existing incompatible definitions require explicit
// remediation: no DROP, rename, type conversion or automatic commercial backfill.
export function planAdditive(contract, catalog, occupiedTables = []) {
  const issues = compareCatalog(contract, catalog);
  const additive = new Set(['missing_table', 'missing_column', 'missing_primary', 'missing_index', 'missing_foreign_key', 'missing_not_null']);
  const incompatible = issues.filter(i => !additive.has(i.kind));
  if (incompatible.length) throw new ReadinessError(incompatible.map(i => i.message).join('; '));
  const statements = [];
  const missingTables = contract.tables.filter(t => !catalog.tables.includes(t.name));
  for (const table of missingTables) statements.push(table.sql);
  for (const table of contract.tables.filter(t => catalog.tables.includes(t.name))) {
    for (const column of table.columns.filter(col => !catalog.columns.some(c => c.table === table.name && c.name === col.name))) {
      if (!column.nullable && column.default === null && occupiedTables.includes(table.name)) throw new ReadinessError('Columna obligatoria sin backfill: ' + table.name + '.' + column.name);
      statements.push('ALTER TABLE ' + tableSql(table.name) + ' ADD COLUMN ' + quote(column.name) + ' ' + column.declaration + ';');
    }
    for (const col of table.columns.filter(col => issues.some(i => i.table === table.name && i.name === col.name && i.kind === 'missing_not_null'))) {
      statements.push('ALTER TABLE ' + tableSql(table.name) + ' ALTER COLUMN ' + quote(col.name) + ' SET NOT NULL;');
    }
    for (const pk of table.primary.filter(p => !catalog.constraints.some(c => c.table === table.name && c.type === 'p' && sameColumns(c.columns,p.columns)))) {
      statements.push('ALTER TABLE ' + tableSql(table.name) + ' ADD CONSTRAINT ' + quote(pk.name) + ' PRIMARY KEY (' + pk.columns.map(quote).join(', ') + ');');
    }
  }
  for (const index of contract.indexes.filter(i => !catalog.indexes.some(a => a.table === i.table && a.name === i.name))) statements.push(index.sql);
  for (const fk of contract.foreignKeys.filter(f => !catalog.constraints.some(c => c.table === f.table && c.name === f.name))) statements.push(fk.sql);
  return statements;
}

export async function readCatalog(client) {
  const tables = (await client.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows.map(r => r.name);
  const columns = (await client.query(`SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS "default"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows;
  const indexes = (await client.query(`SELECT t.relname AS "table", x.relname AS name, i.indisunique AS "unique", i.indisvalid AS valid, COALESCE((to_jsonb(i)->>'indnullsnotdistinct')::boolean,false) AS "nullsNotDistinct", am.amname AS method, pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS "columns"
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=x.relam WHERE n.nspname='public'`)).rows;
  const constraints = (await client.query(`SELECT t.relname AS "table", c.conname AS name, c.contype AS type, c.convalidated AS valid, rt.relname AS target, rn.nspname AS "targetSchema", c.confdeltype AS "onDelete", c.confupdtype AS "onUpdate",
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.ord) AS "columns",
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=rt.oid AND a.attnum=k.attnum ORDER BY k.ord) AS "targetColumns"
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_class rt ON rt.oid=c.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace WHERE n.nspname='public' AND c.contype IN ('p','f')`)).rows;
  return { tables, columns, indexes, constraints };
}

const SCOPE_CHECKS = [
  ['channel_tenant', ['channels','tenant_settings'], 'SELECT count(*)::int AS n FROM public.channels c LEFT JOIN public.tenant_settings t ON t.tenant_id=c.tenant_id WHERE t.tenant_id IS NULL'],
  ['message_conversation', ['messages','conversations','leads'], 'SELECT count(*)::int AS n FROM public.messages m JOIN public.leads l ON l.id=m."leadId" JOIN public.conversations c ON c.id=m."conversationId" JOIN public.leads cl ON cl.id=c."leadId" WHERE l.tenant_id<>cl.tenant_id'],
  ['lead_archived_vendor', ['leads','vendors'], 'SELECT count(*)::int AS n FROM public.leads l JOIN public.vendors v ON v.id=l.archived_by WHERE l.tenant_id<>v.tenant_id'],
  ['commitment_call_event', ['commitments','call_events','leads'], 'SELECT count(*)::int AS n FROM public.commitments x JOIN public.leads l ON l.id=x.lead_id JOIN public.call_events e ON e.id=x.call_event_id JOIN public.leads el ON el.id=e.lead_id WHERE l.tenant_id<>el.tenant_id'],
  ['trace_conversation', ['turn_trace','conversations','leads'], 'SELECT count(*)::int AS n FROM public.turn_trace x JOIN public.leads l ON l.id=x.lead_id JOIN public.conversations c ON c.id=x.conversation_id JOIN public.leads cl ON cl.id=c."leadId" WHERE l.tenant_id<>cl.tenant_id'],
  ['campaign_vendor', ['campaigns','vendors'], 'SELECT count(*)::int AS n FROM public.campaigns c JOIN public.vendors v ON v.id=c."vendorId" WHERE c.tenant_id<>v.tenant_id'],
  ['lead_campaign', ['leads','campaigns'], 'SELECT count(*)::int AS n FROM public.leads l JOIN public.campaigns c ON c.id=l."campaignId" WHERE l.tenant_id<>c.tenant_id'],
  ['lead_vendor', ['leads','vendors'], 'SELECT count(*)::int AS n FROM public.leads l JOIN public.vendors v ON v.id=l."vendorId" WHERE l.tenant_id<>v.tenant_id'],
  ['conversation_campaign', ['conversations','leads','campaigns'], 'SELECT count(*)::int AS n FROM public.conversations x JOIN public.leads l ON l.id=x."leadId" JOIN public.campaigns c ON c.id=x."campaignId" WHERE l.tenant_id<>c.tenant_id'],
  ['conversation_vendor', ['conversations','leads','vendors'], 'SELECT count(*)::int AS n FROM public.conversations x JOIN public.leads l ON l.id=x."leadId" JOIN public.vendors v ON v.id=x."vendorId" WHERE l.tenant_id<>v.tenant_id'],
  ['lead_state_vendor', ['lead_state','leads','vendors'], 'SELECT count(*)::int AS n FROM public.lead_state x JOIN public.leads l ON l.id=x.lead_id JOIN public.vendors v ON v.id=x.vendor_active_id WHERE l.tenant_id<>v.tenant_id'],
  ['call_event_vendor', ['call_events','leads','vendors'], 'SELECT count(*)::int AS n FROM public.call_events x JOIN public.leads l ON l.id=x.lead_id JOIN public.vendors v ON v.id=x.vendor_id WHERE l.tenant_id<>v.tenant_id'],
  ['notification_vendor', ['crm_notifications','leads','vendors'], 'SELECT count(*)::int AS n FROM public.crm_notifications x JOIN public.leads l ON l.id=x.lead_id JOIN public.vendors v ON v.id=x.vendor_id WHERE l.tenant_id<>v.tenant_id'],
  ['media_tenant', ['media_assets','leads'], 'SELECT count(*)::int AS n FROM public.media_assets x JOIN public.leads l ON l.id=x.lead_id WHERE x.tenant_id IS NOT NULL AND x.tenant_id<>l.tenant_id'],
  ['pending_receipt_channel', ['pending_cloud_receipts','channels'], "SELECT count(*)::int AS n FROM public.pending_cloud_receipts p LEFT JOIN public.channels c ON c.provider='cloud' AND c.external_key=p.phone_number_id WHERE c.id IS NULL OR p.tenant_id<>c.tenant_id"],
  // Hito A1/A2: la entrada y la salida durables no pueden pertenecer a un lead de otro
  // tenant. Sin esta comprobación, un bug de ruteo escribiría el mensaje de un cliente en la
  // bandeja de otro sin que ninguna otra verificación lo notara.
  ['inbound_lead_tenant', ['inbound_events','leads'], 'SELECT count(*)::int AS n FROM public.inbound_events x JOIN public.leads l ON l.id=x."leadId" WHERE x.tenant_id<>l.tenant_id'],
  ['outbound_lead_tenant', ['outbound_messages','leads'], 'SELECT count(*)::int AS n FROM public.outbound_messages x JOIN public.leads l ON l.id=x."leadId" WHERE x.tenant_id<>l.tenant_id']
];

export async function checkTenantScope(client, tables) {
  const issues = [];
  for (const [name, required, sql] of SCOPE_CHECKS) {
    if (!required.every(t => tables.includes(t))) continue;
    const count = Number((await client.query(sql)).rows[0].n);
    if (count) issues.push({ kind: 'tenant_scope', name, message: name + ': ' + count + ' relaciones entre tenants o canal no resoluble' });
  }
  return issues;
}

export async function prepareDatabase(client, contract, { apply = false, verify = false } = {}) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL search_path TO public, pg_catalog");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    if (apply) {
      const locked = (await client.query('SELECT pg_try_advisory_xact_lock(20261002, 1701) AS locked')).rows[0].locked;
      if (!locked) throw new ReadinessError('Otra migración CRM está en curso');
    }
    const before = await readCatalog(client);
    let statements = [];
    if (!verify) {
      const occupied = [];
      for (const table of contract.tables.filter(t => before.tables.includes(t.name))) {
        if ((await client.query('SELECT EXISTS(SELECT 1 FROM ' + tableSql(table.name) + ' LIMIT 1) AS occupied')).rows[0].occupied) occupied.push(table.name);
      }
      statements = planAdditive(contract, before, occupied);
    }
    if (apply) for (const sql of statements) await client.query(sql);
    const after = apply ? await readCatalog(client) : before;
    const issues = compareCatalog(contract, after);
    if (apply || verify) {
      if (issues.length) throw new ReadinessError(issues.map(i => i.message).join('; '));
      const scopeIssues = await checkTenantScope(client, after.tables);
      if (scopeIssues.length) throw new ReadinessError(scopeIssues.map(i => i.message).join('; '));
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { statements, issues, tables: contract.tables.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function runSchemaCli(profile = 'full', args = process.argv.slice(2)) {
  let client;
  try {
    const allowed = new Set(['--aplicar','--verificar','--revisar','--sql']);
    if (args.some(a => !allowed.has(a)) || args.filter(a => ['--aplicar','--verificar','--revisar'].includes(a)).length > 1) throw new ReadinessError('Usa solo --aplicar, --verificar o --revisar (y --sql opcional)');
    const contract = selectProfile(loadContract(), profile);
    if (!args.some(a => ['--aplicar','--verificar','--revisar'].includes(a))) {
      console.log('Plan sin conexión: ' + contract.tables.length + ' modelos public; no se escribió ni verificó BD.');
      if (args.includes('--sql')) console.log(contract.tables.map(t => t.sql).concat(contract.indexes.map(i => i.sql), contract.foreignKeys.map(f => f.sql)).join('\n'));
      console.log('Configura CRM_DATABASE_URL explícitamente y usa --revisar, --verificar o --aplicar. No se carga .env.');
      return;
    }
    const url = process.env.CRM_DATABASE_URL;
    if (!url) throw new ReadinessError('CRM_DATABASE_URL requerido explícitamente; no se usa ni carga .env');
    const { default: pg } = await import('pg');
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    const apply = args.includes('--aplicar');
    const verify = args.includes('--verificar');
    const result = await prepareDatabase(client, contract, { apply, verify });
    if (args.includes('--sql')) console.log(result.statements.join('\n'));
    if (apply || verify) console.log('Readiness verificado: ' + result.tables + ' modelos; ' + (apply ? result.statements.length + ' sentencias aplicadas atómicamente.' : 'solo lectura.'));
    else {
      console.log('Revisión sin escrituras: ' + result.statements.length + ' sentencias aditivas pendientes.');
      for (const issue of result.issues) console.log('  ' + issue.message);
    }
  } catch (error) {
    // Driver errors may contain URLs/credentials/row values: never print them.
    console.error(error.code ? 'Falló DB readiness (' + String(error.code).replace(/[^A-Z0-9_]/gi, '') + '). Sin confirmación de éxito.' : error instanceof ReadinessError ? 'Falló DB readiness: ' + error.message : 'Falló DB readiness: conexión o catálogo no verificable. Sin confirmación de éxito.');
    process.exitCode = 1;
  } finally {
    if (client) { try { await client.end(); } catch { process.exitCode = 1; } }
  }
}
