// CLI wrapper — the audit itself lives in src/tools/tenantAudit.ts so the build-failing guard test can import it.
//   npx ts-node scripts/tenant-audit.ts [--fix] [--strict]
import { cli } from '../src/tools/tenantAudit';
cli();
