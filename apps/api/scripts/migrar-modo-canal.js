// Channel schema including modo. Default: offline plan without writes.
// Explicit CRM_DATABASE_URL + --revisar / --verificar / --aplicar.
import { runSchemaCli } from './db-readiness-lib.js';
await runSchemaCli('channel-mode');