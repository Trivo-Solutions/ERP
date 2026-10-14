# Phase J3 — Human Decisions

> Converts the seven open questions from `PHASE_J3_DESIGN_AUDIT.md` §21 into a decision sheet.
> **No source code, migration, permission, role, or database state was changed to produce this
> document.** Nothing below is resolved — every "Recommended implementation direction" is stated
> strictly as an engineering/technical-effort comparison, not as the answer. The human/product-owner
> decision column is what actually settles each question.

---

## Decision 1 — InvoicePayment reversal: schema shape

**Question:**
When an `InvoicePayment` is reversed, should the original row itself be flagged (new nullable
`reversedAt`/`reversedById`/`reversalReason` columns on `InvoicePayment`), or should the original
row stay completely untouched and a new, linked **compensating row** be created instead (e.g. a
negative-amount payment or a dedicated reversal record with a `reversalOfPaymentId` self-relation)?

**Why it matters:**
This is the one schema decision every other part of payment reversal depends on. It determines how
every place that currently sums `InvoicePayment` — the client ledger (F4), the day book, the sales
register, dealer aging, and the invoice's own `paidAmount`/`balanceDue` recompute — must be rewritten
to correctly exclude or net out a reversed payment. Picking the wrong shape now means a second
migration and a second pass through every one of those report functions later.

**Existing behavior:**
`InvoicePayment` has no status/void/reversal field today (`schema.prisma:2432-2457`). It is created
exactly once, by `applyPayment` (`sales.service.ts:920-927`) or `recordClientPayment`
(`sales.service.ts:985-991`), and is never updated anywhere in the codebase. Every report that reads
it today assumes every row is a live, currently-valid receipt.

**Options:**
- **A — Flag on the original row.** Add nullable `reversedAt`, `reversedById`, `reversalReason`.
  Reversal = one `UPDATE` on the original, plus the compensating journal/balance/invoice-balance
  entries elsewhere.
- **B — Compensating row.** Original row is never touched again. Reversal = a new row (negative
  amount, or a dedicated reversal shape) referencing the original.

**Technical consequences:**
- **A:** Every report that sums `InvoicePayment` needs exactly one added filter
  (`reversedAt IS NULL`) — a single, mechanical change repeated across the existing report
  functions. Matches the status-flag convention already used elsewhere in this codebase
  (`SalesInvoice.status`, `JewelryTag.status`). Trade-off: a financial record is mutated after the
  fact, even if only by a flag, not by changing `amount`/`mode`/`date`.
- **B:** The original row is never mutated after creation — the same philosophy already chosen for
  `SalesReturn` (a reversal is a new row, not an edit). Trade-off: every place that currently treats
  `payment.amount` as always-positive (UI display, receipt printing, any report that sums it) must be
  reviewed to correctly net a signed value — a broader set of touch-points than Option A's one added
  filter.

**Recommended implementation direction (technical only):**
Option A touches fewer call sites to retrofit correctly and reuses a pattern already established in
this codebase (a status/flag field checked at read time). Option B requires reviewing every
amount-summing call site for signed-value correctness. This is stated purely as a retrofit-effort and
regression-risk comparison — it is not a position on which model is the more defensible financial
ledger design.

**Human decision required:**
Whether the business/product owner prefers the "flag the original" model (fewer touch points, less
purist) or the "append-only compensating record" model (matches `SalesReturn`'s existing philosophy,
arguably more defensible to an auditor who expects a ledger row to never be touched once written).

**Implementation dependency:**
The `InvoicePayment` reversal migration cannot be written, and the reversal function cannot be
implemented, until this is chosen. Every report/ledger function that currently sums `InvoicePayment`
needs an update matching whichever shape is picked.

---

## Decision 2 — OLD_GOLD / STORE_CREDIT payment reversal

**Question:**
Should reversal of a credit-settled `InvoicePayment` (`mode` = `OLD_GOLD` or `STORE_CREDIT`) be
allowed at all — and if so, must it be built together with (in the same transaction as) a reversal of
the `OldGoldExchange` or `SalesReturn` credit that originally funded it?

**Why it matters:**
Reversing this kind of payment on its own can silently create a double-count: the invoice reopens
(the customer appears to owe again) while the credit that was consumed to settle it — already-melted
gold sitting in the Metal Vault, or an already-spent store credit — is not restored. The business
would end up worse off than before the original sale, not merely back to its starting position. This
is a real accounting-integrity risk, not a style preference.

