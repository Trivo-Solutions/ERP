# GATI → TRIVO Migration: Reconciliation Plan (Phase 2 — plan only, nothing executed)

Date: 2026-10-14. Scope: `VASDSJEP` only (VASSSJEP excluded by owner), **full history** (2025-10-15 → cutover). All "observed" figures below were read from the **live** GATI database on 2026-10-14 and the live database changed while they were being read (two tags moved A→X). They are *indicative only*; the authoritative baseline must be taken from a frozen, restored backup (§1). Tolerances in §9 are **proposals for owner approval**, not agreed rules. Decision numbers (D13+) are in `DECISIONS.md`.

## 0. Principles

1. **Source = frozen backup, target = staging company**, never live GATI vs live TRIVO.
2. **Reconcile on both sides with the same definition.** Every check names its source query, its target query, a unit and a tolerance; the two are written once and reviewed before any data moves.
3. **Nothing disappears silently.** For every entity: `source rows = imported + excluded (reason code) + quarantined (reason code)`. Exclusions and quarantines are listed, not counted away.
4. **A non-zero unexplained difference stops the run** and needs the owner's written approval (§9). Explained rounding differences are classified, never netted into other differences.
5. **Accounting history is imported or re-derived exactly once** (§6). Anything that would double-post is a failed check, not a warning.
6. Reconciliation reports contain counts, sums and internal ids only — no party names, phones, addresses, PAN/Aadhaar/GSTIN — and are kept out of Git unless aggregate-only.

## 1. Baseline (before any import is designed further)

- Restore the most recent GATI backup (`D:\GATISOFTTECH\SJEP BACKUP\…`, format unverified) to a **separate** SQL Server database on a non-production instance; record backup file name, size, SHA-256, restore time. Do not run baseline queries on live `VASDSJEP`.
- Use a dedicated least-privilege read-only SQL login on that copy (db_datareader on `VASDSJEP` copy and `VASDLog` copy only).
- Freeze point: record `MAX(EntryDate/UpdateDate)` across `Inward`, `JewelTrans`, `Journal`, `VoucherEntry`; the final cutover re-baseline uses the same queries at the cutover freeze (runbook §5).
- Capture GATI's own reports for the same date as the independent authority: stock register by branch, party outstanding, day book/sales register for sample months, filed GSTR-1/3B figures per period. Owner must supply them (D23, D20); without them GATI-vs-GATI agreement is the only evidence.

## 2. Check catalogue

"Observed" = live 2026-10-14, indicative. Target side is always measured on the staging TRIVO company through `tenantQuery` reads (or an owner-role read with RLS context) — decided in the runbook.

### 2.1 Tags

