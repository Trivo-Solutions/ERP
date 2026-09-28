# Phase J4 — RBAC / Authorization: Implementation

> Implements the six decisions finalized in `PHASE_J4_DECISIONS.md`, against the findings in
> `PHASE_J4_RBAC_AUTHORIZATION_AUDIT.md`, exactly as scoped by the owner's execution order. J1–J3.5 are
> frozen and were not touched (no J3 client-lifecycle, invoice VOID, payment-reversal, OLD_GOLD/STORE_CREDIT
> reversal, or append-only-SalesReturn behavior was reopened). No new `DELETE /anything/:id`, no dormant
> manufacturing wiring, no unrelated refactor.

---

## 1. Executive summary

All seven slices in the execution order were implemented in one pass (backend permissions and route
gating; the high-value PO permissionization; the shared frontend authorization foundation; the module
rollout across Masters/Clients/Sales/Procurement/Quality-Repairs/Settings; and the Slice 7 cleanup).

Four new permission strings were added (`report:financial_view`, `po:approve_high_value`, `grn:view`,
`payment:view`). Three previously-undecided routes/behaviors were fixed to match them. A pre-existing,
independently-confirmed defect in `approvePO()` (a hardcoded `SUPER_ADMIN`/`PRODUCTION_MANAGER` role-name
check layered on top of the permission system) was replaced with permission-based authorization, which in
turn surfaced that `PRODUCTION_MANAGER` had never actually held `po:approve` in the starter package —
fixed as part of the same change, since leaving it out would have made the new `po:approve_high_value`
grant meaningless for the one role it was designed for.

A reusable frontend authorization foundation (`PermissionGate`, `RequirePermission`) was built and rolled
out as route guards to every page in the six decided modules — plus Finance/Reports, which needed it too
as a direct, immediate consequence of the D1 reporting split (without it, a `report:view`-only user would
still see now-restricted report links in the sidebar and land on a page that 403s). Every mutation button
this pass touched is now gated on its own backend permission, not the page's page-level permission.

No Prisma migration was needed — `Role.permissions` is a plain `String[]` column. A backfill script for
already-provisioned companies was written but deliberately not run against any live database (see §6).

**Verified:** server `tsc`, client `tsc`, server production build (`tsc -p tsconfig.build.json`), client
production build (`vite build`), the full test suite (805/810, 5 pre-existing skips), `npm run test:rls`
against the real role-split cluster (809/810, 1 pre-existing skip), and `npm run audit:tenant` (0
violations) — all clean.

---

## 2. The six locked decisions, as shipped

| # | Decision | Shipped as |
|---|---|---|
| D1 | Reporting split | New `report:financial_view`; trial balance, P&L, balance sheet, dealer aging, client ledger, day book, GST summary (sales + purchase), supplier ledger, and `/reports/aging-receivables` (same sensitivity class as dealer-aging, re-gated for consistency though not explicitly named) all moved off `report:view`. Only `ACCOUNTANT` granted it by default. |
| D2 | High-value PO approval | New `po:approve_high_value`; `approvePO()` rewritten to take a permission-derived boolean instead of a role name; `PRODUCTION_MANAGER` granted both `po:approve` (previously missing — see §4) and `po:approve_high_value`. Frontend `PurchaseOrders.tsx` now checks the permission, not `user?.role`. |
| D3 | J3 admin permissions | Left exactly as-is — SUPER_ADMIN-only, no target roles decided, no starter-role grants added. Confirmed zero frontend UI exists for Void or Payment Reversal to even gate. |
| D4 | Frontend authorization | `PermissionGate` + `RequirePermission` built once in `client/src/components/auth/`, reusing `auth.store.ts`'s existing `hasPermission` algorithm verbatim (no second permission system). Rolled out to all six named modules in one pass, per explicit instruction not to stop between slices. |
| D5 | GRN view | New `grn:view`; `GET /procurement/grn` re-gated; `PRODUCTION_MANAGER`/`STORE_MANAGER` both granted it alongside their existing `grn:create`. |
| D6 | Payment history | New `payment:view`; `GET /sales/clients/:clientId/payments` re-gated; `ACCOUNTANT`/`SALES_MANAGER` both granted it. |

