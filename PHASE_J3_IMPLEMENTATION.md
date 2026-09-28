# Phase J3 — Administrative Mutations: Implementation

> Implements the seven decisions finalized in `PHASE_J3_DECISIONS.md`, against the design proposed in
> `PHASE_J3_DESIGN_AUDIT.md`, for the four entity families J1/J2 scoped: `Client`, `SalesInvoice`,
> `InvoicePayment`, `SalesReturn`. J1 and J2 were frozen and not touched. No unrelated refactor, no
> dormant-manufacturing wiring, no generic `DELETE /anything/:id`.

---

## 1. Scope actually implemented

| # | Capability | Function | Permission | Status |
|---|---|---|---|---|
| J3.1 | Client deactivate / reactivate | `setClientActive()` (`orders.service.ts`) | `client:deactivate` | Done |
| J3.1 | Client permanent delete (zero-history only) | `deleteClient()` (`orders.service.ts`) | `client:delete` | Done |
| J3.1 | `isActive` enforcement on new transactions | `assertClientActive()` (`sales.service.ts`), wired into `createInvoice`/`createMemoOut`/`recordClientPayment` | n/a (business rule) | Done |
| J3.2 | Payment reversal — cash/bank/UPI/card | `reverseInvoicePayment()` (`sales.service.ts`) | `payment:reverse` | Done |
| J3.2 | Payment reversal — STORE_CREDIT | same function | `payment:reverse` | Done (no coupled reversal needed — see §4) |
| J3.2 | Payment reversal — OLD_GOLD (coupled `OldGoldExchange` reversal) | same function | `payment:reverse` | Done |
| J3.3 | Invoice Void | `voidInvoice()` (`sales.service.ts`) | `invoice:void` | Done |
| J3.4 | `/sales/clients/:id/credit` permission fix | — | `client:view` (was `invoice:create`) | Done |
| — | `SalesReturn` "un-return" | — | — | **Not built — Decision 4 confirmed out of scope** |

---

## 2. Human decisions, as finalized (`PHASE_J3_DECISIONS.md`)

1. **InvoicePayment reversal shape** → Option A (flag the original row: `reversedAt`/`reversedById`/
   `reversalReason`, never edit/delete).
2. **OLD_GOLD/STORE_CREDIT reversal** → build the complete chain, not just block it. See §4 for how
   this was actually done — the two modes turned out to need genuinely different treatment, not one
   uniform mechanism.
3. **Client `isActive` enforcement + permission split** → A1 (enforce) + B1 (split into
   `client:deactivate`, separate from `client:edit`).
4. **SalesReturn "un-return"** → Option A (build nothing; confirmed out of scope for this phase).
5. **SalesInvoice Void eligibility + GST** → A1 (strict: zero payments, zero returns) + B2 (block if
   `TaxInvoice.irn` is already set).
6. **Role assignment for the four new permissions** → Option B (ship SUPER_ADMIN-only; no starter
   role grants; no existing-company back-fill).
7. **`/clients/:id/credit` permission** → Option B (`client:view`).

None of these were re-litigated. Where the design audit's own recommendation differed from the final
decision (Decision 2 — the design audit had leaned toward "block credit-mode reversal," the decision
sheet approved building it), the decision sheet's choice is what shipped.

---

## 3. Schema (migration `20260928060525_j3_administrative_controls`)

All three additions are nullable, additive columns — no backfill, no existing row changes value,
consistent with every prior migration's "nullable-first" convention in this codebase.

```sql
ALTER TABLE "invoice_payments" ADD COLUMN "reversalReason" TEXT, ADD COLUMN "reversedAt" TIMESTAMP(3), ADD COLUMN "reversedById" TEXT;
ALTER TABLE "old_gold_exchanges" ADD COLUMN "reversalReason" TEXT, ADD COLUMN "reversedAt" TIMESTAMP(3), ADD COLUMN "reversedById" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN "voidReason" TEXT, ADD COLUMN "voidedAt" TIMESTAMP(3), ADD COLUMN "voidedById" TEXT;
-- + 3 FKs to users(id), ON DELETE SET NULL
```

