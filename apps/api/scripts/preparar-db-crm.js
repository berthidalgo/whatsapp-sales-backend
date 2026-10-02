// Full CRM schema bootstrap / additive upgrade. Default: offline plan only.
import { runSchemaCli } from './db-readiness-lib.js';
await runSchemaCli('full');