# Decisions

| Date | Decision | Rationale | Approved by |
|---|---|---|---|
| 2026-10-14 | Phase 1 discovery only; no migration code, schema change, install, or import. | Per GATI_MIGRATION.md sections 4 and 10. | Project owner (instruction) |
| 2026-10-14 | GATI source engine recorded as SQL Server 2022 `.\SQL22`, database `VASDSJEP`. | Observed, not assumed. | n/a (evidence) |

## Unresolved questions (need business/owner input)
1. Which GATI database is authoritative: only `VASDSJEP` (VASD), or also `VASSSJEP` ("Z_" prefixed, stopped 2025-12-05)? Is VASS to be migrated or archived?
2. Meaning of `Inward.Status` codes A/V/X/I/C/T, and of each `JewelTrans.TranType`.
3. How is a tag's current branch determined when `Inward.BranchNo` is NULL (38,751 tags)? What is branch `05`, and where is branch `01`?
4. Which branches are the four live ones and which is the fifth to be added?
5. How were 59k tags originally received (opening balances vs purchases)? Which cost fields define "original cost"?
6. How are cancelled/edited documents represented (`isCancel` all NULL; `TransVersionNo`; `Delete_Log`)?
7. Which workflows are actually used: memo/approval, repairs, melting, job work, manufacturing orders, export, Shopify, Tally, e-invoice?
8. Migration scope of history: all since 2025-11, or opening balances + open items only? Accounting history as journals or opening balances?
9. How should historical documents interact with TRIVO's auto-journals and with GST filed-period locks?
10. Target environment: which Postgres DB/company in TRIVO; is a staging DB available; who approves access to a read-only GATI login or a restored backup copy?
11. Authoritative GATI reports and tolerances for reconciliation.
12. `SmartOfficedb` on `.\SQLEXPRESS` and the `C:\db-backups\vasavi_jewelry_db` backup: what are they (possibly TRIVO-related, not GATI)?