`SalesInvoice.status = 'VOID'` itself needed **no** migration — `status` is a free-text `String`, not
a Prisma enum, same reasoning `PAID`/`PARTIALLY_PAID` never needed one either. Pure `ADD COLUMN`/
`ADD CONSTRAINT` DDL — no `UPDATE`/`INSERT` against existing rows, so no FORCE-RLS lifting was needed
(RLS policies govern DML, not DDL); applied directly as `trivo_owner` on both `sea_erp_test` and the
real-role-split `trivo_rlstest` cluster (see §7), followed by `npm run db:secure` on the latter per
the standing "after every deploy" rule (CLAUDE.md §12), even though table-level grants aren't
affected by a column add — matching documented practice rather than assuming it's unnecessary.

---

## 4. Design finding: OLD_GOLD and STORE_CREDIT needed genuinely different reversal treatment

This is the one place implementation diverged from a uniform "reverse it" mental model, so it's
recorded here rather than only in code comments.

Tracing `createInvoice`'s payments loop (`sales.service.ts`):

- `client.currentBalance` is incremented by the invoice's `totalAmount` **once**, before the payments
  loop runs.
- A **STORE_CREDIT** "payment" (`applyPayment(..., { fromCredit: true })`) never touches
  `currentBalance` or posts a journal — the credit it draws on was already reflected in
  `currentBalance` being negative *before* the invoice's own debit above, so the net figure is already
  correct the moment the invoice is created. The "payment" row only marks part of the bill paid.
- An **OLD_GOLD** "payment" is different: `bookOldGoldExchange()` runs *inside* the same payments
  loop and performs its **own**, separate movement — it credits `currentBalance`, posts its own
  journal (Dr Inventory / Cr AR), and adds real weight to `MetalStock` — before `applyPayment` marks
  the bill paid.

Consequence for reversal:

- Reversing a **STORE_CREDIT** payment only needs to reopen the invoice (`paidAmount`/`balanceDue`/
  `status`). There is no separate credit-source movement to undo — `currentBalance` is one pooled,
  fungible running balance, not a ledger of individually redeemable credit lots, so there is nothing
  to "double-spend" by reversing this row in isolation. **This is why Decision 4 (SalesReturn stays
  append-only) did not need to be revisited to satisfy Decision 2** — Decision 2's "reverse the
  underlying credit-source movement" requirement is vacuously satisfied for this mode: there is no
  movement specific to *this* payment to reverse, only the invoice's own paid/due state.
- Reversing an **OLD_GOLD** payment genuinely does need to reverse a paired movement — the exchange it
  booked — or the business would be left having extracted real metal value from the customer while
  also re-billing them in cash. `reverseInvoicePayment()` finds the exchange via
  `OldGoldExchange.exchangeNumber` (unique per company; stamped onto the payment's own `referenceNo`
  at booking time — an exact match, not a heuristic) and reverses it in the **same transaction**:
  `currentBalance` incremented back, the exchange's journal reversed (Dr AR / Cr Inventory), the
  `MetalStock` row zeroed (`availableWt: 0, isActive: false`), and the exchange itself flagged
  `reversedAt`/`reversedById`/`reversalReason` (same additive-columns shape as `InvoicePayment`).

**Refusal condition, not a blocker requiring a "STOP and report":** before reversing an OLD_GOLD
exchange, its `MetalStock.availableWt` is checked against `netWeight`. If they differ (or the stock
row is `isActive: false`), the reversal is refused with a 409, not silently skipped and not force-
completed. This codebase's only present-day consumer of Metal Vault stock that could cause this
divergence is the dormant-but-not-disabled production auto-reservation path
(`orders.service.ts:autoReserveMaterials`, triggered by creating a `SalesOrder` against a `Design`
with `BomItem`s of `materialType: 'METAL'`) — a real, reachable code path even though `SalesOrder`
itself is a manufacturing concept per CLAUDE.md §2. If that path already consumed this exact metal, a
reversal cannot conjure the weight back — refusing is correct, not a workaround. This was verified as
a real (if narrow) risk, not a hypothetical: a dedicated test
(`reverseInvoicePayment (J3.2) > refuses to reverse an OLD_GOLD settlement once its metal has been
reserved elsewhere`) directly reduces `MetalStock.availableWt` (simulating what
`autoReserveMaterials` would do) and confirms the reversal is refused and nothing partially applies.

