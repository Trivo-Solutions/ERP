# Company Isolation Audit — repo-wide sweep (2026-09-28)

> Requested as a standalone task, separate from and prerequisite to Phase J2/J3 (see `PHASE_J1_AUDIT.md`).
> Scope: every customer-owned record, query, route, background job, report, and the RLS config itself —
> verified against the live code, not assumed from documentation. Four concrete ownership-check gaps were
> found and **fixed** (code + regression tests) as part of this pass, since they are pure tenant-isolation
> bugs, not Phase J edit/delete/restore functionality. Nothing else was changed. Nothing was committed.

---

## 1. Method

1. Schema classification (below) done directly against `server/prisma/schema.prisma`.
2. Four parallel research passes, each independently verifying a different isolation surface against the
   live code (not against CLAUDE.md's own claims — several claims were re-derived from source, not trusted):
   - **Raw SQL & unscoped queries** — every `$queryRaw`/`$executeRaw` call site, every `findUnique`/`findFirst`/
     `update`/`updateMany`/`delete`/`deleteMany`/`upsert` call outside the modules Phase J1 already reviewed
     line-by-line, and the exact detection scope of the existing `tools/tenantAudit.ts` guard.
   - **Reports, exports, search, dashboards** — every aggregate/`groupBy`/`count` endpoint, whether any of them
     can leak cross-company via a client-supplied field, and whether branch-scoping is applied consistently
     where it's supposed to be.
   - **Background jobs, WebSocket, Redis, object storage, hardware** — independent verification of every
     claim in CLAUDE.md §11 phase 4, plus a fresh check for cron/queue infrastructure CLAUDE.md doesn't
     mention at all.
   - **RLS/DB config + existing test-coverage inventory** — diffed all 85 company-owned tables against the
     actual `CREATE POLICY tenant_isolation` statements in every migration, and inventoried exactly which
     isolation axis (read/create/update/delete/restore/FK/aggregate/search/export/file) each existing
     `tenantIsolation.*.test.ts` file actually exercises, per entity.
3. Four confirmed, previously-untested ownership-check gaps were fixed directly (small, bounded, no schema
   migration needed) with regression tests, then `tsc`, `audit:tenant`, the two touched test files, and the
   full suite were re-run.

---

## 2. Schema classification

90 Prisma models total. Confirmed by the RLS/test-coverage pass via an explicit diff against every
migration's `CREATE POLICY tenant_isolation` statement — **zero gap**: all 85 company-owned tables have a
policy; none of the other 5 do (correctly).

| Classification | Models |
|---|---|
| **GLOBAL / PLATFORM** | `Company` (the tenant root itself), `User` (global login identity, memberships live on `CompanyUser`), `PlatformAuditLog` |
| **SYSTEM / REFERENCE DATA** (platform-owned, read-only to every company) | `HsnCode`, `StateMaster` |
| **COMPANY-OWNED — branch-scoped within company** | `Branch`, `JewelryTag`, `GoodsReceiptNote`, `StockAudit`, `HardwareDevice`, `SalesInvoice`, `MemoOut`, `BranchTransfer`, `UserBranchAccess` |
| **COMPANY-OWNED — child of a company-owned parent** (no independent lifecycle) | `InvoiceItem`, `PoItem`, `PoItemCategory`, `GrnItem`, `JewelryTagMaterial`, `MemoItem`, `SalesReturnItem`, `PurchaseReturnItem`, `StockAuditItem`, `BranchTransferItem`, `JournalLine`, `TagEstimateItem`, `PrItem`, `ApprovalHistory`, `RepairTransaction`, `HallmarkingItem` |
| **COMPANY-OWNED — dormant manufacturing** (still tenant-scoped tables, just unused by the wholesale/retail loop per CLAUDE.md §2) | `JobCard`, `JobProcess`, `WipTracking`, `QcCheckpoint`, `Artisan`, `KarigarLedger`, `ProcessTolerance`, `SubcontractorInvoice`, `Design`, `BomItem`, `BomProcess`, `DesignFile`, `CostEstimate`, `SalesOrder`, `OrderItem`, `MaterialReservation`, `ClientNotification`, `StoneLot`, `StoneLotSplit`, `Consumable`, `ConsumableTransaction` |
| **COMPANY-OWNED — ordinary operational** | every remaining model (masters, `Client`/`Supplier`, `SalesInvoice`/`SalesReturn`/`MemoOut` family, `PurchaseOrder`/`GoodsReceiptNote`/`PurchaseLot` family, `Account`/`JournalEntry`/`CostCenter`, `RepairJob`/`HallmarkingBatch`, `AuditLog`, `CompanyUser`/`CompanyInvitation`/`Role`, `NumberSequence`, `SystemConfig`, etc.) |

`AuditLog` is company-owned (`companyId` NOT NULL) but its edit/delete surface is a hard `REVOKE` at the DB
grant level (see §4) — it's isolated *and* immutable, a stronger guarantee than ordinary company-owned data.

---

## 3. Findings by surface

### 3.1 Raw SQL & unscoped Prisma calls — **no live gap found in application code**

Every `$queryRaw`/`$executeRaw` call site reachable in production code is either non-customer-data (role/
system introspection at startup) or correctly parameterized by `companyId` / run inside an already
tenant-scoped transaction (`tenantContext.ts`'s own `set_config` primitive, `numberSequence.ts`'s atomic
increment, `amendInvoice`'s row-lock, `provisioning.service.ts`). Every `findUnique`/`update`/`delete`-family
call reviewed outside Phase J1's scope (reports, hardware non-device endpoints, platform non-provisioning
code, and a handful of scattered call sites in tagging/procurement/quality/sales/settings) follows the same
"ownership-check, then id-only operation inside a tenant-scoped call" convention used throughout the
codebase — no exception found.

**The gap is in the guard tool, not the application**: `tools/tenantAudit.ts`'s AST detector only matches a
`CallExpression` rooted at the bare identifier `prisma` — it cannot see `$queryRaw`/`$executeRaw` written as
a **tagged template** (`` prisma.$queryRaw`...` ``), which is the actual convention this codebase uses for
every real raw-SQL call site; and it never recognizes `platformPrisma` (the BYPASSRLS client) at all, so a
stray direct `platformPrisma.<companyModel>.<op>()` outside `runAsPlatform()` would pass with **zero**
warning. Neither is exploited today (verified by manual read of every site), but both mean a clean
`audit:tenant` run is not, by itself, proof of anything for those two patterns going forward. Documented as a
manual-review checklist item in CLAUDE.md rather than patched blindly — a reliable static fix would need to
distinguish legitimate scoped raw SQL (the scoping mechanism itself, atomic sequence increments, row locks)
from a hypothetical unscoped one, which the AST alone can't determine; a naive "flag every tagged-template
raw SQL" change would immediately false-positive on `tenantContext.ts`'s own mechanism.

### 3.2 Reports, dashboards, exports, search — **no cross-company leak found**

Every report/aggregate/`groupBy`/`count`/export/search/autocomplete endpoint checked (43 `.count()` sites, 7
`.groupBy()`, 2 `.aggregate()`, plus every named report function across finance/tagging/sales/procurement)
derives its company scope exclusively from `req.tenant!.companyId` / `ctx.companyId`, never from client
input — a repo-wide grep for `req.query.companyId`/`req.body.companyId` (and bracket-access variants) found
**zero matches** anywhere.

One real, non-leak finding: `getStockOnHand`/`getDeadStock` (`tagging.service.ts`) take only `companyId`,
unlike their sibling `getStockBook`/`listTags`/`searchTags`/`getSalesRegister`, which correctly restrict by
`ctx.branchAccess` for a branch-restricted user. A `STORE_MANAGER`/`SALES_MANAGER` scoped to one branch would
see every branch's stock through these two reports but only their own branch everywhere else in the same
module. This is a **branch-scoping inconsistency within one company**, not a cross-company isolation bug —
left as a finding for the team to schedule, not fixed in this pass (out of this task's scope, which is
company boundaries, not intra-company branch boundaries).

### 3.3 Background jobs, WebSocket, Redis, object storage, hardware — **CLAUDE.md §11 phase-4 claims all independently confirmed**

Every specific claim (company-namespaced socket rooms sourced only from a verified JWT; company suspension
actually disconnecting live sockets; Redis keys only ever produced through `cache.forCompany`; object-storage
keys enforced by both an app-level builder and a DB `CHECK` constraint; the `SCALE_PORT`/`RFID_READER_PORT`
env fallback genuinely removed; `NumberSequence` genuinely unique per `(companyId, documentType,
financialYear)`) was re-derived from source and, where a live-DB test exists, confirmed by that test — not
taken on the document's word. No cron/queue/scheduled-job infrastructure exists anywhere in the repo (grepped
for `node-cron`/`BullMQ`/`Bull`/`agenda`/`node-schedule` in both `package.json` files and across
`server/src`/`client/src`/`ops`/`server/scripts` — zero matches); the only non-HTTP customer-data touchpoint
is a benign scale-reconnect `setTimeout` already scoped by `companyId`. The only caveat (already honestly
documented in CLAUDE.md §12, re-confirmed true, not stale): the object-storage boundary is DB-enforced and
tested, but no MinIO/S3 client call exists anywhere yet — the boundary is unexercised against a live store
because nothing uses it yet.