---

## 3. New permissions

Added to `server/src/shared/permissionCatalog.ts` (the single source of truth `requirePermission(...)`
call sites and the Role Editor both key off of):

| Permission | Catalog group / item | Action label |
|---|---|---|
| `report:financial_view` | General → "Sensitive Financial Reports" (new item) | "View (Financial Detail)" |
| `po:approve_high_value` | Procurement → "Purchase Orders" | "Approve (High Value, >₹5,00,000)" |
| `grn:view` | Procurement → "GRN Verification" | "View" |
| `payment:view` | Sales & Export → "Payments & Receipts" | "View" |

**Format note:** two of these action segments (`financial_view`, `approve_high_value`) contain an
underscore, which the starter-package validator's permission regex
(`starterPackage/validate.ts: collectStarterPackageErrors`) did not allow
(`/^(\*|[A-Za-z]+:[A-Za-z]+)$/` — letters only). Since the owner's naming was explicit and non-negotiable,
the regex was widened to `/^(\*|[A-Za-z]+:[A-Za-z]+(_[A-Za-z]+)*)$/` — still exactly one `resource:action`
colon, still letters-only per word, now allowing multi-word actions joined by `_`. This was the one
change in this phase that touched validation logic rather than just adding data; `isValidPermissionList`
(used by the live Role Editor via `settings.service.ts`) needed no change — it validates against the
catalog set directly, not a regex.

---

## 4. Backend route/service changes

| Route / function | Before | After |
|---|---|---|
| `GET /procurement/grn` | `grn:create` | `grn:view` |
| `GET /sales/clients/:clientId/payments` | `sales:view` | `payment:view` |
| `GET /finance/reports/trial-balance` | `report:view` | `report:financial_view` |
| `GET /finance/reports/pnl` | `report:view` | `report:financial_view` |
| `GET /finance/reports/balance-sheet` | `report:view` | `report:financial_view` |
| `GET /finance/reports/dealer-aging` | `report:view` | `report:financial_view` |
| `GET /finance/reports/client-ledger/:clientId` | `report:view` | `report:financial_view` |
| `GET /finance/reports/day-book` | `report:view` | `report:financial_view` |
| `GET /finance/reports/gst-summary` | `report:view` | `report:financial_view` |
| `GET /finance/reports/supplier-ledger/:supplierId` | `report:view` | `report:financial_view` |
| `GET /finance/reports/purchase-gst-summary` | `report:view` | `report:financial_view` |
| `GET /reports/aging-receivables` | `report:view` | `report:financial_view` (judgment call — same data class as dealer-aging; not explicitly named in D1 but leaving it on `report:view` would have made the split trivially bypassable) |
| `POST /procurement/orders/:id/approve` | `po:approve` (router) + hardcoded role-name checks (service) | `po:approve` (router) + `po:approve_high_value` (service, only when goods value > ₹5,00,000) |

**`GET /finance/reports/cost-centers`** and the plain **`GET /finance/cost-centers`** list stayed on
`report:view`/`finance:view` respectively — not named in D1, and not the kind of per-party financial
exposure the decision targeted.

**Everything explicitly NOT touched, on purpose:** `GET /settings/design-categories` (no gate at all —
a real, independently-confirmed defect, but not named in the owner's six decisions or execution slices,
so left as a documented, deferred item rather than expanding scope); `POST /procurement/returns`'s
`po:approve` gate (flagged as a smell in the audit, explicitly marked "Future phase" there, not part of
D1–D6).

### `approvePO()` — the actual before/after

