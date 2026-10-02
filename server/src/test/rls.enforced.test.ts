import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma, prisma as runtimePrisma, inspectDatabaseRoles } from '../config/database';
import { tenantQuery } from '../shared/tenantContext';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { purgeCompany, uniqueCompanyCode, withForcedRls, REAL_ROLE_SPLIT } from './fixtures';
// The build-failing static guard: no company-owned query may bypass the tenant wrappers.
import { runAudit } from '../tools/tenantAudit';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — database-level tenant isolation, proven independently of application filtering.
//
// Every scenario below runs as a session BOUND BY ROW-LEVEL SECURITY:
//   - against a database with the real role split (npm run test:rls) that is the application's actual
//     runtime role (trivo_runtime: no ownership, no BYPASSRLS, tables FORCEd) — the production guarantee;
//   - on the everyday single-role test database the tables are temporarily FORCEd inside a rolled-back
//     transaction, which exercises the same policies.
// ═══════════════════════════════════════════════════════════════════════════

const EMAIL_DOMAIN = '@rlsenf.example.com';

describe('Phase 5: database-enforced tenant isolation', () => {
  const created: string[] = [];
  let A: { id: string }; let B: { id: string };
  let scopedTables: string[] = [];

  beforeAll(async () => {
    const mk = async (tag: string) => {
      const code = uniqueCompanyCode(tag);
      const r = await provisionCompany({ code, name: `RLS ${tag}`, admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Owner Person', password: 'RlsEnf-Passw0rd-123' } });
      created.push(r.company.id);
      return r.company;
    };
    A = await mk('RA'); B = await mk('RB');
    // Extra operational rows in both, so more than the starter tables are populated.
    for (const c of [A, B]) {
      await prisma.client.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ companyId: c.id, clientCode: `RC${i}`, name: `Client ${i}`, type: 'RETAIL' })) });
      await prisma.supplier.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ companyId: c.id, supplierCode: `RS${i}`, name: `Supplier ${i}`, type: 'OTHER' })) });
    }
    const rows: Array<{ tablename: string }> = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation' ORDER BY 1`);
    scopedTables = rows.map((r) => r.tablename);
  }, 120_000);

  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: EMAIL_DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    await prisma.$disconnect();
  });

  const as = (companyId: string | null, tables: string[], fn: (tx: any) => Promise<any>) =>
    withForcedRls(tables, async (tx) => {
      if (companyId) await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyId}, true)`;
      return fn(tx);
    });

  const count = async (tx: any, sql: string, ...params: unknown[]): Promise<number> => (await tx.$queryRawUnsafe(sql, ...params))[0].n;

  it('there are company-owned tables to test, and every one has a tenant_isolation policy', () => {
    expect(scopedTables.length).toBeGreaterThan(70);
  });

  // ─── SELECT ────────────────────────────────────────────────────────────────
  it('SELECT: a session scoped to A sees ZERO rows of B in EVERY company-owned table (and B likewise)', async () => {
    for (const [me, other] of [[A, B], [B, A]]) {
      const leaks = await as(me.id, scopedTables, async (tx) => {
        const out: string[] = [];
        for (const t of scopedTables) {
          const n = await count(tx, `SELECT count(*)::int n FROM "${t}" WHERE "companyId" = $1`, other.id);
          if (n > 0) out.push(`${t}:${n}`);
        }
        return out;
      });
      expect(leaks, `session ${me.id} must not see ${other.id}`).toEqual([]);
    }
  }, 120_000);

  it('the session still sees ITS OWN rows (control — the policy is not simply hiding everything)', async () => {
    const own = await as(A.id, ['clients', 'suppliers', 'accounts', 'roles'], async (tx) => ({
      clients: await count(tx, `SELECT count(*)::int n FROM clients`),
      suppliers: await count(tx, `SELECT count(*)::int n FROM suppliers`),
      accounts: await count(tx, `SELECT count(*)::int n FROM accounts`),
      roles: await count(tx, `SELECT count(*)::int n FROM roles`),
    }));
    expect(own).toEqual({ clients: 12, suppliers: 5, accounts: 44, roles: 6 }); // 44 = the starter chart, incl. 6600 Round Off + 1404/2204 RCM (G2g-7d)
  });

  it('a bare SELECT with NO company filter at all returns only the session company\'s rows — application code forgetting its filter is still contained', async () => {
    const rows = await as(A.id, ['clients'], (tx) => tx.$queryRawUnsafe(`SELECT DISTINCT "companyId" FROM clients`));
    expect(rows.map((r: any) => r.companyId)).toEqual([A.id]);
  });

  // The through-the-application form of the same claim: a findMany with NO `where` at all. This only holds when RLS
  // really binds the application's connection — i.e. with the real role split (the everyday single-role database's
  // role owns the tables, so the same call there is *not* contained; that is precisely why production refuses to run so).
  it.skipIf(!REAL_ROLE_SPLIT)('through the real application path: tenantQuery(A, findMany()) with no where returns only A\'s rows even though B has many', async () => {
    const viaApp = await tenantQuery(A.id, (tx) => tx.client.findMany());
    expect(viaApp.length).toBe(12);
    expect(new Set(viaApp.map((c) => c.companyId))).toEqual(new Set([A.id]));
    const viaAppB = await tenantQuery(B.id, (tx) => tx.supplier.findMany());
    expect(viaAppB.length).toBe(5);
    expect(new Set(viaAppB.map((c) => c.companyId))).toEqual(new Set([B.id]));
    // and a bare call with NO wrapper (a developer forgetting it) sees nothing at all
    expect(await runtimePrisma.client.count()).toBe(0);
  });

  // ─── UPDATE / DELETE ───────────────────────────────────────────────────────
  it('UPDATE: a session scoped to A changes ZERO of B\'s rows in every table (rows are invisible, not merely refused)', async () => {
    const touched: string[] = [];
    for (const t of scopedTables) {
      // Fresh transaction per table. A privilege refusal (e.g. the append-only audit trail) is containment too;
      // only a SUCCESSFUL change of B's rows would be a leak.
      const n = await as(A.id, [t], (tx) => tx.$executeRawUnsafe(`UPDATE "${t}" SET "companyId" = "companyId" WHERE "companyId" = $1`, B.id))
        .catch((e: Error) => { if (!/permission denied/i.test(e.message)) throw e; return 0; });
      if (n > 0) touched.push(`${t}:${n}`);
    }
    expect(touched).toEqual([]);
  }, 240_000);

  it('DELETE: a session scoped to A deletes ZERO of B\'s rows in every table', async () => {
    // One fresh transaction per table, so a refusal on one table can never mask the next.
    const deleted: string[] = [];
    for (const t of scopedTables) {
      const n = await as(A.id, [t], (tx) => tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "companyId" = $1`, B.id)).catch(() => 0);
      if (n > 0) deleted.push(`${t}:${n}`);
    }
    expect(deleted).toEqual([]);
    expect(await prisma.client.count({ where: { companyId: B.id } })).toBe(12); // B's data is intact
    expect(await prisma.supplier.count({ where: { companyId: B.id } })).toBe(5);
  }, 240_000);

  // ─── INSERT / forging ownership ────────────────────────────────────────────
  it('INSERT: a session scoped to A cannot create a row owned by B (WITH CHECK)', async () => {
    for (const [who, forged] of [[A, B], [B, A]]) {
      await expect(as(who.id, ['clients'], (tx) => tx.$executeRaw`
        INSERT INTO clients (id, "companyId", "clientCode", name, type)
        VALUES (gen_random_uuid()::text, ${forged.id}, 'FORGED', 'Forged', 'RETAIL')`)).rejects.toThrow(/row-level security/i);
    }
  });

  it('UPDATE-to-forge: a session cannot re-assign its OWN row to another company (WITH CHECK on the new value)', async () => {
    await expect(as(A.id, ['clients'], (tx) =>
      tx.$executeRawUnsafe(`UPDATE clients SET "companyId" = $1 WHERE "companyId" = $2`, B.id, A.id))).rejects.toThrow(/row-level security/i);
  });

  // ─── Fail-closed ───────────────────────────────────────────────────────────
  it('with NO tenant variable set, every company-owned table returns ZERO rows (fail closed) and writes are refused', async () => {
    const seen = await as(null, scopedTables, async (tx) => {
      const out: string[] = [];
      for (const t of scopedTables) {
        const n = await count(tx, `SELECT count(*)::int n FROM "${t}"`);
        if (n > 0) out.push(`${t}:${n}`);
      }
      return out;
    });
    expect(seen).toEqual([]);
    await expect(as(null, ['clients'], (tx) => tx.$executeRaw`
      INSERT INTO clients (id, "companyId", "clientCode", name, type)
      VALUES (gen_random_uuid()::text, ${A.id}, 'NOVAR', 'No variable', 'RETAIL')`)).rejects.toThrow(/row-level security/i);
  }, 120_000);

  it('the tenant setting is transaction-local: it does not leak to the next query on a reused pooled connection', async () => {
    // set the variable inside one transaction…
    await as(A.id, ['clients'], (tx) => count(tx, `SELECT count(*)::int n FROM clients`));
    // …then run a bare statement outside any tenant transaction on the SAME client: it must see nothing.
    const bare: Array<{ n: number }> = REAL_ROLE_SPLIT
      ? await runtimePrisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int n FROM clients`)
      : await withForcedRls(['clients'], (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int n FROM clients`));
    expect(bare[0].n).toBe(0);
  });
});