| ID | Check | Source measure | Target measure | Tolerance | Observed (indicative) |
|---|---|---|---|---|---|
| R-01 | Physical pieces | `COUNT(DISTINCT JewelCode)` in `Inward` | `COUNT(*)` of `jewelry_tags` from the batch | 0 | 35,384 pieces / 59,839 rows |
| R-02 | Instance map completeness | `COUNT(*)` of `Inward` (every `JewelId`) | rows in `migration_source_map` for entity=tag-instance | 0 | 59,839 |
| R-03 | Unique tag numbers | 0 duplicate `JewelCode` per tip | `tagNumber` unique per company; 0 collisions with TRIVO-generated numbers; sequences advanced past imported ones | 0 | 0 expected |
| R-04 | One tip per piece | tips (`NewJewelId IS NULL`) per `JewelCode` = 1 | n/a (assert on source copy) | 0 violations | 1 for all 35,384 |
| R-05 | Current status | tips by `Status` | tags by mapped status, using the mapping signed off in D16 | 0 | A 21,857 · X 13,173 · V 212 · C 136 · T 6 |
| R-06 | Stock by branch × status | tips A/C/T/V by `BranchNo` (NULL→HO) | tags by `branchId` and status | 0 | HO A 9,720 C 129 T 1 V 63 · 02 A 1,490 C 2 T 5 V 66 · 03 A 4,480 C 5 V 49 · 04 A 5,699 V 33 · 05 A 468 V 1 |
| R-07 | Weights | Σ `GrossWt`, Σ `NetWt` (+`NetWtNotBase` per D22) by branch × base metal × karat for tips | Σ `grossWeight`, Σ `netWeight` same grouping | per §9 | silver 925 dominates by weight; gold 22KT/18KT/14KT; 253 HO tips (78,432 g gross) have no base metal |
| R-08 | Stone weight and pieces | Σ stone weights, Σ `ItemPieces` | Σ `stoneWeight`, Σ `noOfPcs` | per §9 | — |
| R-09 | Original cost | Σ `COST` of the chosen instance (D22) by branch × metal × karat | Σ `costPrice` | 0.00 | 1,422 tips with COST=0; 845 tags where COST ≠ Σ component cost within ₹1 (listed, not corrected) |
| R-10 | Cost components | per tag: Σ `Tot*CostAmt` and `InwardDetail.CostAmount` | Σ `JewelryTagMaterial.costAmount` + labour/VA | 0.00 per tag after the D22 rule | 57,572 of 58,417 tags with COST>0 tie within ₹1 |
| R-11 | Tag attributes | counts by category, stock type, make type, metal, karat | same | 0 | 35,139 of 35,384 tips are STOCK ORDER |
| R-12 | HUID | count and uniqueness of the chosen HUID source (D25) | `huid` | 0 | not yet located |
| R-13 | Zero/blank exceptions | list tips with zero cost, zero MRP, no base metal, zero gross | same list in target quarantine/flag | exact list match | 1,422 zero-cost; 255 zero-MRP among available |
| R-14 | Material rows | `InwardDetail` row count and Σ weight/amount for tips | `jewelry_tag_materials` | 0 | — |
| R-15 | Movement history | `InwardHistory` rows by `Trans`, `InOutType` | rows in the history table (G3) | 0 | 183,583 rows; 0 `JStatus<>Status` mismatches at source |

### 2.2 Transfers and in-transit

| ID | Check | Source | Target | Tolerance | Observed |
|---|---|---|---|---|---|
| R-20 | Issue documents | `BJWSL` docs and lines | `branch_transfers` / items | 0 | 783 docs; 24,389 lines |
| R-21 | Completed vs outstanding | lines with clone vs without | items with/without `receivedAt` | 0 | 24,177 completed + 212 outstanding |
| R-22 | Receipts matched | `BJWPH` docs and lines vs clones | matched receipt documents | 0 unexplained | 741 docs; 24,175 lines; **2 clones without a receipt line** (listed in `branch-location-exceptions.csv`, class D2) |
| R-23 | In-transit set | `BranchPendingVerification_Report` logic = V tips without `Inline_ToJewelId` | transfers `DISPATCHED`/`PARTIALLY_RECEIVED` with items `receivedAt IS NULL` and tags `TRANSFERRED` (only if D15 says so) | exact id list match | 212 (63 from HO; 61 aged ≤3 d, 26 aged 8–30 d, 82 aged 31–90 d, 43 older) |
| R-24 | Per-hop branch continuity | for every chain, hop *n*'s destination = hop *n+1*'s source | movement history | 0 breaks | holds by construction in GATI (a hop's destination row *is* the next hop's source row); the check guards the loader, not the source |
| R-25 | Transfer value | Σ journal amount `BJWSL`/`BJWPH` | per D18 (imported or excluded) | 0 or documented | ₹3,334,695,044.74 / ₹3,270,464,992.56 (gap ₹64.2 M unexplained) |

### 2.3 Sales, returns, purchases, retags, memos

