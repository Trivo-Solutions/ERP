# Tag classification discrepancy — investigation, fix and correction plan

Scope: tag `SBWL00133` / `SBWL00134` and the ~87 tags named "MATTU BOWL" under BOWL → 3 LEG (3LE), whose physical
label is reported to read Category BOWL / Sub-category MATTU (MTU).
Written 2026-10-13. **Nothing in this document was run against production.** The only database reachable from the
work machine is the local dev DB (company SEA, 3 demo tags — no OSSP / SBWL rows), so every statement about OSSP's
data below is either proven from the code, or explicitly labelled as unverified.

## 1. Root cause — what is proven and what is not

### Confirmed (from code, reproducible by test)

1. **The tag name is a frozen text copy.** `NewTagPage.tsx` had no name field; it computed
   `derivedName = subCategory.name || category.name` in the browser and POSTed it, and `createTag` stored it verbatim
   in `JewelryTag.name`. The tag separately stores `categoryId` / `subCategoryId`.
2. **Nothing ever refreshed it.** `updateSubCategory()` (rename / re-code / deactivate a sub-category master) changed
   only `sub_categories`; it did not touch tags and wrote **no audit row** (`subCategory.service.ts` had zero
   `createAuditEntry` calls — also for create, link, unlink, delete). Renaming a master therefore silently changes
   what every list / label / report that resolves the master shows, while the tag's stored `name` keeps the old
   words. A tag can legitimately end up as name "MATTU BOWL" + sub-category "3 LEG".
3. **The current client cannot produce "MATTU BOWL" from a save.** It would store the sub-category name alone
   ("3 LEG" or "MATTU"), never `MATTU` + `BOWL` joined. So the stored text came from an earlier client build, or from
   a sub-category row whose own name was "MATTU BOWL" at the time (then renamed). Which one is **not provable here**.
4. **The print path resolves category / sub-category live from the tag's ids** (`getTagPrintTspl` →
   `subCategory: { name, code }` → `resolveBoundField`). It never prints the stored name in the
   `subCategoryName` / `subCategoryCode` fields. The only field that printed the stored text was the general
   `name` field (now fixed, §3).
5. **A static text element on a label template prints the same words on every tag.** A literal "Mattu"/"MTU" element
   would print MTU on a 3 LEG tag. Nothing warned about it (now flagged, §3).
6. **`20261003170000_shared_sub_categories` (applied from 3 Oct 2026 17:19 IST in git) merged duplicate
   sub-categories** by *same code, or same name ignoring case* and moved tags onto the oldest surviving row,
   keeping that row's name/code. That is a second legitimate way for a tag to end up on a sub-category that does not
   match its stored name. (Migration file time ≠ the time it ran on production — see "Not recoverable".)

### Strongly supported (consistent with 1–6, not proven)

* The label showing MATTU (MTU) was printed while the master row the tag points at *was* MATTU/MTU, and that row was
  later renamed to 3 LEG / 3LE (and a new MATTU row created afterwards). This fits every reported fact — label
  resolves live from ids, MATTU "created after" the tags, stored name still MATTU-ish, both tags now on one 3 LEG
  row — and it is the only single mechanism that explains the paper label **and** the database state without
  assuming a template error. It requires that the *oldest* row for those tags was renamed in place, which is exactly
  the un-audited operation.

### Possible but unverified

* The label template for OSSP has static "MATTU"/"MTU" text, or binds the code field to a literal. **Check:** run the
  read-only report (§6) — `6_template_bindings.csv` lists every element that prints a name/category/sub-category
  field and every static-text element, per template, with the template's `updatedAt`.
* The printed label was produced by an old print-agent request body / cached template (the print agent keeps no log
  the server can read).
* The merge migration folded two rows into one (point 6).

### Not recoverable from available evidence

* **Who renamed or re-coded which sub-category, and when.** `audit_logs` has no master-data rows for sub-categories
  before this change, and `tag_history` only records changes to the *tag row*. A rename changes no tag row, so it
  leaves no trace anywhere. Table statistics / xmin are clues, not an audit trail, and are not used.
* **What the physical label said at print time** other than the paper itself: first prints were not audited
  (`REPRINT` only was).
* **When migrations were applied on production.** `_prisma_migrations.finished_at` on the production DB would say; it
  was not queried.
* Which sub-category the user selected on screen at save time for the 87 tags.

No historical audit events have been invented. The timeline is therefore a **template for the owner's read-only run**,
not a reconstruction:

