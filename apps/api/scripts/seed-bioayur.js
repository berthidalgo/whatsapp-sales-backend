// scripts/seed-bioayur.js — SEED DEL TENANT BIOAYUR
//
// Compatibilidad (F3 forense): los datos viven en data/tenants/bioayur.json y la
// lógica en scripts/seed-generico.js. Este archivo solo preserva el comando
// histórico `node scripts/seed-bioayur.js` (aplica directo, como siempre).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const r = spawnSync(
  process.execPath,
  [join(__dirname, 'seed-generico.js'), '--json', 'data/tenants/bioayur.json', '--aplicar'],
  { stdio: 'inherit', cwd: join(__dirname, '..') }
)
process.exitCode = r.status ?? 1
