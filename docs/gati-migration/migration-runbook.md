# GATI → TRIVO Migration Runbook (Phase 2 draft — a plan, not an executable procedure)

Date: 2026-10-14. Scope: `VASDSJEP` only, full history. **No importer exists, none is authorized, and no step below has been run.** The runbook fixes the order, the gates and the abort rules so Phase 3 has something to be built *against*. Steps that depend on an unmade decision say so (D-numbers in `DECISIONS.md`). Companion documents: `gati-branch-location-findings.md`, `trivo-gap-analysis.md`, `migration-reconciliation-plan.md`, `source-to-target-mapping.csv`.

## 0. Roles and access

| Role | Who | Allowed |
|---|---|---|
| Business owner | Vasavi owner | Approves decisions, tolerances, every non-zero difference, cutover and go-live |
| Migration engineer | implementer | Builds/runs the loader on **staging** only until the owner opens the production gate |
| GATI reader | dedicated SQL login, `db_datareader` on a **restored copy** of `VASDSJEP` and `VASDLog` only | Never the live database, never write |
| TRIVO operator | operator with platform key | Provisions the target company (existing `provisionCompany` / `npm run company:provision`) |

- Target access method is **not yet approved** (D27). Rule until it is: no connection to any TRIVO PostgreSQL database. The loader, when it exists, runs as `trivo_runtime` through `tenantTransaction` with the target `companyId`; `trivo_platform`/BYPASSRLS is not used without the owner naming that exception.
- No credentials, connection strings or tokens in the repository, logs or run reports.

## 1. Gate 0 — preconditions (nothing is built until all are true)