```ts
// BEFORE
export async function approvePO(id, ctx, userId, userRole: string, comments?) {
  ...
  if (amount > PO_APPROVAL_THRESHOLD && userRole !== 'SUPER_ADMIN') { throw 403; }
  if (!['PRODUCTION_MANAGER', 'SUPER_ADMIN'].includes(userRole)) { throw 403; }
  ...
}

// AFTER
export async function approvePO(id, ctx, userId, canApproveHighValue: boolean, comments?) {
  ...
  if (amount > PO_APPROVAL_THRESHOLD && !canApproveHighValue) { throw 403; }
  ...
}
```

The router now computes `canApproveHighValue` the same way the existing PO-delete elevation check
already did (`perms.has('*') || perms.has('po:*') || perms.has('po:approve_high_value')`), via a new
exported `hasPermission(perms, permission)` helper in `middleware/rbac.ts` that both `requirePermission`
and this call site now share.

The base role-list check (`!['PRODUCTION_MANAGER','SUPER_ADMIN'].includes(userRole)`) was removed
entirely, not just narrowed — per the execution spec's explicit statement of intended logic ("normal PO
approval → `po:approve`"), and because the router's own `requirePermission('po:approve')` middleware
already guarantees `po:approve` is present for every caller of this function, so a second, redundant,
role-name-based check added nothing except blocking legitimate delegation. This also means
`po:approve_high_value` alone is structurally never sufficient — you cannot reach `approvePO` at all
without `po:approve` first.

**Pre-existing gap this surfaced, fixed as part of D2 (not a separate, unscoped change):**
`PRODUCTION_MANAGER` never actually held `po:approve` in the starter package before this change — meaning
the router's permission gate already blocked this role from approving *any* PO, low-value or high, via
the API, even though the (now-removed) role-name check's own presence implied the business intent was
that PRODUCTION_MANAGER *could*. Since D2's stated goal is "preserves the CURRENT effective high-value
approval capability," and granting only `po:approve_high_value` without `po:approve` would have shipped
a permission that does nothing, `po:approve` was added to `PRODUCTION_MANAGER` alongside it.

---

## 5. Starter-role changes (`server/src/modules/platform/starterPackage/v1.ts`)

| Role | Added |
|---|---|
| `PRODUCTION_MANAGER` | `po:approve`, `po:approve_high_value`, `grn:view` |
| `ACCOUNTANT` | `report:financial_view`, `payment:view` |
| `SALES_MANAGER` | `payment:view` |
| `STORE_MANAGER` | `grn:view` |
| `SUPER_ADMIN` | unchanged (`*` already covers everything) |
| `FLOOR_WORKER` | unchanged (not in scope for any of the four new permissions) |

Every addition is additive to an existing role's permission array — no existing grant was removed or
reordered, and `collectStarterPackageErrors(STARTER_PACKAGE_V1)` is still `[]` (verified by
`starterPackage.test.ts`, unchanged and still passing).

---

## 6. Existing-company migration / backfill

`Role.permissions` is `String[]` on a normal Postgres table — no Prisma migration was needed for any of
this (no enum, no new column). What existing companies need instead is a **data backfill**: an
already-provisioned company's `PRODUCTION_MANAGER`/`ACCOUNTANT`/`SALES_MANAGER`/`STORE_MANAGER` role rows
were created from the starter package *before* this change and are never retroactively touched by editing
`v1.ts` (`v1.ts`'s own header: "A package is IMMUTABLE once released... existing companies are never
touched").

`server/scripts/backfillJ4Permissions.ts` (new) does this safely:

- Runs as an operator CLI script (`npx ts-node scripts/backfillJ4Permissions.ts` — dry run by default,
  `--apply` to write), same shape as `reset-password.ts`.
- For every `Role` row across every company whose `name` matches one of the four roles above, adds only
  the missing permission strings from the table in §5 — **never removes or overwrites** an existing
  grant, so a company that customized that role via the Role Editor keeps its customization.
- Skips any role that already holds `'*'` (nothing to add).
- Reports what it would change (or did change) per company/role.

**This was not run against any live database in this pass** — same posture as the documented-but-
undeployed `masters:view` (Phase F) and J2's `client:*`/`payment:*`/`return:*` backfills, which CLAUDE.md
records as intentionally deferred until the company's own SUPER_ADMIN or an operator chooses to run it (or
grants it by hand via the Role Editor). Until then, an already-provisioned company's
`PRODUCTION_MANAGER`/`ACCOUNTANT`/`SALES_MANAGER`/`STORE_MANAGER` will not see the four new permissions,
and their corresponding pages/actions will show as not-permitted (fail closed, not fail open — the safer
direction for an authorization change).

