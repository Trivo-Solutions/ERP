import { AsyncLocalStorage } from 'async_hooks';
import { Prisma } from '@prisma/client';
import { prisma, platformPrisma } from '../config/database';

// ═══════════════════════════════════════════════════
// Tenant context — plain data only, NEVER a live Prisma client/transaction.
//
// AsyncLocalStorage here carries the RESOLVED tenant identity (companyId, branch access,
// user) through a request's async call chain so deep service code and the audit-log helper
// don't need it threaded as an explicit parameter everywhere. It never carries a `tx` handle —
// a stored transaction client would (a) let one request's queries leak onto another request's
// connection if reused incorrectly, and (b) make it possible to hold a connection open across
// non-DB work (an external API call, PDF generation, a socket emit) by accident, which is
// exactly the "one long-lived interactive transaction per HTTP request" pattern this
// architecture deliberately rejects. Every actual DB transaction is opened fresh, short-lived,
// per operation, by the three helpers below.
//
// ─── THE ONE STANDARD PATTERN (read this before writing a new tenant-scoped query) ─────────
//
// Every service function that touches a tenant-scoped table picks exactly ONE of these three,
// based on the SHAPE of the work — never a fourth, ad-hoc, hand-rolled variant:
//
//   1. tenantQuery(companyId, tx => tx.model.method(...))
//        A single read or write. Use this for the overwhelming majority of calls: getX, listX,
//        a lone create/update/delete. Internally a 2-element BATCH transaction (SET LOCAL, then
//        the one operation) — see tenantBatch below for why batch form specifically.
//
//   2. tenantBatch(companyId, tx => [tx.a.findMany(...), tx.b.count(...)])
//        Two or more INDEPENDENT reads/writes with no conditional logic between them — the
//        Promise.all([...]) shape. Use this instead of tenantQuery when a function currently
//        does Promise.all([...]) against tenant-scoped tables. Batch form is preferred over the
//        interactive form here on purpose: a plain array of Prisma operations has no code slot
//        for a future developer to accidentally insert an external API call, a sleep, or
//        branching logic between the SET LOCAL and the queries — the shape itself prevents the
//        long-held-connection mistake.
//
//   3. tenantTransaction(companyId, async tx => { ...branching logic, conditional writes... })
//        A genuine multi-step BUSINESS transaction needing all-or-nothing atomicity AND
//        conditional logic between steps (status checks, count-guarded flips, linked writes) —
//        e.g. createInvoice's validate-tag / flip-status / post-journal sequence. This is the
//        ONLY form that may contain a callback body with real control flow.
//        HARD RULE, enforced by review: nothing inside `fn` may perform non-database I/O (no
//        fetch/HTTP call, no file/object-storage write, no email/SMS send, no socket emit, no
//        PDF/report generation). Any such work happens before (to gather inputs) or after (as a
//        side effect of a successful commit) — never inside. This is what keeps this form from
//        becoming the "one long transaction per request" anti-pattern: its lifetime is bounded
//        to DB work only, by convention, not by the type system.
//
// A service function that needs company-scoped access but ISN'T shaped like any of the three
// above (rare) should be treated as a sign the function is doing too much in one place, not a
// reason to inline a fourth pattern.
// ═══════════════════════════════════════════════════

export interface BranchAccess {
  allBranches: boolean;
  branchIds: string[];
}

export interface TenantContext {
  companyId: string;
  companyUserId: string;
  userId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  branchAccess: BranchAccess;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new Error(
      'No tenant context available — this code path must run inside an authenticated request ' +
      '(via resolveTenantContext middleware) or an explicit runAsCompany()/runAsPlatform() call.'
    );
  }
  return ctx;
}

/** True if `branchId` is one this tenant context is allowed to act on. */
export function canAccessBranch(ctx: TenantContext, branchId: string): boolean {
  return ctx.branchAccess.allBranches || ctx.branchAccess.branchIds.includes(branchId);
}

// ─── The three standard forms ────────────────────────────────────────────────
//
// SET LOCAL (via set_config(..., true)) is transaction-scoped — it resets automatically at
// COMMIT/ROLLBACK, which is exactly why the tenant session variable is set as the FIRST
// statement of the SAME short transaction the protected query runs in, never on a bare
// connection outside a transaction (where Prisma's internal pooling could hand that physical
// connection to a different, unrelated request next).

/** Form 2 — two or more independent operations, batch form. See the module doc above. */
export async function tenantBatch<T extends readonly Prisma.PrismaPromise<unknown>[]>(
  companyId: string,
  build: (tx: typeof prisma) => [...T]
): Promise<{ [K in keyof T]: T[K] extends Prisma.PrismaPromise<infer R> ? R : never }> {
  const ops = build(prisma);
  const results = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyId}, true)`,
    ...ops,
  ]);
  return results.slice(1) as any;
}

/** Form 1 — a single operation. Thin wrapper over tenantBatch for the common one-op case. */
export async function tenantQuery<T>(
  companyId: string,
  op: (tx: typeof prisma) => Prisma.PrismaPromise<T>
): Promise<T> {
  const [result] = await tenantBatch(companyId, (tx) => [op(tx)]);
  return result as T;
}

/** Form 3 — a multi-step business transaction with conditional logic. See the module doc above. */
export async function tenantTransaction<T>(
  companyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyId}, true)`;
    return fn(tx);
  });
}

/**
 * Platform-level access, deliberately bypassing tenant scoping — for migrations, platform-wide
 * master-data seeds, and operator tooling ONLY. Once RLS is enforced against the live
 * connection (see the RLS migration's own comment on why it isn't yet), this must run against a
 * Postgres role with BYPASSRLS, never the app's ordinary runtime role. Never reachable from an
 * ordinary company user's request.
 */
export async function runAsPlatform<T>(fn: (tx: typeof prisma) => Promise<T>): Promise<T> {
  return fn(platformPrisma);
}
