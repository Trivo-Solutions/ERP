# Progress

Phase: **2 — Investigation and documentation (read-only), complete, awaiting owner review.** Phase 3 (any import code) has **not** started and is not authorized. Production migration: not approved.

## Phase 1 (2026-10-14) — done
Environment verified (GATI = SQL Server 2022 `.\SQL22`; TRIVO = Node/Prisma/PostgreSQL 18); schema and FK inventories exported; relationships, repository map and 12 open questions recorded. See `PHASE1_SUMMARY.md`.

## Phase 2 (2026-10-14) — done, read-only
Owner confirmations applied: **VASSSJEP excluded; full history; NULL-branch tags located from movement history, no guessing.**

### Deliverables
- `source-to-target-mapping.csv` — 49 mapped items with evidence grade, transformation, history handling, validation, gap/decision refs.
- `trivo-gap-analysis.md` — what TRIVO has, 6 design mismatches, 12 gaps (G1–G12), why service replay fails, GST-lock behaviour, approvals needed.
- `migration-reconciliation-plan.md` — 53 numbered checks (R-01 to R-75, with gaps in numbering by section) with source/target definitions, tolerances (proposed), duplicate/idempotency/exception/rollback rules, accounting no-double-posting rule, baseline SQL.
- `migration-runbook.md` — gated phases P1–P8, cutover, abort/rollback; a plan only.
- Extra: `gati-branch-location-findings.md` (evidence and confidence for every classification) and `branch-location-exceptions.csv` (214 tag-level exceptions: 212 dispatched/receipt-not-found, 2 clone-without-receipt; ids, branch codes, document number/date, age only).
- `DECISIONS.md` updated (owner confirmations, evidence-based answers to old Q1/2/3/5/6/8, new decisions D13–D33).

### Key findings
1. 59,839 `Inward` rows are only **35,384 physical pieces**: a branch transfer clones the tag (same `JewelCode`, new `JewelId`); exactly one "tip" per piece.
2. **NULL `BranchNo` = head office ("Self")** — proven by 24,175 receipts + 24,389 issues agreeing with their book's branch (0 mismatches) and by GATI's own code. 38,751 NULL rows = 18,161 tips + 20,590 superseded instances. Tips: 9,850 current stock at HO (7,672 of them rely on the structural rule only), 63 dispatched-not-received, 8,248 sold from HO. Confirmed-in-transit 0 (GATI cannot distinguish); contradictory 0 among NULL rows.
3. All branches: **212 transfers issued, receipt not found** (GATI's own pending-report definition) and **2 clones with no receipt document**.
4. Deletes are physical and edits in place: no cancelled/superseded document exists to filter; history is a derived ledger and agrees with status 100 % (0 mismatches).
5. Original tags have **no** purchase/bag/order/supplier link. Transfer clones carry a different cost than their source for 2,520 of 24,177 tags.
6. TRIVO has no source-id field, no historical loader, no loadable movement history, no way to preserve tag numbers or document numbers via its services, and would double-post accounting if history were replayed. GST guards block only against filed periods that exist; a fresh company has none.
7. Accounting: `AccountBalance` for FY2 equals the FY1 journal closing for 1,831 of 1,859 parties (28 differ); `DueDetail` does not tie to journals.

### Queries and investigations performed (all read-only)
- Catalog/aggregate `SELECT`s on `VASDSJEP` and `VASDLog` via `sqlcmd -S .\SQL22 -E` with `ApplicationIntent=ReadOnly` and `READ UNCOMMITTED`: status/type/branch distributions, instance chains (`NewJewelId`, `Inline_ToJewelId`), history consistency checks, document/book/party/branch structure, journal/settlement/due/account-balance aggregates, cost-component checks, stock-take coverage, delete/edit-log shape.
- Definitions read (code only, no data): `InwardStatusView`, `InwardHistory_Insert`, `Inward_History_Regenerate`, `Reversal_UpdateInwardStatus`, `BranchPendingVerification_Report`, `JewelTransInward_RegenerateSaleId`, `Inward_DeleteData`, `JewelTrans_Delete` (head), `delete_log_Insert`, `JewelStockReconsilation_Snap_Generate`; trigger list (41, none on tag/document/journal tables).
- TRIVO: repository reads only (schema models, migrations, `sales.service.ts`, `tagging.service.ts`, `finance.service.ts`, `numberSequence.ts`, `gstr3bFilingProtection.ts`, tag-history migration). **No TRIVO database was connected to.**

### Limitations
- Counts are from the live GATI database and drifted during the session (two A→X changes); everything quantitative needs re-baselining on a restored backup.
- Used the same Windows-admin integrated session as Phase 1 (read-only statements); no least-privilege login or restored copy existed. No data was modified, no DDL run, nothing installed, no secrets read.
- Not read/characterised: offline/online-branch procedures (`Inward_ImportOnlineBranchData`, `OnlineBranch_Auto_MemoIssue`), `JewelTransInward_Insert_Update`, `Inward_ItemStatusReport`, GATI business reports, e-invoice/Tally/Shopify tables, `JewelTransProceed` (approval returns), voucher kinds, the HUID column location.
- `InOutType` numeric meanings and the `Delete_Log.TransMode` semantics are inferred, not documented.

## Next (only on the owner's instruction)
1. Owner reviews the five documents and answers D13–D33 (blocking: D13–D18, D20, D22, D23, D27).
2. Owner provides a restored backup path/login (or approves one) and GATI's own stock/outstanding/GST reports.
3. Re-baseline the counts on the frozen copy and regenerate `branch-location-exceptions.csv`.
4. Only then: approve Phase 3 (schema additions + reviewed loader) as a separate, scoped piece of work.