No missing dependency was found that would have required stopping short — the "build the complete
reversal flow" instruction in Decision 2 was fully implementable once the two modes' actual mechanics
were traced individually rather than assumed to be symmetric.

---

## 5. Invoice Void — mechanics

`voidInvoice()` reuses `createSalesReturn`'s exact reversal shape, applied to the whole invoice at
once rather than per-line, inside one `tenantTransaction` with the same `SELECT ... FOR UPDATE` lock
`amendInvoice` takes on the invoice row (serialising concurrent void/amend/payment/return attempts on
the same invoice):

1. Eligibility (throws 409, invoice untouched, if any fail): not already `VOID`; zero
   `InvoicePayment` rows; zero `SalesReturn` rows; `TaxInvoice.irn` not set.
2. Every tagged line's `JewelryTag` flips `SOLD` → `IN_STOCK`, count-checked exactly like
   `createInvoice`'s own flip.
3. Any `TagEstimate` billed to a now-voided line reopens (`status: 'SENT', invoiceId: null`) — the
   exact mirror of `amendInvoice`'s removed-line handling.
4. One journal entry, the exact inverse of `createInvoice`'s own compound entry. `taxableAmount` is
   derived as `totalAmount - taxAmount - roundOff` (per `SalesInvoice.roundOff`'s own documented
   identity) rather than re-read from `TaxInvoice`, so the same formula works for a non-INR invoice
   too (which has no `TaxInvoice` row at all).
5. `client.currentBalance` decremented by the full `totalAmount`.
6. `SalesInvoice.status = 'VOID'`, `voidedAt`/`voidedById`/`voidReason` set. The row and its
   `InvoiceItem`/`TaxInvoice` children are never deleted — an invoice number that vanishes looks worse
   under a GST audit than one explicitly marked void, and GST-return continuity is preserved.
