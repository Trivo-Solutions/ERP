# Phase J1 — Universal Edit/Delete/Restore Audit

> Read-only inventory of every operational Prisma entity's current Create/Edit/Delete/Restore capability,
> produced **before** any Phase J implementation. Nothing in this document changes behavior. See CLAUDE.md
> §6–§7 (Phase J) for the policy this audit is scoped against.
>
> Method: the ~89 operational Prisma models were split into 8 groups (Identity & Access, Masters,
> Procurement & Suppliers, Tagging & Inventory, Sales & Client, Finance, Quality/Repairs/Hallmarking,
> Dormant Manufacturing) and each researched independently against the live code (`server/prisma/schema.prisma`,
> every router/service file that touches the entity, and the corresponding frontend page), citing file:line.

---

## 1. Cross-cutting findings — read this before planning J2/J3

These recur across multiple groups and should shape the *framework* (J2/J3), not be fixed piecemeal:

1. **Zero `router.delete(` exists anywhere in the entire server codebase.** Confirmed independently by three
   groups (Sales, Procurement, Finance) via a full-tree grep. Phase J starts from literally nothing on the
   delete side — every recommendation below is a net-new capability, not a hardening of an existing one.
2. **Audit entries systemically carry no before/after diff.** Every `createAuditEntry(...)` call reviewed
   across Tagging, StockAudit, OldGoldExchange, and elsewhere passes `oldValues`/`newValues` as `undefined`.
   This satisfies CLAUDE.md §6.6's letter (a row exists) but not its intent. Fix once, in the shared
   framework (J3), not per call site.
3. **Whole swaths of mutating code call `createAuditEntry` not at all**: all 16 Masters entities' CRUD
   (`masters.router.ts`), `MetalRate` upsert, `TagTemplate`/`EstimateTemplate` CRUD, the entire Quality module
   (repairs + hallmarking — zero calls), PO/PR workflow transitions (submit/approve/reject/convert),
   `GoodsReceiptNote`/verify, `CompanyUser` edit/deactivate, `Branch` create/edit, `SystemConfig` upsert,
   `HardwareDevice` (including create), `JewelryTag.retireTag`, `BranchTransfer`'s submit/approve/cancel,
   and the entire `finance.service.ts` file (not even `createJournalEntry`/`postJournalEntry`). This is a
   bigger, more immediate gap than delete/restore itself.
4. **CLAUDE.md §6.2's suggested permission families don't exist yet** for `client:*`, `payment:*`,
   `return:*`, `supplier:*`; `memo:*` is one undifferentiated `memo:manage`. Client CRUD is currently gated
   by `order:view`/`order:create` — the *production-order* permission group — a real naming/scoping leak.
5. **Two live, pre-existing bugs surfaced during this pass** (not Phase J scope, but should be fixed with or
   before it — flagged prominently to the team):
   - **CRITICAL — tenant isolation gap in Finance.** `JournalLine.accountId` is a **plain FK**, never
     ownership-checked. `POST /finance/journals` (`journal:create`) accepts a request body with an
     arbitrary `accountId`; once posted, `postJournalEntry` updates that account's `balance` with **no
     company check**. A forged id from another company's `Account` is currently accepted and its balance
     mutated. Root cause: `Account` has no `@@unique([id, companyId])`, so the relation can't even be made
     composite without a migration. Fix: add the composite unique + FK, and
     `assertOwnedByCompany('account', line.accountId, ...)` in `createJournalEntry`.
   - **`JewelryTag.updateTag()` lets a plain `tag:create` holder change `costPrice` on an already-SOLD
     tag**, with no status check, no distinct permission, and no audit diff — a direct violation of
     CLAUDE.md §6's explicit rule that `costPrice` must stay immutable outside an authorized administrative
     operation. Stock-valuation reports (`getStockOnHand`/`getDeadStock`) read `costPrice` live, so this can
     silently diverge reported inventory value from the posted Inventory ledger balance with no
     reconciliation.
6. **A real anti-pattern already exists that CLAUDE.md §6.7 explicitly warns against building**:
   `PATCH /procurement/orders/:id/status` is a generic, model-unaware status setter — no transition
   validation, no ₹5,00,000 approval-threshold check, no `ApprovalHistory` row, no audit entry. Anyone with
   `po:approve` can PATCH a PO straight from `DRAFT` to `COMPLETED`, bypassing the entire guarded workflow
   (`submitPOForApproval`/`approvePO`/`rejectPO`) that sits right next to it. Recommend removing or
   redirecting it to the guarded functions, independent of Phase J.
