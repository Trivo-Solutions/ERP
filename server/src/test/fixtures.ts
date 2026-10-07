import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { platformPrisma as prisma, prisma as runtimePrisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { env } from '../config/env';
import { TenantContext } from '../shared/tenantContext';
import { seedChartOfAccounts } from '../modules/finance/finance.service';
import { seedStarterMasters } from '../shared/starterMasters';

// Shared test-fixture helper — creates a full, minimal tenant (Company + Role + User +
// CompanyUser + Branch) and returns a ready-made TenantContext, so individual test files don't
// each need to hand-roll prisma.role.create/prisma.user.create (which broke across every
// existing test file the moment Role became company-owned and User lost its direct roleId —
// see the multi-tenant migration).
export interface TestTenant {
  company: { id: string; code: string };
  role: { id: string; name: string; permissions: string[] };
  user: { id: string; email: string };
  branch: { id: string; branchCode: string };
  companyUser: { id: string };
  ctx: TenantContext;
}

export async function createTestTenant(suffix: string, permissions: string[]): Promise<TestTenant> {
  // stateCode defaults to '24' (Gujarat) to match every pre-existing test's assumption of the
  // company's "home state" (inherited from the old process.env.COMPANY_STATE_CODE ?? '24'
  // default that createInvoice/convertMemoToInvoice used before the multi-tenant migration
  // moved this onto the Company row itself — see sales.service.ts's fix for why that env var
  // read was itself a cross-tenant bug).
  const company = await prisma.company.create({
    data: { code: `TST-${suffix}`, name: `Test Company ${suffix}`, stateCode: '24', gstin: '24TESTGSTIN0001Z' },
  });
  const role = await prisma.role.create({
    data: { companyId: company.id, name: `TEST_ROLE_${suffix}`, displayName: 'Test Role', permissions },
  });
  const user = await prisma.user.create({
    data: { email: `test-${suffix}@example.com`, password: 'x', name: 'Test User' },
  });
  const branch = await prisma.branch.create({
    data: { companyId: company.id, branchCode: `TSTBR-${suffix}`, name: 'Test Branch' },
  });
  const companyUser = await prisma.companyUser.create({
    data: { companyId: company.id, userId: user.id, roleId: role.id, allBranches: true },
  });

  // Every tenant gets a full chart of accounts (idempotent upsert) so postAutoJournalEntry
  // never fails on a missing account for a test company — same seeding prod does via
  // prisma/seed.ts on company creation.
  await seedChartOfAccounts(company.id);

  // Karat/purity list + design categories are company-owned now (Phase 1 of full company
  // isolation) — a new tenant starts with the standard starter set, same as a real provisioned
  // company. Everything else a test needs (categories, stock types, ...) it creates itself, with
  // this tenant's companyId.
  await seedStarterMasters(company.id);

  const ctx: TenantContext = {
    companyId: company.id,
    companyUserId: companyUser.id,
    userId: user.id,
    roleId: role.id,
    roleName: role.name,
    permissions: role.permissions,
    branchAccess: { allBranches: true, branchIds: [branch.id] },
  };

  return { company, role, user, branch, companyUser, ctx };
}

/** Second branch in the same tenant, for branch-restriction tests. */
export async function addBranch(companyId: string, suffix: string) {
  return prisma.branch.create({
    data: { companyId, branchCode: `TSTBR2-${suffix}`, name: 'Second Test Branch' },
  });
}

/**
 * Deletes every master a company owns, in dependency order (master->master children first:
 * stone_grades -> stone_types, sub_categories -> product_categories). Callers must have removed
 * everything that REFERENCES a master (tags, tag materials, making charges, price masters,
 * designs, invoice items) first. Exported for tests that build their companies by hand instead of
 * through createTestTenant.
 */
export async function deleteCompanyMasters(companyId: string) {
  await prisma.size.deleteMany({ where: { companyId } }); // refs product_categories (RESTRICT)
  await prisma.stoneGrade.deleteMany({ where: { companyId } });
  await prisma.categorySubCategory.deleteMany({ where: { companyId } });
  await prisma.subCategory.deleteMany({ where: { companyId } });
  await Promise.all([
    prisma.stoneType.deleteMany({ where: { companyId } }),
    prisma.stockType.deleteMany({ where: { companyId } }),
    prisma.materialCode.deleteMany({ where: { companyId } }),
    prisma.collection.deleteMany({ where: { companyId } }),
    prisma.productCategory.deleteMany({ where: { companyId } }),
    prisma.karatMaster.deleteMany({ where: { companyId } }),
    prisma.designCategory.deleteMany({ where: { companyId } }),
  ]);
}

export async function cleanupTestTenant(t: TestTenant) {
  const companyId = t.company.id;

  // Phase 3 made ~40 more tables company-owned. Individual test files are expected to clean up
  // whatever they created themselves (tags, invoices, journal entries, ...) before calling this —
  // this is a defensive backstop so a row a test forgot to track (e.g. a MetalStock row from
  // createOldGoldExchange) doesn't leave company deletion blocked by a RESTRICT FK. Deletes run
  // in dependency waves, leaves first, so a wave's deleteMany on an already-empty relation is
  // just a harmless no-op, not an error.

  // Purchase lots sit between JewelryTag (purchaseLotId) and GrnItem (grnItemId), both RESTRICT: detach the
  // tags, drop the lots, and only then can Wave 1 remove the GRN lines.
  await prisma.jewelryTag.updateMany({ where: { companyId, purchaseLotId: { not: null } }, data: { purchaseLotId: null } });
  await prisma.purchaseLot.deleteMany({ where: { companyId } });
  // Vendor component pricing: rates hang off GRN lines / PO lines / suppliers / stone masters (RESTRICT or cascade).
  await prisma.grnItemComponentRate.deleteMany({ where: { companyId } });
  await prisma.poItemComponent.deleteMany({ where: { companyId } });
  await prisma.vendorComponentRate.deleteMany({ where: { companyId } });

  // Returned-jewellery pipeline: leaf-first (retags/transfer items -> transfers -> cases), all before the return lines and tags they point at.
  await prisma.tagRetag.deleteMany({ where: { companyId } });
  await prisma.repairTransferItem.deleteMany({ where: { companyId } });
  await prisma.repairTransfer.deleteMany({ where: { companyId } });
  await prisma.repairCase.deleteMany({ where: { companyId } });
  await prisma.salesReturnItem.deleteMany({ where: { companyId } }); // before invoiceItem (RESTRICT) — not in the parallel batch below
  // Customer advances reference invoice payments / invoices / clients (all RESTRICT): applications first, then advances.
  await prisma.customerAdvanceApplication.deleteMany({ where: { companyId } });
  await prisma.customerAdvance.deleteMany({ where: { companyId } });
  // Wave 1 — deepest leaves (detail/child rows with no further children of their own).
  await Promise.all([
    prisma.stockAuditItem.deleteMany({ where: { companyId } }),
    prisma.branchTransferItem.deleteMany({ where: { companyId } }),
    prisma.jewelryTagMaterial.deleteMany({ where: { companyId } }),
    prisma.exportDocument.deleteMany({ where: { companyId } }),
    prisma.taxInvoice.deleteMany({ where: { companyId } }),
    prisma.supplierPayment.deleteMany({ where: { companyId } }),
    prisma.purchaseReturnItem.deleteMany({ where: { companyId } }),
    prisma.poItemCategory.deleteMany({ where: { companyId } }),
    prisma.grnItem.deleteMany({ where: { companyId } }),
    prisma.prItem.deleteMany({ where: { companyId } }),
    prisma.approvalHistory.deleteMany({ where: { companyId } }),
    prisma.bomItem.deleteMany({ where: { companyId } }),
    prisma.bomProcess.deleteMany({ where: { companyId } }),
    prisma.designFile.deleteMany({ where: { companyId } }),
    prisma.materialReservation.deleteMany({ where: { companyId } }),
    prisma.clientNotification.deleteMany({ where: { companyId } }),
    prisma.wipTracking.deleteMany({ where: { companyId } }),
    prisma.qcCheckpoint.deleteMany({ where: { companyId } }),
    prisma.karigarLedger.deleteMany({ where: { companyId } }),
    prisma.hallmarkingItem.deleteMany({ where: { companyId } }),
    prisma.repairTransaction.deleteMany({ where: { companyId } }),
    prisma.tagEstimateItem.deleteMany({ where: { companyId } }),
    prisma.journalLine.deleteMany({ where: { companyId } }),
    prisma.invoiceItem.deleteMany({ where: { companyId } }),
    prisma.memoItem.deleteMany({ where: { companyId } }),
    prisma.consumableTransaction.deleteMany({ where: { companyId } }),
    prisma.stoneLotSplit.deleteMany({ where: { companyId } }),
  ]);

  // Wave 2 — things whose children are now gone, and which are themselves referenced by Wave-3
  // "hub" tables (JobCard, JewelryTag) but reference nothing further down.
  await prisma.poItem.deleteMany({ where: { companyId } });
  await prisma.repairJob.deleteMany({ where: { companyId } }); // after repairTransaction
  await prisma.hallmarkingBatch.deleteMany({ where: { companyId } }); // after hallmarkingItem
  await prisma.tagEstimate.deleteMany({ where: { companyId } }); // after tagEstimateItem
  await prisma.jobProcess.deleteMany({ where: { companyId } }); // after wipTracking/qcCheckpoint
  await prisma.oldGoldExchange.deleteMany({ where: { companyId } }); // a tagged buy-back references its tag
  await prisma.jewelryTag.deleteMany({ where: { companyId } }); // after jewelryTagMaterial/memoItem/etc — a test's own createdTagIds cleanup normally beats us to this
  await prisma.costEstimate.deleteMany({ where: { companyId } });

  // Wave 3 — JobCard sits in the middle of the manufacturing web (JewelryTag.jobCardId,
  // RepairJob/HallmarkingItem.jobCardId, JobProcess all point at it) — everything that could
  // reference it is gone by now (Wave 1/2 above, or the test's own cleanup ran first). OrderItem
  // is JobCard's own parent (JobCard.orderItemId -> OrderItem), so it must be deleted AFTER
  // JobCard, not before; SalesOrder after OrderItem for the same reason.
  await prisma.jobCard.deleteMany({ where: { companyId } });
  await prisma.orderItem.deleteMany({ where: { companyId } }); // after jobCard, materialReservation, clientNotification
  await prisma.salesOrder.deleteMany({ where: { companyId } }); // after orderItem/jobCard/materialReservation/clientNotification
  await prisma.design.deleteMany({ where: { companyId } }); // after bomItem/bomProcess/designFile/costEstimate/jobCard/jewelryTag

  // Wave 4 — document headers (their own item/detail rows are already gone).
  await Promise.all([
    prisma.stockAudit.deleteMany({ where: { companyId } }),
    prisma.branchTransfer.deleteMany({ where: { companyId } }),
    prisma.purchaseReturn.deleteMany({ where: { companyId } }),
    prisma.purchaseOrder.deleteMany({ where: { companyId } }), // after poItem/grnItem/goodsReceiptNote
    prisma.purchaseRequisition.deleteMany({ where: { companyId } }), // after prItem/approvalHistory
    prisma.subcontractorInvoice.deleteMany({ where: { companyId } }),
    prisma.journalEntry.deleteMany({ where: { companyId } }), // after journalLine
    prisma.invoicePayment.deleteMany({ where: { companyId } }),
    prisma.salesReturn.deleteMany({ where: { companyId } }), // after salesReturnItem
    prisma.memoOut.deleteMany({ where: { companyId } }), // after memoItem
  ]);
  await prisma.goodsReceiptNote.deleteMany({ where: { companyId } }); // after grnItem, before purchaseOrder already ran above — safe no-op if it didn't
  await prisma.salesInvoice.deleteMany({ where: { companyId } }); // after invoiceItem/taxInvoice/exportDocument/salesReturn/invoicePayment
  await prisma.oldGoldExchange.deleteMany({ where: { companyId } });

  // Wave 5 — company's own master/reference/inventory data (no more transactional rows point at
  // these).
  await prisma.metalStockMovement.deleteMany({ where: { companyId } });
  await Promise.all([
    prisma.metalStock.deleteMany({ where: { companyId } }),
    prisma.stoneLot.deleteMany({ where: { companyId } }),
    prisma.consumable.deleteMany({ where: { companyId } }),
    prisma.artisan.deleteMany({ where: { companyId } }),
    prisma.supplier.deleteMany({ where: { companyId } }),
    prisma.hardwareDevice.deleteMany({ where: { companyId } }),
    prisma.metalRate.deleteMany({ where: { companyId } }),
    prisma.priceMaster.deleteMany({ where: { companyId } }),
    prisma.makingCharge.deleteMany({ where: { companyId } }),
    prisma.processTolerance.deleteMany({ where: { companyId } }),
    prisma.tagTemplate.deleteMany({ where: { companyId } }),
    prisma.estimateTemplate.deleteMany({ where: { companyId } }),
    prisma.costCenter.deleteMany({ where: { companyId } }),
    prisma.systemConfig.deleteMany({ where: { companyId } }),
    // G8a — cascades to its own credentials/request-log rows (both ON DELETE CASCADE to this).
    prisma.gstIntegrationConfig.deleteMany({ where: { companyId } }),
  ]);

  // Wave 6 — the company's own masters (Phase 1 of full company isolation). Everything that
  // referenced them (tags, tag materials, making charges, price masters, designs, invoice items)
  // is gone by now. Master->master children first: stone_grades -> stone_types,
  // sub_categories -> product_categories.
  await deleteCompanyMasters(companyId);

  // FK-ordering matters: audit_logs -> users (RESTRICT), number_sequences -> companies
  // (RESTRICT), company_users -> {companies,users,roles}, user_branch_access -> company_users —
  // children before parents throughout. Accounts (seeded fresh per tenant by
  // seedChartOfAccounts above) must go before the company too — assumes the calling test file's
  // own afterAll already cleaned up any JournalEntry/JournalLine rows referencing them (via
  // cleanupJournalEntries), same precondition every existing test file already met when accounts
  // were global.
  // Phase 2: everything identity-related that belongs to this company is removed no matter who
  // created it — audit_logs.companyId is required + RESTRICT now, and a test may have added extra
  // members, roles, branch grants and invitations. Invitations first (they reference roles and the
  // membership they created).
  await prisma.auditLog.deleteMany({ where: { companyId } });
  await prisma.companyInvitation.deleteMany({ where: { companyId } });
  await prisma.userBranchAccess.deleteMany({ where: { companyId } });
  await prisma.companyUser.deleteMany({ where: { companyId } });
  await prisma.branch.deleteMany({ where: { companyId } });
  await prisma.role.deleteMany({ where: { companyId } });
  await prisma.auditLog.deleteMany({ where: { userId: t.user.id } });
  await prisma.user.deleteMany({ where: { id: t.user.id } });
  await prisma.numberSequence.deleteMany({ where: { companyId } });
  await prisma.account.deleteMany({ where: { companyId } });
  await prisma.tagHistory.deleteMany({ where: { companyId } }); // written by a trigger on every tag change/delete above
  await prisma.client.deleteMany({ where: { companyId } }); // after every invoice/payment/return/exchange that references a client
  await prisma.company.deleteMany({ where: { id: companyId } });
}

// ─── Identity helpers (Phase 2) ───────────────────────────────────────────────

/** A signed access token for a fixture tenant's own user — the same claims login() issues. */
export function tokenFor(t: TestTenant): string {
  return jwt.sign(
    {
      userId: t.user.id, email: t.user.email, companyId: t.company.id, companyUserId: t.companyUser.id,
      roleId: t.role.id, roleName: t.role.name, permissions: t.role.permissions, branchAccess: t.ctx.branchAccess,
    },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

/** A tiny supertest wrapper bound to one bearer token, addressing /api/v1. */
export function apiWith(token: string | undefined, app: import('express').Express) {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return {
    get: (p: string) => request(app).get(`/api/v1${p}`).set(auth),
    post: (p: string, body: object = {}) => request(app).post(`/api/v1${p}`).set(auth).send(body),
    patch: (p: string, body: object) => request(app).patch(`/api/v1${p}`).set(auth).send(body),
    put: (p: string, body: object) => request(app).put(`/api/v1${p}`).set(auth).send(body),
    del: (p: string) => request(app).delete(`/api/v1${p}`).set(auth),
  };
}

/**
 * Creates a REAL login (bcrypt password) for an email, or reuses an existing global User by id, and
 * adds a membership in the given company. Returns everything a test needs. The caller is
 * responsible for deleting extra users it creates (cleanupTestTenant removes the memberships).
 */
export async function createMember(opts: {
  companyId: string; roleId: string; email: string; password?: string; name?: string;
  existingUserId?: string; username?: string; employeeId?: string; department?: string; phone?: string;
  allBranches?: boolean;
}) {
  const password = opts.password ?? 'Test-Passw0rd!';
  const user = opts.existingUserId
    ? await prisma.user.findUniqueOrThrow({ where: { id: opts.existingUserId } })
    : await prisma.user.create({ data: { email: opts.email.toLowerCase(), password: await bcrypt.hash(password, 4), name: opts.name ?? 'Test Member' } });
  const membership = await prisma.companyUser.create({
    data: {
      companyId: opts.companyId, userId: user.id, roleId: opts.roleId, allBranches: opts.allBranches ?? true,
      username: opts.username, employeeId: opts.employeeId, department: opts.department, phone: opts.phone,
    },
  });
  return { user, membership, password };
}

// ─── Provisioned-company helpers (Phase 3) ────────────────────────────────────

/** A unique, valid company code for tests: 3-12 chars, A-Z0-9, starts with a letter. */
export function uniqueCompanyCode(prefix = 'T'): string {
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${prefix}${rand}`.slice(0, 12);
}

/**
 * Deletes a company and EVERYTHING it owns, whatever created it. The set of tables is discovered
 * from the database (every table with a "companyId" column) rather than hand-listed, so it cannot
 * fall out of date as the schema grows. Multi-pass: rows whose delete is blocked by a foreign key
 * are retried after their dependants have gone. Also removes the platform audit rows about the company.
 */
export async function purgeCompany(companyId: string): Promise<void> {
  const tables: Array<{ table_name: string }> = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'companyId' AND table_name <> 'companies'`);
  let pending = tables.map((t) => t.table_name);
  for (let pass = 0; pass < 12 && pending.length > 0; pass++) {
    const stillPending: string[] = [];
    for (const t of pending) {
      try { await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "companyId" = $1`, companyId); }
      catch { stillPending.push(t); }
    }
    if (stillPending.length === pending.length) break; // no progress
    pending = stillPending;
  }
  // The tag_history trigger logs the deletion of every tag above, so it is cleared AFTER them (it is
  // append-only for the app, but the test fixtures run as the owner/platform role).
  await prisma.$executeRawUnsafe(`DELETE FROM tag_history WHERE "companyId" = $1`, companyId);
  await prisma.$executeRawUnsafe(`DELETE FROM platform_audit_logs WHERE "subjectId" = $1`, companyId);
  await prisma.$executeRawUnsafe(`DELETE FROM companies WHERE id = $1`, companyId);
}

// ─── Isolation sweep helpers (Phases 3–5) ────────────────────────────────────

/**
 * Every route the application actually serves, discovered from Express's own router stack (so a new
 * endpoint is picked up automatically — a sweep built on a hand-written list would silently miss it).
 */
export function enumerateRoutes(app: import('express').Express): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const mountPath = (layer: any): string =>
    layer.regexp.source
      .replace(/^\^/, '')
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
      .replace(/\\\//g, '/');
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return out;
}

/** Every id (primary key) of every row a company owns, across all its tables — the set of "its" ids. */
export async function allCompanyRowIds(companyId: string): Promise<Set<string>> {
  const tables: Array<{ table_name: string }> = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
     WHERE c.table_schema='public' AND c.column_name='companyId' AND c.table_name <> 'companies'
       AND EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema='public' AND i.table_name=c.table_name AND i.column_name='id')`);
  const ids = new Set<string>();
  for (const t of tables) {
    const rows: Array<{ id: string }> = await prisma.$queryRawUnsafe(`SELECT id FROM "${t.table_name}" WHERE "companyId" = $1`, companyId);
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

/**
 * Database-wide audit: for EVERY foreign key between two company-owned tables, count child rows
 * whose company differs from their parent's. Must be empty — a non-empty result is a cross-company
 * reference (the thing RLS alone cannot prevent, since FK checks bypass RLS).
 */
export async function crossCompanyForeignKeyViolations(): Promise<Array<{ constraint: string; child: string; parent: string; violations: number }>> {
  const fks: Array<{ constraint_name: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }> = await prisma.$queryRawUnsafe(`
    SELECT con.conname AS constraint_name, cl.relname AS child, pl.relname AS parent,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_cols,
           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_cols
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_class pl ON pl.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = cl.oid AND attname = 'companyId' AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = pl.oid AND attname = 'companyId' AND NOT attisdropped)`);
  const bad: Array<{ constraint: string; child: string; parent: string; violations: number }> = [];
  for (const fk of fks) {
    const join = fk.child_cols.map((c, i) => `c."${c}" = p."${fk.parent_cols[i]}"`).join(' AND ');
    const nn = fk.child_cols.map((c) => `c."${c}" IS NOT NULL`).join(' AND ');
    const r: Array<{ n: number }> = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int n FROM "${fk.child}" c JOIN "${fk.parent}" p ON ${join} WHERE ${nn} AND c."companyId" <> p."companyId"`);
    if (r[0].n > 0) bad.push({ constraint: fk.constraint_name, child: fk.child, parent: fk.parent, violations: r[0].n });
  }
  return bad;
}

// ─── Row-level-security proof helper ─────────────────────────────────────────

/** True when the suite runs against a database with the REAL role split (npm run test:rls). */
export const REAL_ROLE_SPLIT = !!process.env.TRIVO_TEST_ENV_FILE;

const ROLLBACK = new Error('__deliberate_rollback__');

/** The connection RLS proofs run on: the runtime role when a real role split exists, else the (owner) test role + a transactional FORCE. */
export const rlsClient = REAL_ROLE_SPLIT ? runtimePrisma : prisma;

/**
 * Runs `fn` in a transaction that is ALWAYS rolled back, as a session bound by row-level security.
 *
 *  - Real role split (REAL_ROLE_SPLIT): the transaction runs on the application's own RUNTIME connection
 *    (role trivo_runtime — no ownership, no BYPASSRLS, tables already FORCEd). This is the genuine
 *    production guarantee; nothing needs to be switched on.
 *  - Single-role database (everyday runs): the connection's role owns the tables and would normally be
 *    exempt from RLS, so the given tables are temporarily FORCEd inside the transaction (DDL is
 *    transactional in Postgres, so this never persists).
 * The callback normally issues `SELECT set_config('app.tenant_company_id', <id>, true)` itself.
 */
export async function withForcedRls<T>(tables: string[], fn: (tx: any) => Promise<T>): Promise<T> {
  let result!: T;
  const client = REAL_ROLE_SPLIT ? runtimePrisma : prisma;
  try {
    await client.$transaction(async (tx) => {
      if (!REAL_ROLE_SPLIT) for (const t of tables) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      result = await fn(tx);
      throw ROLLBACK; // always roll back — proof-only, never persisted
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return result;
}