7. `amendInvoice`, `recordPayment` (→ `applyPayment`), and `createSalesReturn` were each given a
   `status !== 'VOID'` guard — the PHASE_J3_DESIGN_AUDIT.md §9.2 requirement ("amending, paying, or
   returning against a VOID invoice must never be allowed").

**Explicitly not solved (per Decision 5, same posture as the pre-existing I3 gap):** GST e-invoice IRN
cancellation with the tax authority. Blocking Void when `irn` is already set closes the specific risk
of this database saying `VOID` while a live e-invoice stands at the portal; it does not build the
cancellation integration itself.

**Known, accepted narrow gap not covered by Decision 5's eligibility rule:** an invoice created via
`billRepairJob()` (G1) carries a `RepairJob.invoiceId` back-reference. Voiding such an invoice is not
blocked (it has no tagged lines and no payment/return by construction at the point it would be
eligible), but the `RepairJob` row would keep pointing at a now-`VOID` invoice with no automatic
correction. Not addressed — outside the four-entity scope this phase inherited from J1/J2, and no
decision was asked for it.

---

## 6. Files touched

**Schema / migration**
- `server/prisma/schema.prisma` — `SalesInvoice.voidedAt/voidedById/voidReason`,
  `InvoicePayment.reversedAt/reversedById/reversalReason`,
  `OldGoldExchange.reversedAt/reversedById/reversalReason`, matching back-relations on `User`.
- `server/prisma/migrations/20260928060525_j3_administrative_controls/migration.sql`

**Server — services**
- `server/src/modules/orders/orders.service.ts` — `CLIENT_WRITABLE_KEYS` no longer includes
  `isActive`; new `setClientActive()`, `deleteClient()`.
- `server/src/modules/sales/sales.service.ts` — new `assertClientActive()` (wired into
  `createInvoice`, `createMemoOut`, `recordClientPayment`); new `voidInvoice()`,
  `reverseInvoicePayment()`; `status !== 'VOID'` guards added to `amendInvoice`, `recordPayment`,
  `createSalesReturn`.
- `server/src/modules/finance/finance.service.ts` — `getClientLedger`/`getDayBook`'s
  `InvoicePayment` queries now also filter `reversedAt: null`.

**Server — routes**
- `server/src/modules/orders/orders.router.ts` — `PATCH /clients/:id/deactivate`,
  `PATCH /clients/:id/reactivate` (`client:deactivate`), `DELETE /clients/:id` (`client:delete`).
- `server/src/modules/sales/sales.router.ts` — `POST /invoices/:id/void` (`invoice:void`),
  `POST /payments/:id/reverse` (`payment:reverse`); `/clients/:clientId/credit` regated to
  `client:view`.

**RBAC**
- `server/src/shared/permissionCatalog.ts` — added `client:deactivate`, `client:delete`,
  `invoice:void`, `payment:reverse` to the existing `client`/`invoice`/`payment` catalog rows; two
  new `ACTION_LABELS` entries. **`starterPackage/v1.ts` was deliberately not touched** — Decision 6/7.

**Tests (new)**
- `server/src/modules/orders/orders.service.test.ts` (new file) — `updateClient` isActive-immutability
  regression, `setClientActive`, `deleteClient`.
- `server/src/modules/sales/sales.service.test.ts` (appended) — `inactive client is rejected for a
  new sale/memo/payment`, `voidInvoice (J3.3)`, `reverseInvoicePayment (J3.2)`.
- `server/src/test/http.j3Administrative.test.ts` (new file) — the one thing the service-level
  suites above don't cover: `requirePermission(...)` actually gating each of the four new routes
  over real HTTP (granted → succeeds; missing → 403), plus the `/credit` permission fix.

**Documentation**
- `CLAUDE.md` — new J3 summary appended to §7's Phase J narrative.
- This file.

---

## 7. Verification

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` (server) | Clean |
| `npx tsc --noEmit` (server, includes tests) | Clean |
| `npx tsc --noEmit` (client) | Clean (no client changes made — J3 was server-only per the decision sheet's scope) |
| `npm run audit:tenant` | Clean: `scoped=0, raw=0, aliases=0` — identical to the J2 baseline |
| `npx vitest run` (full local suite, `sea_erp_test`) | **42 files, 774 passed, 5 skipped, 0 failed** — baseline was 40/741/5; +2 files/+33 tests, all new, none regressed |
| `npm run test:rls` (real role-split, `trivo_rlstest`) | **42 files, 778 passed, 1 skipped, 0 failed** — baseline was 40/745/1; same +33 |

New tests added this phase: 7 (`voidInvoice`) + 7 (`reverseInvoicePayment`) + 3 (inactive-client
enforcement) in `sales.service.test.ts`; 1 (`updateClient` regression) + 5 (`setClientActive`) + 5
(`deleteClient`) in the new `orders.service.test.ts`; 5 in the new `http.j3Administrative.test.ts` —
**33 new tests**, all passing individually before the final full-suite run above.

Migration `20260928060525_j3_administrative_controls` was applied to both `sea_erp_db` (dev),
`sea_erp_test`, and the real-role-split `trivo_rlstest` cluster (as `trivo_owner`), followed by
`npm run db:secure` on the latter.

---

## 8. Remaining, explicitly out of scope for this phase

- **GST e-invoice IRN cancellation** on Void — manual/outside-the-system, per Decision 5(b)/B2.
- **`SalesReturn` "un-return"** — confirmed not needed, per Decision 4. If ever revisited, note that
  reversing a credit-mode `InvoicePayment` does **not** require it (see §4) — only a true "the return
  itself was a mistake, restore the original SOLD tag" capability would.
- **Role assignment** for the four new permissions to any operational role — ships SUPER_ADMIN-only
  by design (Decision 6/7); a company's own SUPER_ADMIN delegates via the Role Editor when ready.
- **`RepairJob` back-reference on a voided invoice** — narrow, documented gap (§5), not decided or
  fixed here.
- **Frontend** (Edit/Deactivate/Delete/Void/Reverse buttons, confirmation dialogs, reason capture UI)
  — not part of this decision sheet's scope; J3 as approved was a backend-only slice. Flagged for
  whatever the next frontend pass is, same posture as J1/J2's own frontend-implications sections.

---

## J3 IMPLEMENTATION: COMPLETE — READY FOR HUMAN REVIEW