7. **Several plain (non-composite) FKs on otherwise-composite-FK-protected models**, none currently
   exploitable (no request path sets them directly today) but inconsistent with CLAUDE.md §11's convention
   and worth closing in the same migration pass as any other J3 schema work:
   `JewelryTag.jobCardId`/`designId` (also unguarded at the app layer — sibling field `grnItemId` on the
   same call *is* checked, showing the gap is an inconsistency, not a design choice), `JewelryTag.grnItemId`
   itself, `PrItem.prId`, `ApprovalHistory.purchaseRequisitionId`/`purchaseOrderId`,
   `HallmarkingItem.jobCardId`/`RepairJob.originalJobCardId` (also missing an ownership check — untested
   for cross-company forgery, unlike the analogous `tagId`/`clientId` checks on the same models).
8. **Entities that are effectively dead, beyond CLAUDE.md §2's documented dormant list** — recommend an
   explicit business decision on each rather than building Phase J machinery for them:
   - `ExportDocument` — orphaned; no code path ever creates a row (the packing-list feature computes on the
     fly and never touches this table).
   - `ClientNotification` — misleadingly named; its only FK is to `SalesOrder` (dormant production order),
     not to `Client`/`SalesInvoice`. Belongs with the manufacturing cluster despite the name.
   - `StoneLot`/`StoneLotSplit` — reachable via its own Inventory screen, but its only real consumer is the
     dormant `SalesOrder`/`MaterialReservation` BOM-reservation flow (+ one report). Not wired into the live
     buy→stock→sell loop; stone valuation (C4) deliberately uses `StoneGrade` (a master), not this.
   - `Consumable`/`ConsumableTransaction` — stronger than dormant: **there is no create endpoint at all**,
     so a `Consumable` master row can never come into existence through the app. Either dead scaffolding or
     a missing feature nobody wired up.
9. **RBAC naming smells** (not security holes, but worth a Phase J2 pass): `GET /procurement/grn` gated on
   `grn:create` not a view permission; `DesignCategory`'s GET has *no* permission check at all; Client CRUD
   rides `order:*`; `memo:manage`/`repair:manage` each bundle 3–4 unrelated actions under one string.
10. **Frontend has zero permission-awareness in `MastersPage.tsx`** — every Add/Edit/Delete button renders
    unconditionally regardless of the user's grants (server independently enforces correctly, so not a
    security hole, but it violates CLAUDE.md §6.10's intent and would surface a raw error toast instead of
    simply not showing the button).

---

## 2. Master matrix

Legend for **Recommended Op**: HD = Hard Delete · SD = Soft Delete · DA = Deactivate/Activate ·
SR = Status-Retire · AM = Amend · RV = Reverse (compensating txn) · AO = Administrative Override ·
PR = Protected System Record · OOS = Out of scope (child entity or dormant).

