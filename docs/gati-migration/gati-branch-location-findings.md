# GATI Branch / Location Findings (Phase 2, source: `VASDSJEP`, read-only)

Date: 2026-10-14. Scope per owner: `VASDSJEP` only (VASSSJEP excluded). Evidence tags: **[C]** Confirmed by a query or by reading GATI's own code; **[H]** Hypothesis (inferred, not proven); **[U]** Unresolved. All counts were taken from the **live** database, which kept changing while I worked (two tags moved A→X between two of my queries), so every count is "as observed on 2026-10-14" and must be re-taken from a frozen restored backup before use as a reconciliation baseline. No customer, party, phone, address, ID-number or GSTIN data is in this document; branch names are the four already in Phase 1.

## 1. The model is not what Phase 1 assumed: a tag is a chain of instances

- [C] `Inward` has 59,839 rows but only **35,384 distinct `JewelCode`** values (the printed tag number / barcode). Each `JewelCode` has a chain of 1 to 11 `Inward` rows (`JewelId` = the row; `JewelCode` = the physical piece).
- [C] Every branch-to-branch transfer **creates a new `Inward` row** at the destination with the **same `JewelCode`** and a new `JewelId`. The old row is marked `Status='V'` and its `NewJewelId` points at the new row (24,177 of 24,389 `V` rows have it; the same id is stored as `JewelTransInward.Inline_ToJewelId` on the issuing document line, 24,177 of 24,177 match). Each clone is referenced by exactly one source (no merges, no shared targets); 6,154 clones were themselves transferred onward (multi-hop chains).
- [C] `Inward.InwardType`: `R` = original (35,372; never a clone target; **all** have `BranchNo` NULL), `W` = transfer clone (24,177; `PurchaseId` → its receiving `BJWPH` document), `I` = retag/repair clone (278; same `JewelCode`, same branch as its source), `T` = split instance (12).
- [C] **Exactly one "tip" per `JewelCode`** — the row with `NewJewelId IS NULL` (35,384 tips; the tip is always the highest `JewelId`). The tip is the only row that can be physical stock. GATI's own `InwardStatusView` uses the same idea (`MaxJewelId` per `JewelCode`).
- Consequence: "tags missing `BranchNo`" is a property of **rows**; a stock question must be asked of **tips**. Of the 38,751 NULL-branch rows, 18,161 are tips and 20,590 are superseded instances.

## 2. Status letters (`Inward.Status`) — what the evidence supports

| Letter | Rows | Tips | Evidence | Confidence |
|---|---|---|---|---|
| A | 21,857 | 21,857 | Available. `InwardStatusView` maps `A→0`; `JewelTrans_Delete` reverts a deleted sale to `A`; 100% of A rows' last history is receive/return/never-moved. | [C] |
| X | 13,173 | 13,173 | Sold. Every X row has `SaleId` → a `JWSL` document (13,173/13,173); `JewelTrans_Delete` expects `X` for JWSL. | [C] |
| V | 24,389 | 212 | Issued on a branch-transfer document. Every V row has `SaleId` → a `BJWSL` document; `JewelTrans_Delete` expects `V` for BJWSL; `BranchPendingVerification_Report` treats `V` with no `Inline_ToJewelId` as "pending". | [C] |
| C | 136 | 136 | On approval/memo (`JWAP` is last history; `JewelTrans_Delete` expects `C` for JWAP). | [C] |
| I | 278 | 0 | Retag / inward-repair source row: `InwardStatusView` comment "4 = only for Inward Repair Receive"; clone is type `I`, same `JewelCode`, same branch (278/278). | [C] mechanism, [H] business label |
| T | 6 | 6 | Split instance (`InwardStatusView`: `T`,`K` → "can be split / memo-split"). | [H] |

Other letters (`B L P R D E G J S U K M`) appear in GATI code but **no row has them today** [C].

## 3. How a tag's current branch is determined

