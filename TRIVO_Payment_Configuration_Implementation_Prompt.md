# TRIVO ERP — Payment Configuration & Collection Enhancement
## Implementation prompt for Claude Code / coding agent

You are working in the existing TRIVO ERP repository: `nelakodasai/ERP`.

Implement the requirements in `TRIVO_Payment_Configuration_Collection_Spec.md`. Treat this as a backward-compatible extension to the existing payment and accounting flows, not a rewrite. Follow repository conventions and verify the actual code before making assumptions.

## Required discovery before coding

1. Read the existing `TRIVO_Payment_Collection_Module.md` and `TRIVO_Payment_Configuration_Collection_Spec.md` if present.
2. Inspect the complete Prisma definitions and relationships for `InvoicePayment`, `TaxInvoice`, `SalesInvoice`, `CustomerAdvance`, `Branch`, `HardwareDevice`, `User`, and `AuditLog` (or the repository's actual equivalents).
3. Trace all current payment entry points, including tax/sales invoices, customer advances, metal transactions/conversion purchase, other receipts, split payments, returns, refunds, credit notes, and reversals.
4. Inspect the relevant routes/controllers, services, validation schemas, authorization and tenant context, audit helpers, frontend routes/menu/components, migration conventions, test setup, `server/prisma/db-secure.sql`, and schema-guard tests.
5. Check the current branch and working tree first. Preserve unrelated user changes. Do not reset, clean, overwrite, or discard existing work.
6. Before implementation, write a concise repository-specific plan identifying the models/routes/UI/components/tests to change and any genuine blockers. Then proceed with the smallest complete vertical slice; do not stop after merely presenting a plan unless an unsafe ambiguity blocks progress.
7. Reuse existing suitable structures where appropriate, but do not assume `HardwareDevice` is a POS-terminal model without checking its semantics and constraints.

## Functional requirements

### A. Configuration and management

Build management for:
- **Bank/provider master:** display name, optional short code, provider category/type, supported payment methods, active/inactive state, optional non-secret merchant/account identifiers where appropriate, timestamps, and audit history.
- **Branch availability:** configure which bank/providers can be used at each branch. A branch may have multiple providers. Only active providers assigned to the current branch should be selectable during collection.
- **POS terminals:** terminal name/code, provider/acquirer, TID, optional MID, supported methods, company and branch assignment, active/inactive state, and optional counter/user assignment only if supported by the current permission model. Prevent conflicting TID assignments within the appropriate provider/merchant/company scope without assuming TIDs are globally unique.
- **Historical integrity:** deactivating or reassigning a provider/terminal must not rewrite historical payment records or remove historical identifiers needed for reconciliation.
- Add screens, navigation, validation, authorization, and APIs using established project conventions. Restrict configuration changes to appropriate management roles.

### B. Shared payment collection workflow

Extend the existing payment UI and APIs so that, when a user selects a payment method, only relevant fields appear and the backend validates the same rules.

- **Cash:** preserve the current flow. Do not require a bank, provider, POS terminal, or UTR.
- **UPI:** capture the relevant provider/payment path and UTR/reference when available. Do not force selection of a physical POS terminal for ordinary UPI.
- **Card/POS:** require an active terminal assigned to the current company and branch, and capture an authorization/reference identifier when available.
- **Bank transfer:** capture the relevant bank/provider and UTR/reference when available.
- **Cheque:** capture cheque number/date and bank where supported by the existing domain.
- **Other methods:** preserve existing behavior and apply only method-appropriate fields and validation.

Keep these concepts distinct: customer's card-issuing bank, acquiring bank/provider, UPI app/provider, and physical POS terminal are not interchangeable. Use the repository's existing method names and enums where possible; avoid breaking existing API clients.

The workflow must work for tax invoices, sales invoices, advances, metal/conversion-purchase transactions, and other existing receipt/payment flows. Each payment leg must retain its own metadata so multiple UPI/card/bank entries can be recorded against the same document. Do not collapse split payments into one metadata record.

A manually entered UTR/reference is not proof that money has settled. Preserve existing payment statuses and confirmation behavior. If the repository has no gateway/acquirer integration, implement metadata capture only and, if useful, a clean future integration seam with tests/mocks. A TID/MID alone does not provide transaction verification.

Never store PINs, OTPs, CVVs, full card track data, provider passwords, API secrets, or other payment credentials in these records.

### C. Accounting and business invariants

Preserve all existing behavior for:
- automatic journal entries and ledger posting;
- invoice total, paid amount, balance, and payment allocation;
- advances and advance consumption/refunds;
- metal/conversion purchase accounting and stock effects;
- GST and tax invoice behavior;
- returns, credit notes, refunds, reversals, and idempotency;
- existing role restrictions on cash/online collections and branch access.

Do not create a parallel payment ledger or a second source of truth. Keep existing payment models and posting paths authoritative. Ensure every individual payment leg remains traceable and auditable.

### D. Tenant, branch, database, and audit security

- Use the established tenant transaction/query helpers and current company/branch authorization patterns.
- Validate provider, terminal, branch, and payment-document ownership server-side; never trust frontend IDs.
- Use company-aware foreign keys/constraints where consistent with the existing schema.
- Add row-level security (RLS) for every new company-owned table and update `server/prisma/db-secure.sql`, grants, and schema-guard tests as required. Do not weaken existing security policies.
- Audit master changes, branch allocations, terminal creation/reassignment/deactivation, and other sensitive configuration actions using existing audit conventions.
- Preserve historical payment metadata even if a provider/terminal is later inactive.
- Reject cross-company and unauthorized cross-branch references, including forged IDs.

### E. Migrations and compatibility

- Follow the repository's normal Prisma migration naming and conventions.
- Existing payment records must remain valid. New metadata should be nullable/backward-compatible where appropriate; do not fabricate metadata for historic records.
- Add appropriate indexes and scoped uniqueness constraints after checking actual data model semantics.
- Do not edit/delete existing payment records as part of the migration.
- Update security SQL and schema-guard tests whenever new company-owned tables are introduced.
- Do not run a production migration, deployment, host restart, database reset, or destructive command.

## Required tests

Add or update tests covering at least:

1. Legacy payment payloads still work without new metadata.
2. Cash does not require bank/provider/terminal/reference.
3. UPI and bank-transfer metadata validation.
4. Card/POS requires an active terminal assigned to the current company and branch.
5. Inactive/unassigned providers and terminals are rejected for new payments.
6. Cross-company and unauthorized cross-branch IDs are rejected.
7. Multiple UPI/card/bank payment legs on one document preserve separate metadata.
8. TID uniqueness follows the correct scoped business rule.
9. Deactivation/reassignment does not corrupt historical payment details.
10. Invoice balances, journals/ledger, advances, metal flows, GST, returns, refunds, credit notes, reversals, and idempotency do not regress.
11. RLS/schema-guard coverage and audit behavior for new tables/actions.
12. Frontend conditional fields, branch filtering, loading/error states, and validation.
13. Relevant lint, typecheck, build, and test commands.

## Working discipline

- Make small, reviewable changes and inspect the diff frequently.
- Do not silently change existing API contracts, payment enums, accounting semantics, or authorization rules.
- Do not seed real bank account numbers, merchant credentials, or production identifiers.
- Do not claim tests passed unless you actually ran them. Separate new failures from pre-existing failures and report commands/results accurately.
- Do not commit unless explicitly asked.
- Do not deploy or touch production.

## Completion report

When finished, report:
1. What changed and why.
2. Files/modules affected.
3. Migration name and whether it was only created or also applied locally.
4. Exact tests/build/typecheck commands and results.
5. Any assumptions, unresolved issues, and payment-provider integration limitations.
6. Confirmation that no production database, host, or deployment was touched.

Begin by inspecting the repository and the specification, then implement the feature end-to-end.