1. Owner has answered the blocking decisions: D13 (five locations; NULL/Self = Manikonda is confirmed, Branch 05's identity and the branch-GSTIN map are still open), D14 (one tag per `JewelCode`), D16 (status/TranType meanings), D17 (loader instead of service replay), D18 (accounting strategy), D19 (document numbers), D20 (GST history), D22 (original cost), D23 (outstanding authority), D27 (target environment).
2. Owner supplied GATI's own stock register, party outstanding and filed GST figures for a named date (the authority the reconciliation checks against).
3. Approved schema changes written and reviewed: `migration_batches`, `migration_source_map`, `tag_movement_history` (gap-analysis §8). Each with RLS, composite FK, `db-secure.sql`, schema-guard entry and RLS tests (CLAUDE.md §11, §6.12).
4. A restored copy of the GATI backup exists on a non-production SQL Server instance (hash recorded) and the read-only login works on it.
5. A **staging** TRIVO company exists, provisioned from the Starter Package, empty of operational data.
6. Rehearsal window agreed; GATI keeps running live during rehearsals.

## 2. Phase plan (each phase ends at a gate; nothing proceeds on a failed gate)

### P1 — Prepare configuration (target = staging company)
Order matters because later steps reference earlier ones by id.
1. Branches: five rows for the owner's five locations (Manikonda, Jubilee Hills, Vanasthalipuram, Vizag, HO/Himayathnagar); `isHeadOffice` set only on the location D13 confirms as HO; the GATI source value is stored in the source map beside each. NULL/Self maps to the Manikonda row (owner-confirmed 2026-10-14; stock-report VLOOKUP matched 9,715 JewelCodes - a report match, not a physical count). Branch 05 is not created until its identity is confirmed; the 8 JewelCodes provisionally tracked at 05 in the working mapping (`VerifiedBranch`=05, owner-directed, unverified; listed in D13) must be handled explicitly at load: their source branch stays NULL and nothing is imported to 05 as a verified location without the owner's decision. Mirror/counterpart parties are **not** created as branches or clients.
2. GST registrations and each branch's `gstRegistrationId` (D20) — before any document.
3. Masters from GATI, copied not referenced: product categories (142) / sub-categories (742), stock types (5), make types (12, D25), karat codes (G22KT→22K, G18KT, G14KT, G999, SL925, SL999 — KaratMaster first), collections/sizes actually used, HSN rows required by documents.
4. Chart of accounts mapping for the 198 account parties (D18); unmapped accounts listed to the owner, not auto-created.
5. User/sales-person map (D26): 190 sales persons, GATI users for created/updated by.
**Gate P1:** counts of each master = source (minus documented exclusions); every id the later loads need resolves.

### P2 — Parties
Clients (7,318, mirror branch parties excluded), suppliers (272); legacy key to the source map; GSTIN validated with `shared/gstin.ts`; invalid or duplicate GSTIN → exception list, never auto-merged; no PII leaves the staging company or enters Git.
**Gate P2:** R-50, R-51.

### P3 — Tags (tips only, one per `JewelCode`)
1. For each `JewelCode`, take the tip (`NewJewelId IS NULL`); map every instance `JewelId` of the chain to this tag in the source map (59,839 entries).
2. Create the tag with the GATI `JewelCode` as `tagNumber`, `branchId` from `BranchNo` (source value kept; NULL→Manikonda per D13, except the 8 provisional-05 JewelCodes, which wait for the owner's decision; a `V` tip keeps its **source** branch), `status` per the D16/D15 mapping, weights, cost per D22, material rows.
3. Advance `TAG:*` sequences past any imported number that could collide.
4. Zero-cost / no-metal / cost-component exceptions go to quarantine with their reason; they are imported flagged or held back per the owner's ruling, not defaulted.
**Gate P3:** R-01…R-14.

### P4 — Movement and transfers
1. Load `tag_movement_history` from `InwardHistory` + chain hops (dates, documents, branches, actor if mapped).
2. Build `BranchTransfer` history per `BJWSL` document: completed items `receivedAt` = clone creation; the 212 outstanding per D15 (either `TRANSFERRED` + `DISPATCHED` with `receivedAt` null, or held for physical verification first); the 2 class-D2 clones recorded as received with a flagged missing document.
**Gate P4:** R-15, R-20…R-24.

### P5 — Documents
Order: sales invoices + lines + tax (books 37/1121/1180/2226 only unless D33 includes estimates) → sale returns (need their original invoice/item) → memos (open ones first; they hold tags) → purchase returns (book 98, D21) → remaining purchase/inward (`JWPH`, D21/D24).
Each document keeps its **GATI number** (G5); totals are copied, never re-priced; per-line GST is an allocation that must sum back to the document's add/less (D20).
**Gate P5:** R-30…R-40, R-70, R-71, R-73.

### P6 — Money
Per D18, exactly one of: (A) journals imported per document; (B) no journals, one balanced opening entry + party balances; (C) hybrid. Then payments/settlements/vouchers and party balances; `Account.balance` set consistently with posted lines. **Never** through `postAutoJournalEntry` or any service that mutates `Client.currentBalance` by itself.
**Gate P6:** R-52…R-56, R-60…R-66.

### P7 — GST history
Apply the D20 choice for each historical period (mark FILED through a controlled, audited one-time path, or leave open with the documented consequence). Check no import step was rejected by a period guard unexpectedly.
**Gate P7:** R-72, R-74, R-75.

### P8 — Full reconciliation and rehearsal sign-off
Run every check in the plan, produce the run report, list exceptions. Two consecutive clean rehearsals (same result set within the agreed tolerance) are required before a production date is proposed. Also: run the plan's rerun/idempotency, interrupt, delta and rollback tests (§4 there), `npm run test:rls`, `npm run audit:tenant`, client and server `tsc`.

## 3. Cutover (production) — only after Gate 0 and two clean rehearsals

1. Owner announces the freeze window; GATI users stop entering transactions; GATI set read-only (database `READ_ONLY` or access removal — owner's operational call, not done by this plan).
2. Take the final GATI backup, record its hash, restore to the read-only copy, re-run the baseline.
3. Provision the production company (operator) and run P1…P7 once against it. Same loader, same version, same mapping file as the last clean rehearsal; a changed file requires a new rehearsal.
4. Run P8 on production. **Any non-zero unexplained difference = stop** until the owner approves it in writing.
5. Physical spot check before go-live: 212 in-transit tags (D15) and a sample of stock per branch against the count.
6. Owner go/no-go. On go: users move to TRIVO; GATI stays read-only as the archive for the retention period the owner sets.

## 4. Abort and rollback

- **Before go-live:** a batch can be rolled back by `batchId` (reconciliation-plan §4.4). Rollback is allowed only while no live TRIVO transaction has touched an imported row.
- **After go-live:** no rollback. Corrections are made through normal TRIVO operations (amend, void, return, reversal), each audited — imported tags and documents are now referenced by new live ones.
- **Abort criteria:** unexplained non-zero on any check; any `GSTR*_FILED_PERIOD_IMMUTABLE` error that is not an expected, listed one; any cross-company reference; RLS/audit-tenant failure; loader exception outside the quarantine list; source freeze broken (rows changed after the baseline).
- Aborting leaves GATI untouched and the owner operating on GATI.

## 5. Things this runbook deliberately does not do

- It does not authorize building the loader or the schema changes (that is Phase 3 and needs the owner's go-ahead).
- It does not decide any status meaning, branch mapping, cost formula or accounting strategy (all open decisions).
- It does not touch `VASSSJEP`, GATI files (images, reports), Shopify/Tally/e-invoice side tables, the Metal Vault unless D29 says so, or manufacturing/BOM data.
- It does not define production infrastructure (backup of the target before load is the operator's standard `scripts/backup.sh`; restore rehearsal is the operator's).

## 6. Open items that block scheduling

D13–D33 in `DECISIONS.md`, in particular the target environment (D27), the physical resolution of the 212 unreceived transfers (D15), and the accounting strategy (D18).
