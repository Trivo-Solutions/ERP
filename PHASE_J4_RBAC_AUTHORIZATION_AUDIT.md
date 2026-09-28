# Phase J4 — RBAC, Authorization & Administrative UX Audit

**Status: READ-ONLY DESIGN AUDIT. No code, schema, migration, permission, role, starter-package, or test
file was modified to produce this report.** Findings were gathered by four parallel read-only research
passes (baseline/starter-package/legacy-permission; backend endpoint/service-level/SUPER_ADMIN; frontend/
navigation/Role Editor; JWT/audit-log/test-coverage) plus direct reads of `permissionCatalog.ts` and
`rbac.ts`, all cross-checked against each other. Two independent passes converged on the same `navItems.tsx`
defect (§9), which is treated as extra-confidence evidence, not double-counted.

J1–J3.5 decisions are treated as **frozen** throughout. Nothing below revisits them; where J4 touches the
same ground (e.g. SUPER_ADMIN-only J3 permissions) it only documents the current, already-decided state.

---

## 1. Executive summary

The backend authorization chain is **structurally sound and consistently enforced**: every company-owned
route (with one exception, §5) carries a `requirePermission(...)` check; every sensitive administrative
service function (`voidInvoice`, `reverseInvoicePayment`, `setClientActive`, `deleteClient`, etc.) is
reachable from exactly one router call site with a matching permission, and independently re-verifies
company ownership via `assertOwnedByCompany` regardless of what the router already checked. SUPER_ADMIN and
the `'*'` wildcard are correctly company-scoped everywhere they appear — no occurrence crosses a tenant
boundary, touches RLS, or reaches platform/database authority. The Role Editor cannot persist a fabricated
permission string (validated both by UI catalog-sourcing and server-side `isValidPermissionList`), and the
SUPER_ADMIN role itself is protected from being edited or deleted, on both tiers, independently.