- [C] `Inward.LocationId`, `FirstLocationId`, `InwardHistory.LocationId`, `JewelTrans.LocationId`, `JewelTransInward.LocationId`: **NULL on every row** (all tables checked). Location is carried by exactly one field: `Inward.BranchNo`.
- [C] Branch documents are issued from **per-branch books** (`BookMaster.BranchNo`). GATI names them "(HO)", "(B2)", "(B3)", "(B4)", "(B5)"; the book labelled "(HO)" has `BookMaster.BranchNo` NULL. **That label is GATI's, not a verified business identity** — see §3a. The destination is `JewelTrans.PartyNo` — a mirror party whose name is the *counterpart* location (e.g. party "01 MANIKONDA" viewed from branch 02).
- [C] **Agreement test (all documents that exist):** for the 24,175 `BJWPH` receipts, the clone's `BranchNo` equals the receiving book's branch in 24,175/24,175 (including 3,228 where both are NULL = "Branch Receive (HO)"). For the 24,389 `BJWSL` issues, the source row's `BranchNo` equals the issuing book's branch in 24,389/24,389 (20,504 NULL on "Branch Transfer (HO)"). For every tip whose last history row carries a document book (A via JWSR/PJWAP, C/JWAP, V/BJWSL, X/JWSL — 15,670 tips), **0 disagree**. Destination check: the clone's branch equals the issue document's destination party in 24,055 of the 24,177 transfer clones with 0 mismatches (the other 122 have a retag instance as their source and were excluded from this test).
- [C] GATI's own code treats NULL as a real branch: `BranchPendingVerification_Report` prints `IsNull(FirmName,'Self')` for a NULL `BranchNo`; `JewelStockReconsilation_Snap_Generate` joins `IsNull(Inw.BranchNo,'') = IsNull(BR_Branch.BranchNo,'')`.
- [C] There is **no `PartyMst` row for the NULL/Self location itself**. "01 MANIKONDA" exists only as mirror/counterpart rows (`0001002464`, `0002000605`, ...). The four inline-branch parties are 02 (Jubilee Hills), 03 (Vanasthalipuram), 04 (Vizag), 05 (unnamed). Between them they carry 2 distinct GST registrations and one party (05) has none (counts only; no numbers recorded here).
- **Conclusion [C]:** `BranchNo IS NULL` is a single, consistent source location that GATI's application calls "Self". The source value is preserved as-is (`NULL`); **which of the owner's five physical locations it is** is addressed in §3a and is not settled by this section.
- [C] No tag was ever created directly at a branch: all 35,372 `R` originals are NULL-branch. Branch stock only ever arrives via `BJWPH` receipt.

## 3a. Source value → physical location (owner clarification 2026-10-14; mapping status marked per row)

Owner's five physical locations: **Manikonda** (retail), **Jubilee Hills** (retail), **Vanasthalipuram** (retail), **Vizag** (retail), **HO / Himayathnagar** (head office). The original source value is always preserved; the approved mapping is a separate, later artifact (D13). Nothing here reclassifies stock or alters any database.

| Source value (preserved) | GATI name / label | Candidate physical location | Status |
|---|---|---|---|
| `02` (party `0001002463`) | "02 JUBILEE HILLS" | Jubilee Hills | **Confirmed** (name; own GSTIN prefix 36, Telangana) |
| `03` (party `0002000604`) | "03 VANSTHALIPURAM" | Vanasthalipuram | **Confirmed** (name; GSTIN prefix 36) |
| `04` (party `0002001819`) | "04 VIZAG" | Vizag | **Confirmed** (name; GSTIN prefix 37, Andhra Pradesh) |
| `NULL` ("Self") | mirror parties named "01 MANIKONDA"; GATI book labels "(HO)" | **Manikonda** (HO is *not* supported) | **Confirmed by owner 2026-10-14** — see "Owner confirmation" below |
| `05` (party `0002004959`) | "05" (no name, no city, no GSTIN) | unknown; HO/Himayathnagar is a candidate by elimination only | **Pending verification** (identity still unverified; 8 records are only *provisionally tracked* here — see below) |

**Owner confirmation, 2026-10-14 (supersedes "pending" for NULL/Self only).** The owner confirmed that source `NULL`/"Self" and TRIVO's Manikonda branch are the same physical branch (the names differ between the systems). Cross-check: GATI's current-stock report was downloaded on 14 October 2026 at 11:10 PM, after all stores had closed and with no transactions taking place, and compared with the worklist by Excel VLOOKUP on `JewelCode`. **9,715 JewelCodes matched Manikonda** (7,670 never-moved + 1,424 approval-returned + 568 transfer-received + 39 sale-returned + 14 retag clones; recorded as `Self` in `PhysicalLocationVerified`). This is a report-to-report match, not a physical stock count, and it covers stock only: the 8,253 sold and 129 on-memo codes are not stock-report rows and are left blank. The evidence discussion below is the original reasoning; its "pending" wording for NULL/Self is superseded by this paragraph.