**Existing behavior:**
`applyPayment`'s `fromCredit` branch (`sales.service.ts:938-956`) deliberately skips posting a
journal entry and skips touching `client.currentBalance` for a credit-settled payment, because that
movement already happened when the `OldGoldExchange` was booked (`bookOldGoldExchange`,
`sales.service.ts:1228+`) or when the original `SalesReturn` credited the client.
`CREDIT_SETTLEMENT_MODES` (`shared/constants.ts:20-22`) = `OLD_GOLD`, `STORE_CREDIT`. **No reversal
capability exists today for `OldGoldExchange`** — `PHASE_J1_AUDIT.md`'s own matrix independently
flagged this as "the clearest §6.8 gap found anywhere": a real, permanent journal + balance + Metal
Vault side effect with genuinely no undo built. `SalesReturn` is separately proposed to stay
append-only (Decision 4).

**Options:**
- **A — Block it.** Categorically refuse to reverse any `InvoicePayment` whose `mode` is in
  `CREDIT_SETTLEMENT_MODES`, until `OldGoldExchange`/return-credit reversal is designed and built as
  its own, separate capability.
- **B — Allow it anyway.** Reverse the `InvoicePayment` row in isolation, accepting that the invoice
  reopens without the underlying credit being restored.
- **C — Build the coupled reversal now.** Extend this same phase to also build `OldGoldExchange`
  reversal, so a credit-mode payment reversal always executes together with, and in the same
  transaction as, a reversal of whatever generated the credit it drew on.

**Technical consequences:**
- **A:** No new schema or cross-entity logic — one guard clause (reject if `mode` is a credit-
  settlement mode) inside the reversal function. Ships fastest. Leaves a documented gap: a
  mis-recorded old-gold sale cannot be corrected via payment reversal — only via a full invoice Void
  (if eligible) or a manually-entered compensating entry outside the system.
- **B:** Requires no new `OldGoldExchange` capability, but introduces the double-count risk described
  above directly into a live financial ledger, with nothing in the system flagging the resulting
  inconsistency to anyone.
- **C:** Produces the correct end-to-end outcome, but meaningfully expands this phase's scope: it
  requires designing and building reversal of a Metal Vault stock addition, a client balance credit,
  and a journal entry for a fifth entity family (`OldGoldExchange`) that was never part of this
  document's original four-entity review.

**Recommended implementation direction (technical only):**
Option A is the only one of the three that does not introduce a known accounting inconsistency into
production (B) or require building a not-yet-designed capability outside this document's reviewed
scope as a precondition (C). This is a statement about engineering scope containment and risk, not a
judgment on whether the business should eventually be able to do this.

**Human decision required:**
Whether credit-mode payment reversal is needed in the near term at all — and if so, whether it is
acceptable to defer it (Option A) until `OldGoldExchange` reversal exists as its own follow-up phase,
or whether the business needs it sooner and is willing to expand this phase's scope to build it
together now (Option C). Option B is presented only for completeness; accepting a known ledger
inconsistency is unlikely to be advisable, but that is the business's call, not an engineering one.

**Implementation dependency:**
The `payment:reverse` permission's enforcement logic cannot be finalized until this is decided —
specifically, whether the credit-mode guard clause is permanent policy (A) or a placeholder pending a
dependent capability (C). This decision also determines whether `OldGoldExchange` reversal needs to
be scheduled as a prerequisite phase before `payment:reverse` can be considered complete.

---

## Decision 3 — Client: isActive enforcement, and separating deactivate / hard-delete / edit

**Question:**
(a) Should `createInvoice`, `createMemoOut`, and `recordClientPayment` be changed to reject a client
whose `isActive` is `false`? (b) Should deactivate/reactivate become its own permission
(`client:deactivate`), distinct from the general `client:edit`?

These are deliberately posed as **three separate operations, not one**:
- **Editing client data** (name, GST, phone, credit limit, etc.) — already exists, already gated by
  `client:edit`, entirely unaffected by this decision.
- **Deactivating/reactivating a client** (toggling `isActive`) — a *reversible lifecycle toggle*.
  Mechanically already possible today via the existing `client:edit`-gated endpoint, but currently
  has no protective effect.
