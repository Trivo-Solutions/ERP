# TRIVO ERP — Payment Configuration & Collection Specification

**Purpose:** Extend the existing TRIVO ERP payment collection workflow with centrally managed bank/provider configuration, branch-level availability, POS terminal/TID management, and payment-method-specific metadata. This is an implementation specification for the existing repository, not a replacement payment or accounting system.

**Repository:** `nelakodasai/ERP`  
**Safety:** Do not make production changes. Confirm actual schema, services, permissions, and naming before implementation.

## 1. Goals

1. Manage banks/payment providers centrally.
2. Control which providers are available at each company branch.
3. Manage physical POS terminals, including TID and optional MID, and assign them to branches.
4. Capture the correct metadata for each payment leg across invoices, advances, metal/conversion-purchase transactions, and other existing collection flows.
5. Support split payments, including multiple UPI entries against the same bill or estimation.
6. Preserve tenant isolation, auditability, accounting behavior, and compatibility with existing payment records and API clients.

## 2. Existing implementation to verify first

Inspect the current equivalents of:

- Prisma models: `InvoicePayment`, `TaxInvoice`, `SalesInvoice`, `CustomerAdvance`, `Branch`, `HardwareDevice`, `User`, `AuditLog`.
- Services: `server/src/modules/finance/finance.service.ts`, `server/src/modules/sales/sales.service.ts`.
- Security: `server/prisma/db-secure.sql` and schema-guard tests.
- Existing tenant helpers such as `tenantTransaction`, `tenantQuery`, `assertBranchAccessible`, `assertOwnedByCompany`, and `assertAllOwned`, if still present.

These names are discovery leads, not permission to assume the current repository is unchanged. Confirm actual fields, relations, transaction boundaries, and authorization rules. Evaluate whether `HardwareDevice` is semantically suitable for POS terminals before reusing it.

## 3. Configuration data

### 3.1 Bank/provider master

Use an appropriate company-scoped or shared-master pattern consistent with the existing ERP architecture. The exact schema should be chosen after inspecting current conventions. Candidate fields:

- ID and company scope, if company-owned;
- display name;
- optional short code;
- provider category/type (for example bank, UPI provider, acquiring provider, or other supported category);
- supported payment methods;
- active/inactive status;
- optional non-secret merchant/account identifier when needed;
- created/updated timestamps and audit history.

Examples of display names include SBI, HDFC, IDBI, and Axis Bank. Do not seed actual account numbers, credentials, or production merchant identifiers. Avoid making a single category field incorrectly imply that issuing bank, acquiring bank, UPI app, and terminal are the same thing.

### 3.2 Branch-provider availability

- Allow multiple active providers at a branch.
- Maintain an explicit company/branch relationship using existing tenant conventions.
- Only show active providers configured for the user's authorized branch during collection.
- Enforce availability and ownership on the server, not only in the frontend.
- Audit allocation, removal, and status changes.
- Historical payment records must remain readable if an allocation is later removed.

### 3.3 POS terminal management

Candidate fields:

- ID and company scope;
- terminal name/code;
- acquiring bank/provider relation;
- TID (terminal ID);
- optional MID (merchant ID);
- supported payment methods;
- branch assignment;
- optional counter/user assignment only if the current authorization model supports it;
- active/inactive status;
- created/updated timestamps and audit history.

Validation and lifecycle:

- A terminal must belong to the current company and an authorized branch.
- New card/POS payments may select only an active terminal assigned to the payment's branch.
- Prevent conflicting TID assignments within the appropriate company/provider/merchant scope. Do not assume TIDs are globally unique; confirm real business semantics before defining the unique index.
- Deactivation or reassignment must not rewrite old payment records.
- Do not store terminal passwords, provider API secrets, PINs, OTPs, CVVs, or full card data.

## 4. Payment collection behavior

### 4.1 General rules

- Extend the existing payment model and posting workflow; do not introduce a duplicate ledger.
- Keep new metadata optional for historic records and backward compatibility.
- Persist metadata on each individual payment record/leg, not only on the invoice or parent transaction.
- A document may have multiple payment records and multiple entries of the same method, including multiple UPI entries.
- Reuse existing method enums and API shapes where possible. If an enum/API change is required, assess migration and compatibility impact first.
- Server-side validation must match frontend conditional fields.
- A manual UTR/reference is reconciliation information, not proof of successful settlement.

### 4.2 Method-specific requirements

| Payment method | Collection behavior | Required metadata policy |
|---|---|---|
| Cash | Preserve current cash collection flow | No bank, provider, POS terminal, or UTR required unless existing domain rules require another field |
| UPI | Capture the applicable UPI provider/payment path and UTR/reference when available | Do not require a physical POS terminal for ordinary UPI |
| Card/POS | Select an active branch-assigned POS terminal | Terminal required; capture authorization/reference when available |
| Bank transfer | Select the relevant bank/provider | UTR/reference when available; validate provider/branch ownership |
| Cheque | Use existing cheque workflow where supported | Cheque number/date and bank as supported by the domain |
| Other existing methods | Preserve existing behavior | Add only method-appropriate metadata and validation |

The table is a behavioral guide. Existing enum values and domain-specific restrictions take precedence where they are more specific; document any incompatibility rather than silently breaking a flow.

### 4.3 Keep related concepts separate

