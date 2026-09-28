# Phase J2 Review — Sales & Client permission slice (hardening pass, 2026-09-28)

> This is a review of the already-completed J2 first slice (Client/Payment/Return re-gating), not new
> implementation. Per the review brief: no delete/hard-delete/soft-delete/restore/reverse/void/deactivate/
> amend/administrative-override work was performed or is proposed here. J3 was not started. Nothing was
> committed.

---

## 1. Scope

Confirmed by reading the exact diff of every file J2 touched
(`git diff -- server/src/modules/orders/orders.router.ts server/src/modules/sales/sales.router.ts
server/src/shared/permissionCatalog.ts server/src/modules/platform/starterPackage/v1.ts
client/src/components/Layout/navItems.tsx`):

**J2's actual contribution is exactly:**
- `orders.router.ts`: 3 permission strings changed (`order:view`→`client:view`, `order:create`→`client:create`
  on POST, `order:create`→`client:edit` on PATCH).
- `sales.router.ts`: 3 permission strings changed (2× `invoice:create`→`payment:create`, 1×
  `invoice:create`→`return:create`).
- `permissionCatalog.ts`: one new catalog row (`client`) and two new catalog items (`payment`, `return`)
  added under the existing "Sales & Export" group — no existing row changed.
- `starterPackage/v1.ts`: `client:view`/`client:create`/`client:edit`/`payment:create`/`return:create`
  **added alongside** (never replacing) the existing `order:*`/`invoice:create` grants on
  `PRODUCTION_MANAGER`/`ACCOUNTANT`/`SALES_MANAGER`.
- `navItems.tsx`: 1 line (`Clients` nav permission `order:view`→`client:view`).

**No business logic changed anywhere** — every touched line is a permission-string swap on an
`requirePermission(...)` call, a catalog entry, or a role's permission array. `orders.service.ts`,
`sales.service.ts` (the actual `createClient`/`updateClient`/`recordPayment`/`recordClientPayment`/
`createSalesReturn` implementations) were **not touched** by J2 and are unchanged from the state
`COMPANY_ISOLATION_AUDIT.md` already verified as its baseline.

**Note on the diff's noise:** `starterPackage/v1.ts` and `navItems.tsx` also contain unrelated permission-
split changes (`branch:manage`→`branch:create`/`edit`, `role:manage`→`role:view`/`create`/`edit`/`delete`,
`tagTemplate:manage`→`view`/`create`/`edit`, `estimateTemplate:manage`→`view`/`create`/`edit`,
`repair:manage`→`view`/`create`/`edit`/`manage`, plus a new "Management" nav section) that **predate this
session** (confirmed against the two untracked migration folders already present at session start —
`20260927150000_split_role_manage_permission`, `20260927160000_split_branch_tagtemplate_estimatetemplate_
repair_permissions` — and the fact that `permissionCatalog.ts` itself was already untracked/new before J1
began). Per the review brief's "do not perform unrelated cleanup," this review does not audit or touch that
work — it is out of scope for a Client/Payment/Return review.

---

## 2. Client endpoint coverage

Searched the whole server tree for every write path to the `Client` Prisma model (`.client.create(`,
`.client.update(`, `.client.updateMany(`, `.client.upsert(`) and every frontend `apiPost`/`apiPatch` to a
client-shaped path.

