# Phase J3 — Administrative Mutations: Design Audit

> **DESIGN + AUDIT ONLY. No code, migration, permission, route, or schema change was made in this
> pass.** Read-only inventory + proposed semantics for the four entity families named in scope:
> `Client`, `SalesInvoice`, `InvoicePayment`, `SalesReturn`. Everything below is a recommendation
> for human review, not an implementation.

---

## 1. J3 scope

Design a safe, **entity-specific** administrative mutation framework — not a generic
`DELETE /anything/:id` — for the four families J2 already separated permission-wise. Determine,
per entity: current lifecycle, existing mutation paths, dependencies, financial/stock/tax
consequences, the correct administrative operation (hard delete / soft delete / deactivate / void /
reverse / amend / restore / no-op), the permission model, SUPER_ADMIN vs delegated behavior, audit
requirements, transaction sequencing, cross-company test coverage, schema/migration implications,
and frontend implications. Per the brief, **do not** propose final permission names as settled fact
— the names below are the recommendation this document is asking to be reviewed, not something
already added to `permissionCatalog.ts` (it has not been touched).

---

## 2. Frozen J1/J2 baseline (what this document builds on, not re-litigates)

- **J1** (`PHASE_J1_AUDIT.md`): full 90-model classification. Confirmed **zero `router.delete(`
  exists anywhere in the server**. For this scope's four entities specifically: `SalesInvoice` →
  AM done (`amendInvoice`), delete/void missing; `InvoicePayment` → no `payment:*` permission
  existed pre-J2, reverse missing entirely; `SalesReturn` → already the reversal primitive, CREATE
  done, classified PR/append-only; `Client` → DA recommended, no dependency check before edit, no
  Edit/Delete UI control.
- **J2** (`PHASE_J2_REVIEW.md`, reviewed clean): added exactly `client:view`/`client:create`/
  `client:edit`, `payment:create`, `return:create` and re-gated the six already-existing endpoints
  that used to ride `order:*`/`invoice:create`. **No business logic changed.** No delete/reverse/
  void/amend permission exists yet for any of the four families — this document is what comes next.
- **Company-isolation sweep** (`COMPANY_ISOLATION_AUDIT.md`): confirmed clean for `Client`,
  `SalesInvoice`, `InvoicePayment` (via `applyPayment`), `SalesReturn` write paths; the one CRITICAL
  fix in this area (`JournalLine.accountId`) is upstream of these four entities (every ledger post
  in this scope goes through `postAutoJournalEntry` → `createJournalEntry`, which now checks it) and
  does not need to be re-verified per new J3 endpoint, only re-exercised by each new endpoint's own
  regression test per the existing convention.
- This document does **not** repeat the schema classification, the RLS/FORCE-RLS state, or the
  identity/provisioning model — see CLAUDE.md §11 and the two audits above for those; they apply
  unchanged to every mutation proposed here.

---

## 3. Entities reviewed

`Client` (`server/prisma/schema.prisma:1099`), `SalesInvoice` (`:2317`) + its owned child
`InvoiceItem` (`:2374`) + its 1:1 `TaxInvoice` (`:2615`), `InvoicePayment` (`:2432`), `SalesReturn`
(`:2462`) + its owned child `SalesReturnItem` (`:2487`). Service code read directly:
`server/src/modules/orders/orders.service.ts` (`listClients`/`createClient`/`updateClient`/
`getClient`, lines 163–225), `server/src/modules/sales/sales.service.ts` (`createInvoice` 218–479,
`priceInvoice` 484+, `amendInvoice` 694–890, `applyPayment` 896–959, `recordPayment` 961–970,
`recordClientPayment` 976–1011, `listClientPayments` 1016–1023, `createSalesReturn` 1029–1155,
`getClientCredit` 1281–1288), `server/src/middleware/audit.ts` (`createAuditEntry`), and
`server/src/shared/permissionCatalog.ts` (current catalog, reproduced in §11).

---

## 4. Existing lifecycle / state model