describe('Phase 5: the application\'s database role really is constrained (real role split only)', () => {
  it.skipIf(!REAL_ROLE_SPLIT)('runtime role: not a superuser, no BYPASSRLS, owns no table; every tenant table FORCEd; platform role is a different identity', async () => {
    const report = await inspectDatabaseRoles();
    expect(report.problems).toEqual([]);
    expect(report.superuser).toBe(false);
    expect(report.bypassRls).toBe(false);
    expect(report.ownsTables).toBe(0);
    expect(report.unforcedTenantTables).toEqual([]);
    expect(report.platformSeparate).toBe(true);
    expect(report.runtimeRole).not.toBe(report.platformRole);
  });

  it.skipIf(!REAL_ROLE_SPLIT)('runtime role cannot escape RLS: no DDL, cannot disable RLS, cannot switch it off, cannot rewrite the audit trail or read platform tables', async () => {
    const attempts: Array<[string, string]> = [
      ['CREATE TABLE', `CREATE TABLE rls_probe (id int)`],
      ['ALTER TABLE ADD COLUMN', `ALTER TABLE clients ADD COLUMN probe int`],
      ['DISABLE ROW LEVEL SECURITY', `ALTER TABLE clients DISABLE ROW LEVEL SECURITY`],
      ['NO FORCE ROW LEVEL SECURITY', `ALTER TABLE clients NO FORCE ROW LEVEL SECURITY`],
      ['DROP POLICY', `DROP POLICY tenant_isolation ON clients`],
      ['DROP TABLE', `DROP TABLE clients`],
      ['TRUNCATE', `TRUNCATE clients`],
      ['read platform_audit_logs', `SELECT count(*) FROM platform_audit_logs`],
      ['read _prisma_migrations', `SELECT count(*) FROM _prisma_migrations`],
      ['UPDATE audit_logs (append-only)', `UPDATE audit_logs SET action = 'x'`],
      ['DELETE audit_logs (append-only)', `DELETE FROM audit_logs`],
      ['write companies', `UPDATE companies SET name = name`],
      ['delete users', `DELETE FROM users`],
      ['CREATE ROLE', `CREATE ROLE probe_role`],
    ];
    for (const [what, sql] of attempts) {
      await expect(runtimePrisma.$executeRawUnsafe(sql), what).rejects.toThrow(/permission denied|must be owner|not permitted/i);
    }
  });

  it.skipIf(!REAL_ROLE_SPLIT)('runtime role cannot turn RLS off for itself: `SET row_security = off` makes a protected query ERROR instead of returning everything', async () => {
    await expect(runtimePrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL row_security = off`);
      return tx.$queryRawUnsafe(`SELECT count(*) FROM clients`);
    })).rejects.toThrow(/row-level security/i);
  });

  it.skipIf(!REAL_ROLE_SPLIT)('the platform role bypasses RLS by design (it is the operator identity, reached only via runAsPlatform)', async () => {
    const code = uniqueCompanyCode('RP');
    const r = await provisionCompany({ code, name: 'Platform Bypass Co', admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Owner Person', password: 'RlsEnf-Passw0rd-123' } });
    try {
      await prisma.client.create({ data: { companyId: r.company.id, clientCode: 'PB1', name: 'Bypass Client', type: 'RETAIL' } });
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int n FROM clients`);
      expect(n).toBeGreaterThan(0); // sees rows with no tenant variable at all
      expect(await runtimePrisma.client.count()).toBe(0); // …while the runtime role, with no tenant variable, sees none
    } finally {
      await purgeCompany(r.company.id);
      await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    }
  });

  it.skipIf(REAL_ROLE_SPLIT)('single-role database: the safety inspection correctly REPORTS that RLS is not enforced (production would refuse to start)', async () => {
    const report = await inspectDatabaseRoles();
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems.join(' ')).toMatch(/OWNS|PLATFORM_DATABASE_URL|FORCE/);
  });
});

describe('Phase 5: no application code can bypass the tenant wrappers (static guard)', () => {
  it('the tenant audit finds ZERO direct Prisma queries on company-owned models and ZERO aliasing of the bare client', () => {
    const r = runAudit();
    expect(r.scoped, `bare company-owned queries — route them through tenantQuery/tenantBatch/tenantTransaction:\n${r.scoped.map((x) => `  ${x.file}:${x.line} ${x.text}`).join('\n')}`).toEqual([]);
    expect(r.aliases, `aliasing / passing the bare prisma client around:\n${r.aliases.map((x) => `  ${x.file}:${x.line} ${x.text}`).join('\n')}`).toEqual([]);
    expect(r.raw).toBe(0); // no raw SQL outside the wrappers/numberSequence (which is given a transaction client)
  });
});