---

## 7. Frontend authorization architecture (D4)

Two new files, `client/src/components/auth/`:

- **`PermissionGate.tsx`** — inline conditional rendering. Props: `permission` (single), `anyOf` (OR),
  `allOf` (AND), `fallback` (default: render nothing). Delegates entirely to `useAuthStore`'s existing
  `hasPermission`/exact-match/`resource:*`/`*` algorithm — no second permission-evaluation algorithm was
  introduced, per the explicit instruction.
- **`RequirePermission.tsx`** — route-level guard. Same algorithm, but renders a full "Access Restricted"
  panel (icon + heading + explanatory text naming the missing permission) instead of the page, styled with
  the app's existing MUI conventions (no new visual language invented). Used by wrapping a route's
  `element` in `pageRoutes.tsx`.

Both are built entirely on the pre-existing `auth.store.ts` permission snapshot (set once at login) — no
new state, no new fetch, no duplicated business rule. The backend remains authoritative regardless of what
either renders: every mutation this phase gated on the frontend is independently enforced by the same
`requirePermission(...)` call server-side that was already there.

**Route guards wired into `pageRoutes.tsx`** for every route in: Masters (`masters`), Clients
(`orders/clients`), Sales (`sales/memos`, `sales/invoices`, `sales/invoices/new`,
`sales/invoices/:id/edit`, `sales/exchanges`), Procurement (`procurement/requisitions`, `/orders`, `/grn`,
`/returns`, `/suppliers`), Quality/Repairs (`quality/hallmarking`, `quality/repairs`), and Settings
(`settings/users`, `settings/roles`, `settings`, `hardware`). Finance/Reports also got route guards — not
one of the six named modules, but a direct, immediate consequence of D1's report split landing in this
same pass (see §8). Every other module (Product Design, Inventory, Orders(production)/Manufacturing,
Outsourcing) is unchanged — out of the decided rollout scope, any authenticated user of any role still
reaches those pages exactly as before.

---

## 8. Module-by-module frontend changes (Slice 6)