| IST | Source | Label |
|---|---|---|
| 03 Oct 2026 17:19 | git commit `15deea9` (shared sub-categories, merge migration) | Confirmed (code), application time on prod: unverified |
| 04 Oct 2026 | migration `20261004120000` creates `tag_history` + BASELINE row for every existing tag | Confirmed (code); BASELINE rows show each tag's sub-category *on that date* |
| tagged date of SBWL00133/134 | `jewelry_tags.createdAt` | from report `1_tags.csv` |
| MATTU master created | `sub_categories.createdAt` | from report `4_subcategory_masters.csv` |
| any change of the tags' sub-category after 4 Oct | `tag_history.changes.subCategoryId` | from report `2_tag_history.csv` |
| any rename | — | **Not recoverable** |

## 2. `tag.name` consumers (classification of every reader found)

| Consumer | Kind | Treatment |
|---|---|---|
| Print template field `name` (`tsplGenerator.ts`) | Printing | **Changed**: now the live sub-category (else category) name |
| Template fields `categoryName/Code`, `subCategoryName/Code` | Printing | Already live from ids; unchanged |
| `listTags`, `getTag`, `searchTags`, `getStockBook` rows | Display / search / stock reporting | **Changed**: `name` = live classification; stored text exposed as `storedName` |
| TagsPage, StockLookup, StockAudit, Branch transfer screens, JewelTransactionHistory (client) | Display | Unchanged code — they read `name` from the readers above (JewelTransactionHistory reads `getTagTransactions`, unchanged) |
| `searchTags` filter `name contains` | Search/filter | Unchanged (still matches stored text; tag number / HUID / name). Searching by sub-category name is a possible later addition |
| `sales.service.ts:2101, 2611` invoice-line description = `tag.name` | **Financial/transaction snapshot** | **Deliberately unchanged** — an invoice line describes what was sold on that day |
| `returnRepair.retagTag` copies/overrides `name` | Historical/lineage | Unchanged |
| `offerApproval`, `quality`, `estimation`, `photography`, `procurement` purchase-return selects | Display | Unchanged (read stored text; no classification decision depends on it) |
| `audit_logs`, `tag_history.snapshot` | Historical/audit | Untouched by design |
| `DB column jewelry_tags.name` | Storage | **Kept** (NOT NULL; migration plan in §7) |

## 3. What was changed (all local, not committed, not applied anywhere)

* **Server derives the name.** `createTag`, `createTagFromGrnItem`, `updateTag` ignore a client-supplied name when
  classification is involved and store `subCategory.name || category.name` from the *validated* masters.
  Validation (category exists, sub-category exists, belongs to the company, is linked to this category, is active)
  already existed and is unchanged; a rejected pair now writes a `CLASSIFICATION_REJECTED` audit row (it did
  not before). An edit that does not touch category/sub-category leaves the stored text alone.
* **Reads show the live classification.** See §2.
* **`getTag` now returns `category` / `subCategory`** (id, code, name, isActive). The edit form's "keep a
  since-deactivated sub-category in the list" fallback read `editTag.subCategory`, which `getTag` never returned.
* **Label printing**: the general `name` field resolves from the live masters; `GET /tagging/tags/:id/print`
  (also used by reprint) now returns `resolved` (exact category / sub-category name + code the label carries) and
  `warnings` (static text equal to a category/sub-category name or code, or to the tag's stored name; use of the legacy
  `name` field). The New Tag screen shows the resolved classification in the "sent to printer" notice and shows each
  warning. Both first print and reprint go through the same function.
* **New Tag preview card** shows `Category › Sub-category (code)` from the saved ids, not free text. The client no
  longer computes or sends `name`.
* **Audit** (existing `audit_logs`, append-only at the DB; no new table): tag `CREATE` (with classification),
  `UPDATE` + `CLASSIFICATION_CHANGE` (before/after), `CLASSIFICATION_REJECTED`, `PRINT_LABEL` / `REPRINT_LABEL`
  (template id/name/updatedAt, resolved values, template warning codes, correlation id = caller's `x-request-id` or
  a generated one), sub-category `CREATE` / `RENAME` / `DEACTIVATE` / `REACTIVATE` / `DELETE`
  (before/after, number of tags affected, optional reason) and `LINK` / `UNLINK`, and `CLASSIFICATION_CORRECTION`.
  `tag_history` (DB trigger) already records every change to a tag row with the acting user; it is unchanged.
* **Approved correction** (`tagReclassification.service.ts`, `POST /tagging/tags/reclassify/preview` and
  `/reclassify`, new permission `tag:reclassify`): dry run per tag, then one all-or-nothing transaction that changes
  only the listed tags' sub-category (+ stored name), count-checked, reason + reference + `confirm:true` required,
  audit row per tag with before/after + batch id. Never changes category, status, branch, weights or cost.