- **Administrative hard delete** — a *separate, irreversible* removal of the row entirely, only
  possible when the client has zero transaction history across every dependent table. This is not a
  lifecycle toggle and must never be reached through the same code path as deactivation. (The
  zero-dependency condition for hard delete is a mechanical, DB-enforced fact — not itself a business
  judgment call — so it is not listed as an open question here; it is carried forward as designed in
  `PHASE_J3_DESIGN_AUDIT.md` §9.1/§6.)

**Why it matters:**
Conflating these three would misassign risk: a delegate trusted to fix a client's phone number is not
automatically someone who should be trusted to make that client un-billable, and neither of those is
remotely the same trust level as permanently erasing the record.

**Existing behavior:**
`Client.isActive: Boolean @default(true)` (`schema.prisma:1127`). `updateClient`'s
`CLIENT_WRITABLE_KEYS` whitelist already includes `isActive` (`orders.service.ts:183-187`) — today,
anyone holding plain `client:edit` can already flip it, with no dedicated permission, no audit entry,
and no downstream effect anywhere except `listClients` filtering `isActive: true`
(`orders.service.ts:167`) — i.e. it currently affects nothing except whether the client shows up in a
picker list. `createInvoice` (`sales.service.ts:280-283`) checks only `client.companyId`, never
`isActive`.

**Options — enforcement (a):**
- **A1.** Enforce: reject an inactive client at `createInvoice`/`createMemoOut`/
  `recordClientPayment`.
- **A2.** Leave as-is: `isActive` continues to affect only the picker list.

**Options — permission split (b):**
- **B1.** Split: new `client:deactivate` permission, its own audit action, required confirmation.
- **B2.** No split: `isActive` remains one of the many fields `client:edit` can already touch.

**Technical consequences:**
- **A1:** One guard clause (`if (!client.isActive) throw ...`) added at three existing call sites.
  Real behavior change: any client already sitting at `isActive = false` in a live company (set
  through the current, toothless toggle, for whatever reason an operator used it) would suddenly
  become un-transactable the moment this ships — a one-time review of already-deactivated clients in
  any live company is needed first, to avoid an unexpected billing block.
- **A2:** No code change. The field remains real in the schema but continues to do nothing
  protective — effectively means "not needed yet" in practice.
- **B1:** One new permission string, one new `requirePermission` check on the `isActive`-toggling
  path (or a dedicated endpoint), plus a real audit call (`DEACTIVATE`/`REACTIVATE`) that doesn't
  exist today. Lets a company grant "can edit client details" without also granting "can make a
  client un-billable."
- **B2:** No new permission or endpoint. Simplest, but bundles a lifecycle-affecting toggle into the
  same permission as routine detail edits for every role that has either.

**Recommended implementation direction (technical only):**
A1 is a small, contained change (one guard clause × 3 call sites) that makes the field's actual
behavior match what its name already implies — a consistency fix, described purely as an
implementation-scope observation. B1 follows a split pattern already used elsewhere in this codebase
for pulling a lifecycle action out of a general edit permission (e.g. the existing `branch:create`/
`branch:edit` split, and the `tag:edit`/`tag:retire` split `PHASE_J1_AUDIT.md` itself recommended) —
technically consistent with established convention in this repo, independent of whether it matches
this business's preferred trust model.

**Human decision required:**
(1) Whether an inactive client should actually be blocked from new transactions — a real behavior
change with a real pre-deployment review implication. (2) Whether deactivate/reactivate should
require its own permission, or continue to ride `client:edit`.

**Implementation dependency:**
The final permission-catalog entries and the exact code path the three sale-adjacent functions take
both depend on this. If enforcement (A1) is approved, a one-time audit of any already-deactivated
clients in each live company should run **before** deployment, to avoid silently blocking a client
someone deactivated under the old, non-blocking behavior for an unrelated reason.

---

## Decision 4 — SalesReturn reversal ("un-return"): confirm out of scope

**Question:**
Should J3 build any capability to undo/reverse an already-created `SalesReturn` (e.g. it was recorded
against the wrong line or the wrong tag by operator error)?

**Why it matters:**
`SalesReturn` is itself the reversal primitive for a sale — the question is whether *correcting a
mistaken correction* needs its own dedicated machinery, or whether "just sell it again" is an
acceptable remedy. Building a true "un-return" is riskier than it first appears: time passes between
the return and any correction attempt, and the tag involved may have since been resold,
branch-transferred, or hallmarked — none of which a naive reversal could safely unwind.