| ID | Check | Source | Target | Tolerance | Observed |
|---|---|---|---|---|---|
| R-30 | Sales docs | `JWSL` docs (excluding book 98 and, per D33, estimate books) | `sales_invoices` | 0 | 8,180 JWSL docs incl. 117 in book 98 and 127 in estimate books |
| R-31 | Sales lines | `JewelTransInward` for those docs | `invoice_items` | 0 | 13,326 JWSL lines |
| R-32 | Sales totals | Σ `Amount`, Σ `GrossAmount`, Σ `TotalAddlessAmount` by month × book/branch | Σ `totalAmount`, `subtotal`, charges | 0.00 | JWSL gross ₹1,301,573,041.18, net ₹1,332,535,678.59 |
| R-33 | Invoice numbers | `JewelTransPrefix+JewelTransNo` set | `invoiceNumber` set | exact set match (G5) | — |
| R-34 | Sold tags | tips X | tags SOLD, each linked to exactly one latest invoice line | 0 | 13,173 |
| R-35 | Sale returns | `JWSR` docs, lines, Σ amount; `OriginalSaleId` resolves | `sales_returns`, items | 0 | 128 docs; 153 lines; ₹17,436,814.00 net; 153/153 resolve |
| R-36 | Purchase returns | JWSL book 98 | `purchase_returns` (D21) | 0 | 117 docs; 513 lines |
| R-37 | Purchases | `JWPH` | PO/GRN or opening stock (D21/D24) | 0 | 1 doc; 35,372 original tags have **no** purchase document |
| R-38 | Retag/repair | `InwardType='I'` rows and `Status='I'` rows | retag hops | 0 | 278 / 278 |
| R-39 | Memos | `JWAP` docs/lines; open = tips C | `memo_outs` / items; ON_APPROVAL tags | 0 | 109 docs; 6,348 lines; 136 open |
| R-40 | Price/MRP stored | Σ `MRP` of imported sold lines | Σ `unitPrice` | 0.00 (never re-priced) | — |

### 2.4 Parties and balances

| ID | Check | Source | Target | Tolerance | Observed |
|---|---|---|---|---|---|
| R-50 | Party counts | `PartyMst` by IsCustomer / IsSupplier / IsAccount / IsSalesMan (mirror branch parties excluded) | `clients` / `suppliers` / accounts / users | 0 after exclusions | 7,318 / 272 / 198 / 190 |
| R-51 | Party identity | GSTIN present/valid counts; PAN present counts | same | 0 | GSTIN checksum pass-rate to be measured |
| R-52 | Customer balances at cutover | Journal net per party (all history) **and** `AccountBalance` carry-forward | `clients.currentBalance` | 0.00 per party | customers: 759 non-zero of 6,943 with journal rows; Dr ₹2,140,837,908.97 / Cr ₹1,774,076,336.32 |
| R-53 | Supplier balances | same | `suppliers.currentDue` | 0.00 | 30 parties; Dr ₹71,420,767.08 / Cr ₹161,318.78 (a balance in the *debit* direction for a supplier needs explaining) |
| R-54 | Carry-forward | `AccountBalance` `VASD0002` per party vs journals dated ≤ 2026-03-31 | opening balance used | 0 | 1,831 of 1,859 agree; **28 differ** (₹1,398,553,457.39 absolute) — explain before cutover |
| R-55 | Outstanding authority | GATI party-outstanding report (D23) | `currentBalance` and invoice `balanceDue` | 0.00 | `DueDetail` does **not** tie to journal net (181 of 6,889 parties) and contains BJWSL/BJWPH/MPH items, so it is not used as the source |
| R-56 | Invoice-level due | per invoice: total − Σ allocated settlements | `balanceDue`, `paidAmount`, `status` | 0.00 | settlements: 14,737 headers, 46,915 detail rows; `Journal.SettlementId` is NULL, link is `SettlementDetail.Journal_Id` |

### 2.5 Journals, settlements, opening balances

| ID | Check | Source | Target | Tolerance | Observed |
|---|---|---|---|---|---|
| R-60 | Entry balance | each (TranType, TransactionId) group Σ Dr = Σ Cr | each `journal_entries.totalDebit = totalCredit` | 0.00 | by type (rows / Σ amount): JWSL 28,546 / ₹1,332,634,273.05 · VCH 10,621 / ₹623,384,406.78 · MPH 2,177 / ₹400,480,722.28 · JRN 2,114 / ₹166,320,557.07 · MSL 1,482 / ₹66,155,306.04 · BJWSL 783 / ₹3,334,695,044.74 · BJWPH 741 / ₹3,270,464,992.56 · JWSR 347 / ₹17,436,918.00 · JWPH 3 / ₹1,468.78 |
| R-61 | Totals by account by month | Σ by `DrAccountNo`/`CrAccountNo` and month | `journal_lines` by mapped `Account` and month | 0.00 | 198 account parties → chart mapping (D18) |
| R-62 | Trial balance | GATI trial balance at cutover | TRIVO `getTrialBalance(asOf)` | 0.00 | — |
| R-63 | Account.balance column | Σ posted lines per account | `accounts.balance` | 0.00 | `postJournalEntry` maintains this column; a direct loader must too |
| R-64 | No double posting | count of target journal entries with a `referenceType/Id` of an imported document = 1 | each imported document has exactly one entry from the import and **zero** from `postAutoJournalEntry` | 0 | — |
| R-65 | Settlement allocation | Σ `SettlementDetail.Amount` per settlement/party | Σ `invoice_payments.amount` per party | 0.00 | ₹2,287,892,984.86 (settlement type 0 ₹58,531,658.18 + type 1 ₹2,229,361,326.68) |
| R-66 | Voucher kinds | `VoucherEntry` by kind/mode | receipts / supplier payments / manual journals | 0 | 12,678 headers; 4,183 journal rows |
| R-67 | Metal vault | MPH/MSL + `SPM_MaterialStock` by karat | `metal_stocks` (if D29 in scope) | per §9 | 2,228 MPH / 557 MSL headers; 3,579 stock rows |

