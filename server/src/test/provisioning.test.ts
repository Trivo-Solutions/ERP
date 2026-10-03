import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';
import { provisionCompany, type ProvisionStep } from '../modules/platform/provisioning.service';
import {
  STARTER_PACKAGE_V1, registerStarterPackage, _unregisterStarterPackageForTests, getStarterPackage,
  type StarterPackageDefinition,
} from '../modules/platform/starterPackage';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: company provisioning + the TRIVO Starter Package, against the real database.
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN_PASSWORD = 'Admin-Passw0rd-123';
const EMAIL_DOMAIN = '@provtest.example.com';
const ALL_STEPS: ProvisionStep[] = ['company', 'roles', 'branch', 'accounts', 'starterPackage', 'admin', 'verify', 'audit'];

// Tables a freshly provisioned company legitimately has rows in — everything else must be EMPTY.
const STARTER_OR_SETUP_TABLES = new Set([
  'roles', 'branches', 'accounts', 'karat_master', 'design_categories', 'product_categories', 'sub_categories', 'category_sub_categories',
  'collections', 'material_codes', 'stock_types', 'stone_types', 'stone_grades', 'tag_templates',
  'estimate_templates', 'system_configs', 'company_users', 'company_invitations',
]);

describe('Phase 3: company provisioning & Starter Package', () => {
  const createdCompanyIds: string[] = [];
  const clone = (): StarterPackageDefinition => JSON.parse(JSON.stringify(STARTER_PACKAGE_V1));
  const pub = () => apiWith(undefined, app);

  async function provision(over: Partial<Parameters<typeof provisionCompany>[0]> = {}) {
    const code = over.code ?? uniqueCompanyCode();
    const r = await provisionCompany({
      code, name: `Test Company ${code}`,
      admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Admin Person', password: ADMIN_PASSWORD },
      ...over,
    });
    createdCompanyIds.push(r.company.id);
    return r;
  }

  const companyRowCounts = async (companyId: string) => {
    const tables: Array<{ table_name: string }> = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='companyId' AND table_name <> 'companies'`);
    const out: Record<string, number> = {};
    for (const t of tables) {
      const r: Array<{ n: number }> = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t.table_name}" WHERE "companyId" = $1`, companyId);
      out[t.table_name] = r[0].n;
    }
    return out;
  };

  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: EMAIL_DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...createdCompanyIds, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    await prisma.$disconnect();
  });

  // ─── Completeness ───────────────────────────────────────────────────────────
  describe('a provisioned company is complete', () => {
    it('receives roles, head-office branch, chart of accounts, masters, templates, config and an administrator — all its own', async () => {
      const r = await provision();
      const id = r.company.id;
      const pkg = STARTER_PACKAGE_V1;

      const company = await prisma.company.findUniqueOrThrow({ where: { id } });
      expect(company.starterPackageVersion).toBe(1);
      expect(company.starterPackageAppliedAt).toBeInstanceOf(Date);

      expect((await prisma.role.findMany({ where: { companyId: id } })).map((x) => x.name).sort()).toEqual(pkg.roles.map((x) => x.name).sort());
      expect(await prisma.branch.findMany({ where: { companyId: id }, select: { branchCode: true, name: true, isHeadOffice: true } }))
        .toEqual([{ branchCode: 'HO', name: 'Head Office', isHeadOffice: true }]);
      expect(await prisma.account.count({ where: { companyId: id } })).toBe(pkg.chartOfAccounts.length);
      expect(await prisma.karatMaster.count({ where: { companyId: id } })).toBe(pkg.masters.karats.length);
      expect(await prisma.designCategory.count({ where: { companyId: id } })).toBe(pkg.masters.designCategories.length);
      expect(await prisma.productCategory.count({ where: { companyId: id } })).toBe(pkg.masters.productCategories.length);
      expect(await prisma.subCategory.count({ where: { companyId: id } })).toBe(pkg.masters.subCategories.length);
      expect(await prisma.materialCode.count({ where: { companyId: id } })).toBe(pkg.masters.materialCodes.length);
      expect(await prisma.stockType.count({ where: { companyId: id } })).toBe(pkg.masters.stockTypes.length);
      expect(await prisma.stoneType.count({ where: { companyId: id } })).toBe(pkg.masters.stoneTypes.length);
      expect(await prisma.stoneGrade.count({ where: { companyId: id } })).toBe(pkg.masters.stoneGrades.length);
      expect(await prisma.tagTemplate.count({ where: { companyId: id, isDefault: true } })).toBe(1);
      expect(await prisma.estimateTemplate.count({ where: { companyId: id, isDefault: true } })).toBe(1);
      expect((await prisma.systemConfig.findMany({ where: { companyId: id } })).map((c) => `${c.key}=${c.value}`)).toEqual(['DEFAULT_GOLD_MARGIN=15']);
      expect(r.starterPackage.version).toBe(1);
    });

    it('sub-categories and stone grades point at THIS company\'s own parents', async () => {
      const r = await provision();
      const links = await prisma.categorySubCategory.findMany({ where: { companyId: r.company.id }, include: { category: true, subCategory: true } });
      expect(links.length).toBe(STARTER_PACKAGE_V1.masters.subCategories.length);
      for (const l of links) { expect(l.category.companyId).toBe(r.company.id); expect(l.subCategory.companyId).toBe(r.company.id); }
      const grades = await prisma.stoneGrade.findMany({ where: { companyId: r.company.id }, include: { stoneType: true } });
      for (const g of grades) expect(g.stoneType.companyId).toBe(r.company.id);
    });

    it('the administrator is a SUPER_ADMIN member who can sign in, into this company only', async () => {
      const r = await provision();
      expect(r.admin.mode).toBe('MEMBER');
      const login = await pub().post('/auth/login', { companyCode: r.company.code, identifier: r.admin.email, password: ADMIN_PASSWORD });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(login.body.data.user.role).toBe('SUPER_ADMIN');
      expect(login.body.data.company.id).toBe(r.company.id);
      expect(login.body.data.user.branchAccess.allBranches).toBe(true);
    });

    it('a generated initial password is returned exactly once (and only when we generated it)', async () => {
      const code = uniqueCompanyCode();
      const gen = await provisionCompany({ code, name: 'Gen Pw Co', admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Admin Person' } });
      createdCompanyIds.push(gen.company.id);
      expect(gen.admin.mode).toBe('MEMBER');
      const pw = (gen.admin as any).initialPassword as string;
      expect(pw.length).toBeGreaterThanOrEqual(15);
      expect((await pub().post('/auth/login', { companyCode: code, identifier: gen.admin.email, password: pw })).status).toBe(200);
      const supplied = await provision();
      expect((supplied.admin as any).initialPassword).toBeUndefined();
    });

    it('the company can immediately do real work: the ledger accounts exist so a sale can post', async () => {
      const r = await provision();
      const have = new Set((await prisma.account.findMany({ where: { companyId: r.company.id }, select: { code: true } })).map((a) => a.code));
      for (const c of ['1101', '1102', '1200', '1300', '2100', '2201', '2202', '2203', '4000', '5000']) expect(have.has(c), c).toBe(true);
    });

    it('records a platform audit event (NOT a company audit event) with the package version', async () => {
      const r = await provision();
      const ev = await prisma.platformAuditLog.findFirstOrThrow({ where: { action: 'COMPANY_PROVISIONED', subjectId: r.company.id } });
      expect((ev.metadata as any).starterPackageVersion).toBe(1);
      expect((ev.metadata as any).code).toBe(r.company.code);
      expect(await prisma.auditLog.count({ where: { companyId: r.company.id } })).toBe(0);
    });
  });

  // ─── Nothing operational is ever copied ─────────────────────────────────────
  describe('a new company starts with NO operational or another company\'s business data', () => {
    it('every company-owned table outside the starter/setup set is empty — customers, suppliers, stock, tags, invoices, ledger, audit, devices…', async () => {
      const heavy = await provision();
      // Give the first company real operational data, THEN provision another: it must still start clean.
      const cl = await prisma.client.create({ data: { companyId: heavy.company.id, clientCode: 'C1', name: 'Vasavi Customer', type: 'RETAIL' } });
      await prisma.supplier.create({ data: { companyId: heavy.company.id, supplierCode: 'S1', name: 'Vasavi Supplier', type: 'OTHER' } });
      expect(cl.id).toBeTruthy();

      const fresh = await provision();
      const counts = await companyRowCounts(fresh.company.id);
      for (const [table, n] of Object.entries(counts)) {
        if (STARTER_OR_SETUP_TABLES.has(table)) continue;
        expect(n, `${table} must be empty for a new company`).toBe(0);
      }
      expect(counts.company_users).toBe(1);
      expect(counts.branches).toBe(1);
    });
  });

  // ─── Company code ───────────────────────────────────────────────────────────
  describe('company code', () => {
    it('is normalized (stored upper-case) so login always finds it', async () => {
      const raw = uniqueCompanyCode('lc').toLowerCase();
      const r = await provision({ code: `  ${raw}  `, admin: { email: `${raw}${EMAIL_DOMAIN}`, name: 'Admin Person', password: ADMIN_PASSWORD } });
      expect(r.company.code).toBe(raw.toUpperCase());
      expect((await pub().post('/auth/login', { companyCode: raw, identifier: r.admin.email, password: ADMIN_PASSWORD })).status).toBe(200);
    });

    it('a duplicate — exact, different case, or a look-alike — is refused, and nothing is left behind', async () => {
      const first = await provision({ code: uniqueCompanyCode('VS') });
      const before = await prisma.company.count();
      for (const dup of [first.company.code, first.company.code.toLowerCase(), first.company.code.replace(/I/g, '1').replace(/O/g, '0').replace(/L/g, '1') + '']) {
        // (a look-alike only differs if the code contains I/O/L; the exact/lower-case variants always do)
        const email = `dup${Math.random().toString(36).slice(2, 8)}${EMAIL_DOMAIN}`;
        await expect(provisionCompany({ code: dup, name: 'Dup Co', admin: { email, name: 'Dup Admin', password: ADMIN_PASSWORD } }))
          .rejects.toMatchObject({ statusCode: 409, message: 'That company code is not available' });
        expect(await prisma.user.count({ where: { email } })).toBe(0);
      }
      expect(await prisma.company.count()).toBe(before);
    });

    it('a look-alike of an existing code is refused (VASAV1 vs VASAVI)', async () => {
      let base = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        base = `VLK${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[0-9LIOSB]/g, 'Q')}I`;
        try { await provision({ code: base }); break; }
        catch (e: any) { if (e.statusCode !== 409 || attempt === 7) throw e; } // a look-alike of some leftover code — pick another
      }
      const lookalike = base.slice(0, -1) + '1';
      await expect(provisionCompany({ code: lookalike, name: 'x co', admin: { email: `la${Date.now()}${EMAIL_DOMAIN}`, name: 'Admin', password: ADMIN_PASSWORD } }))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('malformed and reserved codes are refused before anything is written', async () => {
      const before = await prisma.company.count();
      for (const code of ['', 'AB', 'HAS SPACE', 'BAD-CODE', "X'; DROP TABLE companies;--", '1LEADING']) {
        await expect(provisionCompany({ code, name: 'Bad Co', admin: { email: `b${Date.now()}${EMAIL_DOMAIN}`, name: 'Admin', password: ADMIN_PASSWORD } }))
          .rejects.toMatchObject({ statusCode: 400 });
      }
      for (const code of ['admin', 'TRIVO', 'platform', 'root']) {
        await expect(provisionCompany({ code, name: 'Reserved Co', admin: { email: `r${Date.now()}${EMAIL_DOMAIN}`, name: 'Admin', password: ADMIN_PASSWORD } }))
          .rejects.toMatchObject({ statusCode: 400, message: 'That company code is reserved' });
      }
      expect(await prisma.company.count()).toBe(before);
    });

    it('bad input is refused: weak password, bad email, tiny name, unknown package version', async () => {
      const code = () => uniqueCompanyCode();
      const ok = () => ({ email: `x${Date.now()}${Math.random().toString(36).slice(2, 5)}${EMAIL_DOMAIN}`, name: 'Admin', password: ADMIN_PASSWORD });
      await expect(provisionCompany({ code: code(), name: 'Co One', admin: { ...ok(), password: 'short' } })).rejects.toMatchObject({ statusCode: 400 });
      await expect(provisionCompany({ code: code(), name: 'Co One', admin: { ...ok(), email: 'not-an-email' } })).rejects.toMatchObject({ statusCode: 400 });
      await expect(provisionCompany({ code: code(), name: 'X', admin: ok() })).rejects.toMatchObject({ statusCode: 400 });
      await expect(provisionCompany({ code: code(), name: 'Co One', admin: ok(), starterPackageVersion: 999 })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ─── Atomicity ──────────────────────────────────────────────────────────────
  describe('provisioning is all-or-nothing', () => {
    it.each(ALL_STEPS)('a failure right after the "%s" step rolls EVERYTHING back — no half-created company', async (failAt) => {
      const code = uniqueCompanyCode('RB');
      const email = `${code.toLowerCase()}${EMAIL_DOMAIN}`;
      const companiesBefore = await prisma.company.count();
      const auditBefore = await prisma.platformAuditLog.count({ where: { action: 'COMPANY_PROVISIONED' } });

      await expect(provisionCompany(
        { code, name: `Rollback ${failAt}`, admin: { email, name: 'Admin Person', password: ADMIN_PASSWORD } },
        { hooks: { afterStep: (s) => { if (s === failAt) throw new Error(`injected failure after ${s}`); } } },
      )).rejects.toThrow(/injected failure/);

      expect(await prisma.company.findUnique({ where: { code } })).toBeNull();
      expect(await prisma.company.count()).toBe(companiesBefore);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      expect(await prisma.platformAuditLog.count({ where: { action: 'COMPANY_PROVISIONED' } })).toBe(auditBefore);
      // the code is free again: a retry succeeds
      const retry = await provisionCompany({ code, name: 'Retry Co', admin: { email, name: 'Admin Person', password: ADMIN_PASSWORD } });
      createdCompanyIds.push(retry.company.id);
      expect(retry.company.code).toBe(code);
    });

    it('a REAL failure (a package that leaves the company incomplete) is caught by verification and rolled back', async () => {
      const broken = clone(); broken.version = 3;
      broken.chartOfAccounts = broken.chartOfAccounts.filter((a) => a.code !== '1300'); // the ledger needs 1300 (Inventory)
      registerStarterPackage(broken);
      try {
        const code = uniqueCompanyCode('BK');
        await expect(provisionCompany({ code, name: 'Broken Pkg Co', starterPackageVersion: 3, admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Admin', password: ADMIN_PASSWORD } }))
          .rejects.toThrow(/verification failed[\s\S]*missing ledger account 1300/);
        expect(await prisma.company.findUnique({ where: { code } })).toBeNull();
      } finally {
        _unregisterStarterPackageForTests(3);
      }
    });
  });

  // ─── Copy, never share ──────────────────────────────────────────────────────
  describe('the Starter Package is COPIED into each company — never shared', () => {
    const IDENTITY_TABLES = ['karatMaster', 'designCategory', 'productCategory', 'subCategory', 'materialCode', 'stockType', 'stoneType', 'stoneGrade', 'tagTemplate', 'estimateTemplate', 'systemConfig', 'account', 'role'] as const;

    it('two companies share NO rows: every starter row has its own id and belongs to exactly one company', async () => {
      const a = await provision(); const b = await provision();
      for (const model of IDENTITY_TABLES) {
        const rowsA = await (prisma as any)[model].findMany({ where: { companyId: a.company.id }, select: { id: true } });
        const rowsB = await (prisma as any)[model].findMany({ where: { companyId: b.company.id }, select: { id: true } });
        expect(rowsA.length, model).toBeGreaterThan(0);
        expect(rowsA.length, model).toBe(rowsB.length);
        const idsA = new Set(rowsA.map((r: { id: string }) => r.id));
        for (const r of rowsB) expect(idsA.has(r.id), `${model} row shared`).toBe(false);
      }
    });

    it('A renames "Necklaces" and deletes "SILVER": B\'s copies are unchanged', async () => {
      const a = await provision(); const b = await provision();
      const snapshot = async (id: string) => ({
        cat: await prisma.productCategory.findUniqueOrThrow({ where: { companyId_code: { companyId: id, code: 'NKL' } } }),
        silver: await prisma.karatMaster.findUnique({ where: { companyId_code: { companyId: id, code: 'SILVER' } } }),
      });
      const bBefore = await snapshot(b.company.id);

      await prisma.productCategory.update({ where: { companyId_code: { companyId: a.company.id, code: 'NKL' } }, data: { name: 'Vasavi Bridal Necklaces' } });
      await prisma.karatMaster.delete({ where: { companyId_code: { companyId: a.company.id, code: 'SILVER' } } });

      const bAfter = await snapshot(b.company.id);
      expect(bAfter.cat.name).toBe('Necklaces');
      expect(bAfter.cat).toEqual(bBefore.cat);
      expect(bAfter.silver).not.toBeNull();
      expect(bAfter.silver).toEqual(bBefore.silver);
    });

    it('and the reverse: B deletes a category and edits its template + config, A unchanged', async () => {
      const a = await provision(); const b = await provision();
      const aBefore = {
        cats: await prisma.productCategory.count({ where: { companyId: a.company.id } }),
        tpl: await prisma.tagTemplate.findFirstOrThrow({ where: { companyId: a.company.id }, select: { name: true, widthMm: true, layout: true } }),
        cfg: (await prisma.systemConfig.findUniqueOrThrow({ where: { companyId_key: { companyId: a.company.id, key: 'DEFAULT_GOLD_MARGIN' } } })).value,
      };
      await prisma.categorySubCategory.deleteMany({ where: { companyId: b.company.id, categoryId: (await prisma.productCategory.findUniqueOrThrow({ where: { companyId_code: { companyId: b.company.id, code: 'RNG' } } })).id } });
      await prisma.productCategory.delete({ where: { companyId_code: { companyId: b.company.id, code: 'RNG' } } });
      await prisma.tagTemplate.updateMany({ where: { companyId: b.company.id }, data: { name: 'Shree Tag', widthMm: 99 } });
      await prisma.systemConfig.update({ where: { companyId_key: { companyId: b.company.id, key: 'DEFAULT_GOLD_MARGIN' } }, data: { value: '99' } });

      expect(await prisma.productCategory.count({ where: { companyId: a.company.id } })).toBe(aBefore.cats);
      const tplA = await prisma.tagTemplate.findFirstOrThrow({ where: { companyId: a.company.id }, select: { name: true, widthMm: true, layout: true } });
      expect(tplA).toEqual(aBefore.tpl);
      expect((await prisma.systemConfig.findUniqueOrThrow({ where: { companyId_key: { companyId: a.company.id, key: 'DEFAULT_GOLD_MARGIN' } } })).value).toBe(aBefore.cfg);
    });

    it('deleting an entire company leaves every other company\'s starter data intact', async () => {
      const a = await provision(); const b = await provision();
      const before = await companyRowCounts(b.company.id);
      await purgeCompany(a.company.id);
      createdCompanyIds.splice(createdCompanyIds.indexOf(a.company.id), 1);
      expect(await companyRowCounts(b.company.id)).toEqual(before);
    });
  });

  // ─── Versioning ─────────────────────────────────────────────────────────────
  describe('Starter Package versioning', () => {
    it('a newer package reaches only NEW companies; existing companies are never changed', async () => {
      const v1Company = await provision({ starterPackageVersion: 1 });
      const v1Snapshot = await companyRowCounts(v1Company.company.id);
      const v1Config = (await prisma.systemConfig.findUniqueOrThrow({ where: { companyId_key: { companyId: v1Company.company.id, key: 'DEFAULT_GOLD_MARGIN' } } })).value;

      const v2 = clone(); v2.version = 2; v2.name = 'TRIVO Starter Package v2 (test)';
      v2.masters.productCategories.push({ code: 'WCH', name: 'Watches' });
      v2.config = [{ key: 'DEFAULT_GOLD_MARGIN', value: '12', category: 'PRICING' }];
      registerStarterPackage(v2);
      try {
        // A company provisioned after v2 exists gets v2 by default…
        const v2Company = await provision();
        expect(v2Company.starterPackage.version).toBe(2);
        expect(await prisma.productCategory.findUnique({ where: { companyId_code: { companyId: v2Company.company.id, code: 'WCH' } } })).not.toBeNull();
        expect((await prisma.systemConfig.findUniqueOrThrow({ where: { companyId_key: { companyId: v2Company.company.id, key: 'DEFAULT_GOLD_MARGIN' } } })).value).toBe('12');
        expect((await prisma.company.findUniqueOrThrow({ where: { id: v2Company.company.id } })).starterPackageVersion).toBe(2);

        // …the company provisioned earlier is completely untouched…
        expect(await companyRowCounts(v1Company.company.id)).toEqual(v1Snapshot);
        expect(await prisma.productCategory.findUnique({ where: { companyId_code: { companyId: v1Company.company.id, code: 'WCH' } } })).toBeNull();
        expect((await prisma.systemConfig.findUniqueOrThrow({ where: { companyId_key: { companyId: v1Company.company.id, key: 'DEFAULT_GOLD_MARGIN' } } })).value).toBe(v1Config);
        expect((await prisma.company.findUniqueOrThrow({ where: { id: v1Company.company.id } })).starterPackageVersion).toBe(1);

        // …and a new company can still be pinned to v1 explicitly.
        const pinned = await provision({ starterPackageVersion: 1 });
        expect(pinned.starterPackage.version).toBe(1);
        expect(await prisma.productCategory.findUnique({ where: { companyId_code: { companyId: pinned.company.id, code: 'WCH' } } })).toBeNull();
      } finally {
        _unregisterStarterPackageForTests(2);
      }
      expect(getStarterPackage(1)).toBe(STARTER_PACKAGE_V1); // v1 itself never changed
    });

    it('the original SEA-era company (provisioned before starter packages) has NULL — it was never "upgraded"', async () => {
      const sea = await prisma.company.findUnique({ where: { code: 'SEA' } });
      if (sea) expect(sea.starterPackageVersion).toBeNull();
    });
  });

  // ─── The administrator is never silently attached ───────────────────────────
  describe('when the admin e-mail already has a login', () => {
    it('it is NOT attached: a pending SUPER_ADMIN invitation is created, and only accepting (with that login\'s password) links it', async () => {
      const first = await provision();
      const email = first.admin.email; // already a login (admin of `first`)

      const second = await provision({ admin: { email, name: 'Ignored Name', password: 'a-different-Passw0rd-1' } });
      expect(second.admin.mode).toBe('INVITATION');
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await prisma.companyUser.count({ where: { companyId: second.company.id, userId: user.id } })).toBe(0);
      expect(await prisma.companyUser.count({ where: { companyId: second.company.id } })).toBe(0); // no admin yet
      // the supplied "different" password was NOT applied to the existing login
      expect((await pub().post('/auth/login', { companyCode: first.company.code, identifier: email, password: ADMIN_PASSWORD })).status).toBe(200);
      expect((await pub().post('/auth/login', { companyCode: second.company.code, identifier: email, password: ADMIN_PASSWORD })).status).toBe(401); // not a member yet

      const inv = (second.admin as any);
      expect((await pub().post('/auth/invitations/accept', { token: inv.token, name: 'Whoever', password: 'wrong-password-123' })).status).toBe(400);
      const ok = await pub().post('/auth/invitations/accept', { token: inv.token, name: 'Whoever', password: ADMIN_PASSWORD });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const login = await pub().post('/auth/login', { companyCode: second.company.code, identifier: email, password: ADMIN_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.data.user.role).toBe('SUPER_ADMIN');
      expect(login.body.data.company.id).toBe(second.company.id);
    });
  });
});