**Existing behavior:**
`SalesReturn`/`SalesReturnItem` have no update or delete path anywhere in the codebase
(`schema.prisma:2462-2501`; the only mutation function is `createSalesReturn`,
`sales.service.ts:1029-1155`). A returned tag flips back to `IN_STOCK` and becomes fully available
for any subsequent normal operation — by the time anyone notices a return was a mistake, the tag's
state may already have moved on.

**Options:**
- **A — Build nothing.** A mistakenly-returned item is corrected by selling it again through the
  existing `createInvoice` path. Nets out correctly, financially and in stock, at the cost of a new
  invoice number rather than "restoring" the original one.
- **B — Build a dedicated reversal** ("return of a return"): flips the tag back to `SOLD`, reverses
  the credit and journal, links back to the original `SalesReturn` — but only safe if nothing has
  touched the tag since the return (still `IN_STOCK`, no intervening transfer/hallmark/resale).

**Technical consequences:**
- **A:** Zero new engineering effort, zero new risk surface. The financial/stock outcome is correct;
  the original invoice number is not "restored," which may read oddly on a per-invoice audit trail
  even though the net financial position is identical.
- **B:** Requires a dependency check across every table that could have touched the tag since the
  return (branch transfer, hallmarking batch, a second sale) before allowing the reversal —
  meaningfully more validation surface than any other action proposed in this document, for a case
  this research found no evidence of being a frequent operational need.

**Recommended implementation direction (technical only):**
Option A requires no new capability and carries no risk of an unsafe reversal being permitted on a
tag whose state has since diverged. Option B's dependency-checking surface is the most complex of
anything proposed in this document relative to its apparent frequency of need. This is an
engineering-effort/risk observation, not a claim that the business doesn't need the capability.

**Human decision required:**
Whether "sell it again" is an acceptable permanent remedy for a mistaken return, or whether the
business needs a true "un-return" badly enough to justify designing and building the more complex,
dependency-checked reversal.

**Implementation dependency:**
If "sell it again is fine," `SalesReturn` needs zero further J3 work and this can be formally closed.
If not, a new capability must be scoped and reviewed from scratch — nothing for it is designed today.

---

## Decision 5 — SalesInvoice Void: eligibility rule and the GST/e-invoice consequence

**Question:**
(a) Is the proposed Void eligibility rule — only invoices with **zero** `InvoicePayment` rows and
**zero** `SalesReturn` rows may be voided — acceptable as stated, or should it be loosened (e.g. to
allow voiding the remaining lines of a partially-returned invoice)? (b) Must GST e-invoice IRN
cancellation be solved before Void ships, or can Void ship now with IRN cancellation left as a
manual, outside-the-system process?

**Why it matters:**
Void is the single highest-priority gap this whole audit identified (`PHASE_J1_AUDIT.md` ranked it
top urgency for this module). The *mechanism* is low-risk — it directly reuses the exact per-line
reversal pattern `createSalesReturn` already runs safely in production, applied to every line at
once. What remains genuinely open is how strict the eligibility gate should be, and whether a
statutory step (cancelling an already-generated GST e-invoice with the tax authority) has to be
solved in the same phase.

**Existing behavior:**
`createSalesReturn` (`sales.service.ts:1029-1155`) already performs, per line: tag `SOLD`→`IN_STOCK`
(count-checked), a reversing journal entry (Dr Revenue+GST / Cr AR, Dr Inventory / Cr COGS), and a
`client.currentBalance` credit. `amendInvoice` (`:694-890`) already refuses to change the customer
once any payment or return exists against an invoice (`:749-751`) — the exact restriction Void's
proposed eligibility rule reuses. **No `VOID` status value and no whole-invoice reversal function
exist anywhere today.** `TaxInvoice` (`schema.prisma:2615-2642`) has no cancellation/status field of
its own — its e-invoice fields (`irn`, `ackNumber`, `ewbNumber`) are stored, but nothing in this
codebase talks to the GST portal to cancel an already-issued IRN.

**Options — eligibility (a):**
- **A1 — Strict** (as proposed): void only permitted with zero payments and zero returns; anything
  else must use amend/return instead.
- **A2 — Looser:** allow voiding the remaining, not-yet-returned lines of a partially-returned
  invoice — functionally close to calling `createSalesReturn` on what's left, under a different name.

**Options — GST/e-invoice consequence (b):**
- **B1 — Manual process:** ship Void now; the operator manually cancels any already-generated e-invoice
  IRN with the GST portal outside this system, using the invoice's stored `irn`/`ackNumber`.
