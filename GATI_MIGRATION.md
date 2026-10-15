GATI-to-TRIVO Enterprise ERP Migration

Client: Vasavi Gold & Diamonds
Project: Enterprise ERP Migration
Current branches: 4
Target branches: 5
Status: Phase 1 — Discovery
Production migration: Not approved

1. Project Objective

Migrate Vasavi Gold & Diamonds from GATI ERP to TRIVO ERP while preserving all required historical, inventory, operational, and financial data.

The migration must support five branches, maintain stock accuracy, preserve historical transaction references, and ensure business continuity.

This is a major enterprise implementation. Do not treat it as a simple database import.

2. Environment

The TRIVO Git repository has been connected to the Claude project.

The local TRIVO repository and GATI environment are available on the same Windows server, according to the project owner.

Claude Code is installed on that server.

Verify actual local repository access, database connectivity, and permissions before proceeding.

Verify the actual GATI database engine, version, instance, databases, schemas, and connection method. Do not assume MySQL or Microsoft SQL Server based on an instance name.

Inspect the actual TRIVO codebase and deployed environment before assuming its architecture or implementation status.

3. Required Migration Scope

Master data

Branches, users, roles, and permissions

Customers and suppliers

Item categories, product masters, metal and purity masters

Stone masters, tax configuration, charges, and payment methods

Jewellery tags and stock

All tags and barcodes

Original tag numbers and source identifiers

Gross weight, net weight, stone weight, purity, and other item attributes

Original tag creation and tagging dates

Original purchase/inward references

Original cost and its components

Current status and branch

Complete stock movement history

Sold, returned, transferred, retired, and other relevant tag states

Purchases and costing

Purchase invoices and invoice lines

Inward and goods receipt transactions

Supplier references and purchase returns

Metal value, stone value, making charges, and other cost components

Historical cost and valuation methods

Sales and returns

Sales invoices and invoice lines

Original invoice numbers and dates

Discounts, making charges, taxes, and payment allocations

Cancelled invoices and reversals

Sales returns, exchanges, refunds, and original-sale links

Branch transfers

Transfer vouchers and line items

Dispatch and receipt transactions

Sending and receiving branches

In-transit stock and pending transfers

Transfer cancellations and reversals

Finance and other transactions

Customer and supplier ledgers

Receipts, advances, outstanding balances, and payment references

Stock adjustments and conversions

Melting, repairs, approvals, and other workflows actually used

GST-related records, credit/debit notes, and day-end reports

Confirm each category exists and is used by inspecting GATI and validating findings with business reports.

4. Mandatory Safety Rules

Begin with read-only discovery.

Never modify, delete, or disrupt live GATI data.

Do not alter TRIVO production data or apply production schema migrations without explicit approval.

Do not start a production import until the mapping, test results, reconciliation plan, backup/restore plan, and rollback procedure are approved.

Do not install packages, restart services, change server configuration, or alter network settings without approval.

Never expose credentials, tokens, private keys, or sensitive customer data in reports or Git.

Never commit production database dumps or sensitive exports.

Use an approved, isolated staging environment for test imports.

Do not invent schema relationships, cost formulas, or business rules. Mark unknowns as unresolved.

Never double-post historical stock movements, invoices, returns, receipts, or accounting transactions.

Check the Git branch and working-tree changes before editing. Preserve unrelated work.

Make small, reviewable changes with appropriate tests and rollback instructions.

Stop at each approval gate and report findings before proceeding.

5. Migration Architecture Principles

The eventual migration solution must support:

Stable source identifiers and traceability to original GATI records

Idempotent imports that can be safely retried

Duplicate detection and referential integrity

Import batches, checkpoints, resumability, and error reporting

Historical dates, voucher numbers, invoice numbers, and branch references

Original costs and documented cost-calculation rules

Historical transaction records separated from new live TRIVO postings

Correct treatment of cancellations, reversals, partial returns, and pending transfers

