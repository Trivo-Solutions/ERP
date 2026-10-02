// G2g-4c-3 — GSTR-1 GSTN JSON serializer. The final pure transformation from the canonical export DTO
// (`gstr1GstnAdapter.ts` / `gstr1GstnExport.types.ts`, both frozen for this phase) to the literal
// GSTN Offline Tool wire JSON shape (`gstr1GstnWire.types.ts`, this phase):
//
//   Frozen GSTR-1 engines -> gstr1GstnAdapter.ts -> Gstr1GstnExportDto -> gstr1GstnValidator.ts
//   (structural/compliance gate, frozen) -> THIS serializer -> GSTN offline JSON
//
// This file takes NO Prisma dependency, performs NO database access, NO HTTP-context access, NO
// filesystem/network access, and never mutates the DTO it is handed — every output object below is
// freshly constructed. It performs NO GST recalculation, NO B2B/B2CL/B2CS reclassification, NO
// credit/debit-note amount calculation, and NO re-validation of business rules the frozen validator
// already owns — it only reshapes already-computed values into the exact wire field names, groupings,
// and key-presence rules the official GST Offline Tool V3.2.4 produces. Pure, deterministic,
// synchronous: the same `Gstr1GstnExportDto` always serializes to byte-identical JSON.
//
// ─────────────────────────────────────────────────────────────────────────────
// Official source verification (this phase's own, done directly against the local install at
// `C:\GST Offline Tool`, V3.2.4 — not merely trusted from an earlier report). Every structural claim
// below was independently re-traced in that source before being relied on here; the specific file/
// line evidence for each is also recorded on the corresponding type in `gstr1GstnWire.types.ts`.
// Summary of what was found, including two points where this phase's own direct reading corrects an
// earlier assumption:
//
//   1. `hash` IS a genuine, always-present key in the real generated upload file (protected from
//      deletion in `service/offline.js`'s quarterly-filing section-stripping loop) — but it is a
//      STATIC PLACEHOLDER STRING (`var hash = "hash";`), never a computed cryptographic value.
//      Reproduced verbatim.
//   2. The modern (May-2025+) bifurcated HSN row shape (`hsn_b2b`/`hsn_b2c`) genuinely has NO `val`
//      key — confirmed directly from the real row-construction code for that shape
//      (`utility/returnStructure.js`, `case 'hsn(b2b)': case 'hsn(b2c)':`), not merely inferred.
//   3. B2B `inv_typ` enum is exactly `R | SEWP | SEWOP | DE | CBW` (`public/data/invtypesforb2b.json`).
//   4. CDNUR `typ` has exactly two valid values anywhere in the official UI: `B2CL` and `EXP`
//      (`scopelists.URList`) — this phase emits only `B2CL`, matching the frozen adapter's own
//      B2CL-origin-only CDNUR input.
//   5. Item numbering (`num` inside `itms[]`) is the GST rate scaled by 100, plus 1 — confirmed at
//      TWO independent call sites (`utility/returnStructure.js` line 3516, and
//      `public/uiassets/js/returns/returns1.ctrl.js`'s `updateSavePayload`). The official source
//      computes this as a raw `rate * 100 + 1`, with no explicit rounding; this serializer applies
//      `Math.round(rate * 100) + 1` instead — numerically identical for every real GST rate (at most
//      2 decimal digits) once IEEE-754 float noise is accounted for, and strictly safer. Documented as
//      a deliberate hardening, not a deviation in meaning (see `round2`/`computeItemNum` below).
//   6. Tax-key omission (never zero-fill) for B2B/B2CL/B2CS/CDNR/CDNUR item-level amounts is
//      confirmed directly from TWO independently-constructed real object literals — B2CS's own
//      intra/inter branches in `utility/returnStructure.js`'s `case 'b2cs'`, and B2B/B2CL/CDNR/CDNUR's
//      shared `itm_det` construction in `returns1.ctrl.js`'s `updateSavePayload` — both omit the
//      opposite key set entirely rather than including it as 0.
//   7. Table 12 HSN rows are the ONE exception to rule 6 — they carry all four tax keys (iamt, camt,
//      samt, csamt) together, unconditionally; the real HSN row-construction code has no intra/inter
//      branching at all.
//   8. Table 13 Documents Issued: the fixed 12-category label list and 1-based `doc_num` index
//      (`docDetails` in `utility/returnStructure.js`) confirms categories 1/4/5 are exactly
//      "Invoices for outward supply"/"Debit Note"/"Credit Note" — the literal strings this phase's
//      three supported categories map to.
//   9. Empty-section omission: the real `generateFile` pipeline runs `omitEmpty()` (the `omit-empty`
//      npm package) over the final object before writing it. That package's own source was read
//      directly: it recursively removes `undefined`/`null`/empty-string/empty-array/empty-object
//      values but explicitly KEEPS `0`, `false`, and `Date` values (`has-values` package, its one
//      dependency for the leaf-value decision). This serializer reproduces exactly that selectivity —
//      a whole top-level section key is omitted when its underlying array/object is empty, but a
//      populated section's own zero-valued numeric fields (e.g. `cess: 0`) are never stripped.
//  10. B2CS `sply_ty` wire values are `'INTRA'`/`'INTER'` (`utility/returnStructure.js`'s `fixPOS()`
//      for type `'b2cs'`) — NOT the canonical DTO's own differently-spelled
//      `'INTRA_STATE'`/`'INTER_STATE'` enum. `rchrg` is the wire string `'Y'`/`'N'`, never a JSON
//      boolean (confirmed: `rowObj.rchrg = 'N'` is the literal default used throughout the real
//      controller source).
//  11. Date format is `DD-MM-YYYY` (confirmed: `utility/returnStructure.js`, `date.format('DD-MM-YYYY')`).
//  12. Rounding: the official `cnvt2Nm()` helper is `parseFloat(parseFloat(s).toFixed(2))` —
//      equivalent in effect to this codebase's own established `round2(n) = Math.round(n*100)/100`
//      convention (see gstr1GstnAdapter.ts's own `round2`); no deviation needed.
// ─────────────────────────────────────────────────────────────────────────────

