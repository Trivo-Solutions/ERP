# CLAUDE.md — Jewellery ERP (pivoting to Wholesale + Retail)

> **Agent: read this file fully before writing any code, and follow it as the source of truth.**
> This describes an **existing, working system** and how we are extending it. It is NOT a greenfield build.
> Do not start over, do not scaffold a new project, do not delete existing modules. When a decision isn't
> covered here, ask before inventing one.

---

## 0. Situation

This repo (`p:\ERP`) is a **working jewellery ERP originally built for a manufacturing business** (~built
May 31, ~84 days old). It is a monorepo:

- `client/` — React 18 + TypeScript + MUI v5
- `server/` — Node / Express / TypeScript + Prisma
- Postgres + Redis + MinIO via `docker-compose.yml`
- 60+ Prisma models across 9 modules; 5 migrations applied (`init` -> `making_charges`)
- RBAC (35+ permissions, 6 roles), audit logging, RS232 scale + barcode/RFID integration

**The business is pivoting** from *manufacturing* to **wholesale + retail trading**: we buy finished
jewellery, hold it as stock, and sell it — over the counter (retail), to dealers (wholesale), and on
consignment (memo). **We are NOT manufacturing anymore.**

**Decision already made: REUSE AND EXTEND, do not rebuild.** The existing system's core is structurally
right for wholesale/retail. Manufacturing modules are cleanly separable and stay **dormant** (unused, not
deleted). We add two missing links to complete the buy->stock->sell loop.

---

## 1. What already works (do not rebuild these)

| Capability | Where | Status |
|---|---|---|
| **Physical item with status lifecycle** | `JewelryTag` (status: `IN_STOCK` / `ON_APPROVAL` / `TRANSFERRED` / `SOLD` / `RETIRED`; has `branchId`, `costPrice`, `sellingPrice`, `huid`, weights) | Solid. `jobCardId`/`designId` already optional — a tag needs no manufacturing lineage. |
| **Dealer consignment / memo flow** | `MemoOut` / `MemoItem` -> `convertMemoToInvoice` (`sales.service.ts`) | Fully working, tag-aware end to end: memo-out -> `ON_APPROVAL`, return -> `IN_STOCK`, convert -> `SOLD` + links `tagId`. **This is our wholesale/consignment flow. It already exists.** |
| **Billing + tax document** | `SalesInvoice`, `TaxInvoice` (`gstin`, `placeOfSupply`, `cgst`/`sgst`/`igst`/`cess`, e-invoice fields `irn`/`ackNumber`/`ewbNumber`) | Structurally sound foundation. |
| **Party master** | `Client` (typed, carries GSTIN), `Supplier` | Reuse. |
| **Procurement** | `PurchaseOrder`, `GoodsReceiptNote` (`procurement.service.ts`) | Reuse. Gap #1 (finished-goods intake) closed — see section 3. |
| **Branch + transfers** | `Branch`, `BranchTransfer` | Reuse. |
| **Finance** | `Account` / `JournalEntry` / `JournalLine` / `CostCenter` (double-entry) | Exists but currently **dormant** — not yet wired to sales (see §4.1, current objective). |
| **RBAC, audit, hardware** | across server | Channel-agnostic, reuse as-is. |

---

## 2. Manufacturing modules — leave DORMANT, do not touch

These are pure manufacturing and are cleanly separable. **Do not delete them, do not build on them, do not
wire new sell-side code into them.** They simply go unused.

- `JobCard` / `JobProcess` / `WipTracking` / `QcCheckpoint` (`manufacturing.service.ts`)
- `Artisan` / `KarigarLedger` / `ProcessTolerance` / `SubcontractorInvoice` (`outsourcing.service.ts`)
- `Design` / `BomItem` / `BomProcess` / `CostEstimate` (Module 1)
- `SalesOrder` / `OrderItem` — note: this is a **production order** (auto-reserves stock against BOM, feeds a
  JobCard). **It is NOT a retail/wholesale sale.** Do not use it for counter or dealer selling.

The only threads linking manufacturing to the sell-side are two **optional** FKs (`JewelryTag.jobCardId`,
`JewelryTag.designId`) and one mandatory one we will loosen (`HallmarkingItem.jobCardId`). Nothing in
tagging, the memo sales path, or finance depends on manufacturing logic.

---

## 3. The pivot: two missing links (the whole objective)

The buy->stock->sell loop had two gaps. Closing them = the business runs on retail + wholesale. Both were
**extensions of patterns already in the codebase**, not new architecture. **Both are now DONE.**

```
  [GAP #1: intake]  DONE                              [GAP #2: retail sale]  DONE
        |                                                     |
 buy finished piece --> JewelryTag (IN_STOCK) --+-- retail direct invoice --> SOLD
   (PO / GRN)            cost, huid, branch      |   (createInvoice, tag-aware)
                                                 +-- wholesale via memo --> SOLD   (already works)
```

**Gap #1 — Finished-goods intake. DONE.**
Migration `20260823172545_add_finished_goods_intake` (adds `GoodsReceiptNote.branchId`,
`JewelryTag.grnItemId` unique). New function `tagging.service.ts: createTagFromGrnItem()` — a
`FINISHED_GOODS` PO/GRN line (one line = one piece, via the `FINISHED_GOODS_MATERIAL_TYPE` constant in
`shared/constants.ts`) now auto-creates a `JewelryTag` at `IN_STOCK`, carrying `costPrice` (= PO line
`totalAmount`), `grossWeight` (defaults to `GrnItem.acceptedWeight`), `netWeight` (= gross - stoneWeight),
and `grnItemId` linking back to the GRN item. Double-tagging guarded by a unique constraint +
count-checked transaction. Tests: `tagging.service.test.ts` (5 tests, incl. a concurrency race test).

**Gap #2 — Tag-aware direct invoicing. DONE.**
Migration `20260823173718_tag_aware_invoice_items` (adds `InvoiceItem.tagId`, nullable + unique).
`createInvoice()` now mirrors `convertMemoToInvoice()`'s validate -> flip -> link pattern, with one
deliberate divergence: the flip is a count-checked conditional `updateMany` (`WHERE status = 'IN_STOCK'`),
not a blind one, because a direct sale has no prior reservation step to lean on (see "Known follow-ups"
below). `tagId` is optional per line — tagged and free-text lines coexist in the same invoice. Tests:
`sales.service.test.ts` (6 tests, incl. all-or-nothing rollback and a concurrency race test).

---

## 4. Secondary fixes (after the two links, in this order)