The **frontend is where the model breaks down**. Only 6 of dozens of page files do any permission-based UI
gating at all; the rest (Masters, most of Sales, most of Procurement, all of Quality/Repairs, all of
Settings' user/role admin) render every mutating action unconditionally and rely entirely on the backend's
403 — which directly contradicts CLAUDE.md §6.10 ("every applicable entity page must expose the appropriate
actions... according to the user's permissions"). Compounding this, there is **no frontend route guard at
all** beyond "is anyone logged in" — any authenticated user can deep-link to any page in the app regardless
of permissions, so the unconditional buttons are reachable, not just visible-but-inert.

Three concrete backend defects were found: an unauthenticated-permission read endpoint
(`GET /settings/design-categories`, §5), a stale/retired permission string that permanently hides an entire
nav section from any non-SUPER_ADMIN role (`navItems.tsx:141`, §9), and one service function
(`procurement.service.ts: approvePO`) that authorizes by hardcoded role name instead of the permission
system, contradicting CLAUDE.md §6.2 explicitly. None of the three cross a company boundary or touch RLS.

Test coverage is real for the J3 administrative permissions specifically (`http.j3Administrative.test.ts`)
but has clear gaps: the `${resource}:*` wildcard path has zero test coverage anywhere, there are no frontend
tests at all (no test files exist under `client/src`), and no test exercises a literal `SUPER_ADMIN`-named
role crossing companies (current coverage uses functionally-equivalent full-permission fixtures instead).

---

## 2. Current authorization architecture

```
Permission Catalog (server/src/shared/permissionCatalog.ts — PERMISSION_CATALOG, ALL_CATALOG_PERMISSIONS)
        |
Starter Package roles (server/src/modules/platform/starterPackage/v1.ts) -- COPIED into a new company's own Role rows
        |
Role Editor (client/src/pages/Settings/RoleEditorPage.tsx) -> POST/PATCH /settings/roles
        |
Role persistence (settings.service.ts: createRole/updateRole -> isValidPermissionList() gate -> Role.permissions[])
        |
Login (auth.service.ts: issueTokens) -- reads membership.role.permissions fresh from DB, bakes into JWT
        |
JWT (access token: userId, companyId, companyUserId, roleId, roleName, permissions[], branchAccess)
        |
authenticate() middleware (middleware/auth.ts) -- RE-READS Role.permissions fresh from DB every request;
        |                                          branchAccess is NOT re-read, only copied from the token
requirePermission(...) (middleware/rbac.ts) -- exact match, OR '*', OR `${resource}:*`
        |
Routes (*.router.ts, ~30 files)
        |
Services -- independently re-check company ownership (assertOwnedByCompany) but trust the router for
        |    the permission decision (one exception: procurement.service.ts:approvePO, §7)
Ownership / company checks (middleware/tenant.ts: assertOwnedByCompany/assertOwnedIfPresent/assertAllOwned)
        |
Frontend hasPermission() (client/src/store/auth.store.ts) -- mirrors rbac.ts's exact algorithm, but reads
        |                                                      permissions cached from the LOGIN response only
Navigation / buttons / actions -- gated in only 6 page files; everywhere else, unconditional (§8)
```

**Global/platform authority**: `platform.router.ts` is gated by a constant-time `x-trivo-platform-key`
header check (`requirePlatformKey`), entirely outside the `authenticate`/JWT/permission system — by design,
this is not a company-tenant concept at all.

**Company authority**: every company-owned route runs through `authenticate` + `resolveTenantContext`
(router-level `.use()`), which fixes `req.tenant`/`ctx.companyId` for the rest of the request. Permission
checks never select or change which company is in scope.

**Role authority**: a `Role` row is a normal company-owned record (`companyId`, checked via
`assertOwnedByCompany` on edit/delete). `SUPER_ADMIN` is not special at the schema level — it is a role
*name* that is (a) seeded with `permissions: ['*']` by the starter package into every new company's own
table, and (b) specifically protected from being edited/deleted once created (§10). There is exactly one
`SUPER_ADMIN` row per company; nothing shares it across companies.

**Permission authority**: `requirePermission(a, b, ...)` requires the caller to satisfy *every* listed
permission via exact string match, the full wildcard `'*'`, or a resource wildcard `` `${resource}:*` ``
(e.g. a literal string `'client:*'` would satisfy any `client:...` check). **No starter role currently uses
a resource wildcard** — only `SUPER_ADMIN`'s bare `'*'` exists in `v1.ts` — so this code path is live and
correct but presently untested and untriggered by any shipped role (§13).

**RLS authority**: independent of and beneath all of the above — a forged/omitted permission does not
change which company's rows are visible; that boundary is enforced at the database by Postgres RLS +
composite FKs, out of scope for this permission-layer audit and already covered by
`COMPANY_ISOLATION_AUDIT.md`.

**Verified explicitly, per the audit brief's requirement:**
- **SUPER_ADMIN is company-scoped and never a database/RLS/platform bypass.** Confirmed by full-repo grep
  of every `SUPER_ADMIN`/`'*'` occurrence (§7) — every one operates on an already-tenant-fixed context, a
  `companyId`-filtered row, or a `companyId`-prefixed resource name (WebSocket rooms).
- **`'*'` is only an RBAC permission wildcard.** It has no effect on `assertOwnedByCompany`, RLS, or audit
  immutability — confirmed by reading the four J3 administrative service functions directly: none of them
  branch on `'*'` or `SUPER_ADMIN`; they take permission as already-decided and independently re-check
  company ownership regardless of caller authority.

---

## 3. Permission catalog analysis

`server/src/shared/permissionCatalog.ts` is the single source of truth for what's grantable via the Role
Editor (`PERMISSION_CATALOG` groups → `ALL_CATALOG_PERMISSIONS` set → `isValidPermissionList()`). Cross-
referencing all 243 `requirePermission(...)` call sites across `server/src` against the catalog:

- **Every permission actually enforced by a route has a matching catalog entry.** No ungrantable-from-UI
  permission exists — `(a)` in the legacy-permission task came back empty.
- **Three catalog permissions are dead/inert** — present in the catalog, granted to a starter role, but
  enforced by zero routes anywhere: `qc:approve` (granted to `PRODUCTION_MANAGER`; only `qc:inspect` is
  ever checked, at `manufacturing.router.ts:63`), `sales:create` (granted to `SALES_MANAGER`; no route
  checks it), `tax:manage` (granted to `ACCOUNTANT`; no route checks it). A company admin could believe
  granting/revoking these changes behavior; it does not.
- A separate legacy `PERMISSIONS` const object in `middleware/rbac.ts` (lines 34–125) has **zero usages**
  anywhere in `server/src/modules` (confirmed by grep) — every router uses raw string literals instead. It
  is also internally stale: missing every J2/J3-era string (`client:*`, `payment:*`, `return:*`,
  `invoice:void`), and containing at least one string (`design:delete`) that was never a real catalog
  permission at all. Both J2's and this audit's review flagged it as dead without removing it (§14).

---

## 4. Backend endpoint audit

Full route-by-route enumeration (method, path, permission, handler) across all ~30 router files was
completed and is accurate as of this pass. It is long, so it is summarized here by module with only the
routes that deviate from a plain **CORRECT** classification called out; the full per-route table (masters,
sales, tagging, procurement, quality, finance, orders, reports, estimation, design, manufacturing,
outsourcing, hardware, inventory, auth, company, settings, platform) was produced during research and every
row not listed below should be read as CORRECT — permission matches the module/action, and reachable only
inside an already company-scoped request.

| Route | Permission used | Classification | Why |
|---|---|---|---|
| `GET /procurement/grn` | `grn:create` | **CONFIRMED DEFECT** | Read-only listing gated by the *create* permission; no `grn:view` exists in the catalog at all, so this can't even be fixed by swapping strings without first adding one (§13). |
| `GET /settings/design-categories` | *(none — only `authenticate`+`resolveTenantContext`)* | **CONFIRMED DEFECT** | Any authenticated company member of any role can read it. Company-scoped correctly (no cross-tenant leak), but an in-company authorization gap — the sibling `POST /settings/design-categories` two lines below correctly requires `system:config`. |
| `POST /procurement/returns` | `po:approve` | **POSSIBLE SMELL / NEEDS HUMAN DECISION** | Creating a purchase return is gated by an *approval* permission rather than a create-shaped one; the frontend research pass flagged the same route independently. |
| `memo:manage` (5 routes: list/create/check-alerts/return/convert) | one string for view+create+admin-alert+return+convert | **INTENTIONAL EXCEPTION** (per catalog's own precedent for bundling) but **POSSIBLE SMELL** | Five materially different actions share one permission with no split; consistent with `repair:manage`'s documented bundling elsewhere, but coarser than the `client:*`/`invoice:*` family the rest of the app now uses. |
| `repair:manage` (status-transition except DELIVERED, add-transaction) | bundled | **INTENTIONAL EXCEPTION** | Catalog's own comment documents this as deliberate ("the two workflow actions... not create/edit"), not an oversight — carried forward from before J2, not revisited by J4 per the frozen-decisions rule. |
| `invoice:void`, `payment:reverse`, `client:deactivate`, `client:delete` | correctly enforced, present in catalog | **INTENTIONAL EXCEPTION (frozen)** | Confirmed unreachable by any non-SUPER_ADMIN role today (§6) — this is J3 Decision 6, not re-litigated here. |

**Dormant-module routes** (`manufacturing.router.ts`, `outsourcing.router.ts`, most of `design.router.ts`)
remain fully permission-gated even though the modules themselves are unused per CLAUDE.md §2 — correct,
inert-but-safe.

---

## 5. Service authorization audit

For the ten sensitive service functions named in the audit brief (`voidInvoice`, `reverseInvoicePayment`,
`setClientActive`, `deleteClient`, `amendInvoice`, `createSalesReturn`, `recordClientPayment`,
`recordPayment`, `createInvoice`, `convertMemoToInvoice`, `billRepairJob`, plus `applyPayment`):

- **Every one is reachable from exactly one router call site** — no fan-in from multiple routes with
  different permission requirements was found anywhere, so none of them can be reached via a
  weaker-permission alternate path.
- **`applyPayment` is not independently router-reachable at all** — it's an unexported internal helper in
  `sales.service.ts`, only called from within `recordPayment`/`recordClientPayment`/`createInvoice`'s own
  payment loop.
- All ten (and the sampled ones read directly — `voidInvoice`, `reverseInvoicePayment`, `setClientActive`,
  `deleteClient`) take a tenant context and call `assertOwnedByCompany` (or an equivalent inline
  `companyId` check) on the target row **before** acting, independent of whatever the router already
  verified — correct defense-in-depth, matching CLAUDE.md §11's contract.
- **None of the ten contain their own permission-string or role-name check** — they trust the router
  entirely for the permission decision, which is correct given the router is the sole caller and Postgres
  FK/RLS/company checks provide the other half of the boundary. The one exception in the whole codebase:

**`procurement.service.ts: approvePO`** (line ~620) takes a raw `userRole: string` and does hardcoded
comparisons — `userRole !== 'SUPER_ADMIN'` (line 628) and
`!['PRODUCTION_MANAGER', 'SUPER_ADMIN'].includes(userRole)` (line 634) — as a *second*, independent
authorization layer on top of the router's `po:approve` check, specifically gating approval of a PO above a
₹5,00,000 threshold. This is:
- **CONFIRMED DEFECT relative to CLAUDE.md §6.2**, which states deletion/modification authority "must
  therefore be permission-driven rather than hardcoded to a particular application role."
- Still company-scoped correctly (ownership is checked first, line 621) — not a tenant-isolation issue.
- **Mirrored client-side** in `PurchaseOrders.tsx:108,140` (`user?.role === 'SUPER_ADMIN'`), so the same
  narrower authority model is visible in the UI too, not just the backend.
- **Practical consequence**: a delegated user granted `po:approve` under any role name other than literally
  `SUPER_ADMIN` or `PRODUCTION_MANAGER` can approve ordinary POs but is permanently blocked from the
  high-value threshold, with no permission they could be granted to unlock it. This directly undercuts
  CLAUDE.md §6.2's delegation model for this one specific case.

---

## 6. SUPER_ADMIN boundary audit

Every literal `SUPER_ADMIN` / `'*'` occurrence in `server/src` and `client/src` was enumerated (11 groups
server-side, 4 client-side). Summary judgment: **no occurrence lets SUPER_ADMIN or `'*'` cross a company
boundary, bypass RLS, act as a platform/database administrator, or bypass audit immutability.** Every
instance is one of:
- a permission-string check inherently scoped to an already-resolved tenant context (`rbac.ts:10`,
  `procurement.router.ts:163`'s `po:*`/`po:approve` elevated-delete check, `auth.store.ts:75`'s frontend
  mirror);
- a role-name check on a `Role` row already fetched with a `companyId` filter (`settings.service.ts`'s
  refusal to edit/delete a company's own `SUPER_ADMIN` role, §10);
- a company-id-prefixed WebSocket room name (`shared/websocket.ts` — `room.role(companyId, roleName)`,
  confirmed two companies sharing a role name land in provably distinct rooms, per
  `runtime.isolation.test.ts`);
- provisioning scaffolding that only ever searches roles created inside the same just-created company's own
  transaction (`platform/provisioning.service.ts`);
- the starter package's own `SUPER_ADMIN: ['*']` **template**, copied (never referenced/shared) into each
  new company's independent `Role` table (`starterPackage/v1.ts:44`, matches CLAUDE.md §11 item 3 exactly);
- test/fixture code proving the above.

**One architectural inconsistency carried forward from §7, not a boundary defect**: `approvePO`'s hardcoded
role-name gate (and its client-side mirror in `PurchaseOrders.tsx`) is a *narrower, name-based* authority
model than the rest of the RBAC system uses, but it does not cross a tenant boundary — it just can't be
delegated the way every other capability in this app can be.

---

## 7. Frontend permission audit

**Core helper**: `client/src/store/auth.store.ts: hasPermission()` (lines 71–79) implements the *identical*
three-clause algorithm as the backend (`user.permissions.includes('*') || .includes(permission) ||
.includes(`${permission.split(':')[0]}:*`)`) — no divergence from `rbac.ts:10`. `hooks/usePermissions.ts`
wraps it; most call sites read the store directly instead.

**How permissions reach the client**: not decoded from the JWT — `user.permissions` is a plain field on the
login HTTP response body, cached into the Zustand store (persisted to `localStorage`) at `setAuth()` and
never re-fetched mid-session. This means, notably, that **the backend's live per-request permission re-read
(§2) and the frontend's login-cached permission snapshot can diverge during a session**: if an admin edits a
role, the *server* enforces the new permission set on the very next request (per §12's JWT trace), but the
*UI* keeps showing buttons/nav based on the stale, login-time snapshot until the affected user logs out and
back in (or the app triggers a refresh that re-fetches `/auth/me`). This is a UX inconsistency, not a
security defect — the server is authoritative regardless — but it means a user could see a button the
server would now reject, or (more relevantly to this app's UX conventions) not see one they've just been
granted.

**Button/action gating — by far the largest finding of this audit.** Only 6 page files anywhere in
`client/src/pages/**` do any `hasPermission`-based gating at all: `BranchTransfersPage.tsx`,
`SalesInvoices.tsx`, `GrnVerification.tsx`, `PurchaseOrders.tsx`, `Suppliers.tsx`,
`PurchaseRequisitions.tsx` — and even within those, gating is partial (some actions on the same page are
gated, others on the same page are not). Every other page's mutating actions render unconditionally,
relying entirely on the backend's 403. Classified per the audit brief's A/B/C/D scheme:

| Area | Gated (A) | Ungated (B) | Notes |
|---|---|---|---|
| Masters (all tabs) | none | Add/Update/Delete, all tabs | Zero `hasPermission` references in the entire 1433-line `MastersPage.tsx` — the exact previously-identified pattern, still present, unchanged. |
| Clients | none | Add Client, Record Payment | No Edit/Deactivate/Delete UI exists yet for J3 capabilities (not a defect — J3 shipped backend-only by design). |
| Sales | `SalesInvoices.tsx` Edit icon+drawer (`invoice:edit`) — **A** | Record Payment, Return Selected (`SalesInvoices.tsx`); entire `NewSalePage.tsx`; entire `MemoOutPage.tsx` | The one clean example of correct gating in the whole Sales area sits next to three ungated forms in the same module. |
| Procurement | `PurchaseOrders.tsx` Approve/Delete — **A**; `GrnVerification.tsx` per-line Tag action — **A**; `Suppliers.tsx` Pay/Statement, correctly matched to their actual backend permissions — **A** | `PurchaseOrders.tsx` New/Create PO; `GrnVerification.tsx` Create GRN, Approve GRN; `Suppliers.tsx` Add Supplier; `PurchaseReturns.tsx` Return (also flagged **C** — its backend permission choice, `po:approve`, is itself the §4 smell) | Same files mix A and B rows depending on the specific action. |
| Finance | none | `JournalEntries.tsx` New Journal, Post | Plus a nav/action mismatch: the page is nav-gated on `journal:create` but exposes a `journal:post`-gated action with no client-side check — a user who can reach the page may see a Post button that 403s. Read-only report pages (Trial Balance, P&L, Balance Sheet, Cost Centers, Dealer Aging, Client Ledger, Supplier Ledger) are **D** — no mutating action. |
| Quality/Repairs | none | New Repair, Deliver, Bill, cost-entry Save (`RepairJobs.tsx`); Send Batch (`HallmarkingPage.tsx`) | Zero `hasPermission` references in either file. |
| Settings | none | Send Invite, branch-access grant, edit-member, revoke-invitation (`CompanyUsersPage.tsx`); Save/Delete/New Role (`RoleEditorPage.tsx`) | Reachability of these pages is itself only nav-gated, and (§9) the Role Editor's own nav entry is currently mis-gated. |
| Reports (all) | — | — | **D** — read-only, no mutating action, pattern-matched rather than individually re-verified line by line. |

**No frontend route guard exists at all.** `client/src/App.tsx`'s `ProtectedRoute` (lines 14–21) checks only
`isAuthenticated && company && user` — no permission check — and `pageRoutes.tsx` maps every path straight
to its component with no gating wrapper. Combined with the table above, **any authenticated user of any
role can deep-link directly to any page in the app** (e.g. `/settings/roles`, `/masters`) and the page will
fully mount, rendering its unconditional buttons, even for a role with none of the underlying permissions —
only the resulting API calls will 403. This is the mechanism that turns "some buttons aren't gated" into "a
whole page most users shouldn't see is fully reachable and interactive-looking."

---

## 8. Navigation audit

`client/src/components/Layout/navItems.tsx` (146 lines) — every nav item, including Dashboard and Workflow
Guide, carries a `permission` field (both use the broad `report:view`, reasonably, as the "logged in and
operational" baseline). No unconditionally-visible sensitive nav item was found.

**Confirmed defect (found independently by two of the four research passes):** `navItems.tsx:141` gates
"Roles & Permissions" (`/settings/roles`) on `permission: 'role:manage'`. Migration
`20260927150000_split_role_manage_permission` rewrote every `Role` row that held `role:manage`, replacing it
with the four granular strings (`role:view/create/edit/delete`) — `role:manage` is no longer even a valid
catalog entry (`permissionCatalog.ts:158` only lists the granular four; `isValidPermissionList` would reject
`role:manage` outright if anyone tried to grant it today). **Consequence**: no ordinary delegated role can
ever hold `role:manage` again, so this nav item is permanently invisible to anyone except a `'*'`-wildcard
(SUPER_ADMIN-equivalent) role — even a role explicitly granted all four granular permissions through the
Role Editor will never see the link, though the backend would serve every one of those endpoints for them.
The companion migration (`20260927160000`, `branch:manage` → `branch:create`/`branch:edit`) correctly
updated its own nav entry (`navItems.tsx:84`) at the same time — only the `role:manage` entry was missed.
`API.md` (lines 353–354) documents the same stale `role:manage` gate, so the doc and the code are
consistently wrong together, not contradicting each other.

No other nav-item/page-capability mismatch was found (55 entries checked). The `sales:view` (list/nav) vs.
`invoice:create`/`payment:create`/`return:create` (mutation) split used throughout Sales is a deliberate,
consistent view/action separation, not a mismatch.

---

## 9. Role Editor audit

Full trace, `client/src/pages/Settings/RoleEditorPage.tsx` → `settings.service.ts`:

- The permission grid is built **only** from `GET /settings/permission-catalog`, itself served straight
  from `PERMISSION_CATALOG` — there is no free-text permission entry anywhere in the component. The only
  non-catalog-sourced value is the literal `'*'` via the "Full access" checkbox.
- **Server-side validation is independent of the UI's own catalog-only construction** (true defense in
  depth): both `createRole` and `updateRole` call `isValidPermissionList(data.permissions)` and throw a 400
  on any string that isn't `'*'` or a catalog member. A fabricated or renamed-away permission string cannot
  be persisted via a direct API call even if the UI were bypassed.
- **Company scoping**: `updateRole`/`deleteRole` both call `assertOwnedByCompany('role', roleId,
  ctx.companyId, 'Role')` before acting — a cross-company role id 404s. `createRole` has no id to check; the
  new row is created with `companyId: ctx.companyId` directly.
- **SUPER_ADMIN is protected on both tiers, independently**: frontend hides the permission grid, the "Full
  access" checkbox, and the Delete button when `selectedRole?.name === 'SUPER_ADMIN'`; backend independently
  refuses (400) to change `SUPER_ADMIN`'s permissions or delete it, even via a direct API call that bypassed
  the UI's hiding entirely. Display-name-only edits still pass on both tiers.
- **Migration implication of the `role:manage` split** (tying back to §8): the split migration correctly
  rewrote persisted `Role.permissions` arrays and the catalog itself, but did not — and structurally
  couldn't, being a DB migration — touch the frontend nav-gating string. This is the direct cause of §8's
  defect, not a separate bug.

---

## 10. Starter Package analysis

Full permission sets per starter role, as literally defined in `starterPackage/v1.ts`:

- **`SUPER_ADMIN`**: `['*']`
- **`PRODUCTION_MANAGER`**: design:view, bom:manage, cost:estimate, po:view, grn:create, stock:view,
  stone:manage, stone:split, order:view/create/approve, reservation:manage, job:view/create/update,
  wip:update, qc:inspect/approve, karigar:view/issue/return, hallmark:manage, repair:view/create/edit/manage,
  invoice:create, report:view, masters:view, client:view/create/edit, payment:create, return:create
- **`ACCOUNTANT`**: finance:view, journal:create/post, report:view, tax:manage, invoice:create, sales:view,
  stock:view, order:view, masters:view, client:view, payment:create, return:create
- **`SALES_MANAGER`**: sales:view/create, memo:manage, invoice:create, export:doc, order:view/create,
  report:view, masters:view, client:view/create/edit, payment:create, return:create, estimation:view/manage,
  estimateTemplate:view, tag:view/create, branch:create/edit/transfer/approve, stock:adjust, user:manage,
  role:view/create/edit/delete, system:config, audit:view
- **`FLOOR_WORKER`**: job:view, wip:update, karigar:view
- **`STORE_MANAGER`**: stock:view/adjust, stone:manage/split, consumable:manage, po:view, grn:create/verify,
  report:view, masters:view, tagTemplate:view/create/edit, estimation:view/manage,
  estimateTemplate:view/create/edit

**No literal resource wildcard** (`'client:*'` etc.) appears anywhere in any non-SUPER_ADMIN role — confirmed
by grep. The `${resource}:*` matching branch in `rbac.ts` is therefore currently dead in practice for every
shipped role except the full `'*'`.

**Confirmed absent from every starter role** (reachable only via `SUPER_ADMIN`'s `'*'` today):
`client:deactivate`, `client:delete`, `invoice:void`, `payment:reverse` — matches CLAUDE.md's own claim
exactly. **`invoice:edit`** (the Phase I8 amend-invoice capability) is in the identical position — granted to
no starter role, SUPER_ADMIN-only in practice — which CLAUDE.md does not call out explicitly anywhere, so
this report is the first place that's recorded.

**Catalog permissions granted to zero starter roles** (beyond the five above): `design:create`,
`design:edit` (only `design:view` is ever granted), `subcon:invoice`, `hardware:manage`, `masters:create`,
`masters:edit`, `masters:delete` (only `masters:view` is ever granted).

**Migration plan (documented, not executed, per the audit brief's instruction):** any future decision to
grant one of the above to a starter role only affects companies provisioned *after* a new starter-package
version ships (starter package is immutable per its own header, per CLAUDE.md §11 item 3). Reaching an
already-provisioned company (including the local dev company) requires either (a) a company's own
SUPER_ADMIN manually delegating the permission through the Role Editor — always available, no migration
needed — or (b) an explicit one-off script/UI action against that company's existing roles, following the
exact precedent already set twice in this codebase for `masters:view` and the J2 `client:*` additions
(CLAUDE.md's "F1"/"J2" sections). No such backfill was performed or recommended as automatic by this audit.

---

## 11. Legacy/stale permission analysis

| Item | Classification | Evidence |
|---|---|---|
| `rbac.ts`'s `PERMISSIONS` const object | **UNUSED / NEEDS CLEANUP** | Zero usages anywhere in `server/src/modules` (confirmed by grep); stale relative to the live catalog in both directions (missing `client:*`/`payment:*`/`return:*`/`invoice:void`; contains `design:delete`, never a real permission). Flagged by J2's own review already, left untouched since — safe to delete once confirmed nothing external reads it. |
| `qc:approve`, `sales:create`, `tax:manage` | **POTENTIALLY DANGEROUS (misleading, not exploitable)** | Granted to production starter roles today, enforced by zero routes — an admin granting/revoking these believes they're changing access; they are not. |
| `navItems.tsx:141`'s `role:manage` | **NEEDS CLEANUP (confirmed defect, see §8)** | Retired by migration `20260927150000`; not a valid catalog string; permanently dead nav gate for non-SUPER_ADMIN roles. |
| `API.md` lines 353–354 | **NEEDS CLEANUP (doc drift, same root cause as above)** | Documents `/roles` as `role:manage`-gated, matching the same stale string. |
| `PHASE_J1_AUDIT.md` §1.1 | **NEEDS CLEANUP (doc defect, informational only)** | Claims "zero `router.delete(` exists anywhere in the entire server codebase," directly contradicted by the same document's own classification matrix, which discusses multiple live DELETE routes (masters, PO). Confirmed live today: 10 `mastersRouter.delete(...)` routes (`masters:delete`) plus `procurementRouter.delete('/orders/:id', ...)` (`po:create`, elevated by the `po:*`/`po:approve` check at `procurement.router.ts:163` above the approved-status threshold). This is a baseline-document accuracy issue, not a code defect — noted because J1's matrix is treated as frozen/authoritative elsewhere in this project. |
| No frontend permission-string duplication | **CORRECT** | No local `PERMISSIONS`-like object exists in `client/src`; the Role Editor fetches the catalog live from the backend, eliminating drift risk by construction. |

---

## 12. Cross-company authorization review

Re-verified by static inspection (not a re-run of `COMPANY_ISOLATION_AUDIT.md`'s full suite, which already
covers this ground) for the specific administrative surfaces J3 added:

- `voidInvoice`, `reverseInvoicePayment`, `setClientActive`, `deleteClient` — all four independently call
  `assertOwnedByCompany` (or an equivalent inline check) on the target row *before* acting, regardless of
  caller authority (§5). A cross-company id 404s; nothing is persisted.
- Role Editor (`updateRole`/`deleteRole`) — same pattern, confirmed at `settings.service.ts` (§10).
- The full authenticate → company → permission → ownership → dependency → transaction → mutation → audit →
  response sequence was traced end-to-end for `voidInvoice` and `reverseInvoicePayment` specifically and
  holds with no step skipped or reordered.

No new cross-company gap was found in this pass. This confirms — for the J3/J4-relevant surface only — that
the architecture COMPANY_ISOLATION_AUDIT.md already validated repo-wide continues to hold for the newest
code.

---

## 13. Audit-log authorization review

All five J3-era administrative operations (`setClientActive`, `deleteClient`, `voidInvoice`,
`reverseInvoicePayment` — including its OLD_GOLD/MetalStock reversal branch — and `billRepairJob`'s rebill
path) call `createAuditEntry(...)` with:
- a distinct action string per operation (`DEACTIVATE`/`REACTIVATE`, `FORCE_DELETE`, `VOID`, `REVERSE` ×3
  for the payment/exchange/metal-stock triad, `REBILL`/`BILL`),
- the correct `companyId` (which `createAuditEntry` itself requires and validates membership against),
- the acting `userId`,
- meaningful before/after payloads in every case (full row/exchange snapshots, not bare reason strings —
  this was an explicit J3.5 hardening fix, confirmed still in place).

`createAuditEntry`'s own required-`companyId`-and-membership-throw behavior (`middleware/audit.ts`) was
independently re-confirmed as a real gate, not a no-op default.

**No non-test application code path calls `prisma.auditLog.update`/`.delete`/`.deleteMany` anywhere.** All 14
matches for those methods across `server/src` are test-fixture teardown code (`afterAll`/`afterEach` blocks
across ~10 test files) — confirmed by reading each match's surrounding context, not just the grep hit.
`PlatformAuditLog` remains a structurally separate table with no company route reading it, consistent with
CLAUDE.md §11 item 2.

---

## 14. Read/report permission review

**`report:view`** is the single permission gating nearly the entire reporting surface: trial balance, P&L,
balance sheet, cost-center profitability, **dealer aging**, **per-client ledger** (individual customer
running balances), day-book, GST summary, supplier ledger, purchase GST summary, dashboard, wip-summary,
stock-summary, karigar-balances, aging-receivables, sales register, stock-on-hand, stock-book, dead-stock.
Every one of `PRODUCTION_MANAGER`, `ACCOUNTANT`, `SALES_MANAGER`, and `STORE_MANAGER` (i.e. every starter
role except `FLOOR_WORKER`) holds `report:view`, meaning all four can see full company-wide financial detail
— including named customers' individual outstanding balances and aging — through this one permission,
regardless of whether their role otherwise touches finance at all (e.g. `STORE_MANAGER` has no `finance:view`
or `client:*` grant, yet can read `getClientLedger`/`getDealerAging` in full via `report:view` alone). This
is **not classified as a defect** — it may be entirely intentional for a business this size where operational
staff are trusted with full visibility — but it is flagged as a genuine granularity question with a concrete
consequence (§16, Human Decision 1), which distinguishes it from a theoretical-purity complaint.

`finance:view` (a separate, narrower permission gating raw journal/account/cost-center *list* endpoints) is
**not** required to see the aggregated financial *reports* built from that same data — an odd asymmetry
worth the same human decision.

Payment history (`GET /clients/:clientId/payments`) rides `sales:view` rather than a dedicated `payment:view`
— reasonably scoped in practice (not granted to `PRODUCTION_MANAGER`/`STORE_MANAGER`), noted only as a minor
naming question (§16, Human Decision 6), not a defect.

---

## 15. Test coverage gaps

Confirmed present: `server/src/test/http.j3Administrative.test.ts` covers all four new J3 permissions with
real granted-vs-missing-403 HTTP pairs; `settings.service.test.ts` covers Role Editor company-scoping,
SUPER_ADMIN-role immutability, and catalog validation (rejecting an unknown permission string); every J3
service function's own test suite includes a cross-company-id-404 case using a full-permission fixture.

**Confirmed zero coverage**, each independently significant:
1. **The `${resource}:*` wildcard branch of `requirePermission`** (`rbac.ts:10`) — no test anywhere
   constructs a role with a literal resource wildcard and confirms it satisfies a narrower permission check.
   Currently untriggered by any shipped role (§10), but the code path is live and unverified.
2. **All frontend permission-gated UI** — there are **zero test files** anywhere under `client/src` (no
   RTL/vitest/jest specs at all), so there is categorically no automated coverage of any button/nav
   visibility behavior, gated or not.
3. **Role-edit → JWT re-issuance end-to-end.** Given §7/§12's JWT-trace finding that `authenticate()`
   re-reads `Role.permissions` fresh from the DB every request (not from the token's embedded claim), this
   gap is narrower in practice than it would be for a token-trusting design, but no test chains
   `updateRole()` → a subsequent authenticated request → asserts the new permission is honored without a
   fresh login.
4. **A literal `SUPER_ADMIN`-named role token used cross-company** against any J3 endpoint — current tests
   use functionally-equivalent full-permission fixtures, not the named role specifically switching between
   two real companies.
5. **A delegated (non-SUPER_ADMIN) role actually granted one of the four J3 permissions through a
   persisted Role Editor round trip**, then exercised over real HTTP — existing tests construct ad hoc
   test-tenant contexts with exactly the permission under test, not a Role-Editor-created-and-saved role.
6. **"Reject a removed/renamed permission string"** as distinct from "reject a never-valid string" —
   `settings.service.test.ts`'s existing catalog-validation test uses an obviously-fabricated string; no
   test simulates a permission that used to be valid (like the real `role:manage` retirement, §8/§9) and
   confirms it's now correctly rejected.

---

## 16. Confirmed defects, possible smells, and human decisions — grouped per §20 of the audit brief

### J4.1 — Must Fix (concrete authorization/security defects)

1. **`GET /settings/design-categories` has no permission gate** (`settings.router.ts:67-73`) — any
   authenticated company member of any role can read it. *Files: `server/src/modules/settings/settings.router.ts`. Tests required: a granted-vs-any-authenticated-user HTTP pair, mirroring `http.j3Administrative.test.ts`'s style. Risk of change: trivial (adding a `requirePermission('design:view')` or `masters:view` call — human decision needed on which permission, since it's currently reachable by everyone). Migration implication: none — this only narrows an already-too-open gate; no existing grant needs to change for anyone who's supposed to keep access, since `design:view`/`masters:view` are already broadly granted.*
2. **`procurement.service.ts: approvePO` hardcodes `SUPER_ADMIN`/`PRODUCTION_MANAGER` role-name checks**
   instead of using the permission system for its ₹5,00,000 high-value threshold, contradicting CLAUDE.md
   §6.2 directly; mirrored client-side in `PurchaseOrders.tsx`. *Files: `server/src/modules/procurement/procurement.service.ts`, `client/src/pages/Procurement/PurchaseOrders.tsx`. Tests required: a delegated role with `po:approve` but a non-listed role name should be able to approve a high-value PO once fixed — needs a new regression test either way. Migration implication: this is where §16 Human Decision 2 must be resolved first — is a new permission string introduced, or is the existing `po:approve` simply trusted at any threshold? Risk of change: moderate — touches a live financial control with a real ₹-threshold business rule, needs explicit sign-off before implementation, not a pure mechanical fix.*
3. **`navItems.tsx:141` gates "Roles & Permissions" on the retired `role:manage` string**, permanently
   hiding it from any role holding the correct granular `role:view/create/edit/delete` permissions.
   *Files: `client/src/components/Layout/navItems.tsx`. Tests required: none exist for nav visibility today (§15 finding 2) — this would be the first, if frontend tests are ever introduced. Risk of change: trivial, single-line string fix (`role:manage` → `role:view`), no migration implication (nothing server-side changes).*
4. **`API.md` documents the same stale `role:manage` gate** — doc-only but should ship alongside #3 so the
   two don't drift again. *Files: `API.md` lines 353–354.*

### J4.2 — Should Fix (meaningful UX / permission-consistency problems)

1. **`GET /procurement/grn` is gated by `grn:create`; no `grn:view` exists.** Needs a new permission added
   to the catalog first (this is why it's not in J4.1 — it requires a catalog change, which per §10's
   established precedent needs a starter-role migration decision, not just a route edit).
2. **`POST /procurement/returns` gated by `po:approve`** rather than a create-shaped permission — re-examine
   intended semantics (Human Decision, see below).
3. **The systemic "backend-protected but UI unconditional" pattern (classification B)** — spans Masters (all
   tabs), Clients (Add/Payment), Sales (Record Payment, Return Selected, New Sale, Memo Out), Procurement
   (New/Create PO, Create/Approve GRN, Add Supplier), Finance (New Journal, Post), Quality/Repairs (New,
   Deliver, Bill, cost-entry), Settings (invite/branch-access/edit-member/revoke, Role Editor Save/Delete/
   New). This is the largest single finding by volume and directly contradicts CLAUDE.md §6.10. Recommend
   building one reusable permission-gating pattern (a `<PermissionGate>` wrapper or a shared prop convention
   over `hasPermission()`) per CLAUDE.md §6.11's "common pattern, not dozens of one-offs" directive, then
   rolling it out module by module, stopping for review after each — mirroring how J2/J3 themselves were
   sliced.
4. **No frontend route guard beyond authentication** (`App.tsx`'s `ProtectedRoute`, `pageRoutes.tsx`) — any
   authenticated user can deep-link to any page regardless of permission. Should be addressed alongside #3,
   since a route guard without button-level gating (or vice versa) only solves half the problem.
5. **Three dead/inert catalog permissions** (`qc:approve`, `sales:create`, `tax:manage`) — either wire them
   to a real check or remove them from the catalog/starter roles; currently misleading to any admin using
   the Role Editor.
6. **`journal:post` has no corresponding UI gate** on `JournalEntries.tsx`'s Post action, even though the
   page itself is nav-gated on the separate `journal:create` — a user who can reach the page may see a
   button that always 403s for them.
7. **`branchAccess` is not re-derived per request** the way `Role.permissions` is (§2/§7) — a revoked branch
   grant only takes effect server-side at the caller's next token refresh/login, unlike a permission change,
   which the JWT trace shows takes effect on the very next request. This inconsistency between two similar-
   looking authorization inputs is worth resolving explicitly, even though it does not cross a tenant
   boundary and matches an already-documented "log out and back in" caveat pattern elsewhere in this
   codebase.

### J4.3 — Migration (existing-role / starter-package changes requiring controlled rollout)

1. Any fix that adds a new permission string (e.g. a prospective `grn:view`, or a new threshold-approval
   permission for `approvePO`) or changes which permission gates an existing route follows the exact
   precedent already established twice in this codebase (`masters:view`, J2's `client:*` additions):
   additive to the starter package only reaches companies provisioned after the change ships; any
   already-provisioned company (including local dev) needs its existing roles updated directly (Role Editor
   or a one-off script) to avoid a silent access regression for users who currently rely on the
   soon-to-be-narrower gate.
2. `client:deactivate`, `client:delete`, `invoice:void`, `payment:reverse`, and (newly documented here)
   `invoice:edit` remain reachable by no starter role — this is J3 Decision 6, correctly left untouched by
   this audit, restated here only so the operational reality ("nothing but a company's own SUPER_ADMIN can
   grant these today") is explicit for whoever plans J4's implementation slices.

### J4.4 — Future Cleanup (low-risk stale/legacy)

1. Delete `rbac.ts`'s unused `PERMISSIONS` const object (zero usages confirmed; verify no external tooling
   depends on it first).
2. Correct `PHASE_J1_AUDIT.md` §1.1's self-contradictory "zero DELETE routes" claim — documentation
   accuracy only, no code implication.

### J4.5 — Human Decisions Required

1. Should `report:view` remain one broad permission covering sensitive per-client financial data (dealer
   aging, client ledger, GST summary, day book) alongside purely operational reports (stock-on-hand,
   dead-stock, wip-summary), or should the financial-detail reports be split into their own, narrower
   permission? Currently every starter role except `FLOOR_WORKER` can see full company financial detail
   through this one grant (§14).
2. Should `approvePO`'s ₹5,00,000 high-value threshold move to a permission string (letting a delegated
   non-SUPER_ADMIN/non-PRODUCTION_MANAGER role be granted that specific authority), or is restricting it to
   those two role names intentional business policy that should simply be documented as an intentional
   exception to CLAUDE.md §6.2 rather than fixed?
3. Should any of `client:deactivate`/`client:delete`/`invoice:void`/`payment:reverse`/`invoice:edit` be added
   to a starter role in a future package version, and/or should a backfill script be offered for existing
   companies that want to delegate one of them now? (Not a re-opening of J3 Decision 6 — that decision
   stands; this only asks whether it's time for the next step it deliberately deferred.)
4. Rollout order and design for the systemic frontend gating gap (J4.2 #3/#4) — module-by-module priority,
   and whether a shared gating component should be built and reviewed before any individual page is touched.
5. Should `grn:view` be introduced as a new catalog permission split from `grn:create`, and which starter
   roles should receive it immediately (determines whether the change is purely additive/safe or needs the
   same existing-company backfill treatment as `masters:view` did)?
6. Should payment history get its own `payment:view` permission distinct from `sales:view`? No concrete
   abuse case was found — include only if full permission-per-resource consistency is a goal in its own
   right.

---

## 17. Proposed J4 implementation slices (design only — not implemented by this audit)

Consistent with how J2/J3 were themselves sliced and reviewed (per CLAUDE.md's own account of that process):

1. **Slice 1 — J4.1 defects**, once Human Decision 2 is resolved for item 2: the `design-categories` gate,
   the `approvePO` permission-ization, and the `navItems.tsx`/`API.md` `role:manage` string fix. Smallest,
   highest-confidence, no starter-package/migration entanglement for items 1/3/4.
2. **Slice 2 — shared frontend permission-gating pattern** (a `<PermissionGate>`-style component or
   equivalent convention) + a frontend route guard, built and reviewed once, before any page-level rollout.
3. **Slice 3+ — module-by-module UI gating rollout** using Slice 2's pattern: Masters, then Clients, then
   Sales, then Procurement, then Quality/Repairs, then Settings — stopping for review after each, per the
   audit brief's own instruction not to implement Phase J as one uncontrolled change.
4. **Slice N — catalog/permission additions** (`grn:view`, any `approvePO` threshold permission) bundled with
   their own starter-package and existing-company migration plan, kept separate from the pure-UI slices
   above since they carry real migration risk the UI work doesn't.
5. **Cleanup slice** — J4.4 items, lowest priority, no functional risk.

**Files likely affected across all slices** (for planning only): `server/src/modules/settings/settings.router.ts`,
`server/src/modules/procurement/procurement.service.ts`, `server/src/modules/procurement/procurement.router.ts`,
`client/src/pages/Procurement/PurchaseOrders.tsx`, `client/src/components/Layout/navItems.tsx`, `API.md`,
`server/src/middleware/rbac.ts` (cleanup only), `client/src/App.tsx`, `client/src/pageRoutes.tsx`, a new
shared frontend gating component (path TBD), and — page by page as each slice proceeds —
`MastersPage.tsx`, `Clients.tsx`, `SalesInvoices.tsx`, `NewSalePage.tsx`, `MemoOutPage.tsx`,
`GrnVerification.tsx`, `Suppliers.tsx`, `PurchaseReturns.tsx`, `JournalEntries.tsx`, `RepairJobs.tsx`,
`HallmarkingPage.tsx`, `CompanyUsersPage.tsx`, `RoleEditorPage.tsx`. Any catalog/starter-package change also
touches `server/src/shared/permissionCatalog.ts`, `server/src/modules/platform/starterPackage/v1.ts`, and
needs a new Prisma migration plus an existing-company backfill plan per §10/J4.3.

---

## 18. Explicit out-of-scope items

- J1–J3.5 decisions were treated as frozen throughout — none were revisited, only their current
  implementation state was verified.
- Tenant/company isolation and RLS were **not** re-audited repo-wide; `COMPANY_ISOLATION_AUDIT.md` already
  covers that ground. This report only spot-checked the newest (J3) administrative surface against that
  same contract (§12).
- No code, schema, migration, permission, role, starter-package, test file, or documentation file was
  modified to produce this report — the one file created is this report itself, the explicitly permitted
  exception per the audit brief.
- Frontend implementation of any J4.1/J4.2 finding is deferred to a future, explicitly-scoped implementation
  phase — this document is design/audit only.
- Deep line-by-line re-verification was not performed for every single one of the ~150+ enumerated routes;
  the full table was produced and reviewed, and every route not called out in §4 is asserted CORRECT based
  on that review, not re-derived independently by a second pass.

---

## 19. Verification performed

- Read in full: `CLAUDE.md` (project source of truth), `PHASE_J1_AUDIT.md`, `PHASE_J2_REVIEW.md`,
  `PHASE_J3_DESIGN_AUDIT.md`, `PHASE_J3_DECISIONS.md`, `PHASE_J3_IMPLEMENTATION.md`,
  `PHASE_J3.5_HARDENING.md`, `server/src/shared/permissionCatalog.ts`, `server/src/middleware/rbac.ts`
  (direct reads by the lead session).
- Four parallel, independent, read-only research passes (general-purpose agents, no Edit/Write tool access
  exercised) covering: (1) baseline docs synthesis + starter package vs. catalog cross-reference + legacy
  permission audit; (2) full backend endpoint enumeration + service-level bypass-risk audit + SUPER_ADMIN/
  wildcard boundary audit; (3) frontend permission-helper trace + button/action gating audit + navigation
  audit + Role Editor audit; (4) JWT/auth trace + audit-log authorization for J3 actions + test-coverage
  audit.
- Cross-validation: two of the four passes independently discovered and confirmed the same
  `navItems.tsx:141` / retired-`role:manage` defect from different angles (starter-package/legacy audit and
  dedicated navigation audit), which is treated as higher-confidence corroboration rather than a duplicate
  finding.
- All claims in this report are grounded in file:line citations gathered by the four passes; no finding was
  asserted without a specific code location backing it.
- No `npm run test:rls`, `npm run audit:tenant`, or test suite run was performed or needed — this is a
  read-only design audit with no code change to verify.

---

## 20. Final status

**J4 DESIGN AUDIT: COMPLETE — READY FOR HUMAN REVIEW**