import { IST_OFFSET_MS } from '../../../shared/compliance';
import { validateGstin } from '../../../shared/gstin';
import { isValidGstUqc } from '../../../shared/gstUqc';
import type {
  Gstr1GstnExportDto,
  Gstr1GstnB2bInvoice,
  Gstr1GstnB2clInvoice,
  Gstr1GstnB2csRecord,
  Gstr1GstnCdnrNote,
  Gstr1GstnCdnurNote,
  Gstr1GstnHsnSummaryRow,
  Gstr1GstnDocumentSeries,
  Gstr1GstnDocumentIssuedCategory,
  Gstr1GstnRateGroup,
} from './gstr1GstnExport.types';
import {
  GSTR1_GSTN_WIRE_HASH_PLACEHOLDER,
  type Gstr1GstnWireReturn,
  type Gstr1WireItem,
  type Gstr1WireItemDetail,
  type Gstr1WireB2bRecipient,
  type Gstr1WireB2bInvoice,
  type Gstr1WireB2clPos,
  type Gstr1WireB2clInvoice,
  type Gstr1WireB2cs,
  type Gstr1WireCdnrRecipient,
  type Gstr1WireCdnrNote,
  type Gstr1WireCdnur,
  type Gstr1WireHsn,
  type Gstr1WireHsnRow,
  type Gstr1WireDocIssue,
  type Gstr1WireDocCategory,
  type Gstr1WireDocSeries,
} from './gstr1GstnWire.types';

// ─────────────────────────────────────────────────────────────────────────────
// Options / errors
// ─────────────────────────────────────────────────────────────────────────────

/** Reserved for future use — this phase needs no configurable behavior (every wire-shape decision is
 *  either fixed by the official contract or derived from the DTO itself). Kept as a typed, extensible
 *  parameter (per this phase's own API contract) rather than omitted, so a future option never
 *  requires a breaking signature change. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Gstr1SerializerOptions {}

export type Gstr1GstnSerializationErrorCode =
  | 'MISSING_GSTIN'
  | 'INVALID_GSTIN'
  | 'MISSING_FILING_PERIOD'
  | 'MALFORMED_FILING_PERIOD'
  | 'MISSING_INVOICE_DATE'
  | 'INVALID_DATE'
  | 'NON_FINITE_VALUE'
  | 'MALFORMED_PLACE_OF_SUPPLY'
  | 'INVALID_DOCUMENT_NUMBER'
  | 'ITEM_SEQUENCE_COLLISION'
  | 'UNSUPPORTED_DOCUMENT_CATEGORY'
  | 'INVALID_HSN_CODE'
  | 'INVALID_UQC'
  | 'MISSING_CDNR_RECIPIENT_GSTIN';

/**
 * Thrown by `serializeGstr1ToGstnJson` when the DTO cannot be safely serialized into GSTN wire JSON.
 * The serializer never silently repairs or guesses a statutory value — see this file's header and
 * section 20 of the implementation brief. `context` carries loose, human-readable diagnostic detail
 * (document numbers, field names, the offending value) — never itself part of the GSTN payload.
 */
