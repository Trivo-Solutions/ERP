import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

// ═══════════════════════════════════════════════════════════════════════════
// TWO database identities (production):
//
//   prisma          the RUNTIME client — DATABASE_URL, role `trivo_runtime`. Owns no table, has no
//                   BYPASSRLS. Every query on a company-owned table runs under row-level security, so it
//                   must go through the tenant wrappers (tenantQuery / tenantBatch / tenantTransaction),
//                   which set `app.tenant_company_id` in the same transaction. A query that forgets to
//                   sees ZERO rows / is refused — fail closed.
//
//   platformPrisma  the PLATFORM client — PLATFORM_DATABASE_URL, role `trivo_platform` (BYPASSRLS, DML only,
//                   still not the owner). Used ONLY through runAsPlatform(): company provisioning,
//                   operator endpoints, platform audit events, startup device enumeration. Never reachable
//                   from a company user's request.
//
//   Migrations run as a third role (`trivo_owner`, DDL) that the running app never connects as.
//
// In development / test with a single database role, PLATFORM_DATABASE_URL may be unset: both clients are
// then the same connection (and RLS is inert, because that role owns the tables). assertDatabaseRoleSafety()
// refuses to start in production in that configuration.
// ═══════════════════════════════════════════════════════════════════════════

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; platformPrisma: PrismaClient };

const clientOptions = {
  log:
    process.env.NODE_ENV === 'development'
      ? ([{ emit: 'event', level: 'query' }, 'info', 'warn', 'error'] as any)
      : (['warn', 'error'] as any),
  transactionOptions: {
    maxWait: 5_000,   // ms to acquire a transaction slot
    timeout: 15_000,  // ms max duration before auto-rollback
    isolationLevel: 'ReadCommitted' as const,
  },
};

// Pool settings are embedded in each URL (?connection_limit=20&pool_timeout=10).
export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient(clientOptions);

export const platformDatabaseConfigured = !!process.env.PLATFORM_DATABASE_URL && process.env.PLATFORM_DATABASE_URL !== process.env.DATABASE_URL;

export const platformPrisma: PrismaClient = platformDatabaseConfigured
  ? (globalForPrisma.platformPrisma ?? new PrismaClient({ ...clientOptions, datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } }))
  : prisma;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
  if (platformDatabaseConfigured) globalForPrisma.platformPrisma = platformPrisma;
  (prisma as any).$on('query', (e: any) => {
    if (process.env.LOG_QUERIES === 'true') {
      logger.debug(`Query: ${e.query} | Duration: ${e.duration}ms`);
    }
  });
}

export async function connectDatabase() {
  await prisma.$connect();
  if (platformDatabaseConfigured) await platformPrisma.$connect();
  logger.info('✅ Database connected');
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
  if (platformDatabaseConfigured) await platformPrisma.$disconnect();
  logger.info('Database disconnected');
}

export interface DatabaseRoleReport {
  runtimeRole: string; platformRole: string;
  superuser: boolean; bypassRls: boolean; ownsTables: number;
  unforcedTenantTables: string[];
  platformSeparate: boolean;
  problems: string[];
}

/**
 * Verifies the app is really running under the isolation guarantee it assumes:
 * the runtime role is not a superuser, does not bypass RLS, owns no table, every tenant table has FORCE
 * ROW LEVEL SECURITY, and the platform client is a DIFFERENT role. Returns the list of problems
 * (empty = safe). Called at startup: production refuses to boot with any problem.
 */
export async function inspectDatabaseRoles(): Promise<DatabaseRoleReport> {
  const [me] = await prisma.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
  const [owned] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`;
  const unforced = await prisma.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND c.relname IN (SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation')
      AND NOT c.relforcerowsecurity`;
  let platformRole = me.current_user;
  if (platformDatabaseConfigured) {
    const [p] = await platformPrisma.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;
    platformRole = p.current_user;
  }

  const problems: string[] = [];
  if (me.rolsuper) problems.push(`runtime role "${me.current_user}" is a SUPERUSER (bypasses RLS)`);
  if (me.rolbypassrls) problems.push(`runtime role "${me.current_user}" has BYPASSRLS`);
  if (owned.n > 0) problems.push(`runtime role "${me.current_user}" OWNS ${owned.n} table(s) — an owner is exempt from RLS unless FORCEd, and could ALTER/DISABLE it`);
  if (unforced.length > 0) problems.push(`${unforced.length} tenant table(s) lack FORCE ROW LEVEL SECURITY (e.g. ${unforced.slice(0, 3).map((u) => u.relname).join(', ')})`);
  if (!platformDatabaseConfigured) problems.push('PLATFORM_DATABASE_URL is not set (or equals DATABASE_URL): platform operations would run as the runtime role');
  else if (platformRole === me.current_user) problems.push('the platform client connects as the same role as the runtime client');

  return { runtimeRole: me.current_user, platformRole, superuser: me.rolsuper, bypassRls: me.rolbypassrls, ownsTables: owned.n, unforcedTenantTables: unforced.map((u) => u.relname), platformSeparate: platformDatabaseConfigured && platformRole !== me.current_user, problems };
}

export async function assertDatabaseRoleSafety(): Promise<void> {
  const report = await inspectDatabaseRoles();
  if (report.problems.length === 0) {
    logger.info(`✅ Database roles: runtime="${report.runtimeRole}" platform="${report.platformRole}" — RLS enforced, tables FORCEd`);
    return;
  }
  const detail = report.problems.map((p) => `  - ${p}`).join('\n');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to start: the database role setup does not provide tenant isolation.\n${detail}\nSee prisma/production-rls-roles.sql and prisma/db-secure.sql.`);
  }
  logger.warn(`⚠️  Row-level security is NOT being enforced against this connection (fine for local development, fatal in production):\n${detail}`);
}