1. **Wire finance into sales.** `createInvoice()` currently increments `client.currentBalance` directly and
   posts **no `JournalEntry`**. Make it post a proper double-entry journal. (Latent bookkeeping correctness
   issue regardless of channel — fix while you're in the sales code.)
2. **Loosen `HallmarkingItem.jobCardId` to optional** (or add a `tagId` alternative) so purchased finished
   goods can be hallmarked, not just manufactured ones.
3. **GST by HSN, per line.** Today the rate is hardcoded (`taxRate = currency === 'INR' ? 0.03 : 0`), computed
   once at invoice level, with a thin same-state check against `COMPANY_STATE_CODE`. Move the rate into an
   **HSN/category rate table**, add per-line HSN/rate on `InvoiceItem`, and make place-of-supply
   branch-state aware. Livable at 3% short-term; required before any mixed-rate cart.

---

## 5. Retail vs wholesale — how they map onto THIS system

Same inventory (`JewelryTag`), same billing (`SalesInvoice`/`TaxInvoice`), same party table (`Client`).
They differ only by path and customer:

| | Retail (walk-in) | Wholesale (dealer) |
|---|---|---|
| Customer | `Client`, lightweight (name + mobile) | `Client` with GSTIN, code, terms |
| Sell path | **Direct** `createInvoice` (Gap #2) | **Memo** `MemoOut -> convertMemoToInvoice` (done), or direct invoice |
| Pricing | MRP / retail | Dealer / volume |
| GST | Usually B2C | B2B, registered |
| Payment | Immediate | May be on credit |

There is **no separate wholesale module to build.** Wholesale = memo path (done) + dealer-typed `Client` +
dealer pricing.

---

## 6. Hard rules for the agent

- Reuse and extend. Do not rebuild, re-scaffold, or start a fresh project.
- Preserve all existing working functionality described in this document.
- Do not modify or wire new sell-side functionality into the dormant manufacturing modules in §2.
- Do not use `SalesOrder` for retail/wholesale selling.
- Every stock change must go through a transactional service.
- Every schema change gets its own Prisma migration and appropriate tests.
- Keep `costPrice` on `JewelryTag` immutable by ordinary sales pricing operations unless an explicitly authorized administrative operation is intentionally changing it.
- Never allow cross-company access or modification. Super Admin authority is always limited to their own company.
- All request-supplied foreign IDs must be verified against the caller's company.
- Preserve the existing RLS, tenant wrappers, composite-FK protections, and company isolation rules.
- Never hardcode a GST rate once the HSN/GST master is available.
- Do not add manufacturing, CAD/BOM, export, courier, or loyalty features unless explicitly asked.

### 6.1 Universal Edit / Delete / Restore Policy

The ERP is a customer-operated business system. The provider must provide the customer with the capability to correct, edit, modify, delete, restore, or otherwise administer their operational data through properly authorized users.

**The system must NOT impose a blanket provider-level rule that operational records can never be deleted.**

The customer's `SUPER_ADMIN` is the highest authority inside that company and must be able to administer that company's operational data.

The Super Admin may:

- create records;
- edit records;
- modify records;
- delete records where technically possible;
- restore records where restoration is supported;
- amend posted records;
- correct master data;
- correct inventory records;
- correct transactional records;
- assign and revoke granular permissions;
- authorize other users to perform these operations.

A Super Admin must never be able to cross the company's tenant boundary. Company isolation, RLS and database-level tenant protections remain absolute.

### 6.2 Delegated Administrative Permissions

Super Admin must be able to assign granular permissions to other users/roles.

Deletion and modification must therefore be permission-driven rather than hardcoded to a particular application role.

Where appropriate, permissions should follow the existing RBAC convention, for example:

- `client:create` / `client:view` / `client:edit` / `client:delete`
- `supplier:create` / `supplier:view` / `supplier:edit` / `supplier:delete`
- `inventory:create` / `inventory:view` / `inventory:edit` / `inventory:delete`
- `invoice:create` / `invoice:view` / `invoice:edit` / `invoice:delete`
- `payment:create` / `payment:edit` / `payment:delete`
- `purchase:create` / `purchase:edit` / `purchase:delete`
- `memo:create` / `memo:edit` / `memo:delete`
- `return:create` / `return:edit` / `return:delete`
- `master:create` / `master:edit` / `master:delete`

The exact permission names should reuse existing RBAC naming conventions rather than introducing duplicate permission systems.

If an existing permission already represents the required authority, extend/use it rather than creating another permission unnecessarily.

### 6.3 Deletion Is an ERP Capability, Not a Provider Policy

The ERP provider supplies the technical capability and safeguards.

The customer organization's Super Admin is responsible for deciding:

- which employees may edit records;
- which employees may delete records;
- which employees may perform administrative corrections;
- which employees may restore records;
- which employees may amend financial/inventory records.

The application must enforce the configured authorization, but it must not assume that the provider should prohibit a customer's authorized administrator from modifying their own company's data.

### 6.4 Safe Deletion Behaviour

"Delete" does not necessarily mean a raw SQL `DELETE`.

The implementation must select the technically correct operation for each entity:

1. **Hard delete** where the record is genuinely removable and has no integrity-critical dependants.
2. **Soft delete / inactive state** where retaining the record is useful for operational continuity.
3. **Status transition / retirement** where the entity has a lifecycle.
4. **Amendment / reversal / compensating transaction** where directly deleting the record would make financial or inventory history mathematically inconsistent.
5. **Administrative force-delete** where explicitly required and technically safe, with elevated permission and mandatory audit information.

The objective is **not to prohibit deletion**. The objective is to ensure that an authorized administrator's requested deletion does not accidentally corrupt unrelated inventory, accounting, tax, tenant, or security data.

### 6.5 No Uncontrolled Cascading Deletes

Do not introduce broad Prisma `onDelete: Cascade` relationships merely to make deletion easier.

Before implementing deletion of an entity:

- identify dependent records;
- identify financial consequences;
- identify inventory consequences;
- identify references from other modules;
- determine whether those dependants should also be removed, reassigned, reversed, or retained;
- use an explicit transaction;
- test the complete operation.

Existing dangerous cascades must be identified during the deletion audit. A delete operation must never accidentally remove unrelated company data.

### 6.6 Audit Trail Is Immutable

**Audit records are the exception to the universal edit/delete capability.**

Application users, including `SUPER_ADMIN`, must NOT be able to:

- edit audit records;
- delete audit records;
- truncate audit records;
- disable audit creation for an individual operation;
- rewrite the recorded actor, timestamp, or original before/after values.

The audit trail is an integrity and accountability mechanism for the ERP.

Every applicable administrative modification must create an audit entry containing, where applicable: `companyId`; acting user; acting membership/employee; timestamp; entity/model; record ID; action (`CREATE`, `EDIT`, `DELETE`, `RESTORE`, `AMEND`, `FORCE_DELETE`, etc.); before-state; after-state; reason/comment for sensitive administrative actions; relevant request/context information.

Audit records must remain company-isolated. `PlatformAuditLog` remains reserved for platform/operator events and is governed by the existing platform isolation rules.

### 6.7 Administrative Override

For exceptional cases, provide an explicit administrative override mechanism rather than creating hidden bypasses.

A `SUPER_ADMIN` or specifically delegated administrator may perform an override when the appropriate permission exists. Sensitive override operations should: require explicit confirmation; require a reason where appropriate; be performed transactionally; generate an immutable audit entry; identify the operation as an administrative override; remain restricted to the user's own company.

Do not create a generic endpoint such as `DELETE /anything/:id` that bypasses model-specific validation. The framework must remain entity-aware and permission-aware.

### 6.8 Financial and Inventory Records

Financial and inventory records are **not provider-forbidden from modification**. They are subject to the same administrative authority model, but the implementation must preserve accounting and inventory integrity. For example:

- editing an issued invoice may create an adjustment journal;
- deleting a payment may require reversal of its journal;
- deleting a sale may require restoration of affected inventory;
- deleting a purchase may require reversing inventory and payable entries;
- deleting a return may require reversing the return's inventory/accounting effects.

The exact behaviour must be implemented per entity and tested. Do not silently delete financial side effects merely because the primary record was deleted.

### 6.9 Restore

Where deletion is implemented through soft deletion or an equivalent reversible mechanism, authorized users should have a `Restore` capability. Restore must: check permission; check company ownership; check current dependencies/state; execute transactionally; restore only what can safely be restored; create an immutable audit entry.

If a record cannot safely be restored, the API must return a clear reason rather than silently creating inconsistent data.

### 6.10 Frontend Requirement

Every applicable entity page must expose the appropriate actions (`Edit`, `Delete`, `Restore`, `Amend`, `Deactivate/Activate`) according to the user's permissions and the entity's lifecycle. The frontend must never rely on hiding a button as the security mechanism.

The server must independently enforce: authentication; company membership; company ownership; RBAC permission; entity-specific dependency rules; transaction integrity.

Delete actions must have a clear confirmation UI. Sensitive administrative deletes/overrides should request a reason.

### 6.11 Delete/Modification Framework Must Be Reusable

Do not implement dozens of unrelated one-off deletion mechanisms. Create a common server-side pattern that can be reused by modules while allowing entity-specific rules:

`authenticate → company context → permission → ownership → entity-specific validation → dependency check → transaction → delete/edit/restore/reverse → audit → response`

The common framework must not bypass model-specific business rules.

### 6.12 Testing Requirements

Every new edit/delete/restore capability must test at minimum:

1. authorized Super Admin succeeds;
2. delegated authorized user succeeds;
3. unauthorized user receives `403`;
4. cross-company record cannot be modified;
5. cross-company record cannot be deleted;
6. invalid/nonexistent record is handled safely;
7. dependent records are handled correctly;
8. transaction rolls back on failure;
9. audit entry is created;
10. audit entry contains the correct actor/company/action;
11. audit entry cannot be modified/deleted through normal application APIs;
12. RLS prevents tenant escape;
13. frontend action visibility follows permissions;
14. direct API access is still denied when the permission is absent.

Run the normal test suite and, before release, run `npm run test:rls` and `npm run audit:tenant`.

---

## 7. Current objective

Gaps #1 and #2 (section 3) are **DONE**. ROADMAP.md's **Phase A — fix the sell-side foundation** is now
**DONE** too:

1. **A1 — GST-zero bug. DONE.** `currency` is now resolved once (`data.currency ?? 'INR'`) at the top of
   `createInvoice()` and reused for the tax-rate calc, the invoice row write, and the `TaxInvoice` gate,
   so the two divergent reads that caused an omitted `currency` to invoice as INR but tax as 0 can no
   longer disagree. Both `createInvoice()` and `convertMemoToInvoice()` now also refuse (throw) to emit a
   `TaxInvoice` on a taxable INR sale with `taxAmount <= 0`, as a belt-and-suspenders invariant.
2. **A2 — Price-mode ambiguity. DONE.** `createInvoice()` now branches per line on the existing
   `rateType` field (previously ignored): `'FIXED'` → `unitPrice = goldRate` directly (a flat, already-
   decided price, e.g. a tag's own `sellingPrice`); anything else (`'PER_GRAM'`, the default) → the
   original `netGoldWeight * goldRate + makingCharge + stoneValue`. No schema change — `rateType` already
   existed on both the input type and `InvoiceItem`, it just wasn't wired to the math.
3. **A3 — Memo path tag-link. DONE.** `convertMemoToInvoice()`'s line-item builder now sets
   `tagId: lineItem.tagId` on each created `InvoiceItem`, so the memo-conversion path is genuinely
   tag-linked end to end (previously only the separate `jewelryTag.updateMany` flip left any trace — the
   `InvoiceItem` row itself carried no `tagId`).

All three covered by tests in `sales.service.test.ts` (currency-omitted vs explicit-INR parity, non-INR
zero-tax with no `TaxInvoice`, `FIXED`-rate pricing incl. a zero-`netGoldWeight` case, `PER_GRAM`
regression, and the memo-path `tagId` link).

**Phase B is in progress** (B1, B2 done; B3, B4 remain):

4. **B1 — HSN + GST rate master. DONE.** New `HsnCode` table (seeded with 7113/3%, the prior
   hardcoded rate). `InvoiceItem` carries `hsnCodeId` + a `taxRate` snapshot copied at sale time —
   like `costPrice` on `JewelryTag`, a later HSN-rate change must not silently reprice a past
   invoice. Each line optionally specifies `hsnCode` (defaults to 7113 when omitted); `createInvoice`
   sums per-line tax, scaled proportionally by any invoice-level discount, reducing to the exact old
   flat formula when every line shares one rate. `convertMemoToInvoice` stamps the default HSN on
   its lines too (still single-rate on that path).
5. **B2 — Place-of-supply fix. DONE.** `Client.state` (free text, e.g. `"Gujarat"`) vs
   `COMPANY_STATE_CODE` (numeric, e.g. `"24"`) never matched, so every sale priced as inter-state
   IGST regardless of the client's real state. New `StateMaster` table (all 36 GST state/UT codes +
   common aliases) and `resolveStateCode()` (`server/src/shared/stateMaster.ts`) resolve the free
   text before comparing. No confident match (blank/unrecognized — the common case for a
   lightweight walk-in retail `Client`) still falls back to inter-state, matching prior behavior.
   `TaxInvoice.placeOfSupply` now stores the resolved code when found. Deliberately stays
   single company-wide `COMPANY_STATE_CODE`, not per-branch — `SalesInvoice` has no `branchId` and
   this codebase uses one GSTIN; branch/multi-GSTIN awareness is a later decision if it's ever needed.

Both covered by tests in `sales.service.test.ts` (default/mixed/unknown HSN cases; same-state by
canonical name and by alias, different-state, and unresolved-state place-of-supply cases).

**Phase B is now fully done** (B1–B4). B3 added a printable A4 tax invoice; B4 added a standalone
counter stock/price lookup screen (`StockLookupPage.tsx`, `/tagging/lookup`) outside the billing
flow — read-only, searches a tag across every status (not just `IN_STOCK`) so an already-sold or
on-approval piece still shows a clear answer, and deliberately omits `costPrice` and any
edit/retire action.

**Phase C — Daily pricing is also fully done** (C1 karat/purity master, C2 daily-rate auto-price,
C3 making-charge/wastage wiring, C4 stone valuation via `PriceMaster` — see ROADMAP.md for the
full writeup of each). Along the way, `createTag`'s materials table in `NewTagPage.tsx` also
picked up a metal-rate auto-fill for a METAL row's Cost Rate, which had no route to today's rate
at all before (see ROADMAP.md's C3 entry).

**Phase D — Returns & exchange is now fully done (D1–D4).** D1–D3: new `SalesReturn`/
`SalesReturnItem`/`PurchaseReturn`/`PurchaseReturnItem` models; `createSalesReturn()` reuses the
same tag (flips `SOLD` → `IN_STOCK`) and never mutates the original `SalesInvoice`/`InvoiceItem`
(or `MemoOut`, for a memo-converted sale — D2 needed zero new code, proven channel-agnostic by a
new test, not assumed); `createPurchaseReturn()` mirrors it on the buy side (`RETIRED`, GRN-sourced
tags only), deliberately not touching `Supplier.currentDue` (*superseded by Phase I2 — it is now a live payable*) since procurement never wired that as
a live balance to begin with. `InvoiceItem.tagId` relaxed from `@unique` to a plain indexed FK
since a returned tag must be resellable. D4 (old gold exchange): new `OldGoldExchange` model —
values a piece via C1/C2's karat/rate infra, credits `Client.currentBalance` as a standing store
credit (not tied to a specific invoice — "redeemable later" falls out of the existing balance
mechanism for free), and also adds the melted weight to the Metal Vault (`MetalStock`) via
`addMetalStock()`, which gained an optional transaction-client param so that write can't orphan
if the rest of the exchange fails. See ROADMAP.md's D1–D4 entries for the full writeup of each.

**Phase E — Branch operations is now fully done (E1–E3).** E1 turned out to already be fully
built — ROADMAP.md's "flow not built" note was stale, corrected after verifying the actual
`tagging.service.ts` code (full `createTransfer → submitTransfer → approveTransfer →
receiveTransfer` lifecycle, guarded and transactional). E2 (inter-branch stock visibility) needed
no schema change — pure `groupBy` aggregation. E3 (stock audit): new `StockAudit`/`StockAuditItem`
models, one branch per audit, report-only (closing an audit never mutates a tag's status/branch —
a finding is a fact for a person to act on later, not an automatic side effect). See ROADMAP.md's
E1–E3 entries for the full writeup of each.

**Phase F is underway — F1 (wire sales → double-entry ledger) is done, done wider than section 4.1's
original one-line scope.** Every money-moving action — `createInvoice`, `applyPayment`/
`recordPayment`, `createSalesReturn`, `createOldGoldExchange`, and (buy-side) `createTagFromGrnItem`/
`createPurchaseReturn` — now posts a balanced `JournalEntry` via new `finance.service.ts:
postAutoJournalEntry(tx, ...)`, not just a `client.currentBalance` bump. Went beyond "sales" on
purpose: without the buy-side intake entry (Dr Inventory / Cr Accounts Payable on
`createTagFromGrnItem`), Inventory would only ever be credited at sale and never debited at
intake — a correct-looking sales ledger sitting on a meaningless Inventory balance. Account-code
lookups go through new `shared/ledgerAccounts.ts: LEDGER_ACCOUNT`; a new migration
(`20260825130000_seed_ledger_accounts`) seeds the 10 specific accounts these entries depend on
directly, same "seed it in a migration" precedent as `DEFAULT_HSN_CODE`/`KaratMaster`, since the
test DB never runs `prisma/seed.ts`'s full `seedChartOfAccounts()`. See ROADMAP.md's F1 entry for
the full per-function writeup and test coverage.

**F2 (standalone payments/receipts) is also done.** `InvoicePayment.invoiceId` is now optional and
a `clientId` column lives directly on every row (backfilled for existing rows), so a payment can
be recorded against a client with no invoice yet — an advance, or a payment against their general
outstanding balance. New `recordClientPayment()`/`listClientPayments()` in `sales.service.ts`,
`POST/GET /sales/clients/:clientId/payments`, and a "Record Payment" action on the Clients page.
Reuses `applyPayment`'s exact ledger entry (F1) and PMT- numbering — see ROADMAP.md's F2 entry.

**Also fixed in this pass — an unrelated but real RBAC gap, found while testing:** no seeded role
except `SUPER_ADMIN` (`'*'`) ever had `masters:view`, so every `/masters/*` GET (karats, HSN,
categories, stone types, price master, making charges) 403'd for every other role — every
karat/category/stone-type dropdown fed by that router was silently empty for anyone not logged in
as the admin account. Root cause was two-fold: `masters:view` was simply missing from the
operational roles' permission lists in `prisma/seed.ts`, *and* every role's `upsert` used
`update: {}` — a no-op on conflict — so even fixing the list in source would never have reached an
already-seeded database on a re-run. Fixed both: added `masters:view` to `SALES_MANAGER`,
`STORE_MANAGER`, `PRODUCTION_MANAGER`, `ACCOUNTANT`, and changed every role's `update` to mirror
its `create` so a re-seed now actually syncs permission changes going forward. Re-ran the seed
against the dev DB and verified `/masters/karats` returns 200 for the `manager@sea-erp.com`
(`PRODUCTION_MANAGER`) account. **A user already logged in when this ran needs to log out and back
in** — their cached JWT still carries the old (pre-fix) permission list baked in at login time;
a plain 403 doesn't trigger the client's silent-refresh-on-401 flow the way an expired token would.

**F3 (dealer outstanding / credit tracking) is also done.** `checkCreditLimit()` in
`sales.service.ts` blocks a sale (direct or memo-converted) that would push a client's
`currentBalance` past their own `Client.creditLimit` — checked before any tag is touched, no
schema change, no limit set means unlimited (unchanged default). New `getDealerAging()` in
`finance.service.ts` + `GET /finance/reports/dealer-aging` + `DealerAging.tsx` page (Finance nav
group) age every outstanding balance into 0–30/31–60/61–90/90+ day buckets and flag anyone
currently over their limit. See ROADMAP.md's F3 entry.

**F4 (per-party customer/dealer ledger) is also done.** New `getClientLedger()` in
`finance.service.ts` merges the exactly-four tables that ever move `Client.currentBalance` —
`SalesInvoice` (debit), `InvoicePayment` (credit, both invoice-scoped and F2's standalone
on-account rows), `SalesReturn` (credit), `OldGoldExchange` (credit) — into one chronological,
running-balance statement, computed from full history first so a `from`-cutoff `openingBalance`
is correct even when the display range is narrower. No schema change — pure read-side
aggregation, same shape as E2/F3. `GET /finance/reports/client-ledger/:clientId` (`report:view`,
optional `from`/`to`); new `ClientLedger.tsx` page (Finance nav group) with a client picker,
date-range filter, and a "Statement" deep-link from the Clients page. See ROADMAP.md's F4 entry
for the full writeup and test coverage.

**Phase G — Repairs & hallmarking is now fully done (G1–G2).** G1 extended the existing
manufacturing-era `RepairJob`/`RepairTransaction` system rather than rebuilding it: optional
`clientId`/`tagId` link a customer's repair to a real party and piece (the old free-text
`clientName`/`originalJobCardId` stay for the QC-failure/rework flow); `receivedDate`/
`deliveredDate` give explicit in/out tracking; new `billRepairJob()` charges the customer by
reusing `createInvoice()` verbatim (one free-text `FIXED`-rate line, no tag on the invoice line),
gated idempotent by a new unique `RepairJob.invoiceId`. This surfaced a real RBAC gap —
`PRODUCTION_MANAGER` (the only role with `repair:manage`) had no `invoice:create`, so nobody
could reach the new billing endpoint — fixed in `seed.ts` and re-seeded (same "a logged-in user
needs to log out and back in" caveat as the earlier `masters:view` fix). G2 loosened
`HallmarkingItem.jobCardId` to optional and added a `tagId` alternative (CLAUDE.md §4.2, now
resolved) so a purchased finished-goods piece can be hallmarked without any JobCard. See
ROADMAP.md's G1–G2 entries for the full writeup and test coverage.

**Phase H — Management reports is now fully done.** Two of its seven original bullets turned out
to already be satisfied by earlier phases (Dealer ledger/outstanding → F3+F4; Profit/margin → the
existing P&L Statement from F1) — no new work there. The five genuinely new reports are all pure
read-side aggregation, no schema changes, same shape as E2/F3/F4: `getSalesRegister()` (sales
module — retail+wholesale together, date+salesperson filters), `getStockOnHand()` and
`getDeadStock()` (tagging module — `IN_STOCK` sliced by branch×category, and bucketed by days
since `updatedAt` respectively), `getDayBook()` and `getGstSummary()` (finance module — one day's
company-wide rollup, and an HSN-wise GST prep summary explicitly flagged as prep-not-filing-ready
in the UI). A new shared `exportToCsv.ts` gives every report page an Excel-opening CSV export
without adding an `xlsx` dependency. See ROADMAP.md's Phase H entry for the full per-report
writeup and test coverage.

**Also done (2026-09-02) — C3 refined so Making Charge/VA varies by karat, not just category.**
`MakingCharge` gained a `karat` column (same free-string convention as `JewelryTag.metalKarat`),
matched most-specific-wins alongside category + makeType — e.g. 22K necklaces can now carry a
different VA% than 18K bangles, which category alone couldn't express. `MaterialCode` also gained
a `karat` column so `NewTagPage.tsx`'s Materials tab can auto-derive a tag's overall `metalKarat`
from whichever METAL row carries the most weight (still manually overridable). See ROADMAP.md's
Phase C entry ("C3-refresh") for the full writeup and test coverage.

**Phase I — Store-operations gap pass (2026-09-25).** Walking the retail loop against the *code* found the docs had run ahead of it.
Done, each with its own migration/tests (full write-up in ROADMAP.md's Phase I): **I1** finished-goods inward now works on screen — the
GRN page has the receiving branch, a per-line **Tag** action and label print (Gap #1's `createTagFromGrnItem` had been API-only, `API.md`
wrongly said a GRN auto-creates the tag, and the PO/GRN routes 500'd on JSON dates until `shared/parseDate.ts`). **I2** purchase GST
(input tax credit, accounts 1401–1403, exact reversal on a purchase return, ITC report) and **supplier payments** — and
`Supplier.currentDue` is now a *live payable* (this supersedes the older "never wired" notes on D3/F1 below). **I4** PAN (Rule 114B,
above ₹2,00,000) and the Sec 269ST cash ceiling (₹2,00,000 per client per day), enforced in `shared/compliance.ts` inside the sale's
transaction; the client create/update endpoints now whitelist their fields. **I5** estimate → invoice: an estimator sends a quote to
billing, the biller finds it by number / item / customer name, is asked for the sales person, can re-price or add/delete its rows, and
the estimate is marked INVOICED exactly once (`createInvoice({ estimateIds })`); this also fixed the New Sale screen never sending its
required `branchId`. **I3 (GST credit note on a sales return) is NOT started** — no go-ahead was given; `createSalesReturn` still books
no GST reversal. TCS on cash jewellery sales is not implemented (confirm with a CA). Verified: the full suite on `sea_erp_test` and on the
real role-split `trivo_rlstest` (`npm run test:rls`), and the data steps of the new migrations were exercised as `trivo_owner` under
FORCE RLS. **A migration that touches tenant rows must lift FORCE RLS around its statement** (see 20260925090000 / 100000) — once
`db-secure.sql` has run, even the owner running `migrate deploy` is filtered by the policy and would insert/update nothing (or fail).

**I6 — purchase lots (bags), 2026-09-25.** A supplier invoice that bills finished pieces *as a bag* is entered as one PO line of
Type `FINISHED_LOT` (`FINISHED_LOT_MATERIAL_TYPE`: gross weight, ONE amount, and a grid of category rows — category, karat, gross/stone/net,
optional piece count — `PoItemCategory`). Receiving it on a GRN opens a `PurchaseLot` and
books the whole bill *then* (Dr Inventory + input GST / Cr Payable; `Supplier.currentDue`); the pieces are then tagged one at a time from New
Tag with the lot chosen (`createTag({ purchaseLotId })`, `shared/purchaseLot.ts`), the piece must be in a category the bag holds and within that row's weight/count — no journal at tagging. Cost rates (metal ₹/g, MC ₹/g, VA %)
are entered ONCE per category row on the PO and pre-filled on each tag's Materials / MC & VA tabs (editable per tag); the tag's `costPrice` is
what those build, falling back to its share of the bag's remaining cost by net weight when nothing is entered. The bag reports the gap to the
invoice as `costVariance` — the ledger keeps the invoice amount, so a gap stays in Inventory until adjusted (nothing is auto-posted). The tag
screens pre-select the PO's supplier as Manufacturer (`manufacturerForSupplier`: a Client, found or created once). Tagged totals are live sums
over its tags, never counters; closing a lot is report-only. Migrations `20260925130000_purchase_lots`, `20260925140000_lot_categories`,
`20260925150000_lot_category_cost_rates`; tests `purchaseLot.test.ts`. See ROADMAP.md's I6 entry.

**Bill summary + round-off (2026-09-27).** New Sale's Charges & Payment tab now shows a jeweller-style **Summary** (Material &
Labour → Gross → Add & Less → Net Amount, `pages/Sales/SaleSummary.tsx`) and an editable adjustments table: discount as ₹ or % of the
gross, shipping/other, GST per line **by HSN picked from the master** (rates are never typed — the 4.3 rule stands), and **round-off**,
automatic to the nearest ₹1 on an INR bill or keyed by hand within ±₹10 (`MAX_ROUND_OFF`; a bigger movement must be a Discount).
`SalesInvoice.roundOff` (migration `20260927120000_invoice_round_off`) is included in `totalAmount`, and `createInvoice` posts it to new
account **6600 Round Off** (`LEDGER_ACCOUNT.ROUND_OFF`; credit when billed up, debit when down) so the journal still balances — that
migration also seeds 6600 into every existing company (FORCE RLS lifted around the insert), the Starter Package chart carries it for
new ones. `GET /sales/tax-context` feeds the screen's preview (HSN rates + CGST/SGST vs IGST). Tests: `sales.service.test.ts`
("round-off", "getTaxContext"). **Not done:** `convertMemoToInvoice()` (memo/wholesale path) does not round off yet — its totals are
unrounded as before; GST *credit note* on a sales return is still I3 (not started).

**Stock Book (2026-09-27).** `/reports/stock-book` (`pages/Reports/StockBook.tsx`, `tagging.service.ts: getStockBook`) — a pivot-style
stock report: one row per tag on the shared `DataTable` (right-click a header to show/hide columns and auto-fit, drag a header to reorder,
Excel-style column filters, layout remembered per browser), Detail or **Summary** (group by any of status/branch/category/sub-category/
collection/stock type/make type/metal/karat/setting/manufacturer; measures summed — each grouping keeps its own remembered layout), search,
sort, paging, CSV. Branch scope is enforced **server-side from the user's branch grants** (`ctx.branchAccess`, same rule as `listTags`): a
restricted user sees only their branch(es) and the picker never offers others; an all-branches user picks one or all. To support this,
`DataTable` gained optional, backward-compatible props: `sortable` (+ column `sortValue`), `pageSizeOptions`, `maxHeight` (sticky header),
`csvFileName` (+ column `csvValue`), `onColumnOrderChange` (Summary reads its grouping order — and so its row sort — from the dragged column order), and `footer` may be a function `(filteredRows, visibleColumns)` so a totals row follows the filters. No migration. **Not a point-in-time ledger** — there is no
stock movement history, so the date range filters on *tagged* date and status is current; a true "as of date" view would need one.
Dia Wt = `DIAMOND` material rows, CS Wt = every other non-metal row (carats). Tests: `tagging.service.test.ts` "getStockBook".

**Old gold & store credit as payment modes (2026-09-27, ROADMAP I7).** New Sale's payment splits now also take `OLD_GOLD` (customer's
old metal, valued at the day's rate and booked as an `OldGoldExchange` + Metal Vault entry inside the same invoice transaction) and
`STORE_CREDIT` (credit already on the account from a return/earlier exchange — `GET /sales/clients/:id/credit`). Both settle the bill from
*credit*, not cash: the `InvoicePayment` row marks the invoice paid but posts no journal and leaves `currentBalance` alone (the credit
was booked when it arose). **Anything that sums `InvoicePayment` as receipts must skip `CREDIT_SETTLEMENT_MODES`** (shared/constants.ts)
— the client ledger and day book already do. No migration. Tests: `sales.service.test.ts` ("old gold & store credit as payment modes").
Not done: memo/wholesale path, applying credit to an older unpaid invoice.

**Editing an issued invoice (2026-09-27, ROADMAP I8).** `PUT /sales/invoices/:id` → `amendInvoice()` (permission `invoice:edit`, SUPER_ADMIN or granted)
changes lines/rates/GST/customer in one transaction: stock flips for tags added/removed, GST record rewritten, **one adjustment journal for the
difference (original entries are never edited or deleted)**, customer balance by the change in total, audit `AMEND` with before/after. The business
explicitly chose this over "never rewrite history" for invoices; returned lines stay locked and the customer is fixed once a payment/return exists.
`createInvoice`'s pricing lives in `priceInvoice()` and is shared. The New Sale screen is the editor (`/sales/invoices/:id/edit`); the invoice list
has Edit actions (shown only with the permission) and From/To date filters. Tests: `sales.service.test.ts` "amendInvoice".

**Next:** nothing left on the roadmap's A–H phase list — CLAUDE.md §4.2 (hallmarking optional FK)
was resolved by G2. Remaining open items are the two documented control gaps in §8
(`createInvoice()`'s optional `tagId` still allows an off-book untagged line; `convertMemoToInvoice()`'s
blind tag-flip `updateMany`) and whatever the user raises next — check in before assuming further
scope.

See `ROADMAP.md` for the full phase breakdown (C–H: pricing, returns/exchange, branches, finance/credit,
repairs, reports). See `API.md` for the full HTTP API reference, current module/feature-scope
status, and setup instructions. See `UI_DESIGN_GUIDE.md` before building or reworking any
frontend screen — keyboard-first field conventions, compact grid-based forms, table overflow
handling, and the `getValues()`-vs-`watch()` pitfall, all with reference implementations to copy.

### Phase J — Universal Edit / Delete / Restore / Administrative Control

The next major objective is to make the ERP fully administrable by the customer's authorized administrators.
This is a **framework requirement across the entire application**, not a single-module feature.

The objective is:

- `SUPER_ADMIN` → full administrative control within own company
- `DELEGATED USER` → only the explicitly assigned edit/delete/restore permissions
- `NORMAL USER` → existing operational permissions only
- `AUDIT TRAIL` → immutable and protected

The implementation must begin with a complete repository audit before changing code.

**Phase J1 — Delete/Edit Inventory Audit.** Inspect the entire Prisma schema, all server routes/services/
controllers, RBAC permissions, audit system, tenant wrappers, RLS policies and all frontend pages. Create a
complete matrix containing at least:

| Module | Entity | UI Page | API | Current Edit | Current Delete | Dependencies | Financial Impact | Inventory Impact | Recommended Operation | Permission | Audit Event |
|---|---|---|---|---|---|---|---|---|---|---|---|

Classify every applicable entity as: Hard Delete / Soft Delete / Deactivate-Activate / Status-Retire / Amend /
Reverse / Administrative Override / Protected System Record. Do not assume that an entity is protected merely
because it is financial or historical — the customer's authorized administrator must retain a supported method
to correct or remove operational data; the implementation determines whether that method is deletion,
amendment, reversal or another safe operation.

**Phase J2 — RBAC.** Extend the existing RBAC system with granular edit/delete/restore/override permissions
where required. `SUPER_ADMIN` must have the complete set of company-level administrative permissions. Do not
create a second authorization system.

**Phase J3 — Server Framework.** Implement reusable authorization and entity-specific deletion/modification
patterns. Every operation must enforce: `authentication → company → permission → ownership → dependency rules
→ transaction → audit`.

**Phase J4 — Frontend.** Add appropriate Edit / Delete / Restore / Amend / Activate-Deactivate actions
throughout the application. Buttons are permission-aware, but the server remains authoritative.

**Phase J5 — Audit Integrity.** Ensure all administrative modifications generate immutable audit records.
Verify that application users cannot modify or delete audit history.

**Phase J6 — Tests.** Test successful authorized operations, unauthorized operations, cross-company attacks,
dependency handling, transaction rollback, audit creation, restore and RLS. Run `npm run test:rls` and
`npm run audit:tenant` before considering Phase J complete.

**Do not implement Phase J as one giant uncontrolled change.** Audit the repository first, produce the
classification matrix, then implement module-by-module and stop for review after each logical group.

**Progress (2026-09-28).** **J1 is done** — the full classification matrix is `PHASE_J1_AUDIT.md`. Alongside
it, a **repo-wide company-isolation sweep** (a separate, prerequisite request, not itself part of J1–J6) is
done — see `COMPANY_ISOLATION_AUDIT.md`: no cross-company leak found anywhere (queries, reports/exports/
search, WebSocket/Redis/object storage, RLS config all independently re-verified against source), but it
found and fixed 4 real ownership-check gaps (`JournalLine.accountId` — CRITICAL, `JewelryTag.jobCardId`/
`designId`, `HallmarkingItem.jobCardId`, `RepairJob.originalJobCardId` — all plain FKs nothing had ever
checked), each with a regression test, plus a new "Company-isolation contract" checklist appended just above
§12.

**J2 is started — first slice done (Sales & Client group), stopped for review before touching another group
or J3.** Per the audit matrix, `client:*`/`payment:*`/`return:*` didn't exist — client CRUD rode `order:view`/
`order:create` (the unrelated production-order permission family), and payment/return creation rode
`invoice:create`. Added `client:view`/`client:create`/`client:edit`, `payment:create`, `return:create` to
`permissionCatalog.ts` and re-gated the actual existing endpoints (`orders.router.ts`'s `/clients` routes,
`sales.router.ts`'s payment and return-creation routes) — no new capability was built (that's J3), this is
purely correcting which permission string an already-working endpoint checks. `PRODUCTION_MANAGER`/
`ACCOUNTANT`/`SALES_MANAGER` in `starterPackage/v1.ts` got the new strings added alongside (never instead of)
their existing `order:*`/`invoice:create` grants, so no one's effective access changes — same precedent as
the earlier documented `masters:view` fix. **Caveat, same class as that precedent**: Starter Package v1 is
immutable per its own header comment — this only reaches a company provisioned from now on. An
already-provisioned company (e.g. the local dev SEA company) needs its `PRODUCTION_MANAGER`/`ACCOUNTANT`/
`SALES_MANAGER` roles' permissions updated directly (Role Editor UI, or a one-off script) for its existing
users to keep working once these endpoints ship — this was **not** done to any live database in this pass.
`npm run test:rls` (745/746) and the full suite (741/746, both runs 0 failed) were re-run clean after every
change in both the isolation sweep and this J2 slice.

**J3 — administrative mutations (Client lifecycle, Invoice Void, Payment reversal) is done, per the
finalized human decisions in `PHASE_J3_DECISIONS.md`.** Full writeup, schema, and test inventory in
`PHASE_J3_IMPLEMENTATION.md`. Summary of the decisions and behavior a future change must not
silently break:

1. **Client deactivate/reactivate is its own permission (`client:deactivate`), separate from
   `client:edit`.** `isActive` was removed from `updateClient`'s writable-field whitelist
   (`CLIENT_WRITABLE_KEYS`, `orders.service.ts`) — ordinary edit can no longer silently toggle it.
   New `setClientActive()` (own audit action `DEACTIVATE`/`REACTIVATE`, rejects a redundant
   toggle) is the only path. It now has real teeth: `createInvoice`, `createMemoOut`, and
   `recordClientPayment` all reject an inactive client via a shared `assertClientActive()` guard
   — deliberately **not** added to `amendInvoice`/`createSalesReturn`/`convertMemoToInvoice`, which
   act on a transaction that already exists (a memo predates any later deactivation; a return/amend
   corrects something already on the books), not one that's starting fresh.
2. **Client permanent deletion (`client:delete`, new `deleteClient()`) requires zero rows across all
   eight of `Client`'s dependent relations** (sales, memos, returns, exchanges, payments, repairs,
   manufactured tags, dormant `SalesOrder`) — checked in code as defense in depth on top of the FK
   layer (every one of those relations is the Postgres default/RESTRICT, never CASCADE), which
   already guarantees this at the database level. Never cascades; a client with any history can only
   be deactivated, never erased.
3. **Invoice Void (`invoice:void`, new `voidInvoice()`) is a whole-invoice reversal — never a hard
   delete.** Reuses `createSalesReturn`'s own proven per-line mechanics (tag flip, ledger reversal,
   client credit) applied to every line and the header at once; sets `status = 'VOID'` (free-text,
   no enum) plus `voidedAt`/`voidedById`/`voidReason`. Strict eligibility: zero `InvoicePayment`
   rows, zero `SalesReturn` rows, not already `VOID`, and refuses if `TaxInvoice.irn` is already
   set (this system has no GST e-invoice IRN-cancellation integration — that stays a manual,
   outside-the-system step, same posture as the I3 gap). `amendInvoice`, `recordPayment`, and
   `createSalesReturn` all now refuse to act on a `VOID` invoice.
4. **Payment reversal (`payment:reverse`, new `reverseInvoicePayment()`) flags the original row
   (`reversedAt`/`reversedById`/`reversalReason`) — it is never edited or deleted.** Every place that
   sums `InvoicePayment` as a real receipt (`getClientLedger`, `getDayBook` in
   `finance.service.ts`) now also filters `reversedAt: null`. Three cases, by mode:
   - **cash/bank/UPI/card/...**: a real receipt — reopens the invoice, credits `currentBalance`
     back, posts the exact inverse journal.
   - **STORE_CREDIT**: this "payment" never moved `currentBalance` or posted a journal in the first
     place — the credit was already netted into `currentBalance` when the `SalesReturn`/
     `OldGoldExchange` that funded it was booked, *before* the invoice's own debit. Reversing it only
     reopens the invoice; there is no separate credit-source movement to undo, and no
     individually-redeemable "unit" of credit to double-spend, since `currentBalance` is one pooled
     running balance, not a ledger of discrete credit lots. **This is why Decision 4 (below) could
     stay closed** — no `SalesReturn` "un-return" capability was needed to satisfy Decision 2's
     "reverse the underlying credit-source movement" requirement for this mode; there is no
     source-specific movement STORE_CREDIT ever made.
   - **OLD_GOLD**: unlike `STORE_CREDIT`, this mode *does* create its own real, separate movement at
     payment-application time (`bookOldGoldExchange`, called from inside `createInvoice`'s payments
     loop): it credits `currentBalance`, posts its own journal, and adds real weight to the Metal
     Vault. Reversing the payment **without** reversing that exchange would let the business collect
     cash for an invoice it already extracted equivalent-value metal for — so both now reverse
     together, atomically, in the same transaction: the exchange is marked
     `reversedAt`/`reversedById`/`reversalReason` (same additive-columns shape as `InvoicePayment`),
     its journal is reversed, `currentBalance` is credited back, and its `MetalStock` row is zeroed
     out (`availableWt: 0, isActive: false`). **Refused (409), not silently skipped, if the metal has
     since been reserved/consumed by anything else** — checked via `MetalStock.availableWt` vs
     `netWeight`. This codebase's only present-day consumer of Metal Vault stock is the
     dormant-but-not-disabled production auto-reservation path (`orders.service.ts:
     autoReserveMaterials`, off a `SalesOrder`/BOM) — if that already spent this exchange's metal,
     there is nothing left to give back, and the reversal correctly refuses rather than fabricating
     stock back into existence.
5. **`SalesReturn` remains append-only — no "un-return" capability was built.** A mistakenly-returned
   item is corrected by selling it again through the normal `createInvoice` path; nets out correctly
   with no new risk surface. If the business later needs a true reversal of a `SalesReturn` itself
   (as opposed to reversing a *payment* that happened to be settled by credit a return generated),
   that is still a from-scratch design question, not something this phase's `payment:reverse`
   capability provides — it only reverses the payment/exchange pair, never the return itself.
6. **All four new permissions ship SUPER_ADMIN-only** (`client:deactivate`, `client:delete`,
   `invoice:void`, `payment:reverse`) — added to `permissionCatalog.ts` but **not** granted to any
   starter role and **not** back-filled onto any already-provisioned company, per Decision 6/7. A
   company's own `SUPER_ADMIN` delegates them through the Role Editor when ready (same
   "log out and back in for a cached JWT to pick it up" caveat as every prior permission-catalog
   addition).
7. **`GET /sales/clients/:clientId/credit` is now `client:view`**, not `invoice:create` (Decision 7)
   — it only ever read `Client.currentBalance`.

Tests: `sales.service.test.ts` (`voidInvoice (J3.3)`, `reverseInvoicePayment (J3.2)`, `inactive client
is rejected...`), `orders.service.test.ts` (new file — `setClientActive`, `deleteClient`,
`updateClient` regression), `http.j3Administrative.test.ts` (new file — the one thing the
service-level suites don't cover: `requirePermission(...)` actually gating each new route over real
HTTP, granted vs. missing). Full local suite, server/client `tsc`, and `npm run audit:tenant` all
re-run clean; `npm run test:rls` re-run against the real role-split cluster after applying this
phase's migration there too (see `PHASE_J3_IMPLEMENTATION.md` for the exact numbers).

**J3.5 — hardening pass (2026-09-28), fixing all six findings from the J3 Final Safety Audit.** Full
writeup, root causes, and per-finding tests in `PHASE_J3.5_HARDENING.md`. In one line each: (1) a
voided invoice no longer counts as a live receivable/sale in `getDealerAging`/`getClientLedger`/
`getDayBook`/`getGstSummary`/`/reports/aging-receivables`/`getSalesRegister` — all six needed the
identical `status: { not: 'VOID' }` (or equivalent) exclusion, since none of them existed to know
about `'VOID'` when it shipped; (2) `billRepairJob()` now checks the *linked invoice's* status, not
just whether `invoiceId` is set, so voiding a repair bill no longer permanently locks that repair job
out of being billed again (it reassigns `invoiceId` to the new invoice and audits the supersession as
`'REBILL'`); (3) `reverseInvoicePayment()`'s three read-then-write mutations (`SalesInvoice.paidAmount
`/`balanceDue`, the `OldGoldExchange` reversed-flag guard, `MetalStock` zeroing) are now a `SELECT ...
FOR UPDATE` lock and two count-checked conditional `updateMany`s respectively, closing real lost-update
windows — one of which was verified to actually reproduce the bug when the fix was temporarily
reverted, then confirmed fixed again; (4) `assertCashLimit` (Sec 269ST) now excludes reversed cash
payments from the daily ceiling; (5) the `OldGoldExchange` and `MetalStock` reversal audit entries now
carry real before/after content instead of a bare reason string / nothing at all; (6) `deleteClient`
gracefully translates a raced FK conflict into a 409 via the existing `isBlockedByForeignKey` helper
instead of a raw 500. Two durable rules learned and worth restating for future work: **a new terminal
status value on any entity must be checked against every existing report/aggregate that filters by
status, not just the ones a bug report happened to name**; and **a conditional write that follows a
state check must itself be count-checked or lock-protected at write time — checking once and writing
blindly later is the same bug every time.** (Noted, not fixed: `addMetalStock` audits from inside
whatever transaction it's given, which can record a `CREATE` for a mutation that later rolls back if
nested in a larger failing transaction — pre-existing, unrelated to any of the six findings.) 13 new
regression tests; full suite, `test:rls`, both `tsc`s, and `audit:tenant` all re-run clean.

**Phase J4 — RBAC / Authorization implementation is done**, per the six locked decisions in
`PHASE_J4_DECISIONS.md`. Full writeup in `PHASE_J4_IMPLEMENTATION.md`. Summary:

1. **Four new permission strings** (`server/src/shared/permissionCatalog.ts`):
   `report:financial_view` (D1), `po:approve_high_value` (D2), `grn:view` (D5), `payment:view` (D6).
   Their action segments contain an underscore, which the starter-package validator's permission
   regex (`starterPackage/validate.ts`) didn't allow — the regex was widened
   (`[A-Za-z]+(_[A-Za-z]+)*`) to admit multi-word actions; still exactly one `resource:action` colon.
2. **D1 — Reporting split.** `report:view` now covers only operational reports; a new
   `report:financial_view` gates trial balance, P&L, balance sheet, dealer aging, client ledger,
   day book, GST summary (sales + purchase), supplier ledger, and `/reports/aging-receivables` (an
   equivalent older report, re-gated for consistency — not explicitly named in D1 but the same
   sensitivity class). Only `ACCOUNTANT` (+ `SUPER_ADMIN` via `*`) gets it by default.
3. **D2 — High-value PO approval.** `procurement.service.ts: approvePO()` no longer takes a
   `userRole` string or hardcodes `SUPER_ADMIN`/`PRODUCTION_MANAGER` — it takes a
   `canApproveHighValue: boolean` the router derives from the caller's permissions. The old
   base role-list check (`!['PRODUCTION_MANAGER','SUPER_ADMIN'].includes(userRole)`) is gone
   too: normal approval is `po:approve` alone (as the router already required), matching the
   intended end-state logic in the execution spec. This also surfaced that `PRODUCTION_MANAGER`
   had never actually held `po:approve` in the starter package — despite the old code assuming it
   could approve — so `po:approve` was added alongside the new `po:approve_high_value`, restoring
   the business capability the hardcoded check implied but the permission system never granted.
   `PurchaseOrders.tsx`'s `POApprovalDrawer` mirrors this (`hasPermission('po:approve_high_value')`,
   not `user?.role === 'SUPER_ADMIN'`).
4. **D5 — GRN view.** `GET /procurement/grn` now requires `grn:view` (was `grn:create`);
   `PRODUCTION_MANAGER`/`STORE_MANAGER` both get it alongside their existing `grn:create`.
5. **D6 — Payment view.** `GET /sales/clients/:clientId/payments` now requires `payment:view`
   (was `sales:view`); `ACCOUNTANT`/`SALES_MANAGER` both get it.
6. **D3 — J3 admin permissions.** No target roles decided yet, per the decision sheet — the five
   (`client:deactivate`, `client:delete`, `invoice:void`, `invoice:edit`, `payment:reverse`) remain
   SUPER_ADMIN-only. No frontend UI exists for Void or Payment Reversal at all (J3 shipped
   backend-only) — nothing to gate yet; building that UI is separate, future-scoped work.
7. **Existing-company backfill is written but not run.** `server/scripts/backfillJ4Permissions.ts`
   (dry-run by default, `--apply` to write) additively grants the role-specific strings above by
   role name, across every company, never overwriting an existing custom grant — same posture as
   the documented-but-undeployed `masters:view`/J2 `client:*` backfills. Not run against the local
   dev SEA company in this pass.
8. **Frontend authorization foundation** (`client/src/components/auth/`): `PermissionGate` (inline
   conditional rendering — exact/`resource:*`/`*`, the identical algorithm `auth.store.ts` and the
   backend's `requirePermission` already use) and `RequirePermission` (route-level guard — renders
   an "Access Restricted" panel instead of the page). Wired into `pageRoutes.tsx` for every route
   in Masters, Clients (`orders/clients`), Sales, Procurement, Quality/Repairs, Settings, Hardware,
   and Finance/Reports (the last two needed it too, as a direct consequence of the D1 report split —
   without it, a `report:view`-only user would still see now-`report:financial_view`-gated pages in
   the sidebar and land on a page whose data calls 403). Every other module's routes (Product
   Design, Inventory, Orders(production)/Manufacturing, Outsourcing) are unchanged — out of the
   decided rollout scope.
9. **Module button/action gating**, mirroring each route's own backend permission (no new frontend
   authorization algorithm): `MastersPage.tsx`'s shared `FormPanel` now gates every tab's Add/Update
   (`masters:create`/`masters:edit`) and Delete (`masters:delete`) in one place, with an explicit
   override for the one tab that isn't really a master (Manufacturers/Clients, which edits real
   `Client` rows via `client:create`/`client:edit`) — plus the isActive-toggle chips in
   `GenericMasterSection`/`CategoriesTab`/`StoneTypesTab`/the Clients tab. `Clients.tsx`,
   `SalesInvoices.tsx`, `NewSalePage.tsx` (a dead `useAuthStore` import finally used), `OldGoldExchange.tsx`,
   `PurchaseOrders.tsx`, `Suppliers.tsx`, `PurchaseRequisitions.tsx`, `GrnVerification.tsx`,
   `PurchaseReturns.tsx`, `RepairJobs.tsx`, `JournalEntries.tsx` (the specifically-named Post/New
   Journal buttons), and `RoleEditorPage.tsx` (Save/Delete) all gained the create/edit/delete/
   approve/payment/return-action checks their own mutation's backend permission requires.
   `Suppliers.tsx`'s "Statement" link was also caught and fixed mid-pass — it still checked the
   old `report:view` after D1 moved `supplier-ledger` to `report:financial_view`.
10. **Slice 7 cleanup:** `navItems.tsx`'s "Roles & Permissions" now gates on `role:view` (was the
    retired `role:manage`); its "GRN Verification"/"Repair Jobs" entries now match D5's `grn:view`
    and the loosened `repair:view` (view-only page access, distinct from the `repair:manage`
    workflow actions already gated inside the page). `rbac.ts`'s dead `PERMISSIONS` object
    (confirmed zero usages) was removed and replaced with an exported `hasPermission(perms, p)`
    helper `requirePermission` and the procurement router's approval-permission check both now
    share. `API.md`'s stale `role:manage` doc and every re-gated route's permission column were
    corrected. `qc:approve`/`sales:create`/`tax:manage` are confirmed dead (granted to a starter
    role, enforced by zero routes) but deliberately left untouched — removing them from the catalog
    could make an already-provisioned company's custom role permanently unsaveable in the Role
    Editor if it happens to hold one, without a prior data migration to strip it first; this is
    recorded as deferred cleanup, not fixed here.
11. **No Prisma migration** — `Role.permissions` is a plain `String[]` column (no enum, no schema
    change needed for a new permission string); the backfill above is a data-only script.
    Verified: full suite (805/810, 5 pre-existing skips), `npm run test:rls` against the real
    role-split cluster (809/810, 1 pre-existing skip), `npm run audit:tenant` (0 violations), both
    `tsc`s, and both production builds (client `vite build`, server `tsc -p tsconfig.build.json`)
    all clean.

**Not done / deferred:** `GET /settings/design-categories` still has no permission gate at all — a
real, pre-existing gap independently confirmed by the J4 audit, but not named in the owner's six
locked decisions or execution slices, so left untouched rather than expanding scope. D3's target
roles for the five J3 admin permissions are an explicit future decision. The backfill script is
unexecuted against any live database. See `PHASE_J4_IMPLEMENTATION.md` for the full matrix.

**G2g-7a — Inward GST Foundation & Multi-GSTIN Attribution (TRIVO GST module, 2026-10-02).**
Data-model/attribution foundation only — no GSTR-3B aggregation, ITC eligibility, RCM calculation,
or journal-posting change. Three purely additive pieces: (1) `GrnItem.buyerRegistrationId` —
which of the company's own GST registrations an inward GRN line is attributed to, resolved by new
`shared/inputGst.ts: resolveBuyerRegistration()` from the GRN's own receiving branch (else the
company's primary active registration, else `null` — never the primary when the branch's own link
is merely inactive, mirroring `resolveSellerRegistration`'s identical behavior on the sell side) and
stamped once, alongside the line's existing `taxableValue`/`inputCgst`/`Sgst`/`Igst`, by
`createTagFromGrnItem` (FINISHED_GOODS) and `openPurchaseLot` (FINISHED_LOT) — composite FK to
`CompanyGstRegistration`, same pattern as `Branch.gstRegistrationId`. (2) A reusable `TaxCategory`
concept (`shared/taxCategory.ts`: TAXABLE/EXEMPT/NIL_RATED/NON_GST/ZERO_RATED) on `PoItem.taxCategory`
— decided at PO entry alongside `hsnCodeId`/`taxRate`, never inferred from a 0% rate (a 0%-rated bill
from an unregistered supplier and a genuinely EXEMPT/NIL_RATED/NON_GST/ZERO_RATED supply are distinct
statutory facts); `createPO` defaults an omitted line to TAXABLE, existing rows stay `NULL`. (3)
`Supplier.isComposition` (default `false`), wired into `createSupplier` only — there is no Supplier
edit endpoint at all today (pre-existing gap, confirmed, left untouched). Deliberately **not**
built: any RCM data field anywhere (the placement — supplier vs. line vs. an unbuilt supply-scoped
concept — is genuinely unresolved from this codebase alone; deferred whole to G2g-7d, the brief's own
RCM phase) and `Client.isComposition`/`isUin` (deferred to G2g-7b — outward/recipient-side, out of
this inward-only phase). Migration `20261002150000_g2g7a_inward_gst_foundation` is pure
`ALTER TABLE ADD COLUMN` + one composite FK — no `UPDATE`, no backfill, no row touched (verified via
`prisma migrate diff` returning an empty diff after applying it). See `PHASE_G2G7A_IMPLEMENTATION.md`
for the full design reasoning, the rejected alternatives for each placement decision, and the test
inventory (full suite 1787/1792 non-RLS and 1791/1792 under the real role-split `test:rls` cluster,
both 0 failed; `audit:tenant` clean; both `tsc`s clean).

**G2g-7c — GSTR-3B Table 4(A)(5) ITC Foundation & Eligibility Engine (2026-10-02). NOT a complete
ITC implementation — see §I below for exactly what's deferred.** Pure classification/aggregation
engine, parallel to (never modifying) G2g-7b's frozen outward engine, built the same way: a
no-Prisma classifier (`gstr3bItcEligibility.ts`), a no-Prisma aggregator (`gstr3bItcAggregation.ts`),
and a tenant-scoped reporting service (`gstr3bItcReporting.service.ts`, reusing G2g-7b's
`resolveGstr3bPeriod` rather than re-deriving period math) behind `GET
/finance/reports/gstr3b-itc` (`report:financial_view`, same gate as every other GST report). No
schema change — reads `GrnItem.buyerRegistrationId`/`PoItem.taxCategory`/`Supplier.isComposition`
(G2g-7a) that already existed. Every inward tax-bearing line (GRN intake, Purchase Return, standalone
Debit Note — Path A excluded, same double-count-avoidance convention as
`finance.service.ts: getPurchaseGstSummary`) is classified **ELIGIBLE / INELIGIBLE / UNRESOLVED**
against only five foundation-phase conditions actually checkable today: buyer-registration match,
supplier GSTIN structural validity (full checksum via `shared/gstin.ts`, not a length check),
supplier composition-scheme status (Section 10 — the one reliable INELIGIBLE exclusion this phase
can establish), tax category (`EXEMPT`/`NIL_RATED`/`NON_GST`/`ZERO_RATED` → INELIGIBLE; missing →
UNRESOLVED), and non-RCM/import/ISD (true by construction — this codebase's inward data model has
none of those yet). **Hard invariant: raw book GST is never silently treated as eligible ITC** — a
line with no determinable fact lands in `unresolved`, never `eligible`. Four statutory conditions
the brief asked about — place of supply, Section 16(4) time limit, Section 17(5) blocked credits,
the 180-day payment condition — and GSTR-2B availability are **NOT_DETERMINABLE today** (no inward
place-of-supply field beyond the existing intra/inter-state split, no tracked GSTR-3B filing date,
no transaction-purpose semantics beyond composition/tax-category, `SupplierPayment` is account-level
not bill-linked, and no GSTR-2B ingestion exists) — each reported once per report as a report-level
diagnostic and in a returned `eligibilityMatrix`, deliberately **not** used to gate every individual
line to UNRESOLVED (that would make the `eligible` bucket permanently empty, defeating the report's
purpose — see `gstr3bItcEligibility.ts`'s own header for the full reasoning). A Purchase Return nets
into the exact same bucket its source GRN line was already classified into (never re-derived). See
`PHASE_G2G7C_IMPLEMENTATION.md` for the full eligibility matrix, diagnostics list, and test
inventory (50 focused G2g-7c tests; full suite 1871/1876 local and 1875/1876 under the real
role-split `test:rls` cluster, both 0 failed; `audit:tenant` clean; `tsc`/Prisma-validate clean).
**G2g-7d — Inward RCM & Self-Invoicing Foundation (2026-10-02). Deliberately "foundation only."**
A dedicated read-only audit (`PHASE_G2G7D_AUDIT.md`) found that neither of TRIVO's two real inward
flows (jewellery-stock PO/GRN, old-gold exchange) is actually RCM-liable under current law (Section
9(4)'s blanket unregistered-supplier rule has been suspended since Feb 2019; the only metal-scrap RCM
notification excludes Chapter 71 precious metals) — so rather than add a new expense-recording
entity for the realistic §9(3) categories (GTA freight, legal/security/director services, none of
which this schema can record as a line item), the build is a pure, reusable classification/liability/
self-invoice/ITC engine plus the minimal schema (`PoItem.rcmCategory`, `RcmLiability`,
`SelfInvoice`) needed to represent a notified supply if and when one is ever flagged. New
`gstr3bRcmClassification.ts`/`gstr3bRcmTaxCalculation.ts`/`gstr3bRcmItcEligibility.ts`/
`gstr3bRcmAggregation.ts` (pure engines) + `gstr3bRcmReporting.service.ts`/
`gstr3bRcmBooking.service.ts`; `GET /finance/reports/gstr3b-rcm`, `GET /finance/rcm-liabilities`,
`POST /finance/rcm-liabilities/:id/mark-paid` (all `report:financial_view`/`journal:create`, no new
permission). ITC eligibility is gated on an actual recorded cash payment (Rule 86(2)), never on
liability-creation alone. One integration hook (`bookRcmLiabilityIfApplicable`) wired into
`createTagFromGrnItem`/`openPurchaseLot` — a no-op for ~100% of lines against today's real data, by
design, not by omission. See `PHASE_G2G7D_IMPLEMENTATION.md` for the full writeup, known limitations
(no automatic guard against a line combining `rcmCategory` with a positive `taxRate`; no RCM
adjustment path on Purchase Return/Debit Note), and test inventory (63 focused tests).

**G2g-7e — GSTR-2B Ingestion & Reconciliation Foundation (2026-10-02).** New `Gst2bStatement`
(immutable, versioned per company/registration/FY/tax-period — ACTIVE/SUPERSEDED, never overwritten,
same hashing/versioning discipline as `GstFilingSnapshot`) and `Gst2bDocument` (one normalized row
per B2B/B2BA/CDNR/CDNRA/ISD/ISDA/IMPG/IMPGSEZ entry). A pure normalizer (`gstr2bNormalizer.ts`) maps
the GSTN wire JSON — field-name spelling a best-effort reconstruction, not byte-verified this
session, same disclaimer class as `shared/gstin.ts` — into a stable internal shape, always preserving
the complete original payload verbatim regardless of mapping confidence. A pure matching engine
(`gstr2bReconciliation.ts`) compares the current statement's documents against book GRNs (keyed by
`GoodsReceiptNote.invoiceNumber`/`invoiceDate`, not `GrnItem`), `PurchaseReturn`, and `RcmLiability`
using three strict identity tiers (exact → normalized-document-number → possible-by-GSTIN-and-date
only, never escalated past possible) plus a ₹1 amount tolerance — a false match is treated as worse
than an honest unresolved one throughout. CDNR/CDNRA is capped at `POSSIBLE_MATCH` confidence by
design: this codebase has no field for a *supplier-issued* credit/debit note number (`PurchaseReturn`/
`DebitNote` record TRIVO's own return/memo, not the supplier's statutory Section-34 note). ISD/IMPG
are preserved faithfully but never reconciled (`ISD_NOT_SUPPORTED`/`IMPORTS_NOT_RECONCILABLE`) — no
ISD or Bill-of-Entry model exists in this codebase. `GET /finance/reports/gstr2b-reconciliation`
always reports `GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY` — a match here is not a final ITC
determination; G2g-7c's own eligibility classifier is untouched and remains authoritative. No
automatic journal/GRN/RCM-liability creation from an imported statement (brief's own explicit ban).
`POST /finance/gstr2b/import` (the request body is the raw GSTN JSON itself; registration/period
travel as query params) and the reconciliation GET both reuse `report:financial_view`, no new
permission. See `PHASE_G2G7E_IMPLEMENTATION.md` for the full writeup, known limitations (period
matching uses the GRN's own `receivedDate`, which can misalign with the GSTN filing period for a
late-received invoice; the field-mapping confidence caveat), and test inventory (49 focused tests;
full suite 1987/1992 local and 1991/1992 under the real role-split `test:rls` cluster, both 0
failed; `audit:tenant` clean; both `tsc`s and Prisma validate clean).

**G2g-7e correction (2026-10-02) — GSTR-2B ITC availability (Table 3/4) now independent of match
status.** The reconciliation engine already normalized and persisted the source's own
ITC-availability flag (`Gst2bDocument.itcAvailability`/`.ineligibilityReason`) but never read it back
out before producing a report. Added `Gstr2bTwoBItcAvailability` (`'AVAILABLE' | 'NOT_AVAILABLE' |
'UNKNOWN'` — `UNKNOWN` is explicit and honest, never silently coerced to `AVAILABLE`) and threaded it
through: `Gstr2bDocumentForMatch`/`Gstr2bMatchResult` (`gstr2b.types.ts`), the DB loader
(`gstr2bReconciliation.service.ts`, which previously omitted those two columns), and all 7
`matches.push(...)` sites in `gstr2bReconciliation.ts` via a new pure `twoBAvailabilityOf()` helper —
`matchStatus` computation itself untouched, so e.g. an `EXACT_MATCH` can carry
`twoBItcAvailability: 'NOT_AVAILABLE'`. No schema change (columns pre-existed), no change to G2g-7b/
7c/7d/GSTR-1. 8 new focused tests. See `PHASE_G2G7E_IMPLEMENTATION.md`'s "Correction" section for the
full writeup and verification numbers (49/49 focused, 730/730 GST regression, both `tsc`, Prisma
validate, `audit:tenant` clean, `test:rls` 1999/2000 — 1 pre-existing skip — 0 failed).

**G2g-7e, including this correction, is now ✅ APPROVED / FROZEN by the user (2026-10-02).** Do not
modify any of its five files without an explicit new instruction.

**G2g-7f — Complete GSTR-3B Aggregation & Reconciliation (2026-10-02).** A pure composition layer
only — reimplements none of G2g-7b/7c/7d/7e, all of which remain frozen and untouched. New
`gstr3bReconciliation.types.ts` / `gstr3bReconciliationComposition.ts` (pure, no Prisma) /
`gstr3bReconciliation.service.ts` compose the four frozen reports (outward liability, book ITC, RCM,
GSTR-2B reconciliation) into one `Gstr3bReconciliationReport` behind `GET
/finance/reports/gstr3b-reconciliation` (`report:financial_view`, required `gstRegistrationId` +
`taxPeriod`). Adds exactly what none of the four alone can produce: a full Table 4(A)/4(B)/4(C)/4(D)
ITC presentation (4(A)(3)/4(A)(5) quoted verbatim from 7d/7c; imports/ISD/Rule 42-43/ITC-reclaim
`NOT_SUPPORTED`/`NOT_DETERMINABLE` with `null` amounts, never a fabricated zero; 4(C) nets only the
two supported eligible buckets, flagged partial), six distinct 2B-derived ITC totals (never one
"ITC Available" figure), an 11-category book-vs-2B reconciliation matrix built on 7e's own match
status + ITC-availability flag, and a read-only `GstReturnPeriod` (`returnType: 'GSTR3B'`) filing-
status lookup — which always reads `NOT_STARTED` today, since no service anywhere writes that
returnType yet; this phase creates/files/locks nothing. One deliberate deviation from the brief's own
example: no `SUPPLIER_MISMATCH` matrix category exists, because the frozen 7e matcher indexes
candidates by supplier GSTIN before comparing anything else, so a genuine supplier-identity
disagreement can never surface as one matched-but-disagreeing row (it shows up as two independent
unmatched rows instead) — documented as a standing diagnostic
(`SUPPLIER_MISMATCH_NOT_DETECTABLE`) rather than a category that would always read zero. No schema
change (`GstReturnPeriod.returnType` was already a free-text column anticipating this). See
`PHASE_G2G7F_IMPLEMENTATION.md` for the full audit, design reasoning, and test inventory (33 new
focused tests; full suite 2028/2033 local and 2032/2033 under the real role-split `test:rls` cluster,
both 0 failed; `audit:tenant` clean; `tsc`/Prisma validate clean).

**G2g-7f is now ✅ APPROVED / FROZEN by the user (2026-10-02).** Do not modify
`gstr3bReconciliation.types.ts` / `gstr3bReconciliationComposition.ts` /
`gstr3bReconciliation.service.ts`, or the `gstr3b-reconciliation` route in `finance.router.ts`,
without an explicit new instruction.

**G2g-7g — GSTR-3B export/filing lifecycle + post-filing mutation protection, now ✅ APPROVED /
FROZEN by the user (2026-10-02).** Two parts, both complete. **(1) Export/filing lifecycle:**
`gstr3bGstnWire.types.ts`/`.ts` (pure serializer), `gstr3bGstnValidator.ts` (pure filing-readiness
validator — `isFilingReady` deliberately means "TRIVO's own data is internally resolved," never
"statutorily complete"; `netPosition.statutoryReportingPosition.status` stays permanently
`NOT_DETERMINABLE` regardless), `gstr3bExport.service.ts`, `gstr3bFilingSnapshot.service.ts`,
`gstr3bFilingAttempt.service.ts`, `gstr3bFilingPeriod.service.ts` — new, GSTR-3B-labeled files
reusing the SAME `GstReturnPeriod`/`GstFilingSnapshot`/`GstFilingAttempt` tables and
`OPEN → SNAPSHOT_CREATED → FILING_ATTEMPTED → FILED → LOCKED` lifecycle G2g-6 already established
(`returnType: 'GSTR3B'`, no schema change), never the frozen GSTR-1-typed functions directly (those
hardcode GSTR-1-only audit-action names/pipelines). `GET /reports/gstr3b-export` + six filing-
lifecycle routes in `finance.router.ts` (`report:financial_view`/`gst:snapshot_create`/
`gst:filing_record`/`gst:period_view`, all pre-existing G2g-6a catalog entries). Full writeup in
`PHASE_G2G7G_IMPLEMENTATION.md`. **(2) Close-out mutation protection** (that report's own flagged
gap, closed the same day): `gstr3bFilingProtection.ts: assertGstr3bPeriodMutable()` — unlike
`gstr1FilingProtection.ts`'s document-traceability check, this is purely DATE-based (a GSTR-3B
snapshot is a period-range aggregation with no per-document id list to check against — see that
file's own header), resolving a mutation's own effective date to a tax period and rejecting (409
`GSTR3B_FILED_PERIOD_IMMUTABLE`) only when that exact company+registration+`GSTR3B` period is
`FILED`/`LOCKED`. Wired into every outward (`createInvoice`/`amendInvoice`/`voidInvoice`/
`createSalesReturn`/`convertMemoToInvoice` in `sales.service.ts`; `createStandaloneCreditNote`/
`createCreditNoteForReturn`/`cancelCreditNote` in `creditNote.service.ts`; `createSalesDebitNote`/
`cancelSalesDebitNote` in `salesDebitNote.service.ts`) and inward/RCM (`createTagFromGrnItem` in
`tagging.service.ts`; `openPurchaseLot`/`createPurchaseReturn` in `procurement.service.ts`;
`createStandaloneDebitNote`/`cancelDebitNote` in `debitNote.service.ts`; `markRcmLiabilityPaid` in
`gstr3bRcmBooking.service.ts`) mutation path that can change a FILED/LOCKED period's own reported
figures — a brand-new backdated document is caught too, something GSTR-1's own traceability-based
guard structurally cannot do. **Do not modify `gstr3bFilingProtection.ts`, any of the nine files
listed above, or the export/filing-lifecycle files in part (1), without an explicit new
instruction.** 37 new tests (35 service-level, incl. one true end-to-end run through the real
snapshot → attempt → FILED → LOCKED pipeline; 2 HTTP) all passing; full suite 2135/2140 (5
pre-existing skips) and 2139/2140 under the real role-split `test:rls` cluster (1 pre-existing
skip), both 0 failed; `audit:tenant` clean; `tsc`/Prisma validate clean; no schema/migration change.


**One pricing engine, live gold, same-day estimates (2026-10-14).** Decisions fixed with the owner after a tag -> estimate -> bill audit:
(1) **One formula** - `server/src/shared/pricingEngine.ts` (row = weight x rate; MC = metal weight x MC rate; **VA = % of the METAL's value**, never of MC;
total rounded once to 2 dp). The sale-line breakdown, the estimate totals and the custom per-gram line all call it; the client mirror is `utils/estimateCalc.ts`
and `pricingEngine.test.ts` fails if they drift. The old "VA marks up MC" rule is gone (sales report split and printed VA column included).
(2) **Gold is the one LIVE element**: a METAL row is priced at the day's metal rate for the tag's karat (`resolveLiveMetalRate` - latest rate on/before today, with
its date and `isToday`), never the rate stored on the tag. MC, VA and stone sale rates stay the tag's own columns. If today's rate is not entered the latest earlier
one is used and the estimation / New Sale screens say so (with an "Update rate" link to `/designs/rates` for holders of the new **`rate:update`** permission, which
now gates `POST /designs/rates` and `/rates/batch` instead of `system:config`). No rate at all for a karat = 409.
(3) **Missing sale rates are blocked, never read as 0** (`shared/tagPriceability.ts`): estimation read/save and an auto-priced sale line refuse a tag with no MC / VA or a
stone row with no sale rate (409); `POST/PATCH /tagging/tags` require them (400) and a metal rate for the karat; the New Tag form refuses blanks. A GRN-created piece
takes its SALE MC/VA from the MakingCharge master (`shared/makingChargeLookup.ts`) - the PO/GRN MC/VA are cost and never become sale rates - and stays unsellable
until they exist. (4) **An estimate is a quote for one day** (`shared/estimateExpiry.ts`): `validUntil` = end of the day; yesterday's cannot be sent to billing,
approved or billed and is not offered by the billing search. A sent estimate can be **recalled** (estimator) or **returned from billing** before it is billed
(`recallEstimate`, audited `RECALL`, no new permission); a "gold rate updated since this estimate" indicator compares its frozen rate with the live one - nothing
reprices automatically. Estimate GST now comes from the default HSN's rate in the master. (5) Stock-side reports (branch summary, stock on hand, dead stock, stock book,
counter lookup) show the **live** sale value beside cost (`shared/liveSaleValue.ts`; an unpriceable piece is counted `unpriced`, never 0). (6) The printed invoice reads a
breakdown line's real metal / MC / VA / stone split from `materialBreakdown`. Tests: `pricingEngine.test.ts`, `liveGoldPricing.test.ts`, `estimateLifecycle.test.ts`,
`liveStockValue.test.ts`. **Caveats:** re-saving (amending) an old PER_GRAM invoice with VA > 0 reprices that line under the new rule; existing companies need `rate:update`
added to the roles that enter the daily rate (Starter Package v1 only reaches new companies) and users must log in again.

**Release hardening (2026-10-10).** (a) **The business day is India time**, explicit and independent of the server's timezone: `shared/businessDay.ts`
(`Asia/Kolkata`, UTC+05:30) drives estimate same-day expiry, "is today's metal rate entered", and the offers' "today"; `businessDay.test.ts` pins the 18:30 UTC
rollover and passes under `TZ=America/New_York`. (b) Billing a fully priced tag no longer needs a metal rate on file: the offer-floor lookup only demands the live
rate when an active offer has a METAL rule (`resolveOfferForTag`). (c) `scripts/backfillRateUpdatePermission.ts` (dry-run by default, `--apply` to write) adds
`rate:update` additively to roles that already hold `system:config` - exactly the group that could enter rates before - and nothing else; not run against any live DB.
(d) `http.releaseWorkflow.test.ts` drives rate -> tag -> stock -> estimate -> rate move -> bill (estimate and direct) -> offer -> discount + GST -> permissions ->
tenant boundary over real HTTP against hand-computed figures.

**Offer management, step 1 (2026-10-12) — definitions + resolver only; estimates and billing do not apply offers yet.**
`Offer`/`OfferRule` (migration `20261012100000_offers`, RLS + composite FKs, no cascades) hold dated promotions on the **sale** rates:
making charge (₹/g), VA (%), stone (₹/ct, per stone type) and optionally metal; each rule is `PERCENT_OFF` or `FIXED_RATE`, optionally
narrowed by category / karat / stone type, and an offer can be scoped to one branch. Agreed rules, enforced in the pure
`modules/offers/offerResolver.ts`: **no stacking** (one offer wins per piece — highest priority, then newest; within it each component takes its most
specific rule); an offer **only ever lowers** a rate (a `FIXED_RATE` above the base rate is ignored); an offer that changes nothing never shadows
one that does. An offer is a read-time overlay — it never writes to `JewelryTag`/`JewelryTagMaterial` (costPrice and tagged rates untouched; when the
dates end the tagged price is simply the price again). The **base rate is a single seam** (`baseRatesForTag` in `offer.service.ts`): when the planned
bulk temporary-price-change feature exists, only that function learns about it (pipeline: tagged rate → bulk change for the date → offer). Permissions
`offer:view/create/edit/delete` (SUPER_ADMIN only until granted; `GET /offers/resolve` rides `estimation:view`); page `/offers`
(`pages/Offers/OfferManagementPage.tsx`). **Decided, not yet built (steps 2–3):** the estimate's date picks the offer; the estimate/invoice line
snapshots the original rate, the offer rate and the offer id; any final rate below the offered rate (override or extra discount, no tolerance) needs a
store manager's approval (single-use, tied to the exact rates, requester ≠ approver, audited) before billing; memo/wholesale conversion is out of v1.
Tests: `modules/offers/offerResolver.test.ts`, `offer.service.test.ts`.

**Offer management, step 2 (2026-10-12) - "Apply offer" on the Estimation page.** When an offer applies to the selected piece today, the page
shows a banner (offer name + each rate it lowers) with an **Apply offer** switch; switching it on loads the offered MC/VA/stone/metal rates (tagged
rate struck through, "Offer saving" in Totals), switching it off restores the tagged rates. The client never names the offer: it sends
`applyOffer: true` plus each line's `materialId`, and `createTagEstimate` re-resolves the winning offer by **today's date** itself - refusing (409)
if none applies any more. The estimate stores `offerId` / `offerName` / `baseSaleMcRate` / `baseSaleVaPercent` and each line's `baseSaleRate` (migration
`20261012120000_estimate_offer_snapshot`, composite FK to `offers`, Restrict) so editing, switching off or later deleting the offer never reprices a past
quote - and an offer that a quote used can no longer be deleted (409; switch it off). Billing from the estimate inherits the offered rates (they are the
estimate's rates). Tests: `modules/offers/estimateOffer.test.ts`.

**Offer management, step 2b/3 (2026-10-13) - Apply offer on New Sale, and the store-manager approval gate.** New Sale's tagged lines get the same
"Apply offer" (the client only sets `materialBreakdown.offerApplied`; `priceInvoice` picks the offer by invoice date, stamps it plus the tagged *and the
offered* rates on the stored breakdown - `offer.mcRate/vaPercent`, row `baseRate/offerRate` - and 409s if none applies). **Step 3:** selling any component
**below the offered rate (zero tolerance)** - a hand-lowered MC/VA/stone/metal rate on a tagged `materialBreakdown` line, *whether or not Apply offer was
pressed* - or taking an invoice `discountAmount` on a bill carrying an applied offer, needs a **store manager's approval**. New `DiscountApproval` table
(migration `20261013100000_discount_approvals`, RLS, composite FKs, no cascades; DB CHECKs: requester != approver, LINE has a tag, USED has an invoice),
service `offers/offerApproval.service.ts`, pure logic `offerApproval.ts`, routes under `/offers/approvals`, permission `discount:approve` (granted to the
Starter Package `STORE_MANAGER`; anyone with `invoice:create`/`invoice:edit` may *request*). `priceInvoice` returns `approvalNeeds` (server-computed);
`createInvoice`/`amendInvoice` call `settleApprovals()` inside their transaction: an approval matches a need only by its **rateHash** (piece + exact
below-offer figures, or the exact discount), is consumed `APPROVED -> USED` by a count-checked update (single use; a rollback releases it), and unmet needs
come back together as 409 `DISCOUNT_APPROVAL_REQUIRED` with `details.needs`. Amending leaves already-approved rates alone (they are matched via
`usedInvoiceId`). Screens: `BelowOfferApprovalDialog` (New Sale asks for + polls approvals, then re-saves) and `/offers/approvals` (`ApprovalInboxPage`,
nav "Offer Approvals"). `AppError` gained an optional `details`. **Caveats:** a tagged line sent *without* a `materialBreakdown`, and the memo/wholesale path,
are not gated (no component rates to compare); an extra discount on a bill with an offer the biller did not apply is ordinary; approvals have no expiry;
"use" of an approval is recorded on the row (`usedAt`/`usedInvoiceId`), not as a separate audit entry; **an already-provisioned company's
`STORE_MANAGER` needs `discount:approve` added (Role Editor / one-off script) and users must log in again** - Starter Package v1 only reaches companies provisioned from now on.
**Estimates (2026-10-13):** an estimate priced below its offer is not sent to billing - "Send to Billing" becomes **"Send for Approval"** (reason
required). `createTagEstimate`/`sendEstimateToBilling` check the rates against the offer in force today (`estimateBelowOffer`); if below, the estimate gets
the new status `AWAITING_APPROVAL` (hidden from the billing search) and a `DiscountApproval` linked by `estimateId` is opened in the same transaction
(migration `20261013120000_estimate_approval`; `TagEstimateItem.materialId` added so rows can be matched to the offer). Approve -> the estimate becomes `SENT`
(released to billing); reject or withdraw -> back to `OPEN`. New Sale loads the estimate's approved approval (`GET /offers/approvals?estimateId=&status=APPROVED`)
and sends it as `approvalIds`, so the manager's one approval also covers the bill. The server answers 409 `APPROVAL_REASON_REQUIRED` when a reason is missing.
Tests: `modules/offers/discountApproval.test.ts`, `offerApproval.test.ts`, `estimateApproval.test.ts`, `saleOffer.test.ts`.

**Delete bill (2026-10-12).** The Sales Invoices screen now has a **Delete** action (drawer and list row), gated by the new `invoice:delete` permission (Invoicing group in Roles & Permissions; SUPER_ADMIN via `*`, granted to no starter role - delegate it in the Role Editor, and users must log in again). `POST /sales/invoices/:id/delete` -> `deleteInvoice()` composes the two reversals J3 already trusts: reverse every live receipt (`reverseInvoicePayment`), then `voidInvoice`. It is **not a raw delete** (J3 design audit §6): the bill stays as `VOID`, stock and ledger are reversed, audit `DELETE`. Refused for a bill with a return, a credit note, an IRN or in a filed GSTR-1/GSTR-3B period. **Atomic:** receipt reversals, the void and all audit rows (incl. the summary `DELETE`) run in ONE transaction (`reversePaymentCore`/`voidInvoiceCore` take the caller's tx; `assertVoidable` checks every refusal under `FOR UPDATE` locks, receipts then invoice, before the first reversal), so a refusal or mid-way failure changes nothing and concurrent deletes cannot double-reverse. Supporting fix: `voidInvoice` now ignores *reversed* payments when checking eligibility (before, a bill that ever had a payment could never be voided, even after the payment was reversed). Not built: the standalone Void and Reverse-payment buttons (the server routes `invoice:void` / `payment:reverse` still exist). Tests: `http.deleteInvoice.test.ts`, client `deleteBill.test.tsx`.

**Payment Configuration & Collection (2026-10-15).** Company-owned `PaymentProvider` (bank / UPI provider / acquirer — category and supported methods are separate things),
`BranchPaymentProvider` (which branch collects through which) and `PosTerminal` (code, TID, optional MID, branch, methods) — migration
`20261015100000_payment_configuration` (RLS + composite FKs, RESTRICT, no cascades; TID unique per company+provider+COALESCE(mid) — **not** globally; not `HardwareDevice`, which is a scale/RFID
reader). Nullable per-leg metadata (provider/terminal ids + **snapshots** of name/code/TID/MID, auth code, cheque no./date/bank, and `InvoicePayment.branchId`) sits on the two
existing leg tables `invoice_payments` and `customer_advance_payments` — **no parallel ledger**: `applyPayment`, `recordClientPayment` and `createCustomerAdvance` call one shared
validator (`shared/paymentMetadata.ts: resolvePaymentLegMeta`) before their unchanged accounting. Cash takes none; card needs a branch-assigned active terminal; UPI's provider/terminal are optional;
transfer needs a provider — **required only once the branch has such a terminal/provider configured** (so legacy CARD/BANK_TRANSFER payloads keep working for an unconfigured branch; a *supplied* id is always
validated). A UTR/auth code is metadata, never proof of settlement (no gateway integration exists). Permissions `paymentConfig:view`/`paymentConfig:manage` (SUPER_ADMIN only until granted — **an
already-provisioned company's roles need them added via the Role Editor, and users must log in again**); `/options` rides `payment:create`/`payment:view`. UI: `/settings/payment-config`
(`PaymentConfigPage.tsx`) and `components/sales/PaymentLegFields.tsx` on New Sale splits, Customer Advances, invoice Record Payment and the Clients on-account dialog. Not covered: supplier
payments (money OUT), `SalesReturn` refunds (no payment leg is recorded), the metal/Material Purchase flow (credits the customer's account; no payment legs), and the memo/wholesale conversion.
Tests: `modules/paymentConfig/paymentConfig.test.ts`, `test/http.paymentConfig.test.ts`, client `test/paymentConfig.test.tsx`. See API.md's Payment Configuration section.

---

## 8. Known follow-ups / control gaps

Two things were deferred deliberately while closing gaps #1/#2. Both are intentional tradeoffs, not bugs
— but both are things a future change could trip over, so they're recorded here rather than left implicit.

- **`createInvoice()` is not yet a hard inventory gate.** `InvoiceItem.tagId` is optional, so a line with
  no `tagId` still bypasses inventory entirely (no lookup, no status flip) — exactly like before gap #2.
  This was the explicit choice for v1 (see section 3, gap #2) to keep non-inventory lines — making-charge
  adjustments, gift-wrap fees, historical entries — legal. It means off-book sales through this endpoint
  are still possible; nothing currently forces every line to carry a tag. If that needs closing later,
  it's a policy change (e.g. require `tagId` for certain `invoiceType`s), not a schema change.
- **`convertMemoToInvoice()`'s tag flip is still a blind `updateMany`** (no `status` predicate, no count
  check) — unlike `createInvoice()`'s guarded version. It's safe *today* only because the memo lifecycle
  already serializes tag possession before this function runs: `createMemoOut()` requires `IN_STOCK` and
  immediately flips to `ON_APPROVAL`, so nothing else can be holding the tag by the time you convert. If
  the memo flow ever changes (e.g. a tag could reach `convertMemoToInvoice` without going through that
  reservation step first), this function would need the same count-checked guard `createInvoice()` has.

Two more were found during the master-data discovery pass (2026-08-23) and logged here as roadmap items —
**both closed by Phase C (2026-08-25):**

- ~~No metal-rate-driven pricing path.~~ **Closed by C1/C2/C3.** `KaratMaster` fixes the karat list;
  `shared/metalRate.ts: resolveMetalRate()` wires `MetalRate` into both `createTagFromGrnItem`
  (GRN-date rate) and `createInvoice` (invoice-date rate, PER_GRAM lines); `MakingCharge` is now
  read by `createInvoice` too. See ROADMAP.md Phase C for the full writeup.
- ~~Stone-pricing FK gap.~~ **Closed by C4.** Went with the additive option: nullable
  `JewelryTagMaterial.stoneTypeId` → `StoneType`, `materialCodeId` untouched. `createTag` resolves
  an unset stone-row `saleAmount` from `PriceMaster` by weight (`shared/priceMaster.ts:
  resolvePriceMaster()`). Not yet wired: a `stoneTypeId` picker in `NewTagPage.tsx`, and
  `createTagFromGrnItem` (no materials breakdown on that path).

---

## 9. Glossary (this codebase's real names)

- **`JewelryTag`** — the physical piece; the item-with-status. Our inventory unit.
- **`MemoOut` / `MemoItem`** — dealer consignment; our working wholesale/consignment flow.
- **`convertMemoToInvoice`** — the reference pattern for tag-aware selling (validate -> flip to `SOLD` -> link).
- **`SalesInvoice` / `TaxInvoice`** — billing + GST document.
- **`Client`** — customer or dealer (party). **`Supplier`** — vendor.
- **`PurchaseOrder` / `GoodsReceiptNote`** — procurement / intake.
- **`SalesOrder`** — a *production* order (manufacturing). **Not** a retail/wholesale sale.
- **Dormant modules** — manufacturing/outsourcing/design/BOM: present, unused, untouched.

---

## 10. Frontend UX convention: keyboard-first fields

This app is operated mostly by keyboard — billing counter and back-office data entry, fast repeated
transactions. Every dropdown/select field, wherever it's created or already exists in the client, must be
changeable **while focused, without first opening it**. Arrow keys (and type-ahead) must move the
selection on a focused-but-closed field, same as a native `<select>` — never require a click or
Enter/Space to open the menu before the value can change. Don't build or leave in place a custom picker
that traps keyboard users into a click-first flow.

When adding a new field (dropdown or otherwise) or touching an existing one, check it's reachable and
operable by keyboard from a plain focus state — tab to it, act on it, tab away — not just usable by mouse.

---

## 11. Company isolation (TRIVO is multi-company — nothing client-owned is shared)

**The rule:** every client-owned record must be unambiguously associated with exactly one company —
directly via `companyId`, or through a strictly company-owned parent. Only explicitly approved
platform records may exist outside a company: `Company`, `User` (global login identity),
`RoleTemplate`, `HsnCode`, `StateMaster` (statutory reference data, read-only to every company), and
`PlatformAuditLog` (TRIVO platform events — see phase 2 below). This is enforced by
`src/test/tenantIsolation.masters.test.ts` ("schema guard") — a new model with no `companyId` fails
CI unless it is added to that allow-list with a reason. Nothing a client can create or edit may be
visible to another client, including "insignificant" text (a collection name, a note, a filename).

**Status of the full-isolation plan** (phase order agreed with the user):
1. **Masters per company — DONE.** `DesignCategory`, `KaratMaster`, `ProductCategory`, `SubCategory`,
   `Collection`, `MaterialCode`, `StockType`, `StoneType`, `StoneGrade` all carry `companyId`, unique on
   `(companyId, code)`, with RLS. Migration `20260924020000_masters_tenant_scope` copies every old global
   row to every existing company and repoints tenant rows at their own company's copy (verified on a
   scratch DB with two companies). Every master id a request supplies (tag category/stock type/
   sub-category/collection/material code/stone grade, invoice-line category, design category, making
   charge, price master, stone grade/sub-category parents) is checked with
   `assertOwnedByCompany`/`assertOwnedIfPresent`/`assertAllOwned` (`middleware/tenant.ts`) — a wrong-
   company id is a 404. Masters router PATCHes use a field whitelist, never `req.body` as-is. A new
   company's starter masters (karats + design categories) come from `shared/starterMasters.ts:
   seedStarterMasters()` — **copy, never reference**. Also: `SystemConfig` is company-scoped
   (`20260924010000_system_config_tenant_scope`).
2. **Identity & membership — DONE.** `User` = global login identity only (email, password hash, name).
   `CompanyUser` = the person inside one company: `employeeId` (unique **per company**), `department`,
   `phone`, `username`, role, branch access, `lastLoginAt` (per company — `User.lastLogin` is platform-only
   and never returned to a company). Migration `20260924030000_phase2_identity_isolation` (one transaction;
   verified on a scratch DB) moves employee data onto the unambiguous membership and **aborts rather than
   guesses** if a multi-company user carries employee data or a branch grant already crosses companies.
   - `UserBranchAccess.companyId` + **composite FKs** `(companyUserId, companyId)` and `(branchId, companyId)`
     — the database itself refuses a grant linking one company's member to another's branch. Grants go through
     `company.service.ts` (`POST/DELETE /company/users/:id/branch-access`), which also verifies ownership.
   - `AuditLog.companyId` is NOT NULL. `createAuditEntry(...)` takes a **required** `companyId` and refuses (throws)
     if the acting user is not a member of that company. **Platform events** (operator actions; legacy rows that
     could not be attributed) use the separate `PlatformAuditLog` table via `createPlatformAuditEntry()` — it has
     no `companyId`, no company route reads it, and `production-rls-roles.sql` withholds it from the tenant role.
   - **No silent attach-by-email.** `createCompanyUser`/`POST /auth/users` are gone. A membership only comes from
     a `CompanyInvitation` the recipient accepts (`POST /auth/invitations/accept`, public): one-time token (only its
     SHA-256 is stored; returned once to the inviting admin — no email provider wired yet), 7-day expiry, single-use
     race-safe. New email → login created; existing login → must supply that login's password, then it is linked
     (global name/password untouched). Every failure is the same generic 400, and invite creation never consults
     the global User table, so nothing reveals whether an email has an account anywhere.
   - Auth: login is company-first (`companyCode` selects, membership + password authorise); a failed lookup still
     spends one bcrypt compare (no timing oracle); credential endpoints are rate-limited per route (the old
     app-level `/api/auth` limiter never matched `/api/v1/auth`). Removed unused `optionalAuth` (skipped the
     membership re-check) and the unused `auditLog()` middleware (wrote rows with no company).
   - Tests: `src/test/tenantIsolation.identity.test.ts` (52) — also covered by the schema guard in the masters suite.
   - **Known/accepted:** the password is on the global `User`, so one person in several companies has one
     password; a branch-access change only reaches an already-issued JWT at its next refresh/expiry.
3. **Company provisioning + Starter Package — DONE.** A new company is created by `provisionCompany()`
   (`modules/platform/provisioning.service.ts`), one transaction, steps `company → roles → branch → accounts →
   starterPackage → admin → verify → audit`; any failure (or a failed `verify`) rolls the whole company back —
   there is no half-provisioned company. Entry points: `npm run company:provision` (operator CLI) and
   `POST /platform/companies` (operator API, `x-trivo-platform-key`; disabled/404 unless
   `TRIVO_PLATFORM_API_KEY` is set). **Registration is operator-controlled** — there is no public sign-up.
   - **Starter Package** (`modules/platform/starterPackage/`) = a versioned, **code-defined**, validated
     definition (`v1.ts`): roles + permissions, chart of accounts, karats, design/product categories, stock types,
     stone types/grades, material codes, tag + estimate templates, and pricing/general config keys. It is
     **COPIED** into the new company by `applyStarterPackage()` — never referenced, never shared, never
     auto-propagated to existing companies (a later v2 only affects companies provisioned after it). The applied
     version is stored on `Company.starterPackageVersion`.
   - What it may NEVER contain (enforced by `validate.ts`, and by a test): another company's operational data;
     config keys matching `DEVICE|SCALE|PORT|KEY|TOKEN|SECRET|PASSWORD|URL|HOST|EMAIL|PHONE|ADDRESS|GSTIN|PAN|
     ACCOUNT_NO|IFSC|UPI|WEBHOOK|SMTP…` (a company's own identity/credentials are its own to enter). Uncertain
     ex-SEA data was classified **company-specific** (it stayed with SEA, it is not in the package).
   - Admin: a **new** email becomes an active member at once (operator-supplied password, or a generated one shown
     ONCE); an email that **already has a login** anywhere is never attached silently — it gets a one-time
     INVITATION instead (same rule as phase 2).
   - Platform events go to `PlatformAuditLog` (no companyId; no company route reads it).
   - The dev seed builds SEA **from the Starter Package**, then adds SEA-only demo data separately.
4. **Runtime isolation — DONE.** Nothing process-wide is shared between companies:
   - WebSocket: every room is `company:<companyId>:…` (`role:`/`user:`/`factory:floor` rooms are gone);
     `emit.*` requires a companyId; the socket's company comes from its verified JWT + a membership check;
     suspending a company disconnects its sockets (`disconnectCompany`).
   - Hardware: devices are company-owned `HardwareDevice` rows only; the env `SCALE_PORT`/`RFID_READER_PORT`
     fallback was removed; readings and events carry the company.
   - Redis: every key is `trivo:<companyId>:…` via `cache.forCompany(companyId)`.
   - Object storage: keys are `companies/<companyId>/…` (`shared/objectKey.ts`) and `design_files.filePath`
     has a DB CHECK for the prefix.
   - Refresh tokens carry the companyId; invitation tokens are `<companyId>.<secret>`; `authenticate` also
     requires the company to be active. Document numbers/sequences are per company.
5. **RLS enforced at the database — DONE.** Three DB identities (`prisma/production-rls-roles.sql`):
   `trivo_owner` (DDL: migrations + `db-secure.sql` only), `trivo_runtime` (the API; owns nothing, no BYPASSRLS,
   tables are `FORCE ROW LEVEL SECURITY`), `trivo_platform` (BYPASSRLS, DML only: provisioning, operator,
   platform audit). Every company query goes through `tenantQuery`/`tenantBatch`/`tenantTransaction`
   (`shared/tenantContext.ts`) which `set_config('app.tenant_company_id', …, true)` **inside the same
   transaction as the query** (no request-long transactions; no live Prisma client stored in AsyncLocalStorage).
   `runAsPlatform` is the only door to the BYPASSRLS client. The API **refuses to start** in production if
   `DATABASE_URL` is a superuser / table owner / BYPASSRLS role (`assertDatabaseRoleSafety`).
   - `npm run audit:tenant` (`tools/tenantAudit.ts`) fails CI on any bare company-model Prisma call.
   - After **every** deploy run `npm run db:secure` as the owner (re-applies grants, FORCE RLS, append-only
     `audit_logs`, platform-table restrictions).
   - Postgres omits key details from unique-violation errors on RLS tables — conflict handling resolves them with
     a company-scoped lookup, never by parsing `meta.target`.
   - Tests: the everyday suite runs on a single-role DB (RLS inert; `withForcedRls` simulates it). The
     **real** role split is `npm run test:rls` (DB `trivo_rlstest`, `TRIVO_TEST_ENV_FILE`) — run it before any
     release: it proves RLS with the real non-owner/non-bypass role. Fixtures use `platformPrisma as prisma`.
6. **Composite foreign keys — DONE (58 relations).** Foreign-key checks bypass RLS, so the high-risk relations
   are `("fkId","companyId") → parent("id","companyId")`: the database itself refuses a child pointing at another
   company's parent (tags→category/stock type/branch/manufacturer, invoices/memos→client/branch, members and
   invitations→role, POs→supplier, price/making-charge masters, …). Parents carry `@@unique([id, companyId])`.
   **Gotchas:** on a nested create under a composite relation do NOT pass `companyId` (Prisma fills it from the
   parent; it is invisible to tsc when spread); optional composite relations need `onDelete: Restrict` (a
   referenced master can't be deleted from under its rows). Plain FKs remain on dormant manufacturing
   internals (e.g. `designs.categoryId`) — those still rely on `assertOwnedByCompany`. Tests:
   `src/test/compositeFk.test.ts`.

**When you add code that takes a foreign id from a request** (a category, a client, a branch, ...):
verify it belongs to the caller's company before using it (`assertOwnedByCompany`) — and if the new column is
a high-risk reference, make its relation composite. Postgres FK checks do not consult RLS, so on a plain FK a
forged id passes the database.

**When you add a new company-owned model:** add `companyId` + an index, a `tenant_isolation` RLS policy and
`FORCE ROW LEVEL SECURITY` (see the latest migrations for the SQL), `@@unique([id, companyId])` if anything will
reference it, register it in `db-secure.sql` if it needs special grants, and access it only through the tenant
wrappers. The schema guard, `audit:tenant` and the RLS suite will fail until you do.

`prisma/rls-coverage-report.md` is a stale generated snapshot (predates system_configs and the nine
masters; its header also contains an unrendered `${entries.length}`) — regenerate before relying on it.

### Administrative authority remains tenant-scoped

`SUPER_ADMIN` means **Super Admin of the current company**, not a global database administrator. A Super
Admin may have unrestricted operational modification/deletion authority over their own company's records, but:

- cannot access another company's records;
- cannot modify another company's records;
- cannot delete another company's records;
- cannot bypass RLS;
- cannot use administrative override to cross a tenant boundary.

The existing RLS, `tenantQuery`, `tenantTransaction`, ownership checks and composite foreign keys remain
mandatory for administrative operations. The only application-level exception to ordinary operational
modification is the immutable audit system and explicitly protected platform/security records.

### Company-isolation contract — mandatory for every future feature

A repo-wide isolation sweep (2026-09-28, see `COMPANY_ISOLATION_AUDIT.md` for the full report) confirmed the
architecture described above actually holds in the live code — not just in this document — across queries,
routes, reports/exports/search, WebSocket/Redis/object storage, and RLS config, and closed 4 real
cross-company ownership gaps it found (`JournalLine.accountId`, `JewelryTag.jobCardId`/`designId`,
`HallmarkingItem.jobCardId`, `RepairJob.originalJobCardId` — all were plain, unchecked FKs; all now go through
`assertOwnedByCompany`/`assertOwnedIfPresent`, with regression tests). Nothing here is new policy — it's the
existing rule, made explicit as a sequence so it isn't skipped under time pressure:

1. Identify the owning Company (direct `companyId`, or a strictly company-owned parent).
2. If a request will supply a foreign id on this feature (a client, tag, branch, invoice, account, ...),
   plan the `assertOwnedByCompany`/`assertOwnedIfPresent`/`assertAllOwned` call for it **before** writing the
   create/update logic — not as an afterthought. Postgres FK checks bypass RLS; a plain FK never stops a
   forged cross-company id on its own.
3. Add `@@unique([id, companyId])` + a composite FK if the new column is a high-risk reference another
   table will point at (CLAUDE.md §11 item 6).
4. Every query goes through `tenantQuery`/`tenantBatch`/`tenantTransaction` — never a bare `prisma.<model>.*`
   call on a company-owned model. `npm run audit:tenant` catches this **for the plain-`prisma`, `CallExpression`
   form only** — see the known blind spots below before trusting a clean run as proof.
5. A report/aggregate/export/search endpoint must derive its company scope from `req.tenant`/`ctx.companyId`
   only, never from a client-supplied field — and if it's meant to respect branch restrictions
   (`ctx.branchAccess`), thread that through explicitly; company-scoping alone is not the same guarantee.
6. Add a cross-company regression test for any new foreign-id-accepting endpoint (forged id → 404, nothing
   persisted) alongside the ordinary create/edit tests — this is the cheapest point to catch the class of bug
   the 4 fixes above all were.
7. Only then expose the API/frontend.

**Known guardrail limitations** (found during the sweep, not yet closed — treat as a manual-review checklist
item until closed): `tools/tenantAudit.ts` cannot see raw SQL written as a tagged template
(`` prisma.$queryRaw`...` ``, the actual convention this codebase uses — it only catches the
`$queryRawUnsafe`-style plain-call form) and does not recognize `platformPrisma` (the BYPASSRLS client) at
all, so a stray direct `platformPrisma.<companyModel>.<op>()` call outside `runAsPlatform()` would currently
pass with zero warning. Neither `audit:tenant` nor `test:rls` runs in CI — there is no CI workflow in this
repo at all; both are manual pre-release steps (CLAUDE.md §12). Any new raw SQL against a company-owned table,
or any new use of `platformPrisma`, needs a manual company-scoping review until these are closed.

---

## 12. Production readiness (Phase 6) — what was verified, and what is still open

Verified on a staging stack that mirrors production topology (PostgreSQL 18 with TLS-only app roles and the three-role
split, API in `NODE_ENV=production`, the built SPA behind a same-origin proxy, real HTTP + WebSocket + a real browser).
Harness: `ops/staging/` (see its README). Runbook: `DEPLOY.md`. **"Tests pass" is not the bar** — the staging pass found
bugs the unit/integration suites could not, all fixed and regression-tested (see below).

**Data set:** two companies (VASAVI, SHREE SILVER PALACE), each ≈ 20,000 tags / 5,000 customers / 5,000 invoices
(+ payments, tax invoices, double-entry journals); SHREE was registered **after** VASAVI was heavy.

**Isolation (all against the real stack):** `ops/staging/isolation-http.js` — 200+ checks: every list/report/dashboard/
master/audit/template endpoint for a freshly registered company shows nothing of VASAVI; ~40 IDOR probes (GET/PATCH/PUT/
DELETE with the other company's ids → 404, other company's rows byte-identical afterwards); forged foreign keys and
spoofed `companyId` in body/query/header; identity/invitation non-disclosure; audit; WebSocket (two SUPER_ADMINs — the case
a shared role room would leak — real `memo:alert` over HTTP reaches only its own company); suspension cuts tokens *and*
live sockets; and **database-level RLS independent of every app filter** (all 80+ company tables: SELECT/UPDATE as the
other tenant → 0 rows, no tenant context → 0 rows, INSERT into another company rejected by policy; even the BYPASSRLS
platform role cannot point a row at another company's parent — composite FK).
Browser (`browser-acceptance.js`, Chromium, two isolated profiles + cross-tab): 140 checks — login/guard, 58 screens per
company with zero 5xx / console errors / other-company text, customer created through the UI, realtime frames, logout,
company switch in one tab, cross-tab logout/login, suspended company bounced.

**Backup/restore (real):** `scripts/backup.sh` (as `trivo_backup`) → `scripts/restore.sh` into a scratch DB: 88/88 tables
row-identical, 82 policies + 61 composite FKs intact, every journal balances, zero cross-company references, runtime role
sees exactly its own company per context, and an API booted on the restored DB logs VASAVI in.

**Performance baseline** (one dev machine running API + Postgres + load generator; no internet latency; Redis absent):
| | p50 | note |
|---|---|---|
| paged tag list / search / invoice list / journals | 10–30 ms | |
| trial balance / P&L / balance sheet / day-book / dashboard | 5–15 ms | |
| dealer aging (5k clients) | 61 ms | |
| GST summary, 1 year | ~270 ms | |
| sales register, 1 year (1.9 MB) | ~360 ms | unpaginated |
| dead-stock report (3.1 MB) | ~500 ms | unpaginated |
| `GET /orders/clients` (all 5k, 2.2 MB) | ~150 ms | unpaginated |
30 concurrent readers, both companies, mixed: 89 req/s, 0 errors, p95 ≈ 0.8 s. Writes: `POST /sales/invoices` (validate → tag
flip → journal → payment) ≈ 20 invoices/s **per company** (serialised on that company's document-number row; p95 ≈ 1.3 s at
10-way concurrency on ONE company) and two companies in parallel double the total — no cross-company contention. API
RSS ≈ 470 MB after the run; DB 80 MB, 99.99 % cache hit, no deadlocks. **Known scaling item:** the three unpaginated lists
above grow linearly — paginate before a company passes ~20k customers / ~50k invoices/year.

**Defects found only by this pass (all fixed, regression-tested — `src/test/http.contract.test.ts`):**
1. `POST /sales/invoices` with `payments[].paymentDate` (the UI's bill-and-collect) → 500: JSON dates were never coerced.
2. Missing / non-string ids reached Prisma as-is (500, and `{"not":""}` would have been read as a *filter*): new
   `middleware/inputGuard.ts` (id-named body fields must be strings, `…Ids` string lists, no nested query objects) +
   `assertOwnedByCompany` type-checks.
3. `tag.manufacturerId` had no app-level ownership check (only the composite FK, as a 500).
4. Behind nginx every client shared one rate-limit bucket (no `trust proxy`) — one company's failed logins could lock out
   another: new `TRUST_PROXY`, and `API_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` are configurable.
5. Browser: a logout→login as another company in one tab kept the **previous company's WebSocket** (module singleton) —
   now bound to the session (`client/src/api/socketRegistry.ts`), closed on logout/login/cross-tab change, and observable
   (the LIVE badge could not see a socket created after first render).
6. Browser: an expired/suspended session froze in the app shell — the refresh call's own 401 re-entered the interceptor and
   awaited itself; never settled, so `logout()` never ran.
7. `restore.sh`/`backup.sh` had never been run: libpq rejects Prisma URL params; FORCE-RLS breaks parallel restores and
   makes an *owner*-side row count read 0; `pg_dump` needs a BYPASSRLS read-only role → `trivo_backup`; restore now serial,
   `--exit-on-error`, verified as the backup role.
8. The production build shipped compiled tests (`tsconfig.build.json` now excludes them); nginx now blocks
   `/api/v1/platform` and sets the body limit; login/UI branding said "SEA".

**Still open (do not claim production-ready without these):**
- **No live Redis and no live MinIO/S3 in the verification environment.** Cache keys (`trivo:<companyId>:…`) and object keys
  (`companies/<companyId>/…`, DB CHECK on `design_files.filePath`) are verified at the builder/constraint level and by tests
  only; nothing in the app currently stores files in object storage. Re-run the isolation suite against a real Redis before
  enabling caching.
- `docker-compose.prod.yml`'s new `db-bootstrap` / `migrate` services are unexecuted (no Docker available here); the plain
  commands inside them were run.
- Printer: agent + per-company TSPL verified; a physical label was **not** printed (the TSC printer was offline).
- No email provider: invitation tokens are returned to the inviting admin (no self-service password reset by email).
- Registration is operator-only by design; a public sign-up would need e-mail verification + abuse controls first.
- No PITR (nightly logical backup only); no monitoring/alerting stack; no load test beyond one machine / 30 users.
- A person in several companies has one password (global `User`); stolen-JWT window = access-token lifetime (8 h default).
- **Administrative data-control verification (Phase J):** before release, verify that a company `SUPER_ADMIN`
  can perform the supported edit/delete/restore/override operations for every classified operational entity,
  delegated permissions work correctly, unauthorized users receive `403`, cross-company operations fail, and
  every administrative action produces an immutable audit record.
