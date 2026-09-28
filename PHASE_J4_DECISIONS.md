# PHASE J4 — HUMAN DECISION SHEET

Source of truth for this checkpoint: `PHASE_J4_RBAC_AUTHORIZATION_AUDIT.md` (complete). J1–J3.5 are treated
as frozen throughout — nothing below reopens them.

**Status: DECIDED by the business/system owner. Implementation has not yet started — see "Next steps" at
the end of this document.**

---

## Decision 1 — Reporting Permission Granularity — DECIDED: **B**

**Current state:** `report:view` gates the entire reporting surface as one permission — both operational
reports (stock-on-hand, dead stock, WIP summary, karigar balances, sales register) and sensitive
financial-detail reports (per-client ledger with named customer balances, dealer aging, day book, GST
summary, supplier ledger, trial balance, P&L, balance sheet). Every starter role except `FLOOR_WORKER`
(`PRODUCTION_MANAGER`, `ACCOUNTANT`, `SALES_MANAGER`, `STORE_MANAGER`) holds `report:view` today.

**Decision: Split sensitive financial-detail reporting into a separate permission.** `report:view` narrows
to operational/general reports; a new, separate permission (exact name left to engineering) will gate client
ledger, dealer aging, day book, and GST/financial detail reports.

**Implementation requires:** (1) a new catalog permission, (2) re-gating the specific financial-detail
report routes from `report:view` to the new string, (3) a starter-role decision — every starter role that
should keep today's level of financial-report access must be explicitly re-granted the new permission in
`v1.ts`, and (4) an existing-company backfill decision, following the precedent already used for
`masters:view` and J2's `client:*` additions — without a backfill, every already-provisioned company's roles
lose financial-report access the moment the route re-gating ships.

---

## Decision 2 — High-Value PO Approval — DECIDED: **A**

**Current state:** `approvePO` enforces a ₹5,00,000 threshold with a hardcoded role-name check
(`SUPER_ADMIN`, `PRODUCTION_MANAGER`), layered on top of the ordinary `po:approve` permission check —
mirrored client-side in `PurchaseOrders.tsx`.

**Decision: Move the ₹5,00,000+ approval authority into the permission system.** A new, specific permission
will gate high-value approval; any role — including a custom delegated one — can then be granted it through
the Role Editor, consistent with how every other capability in this app is delegated (CLAUDE.md §6.2).