### 2.6 GST

| ID | Check | Source | Target | Tolerance | Observed |
|---|---|---|---|---|---|
| R-70 | Per month × registration | taxable value, CGST, SGST, IGST from `JewelTransAddless`+`AdSetupDetail` (per doc setup) | `invoice_items` / `tax_invoices` sums | 0.00 | JWSL: ASrNo 1 total ₹15,402,659.47 vs ASrNo 2 ₹15,392,958.47 (CGST and SGST should be equal per document; ₹9,701 difference to explain; numbering differs by setup so not conclusive) |
| R-71 | Intra vs inter-state split | docs with IGST rows vs CGST/SGST rows (resolved per `AdSetUpNo`) | `igst` vs `cgst/sgst` per invoice | 0 | JWSL add/less rows with `ASrNo` 3 total ₹128,137.30 — 3 % IGST rows in some setups, but `ASrNo` meaning varies, so indicative only |
| R-72 | Filed return agreement | filed GSTR-1/3B figures per period (owner supplies) | TRIVO regenerated figures for the same period | 0.00 or documented | not available |
| R-73 | HSN | docs by HSN | invoice lines by HSN | 0 | 14 GATI HSN codes; TRIVO master is shared reference data |
| R-74 | Period status | list of GATI-filed periods (owner supplies) | `gst_return_periods` status for each period after the D20 action | exact | none exist in TRIVO yet [U] |
| R-75 | Backdated rejects | count of documents rejected with `GSTR3B_FILED_PERIOD_IMMUTABLE` / GSTR-1 equivalent during staging load | 0 | 0 | — |

## 3. Duplicate detection

- Tags: duplicate `tagNumber` per company (target unique constraint) **and** duplicate `JewelCode` with more than one tip (source assertion).
- Documents: duplicate `(TranType, JewelTransPrefix, JewelTransNo)` across books (source) — a number reused by two books must not collapse to one invoice; duplicate invoice numbers in target.
- Journals: duplicate (`TranType`, `TransactionId`, `DrAccountNo`, `CrAccountNo`, `Amount`) groups.
- Parties: duplicate GSTIN across 7,318 customers (report, **never auto-merge**); duplicate normalised phone or name+state (report only).
- Source map: unique `(companyId, sourceSystem, sourceDb, sourceTable, sourceKey)` (G1) is the structural duplicate guard.

## 4. Rerun / idempotency tests (all on staging, before any production run)

1. **Run twice:** second run inserts 0 rows and changes 0 rows; every check in §2 still passes.
2. **Kill mid-run:** interrupt a batch after N entities; no partial entity exists (transactional batches); rerun completes; counts and checksums equal an uninterrupted run.
3. **Delta run:** change a handful of GATI rows in a *copy* (sale a tag, receive a transfer, post a voucher) → only those entities change; a deleted-in-source document is reported, not silently kept.
4. **Rollback:** roll back batch k; all rows tagged with batch k disappear, nothing else; stock, balances and journals return to the pre-batch values (R-06, R-52, R-61 pass at the earlier state).
5. **Isolation:** import into company A while company B has data; B's rows and RLS views unchanged; forged cross-company ids rejected (`npm run test:rls`, `npm run audit:tenant` clean).
6. **Concurrency:** a live TRIVO sale during an import must not touch an imported tag state mid-batch (loader holds the same row locks the services use).

## 5. Exception handling