Company and branch isolation

Data validation and reconciliation at every stage

A controlled final extraction or cutover process for transactions created during migration

Tested backups, restoration, and rollback

Do not finalize the architecture until the source database and target implementation have been inspected.

6. Required Documentation

Create a dedicated documentation directory, preferably docs/gati-migration/, if compatible with the existing repository conventions.

Maintain these documents as evidence becomes available:

environment-inventory.md — verified environment, database engine, and access methods.

trivo-repository-map.md — modules, data models, migrations, and existing functionality.

gati-schema-inventory.csv — relevant tables, columns, data types, keys, and relationships.

gati-transaction-relationships.md — transaction lifecycle and source relationships.

source-to-target-mapping.csv — GATI fields mapped to TRIVO fields, transformations, and validation rules.

trivo-gap-analysis.md — missing features and required changes.

migration-reconciliation-plan.md — comparison reports, validation criteria, and exception handling.

migration-runbook.md — proposed migration stages, cutover, rollback, and responsibilities.

DECISIONS.md — dated decisions, rationale, approval, and unresolved questions.

PROGRESS.md — completed tasks, evidence, blockers, and next steps.

Do not invent findings to populate these documents. Mark each finding as Confirmed, Hypothesis, or Unresolved.

7. Project Phases

Phase 1 — Discovery

Inspect the repository, database environment, schemas, transaction relationships, and current TRIVO functionality.

Approval gate: Review discovery reports before changing the target schema or designing implementation details.

Phase 2 — Mapping and design

Prepare the source-to-target mapping, identify missing features, and design the migration and reconciliation architecture.

Approval gate: Approve the mappings and architecture before implementation.

Phase 3 — Migration development

Implement the approved import tooling, validations, idempotency, error handling, and automated tests.

Approval gate: Approve the staging test plan.

Phase 4 — Staging migration

Run test imports in an isolated environment and reconcile tags, stock, costing, invoices, returns, transfers, and financial balances.

Approval gate: Obtain business approval of reconciliation results.

Phase 5 — Cutover preparation

Finalize the extraction/freeze plan, backups, restore tests, staff readiness, operational testing, and rollback procedure.

Approval gate: Explicitly approve production cutover.

Phase 6 — Controlled rollout

Roll out the approved migration across the four existing branches and prepare the fifth branch. Reconcile and obtain sign-off at every agreed milestone.

Do not assume timelines until data volume, complexity, and business availability are established.

8. Reconciliation Requirements

At minimum, establish comparisons for:

Tag counts, duplicate identifiers, status, and branch

Branch-wise stock quantities and weights

Inventory valuation and historical cost

Purchase and sales invoice counts and totals

Discounts, taxes, and payment allocations

Returns, refunds, and original invoice relationships

Branch transfer dispatches, receipts, and pending movements

Customer/supplier balances, receipts, advances, and ledgers

Relevant GST and day-end reports

Missing references, rejected records, and duplicate imports

Agree on authoritative source reports and acceptable tolerances with the client. Never silently discard or automatically correct discrepancies.

9. Instructions for Claude

At the start of every session:

Read this file, PROGRESS.md, and DECISIONS.md if they exist.

Check the current Git branch and working-tree status.

Identify the current project phase and applicable approval gate.

Use actual code and database evidence.

Separate confirmed findings from hypotheses and unresolved questions.

Report files inspected or changed, tests run, results, risks, and next steps.

Update progress and decision records when significant findings are confirmed.

Never claim that a task or test was completed unless it actually was.

10. First Task

Perform Phase 1 only.

Inspect the local TRIVO repository and GATI environment using read-only methods. Verify the actual database engine and connection method. Map the relevant GATI schemas and transaction relationships to the existing TRIVO modules and data models.

Prepare the discovery reports and identify all unresolved questions.

Do not write migration code, alter either database, install dependencies, run schema changes, or import production data.

Stop after discovery and wait for explicit approval before implementing anything.