### 3.4 RLS config & existing test coverage — **no policy-coverage gap; 5 real ownership gaps confirmed untested (now fixed)**

`db-secure.sql` grants FORCE-RLS coverage dynamically from `pg_policies`, not a hardcoded list, and every one
of the 85 company-owned tables has a matching policy — confirmed by direct diff, and independently guarded at
runtime by `tenantIsolation.masters.test.ts`'s own schema-guard test. `trivo_runtime` genuinely has no
BYPASSRLS and no ownership grants; `audit_logs` has an explicit `REVOKE UPDATE, DELETE`; `platform_audit_logs`
gets no grant at all (functionally equivalent to a revoke, just achieved by omission rather than an explicit
statement — a wording nuance in CLAUDE.md, not a gap).

The existing `tenantIsolation.*.test.ts` suite is extensive but each file covers a different subset of the
10 isolation axes (read/create/update/delete/restore/FK/aggregate/search/export/file) — **no file anywhere
tests search/autocomplete, export/CSV, or file/object-storage isolation** as its own axis. Cross-referencing
Phase J1's named gaps against every test file confirmed 5 of 6 had genuinely zero coverage (the 6th,
`JewelryTag.grnItemId`, turned out to already be tested at the service layer — Phase J1's classification of
it as a *schema-level* plain FK was correct, but the claim of zero test coverage for it specifically was not).

