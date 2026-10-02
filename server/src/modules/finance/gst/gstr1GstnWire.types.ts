// G2g-4c-3 — GSTN wire types. The literal shape of the official GSTR-1 "Generate File" JSON a
// taxpayer uploads to the GST portal, as produced by the GSTN Offline Tool (local install, V3.2.4,
// verified against this phase's own copy at `C:\GST Offline Tool` — see gstr1GstnSerializer.ts's own
// header for exactly which source files were traced and what each finding was). These interfaces
// describe ONLY the wire contract itself — never TRIVO's internal ids, never the canonical
// `Gstr1GstnExportDto` (gstr1GstnExport.types.ts, frozen) shape repeated under new names.
//
// Scope: domestic outward supplies only, matching the canonical DTO's own supported capabilities —
// B2B (Table 4), B2CL (Table 5), B2CS (Table 7), CDNR/CDNUR (Table 9B, Credit Notes `ntty:'C'` and
// Sales Debit Notes `ntty:'D'`), HSN summary (Table 12, modern May-2025+ bifurcated hsn_b2b/hsn_b2c),
// and Documents Issued (Table 13). Every other top-level GSTR-1 section the official tool's own
// template can carry (b2ba, b2cla, cdnra, cdnura, nil, exp, expa, at, ata, atadj, atadja, supeco,
// supecoa, ecom, ecoma) has no corresponding field on the canonical DTO at all and is never emitted
// by this serializer — not merely left empty, structurally absent from these types.

