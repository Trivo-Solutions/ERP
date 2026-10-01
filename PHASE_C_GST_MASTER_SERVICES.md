# Phase C — GST Master Services

Reusable GST master/utility services: GSTIN validation, a provider-independent GSTIN lookup
abstraction, and an HSN/SAC search/lookup/validate service. Consumed today only by their own HTTP
routes; intended for Customer Master, Supplier Master, Product/Item Master, Sales, Purchase,
E-Invoice, E-Way Bill, and GSTR-1 to call directly later. **Read-only and additive** — no existing
GST behavior (Phase A/B, frozen; the in-progress G0–G2 e-invoice work) was touched.

## 1. GSTIN validation — `server/src/shared/gstin.ts`

`validateGstin(raw: unknown): GstinValidationResult` — pure, synchronous, no DB/network:

```ts
interface GstinValidationResult {
  valid: boolean;
  gstin: string;          // normalized (trimmed + upper-cased) input, even when invalid
  stateCode?: string;
  pan?: string;
  entityCode?: string;
  errors: string[];
}
```

Checks, in order: required/non-empty → exactly 15 characters → GSTIN alphabet (`[0-9A-Z]`) only →
structural shape (2-digit state code, 10-char PAN, 1-char entity code `[1-9A-Z]`, literal `Z`) →
state code is one of the 36 allotted GST state/UT codes (mirrors `StateMaster`'s seed) →
**check-digit (character 15) verified via the standard GSTIN checksum algorithm**, not just length.
`errors` accumulates every applicable failure; `valid` is `errors.length === 0`.

`normalizeGstin(raw)` is exported separately for callers that only need the trim+uppercase step.

**Reuse, not duplication:** `company.service.ts` already has a simpler 15-char format check
(`assertValidGstin`, Phase G1, used only for `CompanyGstRegistration`). It was deliberately **left
untouched** — this phase's `validateGstin` is a strict superset (adds checksum + structured errors)
but refactoring frozen Phase G1 code to call it is out of this phase's scope.

**Compliance disclaimer:** the structural rules and check-digit algorithm are reproduced from
general public GST/GSTIN reference knowledge, not fetched from or verified against a live GSTN
source. Verify against a real, portal-verified GSTIN before relying on this for a statutory filing
decision (e.g. rejecting a customer's GSTIN at billing time). Same posture as the existing
`gstUqc.ts`'s own "COMPLIANCE CONFIRMATION REQUIRED" disclaimer.

## 2. GSTIN lookup — `server/src/shared/gstProvider.ts`

```
lookupGstin(gstin, provider?)
  |
  +-- validates first (shared/gstin.ts) — a malformed GSTIN never reaches a provider
  |
  +-- GstProvider interface — { name, lookupGstin(gstin): Promise<GstinLookupOutcome> }
  |
  +-- UnconfiguredGstProvider  — the default; always NOT_CONFIGURED
  +-- HttpGstProvider          — ready once GST_PROVIDER_API_URL/KEY are set (see §5)
```

`GstinLookupOutcome` is a discriminated union: `INVALID | NOT_CONFIGURED | FOUND | NOT_FOUND |
PROVIDER_ERROR`. **No GST Portal scraping, no unofficial API dependency, no fabricated response
data** — this repo has no authorized provider credentials today, so every lookup resolves to
`NOT_CONFIGURED` until one is configured. `GstinLookupResult` only ever carries fields a real
provider actually supplied — nothing is invented to fill a gap.

## 3. HSN/SAC service — `server/src/shared/hsnSac.ts`

`searchHSN(query?, {limit, offset})`, `searchSAC(...)`, `getHSN(code)`, `getSAC(code)`,
`validateCode(code, codeType)`. All read-only against the existing `HsnCode` table (see §4) — bounded
by `limit`/`offset` (default 25, capped at 100), never loads the whole master into memory.

Distinct from the ad-hoc `prisma.hsnCode.findMany(...)` calls already in `sales.service.ts` /
`procurement.service.ts` / `creditNote.service.ts` / `debitNote.service.ts` — those resolve a fixed
set of codes to price one transaction; this module is the general-purpose search/lookup surface for
a future Product/Item Master or a GSTIN/HSN picker screen.

No GST rate is invented for SAC: this app has no authoritative SAC rate source (no service line is
sold), so `searchSAC()`/`getSAC()` simply return whatever SAC rows exist (zero, today).

## 4. Data model change

**Reused the existing `HsnCode` table** rather than creating a new one, per this phase's "do not
create unnecessary GST tables" instruction. Added one column:

```prisma
model HsnCode {
  ...
  codeType String @default("HSN")   // 'HSN' | 'SAC'
  @@index([codeType])
}
```

Migration: `server/prisma/migrations/20260930130000_gst_master_services_hsn_code_type/`. Purely
additive — `NOT NULL DEFAULT 'HSN'` means every existing/seeded row (only HSN 7113 has ever been
seeded) reads exactly as before; no existing consumer of `HsnCode` needed any change, since none of
them filter or care about `codeType`. `HsnCode` remains global platform reference data (no
`companyId` — CLAUDE.md §11's allow-list) and remains **read-only to the API**: `db-secure.sql`
grants the runtime role `SELECT` only on `hsn_codes`, so a `SAC` row — like an `HSN` row — can only
ever be added via a migration, never a request. No SAC row was seeded (no authoritative source
exists), matching "do not invent GST rates / do not create a fake rate database."

## 5. API endpoints — `server/src/modules/gst/gst.router.ts`, mounted at `/api/v1/gst`

All routes: `authenticate` + `requirePermission('masters:view')` — the same permission that already
gates every other read-only reference-data lookup in this app (karats, HSN-for-pricing, categories,
...). No new permission was created; `masters:view` already represents the needed authority.

| Method | Path | Purpose |
|---|---|---|
| GET | `/gst/gstin/validate?gstin=` | Structural + checksum validation. Always `200`; the result's `valid` field carries the verdict. |
| GET | `/gst/gstin/lookup?gstin=` | Validates, then asks the configured provider. See error contract below. |
| GET | `/gst/hsn/search?q=&limit=&offset=` | Paginated HSN search. |
| GET | `/gst/sac/search?q=&limit=&offset=` | Paginated SAC search (empty today — no SAC data exists). |
| GET | `/gst/hsn/:code` | Exact HSN lookup. `404` if not found. |
| GET | `/gst/sac/:code` | Exact SAC lookup. `404` if not found. |
| GET | `/gst/codes/validate?code=&codeType=HSN\|SAC` | Is `code` a known, active code of that type? |

Response envelope on success matches every other router: `{ success: true, data }`.

### Error contract

`/gst/gstin/lookup` and the `:code` routes return structured errors directly (not the app's usual
single-string `AppError` shape) so the four failure kinds this phase asked to be distinguishable
actually are, by both HTTP status and machine-readable code:

```json
{ "success": false, "error": { "code": "GST_PROVIDER_NOT_CONFIGURED", "message": "..." } }
```

| Code | Status | When |
|---|---|---|
| `GST_INVALID_GSTIN` | 400 | The GSTIN failed `validateGstin` before any provider was called. |
| `GST_PROVIDER_NOT_CONFIGURED` | 503 | No `GST_PROVIDER_API_URL` is set. |
| `GST_NOT_FOUND` | 404 | The provider was reachable but has no record for this GSTIN. |
| `GST_PROVIDER_ERROR` | 502 | The provider errored, timed out, or returned an unparseable response. |
| `GST_HSN_NOT_FOUND` / `GST_SAC_NOT_FOUND` | 404 | Exact-code lookup found nothing. Message never echoes the requested code back (see the router's own comment — this app's cross-company isolation sweep generically flags any response that echoes a path-param id, to catch real leaks; these codes are global so there's nothing to leak, but the response still avoids it for consistency). |

Every other failure on these routes (missing/invalid auth, missing permission) goes through the
app's normal error middleware unchanged — same single-string `{ success: false, error: "..." }`
shape as every other router.

## 6. Plugging in a real GSTIN provider

1. Choose an authorized GST data provider and obtain credentials.
2. Set `GST_PROVIDER_API_URL`, `GST_PROVIDER_API_KEY`, and optionally `GST_PROVIDER_NAME` in the
   server's environment (`server/src/config/env.ts` — same "declared but unconfigured by default"
   pattern as the pre-existing `METAL_RATE_API_URL`/`KEY`).
3. `resolveGstProvider()` (`shared/gstProvider.ts`) will then construct an `HttpGstProvider` against
   that URL/key automatically — no code change needed if the provider matches the expected
   contract: `GET {url}?gstin=...` with `Authorization: Bearer {key}`, returning
   `{ found: true, ...fields }` or `{ found: false }`.
4. If the real provider's response shape differs, adjust `HttpGstProvider`'s field mapping in
   `gstProvider.ts` — never invent a value the response didn't actually supply.
5. Credentials live only in server-side env vars; nothing here exposes them to the frontend (no
   route returns `GST_PROVIDER_API_KEY`, and it's never logged).

`HttpGstProvider` is implemented but **untested against any real provider** — none is configured in
this repo. It is covered by unit tests using a stubbed `fetch` (`shared/gstProvider.test.ts`), which
prove the response-mapping logic but not real-world compatibility with a specific vendor's API.

## 7. Tests

- `shared/gstin.test.ts` — 12 tests: valid GSTIN, normalization (case/whitespace), null/empty,
  wrong length, invalid characters, unrecognized state code, invalid PAN shape, invalid checksum,
  missing literal `Z`, out-of-range entity code.
- `shared/gstProvider.test.ts` — 13 tests: format-invalid short-circuits before the provider runs,
  `NOT_CONFIGURED` with the default provider, `FOUND`/`NOT_FOUND`/`PROVIDER_ERROR` pass-through, a
  throwing provider still resolves to `PROVIDER_ERROR` (never an unhandled rejection), and
  `HttpGstProvider`'s own response mapping (found/not-found/HTTP 404/non-2xx/malformed JSON/missing
  `found` field/network failure) via a stubbed `fetch`.
- `shared/hsnSac.test.ts` — 15 tests: exact/substring search, inactive rows excluded, pagination,
  HSN/SAC type isolation, no-match returns empty (not an error), exact lookup (found/wrong-type/
  missing), and `validateCode` (active/inactive/unknown/empty/wrong-type).
- `test/http.gstMasterServices.test.ts` — 9 tests over real HTTP: unauthenticated → 401,
  `masters:view` gates every route (granted succeeds, an unrelated permission is 403 on all seven),
  validate/lookup/search/exact-lookup response shapes and status codes, and an explicit isolation
  check that the same global HSN row is visible identically to two different companies (expected —
  it's shared reference data, not tenant data, per CLAUDE.md §11).

One real finding surfaced by the existing cross-company isolation sweep
(`src/test/isolation.newCompany.test.ts`): the sweep replaces every path param on every `GET` route
with a real id belonging to another company and asserts the response never echoes that id back. My
first draft of the `:code` routes' 404 messages did (`"${code}" is not a known HSN code`), which
tripped the sweep even though nothing was actually leaked (HSN codes are global; a random id
substituted for `:code` simply isn't a code that exists). Fixed by not echoing the param in the
message (§5's table, and the router's own comment) — kept as a durable lesson: **no response body on
an id-taking route should ever contain the raw requested id, even in a "not found" message**, since
a generic leak-detector (correctly) can't tell that case apart from a real cross-tenant disclosure.

## 8. What this phase deliberately did NOT do

Per the phase's own scope boundary: no E-Invoice, E-Way Bill, GSTR-1/2B/3B change, no GST
reconciliation, no Sales Debit/Credit Note logic change, no accounting/GL change, no GST dashboard,
no full frontend. `Client`/`Supplier` records are never auto-populated or modified by a GSTIN
lookup result — that remains a future, explicit decision for whichever screen calls this service.
