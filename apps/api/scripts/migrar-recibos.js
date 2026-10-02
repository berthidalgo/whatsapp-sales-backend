// Meta receipt columns, tenant/phone binding and durable pending receipts.
// Default: offline plan, no database connection and no .env loading.
// Explicit CRM_DATABASE_URL + --revisar / --verificar / --aplicar.
import { runSchemaCli } from './db-readiness-lib.js';
await runSchemaCli('receipts');