Every exception gets a reason code and lands in a quarantine list (a report/table, not a console line). Seeded categories from this investigation: `D1` dispatched receipt not found (212); `D2` clone without receipt (2); zero-cost (1,422); cost components ≠ COST (845); no base metal (258 tips, 253 available at HO); GSTIN invalid; party without state (place of supply unresolved); `AccountBalance` ≠ journal carry-forward (28); document in an estimate book (D33); book 98 purchase returns (D21); JWSL with `AdSetUpNo` NULL (117). A run with any **unclassified** exception fails.

## 6. Accounting without double entries (the rule the whole plan rests on)

- **Never** feed history through `createInvoice` / `applyPayment` / `createSalesReturn` / `createTagFromGrnItem`: each posts its own entry and moves `Client.currentBalance` itself (`sales.service.ts:542,565,1569,1577,2120`).
- Choose **one** of (D18): **(A)** import GATI journals as TRIVO entries (grouped per document) and set balances from them; **(B)** import documents/stock with *no* journals and load a single balanced opening-balance entry at cutover plus party balances; **(C)** hybrid: full operational history without journals, journals imported only for the current financial year. Whichever is chosen, R-64 asserts exactly one origin per document.
- `AccountBalance` for `VASD0002` already is the FY1 closing carried forward (1,831/1,859 match), so for (B)/(C) the cutover balances are derived from journals and compared to it, not added to it.
- Inter-branch BJWSL/BJWPH journals (₹3.3 B) are reconciled in both directions (R-25) before D18 is closed.

## 7. Cutover reconciliation

At the freeze: re-run §1 on a fresh backup, re-run R-01…R-75 on the final staging load, compare the two result sets line by line, then (and only then) run the production load and re-run the same set. Differences between staging and production run results are exceptions in their own right.

## 8. Evidence and sign-off

Each run produces: run id, source backup hash, target company id, batch id, per-check source value / target value / difference / disposition, the exception list, and an approver line per non-zero difference. Stored outside Git (aggregate-only extracts may be committed). The owner signs the final run; nobody else can accept a non-zero unexplained difference.

## 9. Proposed tolerances (for approval)

| Quantity | Proposed tolerance | Basis |
|---|---|---|
| Counts (tags, documents, lines, parties, rows) | **0** | no rounding involved |
| Instance/chain integrity, in-transit id list, unique numbers | **0** | exact set equality |
| Weights | per-tag equal at TRIVO's 4 dp; aggregate difference **0.0000 g** after rounding each tag the same way on both sides | TRIVO `Decimal(10,4)`; GATI `numeric` scale unverified [U] |
| Money, per document and per party | **₹0.00** after the agreed rounding rule | GATI `money` has 4 dp, TRIVO 2 dp — the rounding rule (per line vs per document) must be fixed first and then differences are 0 |
| Money, explained rounding | listed individually; cumulative cap to be agreed (not invented here) | — |
| Anything else non-zero and unexplained | **not tolerated without owner approval** | owner requirement |

## Appendix A — Baseline SQL (to run on the restored copy; read-only)

```sql
-- tips and status
SELECT Status, COUNT(*) FROM Inward WHERE NewJewelId IS NULL GROUP BY Status;
-- pieces
SELECT COUNT(DISTINCT JewelCode) FROM Inward;
-- stock by branch x metal (A, C, T tips)
SELECT ISNULL(i.BranchNo,'HO') br, i.Status, v.ItemCode, COUNT(*) tags,
       SUM(s.GrossWt) gross, SUM(s.NetWt+s.NetWtNotBase) net, SUM(s.COST) cost
FROM Inward i JOIN InwardSummary s ON s.JewelId=i.JewelId
LEFT JOIN SPM_ItemView v ON v.ItemId=s.BaseMetalId
WHERE i.NewJewelId IS NULL AND i.Status IN ('A','C','T')
GROUP BY i.BranchNo, i.Status, v.ItemCode;
-- unreceived transfers (GATI's own definition)
SELECT i.JewelId FROM Inward i
JOIN JewelTrans t ON t.JewelTransId=i.SaleId AND t.TranType='BJWSL'
WHERE i.Status='V' AND i.NewJewelId IS NULL;
-- documents by type
SELECT TranType, COUNT(*), SUM(GrossAmount), SUM(Amount) FROM JewelTrans GROUP BY TranType;
-- journals by type
SELECT TranType, COUNT(*), SUM(Amount) FROM Journal GROUP BY TranType;
```
