// scripts/seed-hidata.js — ALTA DEL CLIENTE HIDATA IMPORTACIONES
//
// Compatibilidad (F3 forense): los datos viven en data/tenants/hidata.json y la
// lógica en scripts/seed-generico.js. Se preserva el CLI histórico:
//   node scripts/seed-hidata.js             → simula
//   node scripts/seed-hidata.js --aplicar   → escribe
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = [join(__dirname, 'seed-generico.js'), '--json', 'data/tenants/hidata.json']
if (process.argv.includes('--aplicar')) args.push('--aplicar')
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: join(__dirname, '..') })
process.exitCode = r.status ?? 1
