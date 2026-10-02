// Read-only boot gate. Schema preparation is an explicit operator command.
import { loadContract, readCatalog, compareCatalog } from '../../scripts/db-readiness-lib.js'
export async function verificarEsquemaCRM(prisma) {
  const contract = loadContract()
  const issues = await prisma.$transaction(async tx => {
    const catalog = await readCatalog({ query: async sql => ({ rows: await tx.$queryRawUnsafe(sql) }) })
    return compareCatalog(contract, catalog)
  }, { isolationLevel: 'RepeatableRead', timeout: 10000 })
  if (issues.length) throw Object.assign(new Error('Esquema CRM incompleto o incompatible; ejecutar verificar-db-crm.js antes del despliegue'), { code: 'CRM_SCHEMA_NOT_READY', issues })
  return { ready: true, schemaVersion: contract.version, models: contract.tables.length }
}
