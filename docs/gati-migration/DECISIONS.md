# Decisions

| Date | Decision | Rationale | Approved by |
|---|---|---|---|
| 2026-10-14 | Phase 1 discovery only; no migration code, schema change, install, or import. | Per GATI_MIGRATION.md sections 4 and 10. | Project owner (instruction) |
| 2026-10-14 | GATI source engine recorded as SQL Server 2022 `.\SQL22`, database `VASDSJEP`. | Observed, not assumed. | n/a (evidence) |
| 2026-10-14 | **Exclude VASSSJEP (the "Z" company).** Required migration scope is `VASDSJEP` only. | Owner instruction (answers old Q1). | Project owner |
| 2026-10-14 | **Migrate full historical data**, including relevant tag/stock and transaction history; accounting history must not create duplicate journals, balances or stock postings. | Owner instruction (answers old Q8's scope; the *method* is D18). | Project owner |
| 2026-10-14 | Tags with NULL `Inward.BranchNo` are to be located from transaction/movement history; **no guessing**. Classifications are evidence labels, not TRIVO statuses. | Owner instruction. Evidence in `gati-branch-location-findings.md`. | Project owner |
| 2026-10-14 | Phase 2 is read-only investigation and documentation. No import code, DDL, writes, installs or TRIVO database access; the TRIVO database is not queried until the owner approves the exact target and access method. | Owner instruction. | Project owner |

## Findings that change earlier questions (evidence, not decisions)

- **Old Q3 (NULL branch):** proven rule from documents — `BranchNo IS NULL` is the head-office/"Self" location (24,175 receipts and 24,389 issues agree with their book's branch, 0 mismatches; GATI's own code treats NULL as a branch). The *name* "01 MANIKONDA" is inferred from mirror-party names. Needs owner confirmation → **D13**.
- **Old Q2 (status meanings):** A = available, X = sold, V = issued on a branch transfer, C = on approval/memo are supported by documents and GATI's own delete/status code; I = retag/inward-repair source and T = split instance are mechanism-proven but their business labels are not. → **D16**.
- **Old Q6 (cancel/edit):** GATI deletes documents physically (history rows removed, tag reverted) and edits in place; there is no cancelled-document state to filter. `Delete_Log` is an audit trail with no content and does not reconcile to live counts.
- **Old Q5 (how 59k tags arrived):** the 59,839 rows are only 35,384 physical pieces; 35,372 are originals with **no** purchase document, bag, order or supplier link; the rest are branch-transfer/retag clones.

## Unresolved questions from Phase 1 (status)

1. ~~VASD vs VASS~~ — **resolved: VASDSJEP only.**
2. Meaning of `Inward.Status` codes and each `TranType` — partially evidenced, owner sign-off outstanding (**D16**).
3. NULL-branch rule — evidenced, owner confirmation outstanding (**D13**). Branch `05` is live but unnamed; branch `01` is the implicit HO.
4. Four live branches vs a fifth — GATI has HO + 02, 03, 04, 05 (**D13**).
5. Original-cost definition — see **D22**; arrival of stock — see **D24**.
6. Cancel/edit representation — answered above.
7. Workflows actually used — still open (partly evidenced: memo/approval JWAP used, retag/repair used, material purchase/sale MPH/MSL used; Shopify, Tally, e-invoice, manufacturing not examined).
8. History depth — scope = full history (decided); method = **D18**.
9. Interaction with auto-journals and GST locks — analysed in `trivo-gap-analysis.md`; choices **D17, D18, D20**.
10. Target environment and read-only access — **D27**.
11. Authoritative reports and tolerances — **D23**, tolerances proposed in the reconciliation plan §9.
12. `SmartOfficedb` / `C:\db-backups\vasavi_jewelry_db` — still open; not investigated.

## New open decisions raised by Phase 2 (owner input needed)

| # | Decision needed | Recommendation (not binding) |
|---|---|---|
| D13 | Confirm `BranchNo IS NULL` = head office; its name/code (01 MANIKONDA?); the branch inventory for TRIVO (HO + 02, 03, 04, 05 — what is 05 called?); which GSTIN each branch bills under. | Confirm; create 5 Branch rows. |
| D14 | Tag identity: one TRIVO tag per `JewelCode` (35,384) built from the chain tip, GATI instances kept as history. | Yes; importing 59,839 rows as tags would multiply stock. |
| D15 | The 212 transfers issued but not received (63 from HO; 61 within 3 days, 26 at 8–30 d, 82 at 31–90 d, 43 older) plus 2 clones with no receipt document: physically verify before cutover? Import as in-transit (`TRANSFERRED` + dispatched transfer) or hold? Which age threshold means "in transit"? | Physical count first; import only the verified-in-transit as `TRANSFERRED`. |
| D16 | Sign off status letters (A, X, V, C, I, T) and TranType meanings (JWSL sale; BJWSL/BJWPH transfer issue/receive; JWSR sale return; JWAP memo, PJWAP its return; JWPH purchase; JWPRM proforma; JWSL book 98 = purchase returns). | Sign off with a GATI stock report. |
| D17 | Replay history through TRIVO services (rejected by analysis: re-numbers, re-prices, re-posts, re-applies today's rules) or build a reviewed historical loader. | Loader (needs approved schema changes, gap-analysis §8). |
| D18 | Accounting history: import GATI journals as entries, or documents without journals + one opening entry, or hybrid; chart-of-accounts mapping for 198 account parties; treatment of ₹3.3 B inter-branch BJWSL/BJWPH journals; Metal Vault postings. | Decide with the accountant; whichever, exactly one origin per document. |
| D19 | Document numbers: keep GATI invoice/credit/receipt numbers verbatim (already printed and filed) — TRIVO's services cannot. | Keep verbatim (loader). |
| D20 | GST history: how historical periods (2025-11 → cutover, already filed from GATI) are represented — mark FILED via a controlled one-time path, or leave open; per-line GST allocation from document-level add/less; GSTR figures to reconcile against (owner supplies). | Mark filed; reconcile to filed returns. |
| D21 | Purchase returns filed as JWSL book 98 (117 docs, 513 lines, no GRN): import as `PurchaseReturn` history? Counterparty? Which of 1 `JWPH` and the rest is purchase history. | Import as purchase-return history, not sales. |
| D22 | "Original cost": which GATI field (`COST`, `ActualCost`, or the component sum) and which instance (the original `R` row, not the transfer-repriced clone — 2,520 clones differ); treatment of 1,422 zero-cost tips and 845 tags where components ≠ `COST`; whether `NetWtNotBase` is part of net weight; stone weight units. | Original-instance `COST`; exceptions to the owner. |
| D23 | Authoritative outstanding balances: GATI party-outstanding report (DueDetail does not tie to journals and includes branch/material items); the 28 parties whose `VASD0002` carry-forward ≠ FY1 closing; supplier balances in debit. | Owner supplies the report. |
| D24 | How the 35,372 original tags (no purchase document) enter TRIVO: opening stock with no GRN/PO, and what accounting entry (if any) they carry. | Opening stock without GRN. |
| D25 | Master mappings: make types (metal vs style mixed), karat/purity (G22KT→22K etc.; silver), HSN list, brand/gender/size/hallmark lists, HUID source column (unlocated), the 253 HO tips with no base metal. | — |
| D26 | Parties: customer/dealer typing; PII handling (7,318 customers); users for 190 sales persons; blacklist semantics; duplicate GSTINs (report, never merge). | — |
| D27 | Target: which PostgreSQL database/company is staging and production; who approves read access; run the loader as `trivo_runtime` through tenant context (no BYPASSRLS). | Staging first. |
| D28 | History fidelity: GATI created/updated user and time, the immutable audit trail (import events; GATI logs archived outside TRIVO). | — |
| D29 | Is the Metal Vault (MPH 2,228 / MSL 557 headers, `SPM_MaterialStock` 3,579) in scope? | — |
| D30 | Memo/approval: import only open memos (136 tags) or all 109 documents; `returnDeadline` has no source. | — |
| D31 | Retag/inward-repair (278 hops) → `TagRetag` or plain chain hops; repair-stock-type tags (7+1). | — |
| D32 | Past physical stock-takes (5 sessions, 12,617 snapshot rows, no location recorded): import as `StockAudit` history or archive only. | Archive only. |
| D33 | "Estimate Invoice" / "Estimate Sale Returns" books (127 JWSL + 19 JWSR docs): are these GST documents or quotations? Do not create tax invoices until answered. | — |