| Path | Permission | Verdict |
|---|---|---|
| `GET /orders/clients` (list/search) | `client:view` | Correct — `orders.router.ts:60` |
| `POST /orders/clients` (create) | `client:create` | Correct — `orders.router.ts:64` |
| `PATCH /orders/clients/:id` (edit) | `client:edit` | Correct — `orders.router.ts:69` |
| `tx.client.update(...)` inside `sales.service.ts` (9 call sites: createInvoice, amendInvoice ×3, applyPayment, recordClientPayment, createSalesReturn, createOldGoldExchange, convertMemoToInvoice) | governed by the calling action's own permission (`invoice:create`/`invoice:edit`/`payment:create`(now)/`return:create`(now)/`memo:manage`) | **Not a bypass.** Read every call site (§1 of this review's research): each one **only ever writes `currentBalance` via `increment`/`decrement`**, never an arbitrary field. This is an internal ledger side-effect of an already-gated transaction, not a general "edit a client" capability. `currentBalance` is explicitly excluded from `CLIENT_WRITABLE_KEYS` in `orders.service.ts` (comment: "currentBalance is moved by invoices/payments alone, never typed in") — confirming this is the intended, sole write path for that field. |
| `POST /tagging/manufacturers/from-supplier` → `manufacturerForSupplier()` (creates a `Client` of type `MANUFACTURER`) | `tag:create` (unchanged) | **Legitimate exception, not a defect.** This is a narrow, idempotent, system-derived record created as a side effect of the tag-creation workflow ("found by GSTIN/name among existing manufacturers, created once if none exists" — `tagging.service.ts:20-26`), gated by the permission for the workflow it's embedded in, exactly like `applyPayment`'s `client.update` above. Requiring `client:create` here would be a **regression**: it would break tag creation with a pre-filled manufacturer for anyone who has `tag:create` but not `client:create` (there is no starter role today with `tag:create` but not `client:create`, but the two are conceptually independent capabilities and should stay that way — this endpoint doesn't let a caller create an arbitrary `RETAIL`/`WHOLESALE` client, only a narrowly-derived `MANUFACTURER` one from an already-owned `Supplier`). **Not changed.** |
| `client/src/pages/Masters/MastersPage.tsx:1219` — a "Manufacturers" tab posting/patching `/orders/clients` | `client:create`/`client:edit` (via the same endpoint, now correct) | **Confirmed intentional, documented in the page's own copy**: "Same records as Orders > Clients; this is just a masters-styled front door onto the same table" (`MastersPage.tsx:1250`). Not a separate code path — hits the exact endpoint already reviewed above, so it's correctly gated. **Note, not a defect:** a user with `masters:edit` but not `client:edit` would see this tab (nav/page gating is by `masters:view`) but get a 403 attempting to save — a UX inconsistency worth a product decision, not a security bug (server enforcement is correct). Flagged for J4, not fixed here. |
| `client/src/pages/Sales/NewSalePage.tsx:129,454` — inline "quick-add client" during a sale | `client:create` (via the same endpoint) | Same endpoint, correctly gated. |
| `client/src/pages/Tagging/NewTagPage.tsx:325` — inline "add a new manufacturer" (distinct from the pre-fill-from-PO path above) | `client:create` (via the same endpoint, `{ ...data, type: 'MANUFACTURER' }`) | Same endpoint, correctly gated — this is the *manual* add-a-brand-new-manufacturer path, distinct from `manufacturerForSupplier`'s auto-derive-from-PO path; correctly requires `client:create` since it's a genuine new-record creation, not a workflow side-effect. |

**Bypass search (item 10 of the review brief):** confirmed via `app.ts`'s router-mount list — `ordersRouter`
is mounted exactly once, at `/orders`; no legacy/duplicate mount, no bulk-import endpoint, no platform-level
Client CRUD (`server/src/modules/platform/` has zero references to Client), no raw-SQL write to `clients`
outside test fixtures. `rejectClientTenantSelectors` (app-level middleware, `app.ts:77`, before any router)
independently blocks a client-supplied `companyId`/`tenantId`/`organizationId` on every request, including
these.

**Conclusion: no genuine defect. Client coverage is complete and consistent.**

---

## 3. Payment endpoint coverage

Searched for every write path to `InvoicePayment` (`.invoicePayment.create(`) and every call site of
`recordPayment`/`recordClientPayment`/`applyPayment`.

| Path | Permission | Verdict |
|---|---|---|
| `POST /invoices/:id/payment` → `recordPayment()` | `payment:create` | Correct — `sales.router.ts:196` |
| `POST /sales/clients/:clientId/payments` → `recordClientPayment()` | `payment:create` | Correct — `sales.router.ts:213` |
| `applyPayment()` (internal, called from `createInvoice`'s bill-and-collect and from `recordPayment`) | governed by the caller (`invoice:create` for bill-and-collect, `payment:create` for standalone) | Not an independent route — has no permission of its own by design, same shape as `createSalesReturn`'s use inside `convertMemoToInvoice`. |
| `GET /sales/clients/:clientId/payments` (list) | `sales:view` | Unchanged, correctly a read permission, not part of this review's create-side scope. |

Supplier payments (`recordSupplierPayment`, `POST /procurement/suppliers/:id/payments`, gated by
`journal:create`) are a **separate model and permission family** (procurement, not sales) — correctly out of
scope for this review; not touched, not reclassified.

**Bypass search:** `.invoicePayment.create(` outside `sales.service.ts` appears only in test fixture setup
(`finance.service.test.ts`) — direct-Prisma test fixtures, not an application code path. No second router
exposes this model.

**Conclusion: no genuine defect. Payment coverage is complete and consistent.**

---

## 4. Sales Return endpoint coverage

Searched for every write path to `SalesReturn` (`.salesReturn.create(`) and every call site of
`createSalesReturn`.

| Path | Permission | Verdict |
|---|---|---|
| `POST /sales/returns` → `createSalesReturn()` | `return:create` | Correct — `sales.router.ts:237` |
| `GET /sales/returns` (list) | `sales:view` | Unchanged, correctly a read permission. |
| `client/src/pages/Sales/SalesInvoices.tsx:101` (`ReturnItemsForm`, the only UI entry point) | `return:create` (via the same endpoint) | Confirmed the only frontend call site. |

`PurchaseReturn` (procurement, gated by `po:approve`) is a separate model/family — correctly out of scope,
not touched.

**Conclusion: no genuine defect. Return coverage is complete and consistent.**

---

## 5. Old-permission audit — every remaining `order:create`/`order:view`/`invoice:create` occurrence

Full-repo grep for `requirePermission('order:create')`, `requirePermission('order:view')`,
`requirePermission('invoice:create')` outside the 6 call sites J2 already fixed:

| File:Line | Route | Classification |
|---|---|---|
| `orders.router.ts:73` | `GET /orders` (list SalesOrder) | **A** — correctly belongs to Orders (production order, dormant per CLAUDE.md §2) |
| `orders.router.ts:84` | `GET /orders/:id` | **A** |
| `orders.router.ts:89` | `POST /orders` (create SalesOrder) | **A** |
| `quality.router.ts:67` | `POST /repairs/:id/bill` (bills via `createInvoice()`) | **B** — correctly belongs to Invoices; creates a `SalesInvoice`, not a Client/Payment/Return |
| `sales.router.ts:132` | `GET /sales/staff` | **B** — a New-Sale-screen helper lookup, correctly rides the permission of the flow that consumes it |
| `sales.router.ts:148` | `GET /sales/estimates` | **B** — same reasoning |
| `sales.router.ts:153` | `GET /sales/branches` | **B** — same reasoning |
| `sales.router.ts:163` | `GET /sales/tax-context` | **B** — same reasoning |
| `sales.router.ts:168` | `POST /sales/invoices` (create invoice) | **B** — the invoice-creation endpoint itself |
| `sales.router.ts:220` | `GET /sales/clients/:clientId/credit` | **F — needs human review.** Reads a client's *derived* spendable credit (from returns/old-gold exchanges) specifically for the New Sale payment-mode picker — narrower than general client viewing, but it does read Client-domain data. Per the brief's "only fix confirmed C/D/E cases," this is left as `invoice:create` (unchanged) with the ambiguity flagged rather than silently reclassified either way. |
| `sales.router.ts:255` | `POST /sales/exchanges` (create `OldGoldExchange`) | **Not applicable** — neither Client, Payment, nor Return; a distinct transaction type outside this review's three-family scope. Not reclassified. |

No occurrence was found that should be C, D, or E (i.e., nothing was silently mis-permissioned as
Client/Payment/Return-shaped that J2 missed). **No fix applied from this section** — one item (`/credit`)
is explicitly flagged for a human product decision rather than auto-resolved.

---

## 6. RBAC plumbing — full chain verified

`permissionCatalog.ts` (server, source of truth) → `GET /settings/permission-catalog`
(`settings.router.ts:16-28`, no server-side change needed since it just returns the catalog) →
`RoleEditorPage.tsx:57` (`apiGet('/settings/permission-catalog')` — confirmed no hardcoded client-side
duplicate) → role save → `createRole`/`updateRole` validate the submitted array against
`isValidPermissionList()` (`settings.service.ts:18,49`, itself built from `ALL_CATALOG_PERMISSIONS`, itself
built from `PERMISSION_CATALOG`) → stored on `Role.permissions` → `requirePermission(...)` middleware
(`rbac.ts:4-21`) reads the JWT-derived `req.user.permissions` set on every request. **Confirmed working
end-to-end** — `client:view`/`client:create`/`client:edit`/`payment:create`/`return:create` are now
grantable through the Role Editor and enforced on the actual routes, not just added to a catalog with
nothing checking it.

**One pre-existing, unrelated staleness noted, not fixed:** `server/src/middleware/rbac.ts`'s
`export const PERMISSIONS = {...}` object (a `resource:action` string constant map) has **zero usages**
anywhere in `server/src/modules` (confirmed by grep) — every router uses raw string literals with
`requirePermission('...')`. It predates this session, is missing many permissions added since it was last
touched (not just `client:*`/`payment:*`/`return:*`), and doesn't affect enforcement (it's inert, unused
dead code). Per "do not perform unrelated cleanup," this review does not touch it — flagged for a future,
separate cleanup pass.

**Frontend gate:** neither `Clients.tsx`, `NewSalePage.tsx`, nor `SalesInvoices.tsx`'s `RecordPaymentForm`/
`ReturnItemsForm` have any `hasPermission(...)` check today (confirmed by grep — `SalesInvoices.tsx` has
exactly one, `canEdit = hasPermission('invoice:edit')`, unrelated to payment/return). **This is unchanged by
J2** — it was already absent before this session (consistent with the J1 audit's finding that
"frontend has zero permission-awareness" in several places) — J2 did not regress it, and adding it is a J4
frontend-polish task, not a J2 defect. Server-side enforcement is authoritative and confirmed correct either
way.

---

## 7. Starter Package v1 impact — existing-company migration required (documented, NOT executed)

`PRODUCTION_MANAGER`/`ACCOUNTANT`/`SALES_MANAGER` retain their exact previous effective capability — every
new permission was **added alongside**, never in place of, the permission it was borrowed from. **No
privilege was silently expanded**: nobody who lacked the ability to create/edit a client, record a payment,
or create a return before this change gained it; nobody who had it lost it.

| Existing role | Existing permission (kept) | New permission added | Existing-company action required |
|---|---|---|---|
| `PRODUCTION_MANAGER` | `order:view` | `client:view` | Grant `client:view` to this role |
| `PRODUCTION_MANAGER` | `order:create` | `client:create`, `client:edit` | Grant both to this role |
| `PRODUCTION_MANAGER` | `invoice:create` | `payment:create`, `return:create` | Grant both to this role |
| `ACCOUNTANT` | `order:view` | `client:view` | Grant `client:view` to this role |
| `ACCOUNTANT` | `invoice:create` | `payment:create`, `return:create` | Grant both to this role |
| `SALES_MANAGER` | `order:view` | `client:view` | Grant `client:view` to this role |
| `SALES_MANAGER` | `order:create` | `client:create`, `client:edit` | Grant both to this role |
| `SALES_MANAGER` | `invoice:create` | `payment:create`, `return:create` | Grant both to this role |
| `SUPER_ADMIN` | `*` | n/a | None — already covers everything |
| `FLOOR_WORKER`, `STORE_MANAGER` | (never had `order:*`/`invoice:create`) | none added | None — no change in scope or effective access |

**Because Starter Package v1 is immutable, this table only takes effect for a company provisioned from now
on.** An already-provisioned company (e.g. local dev SEA) needs one of:
1. **Preferred — no engineering involvement:** that company's own `SUPER_ADMIN` opens Settings > Roles,
   opens each of the three roles above, ticks the newly-visible Client/Payment/Return boxes in the Role
   Editor (now populated per §6), and saves. This is exactly the "customer administers their own
   company" model CLAUDE.md §6.1 describes — no script, no DB access.
2. **Operator fallback, for bulk rollout across many companies:** a one-off, idempotent script per the
   `masters:view` precedent CLAUDE.md already documents — conceptually
   `UPDATE roles SET permissions = array_cat(permissions, ARRAY[...]) WHERE name IN ('PRODUCTION_MANAGER','ACCOUNTANT','SALES_MANAGER') AND NOT (permissions @> ARRAY['client:view'])`,
   scoped per company, run once. **Not written or executed in this pass** — this is a description of the
   shape it would take, not a script to run.

**Same caveat as the documented `masters:view` precedent:** a user already logged in when either path runs
needs to log out and back in — their JWT carries the permission list from login time, and a plain 403
doesn't trigger the client's silent-refresh-on-401 flow the way an expired token does.

---

## 8. SUPER_ADMIN verification

Unchanged by J2 — no code touched in the authentication/tenant-context/RBAC-evaluation path.
`requirePermission` (`rbac.ts:9-11`) grants access when the user's permission set contains the exact string,
a `resource:*` wildcard, or the global `*` — `SUPER_ADMIN`'s `['*']` (starterPackage/v1.ts:44) satisfies
`client:*`/`payment:*`/`return:*` exactly as it does every other permission, no special-casing added or
needed. `SUPER_ADMIN` remains company-scoped: `resolveTenantContext` (`middleware/tenant.ts:43-56`) derives
`companyId` from the verified JWT for every role including `SUPER_ADMIN`; nothing in J2 introduced a path
that reads `companyId` from anywhere else. `SUPER_ADMIN`'s `client:create`/`updateClient` calls still go
through the same `orders.service.ts` functions with the same ownership checks (§9) — **`*` is a permission
wildcard, not an RLS or ownership bypass.** No global/platform bypass was introduced or exists for
`SUPER_ADMIN` in this slice.

---

## 9. Company isolation — verified for the J2-affected paths only (not redone)

Per `COMPANY_ISOLATION_AUDIT.md`'s already-established baseline, re-confirmed by direct read of the current
code for exactly the three touched paths:

- **`createClient`/`updateClient`** (`orders.service.ts:203-218`) — `companyId` is a function parameter,
  always the router's `req.tenant!.companyId`, never read from the body; `updateClient` explicitly checks
  `existing.companyId !== companyId → 404` before writing (line 216); both whitelist fields via
  `CLIENT_WRITABLE_KEYS` (`currentBalance` deliberately excluded, per its own comment).
- **`recordPayment`/`recordClientPayment`** (`sales.service.ts:961-1002`) — `assertOwnedByCompany('salesInvoice', ...)`
  (line 965) / `assertOwnedByCompany('client', ...)` (line 979) run before any write; `ctx.companyId` comes
  from the authenticated `TenantContext`, never the body.
- **`createSalesReturn`** (`sales.service.ts:1029-1046`) — the invoice is fetched scoped by `ctx.companyId`
  and explicitly re-checked (`invoice.companyId !== ctx.companyId → 404`, line 1046) before any item is
  processed.

All three: company comes from trusted tenant context only, no client-supplied `companyId` is ever trusted
(enforced app-wide by `rejectClientTenantSelectors`), ownership checks remain intact, a cross-company id
still 404s, RLS remains the DB-level backstop underneath all of it. **No isolation regression introduced by
the permission-string changes** — they operate strictly above these checks, at the route-gating layer.

---

## 10. Bypass findings

None. Summary of what was checked (detail in §2–4): router mount list (`app.ts`) has exactly one mount per
module, no duplicate/legacy path; no bulk-import/CSV/admin endpoint for Client, InvoicePayment, or
SalesReturn exists anywhere; the platform module has zero references to any of the three models; every
frontend call site for create/edit/payment/return goes through the exact endpoint already reviewed; the one
narrow, intentional exception (`manufacturerForSupplier`, §2) was individually verified as correct-as-is, not
a gap.

---

## 11. Defects fixed

**None.** This review found zero genuine defects requiring a code change. Two items were identified and
explicitly left open rather than silently resolved, per the brief's "do not blindly change unrelated
occurrences": the `/clients/:clientId/credit` permission ambiguity (§5) and the `rbac.ts` dead-code staleness
(§6) — both documented, neither touched.

---

## 12. Test results

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` (server) | Clean |
| `npx tsc --noEmit` (client) | Clean |
| `npm run audit:tenant` | Clean: `scoped=0, raw=0, aliases=0` (identical to baseline) |
| `npx vitest run` (full suite) | **40 files, 741 passed, 5 skipped, 0 failed** — identical to the baseline recorded in `COMPANY_ISOLATION_AUDIT.md` |
| `npm run test:rls` (real role-split, staging cluster) | **40 files, 745 passed, 1 skipped, 0 failed** — identical to the baseline |

Numbers match the expected baseline exactly. No code was changed in this review pass (§11), so no change
was expected or found.

---

## 13. Remaining issues

- `GET /sales/clients/:clientId/credit`'s permission (`invoice:create` vs. a possible `client:view`) needs a
  human product decision — not resolved here.
- `rbac.ts`'s unused `PERMISSIONS` const object is stale (missing many permissions, not just this slice's) —
  a separate, pre-existing cleanup item, not touched.
- `MastersPage.tsx`'s "Manufacturers" tab UX: a `masters:edit`-only user sees the tab but would get a 403
  saving through it, since the underlying action is `client:edit`-gated — a product/UX decision, not a
  security defect.
- Frontend has no `hasPermission` gating on the Clients page, quick-add-client dialogs, or the Record-
  Payment/Return forms — pre-existing (not a J2 regression), correctly a J4 (frontend) scope item per
  CLAUDE.md's own Phase J breakdown.
- Existing-company migration (§7) is documented, not executed — remains an action item for whoever manages
  each already-provisioned company's roles.

---

## 14. J3 prerequisites

None of J2's Client/Payment/Return permission work blocks J3. Before J3 (actual delete/reverse/void/amend
capability) starts for these three entities specifically, the open items most relevant are: a decision on
the `/credit` endpoint's permission (cosmetic, not blocking); and, per `PHASE_J1_AUDIT.md`'s own matrix, that
J3 for `SalesInvoice`/`InvoicePayment`/`SalesReturn` will need **new** permissions this slice deliberately
did not create (no delete/reverse capability exists yet to gate) — e.g. `invoice:delete`/`invoice:void`,
`payment:` reverse-shaped action, `return:` reverse-shaped action — consistent with the brief's instruction
not to build them now.

---

## Verdict

**J2 REVIEW: CLEAN — READY FOR HUMAN REVIEW**