| Module | Entity | Recommended Op | Permission (✅ exists / ⚠️ gap) | Audit | Key Risk / Note |
|---|---|---|---|---|---|
| Identity | Role | HD (FK-blocked) + AM | ✅ role:create/edit/delete | ✅ done | Reference implementation for the whole phase |
| Identity | Company | DA (done) + AM (missing) | platform key; ⚠️ no self-service edit | partial | Name/GSTIN/state uncorrectable post-provisioning — real tax-consequence gap |
| Identity | CompanyUser | DA + AM | ✅ user:manage | ❌ missing | `updateCompanyUser()` writes zero audit rows |
| Identity | UserBranchAccess | HD (correct) | ✅ user:manage | ✅ done | Best-implemented entity in the group |
| Identity | User | PR (delete) / DA (missing) | ⚠️ none (would need platform-level) | n/a | `isActive` field dead — no path ever sets it false; cross-company blast radius issue |
| Identity | AuditLog | PR (confirmed, app + DB grant level) | audit:view (RO) | is the event | Strongest protection in schema — DB REVOKE UPDATE/DELETE |
| Identity | PlatformAuditLog | PR (confirmed) | n/a | is the event | No SELECT grant at all for runtime role |
| Identity | CompanyInvitation | SR (done) | ✅ user:manage | ✅ done | Well implemented; minor unbounded stale-row growth only |
| Identity | Branch | DA + AM | ✅ branch:create/edit | ❌ missing | create/update never call createAuditEntry |
| Identity | NumberSequence | PR | ⚠️ none (no override exists) | n/a | No admin override if a counter desyncs — flag for discussion |
| Identity | SystemConfig | AM (upsert) | ✅ system:config | ❌ missing | upsertConfig() never audits |
| Identity | HardwareDevice | DA + AM | ✅ hardware:manage (extend) | ❌ missing, incl. CREATE | No edit/delete route exists at all today |
| Masters | StockType | DA (HD override) | ✅ masters:edit/delete | ❌ missing | Hard-delete-by-default, no restore; FK-safe |
| Masters | ProductCategory | DA (HD override) | ✅ masters:edit/delete | ❌ missing | 5 dependents, all Restrict |
| Masters | SubCategory | DA (HD override) | ✅ masters:edit/delete | ❌ missing | Re-parent ownership check exists (good) |
| Masters | Collection | DA | ✅ masters:edit/delete | ❌ missing | Lowest blast radius |
| Masters | MaterialCode | DA | ✅ masters:edit/delete | ❌ missing | `karat`/`materialType` edit on in-use row silently changes future pricing |
| Masters | KaratMaster | SR (partial) | ✅ masters:edit/delete | ❌ missing | DELETE usage-checks 9 tables; PATCH doesn't guard a `code` rename in use |
| Masters | StoneType | DA | ✅ masters:edit/delete | ❌ missing | Two-hop dependency via StoneGrade, FK-safe |
| Masters | StoneGrade | DA | ✅ masters:edit/delete | ❌ missing | PriceMaster snapshots classification at write (good pattern) |
| Masters | PriceMaster | DA (already correct) | ✅ masters:edit/delete | ❌ missing | DELETE route is secretly a deactivate already |
| Masters | MakingCharge | DA (already correct) | ✅ masters:edit/delete | ❌ missing | Same pattern as PriceMaster |
| Masters | MetalRate | AM (upsert exists); needs admin delete-by-id | ✅ system:config | ❌ missing | Highest per-write financial risk in group — feeds live same-day pricing, no delete path for a wrong entry |
| Masters | TagTemplate | HD (new capability) | ⚠️ tagTemplate:delete gap | ❌ missing, incl. create/edit | No dependents; verify default-template fallback first |
| Masters | EstimateTemplate | HD (new capability) | ⚠️ estimateTemplate:delete gap | ❌ missing, incl. create/edit | Same as TagTemplate |
| Masters | DesignCategory | OOS (dormant-adjacent) | ⚠️ GET has no permission at all | ❌ missing, incl. create | No edit/delete route exists at all |
| Masters | HsnCode | PR (confirmed) | n/a — platform-only if ever built | n/a | taxRate snapshot on InvoiceItem/PoItem protects history |
| Masters | StateMaster | PR (confirmed) | n/a | n/a | Lowest edit need of all masters |
| Procurement | Supplier | AM + DA | ⚠️ supplier:edit/delete gap | n/a today | **Zero edit/delete capability exists at all**; `isActive` dead |
| Procurement | SupplierPayment | RV | ⚠️ supplierPayment:reverse gap | n/a today | No correction mechanism once posted — high financial risk |
| Procurement | PurchaseOrder | SR (pre-GRN HD already correct) | ✅ po:approve/create | partial (create/delete only) | Generic status-PATCH bypasses the whole approval workflow (§1.6) |
| Procurement | PoItem / PoItemCategory | OOS (header-owned) | n/a | n/a | Fine as-is |
| Procurement | GoodsReceiptNote | PR (correctly un-editable today) | fix grn:create→grn:view split | ❌ missing on /verify | Correct as intentionally protected — the trigger for tags/lots/journals |
| Procurement | GrnItem | OOS (GRN sub-object) | n/a | n/a | `JewelryTag.grnItemId` plain FK — schema-hardening backlog |
| Procurement | PurchaseLot | SR (Close, already correct) | ✅ tag:create (existing) | ✅ done | Well-built: version-locked, count-checked, report-only |
| Procurement | PurchaseReturn / Item | RV (forward direction correct) | consider dedicated return:create | ✅ done | Best-built entity in the group; the return itself has no undo |
| Procurement | MetalStock | AM (adjust, correct) + DA | ✅ stock:adjust | ✅ done | Solid template; only gap is dead isActive + no delete |
| Procurement | PurchaseRequisition / PrItem / ApprovalHistory | AM + HD (DRAFT only) | ✅ po:create/approve | ❌ missing on all 4 workflow actions | No edit/delete of any kind, even DRAFT; `convertToPO` picks an arbitrary supplier (design smell) |
| Tagging | JewelryTag | SR (existing retire) + new AO for cost/branch edits | ⚠️ tag:edit/tag:retire gap (rides tag:create) | ❌ retire has none; update has no diff | **§1.5 costPrice-immutability violation**; branchId editable bypassing BranchTransfer lifecycle |
| Tagging | JewelryTagMaterial | OOS (child of tag) | inherits tag's | inherits | Only `deleteMany` hard-delete in this scope — verify rollback atomicity |
| Tagging | BranchTransfer | SR (existing cancel) | ✅ branch:transfer/approve | partial (create/receive only) | submit/approve/cancel create no audit entry |
| Tagging | BranchTransferItem | OOS (child) | inherits | inherits | — |
| Tagging | StockAudit | PR / Amend-lite | ✅ stock:view/adjust | ✅ good coverage | Report-only by design, confirmed in code |
| Tagging | StockAuditItem | OOS (child) | inherits | inherits | — |
| Tagging | TagEstimate | AM while OPEN; PR once SENT/INVOICED | ⚠️ estimation:edit/cancel gap | unverified | No reservation on quoted tag — sellable/retirable out from under a live estimate |
| Tagging | OldGoldExchange | RV — capability missing entirely | ⚠️ oldGoldExchange:reverse gap | CREATE only, no diff | Irreversible today: real journal + balance + MetalStock side effects, no undo — clearest §6.8 gap found |
| Tagging | StoneLot / StoneLotSplit | OOS — flag as dormant-adjacent | adequate for current reach | adequate | Zero references from tagging/sales/procurement |
| Tagging | Consumable / ConsumableTransaction | OOS — flag as dead scaffolding or missing feature | adequate | adequate | No create endpoint exists at all |
| Sales | Client | DA (+ admin HD if never transacted) | ⚠️ **no client:*** — rides order:view/create | partial | No dependency check before edit; UI has zero Edit/Delete controls |
| Sales | SalesInvoice | AM (done) / SR+RV for delete | AM via invoice:edit; ⚠️ invoice:delete/void gap | AMEND done; VOID missing | Zero delete path; InvoicePayment's Restrict FK accidentally blocks delete once paid, not before |
| Sales | InvoiceItem | OOS (governed by parent) | same as SalesInvoice | covered by parent | Returned lines already locked in amendInvoice |
| Sales | InvoicePayment | RV | ⚠️ **no payment:*** — rides invoice:create | ❌ missing | fromCredit reversal must not double-reverse the originating exchange/return |
| Sales | SalesReturn / Item | PR / append-only (it IS the reversal primitive) | ⚠️ **no return:*** — rides invoice:create | ✅ CREATE done | I3 GST credit-note still not implemented (confirmed still true) |
| Sales | MemoOut / Item | SR (force-return outstanding items) | ⚠️ only memo:manage, no split | ✅ CREATE done | `returnMemoItems`' tag flip is unconditional — second undocumented instance of the documented convertMemoToInvoice gap |
| Sales | TaxInvoice | PR (confirmed) | none independent | covered by parent | 1:1, correctly invoice-transaction-owned |
| Sales | ExportDocument | OOS — orphaned model | n/a | n/a | No code path creates/reads/writes it at all |
| Sales | ClientNotification | OOS — belongs to dormant SalesOrder cluster | n/a | n/a | Misleadingly named; FK is to SalesOrder, not Client |
| Finance | Account | DA (system accts = PR once any JournalLine) | ⚠️ finance:edit gap | ❌ missing | No edit/delete route today; **CRITICAL accountId tenant gap, §1.5** |
| Finance | JournalEntry | PR once posted; draft = HD-able; correction = RV | journal:create/post; ⚠️ journal:reverse gap | ❌ missing | No route exists today (clean), but also zero audit and no reversal mechanism |
| Finance | JournalLine | PR, always — no independent lifecycle | inherits parent's | captured in parent's | Same CRITICAL accountId gap as Account |
| Finance | CostCenter | DA | ⚠️ finance:edit gap | n/a today | No create/edit/delete route at all; not in Starter Package — confirm scope before building |
| Quality | RepairJob | AM while unbilled; RV-then-delete (or block) once billed | ✅ repair:edit/manage; ⚠️ repair:delete gap | ❌ none exist | No delete path today (nothing to orphan yet), but must gate on invoiceId first if ever added |
| Quality | RepairTransaction | AM/RV only, never bare delete | ✅ repair:manage | ❌ none exist | Increments parent's metal counters with no reversal path if ever deleted |
| Quality | HallmarkingBatch | SR (cancel) / no HD once items exist | ✅ hallmark:manage | ❌ none exist | Zero audit trail for any hallmarking action today |
| Quality | HallmarkingItem | PR once RECEIVED; AM pre-receipt | ✅ hallmark:manage | ❌ none exist | `jobCardId` has no ownership check — untested cross-company forgery vector |
| Dormant (Mfg) | JobCard/JobProcess/WipTracking/QcCheckpoint | OOS | n/a | n/a | Manufacturing per CLAUDE.md §2 — leave untouched |
| Dormant (Mfg) | Artisan/KarigarLedger/ProcessTolerance/SubcontractorInvoice | OOS | n/a | n/a | Outsourcing per CLAUDE.md §2 — leave untouched |
| Dormant (Mfg) | Design/BomItem/BomProcess/DesignFile/CostEstimate | OOS | n/a | n/a | Design/BOM per CLAUDE.md §2 — leave untouched |
| Dormant (Mfg) | SalesOrder/OrderItem/MaterialReservation | OOS | n/a | n/a | Production order, **not** a retail/wholesale sale — leave untouched |