---

## 4. Gaps found and fixed in this pass

All four are the same shape: an optional foreign id on a create/update call that every sibling id on the same
call already had an `assertOwnedByCompany`/`assertOwnedIfPresent` check for, but this one didn't — a plain,
non-composite FK left over from the manufacturing era, so Postgres's own FK check (which bypasses RLS) would
accept a forged Company-B id with no warning. None required a schema migration — all are pure app-layer
ownership checks using the existing `ScopedModel` keys (`'account'`, `'jobCard'`, `'design'` were already
valid entries in `middleware/tenant.ts`).

| Fix | File | What changed | Regression test |
|---|---|---|---|
| `JournalLine.accountId` (CRITICAL — the only one with a real, if narrow, blast radius: a forged Company-B account's balance being mutated) | `server/src/modules/finance/finance.service.ts` — `createJournalEntry()` | Added `assertAllOwned('account', data.lines.map(l => l.accountId), companyId, 'Account')` before the entry is created | `server/src/test/tenantIsolation.phase2.test.ts` — "createJournalEntry: accountId cross-company forgery is rejected" (2 tests: forged rejected, legitimate still works) |
| `JewelryTag.jobCardId` / `designId` | `server/src/modules/tagging/tagging.service.ts` — `createTag()` | Added `assertOwnedIfPresent('jobCard', ...)` / `assertOwnedIfPresent('design', ...)` alongside the existing checks for `subCategoryId`/`collectionId`/`manufacturerId` on the same call | `tenantIsolation.phase2.test.ts` — "createTag: jobCardId/designId cross-company forgery is rejected" |
| `HallmarkingItem.jobCardId` | `server/src/modules/quality/quality.service.ts` — `createHallmarkingBatch()` | Added a per-item ownership check for any `jobCardId` supplied, mirroring the existing `tagId` check on the same function | `tenantIsolation.procurementQuality.test.ts` — "createHallmarkingBatch rejects a Company B jobCardId" |
| `RepairJob.originalJobCardId` | `server/src/modules/quality/quality.service.ts` — `createRepairJob()` | Added `assertOwnedIfPresent('jobCard', data.originalJobCardId, ...)` alongside the existing `clientId`/`tagId` checks | `tenantIsolation.procurementQuality.test.ts` — "createRepairJob rejects a Company B originalJobCardId" |

`PrItem.prId` and `ApprovalHistory.purchaseRequisitionId`/`purchaseOrderId` — also plain FKs, also flagged by
Phase J1 — were **not** fixed: confirmed (both by Phase J1 and independently re-confirmed here) that no
request path ever sets either directly; both are always populated server-side from an id the calling function
already validated moments earlier via `assertOwnedByCompany('purchaseRequisition', ...)`. Not exploitable
today. Left as a documented schema-hardening backlog item (make composite in the next migration that touches
either table) rather than changed speculatively.

---

## 5. Final verification

- `npx tsc -p tsconfig.build.json --noEmit` — clean, no errors.
- `npm run audit:tenant` (`ts-node scripts/tenant-audit.ts --strict`) — clean: `scoped=0, raw=0, aliases=0`
  after the fixes (unchanged from before — the fixes are ownership checks, not new bare-Prisma calls).
- `npx vitest run` on the two touched files (`tenantIsolation.phase2.test.ts`,
  `tenantIsolation.procurementQuality.test.ts`) — 50/50 passed, including all 4 new regression tests.
- Full suite (`npx vitest run`) — run against the local `sea_erp_test` database: **40 test files, 741 passed,
  5 skipped, 0 failed.**
- `npm run test:rls` (real role-split mode) — **not run in this pass**; recommend running it before any
  release per CLAUDE.md §12's standing rule, since it's the only mode that exercises RLS with the actual
  non-owner/non-bypass runtime role rather than the single-role fast suite.

---

## 6. Report (per the task's own required format)

- **Models reviewed:** all 90 (full schema classification, §2).
- **Routes reviewed:** every router file across `server/src/modules/*` except the dormant manufacturing
  cluster's internals (already out of scope per CLAUDE.md §2); Phase J1 had already reviewed
  masters/procurement/tagging/sales/finance/quality/company/auth/settings routers line-by-line for CRUD
  capability — this pass re-checked them specifically for company-scoping (a different axis) and added
  `reports.router.ts`, hardware's non-device endpoints, and platform's non-provisioning routes, none of
  which J1 had covered.
- **Services/repositories reviewed:** all service files backing the above; every `findUnique`/`update`/
  `delete`-family call site outside J1's already-reviewed files was individually classified scoped/unscoped.
- **Background jobs reviewed:** none exist (confirmed by grep — no cron/queue infrastructure anywhere in the
  repo); WebSocket, Redis, object storage, and hardware-device integration were reviewed as the actual
  non-HTTP customer-data surfaces that do exist.
- **RLS findings:** zero policy-coverage gap across all 85 company-owned tables; role grants match documented
  intent; one wording nuance (`platform_audit_logs`' isolation is achieved by omission, not an explicit
  revoke) — functionally equivalent, noted for accuracy.
- **Ownership-check findings:** 4 confirmed gaps (§4), all fixed; 2 more (`PrItem`/`ApprovalHistory`) confirmed
  not exploitable today, left as a schema-hardening backlog item; the branch-scoping inconsistency on
  `getStockOnHand`/`getDeadStock` (§3.2) is a separate, intra-company finding, not fixed here.
- **Schema changes:** none — all 4 fixes are app-layer ownership checks using existing `ScopedModel` keys.
- **Tests added:** 4 new regression tests across 2 existing test files (§4); all pass; no existing test
  regressed.
- **Remaining exceptions and why they're legitimate:** `HsnCode`/`StateMaster` (statutory reference data,
  intentionally global per CLAUDE.md §11); `Company`/`User`/`PlatformAuditLog` (intentionally platform-level);
  dormant manufacturing tables (intentionally untouched per CLAUDE.md §2, still correctly company-scoped and
  RLS-covered even though unused); the object-storage boundary being untested against a live store (nothing
  uses it yet); `PrItem`/`ApprovalHistory`'s plain FKs (not exploitable today, tracked not fixed).
- **Confirmation of a documented company-isolation contract for future development:** added as a new
  subsection directly under CLAUDE.md §11 ("Company-isolation contract — mandatory for every future
  feature"), including the two known guardrail (`tools/tenantAudit.ts`) blind spots as an explicit manual-
  review checklist item until they're closed with their own dedicated review.
