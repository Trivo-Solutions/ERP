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
- [C] Branch documents are issued from **per-branch books** (`BookMaster.BranchNo`). The books are named "(HO)", "(B2)", "(B3)", "(B4)", "(B5)"; the **HO books have `BookMaster.BranchNo` NULL**. The destination is `JewelTrans.PartyNo` — a mirror party whose name is the *counterpart* branch (e.g. party "01 MANIKONDA" viewed from branch 02).
- [C] **Agreement test (all documents that exist):** for the 24,175 `BJWPH` receipts, the clone's `BranchNo` equals the receiving book's branch in 24,175/24,175 (including 3,228 where both are NULL = "Branch Receive (HO)"). For the 24,389 `BJWSL` issues, the source row's `BranchNo` equals the issuing book's branch in 24,389/24,389 (20,504 NULL on "Branch Transfer (HO)"). For every tip whose last history row carries a document book (A via JWSR/PJWAP, C/JWAP, V/BJWSL, X/JWSL — 15,670 tips), **0 disagree**. Destination check: the clone's branch equals the issue document's destination party in 24,055 of the 24,177 transfer clones with 0 mismatches (the other 122 have a retag instance as their source and were excluded from this test).
- [C] GATI's own code treats NULL as a real branch: `BranchPendingVerification_Report` prints `IsNull(FirmName,'Self')` for a NULL `BranchNo`; `JewelStockReconsilation_Snap_Generate` joins `IsNull(Inw.BranchNo,'') = IsNull(BR_Branch.BranchNo,'')`.
- [C] There is **no `PartyMst` row that is the head office itself**. "01 MANIKONDA" exists only as mirror/counterpart rows (`0001002464`, `0002000605`, ...). The four inline-branch parties are 02 (Jubilee Hills), 03 (Vansthalipuram), 04 (Vizag), 05 (unnamed). Between them the four inline-branch parties carry 2 distinct GST registrations and one party has none (counts only; no numbers recorded here).
- **Conclusion [C for the rule, H for the label]:** `BranchNo IS NULL` = the head-office / "Self" location. The *rule* is proven by documents; that the HO is named "01 MANIKONDA" is read from the mirror-party names and still needs the owner's confirmation (Decision 13).
- [C] No tag was ever created directly at a branch: all 35,372 `R` originals are NULL-branch. Branch stock only ever arrives via `BJWPH` receipt.

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
| **Confirmed current branch = HO** — tip `A` received into HO by a `BJWPH (HO)` document (clone, type W) | 572 | Document trail + book branch NULL; receipt count test above | High [C] |
| **Confirmed current branch = HO** — tip `A` returned/approval-returned (`PJWAP`/`JWSR`) on an HO-book document | 1,461 | Last history is a document on an HO book; 0 disagree | High [C] |
| **Confirmed current branch = HO** — tip `A`, retag of an HO tag (type I) | 15 | Retag clone inherits source branch (278/278) | High [C] |
| **Confirmed current branch = HO (structural)** — tip `A`, original `R`, never moved | 7,672 | No document at all. Evidence is structural only: every original starts at HO, the only way out of HO is a `BJWSL` issue (which would make it `V`), none exists. Physical corroboration is thin: 3 of the 7,672 were scanned in a completed stock-take and 1,182 are in any stock-take snapshot (all 5 stock-takes covered only NULL-branch tags, but no header records a location). | Medium-High, **owner must confirm NULL=HO** and a physical count is recommended |
| **Confirmed branch of record = HO, physically with a memo party** — tip `C` (approval out) | 129 | Last doc is a `JWAP` on an HO book; custodian is the memo party, not a branch | High for branch of record [C]; where it physically is **is the memo party** |
| **Confirmed current branch = HO** — tip `T` (split instance) | 1 | Only 1 row; meaning of T is [H] | Low-Medium [H] |
| **Transfer dispatched, receipt not found** — tip `V`, no clone | 63 | `BranchPendingVerification_Report`'s own definition; see §6 | High that the receipt is missing [C]; whether physically in transit [U] |
| **Sold from HO** — tip `X` (not stock) | 8,248 | `SaleId` → JWSL on an HO book; 0 disagree | High [C] |
| **Superseded instance (not a stock row)** — `V` with clone | 20,441 | Issued on `BJWSL (HO)`, clone exists; its location *today* is the chain tip's | High [C] |
| **Superseded instance (not a stock row)** — `I` retag/repair source | 149 | Clone exists, same branch | High [C] |
| **Total** | **38,751** | 18,161 tips + 20,590 superseded | reconciles |