- **B2 — Block on IRN:** refuse Void in-app for any invoice where `TaxInvoice.irn` is already set
  (an e-invoice was actually generated), until IRN-cancellation integration exists.
- **B3 — Build the integration:** implement GST portal IRN-cancellation as part of this same phase,
  before Void ships.

**Technical consequences:**
- **A1:** Matches an already-established restriction pattern (`amendInvoice`'s own customer-lock
  rule) — no new dependency-checking logic beyond what already exists.
- **A2:** Effectively duplicates `createSalesReturn`'s own logic under a different name for the
  partial case — raises the question of whether "Void" is even the right name for that path, versus
  simply calling the existing return function on the remaining lines.
- **B1:** No new integration work. Carries a real compliance risk if an operator voids an invoice and
  forgets the manual cancellation step — this system's books would show `VOID` while the tax
  authority's records still show a live invoice.
- **B2:** A small additional check (read `TaxInvoice.irn`) closes that specific risk automatically,
  at the cost of leaving genuinely-erroneous e-invoiced sales uncorrectable by Void at all — they
  would fall back to a return, which itself doesn't reverse GST today (the already-separately-tracked
  I3 gap).
- **B3:** Closes the compliance gap completely, but is a materially larger scope addition — a live
  GST portal integration, credentials, error handling, retry/timeout behavior — than anything else in
  this document, and was never part of the four-entity scope this design audit reviewed.

**Recommended implementation direction (technical only):**
A1 is the smallest, best-precedented change, requiring no new validation logic beyond what
`amendInvoice` already established. On the GST question, B2 is the only option of the three that
closes the specific identified risk (a `VOID`'d invoice with a still-live e-invoice at the tax
authority) without expanding scope into a portal integration (B3) or accepting an unenforced manual
step (B1) — stated as a scope-containment comparison, not a compliance-policy recommendation, since
whether e-invoicing is even in active use for a given company is a business/deployment fact this
document cannot assume.

**Human decision required:**
(1) Confirm or adjust the strict zero-payment/zero-return eligibility rule. (2) Decide the GST/
e-invoice handling: accept the manual-process risk (B1), block Void on any already-e-invoiced sale
until further notice (B2), or commission the larger e-invoice-cancellation integration as its own
project (B3).

**Implementation dependency:**
Void's exact guard-clause set cannot be finalized without both parts of this decision. If B2 or B3 is
chosen, Void's implementation must additionally read `TaxInvoice.irn` as an eligibility input — not
present in the current design proposal — and would need to be added to it.

---

## Decision 6 — J3 permission role assignment

**Question:**
Which existing roles (or new ones) should receive `client:deactivate`, `client:delete`,
`invoice:void`, and `payment:reverse` once they exist — and should any of them ship granted to a
starter role at all initially, or remain SUPER_ADMIN-only (via the `*` wildcard) until a company's
own SUPER_ADMIN explicitly delegates them?

**Why it matters:**
This is a pure trust/risk-tolerance judgment about who inside a customer company should hold each
capability. CLAUDE.md §6.2/§6.3 explicitly reserves this kind of call to the customer's own
SUPER_ADMIN, not to this engineering process.

**Existing behavior:**
The J2 precedent (`PHASE_J2_REVIEW.md` §7) added new permissions "alongside, never in place of" a
role's existing grants specifically so no one's effective access silently changed — and documented
that an already-provisioned company's SUPER_ADMIN must re-grant any new permission through the Role
Editor UI themselves, since Starter Package v1 is immutable and only companies provisioned after a
change pick up a new default automatically.

**Options:**
- **A — Follow the sibling-permission pattern.** Whoever already holds the permission each new one
  is split from (e.g. `invoice:edit` holders also get `invoice:void`; `client:edit` holders also get
  `client:deactivate`) in a future Starter Package version (new companies only).
- **B — Ship ungranted.** All four reachable only via SUPER_ADMIN's `*`, until a company's own
  SUPER_ADMIN explicitly delegates them through the Role Editor.
- **C — Differentiated.** Lower-risk permissions (`client:deactivate`, `invoice:void`) follow Option
  A; higher-risk ones (`client:delete`, `payment:reverse`) follow Option B's more conservative
  default.

**Technical consequences:**
- **A:** Fastest path to usability for existing operational roles. Risk: a role automatically gains a
  materially more powerful capability (e.g. permanently voiding a bill) the moment it's deployed,
  with no explicit per-company decision made.