**Implementation requires:** a new catalog permission; a starter-role decision (which starter roles receive
it by default — likely `PRODUCTION_MANAGER` at minimum, to preserve today's behavior); an existing-company
backfill decision; and a frontend change to `PurchaseOrders.tsx` to check the new permission instead of
`user?.role`.

---

## Decision 3 — J3 Administrative Permissions (Delegation Readiness) — DECIDED: **B**

**Current state:** `client:deactivate`, `client:delete`, `invoice:void`, `payment:reverse`, `invoice:edit`
are SUPER_ADMIN-only by omission (J3 Decision 6 — remains frozen and is not reopened by this decision).

**Decision: Prepare for delegation to selected roles.** A later, separate, controlled step will determine
which specific roles receive which of the five permissions by default in a future starter-package version,
and whether existing companies should be offered a backfill. **Target roles are not decided here** — this
decision only authorizes that follow-up planning step to happen next.

---

## Decision 4 — Frontend Authorization Rollout — DECIDED: **A**

**Current state:** only 6 of dozens of frontend page files do any permission-based button gating at all;
there is also no frontend route guard beyond "is anyone logged in."

**Decision: Build a reusable frontend authorization foundation first, then roll out module-by-module.** A
shared gating pattern (e.g. a `PermissionGate`-equivalent component) and a shared route-level permission
guard will be built and verified once, then applied module by module in the suggested order (Masters →
Clients → Sales → Procurement → Quality/Repairs → Settings), stopping for review after each module — the
same incremental-slice approach already used for J2 and J3.

---

## Decision 5 — GRN View Permission — DECIDED: **A**

**Current state:** `GET /procurement/grn` is gated by `grn:create`; there is no `grn:view`.

**Decision: Introduce a separate `grn:view` permission.** `GET /procurement/grn` will re-gate to the new
permission; `grn:create` will then gate only the actual creation action. **Which existing roles receive
`grn:view` is a separate follow-up step, not decided here** — `PRODUCTION_MANAGER` and `STORE_MANAGER` both
hold `grn:create` today and need an explicit decision on whether they also get the new `grn:view`.
Requires a starter-package change and an existing-company backfill decision so no currently-working
GRN-viewing role loses access the moment the route re-gates.

---

## Decision 6 — Payment History Permission — DECIDED: **A**

**Current state:** `GET /sales/clients/:clientId/payments` is gated by `sales:view`; there is no dedicated
`payment:view`. (No concrete abuse case was found for the prior state — this decision is a granularity
preference, not a security fix.)

**Decision: Introduce a dedicated `payment:view` permission.** Payment history becomes independently
delegable from general sales visibility. Requires a starter-role decision (whether `SALES_MANAGER`/
`ACCOUNTANT` need the new permission explicitly re-granted to preserve their current access) and, if any
role's effective access would narrow, an existing-company backfill decision.

---

## Findings That Do NOT Need Human Decision

| Finding | Classification |
|---|---|
| `GET /settings/design-categories` has no permission gate at all — any authenticated company member of any role can read it | J4 implementation |
| `navItems.tsx:141` gates "Roles & Permissions" on the retired `role:manage` string; should use the current granular `role:view`/etc. | J4 implementation |
| `API.md` contains the same stale `role:manage` documentation for `/roles` | Documentation only |
| `rbac.ts`'s legacy `PERMISSIONS` const object has zero usages anywhere and is stale relative to the live catalog | J4 cleanup |
| `PHASE_J1_AUDIT.md` §1.1 claims "zero DELETE routes exist," contradicted by its own classification matrix | Documentation only |
| `journal:post` has no frontend gate on `JournalEntries.tsx`'s Post action, even though the page itself is nav-gated on the separate `journal:create` | J4 implementation |
| The frontend's cached permission snapshot (set at login) can diverge from the backend's live per-request permission check during a session | Future phase |
| `branchAccess` is only re-derived at login/token-refresh, not per request, unlike `Role.permissions` (which the backend re-reads fresh every request) | Future phase |
| Dead/inert catalog permissions `qc:approve`, `sales:create`, `tax:manage` — granted to production starter roles, enforced by zero routes | J4 cleanup |
| `POST /procurement/returns` is gated by `po:approve` rather than a create-shaped permission | Future phase (semantic review) |
| Frontend button/action gating is inconsistent/absent across most of the app (the specific module-by-module work itself, beyond the Decision 4 strategy) | Future phase |

---

## Frozen J1–J3.5 Decisions

The following remain unchanged unless explicitly reopened later — none are affected by any decision above:

| Area | Status |
|---|---|
| J3 Client lifecycle behavior (deactivate/reactivate, hard-delete zero-history rule) | Frozen |
| J3 SalesInvoice VOID behavior (whole-invoice reversal, strict eligibility, never a hard delete) | Frozen |
| J3 InvoicePayment reversal behavior | Frozen |
| OLD_GOLD reversal flow (atomic with payment reversal, MetalStock zeroing, refuses if metal already consumed) | Frozen |
| STORE_CREDIT reversal flow (reopen-only, no separate credit-source movement to undo) | Frozen |
| SalesReturn append-only decision (no "un-return" capability) | Frozen |
| J3 SUPER_ADMIN-only administrative permissions (`client:deactivate`, `client:delete`, `invoice:void`, `payment:reverse`) — Decision 6 | Frozen |
| J3 inactive-client enforcement (`assertClientActive` on create-fresh paths only) | Frozen |
| `GET /sales/clients/:clientId/credit` → `client:view` (J3 Decision 7) | Frozen |
| Company isolation / RLS architecture | Frozen |
| Dormant manufacturing module protection (no sell-side wiring, no deletion) | Frozen |

---

## Decision Summary

| Decision | Choice |
|---|---|
| J4-D1 Reporting | **B — split operational vs. sensitive financial reports** |
| J4-D2 High-value PO approval | **A — permission-based approval** |
| J4-D3 J3 administrative permissions | **B — prepare for future delegation** |
| J4-D4 Frontend authorization | **A — shared foundation + route guard** |
| J4-D5 GRN viewing | **A — introduce `grn:view`** |
| J4-D6 Payment history | **A — introduce `payment:view`** |

---

## Next steps

All six decisions introduce new catalog permissions and/or new frontend infrastructure and therefore fall
under CLAUDE.md §"Do not implement Phase J as one giant uncontrolled change" — each is implemented as its
own reviewed slice, not as one combined change. None of D1, D2, D5, D6 have their target starter-role
grants or existing-company backfill scope decided yet (deliberately left to a focused follow-up per each
decision's text above); D3 has no target roles decided; D4's shared component design has not started.

Implementation has not begun. This document records the decisions only.

---

J4 HUMAN DECISION SHEET: DECIDED — AWAITING IMPLEMENTATION GO-AHEAD
