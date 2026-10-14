# GATI Transaction Relationships (Phase 1, source: `VASDSJEP`, read-only)

Machine-readable inputs: `gati-schema-inventory.csv` (258 non-empty tables, 3,430 columns, no data) and `gati-foreign-keys.csv` (1,816 declared FK column pairs). Everything below is **Confirmed** from catalog/aggregate queries unless tagged otherwise. Business meaning of codes is **Hypothesis** until validated with GATI reports or the client.

## Core entities
| Concept | GATI table(s) | Rows | Notes |
|---|---|---|---|
| Tag / jewel piece | `Inward` (key `JewelId`) | 59,839 | One row per piece. Children (all keyed `JewelId`): `InwardDetail` 95,952 (stones/materials), `InwardFormula`, `InwardSummary`, `InwardExploration`, `InwardCollection`, `InwardCatch`, `InwardHistory` 183,583, `InwardXtraCharges`. |
| Transaction header | `JewelTrans` (key `JewelTransId`) | 9,945 | Purchase / sale / returns / approvals / branch docs distinguished by `TranType`. |
| Transaction line | `JewelTransInward` (`JewelTransId`,`JewelId`) | 68,395 | Plus `...Detail` 116k, `...Exploration` 187k, `...Formula`, `...Summary`, `JewelTransAddless` 48k (charges/discounts), `JewelTransMetalRate` 79k (rate snapshot per line). |
| Party (customers, suppliers AND branches/locations) | `PartyMst` | 7,776 | 194 child tables. Branches are `PartyMst` rows (`Inward.BranchNo`, `LocationId`, `FirstLocationId` all FK to `PartyMst.PartyNo`). |
| Accounting | `Journal` 46,814; `Settlement`/`SettlementDetail`; `VoucherEntry` 12,678 + `VoucherEntryJournal`; `AccountBalance` 15,719; `DueDetail` 12,227 | | Double-entry style (`DrAccountNo`/`CrAccountNo`, `TranType`, `TransNo`, `TransactionId`). |
| Style/design master | `StyleMst` 40,142 (+Detail/Formula/Summary/Catch/Collection) | | Inward.StyleId FK. |
| Rates | `MetalRateMst`, `RateDailyMst`, `RateDailyMst_Log` 3,667, `RateMst`, `RateChartMst`, `LabourChartMst` | | |
| Masters referenced by tag | `StockTypeMst`, `MakeTypeMst`, `ToneMst`, `HSNMaster`, `MainProduct`/`SubProduct`, `SPM_CommonMaster` (brand/gender/size/hallmark), `CurrencyMst` | | |
| Manufacturing/orders (dormant in TRIVO terms) | `Spm_MfgOrder` 6,767, `SPM_MfgOrderItem` 9,407, `SPM_Bag*` | | Used by GATI; **whether business uses them is Unresolved**. |
| Stock reconciliation/audit | `JewelStockReconsilation_*` (Header/Scan/Snap 12,617/Final), `BagStockReconsilation_*`, `MaterialStockReconsilation_*` | | Physical stock-take history. |
| Raw material stock | `SPM_MaterialStock` 3,579, `SPM_MaterialTrans*` | | Metal/loose-stone movements (maps to TRIVO `MetalStock`). |

## Tag lifecycle
`Inward.Status` is a one-letter code; counts for `VASDSJEP`: **A 21,857; V 24,389; X 13,173; I 278; C 136; T 6**. Meaning of each letter is **Unresolved** (A likely available/in stock; V likely sold/voucher; X likely removed/closed; I likely in transit/issued; C, T unknown). Do not map until verified against a GATI stock report.
Separate lookup `Const_JewelStockStatus` (64 rows) lists movement-level statuses: Opening, Manufactured, Memo In/Return/Sale, Branch Memo Issue/Receive, Purchase, Purchase Return, Sale, Sale Return, Branch Transfer Issue/Receive (+Pending, In Transit), Job Work, Location Transfer, Repaired/Inward Repair, Split/Merge, Broken, Lost, Closing, Reversal Issue/Receive, Exclude. Which column on which table stores these is Unresolved.
Tag-to-document links on `Inward`: `PurchaseId` -> `JewelTrans` (inward purchase), `SaleId` -> `JewelTrans` (sale), `SaleReturn_OriJewelId`/`SaleReturn_OriSaleId` (original-sale link for returns), `ApprovalInwardId` -> `JewelTrans` (memo/approval), `NewJewelId` (retag).

## Document types (`JewelTrans.TranType`)
| TranType | Docs | Date range | Hypothesis |
|---|---|---|---|
| JWSL | 8,180 | 2025-11-10..2026-10-14 | Jewellery sale invoice |
| BJWSL | 783 | 2026-03-08.. | Branch jewellery sale / branch transfer issue |
| BJWPH | 741 | 2026-03-08.. | Branch purchase/receive (transfer receipt) |
| JWSR | 128 | 2025-12-17.. | Sale return |
| JWAP | 109 | 2025-12-22.. | Approval/memo |
| JWPRM | 3 | 2026-09 | Unknown (purchase return/memo?) |
| JWPH | 1 | 2026-01-31 | Purchase |
All are **Hypothesis** (names inferred). Notably there are only 1 JWPH and no obvious bulk purchase doc type: most stock appears via `Inward` rows with `InwardType` / manufacturing rather than purchase invoices. Unresolved how 59k tags were originally received (opening balance, purchase, opening import). `JewelTrans.isCancel` is all NULL, so cancelled documents may be represented differently (e.g. `Delete_Log` 147k rows in `VASDLog`, `TransVersionNo`). **Unresolved.**

## Branches
`Inward.BranchNo` (FK `PartyMst`): codes `02 JUBILEE HILLS` 3,011 tags, `03 VANSTHALIPURAM` 7,963, `04 VIZAG` 9,370, `05` (unnamed) 744, and **NULL on 38,751 tags (65%)** including 20,504 `V` and 9,720 `A`. `LocationId`/`FirstLocationId` are unused on Inward (0 distinct). Business says four branches; a branch `01` is not referenced by any tag (Phase 1 guessed "head office/Hyderabad"; that guess is unsupported and superseded by `gati-branch-location-findings.md` §3a — `01` is only the name prefix of the mirror party for the NULL/Self location). **How a tag's current branch is determined for NULL-branch tags is Unresolved and is the main stock-by-branch risk.**
Branch-to-branch transfer docs appear as `BJWSL`/`BJWPH` with `BOOKMASTERLOCATIONTRANSFERPAIR`, `JewelBranchAutoIssue*`; in-transit statuses exist. Detailed transfer pairing logic not yet traced.

## Money flow (Hypothesis, not validated)
Sale doc (`JewelTrans` JWSL) -> `Journal` rows (`TransactionId`/`TransNo`) -> payments in `Settlement`/`SettlementDetail` (46,915 detail rows) -> `DueDetail` (outstanding) -> `AccountBalance`. Receipts/advances in `VoucherEntry`. Exact keys not yet traced.

## Other
- FY handling: company codes `VASD0001`/`VASD0002` suggest FY split; `TransVersionNo`/`InwardVersionNo` columns indicate document versioning (edits may leave multiple versions) - **Unresolved**, important for avoiding double-posting.
- Triggers: 41 in the DB; procs: 1,792 (business logic likely in stored procedures). Not yet read.
- Web/CRM/Shopify/Tally/e-invoice side tables exist (`SHOPIFY_*`, `TALLY_SALEDATA*`, `EInvoiceDetail`, `SALEEWAYBILL`); whether in use is Unresolved.
