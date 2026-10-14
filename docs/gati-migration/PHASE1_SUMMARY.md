# GATI -> TRIVO Migration: Phase 1 Discovery Summary

Date: 2026-10-14. Client: Vasavi Gold & Diamonds. Scope: read-only discovery; no migration code, schema change or data import. Tags: **[C]** Confirmed (observed), **[H]** Hypothesis, **[U]** Unresolved. Details and evidence: the other files in this folder.

## 1. Verified environment
- [C] GATI (SJE Plus, Gatisofttech, .NET/DevExpress desktop client) and TRIVO run on the same Windows Server 2022 host.
- [C] GATI database engine: **Microsoft SQL Server 2022, named instance `SQL22`** (not MySQL). Databases: `VASDSJEP` (main, ~2.9 GB, 1,154 tables, data to 2026-10-14), `VASSSJEP` (second company, last activity 2025-12-05), `SJEPlus` (login/company registry), `VASDLog` (audit/delete logs).
- [C] Access used: Windows integrated login, SELECT on catalog views and aggregate counts only.
- [C] TRIVO: Node/Express/Prisma + PostgreSQL 18 (local service), repo `nelakodasai/ERP`, branch `main`, 138 Prisma models, multi-company with database-level RLS.
- [U] TRIVO's actual Postgres database(s) were not queried; whether Vasavi is already a provisioned company and which DB is staging is unknown.

## 2. GATI structure
- [C] Tags: `Inward` (59,839 rows, key `JewelId`) with ~30 child tables (details, history 183k, formula, summary, charges).
- [C] Documents: `JewelTrans` (9,945 headers; TranTypes JWSL 8,180, BJWSL 783, BJWPH 741, JWSR 128, JWAP 109, JWPRM 3, JWPH 1), lines in `JewelTransInward` (68,395), charges in `JewelTransAddless`, per-line rate snapshots in `JewelTransMetalRate`.
- [C] Parties and branches share one table, `PartyMst` (7,776 rows).
- [C] Accounting: `Journal` (46,814), `Settlement`/`SettlementDetail`, `VoucherEntry`, `DueDetail`, `AccountBalance`.
- [C] 1,812 declared FKs; 1,792 stored procedures and 41 triggers (not read).
- [H] TranType meanings (e.g. JWSL = sale, JWSR = sale return, BJWSL/BJWPH = branch issue/receive) are inferred from names only.

## 3. The tag / branch issue
- [C] `Inward.BranchNo` is populated for only 21,088 of 59,839 tags: 02 Jubilee Hills 3,011; 03 Vansthalipuram 7,963; 04 Vizag 9,370; 05 (unnamed) 744. **38,751 tags (65%) have NULL branch**, including 9,720 status A and 20,504 status V.
- [C] `LocationId` / `FirstLocationId` are not used on tags. No tag references a branch 01.
- [C] `Inward.Status` is one letter: A 21,857; V 24,389; X 13,173; I 278; C 136; T 6. [U] meanings undocumented; do not map yet.
- [U] How a tag's current branch is determined (perhaps from the latest transfer/sale document or movement history).

## 4. Transaction relationships
- [C] Tag links: `PurchaseId`, `SaleId`, `ApprovalInwardId` -> `JewelTrans`; `SaleReturn_OriJewelId`/`SaleReturn_OriSaleId` for return-to-original-sale; `NewJewelId` for retag.
- [C] A separate lookup (`Const_JewelStockStatus`, 64 rows) lists movement-level statuses (memo, branch transfer incl. in-transit, repair, split/merge, lost, reversal...).
- [H] Money flow: sale doc -> Journal -> Settlement -> DueDetail -> AccountBalance. Keys not yet traced.
- [U] Cancellation/edit representation: `isCancel` is NULL on all documents; versioning columns and `Delete_Log` (147k rows) may carry it.

## 5. TRIVO capabilities (from CLAUDE.md and code listing; [C] as documented policy, not re-tested)
- Has: tag lifecycle (IN_STOCK/ON_APPROVAL/TRANSFERRED/SOLD/RETIRED), branches and transfers, GRN/PO intake, invoices with per-line HSN GST, memo, sales/purchase returns, old gold exchange, double-entry ledger with automatic journal posting, client/supplier balances, repairs, stock audit, per-company RLS and composite FKs, audit log.
- [U] Gaps to be analysed in Phase 2: source-id/traceability columns, historical import path, historical-date posting, movement history, cost-component storage, fifth branch.

## 6. Migration risks
1. Double-posting: TRIVO services auto-post journals and balances; replaying history through them duplicates accounting.
2. GST period locks reject backdated documents once a period is filed.
3. 65% of tags lack a branch; branch-wise stock cannot be reconciled until the rule is known.
4. Unknown status/TranType semantics could silently misclassify sold vs in-stock tags.
5. Cancelled/edited/versioned documents may be imported twice or resurrected.
6. Two companies (VASD, VASS) and FY-wise company codes (VASD0001/0002) complicate scope.
7. Business logic probably lives in 1,792 stored procedures not yet reviewed.
8. Discovery used an administrator login; extraction should use a read-only login or restored backup.
9. TRIVO RLS and cross-company FK checks require importer to run in tenant context.

## 7. Unresolved decisions (see DECISIONS.md for the full list of 12)
Scope of VASS vs VASD; meaning of status codes and TranTypes; branch derivation for NULL-branch tags, branch 05 and the fifth branch; history depth (full vs opening balances plus open items); accounting import strategy; historical vs live posting and GST locks; origin of cost and "original cost" definition; which workflows are actually used (memo, repairs, melting, job work, manufacturing orders, Shopify, Tally, e-invoice); target/staging DB; authoritative reconciliation reports and tolerances; purpose of `SmartOfficedb` and `C:\db-backups\vasavi_jewelry_db`.

## 8. Excluded from these documents
No credentials, connection strings, customer or party names/contact details, GSTINs, raw production rows or dumps. Only schema metadata, aggregate counts, and four internal branch names are included.