---

## 3. Per-module detail

The full per-entity writeups (UI page, exact API routes with file:line, current edit/delete mechanism,
dependency graph, financial/inventory/tax impact, tenant-enforcement verdict, and the specific §6.12 test
categories that apply) are preserved from the research pass and available in this session's agent transcripts.
The highlights not already captured in §1–2:

### Identity & Access
Tenant/ownership enforcement in this group has **no gaps** — every entity that takes a request-supplied
foreign id correctly calls `assertOwnedByCompany`/`assertBranchAccessible`. The entire gap surface here is
audit-trail coverage (see §1.3) plus two real product decisions to make: (a) `Company` identity fields
(name/GSTIN/state/address) have no correction path post-provisioning — a real tax-consequence risk; (b)
`User.isActive` is a dead field with no deactivation path anywhere, meaning a login terminated at one company
stays fully live at any other company it belongs to — deactivating a global login is inherently a
cross-company decision and needs its own (likely platform-level) capability, not a per-company one.

### Masters
Two systemic patterns to fix once, in the framework, rather than per-entity: (1) 8 of 16 masters attempt a
real hard `.delete()` first and only fall back to a 409 when FK-blocked — they never actually deactivate for
you and, once a hard delete succeeds, there is no restore path. Only `PriceMaster`/`MakingCharge` already do
the right thing (their DELETE route is secretly a deactivate). Recommend unifying all onto that pattern:
DELETE = deactivate; a separate, higher-permission "purge" = true hard delete for zero-history rows only.
(2) One `masters:*` permission triple gates all 16 entities at once — no way to grant "can edit categories
but not touch pricing." `KaratMaster.code` can also be silently renamed while in use via PATCH even though
DELETE has a real 9-table usage check — the same guard should apply to a `code` change, not just delete.