- **B:** Safest default — no existing role's effective power increases without a visible, explicit
  action by that company's own SUPER_ADMIN. Cost: every company (including the current dev/staging
  one) must manually grant these before anyone but SUPER_ADMIN can use them.
- **C:** Balances the two, but requires explicitly ranking the four permissions by risk tier — this
  document proposes such a ranking (§11/§13 of the design audit) but it is not an approved decision.

**Recommended implementation direction (technical only):**
Option B requires the least judgment to implement correctly and carries the least risk of an
unreviewed privilege expansion — shipping a new permission with no starter-role grant is always
technically safe; a mis-ranked risk tier under A or C is not something code can self-correct later.
This is a deployment-safety comparison, not a statement about which roles should ultimately hold
these permissions.

**Human decision required:**
The actual role-to-permission mapping for all four new permissions, or the explicit decision to ship
with none assigned initially.

**Implementation dependency:**
The Starter Package diff (if any) cannot be written until this is decided. If any permission is
granted to an already-provisioned company's role, the same "SUPER_ADMIN must manually re-grant it,
and a logged-in user must log out and back in" precedent from J2/earlier fixes applies identically
and should be communicated the same way.

---

## Decision 7 — `GET /sales/clients/:clientId/credit` permission ambiguity (carried over from J2)

**Question:**
Should this endpoint keep its current `invoice:create` gate, or be reclassified to `client:view` (or
a new, narrower permission), since it reads Client-domain data rather than creating an invoice?

**Why it matters:**
Narrow and low-risk — not a new finding, just an item J2's review explicitly declined to silently
resolve. Worth closing in this pass since it sits in the same code area as the rest of this
document's Client-permission work, rather than letting it linger to a third review.

**Existing behavior:**
`sales.router.ts:220`, gated `invoice:create`, feeds only the New Sale screen's payment-mode picker.
`getClientCredit` (`sales.service.ts:1281-1288`) reads `Client.currentBalance` only — no write.
`PHASE_J2_REVIEW.md` §5 explicitly flagged this as "needs human review" and left it unchanged rather
than reclassifying it either way.

**Options:**
- **A — Leave as `invoice:create`** (current state, no change).
- **B — Reclassify to `client:view`** — matches what data the endpoint actually reads.
- **C — New, dedicated permission** for this one read (listed only for completeness; disproportionate
  for a single read-only lookup).

**Technical consequences:**
- **A:** No code change. A delegate with `client:view` but not `invoice:create` could not use this
  lookup — arguably fine today since the New Sale screen needs `invoice:create` to do anything else
  anyway, but slightly inconsistent if a client-only support/service view is ever built later.
- **B:** A one-line permission-string change, identical in shape to every other J2 reclassification.
  A delegate with only `client:view` could see a client's derived credit outside the sales flow
  without needing `invoice:create`.
- **C:** Adds a fifth permission string for one read-only endpoint — disproportionate to its scope.

**Recommended implementation direction (technical only):**
Option B is the smallest, most internally consistent change relative to the rest of J2's own
reclassification work, which throughout matched the permission to the data being read/written rather
than to whichever single screen happened to be its only current consumer.

**Human decision required:**
Simply A or B (C is not a serious contender). The lowest-stakes decision in this document, included
only because the brief requires every open question to be surfaced rather than silently resolved.

**Implementation dependency:**
None of the other six decisions depend on this one. It can be resolved independently, at any time,
including after the rest of J3 ships.

---

## Decisions that are NOT required yet

Safe to leave as an implementation detail, decided during coding rather than requiring sign-off now:

- The exact wording of new audit `action` strings (`DEACTIVATE`, `REACTIVATE`, `FORCE_DELETE`,
  `VOID`, `REVERSE`) — `AuditLog.action` is free-text; no schema or product impact either way.
- Whether the audit before/after "snapshot" helper is factored into a shared utility or duplicated
  per function — internal code organization only, does not change behavior or the audit contract.
- The precise concurrency mechanism used to make "reverse an already-reversed payment" or "void an
  already-void invoice" atomic (a DB constraint vs. an application-level count-check) — as long as it
  is atomic under concurrent requests, matching the count-checked pattern already used throughout
  this codebase, the specific mechanism is an implementation choice.
- The order in which the four families' audit-diff retrofit (§22 item 1 of the design audit) is
  committed — pure engineering sequencing.