### 4.1 Client
No formal status machine. `isActive: Boolean @default(true)` exists on the model and is **already**
one of the fields `updateClient`'s whitelist (`CLIENT_WRITABLE_KEYS`, `orders.service.ts:183-187`)
accepts — so a "deactivate" is *mechanically* already reachable today via a plain `PATCH
/orders/clients/:id { isActive: false }`, with **no dedicated permission, no dependency check, no
audit call, and no enforcement anywhere that an inactive client can't still be invoiced** (`
createInvoice` only checks `client.companyId`, never `client.isActive` — confirmed at
`sales.service.ts:280-283`). `listClients` filters `isActive: true` (`orders.service.ts:167`), so
today "deactivate" only ever means "stop showing up in the client picker" — it has no protective
effect at all. `currentBalance` is excluded from the writable set by design (comment at
`orders.service.ts:189`) — the one field genuinely protected from ad-hoc edit today.

### 4.2 SalesInvoice
`status` is a free-text `String @default("DRAFT")` (not a Prisma enum — no migration needed to add
a new recognized value). Values actually produced by code: `DRAFT` (the Prisma-level default;
`createInvoice`'s `create` call never sets `status` explicitly, so an invoice with **no** payment
applied in the same transaction is left at `DRAFT` indefinitely — there is no separate "issue"
transition), `PARTIALLY_PAID`/`PAID` (set by `applyPayment`, `sales.service.ts:934`, and
re-derived by `amendInvoice`, `:833`). **No `VOID`/`CANCELLED` value exists anywhere in code today.**
`amendInvoice` (AM) is the one mutation path — transactional, count-checked stock flips, real
before/after snapshot audit (`sales.service.ts:724-734`, `888`), correctly locks lines already
covered by a `SalesReturn` (`:756-765`) and locks the customer once a payment or return exists
(`:749-751`). This is the reference implementation this whole document leans on.

### 4.3 InvoiceItem
Owned entirely by `SalesInvoice` — no independent lifecycle, no independent permission. `onDelete:
Cascade` from `SalesInvoice` (`schema.prisma:2381`) — i.e. **a hard delete of the parent invoice
silently deletes every line with it**, with nothing else to stop it at the DB level once other FKs
allow it (see §6).

### 4.4 TaxInvoice
1:1 with `SalesInvoice`, INR-taxable sales only. No independent lifecycle; no `onDelete` override on
its `invoiceId` FK (`schema.prisma:2619`) → Postgres default `NO ACTION`, i.e. **a hard delete of a
taxed `SalesInvoice` is blocked at the database level by this row alone**, before any application
check ever runs.

### 4.5 InvoicePayment
No status field at all. A row is created once (`applyPayment`/`recordClientPayment`) and never
updated or deleted anywhere in the codebase. `invoiceId` is nullable (F2 standalone/on-account
payments); `clientId` is always present. **Nothing on the row distinguishes an ordinary cash/bank
receipt from a credit-settlement receipt except its own `mode` value** — `applyPayment`'s
`opts.fromCredit` flag is a function parameter, never persisted, but it is reliably reconstructable:
every call site that passes `fromCredit: true` also passes `mode` equal to `PAYMENT_MODE_OLD_GOLD` or
`PAYMENT_MODE_STORE_CREDIT` (`sales.service.ts:449-451, 462`), i.e. **`CREDIT_SETTLEMENT_MODES.
includes(payment.mode)` is already an exact, existing test for "this row moved no cash and posted no
journal."**

### 4.6 SalesReturn / SalesReturnItem
No status field, no update path, no delete path anywhere. By design this **is** the correction/
reversal primitive for a sale (validate SOLD → flip IN_STOCK → reverse ledger → credit client), not
something that itself needs correcting in the ordinary case — D2 (CLAUDE.md) proved this works
identically whether the original sale came from `createInvoice` or `convertMemoToInvoice`.

---

## 5. Existing mutation paths (routes + internal-only paths)

| Path | Function | Permission (today) | Notes |
|---|---|---|---|
| `GET /orders/clients` | `listClients` | `client:view` | isActive-filtered |
| `POST /orders/clients` | `createClient` | `client:create` | |
| `PATCH /orders/clients/:id` | `updateClient` | `client:edit` | **includes `isActive` today, unaudited** |
| `POST /sales/invoices` | `createInvoice` | `invoice:create` | tag flip, journal, TaxInvoice, optional inline payments |
| `PUT /sales/invoices/:id` | `amendInvoice` | `invoice:edit` | reference AM implementation |
| — (no route) | — | — | **no void/cancel/delete path exists for `SalesInvoice`** |
| `POST /invoices/:id/payment` | `recordPayment` → `applyPayment` | `payment:create` | |
| `POST /sales/clients/:clientId/payments` | `recordClientPayment` | `payment:create` | standalone/on-account |
| (internal, no route) | `applyPayment` called from `createInvoice`'s bill-and-collect | rides `invoice:create` | same math as `recordPayment`, by design (comment at `:892-895`) |
| — (no route) | — | — | **no edit/delete/reverse path exists for `InvoicePayment`** |
| `POST /sales/returns` | `createSalesReturn` | `return:create` | |
| — (no route) | — | — | **no edit/delete/reverse path exists for `SalesReturn` — intentional, it already is one** |
| `GET /sales/clients/:clientId/credit` | `getClientCredit` | `invoice:create` (flagged ambiguous by J2 §5, unresolved) | reads `Client.currentBalance` only |

**Alternate/internal paths specifically checked, per the brief's instruction not to assume the route
is the only mutation path:** `tx.client.update(...)` appears at 9 call sites inside
`sales.service.ts` (`createInvoice`, `amendInvoice` ×3, `applyPayment`, `recordClientPayment`,
`createSalesReturn`, `createOldGoldExchange`, `convertMemoToInvoice`) — J2's review (§2 of that
document) individually verified every one only ever moves `currentBalance` via `increment`/
`decrement`, never an arbitrary field; re-confirmed here, unchanged. No bulk-import, no platform-
level CRUD, no second router mount for any of the four models (confirmed by the same `app.ts`
mount-list method J2 used).

---

## 6. Dependency matrix

Built from the actual Prisma relations (not assumed) — see the `onDelete` grep in this session's
research: every FK into these four models is `Restrict` **or** the Postgres default `NO ACTION`
(functionally identical to Restrict for hard-delete purposes) **except** `InvoiceItem.invoiceId`,
which is `Cascade`.

| Entity | Referenced by | FK behavior | Practical consequence for hard delete |
|---|---|---|---|
| `Client` | `SalesInvoice.clientId`, `SalesReturn.clientId`, `InvoicePayment.clientId`, `OldGoldExchange.clientId`, `MemoOut.clientId`, `RepairJob.clientId`, `JewelryTag.manufacturerId`, `SalesOrder.clientId` (dormant) | all default (blocking) | **Hard delete only possible for a client with zero rows in all eight relations, ever.** Any transaction history blocks it at the DB layer alone. |
| `SalesInvoice` | `InvoiceItem.invoiceId` | **Cascade** | A raw hard delete would **silently wipe every line item** with no trace beyond an audit row (if one exists) |
| `SalesInvoice` | `TaxInvoice.invoiceId`, `SalesReturn.invoiceId`, `ExportDocument.invoiceId`, `TagEstimate.invoiceId` (billed-here) | default (blocking) | Any taxed (INR) invoice already has a `TaxInvoice` row created in the **same transaction** as the invoice itself → **a hard delete of any real INR invoice is blocked from the instant it's created**, not just later |
| `SalesInvoice` | `InvoicePayment.invoiceId`, `RepairJob.invoiceId` | **Restrict** | Blocked once any payment exists or it's a repair bill |
| `InvoicePayment` | *(nothing references it)* | n/a | Leaf record — no dependent rows to worry about, but see §9 for why deletion is still wrong |
| `SalesReturn` | `SalesReturnItem.returnId` | **Cascade** (child, by design — see §4.6) | Correct as-is; the item has no independent existence |
| `SalesReturnItem` | *(nothing references it)* | n/a | Leaf |

**Conclusion carried into §9's recommendations:** `SalesInvoice` is **already, by construction, not
safely hard-deletable the moment it becomes a real taxed sale** — the schema itself enforces this.
The only invoices a raw hard delete could even technically reach (non-INR, or a fully-discounted
zero-tax INR sale, with zero payments/returns/repair links) still have the `InvoiceItem` Cascade
problem (silent line-item loss) and would still destroy the `JournalEntry`/`JournalLine` rows
`postAutoJournalEntry` created in the same transaction (those have no back-reference from
`SalesInvoice`, so nothing stops the orphaning, but nothing reverses them either — the ledger would
be left permanently unbalanced). **This is the core finding motivating §9's "Void, never hard
delete" recommendation** — even the narrowest theoretically-reachable case is still unsafe.

---

## 7. Financial impact analysis

| Entity | What moves money | Reversal already exists? |
|---|---|---|
| `SalesInvoice` create | Dr AR / Cr Revenue+GST+RoundOff, Dr COGS / Cr Inventory (`:406-420`); `client.currentBalance` debited | `amendInvoice` (partial, line-level); `createSalesReturn` (line-level, only for SOLD tagged lines) — **no whole-invoice reversal** |
| `SalesInvoice` amend | One compounded adjustment entry for the delta (`:862-875`); `client.currentBalance` adjusted by delta | is itself the correction mechanism |
| `InvoicePayment` (cash-mode) | Dr Cash/Bank / Cr AR (`:943-950`); `client.currentBalance` credited (decremented) | **none** |
| `InvoicePayment` (credit-mode: `OLD_GOLD`/`STORE_CREDIT`) | **No journal, no `client.currentBalance` change** — the balance move already happened when the underlying `OldGoldExchange`/return credit was booked (`applyPayment`'s `opts.fromCredit` branch, `:938-956`) | **none, and reversing this row independently would be a bug — see §9.3** |
| `SalesReturn` create | Exact reversal of the sale's line-level entry: Dr Revenue+GST / Cr AR, Dr Inventory / Cr COGS (`:1130-1142`); `client.currentBalance` credited | is itself the reversal |

---

## 8. Stock impact analysis

| Entity | Tag status effect | Guard pattern |
|---|---|---|
| `SalesInvoice` create | `IN_STOCK` → `SOLD`, count-checked `updateMany` (`:320-326`) | Guarded (not blind) |
| `SalesInvoice` amend | Added lines `IN_STOCK`→`SOLD`, removed lines `SOLD`→`IN_STOCK`, both count-checked (`:780-789`); also reopens any `TagEstimate` the removed tag was billed against | Guarded |
| `InvoicePayment` (any mode) | **None** — a payment never touches `JewelryTag` | n/a |
| `SalesReturn` create | `SOLD` → `IN_STOCK`, count-checked (`:1095-1101`) | Guarded |

No stock-impacting mutation in this scope is a blind/unconditional `updateMany` — unlike the two
documented pre-existing exceptions elsewhere in the codebase (`convertMemoToInvoice`'s tag flip,
`returnMemoItems`' tag flip; both out of this document's four-entity scope, both already flagged in
CLAUDE.md §8 / J1 §1).

---

## 9. Proposed administrative action per entity

### 9.1 Client → **Deactivate/Reactivate (primary) + narrow Administrative Hard Delete (secondary)**

- **Deactivate/Reactivate** is the everyday operation. It already exists mechanically (the
  `isActive` field) but today is unaudited, ungated by its own permission, and — critically —
  **toothless**: nothing stops an inactive client from being invoiced, memo'd, or paid tomorrow.
  Proposed fix (design only): split it out of the general `client:edit` whitelist into its own
  action (own permission, own audit action `DEACTIVATE`/`REACTIVATE`), and — this is the one place
  this document proposes new *business-logic* behavior, not just a permission split — have
  `createInvoice`/`createMemoOut`/`recordClientPayment` reject an inactive client the same way they
  already reject a wrong-company one. No dependency check is needed to deactivate (it's reversible
  and, once enforced, protective rather than destructive) — full history stays visible.
- **Hard delete** is real but narrow: safe **only** for a client with zero rows across all eight
  relations in §6 (never invoiced, never memo'd, never paid, never returned against, never an
  old-gold counterparty, never a repair customer, never used as a `JewelryTag.manufacturerId`,
  never a dormant `SalesOrder` party). This is exactly the "duplicate/junk client created by
  mistake, never actually transacted" case CLAUDE.md §6.4 anticipates. Must be an explicit,
  separately-permissioned, reason-required, audited operation (§6.4 item 5 — Administrative
  force-delete) — never the default "Delete" button's behavior, which should be Deactivate.
- **What must never be allowed:** editing or deleting `currentBalance` directly (already correctly
  excluded from `CLIENT_WRITABLE_KEYS` — no change proposed); hard-deleting a client with any
  transaction history, ever, under any permission including SUPER_ADMIN's `*` (the FK layer already
  guarantees this at the DB level even if application code had a bug — defense in depth, not
  something J3 needs to add).

### 9.2 SalesInvoice → **Void (new) — never Hard Delete**

Per §6's finding, a hard delete is unsafe even in its narrowest theoretically-reachable case (orphans
`JournalEntry`/`JournalLine`, and Cascade-wipes `InvoiceItem` with no recovery). The correct
capability for "this invoice should never have existed as a sale" is a **Void**: a full,
whole-invoice reversal that reuses the exact mechanics `createSalesReturn` already proves safe,
applied to every line at once, plus closing the header:

- Eligibility: **zero `InvoicePayment` rows and zero `SalesReturn` rows** against it (mirrors
  `amendInvoice`'s existing "customer locked once paid/returned" rule at `:749-751` — if money has
  moved or a partial return already happened, the correct tool is a return for what's left, not a
  void of the whole thing).
- Effect (one transaction): every tagged line's tag flips `SOLD`→`IN_STOCK` (count-checked, same
  guard as `createSalesReturn`); any `TagEstimate` billed to this invoice reopens to `SENT`
  (`invoiceId: null`) exactly as `amendInvoice` already does for a removed line (`:788`); the full
  original compound journal entry is reversed line-for-line (same shape as `createSalesReturn`'s
  reversal, scaled to 100% instead of per-return-line); `client.currentBalance` is decremented by
  the full `totalAmount`; `SalesInvoice.status` is set to `'VOID'` (a new but non-breaking string
  value — `status` is not a Prisma enum); the row and its `InvoiceItem`/`TaxInvoice` children are
  **never deleted**, only marked and left in place for the audit trail and for GST-return continuity
  (an invoice number that simply vanishes looks worse under audit than one explicitly marked void).
- What must never be allowed: voiding an invoice with any payment or return already against it
  (use amend/return instead); a second void of an already-`VOID` invoice; any further amend/payment/
  return against a `VOID` invoice (all three existing functions need a `status !== 'VOID'` guard
  added when this is implemented).
- **Explicitly out of scope for this proposal:** GST e-invoice IRN cancellation is its own statutory
  workflow with its own time window and portal call — marking `SalesInvoice.status = 'VOID'` in this
  database does **not** cancel an already-generated e-invoice with the GST authority. Flagged as a
  compliance follow-up, not solved here (same posture as the already-documented I3 GST-credit-note
  gap on returns).

### 9.3 InvoicePayment → **Reverse (new, cash/bank modes only) — never Edit, never Delete**

The payment row itself must stay immutable (it's the record of money that genuinely moved, or of a
credit application that genuinely happened) — a correction is a **compensating reversal**, not an
edit or delete, matching `SalesReturn`'s own philosophy.

- **Cash/bank-mode payments** (`mode` not in `CREDIT_SETTLEMENT_MODES`): reversible. Effect: reopen
  the invoice (`paidAmount`/`balanceDue`/`status` recomputed as if this payment never applied —
  exact inverse of `applyPayment`'s math); re-increment `client.currentBalance` by the reversed
  amount; post the exact inverse journal (Dr AR / Cr Cash-or-Bank); mark the original row reversed
  (new fields — see §18) rather than deleting it.
- **Credit-mode payments** (`mode` in `CREDIT_SETTLEMENT_MODES`, i.e. `OLD_GOLD`/`STORE_CREDIT`)
  → **must not be independently reversible.** Reasoning, spelled out because it's the one non-obvious
  call in this document: reversing this row in isolation would reopen the invoice's balance (as if
  the bill were unpaid again) while doing nothing to restore the credit that was consumed to settle
  it — the customer's old gold is already melted into the vault, or their store credit was already
  spent, by a *different* transaction (`OldGoldExchange`, or the original `SalesReturn`) that this
  reversal cannot see or undo. That would leave the books claiming the customer both owes for an
  unpaid bill *and* has no credit to show for the exchange that supposedly paid it — a real,
  silent double-count. The correct fix is symmetric to J1's own finding on `OldGoldExchange`
  (§2 of that document: "RV — capability missing entirely... clearest §6.8 gap found") — **a
  credit-settled `InvoicePayment` becomes reversible only once, and together with, a reversal
  capability for the exchange/return that generated the credit it drew on.** Until that exists,
  `payment:reverse` must categorically refuse any row whose `mode` is in `CREDIT_SETTLEMENT_MODES`.
  This is a **hard prerequisite dependency**, not a style preference — see §21.
- **Standalone (F2, `invoiceId: null`) payments**: reversible the same as a cash/bank invoice-scoped
  payment, just with no invoice to reopen — only the client balance and journal reverse.
- What must never be allowed: reversing an already-reversed payment twice; reversing a credit-mode
  payment under any permission (including SUPER_ADMIN's `*`) until the prerequisite above is closed
  — this is a business-rule guard the code must enforce regardless of who's asking, not a permission
  gap to paper over.

### 9.4 SalesReturn → **Protected / append-only. No new mutation capability proposed.**

Confirms J1's own classification. A return already *is* the correction primitive for a sale; adding
an "undo a return" capability on top would need to answer questions this document does not think are
worth building machinery for yet: has the returned tag since been resold, transferred to another
branch, or hallmarked? A real but rare "the return itself was a mistake" case exists, but the safest
available remedy today is already sufficient and low-risk: sell the item again through the normal
`createInvoice` path, which nets out correctly with no new capability, no new risk surface, and no
schema change. **Recommendation: do not build return-reversal in this pass.** Flagged as an explicit
open question for the business in §21, not decided here either way beyond "don't build it yet."

---

## 10. Actions that must NOT be allowed (consolidated)

- Editing `Client.currentBalance` directly, by anyone, ever (already enforced; carry forward).
- Hard-deleting a `Client` with any row in any of the eight dependent relations (§6), by anyone
  including SUPER_ADMIN — the FK layer already guarantees this; application code must not attempt to
  work around it (e.g. by nulling FKs first).
- Hard-deleting a `SalesInvoice` under any circumstance (§6, §9.2) — Void is the only administrative
  removal path, full stop.
- Amending, paying, or returning against a `VOID` invoice.
- Editing or hard-deleting an `InvoicePayment` row (§9.3) — Reverse only, and only for cash/bank
  modes until the `OldGoldExchange`/return-credit reversal prerequisite exists.
- Reversing an already-reversed `InvoicePayment`.
- Any mutation of `SalesReturn`/`SalesReturnItem` at all (§9.4) — it is the reversal primitive, not
  something with its own reversal, at least for this pass.
- Any of the above bypassing tenant/company scoping, RLS, or the immutable-audit rule — no exception
  is proposed anywhere in this document for SUPER_ADMIN to cross a company boundary or touch
  `AuditLog`.

---

## 11. Proposed permission matrix

Current catalog (`permissionCatalog.ts:109-117`, "Sales & Export" group) has exactly: `client:view`/
`client:create`/`client:edit`, `sales:view`/`sales:create`/`memo:manage`, `invoice:create`/
`invoice:edit`, `payment:create`, `return:create`. **Nothing below has been added to the catalog —
this is the proposal the human reviewer is being asked to approve or amend.**

| Entity | Proposed permission | New? | Rationale |
|---|---|---|---|
| Client | `client:deactivate` | **new** | Distinct from `client:edit` — a lifecycle action with its own consequence (blocks future transactions once enforced per §9.1), deserves its own grant, same reasoning as `tag:retire` being split from `tag:create` per J1 §1.2's recommendation for `JewelryTag` |
| Client | `client:delete` | **new** | Materially higher-risk than deactivate (irreversible); a delegate trusted to deactivate duplicates should not automatically be trusted to permanently erase a record |
| SalesInvoice | `invoice:void` | **new** | Distinct from `invoice:edit` (amend) — void is a whole-invoice reversal with different eligibility rules and a bigger blast radius than a line-level amend |
| InvoicePayment | `payment:reverse` | **new** | Mirrors `return:create` being distinct from `invoice:create` — reversing money already received is a materially different trust level than recording new money |
| SalesReturn | *(none proposed)* | — | No new mutation capability proposed (§9.4) |

**Naming convention check against CLAUDE.md §6.2's own examples** (`client:delete`, `invoice:void`,
`payment:reverse`, `return:reverse`) — this proposal matches three of the four examples exactly and
deliberately omits the fourth (`return:reverse`, §9.4). `client:deactivate` is an addition beyond
CLAUDE.md's own example list, justified above.

**SUPER_ADMIN**: needs no code change to receive any of these — `'*'` already satisfies any new
permission string exactly as it does every existing one (`rbac.ts`'s `requirePermission`, unchanged
by J2, re-confirmed in that review §8). Only the catalog + delegated-role grants are new work, not
the wildcard evaluation.

---

## 12. SUPER_ADMIN behavior

Unchanged from the standing rule (CLAUDE.md §6.1/§11 "Administrative authority remains
tenant-scoped") — re-stated per-action because the brief asks where even SUPER_ADMIN should be
limited to a controlled reversal rather than a direct delete:

| Action | SUPER_ADMIN may do it directly? | Where SUPER_ADMIN is still limited to reversal, not deletion |
|---|---|---|
| Client deactivate/reactivate | Yes | — |
| Client hard delete | Yes, but **only** when the zero-dependency check passes — the check is a business-integrity rule, not a permission gate, so SUPER_ADMIN does not bypass it | Any client with history: SUPER_ADMIN can only Deactivate, never force-erase transaction history |
| Invoice void | Yes, within the eligibility rule (no payment/return yet) | An invoice with a payment/return already against it: SUPER_ADMIN can only Amend (existing) or let a return cover what's left — no whole-invoice void |
| Payment reverse (cash/bank) | Yes | — |
| Payment reverse (credit-mode) | **No — blocked for everyone, including SUPER_ADMIN**, until the exchange/return-credit reversal prerequisite (§9.3, §21) exists | This is the one place this document proposes SUPER_ADMIN cannot act at all yet, by design |
| Any SalesReturn mutation | Not proposed for anyone | — |
| Cross-company access | Never, for anyone, under any of the above | Structural (RLS + ownership checks), not a policy choice |

---

## 13. Delegated-role behavior

No specific role assignment is proposed here (that's a J3-implementation-time decision, informed by
who in a real company should hold each string) — but the shape, following the J2 precedent exactly:
add the new strings to the catalog, and **add them alongside, never in place of**, whatever a role
already holds, so no existing user's effective access silently changes the moment these ship. Given
the risk gradient, a reasonable default posture (for the human reviewer to confirm, not something
this document treats as decided): `client:deactivate` and `invoice:void` are plausible for the same
roles that already hold `client:edit`/`invoice:edit` (`SALES_MANAGER`, `ACCOUNTANT`,
`PRODUCTION_MANAGER` per the current Starter Package); `client:delete` and `payment:reverse` are
higher-trust and plausibly `ACCOUNTANT`-and-above only, given their financial-history implications —
but this is exactly the kind of judgment call the brief says must not be blindly invented; flagged
for explicit sign-off before J3 implementation assigns any role a new string.

---

## 14. Audit requirements

**Systemic gap to close as part of implementing any of this (J1 §1.2/§1.3, confirmed still true by
this session's direct reads of `applyPayment`/`createSalesReturn`/`createClient`/`updateClient` —
none of the four currently call `createAuditEntry` with anything but `undefined`/`undefined` for
old/new values, and `applyPayment`/`recordClientPayment` don't call it at all):** every new J3
mutation must supply a **real** before/after diff, following the one pattern in this codebase that
already does it correctly — `amendInvoice`'s `snapshot()` helper (`sales.service.ts:724-734`,
consumed at `:888`). Recommend that helper (or its shape) become the template every new J3 audit
call copies, not a fresh convention per entity.

Per action, minimum required audit payload (all via `createAuditEntry`, all company-scoped per its
existing contract):

| Action | `tableName`/`recordId` | `action` string | Required `oldValues` | Required `newValues` |
|---|---|---|---|---|
| Client deactivate/reactivate | `clients` / client id | `DEACTIVATE` / `REACTIVATE` | `{ isActive: true }` | `{ isActive: false, reason }` |
| Client hard delete | `clients` / client id | `FORCE_DELETE` | full row snapshot (it won't exist to look up afterward) | `null` |
| Invoice void | `sales_invoices` / invoice id | `VOID` | full snapshot incl. items (same shape as `amendInvoice`'s `snapshot()`) | `{ status: 'VOID', reason }` + reversal totals |
| Payment reverse | `invoice_payments` / payment id | `REVERSE` | full payment row | `{ reversedAt, reversedBy, reason }` + resulting invoice balance |

Every row must carry `companyId`, acting `userId`, timestamp (all already structural to
`createAuditEntry`), plus the action-specific `reason` folded into `newValues` (matching
`amendInvoice`'s existing convention of appending `reason` onto the `after` object, `:888` —
reuse that convention rather than inventing a parallel one).

`AuditLog` itself is not proposed to change — it is already DB-`REVOKE`d for `UPDATE`/`DELETE`
(`db-secure.sql`, confirmed in COMPANY_ISOLATION_AUDIT.md §3.4) and this document does not propose
any exception to that for any of these four entities.

---

## 15. Reason/confirmation requirements

| Action | Reason required? | Confirmation UI (documented for J4, not built) |
|---|---|---|
| Client deactivate | Recommended, not mandatory (low blast radius, reversible) | Simple confirm dialog |
| Client reactivate | No | None needed |
| Client hard delete | **Mandatory** | Confirm dialog naming the exact record; must show the zero-dependency proof, not just a generic "are you sure" |
| Invoice void | **Mandatory** | Confirm dialog must show what will be reversed (line count, tags returning to stock, journal reversal amount) before submit |
| Payment reverse | **Mandatory** | Confirm dialog must show the invoice's resulting new balance/status post-reversal |

---

## 16. Transaction requirements

All four proposed new mutations follow the same sequence, matching CLAUDE.md §6.11's stated
framework exactly (and matching what `amendInvoice`/`createSalesReturn` already do in practice):

```
authenticate
  → resolve company context (ctx.companyId from verified JWT)
  → permission check (requirePermission('<new string>'))
  → ownership check (assertOwnedByCompany on every request-supplied id — the invoice/payment/client
     itself, plus any id embedded in the request body)
  → lifecycle/dependency validation (entity-specific — §9's eligibility rules)
  → mandatory reason captured (where §15 requires it)
  → tenantTransaction(ctx.companyId, async (tx) => { ...the actual mutation, count-checked where a
     status flip is involved, exactly like createInvoice/createSalesReturn's existing pattern... })
  → createAuditEntry with real before/after (§14)
  → response
```

Any failure at any step rolls the whole transaction back — no partial reversal (e.g. tags flipped
back to stock but the journal not reversed) is acceptable, matching the existing all-or-nothing
guarantee `createInvoice`/`amendInvoice`/`createSalesReturn` already provide today (re-confirmed by
the existing rollback tests those three already have, per CLAUDE.md's Gap #2/D1/I8 writeups).

---

## 17. Cross-company / RLS requirements

No new class of risk beyond what the existing four create/amend/return functions already handle
correctly (re-verified live in §5/§6 of this document, and independently by
`COMPANY_ISOLATION_AUDIT.md`). Every new function must, at minimum:
- Resolve the target row by id **and** re-check `row.companyId === ctx.companyId` before mutating —
  the exact pattern already used by `createSalesReturn` (`:1046`) and `amendInvoice` (via
  `assertOwnedByCompany`, `:703`).
- Never accept a client-supplied `companyId` (already blocked app-wide by
  `rejectClientTenantSelectors` — no change needed, just don't introduce a new field that
  circumvents it).
- Run inside `tenantTransaction`/`tenantQuery` — never a bare `prisma.<model>` call (guarded partly
  by `npm run audit:tenant`, but per CLAUDE.md §11's documented blind spot, that tool cannot see
  tagged-template raw SQL or `platformPrisma` — none of the four proposed mutations need either, and
  none should ever introduce them).
- Be added to `npm run test:rls`'s real-role-split suite, not just the single-role fast suite.

---

## 18. Existing-data / migration implications (documented, none created)

| Entity | Schema change needed | Backfill needed | Notes |
|---|---|---|---|
| `Client` | None — `isActive` already exists | None | Splitting the permission is a code-only change |
| `SalesInvoice` | New nullable columns: `voidedAt DateTime?`, `voidedById String?` (or reuse `AuditLog` alone and skip these — see below), `voidReason String?` (or fold into `notes`/audit only) | None (all nullable, default null on existing rows) | `status = 'VOID'` itself needs **no** migration since `status` is already a free-text `String`, not an enum — this is the cheapest part of the whole proposal |
| `InvoicePayment` | New nullable columns: `reversedAt DateTime?`, `reversedById String?`, `reversalReason String?`; **and/or** a self-referential pair (`reversalOfPaymentId String?` on a compensating row pointing back at the original) if the team prefers "reversal = a new negative-amount row" over "reversal = a flag on the original row" — **this exact shape (flag-on-original vs. new-compensating-row) is the one open schema-design question this document is flagging for a decision, not resolving unilaterally** (see §21) | None | Either shape is a small, additive, nullable-column migration — no existing row needs backfilling beyond defaulting to null/false |
| `SalesReturn` | None proposed | None | No new capability, no schema need |
| `AuditLog` | None | None | New `action` string values (`DEACTIVATE`, `REACTIVATE`, `FORCE_DELETE`, `VOID`, `REVERSE`) need no migration — `action` is already free-text |

No existing row in any of these four tables needs to change value at migration time — every proposed
column is additive and nullable, consistent with every prior migration in this codebase's history
(the "seed it, don't reference it" and "nullable-first" conventions already established by
`InvoicePayment.invoiceId`/F2, `HallmarkingItem.jobCardId`/G2, etc.).

---

## 19. Frontend implications (documented for J4, not built)

- **Clients page**: currently has no Edit/Delete UI at all (J1 finding, re-confirmed unchanged by
  J2's review). J4 needs: an Edit action (already possible via the existing `client:edit`-gated
  endpoint — just missing a button), a Deactivate/Reactivate toggle gated on `client:deactivate`
  with a confirm dialog, and a Delete action gated on `client:delete` that is disabled (not just
  hidden) with an explanatory tooltip when the record has any transaction history — mirroring
  CLAUDE.md §6.10's "never rely on hiding a button as the security mechanism," the server remains
  the authority even though the button should proactively reflect the dependency state.
- **Sales Invoices page** (`SalesInvoices.tsx`): already has `canEdit = hasPermission('invoice:edit')`
  gating the existing Edit action (J2 §6). J4 needs a parallel Void action gated on `invoice:void`,
  shown only while the eligibility rule (§9.2 — zero payments, zero returns) holds, with the mandatory
  reason + consequence-preview dialog from §15.
- **Payment recording UI** (`RecordPaymentForm` inside `SalesInvoices.tsx`, and the client-ledger
  payment list): needs a Reverse action gated on `payment:reverse`, visible only for cash/bank-mode
  rows (never for `OLD_GOLD`/`STORE_CREDIT` rows, per §9.3 — the button itself should not render for
  those, not merely 403 when clicked, since this is a permanent business-rule restriction, not a
  per-user permission gap).
- **SalesReturn UI**: no change proposed — remains create-only, matching §9.4.
- Every new action must independently re-check permission server-side (already the framework
  convention) — the frontend gating above is UX, not the security boundary.

---

## 20. Test matrix (per proposed action, the 12 categories the brief specifies)

| # | Category | Applies to |
|---|---|---|
| 1 | SUPER_ADMIN same-company success | All 4 new actions |
| 2 | Delegated authorized role success | All 4 (once role grants are decided per §13) |
| 3 | Unauthorized user → 403 | All 4 |
| 4 | Cross-company target → 404/denied | All 4 — forged id from Company B must not be reachable |
| 5 | Dependency blocks unsafe mutation | Client hard delete (any of 8 relations non-empty); Invoice void (payment/return exists); Payment reverse (already reversed, or credit-mode) |
| 6 | Financial/stock integrity | Invoice void (journal reverses to zero net, tags return to IN_STOCK, estimate reopens); Payment reverse (client balance and invoice balanceDue return to pre-payment state) |
| 7 | Audit entry created | All 4, with real before/after per §14 |
| 8 | Audit contains required before/after | All 4 |
| 9 | Audit cannot be modified/deleted | Structural — already true (DB `REVOKE`), re-confirm no new code path attempts it |
| 10 | Transaction rollback on failure | All 4 — e.g. inject a failure after the tag-flip step and confirm the journal/balance changes did not partially apply |
| 11 | RLS protection | All 4, run under `npm run test:rls` (real role split), not just the fast single-role suite |
| 12 | Existing lifecycle/status restrictions | Invoice void on an already-`VOID` invoice rejected; Payment reverse on an already-reversed payment rejected; Client delete on a client with history rejected |

---

## 21. Risks / open questions (for human decision before implementation)

1. **`InvoicePayment` reversal schema shape** (§18): flag-on-original-row vs. new-compensating-row.
   This document leans toward flag-on-original (simpler queries, matches how `SalesInvoice.status`
   already works) but does not treat this as decided.
2. **Credit-mode payment reversal is blocked, not solved** (§9.3): closing it properly requires a
   `OldGoldExchange`/return-credit reversal capability that is **out of this document's four-entity
   scope** (J1 already separately flagged `OldGoldExchange` reversal as its own gap). Recommend
   treating that as a J3 follow-up phase, sequenced *before* anyone asks to reverse a credit-settled
   payment in production — otherwise the permission will exist with no safe way to use it on a whole
   class of real payments.
3. **`Client.isActive` enforcement change** (§9.1) is the one place this document proposes new
   business logic beyond permission/audit plumbing — worth explicit sign-off since it changes
   `createInvoice`/`createMemoOut`/`recordClientPayment`'s behavior for existing inactive clients (if
   any already exist in a live company from ad-hoc use of the existing unaudited toggle).
4. **`SalesReturn` reversal ("un-return")** (§9.4): deliberately not proposed. Confirm the business
   agrees "sell it again" is an acceptable remedy for a mistaken return before considering this
   permanently out of scope.
5. **GST e-invoice IRN cancellation on Void** (§9.2): explicitly not solved here — flag for a
   separate compliance-focused pass, same posture as the already-open I3 gap.
6. **Role assignment for the new permissions** (§13) is a business judgment call, not a technical
   one — needs explicit sign-off, not an engineering default.
7. **`GET /sales/clients/:clientId/credit`'s permission ambiguity** (carried over from J2 §5,
   still unresolved) — unrelated to J3's mutation scope but sitting in the same code area; note it
   so it isn't lost, not proposing to fix it here.

---

## 22. Recommended implementation order

Not a commitment — proposed sequencing once the open questions in §21 are resolved:

1. **Audit-diff retrofit** (§14) for the existing four functions that already mutate these entities
   (`createClient`/`updateClient`, `createInvoice`, `applyPayment`/`recordClientPayment`,
   `createSalesReturn`) — additive, no behavior change, and every new J3 action inherits the pattern
   for free once it exists. (This is J1's own recommended sequencing, §4 item 3, re-affirmed here for
   this scope specifically.)
2. **Client deactivate/reactivate**, including the `isActive`-enforcement change (§21 item 3) —
   smallest blast radius, no schema migration, resolves the "toothless toggle" gap immediately.
3. **Invoice void** — highest-value gap (J1 ranked Sales & Client's delete-side gap as the top
   urgency item across the whole audit, §4 item 4 of that document) and the schema addition is
   trivial (§18).
4. **Client hard delete** — narrow, low-frequency, but completes the Client family.
5. **Payment reverse (cash/bank only)** — sequenced after Void so the reason/confirmation UI pattern
   is already established; ships with credit-mode reversal explicitly blocked per §9.3/§21 item 2.
6. **(Separate, later phase, not J3-for-these-four-entities)**: `OldGoldExchange`/return-credit
   reversal, unblocking credit-mode payment reversal.

---

## 23. Explicit J3 implementation prerequisites

Before any code is written for this scope:
- Human sign-off on §21's seven open questions, in particular items 1–3 (schema shape, the
  credit-mode block, and the `isActive`-enforcement behavior change).
- Confirmation of the exact permission strings in §11 (or approved alternatives) — this document
  proposes names, it does not add them to `permissionCatalog.ts`.
- Confirmation of role assignment (§13) — or an explicit decision to ship the permissions ungranted
  to any starter role initially (SUPER_ADMIN-only via `*` until assigned).
- Agreement that `SalesReturn` gets no new mutation capability in this phase (§9.4, §21 item 4).

Once those are confirmed, implementation should proceed **module-by-module per §22**, each stopping
for review before the next, per CLAUDE.md's own instruction not to implement Phase J as one
uncontrolled change — consistent with how J2's own first slice was deliberately scoped and reviewed
before J3 began.

---

## J3 DESIGN AUDIT: COMPLETE — READY FOR HUMAN REVIEW

This is a design proposal, not a verdict that implementation may begin. Per the brief: readiness of
the *repository* is not the gate — the semantics in §9, the permission matrix in §11, and the seven
open questions in §21 require explicit human approval before any J3 code is written.