### Procurement & Suppliers
The procurement-return path (`PurchaseReturn`) and lot-closing path (`PurchaseLot`) are the best-built
reversal/status-transition examples in the whole codebase — count-checked tag flips, exact pro-rata GST
reversal, version-locked concurrency guards. By contrast, `Supplier` and `SupplierPayment` have **zero**
edit/delete/reverse capability at all — the single largest functional gap in this group relative to
CLAUDE.md §6's "customer must be able to correct their own operational data" mandate. `PurchaseRequisition`
is inconsistent with `PurchaseOrder`: a mistakenly-created DRAFT PR has no removal path at all, while a
DRAFT PO does.

### Tagging & Inventory
`JewelryTag` is the highest-risk entity in the whole audit given its ~9 dependent tables and the confirmed
`costPrice` mutability violation (§1.5). `BranchTransfer`'s reservation/release logic (tag flip at creation,
not approval — the recent race fix) is correct and count-checked at every step; its only gap is missing
audit entries on 3 of its 5 transitions. `OldGoldExchange` is the clearest example of a §6.8 violation found
anywhere: real, permanent journal + balance + Metal Vault side effects with genuinely no reversal capability
built — not merely unsafe, absent.

### Sales & Client
`amendInvoice()`/`createSalesReturn()` are the reference patterns for this whole phase — transactional,
count-checked, audited with real before/after, correctly locking returned lines and fixed customers. The gap
is entirely on the *delete* side, which doesn't exist for any of the 11 entities in this group, and on
permission-family naming (`client:*`/`payment:*`/`return:*` don't exist; everything rides `invoice:create`
or `order:*`). `MemoOut.returnMemoItems()`'s tag flip is unconditional (no status predicate/count check) —
a second, previously-undocumented instance of the same risk class CLAUDE.md §8 already flags for
`convertMemoToInvoice`.

