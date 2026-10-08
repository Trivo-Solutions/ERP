# TRIVO Photography — Phase 0 Audit (Repository & Architecture)

Date: 2026-10-07 · Scope: read-only inspection, no production code changed · Spec: `TRIVO_PHOTOGRAPHY_SYSTEM.md`

> **Spec location note.** The instruction named `docs/TRIVO_PHOTOGRAPHY_SYSTEM.md`, but the spec is at the repo
> **root** (`P:\ERP\TRIVO_PHOTOGRAPHY_SYSTEM.md`, untracked). `docs/` did not exist; this audit created it.

**Evidence convention.** Every statement below was read from source in this session unless marked
**[UNVERIFIED]** (a belief about something outside the repo, or code I did not open). Nothing marked
[UNVERIFIED] should be built on without a check.

---

## 0. Executive summary

1. **There is no image infrastructure to reuse.** `JewelryTag` has no image/photo field. No image model, no upload
   endpoint, no image-processing library, no object-storage code exists. The only "photo" artefacts are a
   client-side placeholder (`NewTagPage.tsx` `TagImageUpload`, never sent to the server) and `DesignFile`
   (dormant manufacturing, design-bound). Photography will be the **first real consumer of object storage**.
2. **Object storage is scaffolding only.** `minio` + `multer` are in `server/package.json` but imported nowhere;
   `docker-compose.yml` (dev) has a MinIO service; **`docker-compose.prod.yml` has none**; `DEPLOY.md` does not
   cover object storage; CLAUDE.md §12 lists "no live MinIO verified" as open. Only the key-namespacing helper
   `shared/objectKey.ts` exists. This is the largest hidden piece of work.
3. **The printer agent is not a template for a secure, remotely-controllable bridge.** It is a loopback-only
   (`127.0.0.1:9101`), unauthenticated, Windows-only HTTP service called directly by the browser on the same PC.
   The ERP never knows it exists. There is no device registration, credential, heartbeat or server connection.
   The spec's requirements (station credentials, heartbeat, phone-as-controller) need a **new** mechanism.