Owner's other classes: **Confirmed in transit: 0** — GATI has no field or status that distinguishes "in transit" from "dispatched, receipt not recorded"; both are the same pending state (§6), so this class is empty by construction and needs a business rule (Decision 15). **Transfer/receipt history contradictory: 0 among the NULL-branch rows** (every cross-check in §3 agrees); **2 across all branches** (§6, class D2, both at branch 02). **Location unresolved: 0** by the document rules; the only soft population is the 7,672 "never moved" originals that rely on the NULL=HO rule.

## 6. All branches: the 212 unreceived transfers

- [C] GATI's pending definition (`BranchPendingVerification_Report`): `Status IN ('U','V')`, issue document in a `BJWSL`/`JWBAP` book to a party with `ClientAs_ToBranch=1`, `Inline_ToJewelId IS NULL`. It selects exactly the 212 `V` tips without a clone. `U` has no rows. **No cancelled, deleted or reversed document can be in this set** (deletes are physical, §4).
- 63 are NULL-branch (issued by HO); 149 are issued by a branch (02: 66, 03: 49, 04: 33, 05: 1).
- Routes (source → destination): 02→01 62; 01(HO)→03 59; 03→01 48; 04→01 31; 02→05 4; 01(HO)→05 4; 04→05 2; 05→01 1; 03→05 1. Two thirds are branch→HO returns.
- Age at 2026-10-14 (days since the issue document date): 0–3 d: 61; 8–30 d: 26; 31–90 d: 82; over 90 d: 43. Issue dates run 2026-06-03 to 2026-10-14. The thresholds that would separate "in transit" from "lost / not receipted" are a business decision (Decision 15).
- **Receipt history contradictory (2 tags, class D2):** two transfer clones at branch 02 (type W, status A, issued from HO on 2026-10-05) exist without any `BJWPH` receipt line — no `PurchaseId`, no `InOutType=0` history row. GATI treats them as received (the clone exists) but no receiving document can be found. This is why completed transfers number 24,177 clones against 24,175 `BJWPH` lines.
- File: `branch-location-exceptions.csv` (214 data rows: 212 class D1 + 2 class D2; tag ids, branch short codes, issue document number/date, age). It contains no party, customer or personal data. Re-generate from the frozen backup before relying on it: the live source added/changed rows during the session.
- [C] Money side: BJWSL journals total ₹3,334,695,044.74 over 783 documents and BJWPH ₹3,270,464,992.56 over 741; the ₹64.2 M gap is *not* proven to be these 212 pieces (no per-document valuation was reconciled) [U].

## 7. Branch inventory (for the TRIVO `Branch` table)

[C] Five locations exist in GATI data: HO (NULL, implicit, name "01 MANIKONDA" by mirror parties), 02 JUBILEE HILLS, 03 VANSTHALIPURAM, 04 VIZAG, 05 (no name). Books exist for all five, and branch 05 is live (468 stock tags, documents from 2026-10). The owner's "four live branches + a fifth to be added" is ambiguous against this (Decision 13).

Current stock tips by branch and status (live, unfrozen): HO A 9,720 / C 129 / T 1; 02 A 1,490 / C 2 / T 5; 03 A 4,480 / C 5; 04 A 5,699; 05 A 468. Metal mix: silver 925 (SL925) dominates by weight; gold 22KT/18KT/14KT, silver 999, gold 999. 253 HO `A` tips (78,432 g gross) have no base metal and zero cost [U what they are].

## 8. Limitations of this investigation

- Single live database, one Windows-admin session (read-only `SELECT`s, `ApplicationIntent=ReadOnly`, `READ UNCOMMITTED`); no restored backup and no dedicated least-privilege login were available. Counts drifted by 2 rows during the session.
- Reading procedures was limited to the ones that govern status, history, deletion, pending transfers and stock-take snapshots (`InwardStatusView`, `InwardHistory_Insert`, `Inward_History_Regenerate`, `Reversal_UpdateInwardStatus`, `BranchPendingVerification_Report`, `JewelTransInward_RegenerateSaleId`, `Inward_DeleteData`, `JewelTrans_Delete` (head), `delete_log_Insert`, `JewelStockReconsilation_Snap_Generate`). I did **not** read `Inward_ImportOnlineBranchData` / `OnlineBranch_Auto_MemoIssue` (offline-branch sync, 66 KB / 34 KB), `JewelTransInward_Insert_Update` (32 KB) or `Inward_ItemStatusReport`; the online/offline branch mechanism (`IsOfflineBranch` parties) is therefore not characterised [U].
- No GATI business report (stock register, outstanding) was available to confirm any figure against what GATI itself shows users.