### Finance
This group is unusual: there is currently **no** edit or delete route for any of its 4 models, so there is
nothing dangerous to lock down defensively — the Phase J work here is closer to net-new build (a Reverse
capability for `JournalEntry`, Deactivate for `Account`/`CostCenter`, and audit calls that don't exist at all
in `finance.service.ts` today) than to auditing-away an existing danger. The one live danger (§1.5's
`JournalLine.accountId` gap) predates Phase J and should be fixed as its own priority item, not folded into
J3's timeline.

### Quality / Repairs / Hallmarking
The entire module has **no audit logging whatsoever** — a bigger and more immediate gap than delete/restore
itself. `RepairJob.originalJobCardId` and `HallmarkingItem.jobCardId` are the only ownership-check gaps found
in this group (mirroring the `jobCardId` gap found independently on `JewelryTag` in Tagging) — worth fixing
together since it's the same field name, same missing check, appearing on three different models.

### Dormant Manufacturing (not independently re-audited — per CLAUDE.md §2)
`JobCard`/`JobProcess`/`WipTracking`/`QcCheckpoint`, `Artisan`/`KarigarLedger`/`ProcessTolerance`/
`SubcontractorInvoice`, `Design`/`BomItem`/`BomProcess`/`DesignFile`/`CostEstimate`, and
`SalesOrder`/`OrderItem`/`MaterialReservation` are confirmed unused by the live wholesale/retail path (their
only touchpoints are the two documented optional FKs on `JewelryTag`, plus `ClientNotification`'s FK to
`SalesOrder`, and `Consumable`/`StoneLot`'s incidental overlap noted in §1.8). Per CLAUDE.md's explicit
instruction, these are **out of scope for Phase J** — do not build edit/delete/restore machinery for them
unless the business explicitly asks.

---

## 4. Recommended sequencing

Not a commitment — a proposed order for J2/J3, grouped so each stop is reviewable on its own:

1. **Fix the two pre-existing bugs first, independent of Phase J** (§1.5): the `JournalLine.accountId`
   tenant-isolation gap, and `JewelryTag.costPrice` post-sale mutability. Both are correctness/isolation
   issues today, not new scope.
2. **J2 — RBAC**: add the missing permission families (`client:*`, `payment:*`, `return:*`, `tag:edit`/
   `tag:retire`, `supplier:*`, `tagTemplate:delete`/`estimateTemplate:delete`, split `memo:manage`) per
   CLAUDE.md §6.2's convention, reusing existing strings wherever one already covers the need.
3. **J3 — audit-trail sweep** (§1.3): add `createAuditEntry` with real before/after to every mutating
   function currently missing it. This is additive, doesn't change business logic, and closes the single
   biggest compliance gap uniformly across every module — do this before building new delete/restore
   endpoints, so every new endpoint gets it for free from the shared pattern.
4. **J3 — module-by-module delete/restore/reverse**, in roughly this order of urgency: Sales & Client
   (invoice void/reverse, payment reverse) → Tagging (tag edit-permission split, old-gold reverse) →
   Procurement (supplier edit/deactivate, supplier-payment reverse) → Finance (account deactivate, journal
   reverse) → Masters (unify hard-delete-by-default onto the deactivate-first pattern) → Quality/Identity
   (lower urgency — smaller blast radius, fewer financial side effects).
5. **J4 — frontend**: wire Edit/Delete/Restore actions gated by the new permissions; fix `MastersPage.tsx`'s
   unconditional button rendering.
6. **J6 — tests + `npm run test:rls` + `npm run audit:tenant`** before considering any module's Phase J work
   complete, per CLAUDE.md §6.12/§7.