**Provisional assignment of eight unresolved records to Branch 05 (owner-directed, temporary).** Eight JewelCodes were not matched by the report: dispatched/receipt not found SBNG00665, SBRC00044, SRNG02917, SRNG02960, SBTM00018, SBTM00023 (6); split instance SBNG00091 (1); transfer-receipt anomaly SNEC00463 (1). The owner instructed that they be assigned to Branch 05 in the migration working mapping for operational tracking. In the worklist this is `VerifiedBranch` = `05` with an explanatory `VerificationNotes`; `SourceBranchNo` stays `NULL`, `PhysicalLocationVerified` stays `#N/A`, and the source evidence is untouched. **It is not proof that these pieces are at Branch 05, and Branch 05's own physical identity remains unverified.**

**Evidence on NULL/Self ↔ Manikonda [C facts, H conclusion]:**
- The three GATI company records (`SJEPlus..Company`: VASD0001, VASD0002, VASS0001) all carry a **Manikonda** address (Hyderabad, Telangana); GATI's "own company" is therefore at Manikonda.
- All four mirror parties that represent the NULL/Self location from the other branches' side are named "01 MANIKONDA".
- The NULL/Self location is the **busiest retail seller**: 4,898 `Tax Invoice` + 110 `Estimate Invoice` JWSL documents (₹588.9 M of the ₹1,112.1 M invoiced outside book 98, i.e. more than any branch) — a location that retails to customers, which a pure head office normally does not.
- The NULL/Self book set additionally holds every **company-wide** book (cash/bank/UPI books, purchases, journals, quotations, purchase orders, metal and stone purchase/sale, repair, approvals). That is consistent with "the original company location also acts as the accounting centre", but it does not by itself say HO.
- Against HO: the books for NULL/Self are labelled "(HO)" **only** for the two transfer books (`Branch Transfer (HO)`, `Branch Receive (HO)`); no party, book, city or address in `VASDSJEP`/`SJEPlus` contains "Himayathnagar" (0 hits in firm names, cities, address lines, book names, company address).
- **Therefore:** NULL/Self cannot be called "HO / Himayathnagar" on this evidence, and the earlier statement in this document set that NULL = head office was an over-reading of the "(HO)" book label. It is more likely **Manikonda**, but that remains pending owner confirmation.

**Evidence on `05` ↔ HO/Himayathnagar [C facts, U conclusion]:**
- For HO: it was created recently (party 2026-09-10; first documents 2026-09-18) and has no sales or customers yet; it receives 731 transfer clones (623 from NULL/Self, 105 from 04, 3 from 02) and has issued 263 onward — a stock hub/pass-through pattern, not a selling one. 0 tags at 05 have ever been sold (statuses: A 468, V 263, I 13).
- Against HO: it has the **same full retail book template as branches 02–04** (Tax Invoice, Estimate Invoice, Sales Return, Approval, Jewelry Purchase, Stock Reconciliation, Proforma, Customer Material Receive; the "(B5)" suffix is the same pattern as "(B2)", "(B3)", "(B4)") and its Tax Invoice book reuses the *Repair Invoice* prefix, which looks like a copy-and-edit of a branch template. It has no name, no city and no GSTIN, so GATI never recorded what it is. Its own party name does not say HO.
- **Therefore:** nothing in the source says `05` is HO/Himayathnagar. It is equally consistent with a retail branch that opened in September 2026 and has not yet sold, and `NULL` and `05` are **not** interchangeable on any evidence found. Application logic for treating `05` as HO was not found in any procedure read (`InwardStatusView`, `BranchPendingVerification_Report`, `JewelStockReconsilation_Snap_Generate` treat it like any other branch value).
- What would settle it (owner or GATI report): the branch list as printed on a GATI branch stock/transfer report, the GST registration (if any) for the HO, and a statement of which value HO users post under.

**Consequence for the classifications in §5:** the counts are unchanged because they were computed on the preserved source value `NULL`; only the *label* changes. Where this file says "NULL/Self", read it as "the source value NULL", not as a confirmed physical location. If the owner confirms NULL = Manikonda, the 9,850 "current stock" rows are Manikonda stock; if the HO is `05`, the 468 stock tips at 05 are HO stock.