| Module | File | What changed |
|---|---|---|
| Masters | `MastersPage.tsx` | Shared `FormPanel` component (used by every tab) now gates Add/Update on `masters:create`/`masters:edit` and Delete on `masters:delete`, via a new `permissions` prop defaulting to the masters triad — with an explicit override for the one tab that isn't a real master (`ClientsTab`, which edits actual `Client` rows via `/orders/clients` and so needs `client:create`/`client:edit` instead). The isActive-toggle status chips in `GenericMasterSection`, `CategoriesTab` (category + sub-category), `StoneTypesTab` (type + grade), and `ClientsTab` were all gated the same way (permission check inside the toggle handler, plus a non-interactive chip when not permitted). |
| Clients | `Clients.tsx` | "Add Client" (`client:create`); row actions — PAN/Form 60 (`client:edit`), Record Payment (`payment:create`), Statement (`report:financial_view`, matching the now-financial-view-gated `client-ledger` route). |
| Sales | `SalesInvoices.tsx` | "New Sale" (`invoice:create`, alongside the pre-existing `invoice:edit` gate on Edit); Record Payment form (`payment:create`); Return Selected (`return:create`). `NewSalePage.tsx`: "New Client" quick-add (`client:create` — this page's route guard is `invoice:create`/`invoice:edit`, a different permission from creating a client). `OldGoldExchange.tsx`: "Record Exchange" (`invoice:create`, since `POST /sales/exchanges` needs it — stricter than the page's own `sales:view` route guard). `MemoOutPage.tsx`/`HallmarkingPage.tsx`: no internal gating needed — every action on each page already rides the exact same single permission (`memo:manage`, `hallmark:manage`) the route guard already requires. |
| Procurement | `PurchaseOrders.tsx` | High-value approval check switched from `user?.role === 'SUPER_ADMIN'` to `hasPermission('po:approve_high_value')` (D2); "New PO" (`po:create`); "Submit for Approval" (`po:create`). `Suppliers.tsx`: "Add Supplier" (`po:create`); "Statement" link fixed from stale `report:view` to `report:financial_view` (caught mid-pass — a direct casualty of the D1 split this file hadn't been touched for yet). `PurchaseRequisitions.tsx`: "New Requisition" (`po:create`) — the drawer's Submit/Approve/Reject/Convert actions were already correctly gated. `GrnVerification.tsx`: "Create GRN" (`grn:create`) and "Approve" (`grn:verify`) — the Tag actions were already gated on `tag:create`. `PurchaseReturns.tsx`: "Return Selected" (`po:approve`, matching the route's actual gate). |
| Quality/Repairs | `RepairJobs.tsx` | "New Repair" (`repair:create`); repair-cost inline edit (`repair:edit`); "Mark delivered" (`repair:manage`); "Bill" (`invoice:create`) — all previously fully ungated, matching the audit's finding. |
| Settings | `RoleEditorPage.tsx` | Save (`role:create` when creating, `role:edit` when editing) and Delete (`role:delete`) — previously fully ungated. `CompanyUsersPage.tsx`/`SettingsPage.tsx`/`HardwarePage.tsx`: no internal gating needed — every action on each rides the one permission (`user:manage`, `system:config`/read-only, `hardware:manage`) the route guard already requires. |
| Finance (not one of the six, but a direct D1 consequence) | `JournalEntries.tsx` | "New Journal" (`journal:create`) and "Post" (`journal:post`) — the Post action was explicitly named in the execution spec as ungated; now fixed. |

**Also fixed, Slice 7:** `navItems.tsx` — "Roles & Permissions" now gates on `role:view` (was the retired,
no-longer-valid `role:manage` — permanently invisible to every non-`*` role before this fix); "GRN
Verification" now matches D5 (`grn:view`, was `grn:create`); "Repair Jobs" loosened from `repair:manage`
to `repair:view` (page access shouldn't require the workflow-action permission; the page's own
create/deliver/bill actions still check their own specific permissions); every Finance/Reports nav entry
for the ten routes in §4's table updated from `report:view` to `report:financial_view` to match the
backend.

---

## 9. Legacy cleanup performed (Slice 7)

- **`rbac.ts`'s dead `PERMISSIONS` const object and `Permission` type** — confirmed zero usages anywhere
  in the repo (every `requirePermission(...)` call site already used raw string literals) via a repo-wide
  grep before removal. Replaced with an exported `hasPermission(userPermissions: string[], permission:
  string): boolean` helper — the same exact/`resource:*`/`*` algorithm, now shared by `requirePermission`
  itself and the procurement router's high-value-approval check, instead of being duplicated inline.
- **`navItems.tsx`'s stale `role:manage`** — fixed (see §8).
- **`API.md`** — the stale `/roles` `role:manage` doc corrected to the real per-verb permissions
  (`role:view`/`role:create`/`role:edit`/`role:delete`, the last two of which weren't documented at all);
  `/grn`, `/clients/:clientId/payments`, and every re-gated financial report route's permission column
  updated; the RBAC quick-reference section's role summary and its reference to the now-deleted
  `PERMISSIONS` object corrected to point at `permissionCatalog.ts`.
- **`qc:approve`/`sales:create`/`tax:manage`** — confirmed dead (present in the catalog, granted to a
  starter role, enforced by zero routes anywhere) but **deliberately left untouched**. Removing a
  permission string from the catalog while it may still be present in an already-provisioned company's
  stored `Role.permissions` array would make that role fail `isValidPermissionList` on its very next edit
  through the Role Editor (the removed permission isn't rendered as a checkbox to uncheck, so the save
  would be permanently blocked without a prior data migration to strip it first). This is exactly the
  class of risk the instructions called out ("do not silently remove permissions from the live catalog if
  existing database rows may depend on them") — recorded here as deferred cleanup requiring its own
  migration decision, not fixed in this pass.

---

## 10. Files changed

**Backend:**
- `server/src/shared/permissionCatalog.ts` — 4 new permissions, 1 new catalog item, 2 new action labels.
- `server/src/middleware/rbac.ts` — removed dead `PERMISSIONS`/`Permission`; added `hasPermission()`;
  `requirePermission` now calls it.
- `server/src/modules/platform/starterPackage/v1.ts` — starter-role grants (§5).
- `server/src/modules/platform/starterPackage/validate.ts` — permission regex widened for underscore
  action segments.
- `server/src/modules/procurement/procurement.service.ts` — `approvePO()` rewritten (§4).
- `server/src/modules/procurement/procurement.router.ts` — `grn:view` gate; `approvePO` call site now
  derives and passes `canApproveHighValue`.
- `server/src/modules/sales/sales.router.ts` — `payment:view` gate.
- `server/src/modules/finance/finance.router.ts` — nine routes moved to `report:financial_view`.
- `server/src/modules/reports/reports.router.ts` — `aging-receivables` moved to `report:financial_view`.
- `server/src/test/tenantIsolation.procurementQuality.test.ts` — one call site updated for `approvePO`'s
  new signature (a boolean in place of a role-name string; the test itself proves cross-company 404, so
  the exact boolean value is inert to what it's testing).
- `server/scripts/backfillJ4Permissions.ts` — new (§6).
- `server/src/test/http.j4Authorization.test.ts` — new (§11).

**Frontend:**
- `client/src/components/auth/PermissionGate.tsx` — new (§7).
- `client/src/components/auth/RequirePermission.tsx` — new (§7).
- `client/src/pageRoutes.tsx` — route guards wired in (§7).
- `client/src/components/Layout/navItems.tsx` — permission-string fixes (§8).
- `client/src/pages/Masters/MastersPage.tsx`, `Orders/Clients.tsx`, `Sales/SalesInvoices.tsx`,
  `Sales/NewSalePage.tsx`, `Sales/OldGoldExchange.tsx`, `Procurement/PurchaseOrders.tsx`,
  `Procurement/Suppliers.tsx`, `Procurement/PurchaseRequisitions.tsx`,
  `Procurement/GrnVerification.tsx`, `Procurement/PurchaseReturns.tsx`, `Quality/RepairJobs.tsx`,
  `Finance/JournalEntries.tsx`, `Settings/RoleEditorPage.tsx` — button/action gating (§8).

**Docs:** `API.md`, `CLAUDE.md` (this phase's summary appended under "Phase J").

**No Prisma migration** (§6).

---

## 11. Tests added/modified

- **`server/src/test/http.j4Authorization.test.ts`** (new, 15 tests, real HTTP via `supertest` + the real
  app — the same pattern as `http.j3Administrative.test.ts`, since service-level tests bypass
  `requirePermission(...)` entirely by calling functions directly with a full-permission ctx):
  - PO approval: `po:approve` alone approves a ≤₹5,00,000 PO (existing behavior unchanged); `po:approve`
    alone is 403 on a >₹5,00,000 PO; `po:approve` + `po:approve_high_value` approves it;
    `po:approve_high_value` alone (no `po:approve`) is 403 — proves it's never sufficient on its own.
  - GRN: `grn:view` can list, is 403 on create; `grn:create` alone is 403 on list (no longer implies view).
  - Payment history: `payment:view` succeeds; `sales:view` alone (the old gate) is now 403.
  - Reporting (`it.each` over all ten re-gated routes): `report:view` alone is 403 on every one;
    `report:financial_view` succeeds on every one.
  - Operational reports (`wip-summary`, `stock-summary`, `sales/reports/register`) remain reachable on
    `report:view` alone — proves the split didn't over-narrow anything by accident.
  - `SUPER_ADMIN` wildcard (`'*'`) reaches every one of the above.
- **`server/src/test/tenantIsolation.procurementQuality.test.ts`** — one line updated for `approvePO`'s
  new parameter type (unrelated to the test's actual assertion, which is cross-company 404).
- **`server/src/modules/platform/starterPackage.test.ts`** — unchanged, still passes: proves
  `STARTER_PACKAGE_V1` (with its four new permission grants) still satisfies every structural rule the
  validator enforces.
- **`server/src/modules/settings/settings.service.test.ts`** — unchanged, still passes: proves the Role
  Editor's `createRole`/`updateRole` still reject an unrecognized permission string and still enforce
  company-scoping and SUPER_ADMIN-immutability, unaffected by the catalog additions.

No new client-side test framework was introduced (none existed before this phase) — per instruction,
verification here is TypeScript + both production builds instead (§1), which is what actually would have
caught a broken import/prop/JSX error across the ~15 files this phase touched.

---

## 12. Verification results

| Check | Result |
|---|---|
| Server `tsc --noEmit` | Clean |
| Client `tsc --noEmit` | Clean |
| Server production build (`tsc -p tsconfig.build.json`) | Clean |
| Client production build (`vite build`) | Clean (pre-existing >500kB chunk warning, unrelated) |
| Full server test suite (`npx vitest run`) | 805 passed / 5 skipped (43 files) — 0 failed |
| `npm run test:rls` (real role-split cluster, `trivo_rlstest`) | 809 passed / 1 skipped (43 files) — 0 failed |
| `npm run audit:tenant --strict` | 0 violations requiring fixes (2 pre-existing reviewed transaction/other entries, unrelated to this phase) |

A repo-wide grep confirmed no remaining hardcoded role-name authorization
(`userRole ===`/`!==`, `.includes(userRole)`, `user?.role ===` client-side) anywhere this phase touched,
and no remaining `role:manage` reference outside historical migration files and this phase's own
explanatory comments.

---

## 13. Known limitations / explicitly deferred

- **`GET /settings/design-categories` still has no permission gate.** Independently re-confirmed during
  this pass; not named in the owner's six decisions or seven execution slices, so left untouched rather
  than expanding scope. A future, explicitly-scoped fix should add one (likely `design:view` or
  `masters:view`, matching its sibling `POST` route's `system:config`).
- **D3's target roles for the five J3 administrative permissions are not decided** — by design, this
  phase only "prepares for future delegation" per the locked decision; no starter-role grants were added,
  and none should be invented here.
- **No frontend UI exists for Invoice Void or Payment Reversal at all** — confirmed by a repo-wide search
  before concluding there was nothing to gate. Building that UI (so D3's eventual delegation has
  something to gate) is separate, future-scoped feature work, not an authorization-gating task.
- **The existing-company backfill script (`backfillJ4Permissions.ts`) has not been run against any live
  database**, including the local dev SEA company — written, dry-run-safe, and documented, per the same
  deliberate-deferral posture as every prior permission-catalog addition in this codebase's history.
- **`qc:approve`/`sales:create`/`tax:manage` remain dead** in the catalog and on their starter roles —
  confirmed inert, deliberately not removed (§9).
- **The frontend's permission snapshot is still set once at login** (an existing, pre-J4 limitation, not
  introduced or worsened here) — a role edit via the Role Editor takes effect on the backend immediately,
  but a currently-logged-in user's UI won't reflect a newly-granted or newly-revoked permission until they
  log out and back in. The backend remains authoritative in the interim (a 403 still occurs), but the UI
  may show a stale set of visible buttons/pages for that session.
- **Route guards were not extended beyond the six decided modules** (+ Finance/Reports, forced by D1).
  Product Design, Inventory, Orders(production)/Manufacturing, and Outsourcing pages remain reachable by
  any authenticated user of any role, exactly as before this phase — unchanged, not regressed, but also
  not hardened.

---

**J4 IMPLEMENTATION: COMPLETE — READY FOR HUMAN REVIEW**
