const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const api = resolve(__dirname,'..')
// Compatibility entry point uses the same validation and transaction as every tenant.
const resultado = spawnSync(process.execPath,[resolve(api,'scripts/seed-generico.js'),'--json',resolve(api,'data/tenants/peru_exporta.json'),'--aplicar'],{cwd:api,stdio:'inherit'})
if (resultado.error) throw resultado.error
process.exitCode = resultado.status ?? 1
