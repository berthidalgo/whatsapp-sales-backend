// Full schema + tenant-scope readiness. Always read-only; explicit target URL.
import { runSchemaCli } from './db-readiness-lib.js';
await runSchemaCli('full', ['--verificar', ...process.argv.slice(2)]);