4. **Mobile + external camera cannot work over the printer-agent model** (a phone cannot reach a PC's loopback).
   That combination forces a server-relayed design (bridge connects *outbound* to ERP). This is the key
   architectural decision for the user.
5. **Tenancy/RLS/audit/RBAC conventions are strong and well-documented**; Photography can follow them directly.
   Two friction points: device (non-user) authentication has no precedent, and `audit_logs.userId` is NOT NULL.
6. **Upload size limits (10 MB at nginx and Express) are almost certainly below a Sony A7R V file.** [size UNVERIFIED]

Recommendation: proceed to Phase 1 (data model) only after the decisions in §15 are answered — several change the schema.

---

## 1. Current architecture relevant to Photography

| Layer | Fact | Source |
|---|---|---|
| Monorepo | `client/` (React 18 + MUI 5 + Vite), `server/` (Express + Prisma 5 + Postgres), `printer-agent/` (Node/TS), npm workspaces | root `package.json`, `server/package.json`, `client/package.json` |
| API | Single Express app, routers mounted at `/api/v1/<module>`; tagging at `/api/v1/tagging` | `server/src/app.ts:94-122` |
| Body parsing | `express.json({limit:'10mb'})` with a `verify` hook that retains `req.rawBody`; urlencoded 10 MB; global `inputGuard` | `app.ts:75-77` |
| Proxy | nginx `client_max_body_size 10m`; `/api/` and `/socket.io/` proxied to `server:3001`; listens on **port 80 only** (TLS presumably upstream, not in repo) | `client/nginx.conf` |
| Tenant model | Every request: `authenticate` → `resolveTenantContext` → services take `ctx: TenantContext`; DB access only via `tenantQuery / tenantBatch / tenantTransaction` (set `app.tenant_company_id` in-transaction); `runAsPlatform` is the only BYPASSRLS door | `middleware/auth.ts`, `middleware/tenant.ts`, `shared/tenantContext.ts` |
| Client-supplied tenant | `rejectClientTenantSelectors` returns 400 if `companyId/tenantId/organizationId` appears in body, query **or header** — on every route | `middleware/tenant.ts:27-41` |
| Tags | Router `/tagging/tags*`, service `tagging.service.ts` (`listTags`, `searchTags`, `getTag`, `createTag`, …), permissions `tag:view` / `tag:create` | `tagging.router.ts:88-146`, `tagging.service.ts` |
| Frontend | React Router v7 in `pageRoutes.tsx`; `RequirePermission` route guard; sidebar `navItems.tsx`; **custom tab system** (`tabs.store`, `tabPaths.ts` titles/owner by nav path); global `KeyboardShortcuts.tsx` | `client/src/pageRoutes.tsx`, `components/Layout/*` |
| Realtime | socket.io, JWT handshake, company-prefixed rooms | `shared/websocket.ts`, `client/src/api/socketRegistry.ts` |
| Hardware | Two unrelated mechanisms: (a) server-side serial scales (`shared/hardware.ts`, `HardwareDevice`); (b) browser→loopback print agent | see §5 |

## 2. Existing models that can be reused (and those that cannot)

| Model | Verdict | Reason |
|---|---|---|
| `JewelryTag` | **Reuse as the anchor — do not add columns to it.** | Has `companyId`, composite FK target `@@unique([id, companyId])`, `branchId` composite FK, `tagNumber` unique per company. Adding image columns would fire the `tag_history_capture` trigger (see §4) and is unnecessary. |
| `Branch` | Reuse (composite FK `(branchId, companyId)`) | Standard pattern. |
| `CompanyUser` / `UserBranchAccess` | Reuse for photographer identity and branch grants | Branch scoping is enforced in service code via `ctx.branchAccess` / `canAccessBranch`. |
| `AuditLog` | Reuse (with caveat §7) | Append-only for the runtime role. |
| `HardwareDevice` | **Do not overload for stations/cameras (recommendation).** | It is a serial-port/scale registry: `deviceId`, `port`, `baudRate`, `ipAddress`, `lastPing`. It has **no credential, no revocation, no station/controller concept**, and `@@unique([companyId, deviceId])` is keyed for serial devices. Server code (`hardware.initialize`) auto-connects active `SCALE` rows. A `deviceType='CAMERA'` row would be inert but semantically muddy. Decide in Phase 1 (§9). |
| `DesignFile` | **Not reusable.** | Bound to `Design` via plain FK with `onDelete: Cascade` (conflicts with CLAUDE.md §6.5), dormant manufacturing module (CLAUDE.md §2 forbids wiring new sell-side code into it), no tag link. |
| `SystemConfig` | Reuse for per-company photography settings (image sizes, retention) | Company-scoped key/value. Note starter-package validator forbids config keys matching `DEVICE\|PORT\|KEY\|TOKEN\|SECRET\|URL…`. |
| `CompanyInvitation` token scheme | **Reuse the pattern** for device pairing/credential tokens | `<companyId>.<secret>`, only SHA-256 stored, shown once (CLAUDE.md §11.2). Solves the "which tenant is this token for?" problem under RLS (§6). |

## 3. Existing image / storage infrastructure

**Found:**
- `server/package.json`: `minio ^8.0.4`, `multer ^1.4.5-lts.1` (+ `@types/multer`) — **no `import` of either anywhere in `server/src`** (grep).
- `server/src/config/env.ts`: `MINIO_ENDPOINT/PORT/ACCESS_KEY/SECRET_KEY/BUCKET_NAME/USE_SSL` with dev defaults (`minioadmin`, bucket `sea-erp-files`).
- `docker-compose.yml`: `minio/minio:latest`, default creds, health check. **`docker-compose.prod.yml`: no MinIO.**
- `server/src/shared/objectKey.ts`: `companyObjectKey(companyId, ...segments)` and `assertObjectKeyBelongsToCompany(...)`. Header states: *"Object storage is not wired up yet — nothing uploads or downloads a file today."* 404-not-403 for foreign keys.
- `server/src/test/namespaces.test.ts:96-102`: a **guard test that fails if any application file imports `minio`/`@aws-sdk/client-s3` or contains an `uploads/` path** outside the helper. A storage service will trip this test unless the test's allowance is deliberately extended (a change to an existing test → needs your approval in the phase report).
- `design_files.filePath` has a DB CHECK that the path starts with the company prefix (tested).
- CLAUDE.md §12 "Still open": *no live Redis/MinIO in verification; nothing stores files in object storage*.

**Not found (grep across server/client src + all `package.json`):** `sharp`, `jimp`, EXIF library, any thumbnail code, `getUserMedia`, `BarcodeDetector`, any QR/barcode *scanning* library, any file-serving route, any signed-URL code.

**Client-side image touchpoints (all unrelated to server storage):**
- `NewTagPage.tsx:75-176, 1513` — `TagImageUpload` keeps a `File` in React state; comment: *"no upload endpoint exists yet … so the real upload wiring can drop in later"*. This is the natural integration point for showing a tag's photo.
- Template designers embed logos as data URLs inside the template JSON (`Estimate/TaxInvoice/TagTemplateDesigner`); `tsplGenerator` supports an `image` element for labels. Unrelated.
- Client deps present: `jsbarcode`, `qrcode` (generation only).

**Implications**
- Everything needed is net-new: storage service, multipart upload route, image pipeline lib, authenticated/signed image delivery, bucket provisioning, prod compose service, backup story.
- `<img src>` cannot send the `Authorization: Bearer` header, so image delivery needs either short-lived signed URLs or a fetch→blob pattern. Security review item (spec §16 "image download URLs").
- `tenantTransaction` rule (tenantContext.ts:37-47): **no object-storage write inside a DB transaction.** Upload first, commit DB row after, reconcile orphans.
- Backup: `scripts/backup.sh`/`restore.sh` are `pg_dump` based (CLAUDE.md §12). Images in MinIO would be **outside** that backup. **[UNVERIFIED: I did not open backup.sh]** — confirm before go-live; otherwise photos have no backup.
- Capacity: staging data set is ~20,000 tags/company (CLAUDE.md §12). With several images per tag the original-retention policy is a real cost decision (see §15 Q6).
- `server/Dockerfile` runtime is `node:20-bookworm-slim` (glibc) — a prebuilt-binary library such as `sharp` is expected to install cleanly. **[UNVERIFIED — not attempted; Phase 1/2 should confirm]**

## 4. Existing Tag relationships

`JewelryTag` (`schema.prisma:2964`): `companyId`, `tagNumber` (`@@unique([companyId, tagNumber])`), `branchId` (composite FK), `status` string (`IN_STOCK`/`ON_APPROVAL`/`TRANSFERRED`/`SOLD`/`RETIRED`), category/subCategory/collection/stockType/size/manufacturer (composite FKs), `grnItemId`, `purchaseLotId`, `createdById`, many back-relations (memo, transfer, invoice, return, audit, repair, hallmark, estimate…). **No images, no photo status.**

Facts that constrain the design:
1. **Tag number format** is built by `nextTagNumber`: `<stockTypeCode><categoryCode><5-digit sequence>` (`numberSequence.ts:120-130`). The spec's `VG000123` is illustrative; real prefixes depend on masters. **[Real prefix format in production not verified.]**
2. **Tag history trigger** `tag_history_capture` fires `AFTER INSERT OR UPDATE OR DELETE ON jewelry_tags` and writes a row for *any* changed column (excluding `updatedAt`). Adding e.g. `primaryImageId`/`photoStatus` to `JewelryTag` would pollute tag history on every photo and risks touching tags in non-editable states. → **Keep photography state in its own table(s).**
3. `updateTag` calls `assertTagEditable(status)`; a SOLD tag cannot be edited. Photography on a SOLD/RETIRED tag (e.g. re-shoot for catalogue) must not route through `updateTag`.
4. Barcode on labels is a Code128/QR whose *content* comes from the tag template element (`tsplGenerator.ts:201-208`); I did not trace which field the default template encodes. **[UNVERIFIED: assumed to be tagNumber — confirm against a real template.]**
5. Existing scan UX = a text input that searches (`searchTags`, 20 results, matches `tagNumber`/`name`/`huid`) and auto-acts on a single match (`StockAudit.tsx:95-98`). A USB/Bluetooth keyboard-wedge scanner therefore already works with the same pattern; no scanner library exists.
6. **Cost data**: the Stock Lookup screen deliberately omits `costPrice` (CLAUDE.md B4). The Photography queue/tag payload must also omit `costPrice` (and ideally prices) — photographers should not receive them.

## 5. Existing local-agent (printer-agent) architecture

Studied: `printer-agent/src/index.ts`, `config.ts`, `README.md`, `client/src/utils/printAgent.ts`, installer/script listing.

| Question from spec §4 | Finding |
|---|---|
| How does it authenticate? | **It does not.** Binds `127.0.0.1:9101` (loopback = the only boundary); `cors({origin: ALLOWED_ORIGIN \|\| '*'})`. |
| How does it communicate with ERP? | **It doesn't.** The *browser* calls it (`fetch http://127.0.0.1:9101/print`, 3 s status timeout / 15 s print). ERP server has no knowledge of the agent. |
| Device registration? | None. Config is local only: `%LOCALAPPDATA%\SeaErpPrintAgent\config.json` (`printerName`, `port`), atomic write-then-rename. |
| WebSocket / local HTTP? | Local HTTP only: `GET /status`, `POST /print`, `/setup*` pages. No socket, no heartbeat, no push. |
| Updates / errors | No auto-update; user re-downloads. Errors returned as `{ok:false,error}` (502/409); client throws `PrintAgentNotRunningError` to offer a download link. |
| Packaging | Node/TS, bundled by `pkg` to `printer-agent.exe`; Inno Setup installer (Windows-only compiler, committed binary at `client/public/downloads/`); Startup-folder autostart. Printing via PowerShell/GDI (`scripts/print-gdi.ps1`) → **Windows-only**. |
| How does the frontend know it's online? | Browser polls `GET /status`; failure ⇒ "not running". Nothing server-side. |

**What transfers to a Camera Bridge:** the packaging/installer/download flow; the per-user config dir pattern; the "agent serves its own setup page"; the "browser shows download link when agent missing" UX; atomic config writes.

**What does *not* transfer (new work):** station registration, per-device revocable credential, server-visible online state/heartbeat, remote command channel, upload retry queue, macOS support, mobile reachability.

**Browser→loopback caveats [UNVERIFIED — platform behaviour, verify in Phase 4/5]:** HTTPS page → `http://127.0.0.1` is generally treated as potentially trustworthy by Chromium, but Safari/iOS behaviour differs and Chromium's private-network/local-network-access prompts are evolving. A loopback-only design is inherently a **same-machine, desktop-Chromium** design.

## 6. Existing authentication / RBAC

**Auth (users):** JWT access (8h default) + refresh (30d). `authenticate` re-validates the `CompanyUser` membership, user and company active flags on **every** request via a tenant-scoped query (`auth.ts:54-63`). `req.user` carries `companyId, companyUserId, roleId, roleName, permissions[], branchAccess`. Permissions are baked into the JWT (CLAUDE.md: changed permissions need re-login to reach a cached token — although `authenticate` rebuilds `permissions` from the live role each request, `branchAccess` is read from the token).

**RBAC:** `requirePermission('res:action')`; wildcard exact / `res:*` / `*` (`rbac.ts:37-40`). Catalog for the Role Editor in `shared/permissionCatalog.ts` ("keep in sync … no automated check"). Underscore actions (e.g. `report:financial_view`) are allowed (J4 widened the validator regex). Starter Package v1 is **immutable** and only seeds *new* companies; existing companies require a backfill script (`server/scripts/backfillJ4Permissions.ts` is the precedent: dry-run default, `--apply`).

**Spec §22 names (`Photography.View` …) do not match the convention.** Proposed (confirm in Phase 1): `photography:view`, `photography:capture`, `photography:review`, `photography:delete`, `photography:restore`, `photography:manage_stations`, `photography:manage_cameras` (underscore-action precedent exists). Add to `permissionCatalog.ts` (new "Photography" group), starter package (new companies), and a backfill script (existing companies).

**Gap — no machine/device authentication exists.** Only user JWTs, the operator `x-trivo-platform-key`, and one-time invitation tokens. Under FORCE RLS the runtime role sees *zero rows* without a tenant context, so a device cannot be looked up by a bare token hash. **Resolution with precedent:** issue device tokens as `<companyId>.<secret>` (same as invitation tokens and refresh tokens, CLAUDE.md §11.2/§11.4); the server extracts `companyId`, then does a `tenantQuery(companyId, …)` hash lookup. The extracted `companyId` is treated only as *where to look*, never as authority — identical to `authenticate`'s own approach (auth.ts:51-53). Device requests need their own middleware (`authenticateDevice` → `req.device`) and an explicit scope list; `requirePermission` is user-only.

**Branch access:** `ctx.branchAccess` (`allBranches` or `branchIds[]`); helpers `canAccessBranch`, `assertBranchAccessible`; list endpoints cap results to the allowed set (`listTags`, `searchTags`). Photography queue must copy `listTags`'s `allowedBranchIds` logic. Branch grants are read from the JWT, so a revoked grant lingers until refresh (accepted in CLAUDE.md §11.2).

**Ownership check helper:** `assertOwnedByCompany(model, id, companyId, label)` — `ScopedModel` is a closed string union; new models (`photographyStation`, `tagImage`, …) must be added. Wrong-company ⇒ 404.

## 7. Existing audit system

- `createAuditEntry(tableName, recordId, userId, action, old, new, companyId)` — `companyId` mandatory; **refuses (throws) if `userId` is not a member of that company**; write failures are logged and swallowed (never fail the business op).
- `audit_logs`: `userId String` **NOT NULL FK → users**, `companyId` NOT NULL, `oldValues/newValues Json`, ip/userAgent columns exist but `createAuditEntry` does not populate them. Runtime role: `REVOKE UPDATE, DELETE` (db-secure.sql) ⇒ append-only.
- `PlatformAuditLog` is operator-only; not for Photography.
- **Conflict:** spec §23 lists device-originated events ("Camera connected/disconnected", "Station registered", automated upload). A bridge has no `userId`. Options (decision needed, §15 Q9): (a) attribute every auditable action to a real human (the session's photographer / the admin who registered the station) and keep pure device telemetry (heartbeats, connect/disconnect) out of `audit_logs` in a dedicated, non-audit `station event` table or just live status; (b) extend `audit_logs` with a nullable `actorDeviceId` — touches a shared, security-critical table and its guard tests, so I recommend (a).
- Tag history trigger is separate (captures `jewelry_tags` row changes only). Image events will not appear there unless explicitly decided (§15 Q10).
- Existing action vocabulary (CLAUDE.md §6.6): CREATE/EDIT/DELETE/RESTORE/AMEND/FORCE_DELETE/DEACTIVATE/REACTIVATE. Photography should add e.g. `CAPTURE`, `UPLOAD`, `SET_PRIMARY`, `REPLACE`, `PAIR`, `REVOKE` as strings (column is free text).

## 8. Existing real-time communication

`shared/websocket.ts` (socket.io 4):
- Handshake accepts **only a user JWT** (`auth.token`); verifies membership live; joins `company:<cid>`, `…:user:<uid>`, `…:role:<role>`, `…:branch:<bid>` for granted branches.
- Rules in the file header: every room company-prefixed; client events cannot name a company; `emit.*` requires `companyId` (no global broadcast).
- Client: one socket per signed-in identity, closed on logout/company switch (`socketRegistry.ts`) — a hard-won fix (CLAUDE.md §12 defect 5).
- Existing emitters: job cards, scale readings (branch room), RFID, stock/memo alerts, notifications.
- **No delivery guarantees/acks/replay** — a command emitted while the target is offline is lost.
- nginx already proxies `/socket.io/` with upgrade headers.

**For Photography:** add `room.station(cid, stationId)` and a **device handshake branch** (`auth.deviceToken`) that joins *only* the station room — never `company:<cid>` (that room carries unrelated company events). Add emitters (`photography:queue`, `capture:result`, `station:status`). Capture-command reliability must not depend on the socket alone (persist command/session state in DB; see §10).

## 9. Recommended Photography domain model (for Phase 1 validation, not final)

Guiding rules: new tables only; no change to `jewelry_tags`; all composite-FK'd to company; queue status **derived**, not stored on the tag.

**9.1 `TagImage`** (the "Photo"; spec's `Photo` + most of `Capture` + `UploadJob`)
`id, companyId, tagId, branchId` (branch copied from the tag **at capture time**; composite FKs `(tagId, companyId)`, `(branchId, companyId)`), `imageType` (`PRIMARY|SIDE|BACK|DETAIL|OTHER`), `isPrimary` (partial unique index: ≤1 live primary per tag), `reviewStatus` (`CAPTURED|REVIEW_REQUIRED|APPROVED|REJECTED`), `uploadStatus` (`PENDING|CONFIRMED|FAILED`), `processingStatus`, `storageKeyOriginal?/Optimized/Thumb` (built only via `companyObjectKey`), `originalFilename?`, `mimeType`, `width/height`, `sizeBytes`, `sha256`, `idempotencyKey` (**unique per company**, mirroring `CustomerAdvance`/`20261007120000_advance_application_idempotency`), `captureSource` (`DEVICE_CAMERA|BRIDGE`), `cameraLabel`, `stationId?`, `capturedById` (User), `capturedAt`, soft-delete (`deletedAt, deletedById, deleteReason` — mirrors `reversedAt/reversedById/reversalReason` convention), `createdAt/updatedAt`. Append-friendly; no `onDelete: Cascade`.

**9.2 `PhotographyStation`** — `id, companyId, branchId` (composite FK), `name` (`@@unique([companyId, name])`, so two companies may share a name), `isActive`, `lastSeenAt`, `registeredById`, `createdAt`. **Not tied to a user.**

**9.3 `StationCredential`** (bridge identity; could be columns on station if one credential per station is enough) — `id, companyId, stationId` (composite FK), `tokenHash` (SHA-256, unique), `scopes[]`, `createdById`, `createdAt`, `lastUsedAt`, `revokedAt/revokedById`, optional `expiresAt` (rotation). Raw token shown once.

**9.4 `PhotographySession`** (optional, Phase 5) — `id, companyId, stationId, userId, tagId?, state, startedAt/endedAt`; ties a human to a station window so bridge uploads can be attributed (resolves the audit `userId` problem) and carries pending capture commands. Do **not** build in Phase 1 unless Q9 requires it.

**Not recommended as separate tables now:** `CameraDevice`, `CameraConnection`, `Capture`, `UploadJob`. Camera inventory can be a JSON capability report on heartbeat (volatile, not business data); `Capture`/`UploadJob` collapse into `TagImage` status fields. Re-evaluate after Q-answers.

**Queue = query, not table.** A tag is *pending* if it has no live `PRIMARY` image; *completed* if it has an approved primary; *rejected/review* from `TagImage.reviewStatus`. This satisfies spec §9 ("do not create duplicate status systems"). Open question: which tag statuses are eligible (§15 Q5).

**RLS/guards per new table (mandatory, from CLAUDE.md §11):** `companyId` + index, `tenant_isolation` policy (`USING` and `WITH CHECK` on `current_setting('app.tenant_company_id', true)`), `ENABLE` in migration (FORCE applied by `db-secure.sql` automatically via the policy name), `@@unique([id, companyId])` where referenced, composite FKs for tag/branch/station, ownership assertions for every request-supplied id, cross-company regression tests, `audit:tenant` clean. If the audit/trail-like tables become append-only, add a `REVOKE UPDATE, DELETE` line to `db-secure.sql` (precedent: `tag_history`).

## 10. Recommended Camera Bridge architecture

**Capture paths (three, in priority order, matching spec phases):**

| Path | Controller | Camera | Upload by | Phase |
|---|---|---|---|---|
| A. Browser device camera | any browser | device camera via `getUserMedia`, or `<input type="file" accept="image/*" capture>` (native camera app, full-res, works on iOS Safari without secure-context issues) | the **user's JWT** (no device credential) | 3–4 |
| B. Same-PC bridge | desktop browser on bridge PC | external camera via bridge | bridge (station credential) or browser relay | 5, 9 |
| C. Remote controller | phone/tablet | external camera on a bridge PC | bridge (station credential) | 5, 8 |

**Core decision (needs the user — §15 Q1):** Path C requires the bridge to connect **outbound** to the ERP (socket.io client with a station credential) so the ERP can relay "capture" from any controller. A pure loopback model (printer-agent style) can only ever serve Path B. Recommended: **outbound-connection bridge**, with an *optional* loopback endpoint for same-PC low-latency/preview.

```
Controller (browser, user JWT) ──POST capture-request──► TRIVO API ──socket (station room)──► Camera Bridge ──► CameraProvider
                                                              ▲                                                   │ image bytes
                                       result event (user room) │◄── HTTPS multipart upload (station credential, idempotency key) ◄┘
```

- **Bridge authentication:** station credential `<companyId>.<secret>` (§6); scopes limited to `photography:bridge` operations (heartbeat, receive command, upload an image *for a capture session it was issued*, report camera list). It cannot read tags, users, or other stations.
- **Tag trust:** the bridge never names a tag authoritatively. The *controller's* authenticated request creates a short-lived capture ticket (user, tag, station, expiry, idempotency key) after the server validates tag ownership, branch grant and `photography:capture`. The bridge uploads against the ticket id; the server derives company/branch/tag/user from the ticket (spec §13). This also yields the human `userId` for audit.
- **Provider abstraction** (`CameraProvider` interface in the bridge): `discover, connect, disconnect, getStatus, capture, downloadCapture` required; `startPreview/stopPreview/switchCamera` optional with a **capabilities** object the UI reads (spec §15). First providers: `MockCameraProvider` (Phase 5, test), `DeviceCameraProvider` (browser-side, not in bridge), then `SonyProvider` (Phase 6).
- **Reliability:** bridge keeps a local on-disk pending-upload queue (atomic file writes, same pattern as printer-agent `config.ts`), retries with the same idempotency key; server confirms via `uploadStatus=CONFIRMED` only after bytes + checksum verified (spec §20–21). Capture state lives in DB so a browser refresh or bridge restart can resume.
- **Packaging:** reuse Node/TS + installer flow where possible, but Sony camera SDKs are native; the Sony adapter likely needs a native component. **[UNVERIFIED: which Sony SDK/protocol supports ILCE-7RM5 remote capture over USB, on which OS, with what licensing — spec Rule 7/Phase 6 mandate verifying before coding. I deliberately make no claim here.]** macOS requirement (spec §18) means the printer-agent's PowerShell/Windows specifics cannot be copied.
- **Mobile + Sony** (Phase 8): a phone cannot run the PC bridge. Feasible shapes are (i) phone as controller of a bridge PC (Path C — works with the design above), or (ii) a native mobile app talking to the camera directly (a different, much larger project). **[Feasibility of direct phone↔Sony not verified.]** The spec's "Android + Sony" should be clarified (§15 Q3).

## 11. Required migrations (indicative; exact set decided in Phase 1)

Existing discipline: timestamped folder `YYYYMMDDHHMMSS_name`, hand-written SQL including RLS, one logical change each, composite FKs, CHECK constraints, tenant-row data steps must lift FORCE RLS (none expected here since no backfill). Latest migration on disk: `20261009100000_advance_split_payments` (**uncommitted, belongs to another in-flight task**).

1. `…_photography_stations` — `photography_stations` (+ credential table), RLS policies, indexes.
2. `…_tag_images` — `tag_images`, partial unique index for single live primary, `(companyId, idempotencyKey)` unique, `(id, companyId)` unique, composite FKs to `jewelry_tags` / `branches` / `photography_stations`, CHECKs (non-negative size, valid enums), RLS.
3. (Phase 5) `…_photography_sessions` / capture tickets if adopted.
4. `db-secure.sql` — only if append-only/special grants are required (tables with a `tenant_isolation` policy are picked up automatically).
5. Non-schema: permission catalog + starter package v1 note + backfill script for existing companies (no migration, `Role.permissions` is a `String[]`).

No destructive change to any existing table is anticipated. Must verify migration/DB state at Phase 1 start (spec §26) — **not** done in Phase 0 (read-only, no DB connection made).

## 12. Required frontend areas

- New nav group "Photography" in `navItems.tsx` + routes in `pageRoutes.tsx` guarded by `RequirePermission`; add titles for non-sidebar pages to `EXTRA_TITLES` in `tabPaths.ts` (otherwise tab title falls back to "Page").
- Pages: Queue, Capture workspace, Review, Completed/Rejected, Stations/Camera status (admin).
- Capture workspace: tag scan/search (reuse the `StockAudit`-style scan input and `/tagging/tags/search` pattern), camera selector with capability messaging, review/retake/save-next, existing-images strip with image type + primary toggle.
- Device camera component (`getUserMedia` + `capture`-input fallback); permission-denied and no-camera states.
- Image display via signed URL/blob (never raw bucket URLs).
- Realtime: reuse `ensureSocketFor`/`getSocket`; subscribe to station/queue events; handle socket-closed-on-logout.
- Follow `UI_DESIGN_GUIDE.md` (keyboard-first fields, CLAUDE.md §10) — **not yet read in this phase; must be read before Phase 3**.
- Shortcut conflicts: spec's R/N/Space/Enter/Esc vs `KeyboardShortcuts.tsx`: existing bindings use Alt+*/Ctrl+* plus `/` (focus search) and `Esc` (close dialog); an `isTyping()` guard exists. Bare `R`/`N` are free outside inputs; `Esc` already closes dialogs; `Enter`/`Space` must be scoped to the capture view only. No blocking conflict found.
- NewTagPage: optionally replace the local-only `TagImageUpload` placeholder with a read-only preview of the tag's photos (decision, §15 Q11).
- Tag label/lookup/Stock Book: optional thumbnail column — out of scope unless requested.
- Client currently has no test of browser camera flows; spec §29 browser tests need a harness decision (Playwright is present under root `node_modules` as a transitive tool; `ops/staging/browser-acceptance.js` is the existing real-browser harness — **[UNVERIFIED how it is invoked/which dependency]**).

## 13. Required backend areas

- `modules/photography/` — router, service(s), station service, device-auth middleware, tests (follow `modules/tagging` layout).
- `shared/storage.ts` — the single MinIO/S3 wrapper (built on `objectKey.ts`), health check, put/get/stat/delete/presign; plus `namespaces.test.ts` guard update.
- `shared/imagePipeline.ts` — validation (magic bytes, max pixels/size), EXIF orientation, resize, thumbnail, strip GPS; add an image library dependency.
- Multipart route with a **dedicated size limit** (multer is installed), bypassing the 10 MB JSON parser; matching nginx `location` with larger `client_max_body_size` and timeouts; reverse-proxy buffering considerations.
- `middleware/deviceAuth.ts`; extend `websocket.ts` (device handshake, `room.station`, emitters).
- `permissionCatalog.ts`, `starterPackage/v1.ts` + `validate.ts` check, backfill script, `assertOwnedByCompany` union additions, `inputGuard` compatibility (id-named fields must be strings).
- Rate limiting: global `/api` limiter exists (shared bucket per IP; `TRUST_PROXY` configurable) — bridge heartbeat/upload traffic from one site shares an IP bucket with human users; per-route limiter needed.
- Orphan reconciliation job (object written but DB commit failed, or the reverse).
- Docs: `API.md` update; `docker-compose.prod.yml` + `DEPLOY.md` object-storage service and bucket policy; backup coverage for images.
- Tests: service tests, HTTP security tests (pattern `http.*Security.test.ts`), tenant-isolation + RLS tests (`rls.*`, `compositeFk.test.ts` patterns), schema-guard coverage automatic.

## 14. Risks / conflicts discovered

| # | Severity | Finding |
|---|---|---|
| R1 | **High** | Object storage entirely unproven: no MinIO in `docker-compose.prod.yml`, not in DEPLOY.md, never exercised (CLAUDE.md §12). Photography is blocked on it. |
| R2 | **High** | Upload limits (nginx 10 MB, Express 10 MB JSON) vs. full-resolution A7R V files [size UNVERIFIED — get a real sample]. RAW would be far larger. Needs multipart + new nginx location + timeouts. |
| R3 | **High** | No device-auth precedent; RLS blocks pre-tenant token lookup unless token embeds companyId (`<companyId>.<secret>` precedent exists). Must not give the bridge a user JWT/password (spec §14, RLS §6). |
| R4 | **High** | Printer-agent model (loopback, unauthenticated, Windows-only, browser-driven) cannot satisfy mobile-controller, macOS, credentialed-station requirements. Using it as a template would silently drop spec requirements. |
| R5 | Med | `audit_logs.userId` NOT NULL + membership check ⇒ device actors can't be audited directly (§7). |
| R6 | Med | `namespaces.test.ts` bans storage imports outside the helper ⇒ the first storage code intentionally trips an existing guard; needs an explicit, reviewed allowance. |
| R7 | Med | Images are outside the documented backup (`pg_dump`) [backup.sh not opened]. Silent data-loss risk. |
| R8 | Med | `getUserMedia` requires a secure context; nginx config listens on :80 only and the repo doesn't show TLS termination. Camera works on `localhost` but a LAN/IP HTTP deployment would fail on phones. Check actual deployment topology. |
| R9 | Med | Existing sockets have no acks/replay; commands to an offline bridge are lost ⇒ DB-backed capture tickets needed. |
| R10 | Med | Starter Package v1 immutable + JWT-cached permissions ⇒ existing companies need an explicit backfill and re-login (same caveat repeatedly documented). |
| R11 | Med | Photographer payloads must exclude `costPrice`/pricing; do not reuse `getTag` (returns materials, memo/transfer history). |
| R12 | Low | Tag trigger pollution if state is put on `jewelry_tags` (avoided by design). |
| R13 | Low | Sony specifics unknown/unverified; second "Sony 4K" model unknown (spec Phase 7). |
| R14 | Low | `tenantTransaction` forbids object-storage I/O inside the transaction ⇒ two-phase write + reconciliation. |
| R15 | Low | CLAUDE.md §11 notes `audit:tenant` misses tagged-template raw SQL and `platformPrisma`; any raw SQL in photography (e.g. the single-primary index logic) needs manual review. |
| R16 | Info | Working tree has **unrelated uncommitted work** (Customer Advances split-payments: 8 modified files + 1 untracked migration `20261009100000_advance_split_payments`) and the spec file untracked. Photography must not touch these; a new migration must sort after `20261009100000`. Per spec Rule 10 this is reported, not touched. |
| R17 | Info | Spec path mismatch (`docs/` vs root), noted above. |

## 15. Information still needed before implementation

1. **Bridge topology:** approve outbound-connection bridge (supports phone-as-controller) vs. loopback-only (same-PC only, simpler, mirrors printer agent)? This decides the Phase 5 scope.
2. **Deployment:** is the ERP served over HTTPS (needed for browser camera on phones)? Cloud-hosted or on-prem LAN? Where does TLS terminate?
3. **Mobile + Sony meaning:** is "phone controls a Sony" acceptable as *phone → ERP → PC bridge → Sony* (PC stays at the station), or must the phone talk to the camera directly (Wi‑Fi/USB‑OTG, likely a native app)?
4. **Real sample files:** one JPEG (and RAW if used) from the A7R V in the actual shooting settings — to size limits, storage and the pipeline.
5. **Queue eligibility:** which tag statuses need photos (only `IN_STOCK`? also `ON_APPROVAL`)? Are existing tags (tens of thousands) backfilled into the queue or only new ones from a cut-off date? Is photographing mandatory before a tag can be sold (no — assumed purely informational; confirm)?
6. **Retention & capacity:** keep originals? JPEG only or RAW too? Target optimized size/long edge; images per tag; expected tag volume per company; retention for rejected/deleted images.
7. **Image-type rules:** is `PRIMARY` required, one-per-type or many-per-type (e.g. several DETAIL)? Can a rejected image be restored?
8. **Roles:** who is a "photographer" (new role vs. permission added to existing roles)? Should photographers be branch-restricted? Who reviews/approves?
9. **Audit of device events:** accept option (a) (human-attributed audit; device telemetry kept out of `audit_logs`) over modifying `audit_logs`?
10. **Tag history:** should photographing show in the tag's history timeline (would need an explicit, separate mechanism — not via the `jewelry_tags` trigger)?
11. **Where photos appear:** Tag list/lookup/NewTag page/invoice print/catalogue? (affects image-size variants and delivery API.)
12. **Barcode content:** confirm what the printed labels encode (tagNumber vs. other) and which scanner hardware is used (keyboard-wedge scanner vs. camera scanning). Camera-based scanning needs a library and has iOS limits.
13. **Sony details:** exact "Sony 4K" model (Phase 7); OS of station PCs (Windows only vs. macOS too); whether Sony Imaging Edge / SDK licensing is acceptable.
14. **Packaging/installer:** one bridge for Windows first? Who installs and registers stations (company Super Admin via pairing code)?
15. **Browser tests:** acceptable to use the existing staging harness / add a browser-test dependency for spec §29?
16. **Uncommitted work:** is the Customer Advances change to be committed/landed first so Photography migrations sit cleanly after it?

## 16. Recommended Phase 1 plan (Data Model & Domain Design — after your approval)

0. **Pre-flight:** `git status`/`git diff`; confirm DB/migration state against a **scratch** DB (never reset real data); decide how to treat the uncommitted Advances work (Q16).
1. Close the decisions in §15 that affect schema: Q1, Q5, Q6, Q7, Q9 (minimum).
2. Finalize the model: `TagImage`, `PhotographyStation`, `StationCredential` (+ optionally `PhotographySession`) with exact columns, enums-as-CHECKs, indexes, composite FKs, single-live-primary partial unique index, idempotency uniqueness.
3. Write migration(s) with RLS; add to schema; `prisma validate`; apply to scratch DB; `prisma migrate diff` shows no drift.
4. Permissions: add `photography:*` to the catalog; starter-package note; backfill script (dry-run only, not executed).
5. `ScopedModel` additions; no services/routes/UI yet.
6. Tests: schema guard (automatic), RLS (A cannot see/insert/update/delete B's rows), composite-FK (image→other company's tag/branch/station refused at DB level), single-primary and idempotency constraints, CHECKs. Run full suite, `npm run test:rls`, `npm run audit:tenant`.
7. Deliver the phase report in the spec §32 format, then **STOP**.
Explicitly out of Phase 1: storage service, upload route, image pipeline, bridge, UI.

Suggested sequencing note for later phases: because storage (R1/R2) gates everything, consider a small **"Phase 1.5 — storage & upload foundation"** (prod MinIO, `shared/storage.ts`, multipart route, nginx limits, guard-test update, backup coverage) before Phase 2 APIs. This is an addition to the spec's phase list and is your call.

---

## Appendix A — Files inspected

Spec/docs: `TRIVO_PHOTOGRAPHY_SYSTEM.md`, `CLAUDE.md` (provided context).
Server: `prisma/schema.prisma` (models: `JewelryTag`, `BranchTransfer`/`Item` head, `AuditLog`, `PlatformAuditLog`, `CompanyInvitation`, `HardwareDevice`, `SystemConfig`, `Design`, `DesignFile`, `CompanyUser`, `UserBranchAccess`; grep for image/photo), `prisma/db-secure.sql`, migrations `20261007100000_customer_advances`, `20261004120000_tag_history`, migration directory listing, `src/app.ts`, `src/config/env.ts`, `src/middleware/{auth,rbac,tenant,audit}.ts`, `src/shared/{tenantContext,websocket,hardware,objectKey,permissionCatalog,numberSequence}.ts`, `src/shared/tsplGenerator.ts` (grep), `src/modules/hardware/hardware.router.ts`, `src/modules/tagging/tagging.router.ts` (route list), `tagging.service.ts` (`listTags`, `getTag`, `createTag`/`updateTag` signatures, `searchTags`), `src/test/` directory listing, `src/test/namespaces.test.ts` and `tenantIsolation.masters.test.ts` (grep), `server/Dockerfile` (head), `server/package.json`, `scripts/` listing.
Client: `package.json`, `nginx.conf`, `src/pageRoutes.tsx` (grep), `src/api/socketRegistry.ts`, `src/utils/printAgent.ts`, `components/Layout/{KeyboardShortcuts,tabPaths}.tsx`, `pages/Tagging/{NewTagPage (grep), StockAudit (grep)}`, directory listings of `pages/`, `components/`, `pages/Tagging`, `pages/Hardware`.
Agent: `printer-agent/{README.md,src/index.ts,src/config.ts}` + file listing.
Ops/deploy: `docker-compose.yml` (grep), `docker-compose.prod.yml` (grep minio → none), `DEPLOY.md` (grep), `ops/` listing.

**Not opened (so claims about them are limited):** `UI_DESIGN_GUIDE.md`, `API.md`, `DEPLOY.md` body, `backup.sh`, `navItems.tsx` body, `auth.store.ts`, `starterPackage/*`, `Branch` model body, `client/src/api/client.ts`, the e2e/browser harness, `hardware.ts` beyond line 60, `printer-agent` scripts/installer.

## Appendix B — Verification not performed (by design)
No database connection, no `prisma validate`/`migrate`, no test run, no package install, no network, no file edits other than creating this document.
