# Phase J3.5 — Hardening Pass (fixes for the J3 Final Safety Audit findings)

> Fixes exactly the six findings from the J3 Final Safety Audit (chat-reported, not a saved file — see
> the audit report reproduced in §0 below for reference). No J1/J2/J3 decision was revisited; no
> feature, refactor, or RBAC redesign was added beyond what each finding required.

---

## 0. What the audit found (for reference)

1. A voided `SalesInvoice` still counted as a live receivable/sale in `getClientLedger`, `getDealerAging`,
   `/reports/aging-receivables`, `getSalesRegister`, `getGstSummary`, and `getDayBook` (found beyond the
   original five during this pass's broader search).
2. `billRepairJob()`'s idempotency guard checked only whether `RepairJob.invoiceId` was set, never
   whether the linked invoice was still live — voiding a repair-billing invoice made that repair job
   permanently unbillable.
3. `reverseInvoicePayment()` had three non-count-checked read-then-write mutations that could lose an
   update under concurrent access: `SalesInvoice.paidAmount`/`balanceDue`, `MetalStock.availableWt`/
   `isActive`, and `OldGoldExchange`'s own "already reversed" guard.
4. `assertCashLimit` (Sec 269ST) summed `InvoicePayment.amount` without excluding reversed rows.
5. The `OldGoldExchange` REVERSE audit entry carried no before-snapshot, and the `MetalStock` zeroing
   during a reversal had no audit entry at all.
6. `deleteClient`'s dependency check and the delete itself are two separate statements; a race would
   surface as a raw, ungraceful 500 instead of the intended 409.

---

## 1. Finding 1 — VOID reporting/ledger exclusion

**Status: FIXED.**

**Root cause:** `voidInvoice()` (J3) correctly decrements `client.currentBalance` and marks
`status = 'VOID'`, but deliberately leaves `balanceDue == totalAmount` unchanged (voiding's own
eligibility already required zero payments, so there is nothing to zero). Every report written
*before* `'VOID'` existed as a status value had no reason to exclude it, and nothing updated them
when J3 introduced it.

**Search performed (read-only, then fixed):** every `salesInvoice.*` query in the four production
files that reference the model (`finance.service.ts`, `reports.router.ts`, `sales.router.ts`,
`sales.service.ts`) — 13 call sites total. Of those, 6 are point-lookups-by-id or document generation
(unaffected — a VOID invoice must remain findable there) and one (`/sales/invoices` list) is
deliberately a historical view where showing `status: 'VOID'` faithfully is the correct behavior, not
a bug (an operator needs to find and review voided invoices). The six genuine current-aggregate paths
were fixed:

| Function | File | Fix |
|---|---|---|
| `getDealerAging` (F3) | `finance.service.ts` | added `status: { not: 'VOID' }` to the invoice filter |
| `getClientLedger` (F4) | `finance.service.ts` | added `status: { not: 'VOID' }` — the voided invoice's debit is no longer listed, so the statement keeps reconciling to `client.currentBalance` |
| `getDayBook` (H4) | `finance.service.ts` | added `status: { not: 'VOID' }` — a voided invoice no longer inflates its original day's rollup, however long after that day it was voided |
| `getGstSummary` (H5) | `finance.service.ts` | added `status: { not: 'VOID' }` inside the nested `invoice` filter on `InvoiceItem` |
| `/reports/aging-receivables` | `reports.router.ts` | added `'VOID'` to the existing `notIn: ['PAID', 'CANCELLED']` list |
| `getSalesRegister` (H1) | `sales.service.ts` | added `status: { not: 'VOID' }` — excluded from rows *and* totals, not merely zeroed out of the total while still listed, since a void was never a completed sale |

**Not touched, and why it's correct as-is:** `GET /sales/invoices` (the invoice list/history screen) and
`GET /sales/invoices/:id`/`generatePackingList` (direct lookups) — these are explicitly historical/
document views, not current-totals aggregates; a voided invoice must remain visible and retrievable
there, clearly labeled `VOID`.

**Tests added** (all new; none modified an existing assertion to force a pass):
- `finance.service.test.ts`: one new test in each of `getDealerAging`, `getClientLedger`, `getDayBook`,
  `getGstSummary` — each proves the specific report excludes a VOID invoice while an existing active
  one's figures are unchanged. `getClientLedger`'s test specifically re-checks the
  `closingBalance === client.currentBalance` reconciliation invariant the audit found broken.
  `getGstSummary`'s test uses the real `voidInvoice()` flow end-to-end (create → confirm it counted →
  void → confirm it's gone), not a direct row edit, to prove the actual interaction, not just the
  query's own filter in isolation.
- `sales.service.test.ts`: one new test in `getSalesRegister` (direct-row VOID exclusion); one new
  end-to-end test in `voidInvoice (J3.3)` that voids a real invoice and checks `getDealerAging`,
  `getClientLedger`, and `getSalesRegister` together — and explicitly proves a **different**, untouched
  active invoice for the **same client** is still reported correctly (the audit's requirement #4).

---

## 2. Finding 2 — RepairJob rebilling after invoice void

**Status: FIXED.**

**Fix, in `billRepairJob()` (`quality.service.ts`):** the guard is now
`if (repair.invoiceId && repair.invoice?.status !== 'VOID') throw ...` (previously just
`if (repair.invoiceId) throw ...`). Concretely:
- `invoiceId = null` → unbilled → bills normally (unchanged).
- `invoiceId` points to a non-VOID invoice → still blocked (unchanged behavior for the live case).
- `invoiceId` points to a VOID invoice → now eligible; a fresh `createInvoice()` runs and
  `RepairJob.invoiceId` (a plain nullable `@unique` field, not a list) is **reassigned** to the new
  invoice's id.

**What happens to the old, voided invoice:** left exactly as `voidInvoice()` left it — a real,
independently queryable `SalesInvoice` row, `status = 'VOID'`, never deleted, never touched by this
fix. History is preserved by the invoice itself remaining in the database (unchanged from J3) *and*
by a new audit entry: `billRepairJob` now calls `createAuditEntry('repair_jobs', id, userId, ...)` —
`'REBILL'` (with `oldValues: { invoiceId: <old, voided id> }`, `newValues: { invoiceId: <new id> }`)
when superseding a voided invoice, or `'BILL'` (no `oldValues`) on an ordinary first bill. This closes
a pre-existing gap noted in passing — `billRepairJob` had never audited anything before this fix — but
only for the exact code path this finding required touching; no broader retrofit was attempted.

**Frontend:** `RepairJobs.tsx`'s "billed" chip now checks `r.invoice.status !== 'VOID'` before
rendering the green success chip; when the linked invoice is void it instead shows a muted
`"<number> (voided)"` chip alongside the still-enabled bill button, so the state is visible rather
than silently misleading. `listRepairJobs`'s `invoice` select was extended to include `status` to
support this.

**Concurrent billing protection:** checked, not added. The pre-existing `billRepairJob` had no
row lock or count-checked claim on `RepairJob` before this pass (two concurrent first-time bills on
the same never-billed repair job could both create a separate invoice and race on the final
`invoiceId` write) — this is a pre-existing gap, not something J3's Void introduced or worsened, and
adding new locking for it would have been an unrelated concurrency fix outside this finding's scope
("if already present" — it wasn't). Documented as a known limitation (§6 below), not fixed here.

**Tests added** (`quality.service.test.ts`, new `describe('rebilling after the linked invoice is voided
(J3.5 Finding 2)')`):
1. a repair job whose invoice was voided can be billed again — reassigns `invoiceId`, old invoice stays
   `VOID` and unmodified otherwise, `REBILL` audit entry has the correct old/new ids.
2. after rebilling, a second active billing is still blocked (`/already billed/`).
3. cross-company protection — a different company's context cannot bill this company's repair job (404).
(A "first bill still works" and "second active billing blocked" case were already covered by the
pre-existing suite and re-verified unchanged.)

---

## 3. Finding 3 — OLD_GOLD reversal concurrency

**Status: FIXED**, using the codebase's own two existing established patterns rather than inventing a
third: `SELECT ... FOR UPDATE` (already used by `amendInvoice`/`voidInvoice` on `SalesInvoice`) and a
count-checked conditional `updateMany` (already used everywhere a status flip happens — tag flips,
the payment's own reversal claim).

| Mutation | Before | After |
|---|---|---|
| `SalesInvoice.paidAmount`/`balanceDue`/`status` | stale read, then a bare `.update()` with computed plain values | `SELECT ... FOR UPDATE` on the invoice row *before* reading `paidAmount`, inside the same transaction — the same lock `amendInvoice`/`voidInvoice` already take on this exact row, so a concurrent reversal, amend, or void on the same invoice now serialises correctly instead of racing |
| `OldGoldExchange`'s "already reversed" guard | `findFirst` + `if (exchange.reversedAt) throw` (check-then-act, no lock) | `updateMany({ where: { id, reversedAt: null }, data: {...} })`, count-checked — the exact same claim pattern the payment's own reversal already used, now applied to the exchange too |
| `MetalStock.availableWt`/`isActive` zeroing | a blind `.update()` with no re-verifying `WHERE` clause | `updateMany({ where: { id, availableWt: <the value just checked>, isActive: true }, data: { availableWt: 0, isActive: false } })`, count-checked — if anything (e.g. `orders.service.ts:autoReserveMaterials`) changed the stock between the check and this write, it affects 0 rows and the whole reversal rolls back, rather than silently clobbering that other movement |

The pre-existing MetalStock-consumption refusal (`availableWt !== netWeight` → 409) was **not
weakened** — it still runs first, before any claim is attempted; the count-checked write is an
*additional* guard against the narrower window between that check and the write itself, not a
replacement for it.

**Verified with a real sanity check, not just written and trusted:** the invoice-lock fix's own test
(§ below) was confirmed to actually fail without the `FOR UPDATE` line (`paidAmount` stuck at 2000
instead of 0 — the exact lost-update the fix targets), then confirmed to pass again with the fix
restored, before being accepted as a real regression test rather than a tautology.

**Tests added** (`sales.service.test.ts`, new `describe('concurrency (J3.5 Finding 3)')` inside
`reverseInvoicePayment (J3.2)` — both use `Promise.allSettled`/`Promise.all` starting both operations
together, not two sequential calls):
1. *Two simultaneous reversal attempts on the SAME OLD_GOLD payment* — exactly one settles fulfilled,
   the other rejects `/already been reversed/`; client balance moves by exactly one `valuedAmount` (not
   double-credited); exactly one `OldGoldExchangeReversal` journal entry exists; `MetalStock` ends in a
   single correct zeroed state.
2. *Two concurrent reversals of two DIFFERENT payments on the SAME invoice* — both succeed; the final
   `paidAmount`/`balanceDue`/`status` reflect **both** reversals (this is the one that provably fails
   without the `FOR UPDATE` fix — see above); exactly two `InvoicePaymentReversal` journal entries
   exist, none dropped or duplicated.

A genuinely concurrent "reversal races `autoReserveMaterials`'s stock consumption" scenario was not
attempted as a live interleaved test — it would require standing up the full dormant `SalesOrder`/
`Design`/`BomItem` pipeline under a timing-dependent race, a large amount of fixture machinery for a
scenario the existing deterministic test (pre-decrementing `availableWt` to simulate the race having
already resolved unfavorably — carried over unchanged from J3) already proves the *guard* handles
correctly; only the *write*'s own race-safety (now closed) needed a new test, and is covered by the
`MetalStock` assertions in test 1 above.

---

## 4. Finding 4 — Sec 269ST cash limit excludes reversed payments

**Status: FIXED.** `assertCashLimit` (`shared/compliance.ts`) now filters `reversedAt: null` on its
`invoicePayment.aggregate` call, alongside the existing `mode`/`companyId`/`clientId`/`paymentDate`
filters. No other rule in that function changed.

**Test added** (`sales.compliance.test.ts`, inside the existing `Sec 269ST` describe): pays ₹1,50,000
cash, reverses it, then pays ₹1,99,999 cash the same day — succeeds (would have failed under the old
code, since 150000 (reversed) + 199999 ≥ 200000). Then proves no loophole was introduced: that same
active ₹1,99,999 receipt still blocks a further ₹1 cash payment the same day, with the exact
"₹1,99,999 already received" figure in the error — and a non-cash payment of any size remains
unaffected, exactly as before.

---

## 5. Finding 5 — OLD_GOLD reversal audit completeness

**Status: FIXED**, using the existing `createAuditEntry`/`AuditLog` mechanism only — no new table, no
second audit path, `AuditLog` remains immutable (unchanged DB-level `REVOKE UPDATE, DELETE`).

- The `OldGoldExchange` `REVERSE` audit entry now carries a real before-snapshot
  (`exchangeNumber`, `clientId`, `karat`, `grossWeight`, `stoneWeight`, `netWeight`, `ratePerGram`,
  `valuedAmount`, `metalStockId`), captured before the claim, not just a bare reason string —
  reconstructable on its own now, matching the shape of the other three J3 reversal audit entries.
- `MetalStock`'s zeroing during a reversal is now audited (`'metal_stocks'`, action `'REVERSE'`,
  `before: { availableWt, isActive }` / `after: { availableWt: 0, isActive: false }`) — matching the
  contract every *other* `MetalStock` mutation in this codebase already had (`addMetalStock` → `CREATE`,
  `adjustMetalStock` → `ADJUST`); this one silently didn't.
- **Correctness detail, not just added, but placed correctly:** both new audit calls run *after* the
  transaction commits (alongside the two pre-existing ones for the payment and the exchange), not from
  inside the open transaction — `createAuditEntry` writes via its own connection
  (`middleware/audit.ts`), so calling it before the surrounding transaction is durable could record an
  entry for a mutation that then rolls back. (A pre-existing, unrelated instance of that exact risk was
  noticed in `addMetalStock`, which does audit from inside a possibly-nested transaction — left
  untouched, as fixing it is outside this finding's scope; noted in CLAUDE.md, see §7.)

Audit immutability itself was not re-tested here — it is a structural, DB-level property (`REVOKE
UPDATE, DELETE ON audit_logs`) already covered by the existing RLS/isolation suite, and nothing in
this pass calls `.update()`/`.delete()` on `AuditLog` anywhere.

**Test added:** the existing OLD_GOLD reversal test in `sales.service.test.ts` was strengthened (not
replaced) to assert the new before/after content on both the exchange's and the `MetalStock`'s audit
entries, rather than merely `expect(audit).not.toBeNull()`.

---

## 6. Finding 6 — client delete race / error translation

**Status: FIXED.** `deleteClient()` (`orders.service.ts`) now wraps its `client.delete()` call in a
`try`/`catch` that recognizes a foreign-key conflict via the existing `isBlockedByForeignKey()` helper
(`shared/prismaErrors.ts` — the same one `masters.router.ts` and `settings.service.ts` already use for
exactly this shape of problem) and translates it into the same clean 409 the earlier, non-racing
dependency check already gives, instead of letting a raw constraint-violation error surface as a 500.

**What was deliberately not changed:** the dependency check and the delete remain two separate
statements — no cascade delete, no weakened FK, no new locking that would let a delete proceed against
a genuinely-dependent client. The FK layer stays the actual backstop; this only makes its failure mode
graceful.

**Test added:** rather than a live interleaved-timing test (see the reasoning below), a deterministic
test proves the exact mechanism the fix depends on: creating a client with a real dependent
`SalesInvoice`, then attempting a raw `prisma.client.delete()` directly (bypassing `deleteClient`'s own
earlier check) and confirming (a) it throws, (b) `isBlockedByForeignKey()` recognizes that specific
error, and (c) the client row is untouched. This is what `deleteClient`'s new `catch` block relies on
being true; it is proven directly rather than assumed.

**Why no live race test:** a genuine interleaved race (dependency created in the exact window between
the count-check and the delete) has no shared lock or resource forcing a specific interleaving the way
Finding 3's `SELECT ... FOR UPDATE` scenarios do — `Promise.all`-starting the two operations together
would not deterministically land in the narrow window every run, making the test itself flaky rather
than a reliable regression guard. The deterministic test above proves the same safety net without that
risk, consistent with the brief's own "if practical" qualifier for this specific finding.

---

## 7. CLAUDE.md updates

Two durable rules were added to CLAUDE.md, both discovered while fixing the findings above, both
already true of the *correct* parts of this codebase and now made explicit so they aren't
re-violated by a future change:

1. **A new terminal/closed status value on any entity must be reconciled against every existing
   report/aggregate that filters or sums by status** — Finding 1 was six separate places that all
   needed the identical one-line fix because `'VOID'` didn't exist when they were written; the fix
   itself was trivial each time, but finding all six required a deliberate full-repo search, not
   trusting the original bug report's own list.
2. **A conditional write that follows a state check must itself be count-checked (or otherwise
   atomic/locked) at write time, not just checked once and then written blindly** — Findings 3's three
   sub-fixes were all instances of this same shape of bug (check now, write later, nothing re-verifies
   at write time). Also noted as a known, *pre-existing, unrelated* instance still standing:
   `addMetalStock` calls `createAuditEntry` from inside whatever transaction it's given, which can
   record an audit entry for a mutation that later rolls back if that transaction is nested inside a
   larger one that fails afterward — flagged for a future pass, not fixed in this one (out of scope for
   any of the six findings).

---

## 8. Verification

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` (server) | Clean |
| `npx tsc --noEmit` (server, incl. tests) | Clean |
| `npx tsc --noEmit` (client) | Clean |
| `npm run audit:tenant` | Clean — `scoped=0, raw=0, aliases=0`, identical baseline (the new `tx.$queryRaw` FOR UPDATE lock is a tagged template, the documented blind spot in CLAUDE.md §11 — not a new gap, the same shape `amendInvoice`/`voidInvoice` already use) |
| `npx vitest run` (full local suite) | **42 files, 787 passed, 5 skipped, 0 failed** — baseline was 42/774/5; +13 new tests, none regressed |
| `npm run test:rls` (real role-split) | **42 files, 791 passed, 1 skipped, 0 failed** — baseline was 42/778/1; same +13 |

New tests added this pass: 6 (Finding 1) + 3 (Finding 2) + 2 (Finding 3, concurrency) + 1 (Finding 4)
+ 0 new / 1 strengthened (Finding 5) + 1 (Finding 6) = **13 new tests**, all individually verified
passing before the final combined run above; one (Finding 3's invoice-lock test) was additionally
confirmed to genuinely fail without its fix, then pass with it restored.

---

## 9. Remaining, explicitly separated

**Fixed this pass:** all six findings (1–6), in full, as scoped by the brief.

**Intentionally deferred (pre-existing or explicitly out of scope, not newly discovered):**
- GST e-invoice IRN cancellation on Void (J3 Decision 5(b), unchanged).
- `SalesReturn` "un-return" (J3 Decision 4, unchanged).
- Role assignment for the four J3 permissions (Decision 6/7, unchanged).
- Concurrent *first-time* billing protection on `billRepairJob` (pre-existing, not present before this
  pass, not added — see Finding 2 §2 above).
- `addMetalStock`'s own audit-from-inside-a-transaction pattern (pre-existing, unrelated to any of the
  six findings — noted in CLAUDE.md §7 above, not fixed).

**Newly discovered during this pass, not part of the original six findings, and not fixed:** none — the
broader Finding-1 search surfaced `getDayBook` and `getGstSummary` as additional affected paths beyond
the audit's original five-item list, but these are squarely within Finding 1's own stated scope
("do not assume the five identified paths are the complete list"), not a seventh, separate finding.

---

## J3.5 HARDENING: COMPLETE — READY FOR HUMAN REVIEW