export class Gstr1GstnSerializationError extends Error {
  readonly code: Gstr1GstnSerializationErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: Gstr1GstnSerializationErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'Gstr1GstnSerializationError';
    this.code = code;
    this.context = context;
  }
}

function fail(code: Gstr1GstnSerializationErrorCode, message: string, context?: Record<string, unknown>): never {
  throw new Gstr1GstnSerializationError(code, message, context);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Matches gstr1GstnAdapter.ts's own `round2` exactly — see this file's header, finding 12. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertFinite(value: number, label: string, context: Record<string, unknown>): number {
  if (!Number.isFinite(value)) {
    fail('NON_FINITE_VALUE', `${label} is not a finite number (got ${value}).`, { ...context, field: label, value });
  }
  return value;
}

function roundedFinite(value: number, label: string, context: Record<string, unknown>): number {
  return round2(assertFinite(value, label, context));
}

/** DD-MM-YYYY, IST calendar day — see this file's header, finding 11. Shifts by the fixed +5:30
 *  offset and reads the UTC calendar fields of the shifted instant, the same pattern this codebase's
 *  own `shared/compliance.ts: istDayBounds` and `shared/istDate.ts` already use — never a timezone
 *  library, never the server's own local timezone. */
function formatDateDDMMYYYY(d: Date, label: string, context: Record<string, unknown>): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    fail('INVALID_DATE', `${label} is not a valid date.`, { ...context, field: label });
  }
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const year = shifted.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

const POS_RE = /^\d{2}$/;

/** Structural shape check only (2 digits) — a real GST state-code membership check already happened
 *  upstream (the frozen classification/validator pipeline); this is a wire-shape guard, not a second
 *  business-rule gate. */
function assertPos(pos: string | null | undefined, context: Record<string, unknown>): string {
  if (!pos || !POS_RE.test(pos)) {
    fail('MALFORMED_PLACE_OF_SUPPLY', `Place of supply "${pos ?? '(none)'}" is not a 2-digit GST state/UT code.`, context);
  }
  return pos;
}

/** GSTN's `rchrg`/CDNR wire strings are 'Y'/'N', never a JSON boolean — see this file's header,
 *  finding 10. `null` (TRIVO's own "source fact was unset" state) is not a real GSTN value; it
 *  defaults to 'N', matching the official UI's own default for a freshly-created row
 *  (`rowObj.rchrg = 'N'`), never 'Y' (which would fabricate a reverse-charge fact that doesn't exist). */
function reverseChargeFlag(reverseCharge: boolean | null): 'Y' | 'N' {
  return reverseCharge === true ? 'Y' : 'N';
}

/**
 * Item numbering — see this file's header, finding 5. One `Gstr1WireItem` per collapsed rate group.
 * `interState` is resolved ONCE per invoice/note (from its own place-of-supply vs. the filing GSTIN's
 * state — see `resolveInterState` below) and applied uniformly to every rate group on that document,
 * since a single invoice/note has exactly one place of supply.
 */
function computeItemNum(rate: number, context: Record<string, unknown>): number {
  const num = Math.round(assertFinite(rate, 'rate', context) * 100) + 1;
  return num;
}

function buildItemDetail(rg: Gstr1GstnRateGroup, interState: boolean, context: Record<string, unknown>): Gstr1WireItemDetail {
  const txval = roundedFinite(rg.taxableValue, 'rateGroups.taxableValue', context);
  const rt = assertFinite(rg.rate, 'rateGroups.rate', context);
  const csamt = roundedFinite(rg.cess, 'rateGroups.cess', context);
  if (interState) {
    const iamt = roundedFinite(rg.igst, 'rateGroups.igst', context);
    return { txval, rt, iamt, csamt };
  }
  const camt = roundedFinite(rg.cgst, 'rateGroups.cgst', context);
  const samt = roundedFinite(rg.sgst, 'rateGroups.sgst', context);
  return { txval, rt, camt, samt, csamt };
}