- Frontend confirmation-dialog wording, button placement, and exact copy (J4 scope) — cosmetic,
  reviewable at build time, does not require product sign-off at this stage.

---

## J3 Implementation Gate

Decisions that **must** be resolved before the corresponding code is written:

| Must resolve before... | Blocking decision(s) |
|---|---|
| Any `InvoicePayment` reversal schema/migration work begins | **Decision 1** |
| `payment:reverse` can be implemented or its scope finalized | **Decision 2** |
| Any `Client` enforcement-logic change or the deactivate/edit permission split is coded | **Decision 3** |
| `SalesInvoice` Void's eligibility guard clauses are written | **Decision 5** |
| Any Starter Package / role-grant change ships for the four new permissions | **Decision 6** (shipping all four SUPER_ADMIN-only via `*`, with no role grants, does not require this to be resolved first — only granting them to any specific role does) |

Decisions that gate **scope closure**, not a specific line of code, and should be explicitly
confirmed so J3 doesn't quietly reopen them later:

| Must be explicitly confirmed closed | Decision |
|---|---|
| Whether `SalesReturn` gets any new mutation capability in this phase (currently: no) | **Decision 4** |

Fully independent, non-blocking, resolvable at any time including after the rest of J3 ships:

| Decision |
|---|
| **Decision 7** |

---

## J3 DECISION SHEET: COMPLETE — AWAITING HUMAN SIGN-OFF

---

## Supersession record — Day Book treatment of reversed customer advances (2026-10-13)

**Supersedes, in part:** the Day Book reporting behaviour that followed from Decision 1 — "every report that sums
`InvoicePayment` adds `reversedAt IS NULL`, so a reversed receipt is treated as if it never happened" — **for customer
advances only**. The text of Decision 1 above is left exactly as written, as the historical record.

**What is NOT changed:** Decision 1's schema choice (Option A — flag the original row, never edit or delete it) stands, for
`InvoicePayment` and for `CustomerAdvance` alike. The advance-reversal journal (Dr 2400 Customer Advances / Cr Cash-or-Bank,
dated the reversal) is unchanged. The client ledger and `Client.currentBalance` are unchanged (an advance never touches them).
**`InvoicePayment` reversals are still excluded from the Day Book exactly as before** — that is a separate, still-open question
(the same cross-day mismatch exists there), deliberately not decided or built here, and it keeps `payments.total` /
`payments.byMode` receipts-only.

**Previous behaviour (superseded):** a reversed advance was dropped from the Day Book on the day it was taken, and shown nowhere.
A reversal on a later day therefore rewrote an already-closed day, and the cash that physically left on the reversal day never
appeared on any day. The ledger (cash in on D, cash out on R) and the Day Book disagreed.

**New rule (approved by the business owner):**
1. An advance receipt stays on its **original business date** as gross money in, whether or not it is reversed later
   (`advances.rows[].reversed` marks it; its unused amount is 0).
2. A reversal is **money out on the actual reversal date** (`CustomerAdvance.reversedAt`, India business day — the same instant
   the reversal journal is posted), reported once, with advance number, customer, amount, original date and reason, and by the
   **original payment modes** (the advance's payment lines, which are never edited or deleted). A reversal is whole-advance and
   once-only, so the full amount is reported exactly once; no partial reversal exists in the data model.
3. A same-day reversal shows both the inflow and the outflow (net zero); a cross-day reversal changes nothing on the original day.
4. **Total Money In stays gross** (payments + advances received). New: **Total Money Out** (advance reversals) and
   **Net Money Movement = Total Money In − Total Money Out**, reconciled per payment mode (`moneyIn.byMode[].out` / `.net`).
5. An advance with no payment lines is not guessed: a single header mode is used as recorded; a `SPLIT` header with no lines is
   reported under its own `UNKNOWN` mode, never folded into Cash.
6. Applying an earlier advance to a bill is not new money in (unchanged). **Refunds are out of scope** — no code writes
   `refundedAmount` today; they remain undesigned.

**Where:** `finance.service.ts: getDayBook`, `DayBook.tsx`; tests `finance.dayBookMoneyIn.test.ts`, `http.dayBook.test.ts`,
client `dayBook.test.tsx`. Existing API fields keep their meaning (`payments.total`, `payments.byMode` receipts-only);
`moneyIn`/`advances`/`net` gained fields, and `advances` now includes reversed advances on the day they were taken.
