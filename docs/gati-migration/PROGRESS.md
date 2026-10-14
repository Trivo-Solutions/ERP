# Progress

Phase: **1 - Discovery** (awaiting approval gate). Production migration: not approved.

## Completed (2026-10-14)
- Read GATI_MIGRATION.md; checked Git state (`main`, HEAD 99e752b; pre-existing uncommitted changes left untouched).
- Verified GATI engine: **SQL Server 2022 named instance `SQL22`**, DB `VASDSJEP` (main, 1,154 tables), `VASSSJEP`, `SJEPlus`, `VASDLog`. See `environment-inventory.md`.
- Exported schema metadata only (no data): `gati-schema-inventory.csv` (258 non-empty tables), `gati-foreign-keys.csv` (1,816 FK pairs).
- Wrote `environment-inventory.md`, `trivo-repository-map.md`, `gati-transaction-relationships.md`, `DECISIONS.md`.
- Access was read-only (SELECT on catalog views and aggregates, Windows auth). No GATI or TRIVO data was modified; nothing installed; no services touched; no credentials read or recorded.

## Key confirmed findings
- Source is SQL Server, not MySQL. Tags = `Inward` (59,839); documents = `JewelTrans` (9,945; 7 TranTypes); lines = `JewelTransInward` (68,395); branches are `PartyMst` rows.
- Four branch codes appear on tags (02 Jubilee Hills, 03 Vansthalipuram, 04 Vizag, 05), but **65% of tags (38,751) have NULL branch**.
- Tag status is a single-letter code (A/V/X/I/C/T) whose meaning is not documented in the DB.
- TRIVO auto-posts journals and enforces GST-period locks; a naive import through existing services would double-post or be rejected.

## Not done in this pass (deliberately)
- `source-to-target-mapping.csv`, `trivo-gap-analysis.md`, `migration-reconciliation-plan.md`, `migration-runbook.md` are Phase 2 deliverables, not created.
- No Postgres/TRIVO DB query, no stored-procedure/trigger reading, no business-report comparison, no data-quality profiling.

## Blockers / needs from owner
See the 12 open questions in `DECISIONS.md`. Highest impact: status code meanings, NULL-branch rule, VASS scope, history depth, and a read-only login or restored backup for further profiling.

## Proposed next steps (after approval)
1. Owner answers open questions; supply GATI stock/sales/day-end reports as authoritative references.
2. Deeper read-only profiling: status/branch derivation (read relevant stored procs), transfer pairing, cancellation handling, cost fields, duplicates.
3. Inspect TRIVO Postgres (read-only) and confirm the target company/staging DB.
4. Then Phase 2: mapping CSV, gap analysis, reconciliation plan, architecture.