## 4. "Latest valid movement" vs old / reversed / cancelled / deleted

- [C] **Deletes are physical.** `JewelTrans_Delete` removes the document's `InwardHistory` rows, nulls `Inward.SaleId` and flips the tag back (`A` for a sale/branch issue, `X`/`A` for returns). Nothing remains of a deleted document except one line in `VASDLog..Delete_Log` (document number, type, book, user, time, remarks — **no content**). Superseded or deleted documents therefore **cannot appear** in `JewelTrans`/`InwardHistory`; there is nothing to filter out.
- [C] **Edits are in place.** `JewelTrans.TransVersionNo` / `Inward.InwardVersionNo` are counters (max seen: 8 on JWSL, 56 on a JWAP book); the previous version is not retained in these tables. `isCancel` is NULL on every `JewelTrans` row [C]; GATI does not cancel, it deletes.
- [C] `InwardHistory` is a derived, rebuildable ledger (`Inward_History_Regenerate` truncates and rebuilds it from `InwardHistory_View`; `InwardHistory_Insert` refuses a movement dated before the previous one). Per tag, `isLastTransaction=1` plus `InOutType=1` marks the current status: **0 tags** have `JStatus <> Status` (GATI's own regenerate check), **0 tags** have no history, **0 tags** have two current rows, **0 history rows** point at a missing document or tag.
- [C] `InwardHistory.InOutType` on the transfer pair (observed pattern, counts equal exactly): issue writes `3 (A)` then `1 (V)`; completed receipt adds `4 (V)` on the issuing row (24,177 rows) and `0 (A)` on the clone (24,175 rows). **A transfer is complete iff a clone exists.** The 212 `V` tips have 3 and 1 but no 4. [H: the numeric meaning of each `InOutType` is inferred from these counts, not documented.]
- [U] `Delete_Log.TransMode` (1/2/3, 147,335 rows) behaves like add/edit/delete but its counts do not reconcile to live document counts (JWSL: 8,286 logged mode 1, 201 mode 3, 8,180 live). Treat as an unreliable audit log; do not use it to reconstruct documents.

## 5. Classification of the 38,751 NULL-`BranchNo` rows

Classes requested by the owner are used where they apply. Two extra labels are needed because a large part of the population is not current stock; these are **not** TRIVO statuses and nothing here is converted to one.

| Class | Rows | How established | Confidence |
|---|---:|---|---|
| **Confirmed current branch = NULL/Self** — tip `A` received into NULL/Self by a `BJWPH (HO)` document (clone, type W) | 572 | Document trail + book branch NULL; receipt count test above | High [C] |
| **Confirmed current branch = NULL/Self** — tip `A` returned/approval-returned (`PJWAP`/`JWSR`) on a NULL/Self-book document | 1,461 | Last history is a document on a NULL/Self book; 0 disagree | High [C] |
| **Confirmed current branch = NULL/Self** — tip `A`, retag of a NULL/Self tag (type I) | 15 | Retag clone inherits source branch (278/278) | High [C] |
| **Confirmed current branch = NULL/Self (structural)** — tip `A`, original `R`, never moved | 7,672 | No document at all. Evidence is structural only: every original starts at NULL/Self, the only way out of NULL/Self is a `BJWSL` issue (which would make it `V`), none exists. Physical corroboration is thin: 3 of the 7,672 were scanned in a completed stock-take and 1,182 are in any stock-take snapshot (all 5 stock-takes covered only NULL-branch tags, but no header records a location). | Medium-High, **owner must confirm NULL=NULL/Self** and a physical count is recommended |
| **Confirmed branch of record = NULL/Self, physically with a memo party** — tip `C` (approval out) | 129 | Last doc is a `JWAP` on a NULL/Self book; custodian is the memo party, not a branch | High for branch of record [C]; where it physically is **is the memo party** |
| **Confirmed current branch = NULL/Self** — tip `T` (split instance) | 1 | Only 1 row; meaning of T is [H] | Low-Medium [H] |
| **Transfer dispatched, receipt not found** — tip `V`, no clone | 63 | `BranchPendingVerification_Report`'s own definition; see §6 | High that the receipt is missing [C]; whether physically in transit [U] |
| **Sold from NULL/Self** — tip `X` (not stock) | 8,248 | `SaleId` → JWSL on a NULL/Self book; 0 disagree | High [C] |
| **Superseded instance (not a stock row)** — `V` with clone | 20,441 | Issued on `BJWSL (HO)`, clone exists; its location *today* is the chain tip's | High [C] |
| **Superseded instance (not a stock row)** — `I` retag/repair source | 149 | Clone exists, same branch | High [C] |
| **Total** | **38,751** | 18,161 tips + 20,590 superseded | reconciles |

**Scope of "unresolved: 0".** "Location unresolved: 0" below means every *source-document* classification resolves to a source branch value without contradiction. It does **not** mean every physical location is verified: the physical identity of NULL/Self is still pending (§3a, D13), and the 7,672 never-moved tags rest on a structural rule with no document, so they require physical verification. The worklist `null-branch-jewelcode-verification.csv` exists for that purpose.

Owner's other classes: **Confirmed in transit: 0** — GATI has no field or status that distinguishes "in transit" from "dispatched, receipt not recorded"; both are the same pending state (§6), so this class is empty by construction and needs a business rule (Decision 15). **Transfer/receipt history contradictory: 0 among the NULL-branch rows** (every cross-check in §3 agrees); **2 across all branches** (§6, class D2, both at branch 02). **Location unresolved: 0** by the document rules; the only soft population is the 7,672 "never moved" originals that rely on the NULL=NULL/Self rule.

## 6. All branches: the 212 unreceived transfers

- [C] GATI's pending definition (`BranchPendingVerification_Report`): `Status IN ('U','V')`, issue document in a `BJWSL`/`JWBAP` book to a party with `ClientAs_ToBranch=1`, `Inline_ToJewelId IS NULL`. It selects exactly the 212 `V` tips without a clone. `U` has no rows. **No cancelled, deleted or reversed document can be in this set** (deletes are physical, §4).
- 63 are NULL-branch (issued by HO); 149 are issued by a branch (02: 66, 03: 49, 04: 33, 05: 1).
- Routes (source → destination): 02→01 62; NULL→03 59; 03→01 48; 04→01 31; 02→05 4; NULL→05 4; 04→05 2; 05→01 1; 03→05 1. Two thirds are branch→NULL/Self (mirror "01") returns.
- Age at 2026-10-14 (days since the issue document date): 0–3 d: 61; 8–30 d: 26; 31–90 d: 82; over 90 d: 43. Issue dates run 2026-06-03 to 2026-10-14. The thresholds that would separate "in transit" from "lost / not receipted" are a business decision (Decision 15).
- **Receipt history contradictory (2 tags, class D2):** two transfer clones at branch 02 (type W, status A, issued from NULL/Self on 2026-10-05) exist without any `BJWPH` receipt line — no `PurchaseId`, no `InOutType=0` history row. GATI treats them as received (the clone exists) but no receiving document can be found. This is why completed transfers number 24,177 clones against 24,175 `BJWPH` lines.
- File: `branch-location-exceptions.csv` (214 data rows: 212 class D1 + 2 class D2; tag ids, branch short codes, issue document number/date, age). It contains no party, customer or personal data. Re-generate from the frozen backup before relying on it: the live source added/changed rows during the session.
- [C] Money side: BJWSL journals total ₹3,334,695,044.74 over 783 documents and BJWPH ₹3,270,464,992.56 over 741; the ₹64.2 M gap is *not* proven to be these 212 pieces (no per-document valuation was reconciled) [U].

## 7. Branch inventory (for the TRIVO `Branch` table)

[C] Five source location values exist: `NULL` ("Self"), 02 JUBILEE HILLS, 03 VANSTHALIPURAM, 04 VIZAG, 05 (no name). Books exist for all five. Owner clarification (2026-10-14): the business has **five physical locations** — four retail branches (Manikonda, Jubilee Hills, Vanasthalipuram, Vizag) and one Head Office (HO / Himayathnagar). The source-to-business mapping is in §3a; only part of it is verified.

Current stock tips by branch and status (live, unfrozen): NULL/Self A 9,720 / C 129 / T 1; 02 A 1,490 / C 2 / T 5; 03 A 4,480 / C 5; 04 A 5,699; 05 A 468. Metal mix: silver 925 (SL925) dominates by weight; gold 22KT/18KT/14KT, silver 999, gold 999. 253 NULL/Self `A` tips (78,432 g gross) have no base metal and zero cost [U what they are].

## 8. Limitations of this investigation

- Single live database, one Windows-admin session (read-only `SELECT`s, `ApplicationIntent=ReadOnly`, `READ UNCOMMITTED`); no restored backup and no dedicated least-privilege login were available. Counts drifted by 2 rows during the session.
- Reading procedures was limited to the ones that govern status, history, deletion, pending transfers and stock-take snapshots (`InwardStatusView`, `InwardHistory_Insert`, `Inward_History_Regenerate`, `Reversal_UpdateInwardStatus`, `BranchPendingVerification_Report`, `JewelTransInward_RegenerateSaleId`, `Inward_DeleteData`, `JewelTrans_Delete` (head), `delete_log_Insert`, `JewelStockReconsilation_Snap_Generate`). I did **not** read `Inward_ImportOnlineBranchData` / `OnlineBranch_Auto_MemoIssue` (offline-branch sync, 66 KB / 34 KB), `JewelTransInward_Insert_Update` (32 KB) or `Inward_ItemStatusReport`; the online/offline branch mechanism (`IsOfflineBranch` parties) is therefore not characterised [U].
- No GATI business report (stock register, outstanding) was available to confirm any figure against what GATI itself shows users.

## 7. Verification worklist: `null-branch-jewelcode-verification.csv`

Query snapshot: 2026-10-14 ~21:54 IST, **live** `VASDSJEP` (no frozen backup exists), read-only, `READ UNCOMMITTED`. Counts therefore differ slightly from §5, which was taken earlier the same day.

**Scope and logic.** One row per `JewelCode` whose chain tip (`Inward.NewJewelId IS NULL`) has `BranchNo IS NULL`. Latest movement = the tip's `InwardHistory` row with `isLastTransaction=1` (preferring `InOutType=1`, then highest `Id`); document type/number/date come from `JewelTrans` (via `JewelTransId`), `JewelTransProceed` (approval returns, via `ProceedId`), or, for a transfer clone, the `BJWPH` receipt in `Inward.PurchaseId`. The source value is written literally as `NULL`. The first 15 columns are the requested ones (columns 11-15 blank for the reviewer); extra columns after them: `VerificationPriority`, `IsCurrentStockCandidate`, `LatestInwardType`, `LatestBookName`, `LatestBookBranchNo`, `ChainInstances`, `ChainNullBranchInstances`. No party, customer or personal data is included.

**Result: 18,105 unique JewelCodes** (every one has exactly one tip). Counts: sold 8,253; never-moved originals (structural rule only, `REQUIRED` physical verification) 7,670; approval-returned 1,424; transfer-received 569; on approval/memo 129; sale-returned 39; retag clone 14; dispatched-receipt-not-found 6; split instance 1. See `null-branch-jewelcode-verification-summary.csv`.

**Reconciliation to §5 (18,161 tips).** Total −56: dispatched/no-receipt 63→6 (−57), never-moved 7,672→7,670 (−2), other status-A classes 2,048→2,046 (−2; §5 rows 572+1,461+15 vs 569+1,424+39+14 here, different document-type grouping), sold 8,248→8,253 (+5). The −57 is proven live drift: 57 `W` clones created on 2026-10-14 are receipts of NULL-issued transfers (their source tips are now superseded, and the new tips sit at other branches). The −4 status-A and +5 sold changes are other live activity after §5 (15 more NULL-branch tips have been sold today), not re-classified stock; I did not trace each of the 9 individually. Total NULL-branch rows are now 38,752 (+1) = 18,105 tips + 20,647 superseded.

**Not in the list (by scope).** 17,269 JewelCodes have a superseded NULL-branch instance but their tip is at another branch; they are not NULL-branch stock and were not listed. Superseded NULL instances of in-scope codes are not separate rows (see `ChainNullBranchInstances`).

**Caveats.** This is a location-verification worklist, not a stock list: sold, memo and dispatched rows are included on purpose and flagged (`IsCurrentStockCandidate`). `DISPATCHED_RECEIPT_NOT_FOUND` is not confirmed in transit. Re-run from the frozen backup before relying on counts.