- **Issuing bank:** the customer's bank/card issuer.
- **Acquirer/provider:** the bank or payment provider processing the merchant's payment.
- **UPI app/provider:** the UPI path used by the customer, when known and useful.
- **POS terminal:** physical device identified by its TID and potentially associated MID.
- **Reference/UTR/auth code:** a transaction identifier, not a provider or device.

Capture only what is relevant and available for the selected method.

### 4.4 Payment status and external integrations

- Preserve the current payment status model and transition rules.
- If a gateway/acquirer integration already exists, use its established verification and idempotency contract.
- If no such integration exists, implement configuration and metadata capture only; an integration interface may be added if it fits existing architecture.
- Do not represent a payment as automatically verified merely because a user supplied a UTR or selected a TID/MID.
- Mock provider calls in tests; never require live credentials for normal unit/integration tests.

## 5. Business flows to cover

Trace and support the existing applicable flows, including:

1. Tax invoice and sales invoice collection.
2. Customer advance receipts and advance adjustments/refunds.
3. Metal transactions and conversion purchase.
4. Other existing receipts/payment collection paths.
5. Split payments with more than one method and repeated entries of the same method.
6. Returns, refunds, credit notes, and reversals where the application records or changes payment details.

Do not add a new flow merely because it is listed here if the repository has no such flow; identify the actual existing entry point and report any unsupported domain path.

## 6. Accounting invariants

The enhancement must not regress:

- invoice totals, paid amounts, outstanding balances, and allocations;
- automatic journal entries, ledger accounts, and accounting posting;
- customer advance balances and consumption/refunds;
- metal/conversion-purchase accounting and inventory/stock behavior;
- GST and tax invoice calculations;
- return, refund, reversal, and credit-note handling;
- idempotency and duplicate-submission protections;
- existing permissions/restrictions for cash and online collection.

Payment configuration is metadata and selection logic; it must not become a second accounting source of truth.

## 7. Multi-company, branch security, and audit

- Use existing tenant context and transaction/query helpers.
- Check company ownership and branch access on every read/write and payment submission.
- Reject forged, inactive, unassigned, or cross-company provider/terminal IDs.
- Use company-aware foreign keys/constraints where consistent with current schema design.
- Every new company-owned table must have appropriate RLS policies and least-privilege grants.
- Update `server/prisma/db-secure.sql`, schema-guard tests, and relevant security checks for any new tables or policies.
- Do not weaken existing RLS, database grants, or tenant checks to make the feature work.
- Audit creation and edits of provider masters, branch allocations, terminals, TID/MID changes, deactivation, and reassignment.
- Preserve historical payment identifiers/metadata after a configuration record is deactivated or reassigned.

## 8. UI and permissions

Use the existing frontend framework, design system, navigation, route guards, and API patterns.

### Configuration screens

- Bank/provider list with search/filter and active status.
- Create/edit provider form.
- Branch-provider allocation screen.
- POS terminal list and create/edit screen with TID, optional MID, provider, branch, supported method, and status.
- Clear loading, validation, permission-denied, and server-error states.

### Collection screens

- Keep the existing method selection and overall collection experience.
- Reveal only fields relevant to the selected method.
- Filter provider/terminal options to the user's authorized current branch.
- Support multiple payment legs and preserve each leg's metadata.
- Do not rely on hiding an option in the UI as a security control.
- Restrict master/terminal management to authorized roles using existing permission conventions.

## 9. Database migration and compatibility

- Use the repository's normal migration naming and Prisma conventions.
- Make additions backward-compatible wherever possible; nullable metadata should not invalidate existing payment rows.
- Do not fabricate metadata for historical payments.
- Do not delete or rewrite existing payment records during migration.
- Add indexes and scoped unique constraints only after validating actual data-model semantics.
- Add company/branch relationships and foreign keys consistent with the existing tenant model.
- Update RLS/security SQL and schema-guard coverage for every new company-owned table.
- Do not reset or seed a real database, run a production migration, deploy, or restart production services.

## 10. Acceptance tests

At minimum, cover:

- existing payment payload without new metadata;
- cash collection without bank/provider/terminal/UTR;
- UPI and bank-transfer metadata validation;
- card/POS collection requiring an active terminal assigned to the current branch;
- inactive provider/terminal rejection;
- forged and cross-company/cross-branch IDs rejected;
- multiple UPI entries and split payments retaining independent metadata;
- scoped TID uniqueness;
- deactivation/reassignment preserving historical payment details;
- invoice balance, journal/ledger, advance, metal, GST, returns, refunds, credit-note, reversal, and idempotency regression tests;
- audit history and RLS/schema-guard tests;
- frontend conditional fields, branch filtering, validation, and error states;
- relevant typecheck, lint, build, and test commands.

## 11. Suggested implementation sequence

1. Inspect the current spec, schema, routes/services, auth, UI, tests, and security SQL.
2. Map each supported collection flow and its current payment persistence/accounting behavior.
3. Finalize the schema design and migration, including company/branch scope and audit.
4. Add provider/branch/terminal APIs and authorization.
5. Add the management UI and navigation.
6. Extend shared collection validation/UI to store per-payment metadata.
7. Integrate the affected transaction flows without duplicating accounting logic.
8. Add tests, update security guards, and run checks.
9. Review the final diff for compatibility, tenant isolation, and unrelated changes.

## 12. Completion report required

Provide:

- summary of behavior implemented;
- list of changed files/modules;
- migration name and whether it was created or applied locally;
- exact test/build/typecheck commands and results;
- known limitations and whether a real payment-provider integration exists;
- confirmation that no production database, host, or deployment was touched.
