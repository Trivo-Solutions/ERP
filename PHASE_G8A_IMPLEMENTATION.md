# G8a — GST Integration Foundation

Infrastructure-only phase: a provider-neutral boundary that a future e-invoice/IRP, GSTIN-lookup,
and E-Way Bill integration (G8b+) can be built on without redesigning anything. No IRN generation,
no GSTIN lookup, no E-Way Bill, no change to GST filing/reporting/accounting. See the pasted G8a
brief for the full 31-section spec this implementation was built against.

## 1. Read-only audit (done before any code)

- `CompanyGstRegistration` (`server/prisma/schema.prisma`) is the existing per-company GST
  identity record; `company.service.ts`'s `createGstRegistration`/`updateGstRegistration` is the
  reference pattern for ownership-checked CRUD + audit.
- No encryption helper existed anywhere in the codebase. No HTTP client/retry/timeout wrapper
  existed either — the one precedent, `shared/gstProvider.ts`'s `HttpGstProvider`, calls the global
  `fetch` directly with none of timeout/retry/correlation/size-bounding, and is for an unrelated
  concern (GSTIN-registry lookup, Phase C) that this phase deliberately does not touch or extend.
- No correlation-id/request-id or idempotency infrastructure existed anywhere in `server/src`.
- Audit: `middleware/audit.ts`'s `createAuditEntry(tableName, recordId, userId, action, oldValues,
  newValues, companyId)` is the one company-event audit path; reused as-is.
- Tenant/ownership: `middleware/tenant.ts`'s `assertOwnedByCompany`/`ScopedModel` union and
  `shared/tenantContext.ts`'s `tenantQuery`/`tenantTransaction` are the mandatory wrappers; reused
  as-is, with `'gstIntegrationConfig'` added to `ScopedModel`.
- Migrations: the precedent for a new company-owned table (RLS policy, composite FKs, FORCE ROW
  LEVEL SECURITY) was `20261002160000_g2g7d_inward_rcm_foundation`'s `rcm_liabilities`/
  `self_invoices` tables — copied exactly for the three new G8a tables.

No duplicate model/service/permission was created — see the "Reuse, not duplicate" notes inline in
each file.

## 2. Architecture

```
future sell-side / e-invoice code
        │
        ▼
gstIntegration.service.ts      (config CRUD, credential encryption, connection test — the
                                 provider-neutral orchestration layer; owns the
                                 authenticate→company→permission→ownership→operation pipeline)
        │
        ├── resolveProvider(name) → GstIntegrationProvider   (providers/resolveProvider.ts)
        │         └── UnconfiguredProvider                    (the ONLY concrete class shipped —
        │                                                       deterministic NOT_CONFIGURED /
        │                                                       UNSUPPORTED_PROVIDER_OPERATION)
        ├── auth/tokenSession.ts          (in-process cache, expiry, single-flight)
        ├── httpClient.ts                 (timeout, HTTPS-in-prod, bounded size, retry policy)
        ├── encryption.ts                 (AES-256-GCM credential encryption)
        ├── errors.ts                     (GstIntegrationError, category normalization)
        ├── correlationId.ts              (trace id generation)
        └── requestTracking.service.ts    (GstIntegrationRequestLog + idempotency de-dup)