* **Read-only evidence report** `server/scripts/reportClassificationDiscrepancy.ts` (see §6).

### Documented effect of editing a sub-category master
Rename / re-code / deactivate applies to **every** tag carrying it, immediately, on labels and lists (they read the
master live). Tag rows are not rewritten, so a tag's stored legacy text is not updated and `tag_history` shows
nothing. That is why the rename is now audited with the number of tags it moves.

## 4. Schema / migration impact
**None.** No Prisma schema change, no migration, no data change. One new permission string (`tag:reclassify`) in
the code catalog — Postgres stores permissions as `Role.permissions String[]`, so it is SUPER_ADMIN-only (`*`) until a
company grants it in the Role Editor; no backfill was written or run (J4 precedent).

## 5. Tests
`server/src/test/tagClassification.test.ts` (25 tests): selected sub-category id saved and name server-derived;
mismatch / inactive / foreign / bogus sub-category rejected (+ rejection audit); BOWL→3 LEG prints 3 LEG / 3LE and
BOWL→MATTU prints MATTU / MTU; a legacy name "MATTU BOWL" cannot override any bound field; resolved values returned
before printing; static MTU text is flagged and is the only way MTU can appear on a 3 LEG label; a master rename is
followed by labels and audited while tag rows stay untouched; print / reprint audits; edit re-derives name and audits
before/after; invalid edit changes nothing; tag_history records the change; legacy tags readable in
list/search/get; master audit actor/company; dry run writes nothing, apply changes only the listed tags with
reason/reference/batch; all-or-nothing rollback; missing reason/reference/confirm rejected; cross-company tag 404;
403 over HTTP without `tag:reclassify`. See the final report for suite-wide results.

## 6. The 87-tag review (read-only) — how to produce it
The real data is in OSSP's production database, which was not touched. Run, with the owner's go-ahead, by someone who
has the production read credential:

```
cd server
npx ts-node scripts/reportClassificationDiscrepancy.ts --company <OSSP company code> \
    --stored-name "MATTU BOWL" --category BOWL --sub-code 3LE \
    --also SBWL00133,SBWL00134 --out ./classification-report
```
Every statement runs in a `SET TRANSACTION READ ONLY` transaction (Postgres enforces it). Output (CSV, IST):
`1_tags.csv` (tag id/number, stored name, category & sub-category ids/names/codes, tagged time, status, branch,
`nameMatchesCurrentSubCategory`, history/print counts), `2_tag_history.csv`, `3_tag_audit_rows.csv`,
`4_subcategory_masters.csv` (all masters with created time, linked categories, tags using each),
`5_master_audit_rows.csv`, `6_template_bindings.csv`, `summary.json`.
SBWL00133 / SBWL00134 are included via `--also` and appear in the same file (filter on tagNumber).
It was exercised against the local dev DB only (1 demo tag).

## 7. Proposed correction workflow (needs the business owner)
1. Owner/stock manager runs the report and, **per tag**, writes down the sub-category it really is (MATTU, 3 LEG, …).
   Names alone are not evidence: "MATTU BOWL" tags are not assumed to be MATTU.
2. Prepare `items = [{ tagId, subCategoryId }, …]` from the owner's sheet (≤200 per batch).
3. `POST /tagging/tags/reclassify/preview` — review before/after and refusals.
4. Super Admin (or a role granted `tag:reclassify`) `POST /tagging/tags/reclassify` with reason, approval reference
   and `confirm:true`. Nothing runs on production until the owner approves the exact tag ids.
5. Reprint labels for corrected tags that are still on stock; sold tags need nothing physical.

Decision needed from the owner before any production step: *which sub-category is each of the 87 tags*; whether
sold/memo'd tags are in scope; whether a physical relabel is wanted.

## 8. Remaining risks / rollout (nothing below has been done)
* Deploy is a normal code deploy — no migration, no `db:secure` change needed (run it anyway per the runbook).
* Existing companies need `tag:reclassify` granted in the Role Editor (SUPER_ADMIN has it via `*`); users re-login.
* Labels that used the `name` field now read the sub-category name instead of the stored text (usually identical;
  for stale tags it now matches the other fields on the label).
* Existing stored names are not rewritten; the 87 stay as-is until the owner-approved correction.
* `GET /print` now writes an audit row per print (one `audit_logs` insert per label).
* Template designer test prints are audited as `PRINT_LABEL` too.
* Full-text search by sub-category name is not added (search still matches the stored text).