/**
 * Builds one document's `itms[]`, detecting an item-sequence collision (two distinct rate groups
 * resolving to the same `num` — see this file's header, finding 5, and the brief's section 11/20:
 * "If two generated item numbers collide, fail validation rather than silently producing ambiguous
 * output"). Rate groups arrive already deduplicated-by-rate from the frozen adapter
 * (`collapseRateGroups`), so a collision here can only mean two DISTINCT rates rounding to the same
 * wire `num` — genuinely ambiguous, never silently merged or overwritten.
 */
function buildItems(rateGroups: Gstr1GstnRateGroup[], interState: boolean, context: Record<string, unknown>): Gstr1WireItem[] {
  const items: Gstr1WireItem[] = [];
  const seenNums = new Map<number, number>();
  for (const rg of rateGroups) {
    const num = computeItemNum(rg.rate, context);
    const priorRate = seenNums.get(num);
    if (priorRate !== undefined && priorRate !== rg.rate) {
      fail(
        'ITEM_SEQUENCE_COLLISION',
        `Rate groups at ${priorRate}% and ${rg.rate}% both resolve to item num ${num} — cannot be represented unambiguously.`,
        { ...context, num, rates: [priorRate, rg.rate] },
      );
    }
    seenNums.set(num, rg.rate);
    items.push({ num, itm_det: buildItemDetail(rg, interState, context) });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level metadata
// ─────────────────────────────────────────────────────────────────────────────

function resolveSellerStateCode(gstin: string): string {
  const result = validateGstin(gstin);
  if (!result.valid) {
    fail('INVALID_GSTIN', `Seller GSTIN "${gstin}" failed structural/checksum validation: ${result.errors.join('; ')}`, { gstin });
  }
  return result.gstin.slice(0, 2);
}

const FILING_PERIOD_RE = /^(0[1-9]|1[0-2])\d{4}$/;

function assertFilingPeriod(fp: string | null): string {
  if (!fp || fp.trim() === '') {
    fail('MISSING_FILING_PERIOD', 'No GSTN statutory filing period (MMYYYY) was resolved for this export.');
  }
  if (!FILING_PERIOD_RE.test(fp)) {
    fail('MALFORMED_FILING_PERIOD', `Filing period "${fp}" is not a well-formed MMYYYY value.`, { filingPeriodMmYYYY: fp });
  }
  return fp;
}

/** `gt`/`cur_gt` — see gstr1GstnWire.types.ts's own doc comment on `Gstr1GstnWireReturn.gt`. Emitted
 *  only off a VERIFIED, non-null AATO figure; never a fabricated 0 for MISSING/UNVERIFIED. */
function resolveAatoWireAmount(figure: { amount: number | null; verificationState: string }): number | undefined {
  if (figure.verificationState !== 'VERIFIED' || figure.amount == null) return undefined;
  return round2(figure.amount);
}

/** `isInterState` is read off the document's own place-of-supply vs. the filing GSTIN's own state —
 *  two fields already present on the DTO — never a recomputation of GST liability itself (the frozen
 *  classification engine already decided that upstream; this is pure wire-shape selection: which key
 *  set, camt/samt or iamt, to serialize). Resolved ONCE per document and applied to every one of its
 *  rate groups, since one invoice/note has exactly one place of supply. */
function resolveInterState(placeOfSupply: string | null, sellerStateCode: string, context: Record<string, unknown>): boolean {
  const pos = assertPos(placeOfSupply, context);
  return pos !== sellerStateCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 — B2B
// ─────────────────────────────────────────────────────────────────────────────

function buildB2bInvoice(inv: Gstr1GstnB2bInvoice, sellerStateCode: string): Gstr1WireB2bInvoice {
  const context = { section: 'B2B', documentNumber: inv.invoiceNumber };
  if (!inv.invoiceDate) {
    fail('MISSING_INVOICE_DATE', `B2B invoice ${inv.invoiceNumber} has no invoice date.`, context);
  }
  const interState = resolveInterState(inv.placeOfSupply, sellerStateCode, context);
  // A real, verified non-'R' value (SEWP/SEWOP/DE/CBW) is trusted as-is — see
  // gstr1GstnWire.types.ts's own Gstr1WireB2bInvoiceType comment and this file's header, finding 3.
  // The frozen adapter always emits null today, which resolves to 'R' here.
  const invType = inv.invoiceType ?? 'R';
  return {
    inum: inv.invoiceNumber,
    idt: formatDateDDMMYYYY(inv.invoiceDate, 'invoiceDate', context),
    val: roundedFinite(inv.invoiceValue, 'invoiceValue', context),
    pos: inv.placeOfSupply as string,
    rchrg: reverseChargeFlag(inv.reverseCharge),
    inv_typ: invType,
    itms: buildItems(inv.rateGroups, interState, context),
  };
}

function buildB2b(invoices: Gstr1GstnB2bInvoice[], sellerStateCode: string): Gstr1WireB2bRecipient[] | undefined {
  if (invoices.length === 0) return undefined;
  const byCtin = new Map<string, Gstr1WireB2bInvoice[]>();
  for (const inv of invoices) {
    const wireInv = buildB2bInvoice(inv, sellerStateCode);
    const list = byCtin.get(inv.recipientGstin) ?? [];
    list.push(wireInv);
    byCtin.set(inv.recipientGstin, list);
  }
  return Array.from(byCtin.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ctin, inv]) => ({ ctin, inv }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 5 — B2CL. Always inter-state (see gstr1GstnWire.types.ts's own header on this section) — no
// place-of-supply-vs-seller-state comparison needed; the frozen classification already guarantees it.
// ─────────────────────────────────────────────────────────────────────────────

function buildB2clInvoice(inv: Gstr1GstnB2clInvoice): Gstr1WireB2clInvoice {
  const context = { section: 'B2CL', documentNumber: inv.invoiceNumber };
  if (!inv.invoiceDate) {
    fail('MISSING_INVOICE_DATE', `B2CL invoice ${inv.invoiceNumber} has no invoice date.`, context);
  }
  return {
    inum: inv.invoiceNumber,
    idt: formatDateDDMMYYYY(inv.invoiceDate, 'invoiceDate', context),
    val: roundedFinite(inv.invoiceValue, 'invoiceValue', context),
    itms: buildItems(inv.rateGroups, true, context),
  };
}

function buildB2cl(invoices: Gstr1GstnB2clInvoice[]): Gstr1WireB2clPos[] | undefined {
  if (invoices.length === 0) return undefined;
  const byPos = new Map<string, Gstr1WireB2clInvoice[]>();
  for (const inv of invoices) {
    const context = { section: 'B2CL', documentNumber: inv.invoiceNumber };
    const pos = assertPos(inv.placeOfSupply, context);
    const wireInv = buildB2clInvoice(inv);
    const list = byPos.get(pos) ?? [];
    list.push(wireInv);
    byPos.set(pos, list);
  }
  return Array.from(byPos.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pos, inv]) => ({ pos, inv }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 7 — B2CS. `supplyType` is already explicit on the canonical DTO (the frozen adapter's own
// `Gstr1GstnB2csRecord`) — trusted as-is, never recomputed from place of supply (unlike B2B/B2CL/
// CDNR/CDNUR, which carry no such explicit field and must derive it).
// ─────────────────────────────────────────────────────────────────────────────

function buildB2csRecord(r: Gstr1GstnB2csRecord, index: number): Gstr1WireB2cs {
  const context = { section: 'B2CS', placeOfSupply: r.placeOfSupply, rate: r.rate, index };
  const pos = assertPos(r.placeOfSupply, context);
  const rt = assertFinite(r.rate, 'rate', context);
  const txval = roundedFinite(r.taxableValue, 'taxableValue', context);
  const csamt = roundedFinite(r.cess, 'cess', context);
  if (r.supplyType === 'INTER_STATE') {
    const iamt = roundedFinite(r.igst, 'igst', context);
    return { sply_ty: 'INTER', typ: r.ecommerceSupplyType, pos, rt, txval, iamt, csamt };
  }
  const camt = roundedFinite(r.cgst, 'cgst', context);
  const samt = roundedFinite(r.sgst, 'sgst', context);
  return { sply_ty: 'INTRA', typ: r.ecommerceSupplyType, pos, rt, txval, camt, samt, csamt };
}

function buildB2cs(records: Gstr1GstnB2csRecord[]): Gstr1WireB2cs[] | undefined {
  if (records.length === 0) return undefined;
  return records.map((r, idx) => buildB2csRecord(r, idx));
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 9B — CDNR / CDNUR
// ─────────────────────────────────────────────────────────────────────────────

function buildCdnrNote(note: Gstr1GstnCdnrNote, sellerStateCode: string): Gstr1WireCdnrNote {
  const context = { section: 'CDNR', documentNumber: note.noteNumber };
  const interState = resolveInterState(note.placeOfSupply, sellerStateCode, context);
  return {
    nt_num: note.noteNumber,
    nt_dt: formatDateDDMMYYYY(note.noteDate, 'noteDate', context),
    ntty: note.noteType,
    val: roundedFinite(note.noteValue, 'noteValue', context),
    pos: note.placeOfSupply as string,
    // Domestic CDNR scope — see this file's header, finding 6 context and the brief's section 14.
    rchrg: 'N',
    inv_typ: 'R',
    itms: buildItems(note.rateGroups, interState, context),
  };
}

function buildCdnr(notes: Gstr1GstnCdnrNote[], sellerStateCode: string): Gstr1WireCdnrRecipient[] | undefined {
  if (notes.length === 0) return undefined;
  const byCtin = new Map<string, Gstr1WireCdnrNote[]>();
  for (const note of notes) {
    const context = { section: 'CDNR', documentNumber: note.noteNumber };
    // Defensive only — the frozen adapter guarantees a non-null, present recipientGstin for every
    // CDNR document by construction (it only ever populates this bucket for a registered recipient;
    // see gstr1GstnAdapter.ts's own creditNoteToCdnr/salesDebitNoteToCdnr). Never expected to fire
    // against real adapter output.
    if (!note.recipientGstin || note.recipientGstin.trim() === '') {
      fail('MISSING_CDNR_RECIPIENT_GSTIN', `CDNR note ${note.noteNumber} has no recipient GSTIN.`, context);
    }
    const wireNote = buildCdnrNote(note, sellerStateCode);
    const list = byCtin.get(note.recipientGstin) ?? [];
    list.push(wireNote);
    byCtin.set(note.recipientGstin, list);
  }
  return Array.from(byCtin.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ctin, nt]) => ({ ctin, nt }));
}

/**
 * CDNUR's `typ` is fixed to 'B2CL' — the frozen adapter's only CDNUR input is the B2CL-origin credit/
 * sales-debit-note bucket (`creditNoteToCdnur`/`salesDebitNoteToCdnur` in gstr1GstnAdapter.ts, both
 * reading from `...cdnur.b2cl...`); the canonical `Gstr1GstnCdnurNote` type carries no "origin" field
 * at all for this serializer to independently re-verify against (the same structural gap the frozen
 * validator documents for its own analogous check — see gstr1GstnValidator.ts's `checkCdnur` comment).
 * There is therefore no real signal under which this phase could ever detect — let alone reject — a
 * non-B2CL-origin note; see this file's header, finding 4, and the brief's section 15.
 */
function buildCdnurNote(note: Gstr1GstnCdnurNote, sellerStateCode: string): Gstr1WireCdnur {
  const context = { section: 'CDNUR', documentNumber: note.noteNumber };
  const interState = resolveInterState(note.placeOfSupply, sellerStateCode, context);
  return {
    ntty: note.noteType,
    nt_num: note.noteNumber,
    nt_dt: formatDateDDMMYYYY(note.noteDate, 'noteDate', context),
    val: roundedFinite(note.noteValue, 'noteValue', context),
    typ: 'B2CL',
    pos: note.placeOfSupply as string,
    itms: buildItems(note.rateGroups, interState, context),
  };
}

function buildCdnur(notes: Gstr1GstnCdnurNote[], sellerStateCode: string): Gstr1WireCdnur[] | undefined {
  if (notes.length === 0) return undefined;
  return notes.map((note) => buildCdnurNote(note, sellerStateCode));
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 12 — HSN summary. All four tax keys always present together — see this file's header,
// finding 7, and gstr1GstnWire.types.ts's own header on Gstr1WireHsnRow. `num` is a per-section
// (hsn_b2b vs. hsn_b2c) sequential 1-based count, per the brief's section 16.
// ─────────────────────────────────────────────────────────────────────────────

function buildHsnRow(row: Gstr1GstnHsnSummaryRow, num: number, reportingTab: 'B2B' | 'B2C'): Gstr1WireHsnRow {
  const context = { section: `TABLE_12_${reportingTab}`, hsnCode: row.hsnCode, uqc: row.uqc, rate: row.rate };
  if (!row.hsnCode) {
    fail('INVALID_HSN_CODE', `Table 12 (${reportingTab}) row at rate ${row.rate}% has no HSN code.`, context);
  }
  if (!row.description) {
    fail('INVALID_HSN_CODE', `Table 12 (${reportingTab}) HSN ${row.hsnCode} has no description.`, context);
  }
  if (!isValidGstUqc(row.uqc)) {
    fail('INVALID_UQC', `Table 12 (${reportingTab}) row (HSN ${row.hsnCode}) has an unsupported UQC "${row.uqc ?? '(none)'}".`, context);
  }
  return {
    num,
    hsn_sc: row.hsnCode,
    desc: row.description,
    uqc: row.uqc,
    qty: roundedFinite(row.quantity, 'quantity', context),
    rt: assertFinite(row.rate, 'rate', context),
    txval: roundedFinite(row.taxableValue, 'taxableValue', context),
    iamt: roundedFinite(row.igst, 'igst', context),
    camt: roundedFinite(row.cgst, 'cgst', context),
    samt: roundedFinite(row.sgst, 'sgst', context),
    csamt: roundedFinite(row.cess, 'cess', context),
  };
}

function buildHsn(hsnB2b: Gstr1GstnHsnSummaryRow[], hsnB2c: Gstr1GstnHsnSummaryRow[]): Gstr1WireHsn | undefined {
  const result: Gstr1WireHsn = {};
  if (hsnB2b.length > 0) {
    result.hsn_b2b = hsnB2b.map((row, idx) => buildHsnRow(row, idx + 1, 'B2B'));
  }
  if (hsnB2c.length > 0) {
    result.hsn_b2c = hsnB2c.map((row, idx) => buildHsnRow(row, idx + 1, 'B2C'));
  }
  return result.hsn_b2b || result.hsn_b2c ? result : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 13 — Documents Issued
// ─────────────────────────────────────────────────────────────────────────────

/** Exact official category index + label — see this file's header, finding 8. */
const DOCUMENT_CATEGORY_WIRE: Record<Gstr1GstnDocumentIssuedCategory, { doc_num: number; doc_typ: string }> = {
  INVOICES_FOR_OUTWARD_SUPPLY: { doc_num: 1, doc_typ: 'Invoices for outward supply' },
  DEBIT_NOTE: { doc_num: 4, doc_typ: 'Debit Note' },
  CREDIT_NOTE: { doc_num: 5, doc_typ: 'Credit Note' },
};

const DOCUMENT_NUMBER_RE = /^[A-Za-z0-9\-/]+$/;

function assertDocumentNumber(num: string, context: Record<string, unknown>): string {
  if (!num || num.length === 0 || num.length > 16 || !DOCUMENT_NUMBER_RE.test(num)) {
    fail('INVALID_DOCUMENT_NUMBER', `Document number "${num}" violates Rule 46(b) (1-16 characters, alphanumeric plus '-'/'/' only).`, context);
  }
  return num;
}

function buildDocSeries(series: Gstr1GstnDocumentSeries, num: number): Gstr1WireDocSeries {
  const context = { section: 'TABLE_13', documentCategory: series.documentCategory, fromDocumentNumber: series.fromDocumentNumber };
  return {
    num,
    from: assertDocumentNumber(series.fromDocumentNumber, context),
    to: assertDocumentNumber(series.toDocumentNumber, { ...context, toDocumentNumber: series.toDocumentNumber }),
    totnum: assertFinite(series.totalIssued, 'totalIssued', context),
    cancel: assertFinite(series.cancelled, 'cancelled', context),
    net_issue: assertFinite(series.netIssued, 'netIssued', context),
  };
}

function buildDocIssue(series: Gstr1GstnDocumentSeries[]): Gstr1WireDocIssue | undefined {
  if (series.length === 0) return undefined;
  const byCategory = new Map<Gstr1GstnDocumentIssuedCategory, Gstr1GstnDocumentSeries[]>();
  for (const s of series) {
    const wire = DOCUMENT_CATEGORY_WIRE[s.documentCategory];
    if (!wire) {
      fail('UNSUPPORTED_DOCUMENT_CATEGORY', `Document category "${s.documentCategory}" has no GSTN wire mapping.`, { section: 'TABLE_13' });
    }
    const list = byCategory.get(s.documentCategory) ?? [];
    list.push(s);
    byCategory.set(s.documentCategory, list);
  }
  const docDet: Gstr1WireDocCategory[] = Array.from(byCategory.entries())
    .sort(([a], [b]) => DOCUMENT_CATEGORY_WIRE[a].doc_num - DOCUMENT_CATEGORY_WIRE[b].doc_num)
    .map(([category, list]) => {
      const sorted = [...list].sort((a, b) => {
        const fy = (a.financialYear ?? 0) - (b.financialYear ?? 0);
        if (fy !== 0) return fy;
        const prefix = a.seriesPrefix.localeCompare(b.seriesPrefix);
        if (prefix !== 0) return prefix;
        return a.fromSerial - b.fromSerial;
      });
      const { doc_num, doc_typ } = DOCUMENT_CATEGORY_WIRE[category];
      return { doc_num, doc_typ, docs: sorted.map((s, idx) => buildDocSeries(s, idx + 1)) };
    });
  return { doc_det: docDet };
}

// ─────────────────────────────────────────────────────────────────────────────
// The serializer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serializes a canonical GSTR-1 GSTN export DTO into the literal GSTN Offline Tool wire JSON shape.
 * Pure and side-effect free: no Prisma, no Date.now(), no randomness, no mutation of the input DTO —
 * the same input always produces byte-identical output. Throws `Gstr1GstnSerializationError` rather
 * than producing a malformed or statutorily-incorrect payload (see this file's header and the
 * `Gstr1GstnSerializationErrorCode` union for every rejection this function can raise).
 *
 * Does NOT re-run `validateGstr1GstnExport` (G2g-4c-2) — that validator's blockers are a distinct,
 * broader filing-readiness gate (AATO verification, HSN-digit mandates, branch-scope completeness,
 * ...) a caller is expected to run beforehand; this function's own checks are the narrower set needed
 * to serialize safely at all (see section 20 of the implementation brief).
 */
export function serializeGstr1ToGstnJson(dto: Gstr1GstnExportDto, _options?: Gstr1SerializerOptions): Gstr1GstnWireReturn {
  if (!dto.metadata.gstin || dto.metadata.gstin.trim() === '') {
    fail('MISSING_GSTIN', 'The export carries no seller GSTIN.');
  }
  const sellerStateCode = resolveSellerStateCode(dto.metadata.gstin);
  const fp = assertFilingPeriod(dto.metadata.period.filingPeriodMmYYYY);

  const wire: Gstr1GstnWireReturn = {
    gstin: dto.metadata.gstin.trim().toUpperCase(),
    fp,
    version: dto.metadata.schemaVersion,
    hash: GSTR1_GSTN_WIRE_HASH_PLACEHOLDER,
  };

  const gt = resolveAatoWireAmount(dto.metadata.aato.precedingFy);
  if (gt !== undefined) wire.gt = gt;
  const curGt = resolveAatoWireAmount(dto.metadata.aato.currentFy);
  if (curGt !== undefined) wire.cur_gt = curGt;

  const b2b = buildB2b(dto.b2b, sellerStateCode);
  if (b2b) wire.b2b = b2b;

  const b2cl = buildB2cl(dto.b2cl);
  if (b2cl) wire.b2cl = b2cl;

  const b2cs = buildB2cs(dto.b2cs);
  if (b2cs) wire.b2cs = b2cs;

  const cdnr = buildCdnr(dto.cdnr, sellerStateCode);
  if (cdnr) wire.cdnr = cdnr;

  const cdnur = buildCdnur(dto.cdnur, sellerStateCode);
  if (cdnur) wire.cdnur = cdnur;

  const hsn = buildHsn(dto.hsnB2b, dto.hsnB2c);
  if (hsn) wire.hsn = hsn;

  const docIssue = buildDocIssue(dto.documentsIssued);
  if (docIssue) wire.doc_issue = docIssue;

  return wire;
}