// ─────────────────────────────────────────────────────────────────────────────
// Item-level rate group — Table 4 (B2B) / Table 5 (B2CL) / Table 9B (CDNR/CDNUR). GSTN's own
// `itm_det` shape genuinely OMITS the opposite tax-key set rather than zeroing it — confirmed by
// reading the actual GSTR1 item-construction code for both the intra-state and inter-state branches
// (`public/uiassets/js/returns/returns1.ctrl.js`'s `updateSavePayload`, the add-invoice-line flow):
// intra-state builds `itm_det` with ONLY txval/rt/camt/samt/csamt (no `iamt` key at all); inter-state
// builds it with ONLY txval/rt/iamt/csamt (no `camt`/`samt` keys at all). The identical pattern is
// independently confirmed for Table 7 (B2CS) at `utility/returnStructure.js`'s `case 'b2cs'`. Never a
// discriminated union with an explicit tag — GSTN's own wire shape carries no such tag on the item
// itself (intra/inter is implied by the invoice/note's own place-of-supply vs. the filing GSTIN's
// state), so this is a plain structural union; TypeScript's structural typing distinguishes the two
// shapes by key presence alone, exactly as the real payload does.
export interface Gstr1WireItemDetailIntraState {
  txval: number;
  rt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface Gstr1WireItemDetailInterState {
  txval: number;
  rt: number;
  iamt: number;
  csamt: number;
}

export type Gstr1WireItemDetail = Gstr1WireItemDetailIntraState | Gstr1WireItemDetailInterState;

/**
 * One rate-group entry inside a B2B/B2CL/CDNR/CDNUR `itms[]` array. `num` is GSTN's own item
 * identifier — confirmed from source (`utility/returnStructure.js` line 3516 and
 * `returns1.ctrl.js`'s `updateSavePayload`, both: `tempObj.num = (obj.rt) * 100 + 1`) to be the GST
 * rate itself, scaled by 100 and offset by 1 (e.g. a 3% rate item is `num: 301`). The official source
 * computes this with a raw `rate * 100 + 1` (no explicit rounding) — this serializer instead computes
 * it as `Math.round(rate * 100) + 1`: for every real GST rate (at most 2 decimal digits — 0.1, 0.25,
 * 1.5, 3, 5, 12, 18, 28, ...) the two formulas are numerically identical once IEEE-754 floating-point
 * noise is accounted for (e.g. `0.1 * 100` is `10.000000000000002` in JS, not `10`); `Math.round`
 * removes that noise without changing the result for any value this serializer will ever see. This is
 * a deliberate, documented hardening of the literal source formula, not a deviation from its meaning.
 */
export interface Gstr1WireItem {
  num: number;
  itm_det: Gstr1WireItemDetail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 — B2B
// ─────────────────────────────────────────────────────────────────────────────

/** GSTN's own B2B invoice-type enum, confirmed against `public/data/invtypesforb2b.json` /
 *  `invtypes.json` in the local Offline Tool install — exactly these five codes exist in the UI's
 *  own dropdown; no others are valid. */
export type Gstr1WireB2bInvoiceType = 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW';

export interface Gstr1WireB2bInvoice {
  inum: string;
  /** DD-MM-YYYY, IST calendar day. */
  idt: string;
  val: number;
  pos: string;
  /** 'Y' | 'N' — a GSTN wire string, never a JSON boolean (confirmed: `rowObj.rchrg = 'N'` is the
   *  literal default value used throughout the real controller source whenever a new row is created
   *  without an explicit reverse-charge indicator). */
  rchrg: 'Y' | 'N';
  inv_typ: Gstr1WireB2bInvoiceType;
  itms: Gstr1WireItem[];
}

/** One recipient group — GSTN's B2B table is grouped by recipient GSTIN (`ctin`), each carrying its
 *  own `inv[]` array of that recipient's invoices for the period. */
export interface Gstr1WireB2bRecipient {
  ctin: string;
  inv: Gstr1WireB2bInvoice[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 5 — B2CL. Always inter-state by classification (the frozen `gstr1Classification.ts` never
// places an intra-state invoice in this bucket) — `itm_det` therefore only ever uses the inter-state
// shape (iamt/csamt, never camt/samt). Confirmed from source (`utility/returnStructure.js`'s plain
// (non-amendment) `case 'b2cl'`) that the per-invoice object carries no `inv_typ` at all — the
// adapter's own `Gstr1GstnB2clInvoice` type likewise has no invoiceType field, so there is nothing to
// map here; `pos` is the GROUP key only, never duplicated inside each invoice (matching the
// documented, publicly-known GSTN B2CL wire contract — the source file's own per-row `pos` key on the
// pre-grouping intermediate object is an artifact of that file's single-Excel-row representation
// before the grouping-by-POS step, not evidence the final uploaded JSON repeats it).
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1WireB2clInvoice {
  inum: string;
  idt: string;
  val: number;
  itms: Gstr1WireItem[];
}

export interface Gstr1WireB2clPos {
  pos: string;
  inv: Gstr1WireB2clInvoice[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 7 — B2CS. A flat array of aggregation buckets — no recipient, no invoice. `sply_ty` values
// are 'INTRA'/'INTER' (confirmed: `utility/returnStructure.js`'s `fixPOS()` for type 'b2cs' explicitly
// normalizes `data[i].sply_ty` to these exact literals — NOT 'INTRA_STATE'/'INTER_STATE', which is
// the canonical DTO's own, differently-named, enum). `typ` ('OE'/'E') is confirmed from
// `scopelists.typeList` in `utility/returnStructure.js`. Tax-key omission mirrors Table 4/5 exactly —
// confirmed directly from `utility/returnStructure.js`'s own `case 'b2cs'`: the intra-state branch's
// object literal never contains an `iamt` key; the inter-state branch's never contains `camt`/`samt`.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr1WireB2csSupplyType = 'INTRA' | 'INTER';
export type Gstr1WireB2csEcommerceType = 'OE' | 'E';

export interface Gstr1WireB2csIntraState {
  sply_ty: 'INTRA';
  typ: Gstr1WireB2csEcommerceType;
  pos: string;
  rt: number;
  txval: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface Gstr1WireB2csInterState {
  sply_ty: 'INTER';
  typ: Gstr1WireB2csEcommerceType;
  pos: string;
  rt: number;
  txval: number;
  iamt: number;
  csamt: number;
}

export type Gstr1WireB2cs = Gstr1WireB2csIntraState | Gstr1WireB2csInterState;

// ─────────────────────────────────────────────────────────────────────────────
// Table 9B — CDNR (registered recipient). Carries BOTH Credit Notes (`ntty:'C'`) and Sales Debit
// Notes (`ntty:'D'`) in the SAME table, distinguished only by `ntty` — confirmed from source
// (`utility/returnStructure.js`'s GSTR1 `case 'cdnr'`: one shared object shape with `ntty:
// inv[trans.LBL_NOTE_TYP]`, no separate debit-note table). Also confirmed from that same object that
// CDNR genuinely carries both `rchrg` and `inv_typ` fields (unlike B2CL/CDNUR, which carry neither on
// a per-document basis the way CDNR does) — this phase's domestic scope fixes both to 'N'/'R'.
// ─────────────────────────────────────────────────────────────────────────────

/** 'C' = Credit Note, 'D' = Sales Debit Note — GSTN's own `ntty` values for this table (never to be
 *  confused with TRIVO's separate, purchase-side `DebitNote` model, which this pipeline never reads —
 *  see gstr1GstnAdapter.ts's own header). */
export type Gstr1WireNoteType = 'C' | 'D';

export interface Gstr1WireCdnrNote {
  nt_num: string;
  nt_dt: string;
  ntty: Gstr1WireNoteType;
  val: number;
  pos: string;
  rchrg: 'N';
  inv_typ: 'R';
  itms: Gstr1WireItem[];
}

export interface Gstr1WireCdnrRecipient {
  ctin: string;
  nt: Gstr1WireCdnrNote[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 9B — CDNUR (unregistered recipient). Flat array, no `ctin`/`rchrg`/`inv_typ` — confirmed
// absent from the real per-document object (`utility/returnStructure.js`'s GSTR1 `case 'cdnur'`).
// `typ` is confirmed, from `scopelists.URList` in the same file, to have EXACTLY two valid values in
// the entire official UI: "B2CL" and "EXP" — this phase supports only the former (domestic
// unregistered large-invoice origin); an export-origin (EXP) note is out of scope (CLAUDE.md's
// documented "exports" capability gap) and is never produced by the frozen adapter this serializer
// consumes.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1WireCdnur {
  ntty: Gstr1WireNoteType;
  nt_num: string;
  nt_dt: string;
  val: number;
  typ: 'B2CL';
  pos: string;
  itms: Gstr1WireItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 12 — HSN summary (modern, May-2025+ bifurcated hsn_b2b/hsn_b2c). Confirmed directly from the
// REAL GSTR1 row-construction source for this modern shape (`utility/returnStructure.js`'s
// `case 'hsn(b2b)': case 'hsn(b2c)':`, inside the `showHSNTabs` branch gated on the same
// HSN_BIFURCATION_START_DATE="052025" this codebase's own gstr1Table12Aggregation.ts uses): the row
// object is exactly `{ num, hsn_sc, user_desc, desc, uqc, qty, rt, txval, iamt, samt, camt, csamt }`
// — NO `val` key anywhere in that literal. This independently confirms the human decision to omit
// `val` for the modern bifurcated shape; it is not merely "the old `val` property kept for legacy
// compatibility" (the section 16-style field this phase's types file could have carried) — the
// official generator genuinely never writes it for hsn_b2b/hsn_b2c. `user_desc` (the filer's OWN
// typed description, distinct from `desc`, the HSN master's description) has no counterpart on the
// canonical DTO's `Gstr1GstnHsnSummaryRow` and is never emitted. Unlike Table 4/5/7/9B, this row
// carries ALL FOUR tax keys (iamt, camt, samt, csamt) together, unconditionally — the source's own
// object literal has no intra/inter branching for HSN at all.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1WireHsnRow {
  num: number;
  hsn_sc: string;
  desc: string;
  uqc: string;
  qty: number;
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface Gstr1WireHsn {
  hsn_b2b?: Gstr1WireHsnRow[];
  hsn_b2c?: Gstr1WireHsnRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 13 — Documents Issued. `doc_num`/`doc_typ`/`docs[]` and each series's `num`/`from`/`to`/
// `totnum`/`cancel`/`net_issue` are all confirmed verbatim from source
// (`utility/returnStructure.js`'s `case 'doc_issue'` and `returns1.ctrl.js`'s `initNewInvRow`),
// including the exact fixed 12-category label list and 1-based index GSTN assigns each
// (`docDetails` array, same file) — this phase supports only the three categories the frozen Table 13
// engine actually produces (see gstr1GstnAdapter.ts's own `mapTable13Category`): category 1
// "Invoices for outward supply", category 4 "Debit Note", category 5 "Credit Note". `doc_typ` is
// always one of these exact official label strings — never an internal TRIVO name.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1WireDocSeries {
  /** 1-based sequence number of this series WITHIN its document category in this export — a
   *  presentation-ordering artifact the official UI assigns incrementally as a filer adds series rows
   *  (`returns1.ctrl.js`'s `initNewInvRow`), never a statutory value derived from the documents
   *  themselves. */
  num: number;
  from: string;
  to: string;
  totnum: number;
  cancel: number;
  net_issue: number;
}

export interface Gstr1WireDocCategory {
  doc_num: number;
  doc_typ: string;
  docs: Gstr1WireDocSeries[];
}

export interface Gstr1WireDocIssue {
  doc_det: Gstr1WireDocCategory[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The top-level wire return
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full GSTR-1 "Generate File" JSON shape, as the official GSTN Offline Tool V3.2.4 produces it
 * (`service/offline.js`'s `generateFile`/`gstfileNew` pipeline — the actual upload-ready file, not
 * `formDataFormat`'s empty-return template, though both share the same key list for the sections this
 * phase supports). Only sections the canonical DTO declares SUPPORTED are ever present as keys —
 * every unsupported section (b2ba, b2cla, cdnra, cdnura, nil, exp, expa, at, ata, atadj, atadja,
 * supeco, supecoa, ecom, ecoma) has no field on this type at all, matching the official tool's own
 * `omitEmpty()` pass over the generated file (the `omit-empty` npm package — confirmed from its own
 * source: it recursively drops `undefined`/`null`/empty-string/empty-array/empty-object values but
 * explicitly KEEPS `0`, `false`, and `Date` values). This serializer reproduces that same omission
 * rule at the TypeScript level: a section builder returns `undefined` (so the key is never assigned)
 * exactly when the underlying DTO array/object is empty, rather than ever emitting `[]` or `{}`.
 */
export interface Gstr1GstnWireReturn {
  gstin: string;
  /** MMYYYY, e.g. "092026". */
  fp: string;
  /** Preceding-FY AATO (Annual Aggregate Turnover) — the GSTN portal's own "gt" field. Emitted ONLY
   *  when the canonical DTO's `metadata.aato.precedingFy` is VERIFIED with a non-null amount; the
   *  official empty-template generator itself conditionally omits `gt`/`cur_gt` entirely when no
   *  turnover figure is available (`utility/common.js`'s `formDataFormat`'s own `isNaN(gt)` branch),
   *  confirming omission — never a fabricated 0 — is the correct behavior when TRIVO has no verified
   *  figure to report. */
  gt?: number;
  /** Current-FY AATO — same omission rule as `gt`, keyed off `metadata.aato.currentFy`. */
  cur_gt?: number;
  version: string;
  /** Confirmed from source (`utility/common.js`: `var hash = "hash";`, used verbatim in the literal
   *  `"hash":"' + hash + '"` template string) to be a STATIC PLACEHOLDER STRING, not a cryptographic
   *  digest, a per-filing signature, or a value ever computed from the payload's own content — the
   *  variable is hard-coded to the literal word "hash" and never reassigned anywhere this phase's
   *  source search reached. Also confirmed the real `generateFile` pipeline's own key-preservation
   *  list (the quarterly/`isTPQ` section-stripping loop) explicitly protects `"hash"` from deletion
   *  alongside `gstin`/`fp`/`version` — i.e. it is a genuine, always-present key in the actual
   *  generated upload file, not an artifact confined to the empty-template skeleton. This serializer
   *  therefore reproduces it exactly, as the brief's own section 4 instructs for a confirmed literal
   *  wire field, while documenting (here and in this phase's final report) that it carries no
   *  statutory/cryptographic meaning. */
  hash: string;
  b2b?: Gstr1WireB2bRecipient[];
  b2cl?: Gstr1WireB2clPos[];
  b2cs?: Gstr1WireB2cs[];
  cdnr?: Gstr1WireCdnrRecipient[];
  cdnur?: Gstr1WireCdnur[];
  hsn?: Gstr1WireHsn;
  doc_issue?: Gstr1WireDocIssue;
}

/** The literal placeholder value GSTN's own Offline Tool hard-codes for the `hash` field — see
 *  `Gstr1GstnWireReturn.hash`'s own doc comment for the full source evidence. Exported so a test (or
 *  a future caller) can assert against it by name rather than repeating the magic string. */
export const GSTR1_GSTN_WIRE_HASH_PLACEHOLDER = 'hash' as const;

