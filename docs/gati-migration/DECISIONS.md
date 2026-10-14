# Decisions

| Date | Decision | Rationale | Approved by |
|---|---|---|---|
| 2026-10-14 | Phase 1 discovery only; no migration code, schema change, install, or import. | Per GATI_MIGRATION.md sections 4 and 10. | Project owner (instruction) |
| 2026-10-14 | GATI source engine recorded as SQL Server 2022 `.\SQL22`, database `VASDSJEP`. | Observed, not assumed. | n/a (evidence) |
| 2026-10-14 | **Exclude VASSSJEP (the "Z" company).** Required migration scope is `VASDSJEP` only. | Owner instruction (answers old Q1). | Project owner |
| 2026-10-14 | **Migrate full historical data**, including relevant tag/stock and transaction history; accounting history must not create duplicate journals, balances or stock postings. | Owner instruction (answers old Q8's scope; the *method* is D18). | Project owner |
| 2026-10-14 | Tags with NULL `Inward.BranchNo` are to be located from transaction/movement history; **no guessing**. Classifications are evidence labels, not TRIVO statuses. | Owner instruction. Evidence in `gati-branch-location-findings.md`. | Project owner |
| 2026-10-14 | **`Inward.BranchNo IS NULL` ("Self") = TRIVO's Manikonda branch.** The names differ between the systems but they are the same physical branch. Support: owner confirmation plus a report cross-check: GATI's current-stock report, downloaded 2026-10-14 at 11:10 PM after all stores had closed with no transactions taking place, was compared with `null-branch-jewelcode-verification.csv` by Excel VLOOKUP on `JewelCode`; 9,715 JewelCodes matched Manikonda (recorded as `Self` in `PhysicalLocationVerified`). This is a report-to-report match, **not a physical stock count**. The source value `NULL` is preserved on every record. | Owner confirmation + VLOOKUP against the GATI current-stock report. Closes the NULL/Self half of D13. | Project owner |
| 2026-10-14 | **Eight unresolved JewelCodes are assigned TEMPORARILY to Branch 05 in the migration working mapping, for operational tracking only** (`VerifiedBranch` = `05`): dispatched/receipt not found (6) SBNG00665, SBRC00044, SRNG02917, SRNG02960, SBTM00018, SBTM00023; split instance (1) SBNG00091; transfer-receipt anomaly (1) SNEC00463. This is a provisional, owner-directed assignment, **not** evidence that Branch 05 is their physical location and not a verification: their `PhysicalLocationVerified` stays `#N/A`, their `SourceBranchNo` stays `NULL` (never rewritten to 05), and all source evidence is retained. Branch 05's own physical identity is still unverified (D13). | Owner instruction; the report did not match these eight, so no evidence places them anywhere. | Project owner |
| 2026-10-14 | Phase 2 is read-only investigation and documentation. No import code, DDL, writes, installs or TRIVO database access; the TRIVO database is not queried until the owner approves the exact target and access method. | Owner instruction. | Project owner |

## Findings that change earlier questions (evidence, not decisions)

- **Old Q3 (NULL branch):** proven from documents — `BranchNo IS NULL` is one consistent source location that GATI's application calls "Self" (24,175 receipts and 24,389 issues agree with their book's branch, 0 mismatches; GATI's own code treats NULL as a branch). **Which physical location it is was NOT proven by the documents; the owner has since confirmed it is Manikonda (see D13 and the owner-decision rows above).** After the owner's 2026-10-14 clarification (four retail branches + HO) the evidence points to **Manikonda**, not HO (company address in Manikonda; mirror parties named "01 MANIKONDA"; 4,898 retail tax invoices; no "Himayathnagar" anywhere in the source). The earlier "NULL = head office" wording came from GATI's "(HO)" transfer-book labels and is withdrawn. See `gati-branch-location-findings.md` §3a → **D13**.
- **Old Q2 (status meanings):** A = available, X = sold, V = issued on a branch transfer, C = on approval/memo are supported by documents and GATI's own delete/status code; I = retag/inward-repair source and T = split instance are mechanism-proven but their business labels are not. → **D16**.
- **Old Q6 (cancel/edit):** GATI deletes documents physically (history rows removed, tag reverted) and edits in place; there is no cancelled-document state to filter. `Delete_Log` is an audit trail with no content and does not reconcile to live counts.
- **Old Q5 (how 59k tags arrived):** the 59,839 rows are only 35,384 physical pieces; 35,372 are originals with **no** purchase document, bag, order or supplier link; the rest are branch-transfer/retag clones.

## Unresolved questions from Phase 1 (status)

1. ~~VASD vs VASS~~ — **resolved: VASDSJEP only.**
2. Meaning of `Inward.Status` codes and each `TranType` — partially evidenced, owner sign-off outstanding (**D16**).
3. NULL-branch meaning — consistent source value; **owner-confirmed 2026-10-14 as Manikonda** (**D13**). Branch `05` is still unnamed and unverified; nothing in the source says it is HO/Himayathnagar.
4. Branches — **answered by the owner 2026-10-14:** four retail branches (Manikonda, Jubilee Hills, Vanasthalipuram, Vizag) + one Head Office (HO / Himayathnagar). GATI has five source values: NULL/Self, 02, 03, 04, 05; the mapping is in D13 (**D13**).
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
| D13 | **Five physical locations (owner, 2026-10-14):** Manikonda, Jubilee Hills, Vanasthalipuram, Vizag (retail) and HO / Himayathnagar. The original GATI source value is preserved on every record; the approved mapping is kept separately (see table below). **NULL/Self = Manikonda is now confirmed (owner + stock-report VLOOKUP).** Still open: what Branch `05` physically is, and which GSTIN each branch bills under. Eight records are provisionally tracked at `05` (below) without verifying it. | Confirm what `05` is and the branch-to-GSTIN map. Create 5 TRIVO Branch rows only after those are confirmed. |
| D14 | Tag identity: one TRIVO tag per `JewelCode` (35,384) built from the chain tip, GATI instances kept as history. | Yes; importing 59,839 rows as tags would multiply stock. |
| D15 | The 212 transfers issued but not received (63 from NULL/Self; 61 within 3 days, 26 at 8–30 d, 82 at 31–90 d, 43 older) plus 2 clones with no receipt document: physically verify before cutover? Import as in-transit (`TRANSFERRED` + dispatched transfer) or hold? Which age threshold means "in transit"? | Physical count first; import only the verified-in-transit as `TRANSFERRED`. |
| D16 | Sign off status letters (A, X, V, C, I, T) and TranType meanings (JWSL sale; BJWSL/BJWPH transfer issue/receive; JWSR sale return; JWAP memo, PJWAP its return; JWPH purchase; JWPRM proforma; JWSL book 98 = purchase returns). | Sign off with a GATI stock report. |
| D17 | Replay history through TRIVO services (rejected by analysis: re-numbers, re-prices, re-posts, re-applies today's rules) or build a reviewed historical loader. | Loader (needs approved schema changes, gap-analysis §8). |
| D18 | Accounting history: import GATI journals as entries, or documents without journals + one opening entry, or hybrid; chart-of-accounts mapping for 198 account parties; treatment of ₹3.3 B inter-branch BJWSL/BJWPH journals; Metal Vault postings. | Decide with the accountant; whichever, exactly one origin per document. |
| D19 | Document numbers: keep GATI invoice/credit/receipt numbers verbatim (already printed and filed) — TRIVO's services cannot. | Keep verbatim (loader). |
| D20 | GST history: how historical periods (2025-11 → cutover, already filed from GATI) are represented — mark FILED via a controlled one-time path, or leave open; per-line GST allocation from document-level add/less; GSTR figures to reconcile against (owner supplies). | Mark filed; reconcile to filed returns. |
| D21 | Purchase returns filed as JWSL book 98 (117 docs, 513 lines, no GRN): import as `PurchaseReturn` history? Counterparty? Which of 1 `JWPH` and the rest is purchase history. | Import as purchase-return history, not sales. |
| D22 | "Original cost": which GATI field (`COST`, `ActualCost`, or the component sum) and which instance (the original `R` row, not the transfer-repriced clone — 2,520 clones differ); treatment of 1,422 zero-cost tips and 845 tags where components ≠ `COST`; whether `NetWtNotBase` is part of net weight; stone weight units. | Original-instance `COST`; exceptions to the owner. |
| D23 | Authoritative outstanding balances: GATI party-outstanding report (DueDetail does not tie to journals and includes branch/material items); the 28 parties whose `VASD0002` carry-forward ≠ FY1 closing; supplier balances in debit. | Owner supplies the report. |
| D24 | How the 35,372 original tags (no purchase document) enter TRIVO: opening stock with no GRN/PO, and what accounting entry (if any) they carry. | Opening stock without GRN. |
| D25 | Master mappings: make types (metal vs style mixed), karat/purity (G22KT→22K etc.; silver), HSN list, brand/gender/size/hallmark lists, HUID source column (unlocated), the 253 NULL/Self tips with no base metal. | — |
| D26 | Parties: customer/dealer typing; PII handling (7,318 customers); users for 190 sales persons; blacklist semantics; duplicate GSTINs (report, never merge). | — |
| D27 | Target: which PostgreSQL database/company is staging and production; who approves read access; run the loader as `trivo_runtime` through tenant context (no BYPASSRLS). | Staging first. |
| D28 | History fidelity: GATI created/updated user and time, the immutable audit trail (import events; GATI logs archived outside TRIVO). | — |
| D29 | Is the Metal Vault (MPH 2,228 / MSL 557 headers, `SPM_MaterialStock` 3,579) in scope? | — |
| D30 | Memo/approval: import only open memos (136 tags) or all 109 documents; `returnDeadline` has no source. | — |
| D31 | Retag/inward-repair (278 hops) → `TagRetag` or plain chain hops; repair-stock-type tags (7+1). | — |
| D32 | Past physical stock-takes (5 sessions, 12,617 snapshot rows, no location recorded): import as `StockAudit` history or archive only. | Archive only. |
| D33 | "Estimate Invoice" / "Estimate Sale Returns" books (127 JWSL + 19 JWSR docs): are these GST documents or quotations? Do not create tax invoices until answered. | — |

### D13 — source value → physical location mapping (status per row)

| Source `Inward.BranchNo` (preserved) | GATI label | Physical location | Status | Basis |
|---|---|---|---|---|
| `0001002463` ("02") | 02 JUBILEE HILLS | Jubilee Hills (retail) | **Confirmed** | Name; own GSTIN (state 36) |
| `0002000604` ("03") | 03 VANSTHALIPURAM | Vanasthalipuram (retail) | **Confirmed** | Name; own GSTIN (state 36) |
| `0002001819` ("04") | 04 VIZAG | Vizag (retail) | **Confirmed** | Name; own GSTIN (state 37) |
| `NULL` (GATI: "Self") | mirror parties "01 MANIKONDA"; transfer books "(HO)" | Manikonda (retail) | **Confirmed by owner (2026-10-14)** | Owner confirmation; 9,715 JewelCodes matched Manikonda in GATI's current-stock report (downloaded 2026-10-14 11:10 PM, stores closed, no transactions) by Excel VLOOKUP. Also consistent with the registry address, 4,898 retail tax invoices and the "01 MANIKONDA" mirror parties. Not a physical count. The "(HO)" book label is GATI's label only. |
| `NULL` — 8 JewelCodes only (6 dispatched/receipt not found, 1 split instance, 1 transfer-receipt anomaly) | not matched by the stock report (`PhysicalLocationVerified` = `#N/A`) | **Branch 05 — temporary working assignment, owner-directed** | **Provisional / unverified** | Owner instruction for operational tracking. Held in `VerifiedBranch`; source `NULL` preserved. Not evidence of physical location. Revisit when 05 and these pieces are physically resolved (D15). |
| `0002004959` ("05") | "05" (no name/city/GSTIN) | HO / Himayathnagar? | **Pending verification** — no evidence for or against; the provisional 8-record assignment above does not change this | New (2026-09-10), no sales, stock hub pattern; but carries the full retail book template and nothing names it HO. Not interchangeable with NULL. |

Naming of HO as "HO / Himayathnagar" comes from the owner's statement only; **no source record mentions Himayathnagar**. Until D13 is fully closed, documents use the source value (`NULL/Self`, `05`) and never "HO" for either; NULL/Self may be described as mapped to Manikonda. No stock is reclassified by this table.