```

`server/src/modules/gst/integration/` is a **new, separate** module tree — it adds nothing to the
existing `modules/gst/gst.router.ts` (Phase C GSTIN lookup/HSN/AATO/compliance) or any frozen
`modules/finance/gst/gstr1*`/`gstr3b*`/`gstr2b*` file. Mounted as its own router at
`/api/v1/gst/integration` (`app.ts`), alongside (not inside) the existing `/api/v1/gst` mount.

## 3. Models added (migration `20261002180000_g8a_gst_integration_foundation`)

- **`GstIntegrationConfig`** — one row per (GST registration × provider × environment). Never a
  Company-wide credential; a GST registration is the ownership unit (brief §6). Composite FK to
  `CompanyGstRegistration(id, companyId)`.
- **`GstIntegrationCredential`** — generic `credentialKey`/`encryptedValue` rows, one config can
  hold `clientId`/`clientSecret`/`username`/`password`/`portalId`/`apiKey`/... without a schema
  change per provider (brief §8). `onDelete: Cascade` from its parent config.
- **`GstIntegrationRequestLog`** — metadata-only trace of one operation attempt (no payload body
  stored by default, brief §14). The `@@unique([companyId, idempotencyKey])` constraint (nullable
  key, so NULLs never collide) **is** the idempotency mechanism (brief §13) — no second table.

All three: `companyId` direct FK, `@@unique([id, companyId])` composite-FK targets where
referenced, `tenant_isolation` RLS policy, `ENABLE`/`FORCE ROW LEVEL SECURITY` — identical shape to
every other tenant table. Verified zero schema drift (`prisma migrate diff`) against both
`sea_erp_test` and the real role-split `trivo_rlstest` cluster after applying.

## 4. Provider abstraction & credential security

- `GstIntegrationProvider` interface (`types.ts`): `authenticate`, `health`, and seven future
  e-invoice/EWB capability methods. Every future-capability method's only implementation
  (`UnconfiguredProvider`) returns a deterministic `UNSUPPORTED_PROVIDER_OPERATION` result — never
  throws, never fabricates data (no fake IRNs, confirmed by a dedicated test).
- `resolveProvider(name)` is the ONE place a real adapter (G8b+) gets wired in; today every
  provider name resolves to `UnconfiguredProvider`.
- `providers/mockProvider.ts` is an injectable fake (brief §24) used only by
  `auth/tokenSession.test.ts` — never resolved by `resolveProvider`, never reachable from a real
  request.
- Credentials are AES-256-GCM encrypted (`encryption.ts`), key from
  `env.GST_INTEGRATION_ENCRYPTION_KEY` (new, optional, min 32 chars — same "declared but
  unconfigured" posture as `GST_PROVIDER_API_KEY`/`METAL_RATE_API_KEY`). Never stored in the
  database, never logged. Encrypting/storing a credential with no key configured throws (503) —
  never silently falls back to plaintext (test-covered). Stored format:
  `"<iv>:<authTag>:<ciphertext>"`, each base64.
- No route or service function ever returns a decrypted value or the raw `encryptedValue` —
  `gstIntegration.service.ts`'s `toSummary()` only ever surfaces credential **keys**
  (`credentialKeys: string[]`), proven by both service-level and HTTP-level tests asserting the
  response body never contains a supplied secret value.

## 5. Sandbox/production separation

`GstIntegrationEnvironment = 'SANDBOX' | 'PRODUCTION'` travels explicitly through every call
context (`GstIntegrationCallContext.environment`) — never inferred from a URL. `httpClient.ts`
enforces HTTPS when `environment === 'PRODUCTION'`, rejecting an `http://` URL before ever calling
`fetch` (test-covered); `SANDBOX` has no such requirement. A config's `(gstRegistrationId, provider,
environment)` triple is unique, so a sandbox and a production config for the same provider+
registration are structurally separate rows, never conflatable.

## 6. Authentication foundation

`auth/tokenSession.ts`: a per-process `Map`-based cache keyed by `configId`, with:
- expiry (5s skew before a cached session is treated as stale),
- single-flight concurrency protection (concurrent callers for the same `configId` share one
  in-flight `provider.authenticate()` call — proven with a real `authenticateDelayMs` race test),
- a result with no `expiresAt` is never cached (treated as single-use),
- `invalidateSession(configId)` for a future 401-triggered re-auth.

Scope limitation stated plainly in the file and here: this cache is **per-process**, not
Redis-backed — correct for a single-instance deployment; a horizontally-scaled API would want a
shared cache. Out of scope for G8a (see §12 below), and the function signature doesn't leak the
storage choice, so this is additive later, not a redesign.

## 7. Encryption boundary (brief §27)

`TRIVO canonical request → provider adapter → provider-specific serialization → encryption → HTTP`
is the intended boundary; this phase builds the HTTP/auth/credential-encryption layers and the
adapter *interface*, and deliberately does not invent any provider-specific wire serialization or
IRN payload encryption algorithm — there is no real provider to serialize for yet.

## 8. HTTP client (`httpClient.ts`)

Single controlled entry point `gstIntegrationFetch()`: explicit timeout (`AbortController`, default
15s), HTTPS-required for `PRODUCTION`, bounded response size (default 2MB, override for tests),
correlation-id header on every call, structured `GstIntegrationError` on any non-2xx/network/
timeout/oversized-response failure, and **retry only when both** (a) the category is one of
TIMEOUT/NETWORK/RATE_LIMIT/PROVIDER and (b) the caller's `operation` is in
`IDEMPOTENT_SAFE_OPERATIONS` (`HEALTH_CHECK`/`GET_GSTIN_DETAILS`/`GET_IRN`/`GET_IRN_BY_DOCUMENT`) —
`GENERATE_IRN`/`CANCEL_IRN`/`GENERATE_EWAYBILL`/`CANCEL_EWAYBILL` are never retried, proven by a
test that a 500 on `GENERATE_IRN` is called exactly once. Never logs headers or body — only method,
host+path, status, correlationId, duration.

## 9. Idempotency & request/response tracking

`requestTracking.service.ts`: `buildIdempotencyKey({companyId, gstRegistrationId, provider,
environment, operation, naturalKey})` is a deterministic SHA-256 hash. `startRequest()` tries to
INSERT a PENDING `GstIntegrationRequestLog` row; on a unique-constraint collision for the same
`(companyId, idempotencyKey)` it fetches and returns the **existing** row (`isNew: false`) instead
of creating a duplicate operation record — proven by a test that two `startRequest()` calls with the
same key resolve to the same row id, and that the DB holds exactly one row. Requests with no
idempotency key never collide with each other (NULL ≠ NULL in a unique index) — also tested.

## 10. Error normalization

`GstIntegrationError` (`errors.ts`): `category` (one of the ten in the brief), `provider`,
`operation`, `providerCode`, `retryable`, `correlationId`. `categoryForHttpStatus()` maps
401→AUTHENTICATION, 403→AUTHORIZATION, 400/422→VALIDATION, 409→DUPLICATE, 429→RATE_LIMIT,
5xx→PROVIDER. `toSafeJSON()` is the only serialization path — no stack, no internal detail.

## 11. Correlation IDs

`correlationId.ts: generateCorrelationId()` — `gstint_<uuid>`. No prior request-id infrastructure
existed to reuse (verified by search); this is intentionally small rather than a competing system.
Every `GstIntegrationRequestLog` row and every `GstIntegrationHttpRequest`/error carries one, tracing
TRIVO request → log row → (future) provider HTTP request.

## 12. Permissions

Three new strings in `permissionCatalog.ts`: `gst:integration_view`, `gst:integration_manage`,
`gst:integration_test`. Matches the existing `gst:registration_*`/`gst:period_*` underscore-action
convention; `starterPackage/validate.ts`'s permission regex already accommodates it (no change
needed). **Not granted to any starter role** (SUPER_ADMIN only, via the wildcard) — same posture as
`gstFiling` (G2g-6a) when it shipped ahead of any starter-role grant, per brief §19's explicit
instruction.

## 13. Routes (`gstIntegration.router.ts`, mounted at `/api/v1/gst/integration`)

| Method | Path | Permission |
|---|---|---|
| GET | `/registrations/:gstRegistrationId` | `gst:integration_view` |
| POST | `/registrations/:gstRegistrationId` | `gst:integration_manage` |
| PATCH | `/:id` | `gst:integration_manage` |
| POST | `/:id/test` | `gst:integration_test` |

`/test` runs only a read-only health check — never an IRN/EWB mutation (brief §20/§23), and the
service layer reads config+credentials via `tenantQuery` (DB only) **before** calling the provider,
and makes the actual provider call **outside** any transaction, per `tenantContext.ts`'s hard rule
that no non-database I/O may happen inside `tenantTransaction`.

## 14. Security pipeline

Every function: `authenticate` (route middleware) → `company context` (`req.tenant`) →
`permission` (route middleware) → `GST registration / config ownership`
(`assertOwnedByCompany('companyGstRegistration'|'gstIntegrationConfig', ...)`) → operation. A wrong
company's registration or config id is a 404 (indistinguishable from nonexistent), never a 403 that
would leak existence. `rejectClientTenantSelectors` rejects a client-supplied `companyId` with 400
(HTTP-tested).

## 15. Auditing

`createAuditEntry('gst_integration_configs', ..., 'CREATE'|'EDIT', before, after, companyId)` on
every config create/update, recording provider/environment/label/isActive and **which credential
keys changed** — never a value (service-level test asserts the audit row serializes the key name
`password` but never the secret value supplied for it).

## 16. No real provider calls, ever, in this phase

`UnconfiguredProvider` performs no network I/O at all — `health()`/`authenticate()` are pure,
synchronous-shaped async functions returning a fixed result. There is no code path in this phase
that can reach a real IRP/GSP/GSTN endpoint, in tests, dev, or production, by construction (not by
a disabled flag that could be flipped on by accident).

## 17. Tests

- `encryption.test.ts` (7), `httpClient.test.ts` (13), `providers/unconfiguredProvider.test.ts` (7,
  incl. `it.each` over all five provider names), `auth/tokenSession.test.ts` (7, incl. a real
  single-flight concurrency race and a fake-timer expiry test), `requestTracking.service.test.ts`
  (6, DB-backed), `gstIntegration.service.test.ts` (12, DB-backed: encryption-at-rest, tenant
  isolation, duplicate-config 409, audit content) — **55 tests**, all green.
- `server/src/test/http.gstIntegrationSecurity.test.ts` (10): 401 unauthenticated, 403 per missing
  permission (view-only can't mutate, manage-only can't test), credential values never echoed over
  HTTP, cross-company 404 on list/create/update/test with no leak and no mutation, client-supplied
  `companyId` rejected 400, unknown provider/environment rejected 400. **10 tests**, all green.

## 18. Verification (run once each, per the brief's §30)

- G8a-targeted suite: **65/65 passed**.
- GST regression (`finance/gst`, `company`, `gst` modules, 47 files): **869/869 passed**.
- Full server suite: **2200 passed, 5 skipped** (pre-existing skips, unrelated to G8a).
- Real role-split RLS suite (`npm run test:rls` against `trivo_rlstest`): **2204 passed, 1 skipped**
  (pre-existing).
- `npm run audit:tenant`: **0 company-owned-model violations**.
- `npx tsc --noEmit`: clean except one **pre-existing, unrelated** error in
  `gstr3bGstnWire.test.ts` — see Out-of-scope findings below. No client files touched, so no client
  build was run.
- `npx prisma validate`: clean. Migration applied and verified **zero drift** against both
  `sea_erp_test` and `trivo_rlstest` (owner role), and `db-secure.sql` re-run against `trivo_rlstest`
  so the three new tables are correctly granted to `trivo_runtime`/`trivo_platform`.

## 19. Out-of-scope findings (documented, not fixed)

- `server/src/modules/finance/gst/gstr3bGstnWire.test.ts` fails `tsc --noEmit` with a pre-existing
  type error (`taxableValue: number` not assignable to `type '0'` on
  `Gstr3bTable31SectionUnsupported`) — confirmed via `git status`/`git diff` to be fully committed,
  untouched by this phase, and present before G8a work began. Frozen file; not fixed here.

## 20. Known, deliberate scope limitations (not bugs)

- The auth/session cache is per-process, not shared across horizontally-scaled instances (§6 above).
- No real `GstIntegrationProvider` adapter exists — `resolveProvider` always returns
  `UnconfiguredProvider`. This is G8a's intended end state, not a gap; G8b+ adds a real adapter
  behind the same interface with no change to the service/router layer.
- No admin UI screen for managing integration configs — brief §17 explicitly says not to build one
  unless an appropriate settings screen already exists; none does for this concept.
