// Generates versioned empty-schema SQL locally. No database, .env or API access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_ROOT, SCHEMA_PATH, SQL_PATH, CONTRACT_PATH, parseSchemaSql, qualifySql } from './db-readiness-lib.js';

if (process.argv.length !== 3 || process.argv[2] !== '--actualizar') {
  console.error('Uso: node scripts/generar-contrato-db.js --actualizar (solo archivos locales; no BD).');
  process.exitCode = 1;
} else {
  let temporary;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-schema-contract-'));
    const source = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const offlineSchema = source.replace(/url\s*=\s*env\("DATABASE_URL"\)/, 'url = "postgresql://offline:offline@127.0.0.1:1/offline"');
    const schemaCopy = path.join(temporary, 'schema.prisma');
    fs.writeFileSync(schemaCopy, offlineSchema);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: temporary, TMP: temporary,
      PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' };
    const generated = execFileSync(process.execPath, [path.join(API_ROOT, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaCopy, '--script'], {
      cwd: temporary, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore','pipe','pipe']
    });
    const sql = '-- Contrato CRM 20261002: esquema completo sin datos comerciales.\n-- Bootstrap en BD vacía; upgrades mediante preparar-db-crm.js (nunca ejecutar a ciegas en producción).\n' + qualifySql(generated);
    const contract = parseSchemaSql(sql, source);
    fs.mkdirSync(path.dirname(SQL_PATH), { recursive: true });
    fs.writeFileSync(SQL_PATH, sql);
    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n');
    console.log('Contrato generado offline: ' + contract.tables.length + ' tablas, ' + contract.indexes.length + ' índices, ' + contract.foreignKeys.length + ' foreign keys.');
  } catch {
    console.error('No se pudo generar el contrato local. Verifica instalación local de Prisma y sintaxis del schema.');
    process.exitCode = 1;
  } finally {
    // Keep the isolated temporary schema for diagnostics; no secrets or database data.
  }
}