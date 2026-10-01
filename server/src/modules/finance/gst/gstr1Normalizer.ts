// G2g-3b — GST reporting normalizer. Pure, deterministic functions that turn one persisted sales
// line (InvoiceItem / SalesReturnItem / CreditNoteItem) into one GstReportingLine — a shape a
// future GSTR-1 aggregator (G2g-3c) can group into B2B/B2CL/B2CS/CDNR/Table 12 without having to
// re-derive statutory quantity or re-run GST math itself.
//
// Deliberately NOT in scope here (see PHASE_G2g-3b prompt): no B2B/B2C classification, no table
// aggregation, no CSV export, no new routes/permissions, no schema change. This module only
// normalizes one line at a time — it never queries Prisma directly, so every rule below is
// testable with plain object fixtures (see gstr1Normalizer.test.ts).
//
// Money/weight/quantity fields throughout follow this codebase's existing convention (see
// sales.service.ts, creditNote.service.ts, finance.service.ts): Prisma Decimal columns are typed
// `unknown` at the boundary and converted with `Number(...)`, everything downstream is a plain
// `number` — no decimal.js, no Prisma.Decimal leaking into this module's own API.

import { normalizeGstUqc } from '../../../shared/gstUqc';

const round2 = (n: number) => Math.round(n * 100) / 100;

export type GstReportingSourceType = 'INVOICE' | 'SALES_RETURN' | 'CREDIT_NOTE';

// Where a line's reported UQC actually came from — lets a caller tell "the transaction really
// said GMS" apart from "we're filling in the HSN master's default because the transaction (most
// likely a pre-G2g-3a historical row) never recorded one." Never silently conflated (rule 5).
export type GstUqcSource = 'PERSISTED' | 'HSN_DEFAULT' | 'NONE';

// How a line's statutory Table-12 quantity was derived — see normalizeGstQuantity's rules.
export type GstQuantityBasis =
  | 'BILLING_PIECES'       // PCS/NOS — the line's own billing piece count
  | 'NET_WEIGHT_GMS'       // GMS — the line's own persisted net (gold) weight, in grams
  | 'NO_PHYSICAL_QUANTITY' // a value-only adjustment: by design, nothing physically moved
  | 'UNAVAILABLE'          // the UQC calls for a quantity, but the source data doesn't have one
  | 'UNSUPPORTED_UQC';     // no statutory-quantity rule defined yet for this UQC (see rule 4)

// A Credit Note is either wrapping a real SalesReturn (Path A) or standing alone (Path B) — see
// creditNote.service.ts's own module header for the full design. The aggregator must never count
// both a SALES_RETURN line and its Path A CreditNote line as two separate reductions of the same
// supply (rule 8) — that's why every SALES_RETURN line also carries hasLinkedCreditNote, and every
// CREDIT_NOTE line carries creditNotePath: the two facts one aggregator decision hinges on.
export type CreditNotePath = 'A_WRAPS_RETURN' | 'B_STANDALONE';

export interface GstReportingLine {
  sourceType: GstReportingSourceType;
  /** The originating row's own id (InvoiceItem.id / SalesReturnItem.id / CreditNoteItem.id). */
  sourceId: string;

  invoiceId?: string;
  invoiceItemId?: string;
  invoiceNumber?: string | null;
  invoiceDate?: Date | null;
  /** SalesInvoice.status as persisted (e.g. 'VOID') — the aggregator's own call whether a voided
   *  source invoice should still contribute a line (see J3.5's "a new terminal status must be
   *  checked against every report" lesson — deliberately not pre-filtered out here). */
  invoiceStatus?: string | null;

  salesReturnId?: string;
  /** Only set on a SALES_RETURN line: true when this return already has a Path A CreditNote —
   *  the two are never both counted as separate reductions of the same supply (see CreditNotePath). */
  hasLinkedCreditNote?: boolean;

  creditNoteId?: string;
  creditNoteNumber?: string | null;
  creditNoteDate?: Date | null;
  /** Only set on a CREDIT_NOTE line. */
  creditNotePath?: CreditNotePath;
  /** CreditNote.status as persisted ('ISSUED' | 'CANCELLED', free-text convention — no enum).
   *  Preserved, never filtered out here (rule 8) — the aggregator decides whether a CANCELLED
   *  note still counts. */
  creditNoteStatus?: string;

  hsnCode: string | null;
  hsnCodeId?: string | null;
  description: string | null;

  uqc: string | null;
  uqcSource: GstUqcSource;

  quantity: number;
  quantityBasis: GstQuantityBasis;

  /** Tax-inclusive value of this line — what the party actually paid/was credited for it. */
  value: number;
  /** Net-of-tax, net-of-this-line's-own-share-of-discount value (the persisted snapshot). */
  taxableValue: number;

  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** Always 0 — this schema has no line-level cess column on InvoiceItem/CreditNoteItem, only
   *  TaxInvoice.cess at the header. Attributing a header-level cess down to one line would be a
   *  fabricated allocation (rule 7), so this normalizer never does it; a header-level cess stays
   *  a header-level fact for the aggregator to read off TaxInvoice itself. */
  cessAmount: number;
  gstRate: number;

  buyerGstin: string | null;
  isRegisteredRecipient: boolean;
  placeOfSupply: string | null;
  reverseCharge?: boolean | null;

  sellerRegistrationId: string | null;

  /** true for SALES_RETURN and CREDIT_NOTE — both reduce a previously reported supply rather
   *  than add a new one. */
  isCredit: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// UQC resolution (rule 3 / rule 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the statutory reporting UQC for one line from its own persisted snapshot, falling
 * back to its HSN's defaultUqc, and distinguishes which of the two actually produced the value
 * (rule 5) — a persisted value is the transaction's own authoritative snapshot; a derived one is
 * this read-side function filling a gap (typically a pre-G2g-3a historical row) and must never be
 * reported as if it had actually been stored on the transaction.
 *
 * A persisted value that fails validation (pre-dates G2g-3a's write-time check, or a manual data
 * edit) is not trusted as-is — it is treated exactly like a missing one and the HSN default is
 * tried next. This function never throws: a bad/missing UQC is a fact about the data, reported
 * deterministically (down to `NONE`), not an error this read path raises.
 */
export function resolveReportingUqc(
  persistedUqc: string | null | undefined,
  hsnDefaultUqc: string | null | undefined,
): { uqc: string | null; source: GstUqcSource } {
  const persisted = normalizeGstUqc(persistedUqc);
  if (persisted) return { uqc: persisted, source: 'PERSISTED' };

  const derived = normalizeGstUqc(hsnDefaultUqc);
  if (derived) return { uqc: derived, source: 'HSN_DEFAULT' };

  return { uqc: null, source: 'NONE' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantity resolution (rule 4 — the critical one)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives a line's GSTR-1 Table 12 quantity. `InvoiceItem.quantity`/`CreditNoteItem.quantity` is
 * the billing PIECE count — never treated as the statutory quantity for a weight-based UQC, and
 * never the other way around.
 *
 * `hasPhysicalQuantity` is the caller's own explicit signal, not inferred from the numbers here:
 *   - every InvoiceItem/SalesReturnItem line is a real, physical/billing line → always true.
 *   - a CreditNoteItem's `quantity` column is null for EVERY value-only line (both a fully
 *     standalone Path B line and a Path B line that still points at an invoiceItemId for
 *     traceability — see creditNote.service.ts's buildLineFromInvoiceItem: it always fills
 *     `netWeight` from the source line for traceability, whether or not this is a physical
 *     return, but only fills `quantity` for a genuine Path A physical return). Deriving
 *     `hasPhysicalQuantity` from `netWeight`'s own null-ness would therefore wrongly treat a
 *     value-only Path B line (netWeight present, quantity null) as a physical GMS movement —
 *     exactly the mistake rule 4 forbids. `quantity != null` is the one field the source data
 *     already uses to mean "this credited a real physical return" (see G2g-3a's own schema
 *     comment on CreditNoteItem.quantity), so callers pass that through unchanged rather than
 *     this function re-deriving it.
 *
 * Rules, in order:
 *   1. No physical quantity (a value-only adjustment) → 0, NO_PHYSICAL_QUANTITY. Never copies the
 *      original line's quantity or weight (rule 4's explicit "do not copy" instruction).
 *   2. UQC is PCS or NOS → the line's own billing quantity, if present → BILLING_PIECES.
 *   3. UQC is GMS → the line's own persisted net (gold) weight, if present → NET_WEIGHT_GMS.
 *      Deliberately never gross weight and never stone weight (rule 4).
 *   4. Any other UQC (BAG, BOX, SET, PRS, OTH, ...), or no UQC at all → 0, UNSUPPORTED_UQC. This
 *      codebase's jewelry domain only ever prices by piece or by gram (see gstUqc.ts's own
 *      comment on GMS/PCS being "the primary unit[s]") — no mapping is invented for a UQC this
 *      business doesn't actually transact in.
 *   5. A UQC that DOES have a rule above (PCS/NOS/GMS) but whose required source field is missing
 *      → 0, UNAVAILABLE — distinct from UNSUPPORTED_UQC (a rule exists; the data just doesn't
 *      have what the rule needs) and from NO_PHYSICAL_QUANTITY (a real gap, not a designed one).
 */
export function normalizeGstQuantity(input: {
  uqc: string | null;
  hasPhysicalQuantity: boolean;
  billingQuantity: number | null;
  netWeight: number | null;
}): { quantity: number; basis: GstQuantityBasis } {
  if (!input.hasPhysicalQuantity) return { quantity: 0, basis: 'NO_PHYSICAL_QUANTITY' };

  if (input.uqc === 'PCS' || input.uqc === 'NOS') {
    return input.billingQuantity != null
      ? { quantity: input.billingQuantity, basis: 'BILLING_PIECES' }
      : { quantity: 0, basis: 'UNAVAILABLE' };
  }

  if (input.uqc === 'GMS') {
    return input.netWeight != null
      ? { quantity: input.netWeight, basis: 'NET_WEIGHT_GMS' }
      : { quantity: 0, basis: 'UNAVAILABLE' };
  }

  return { quantity: 0, basis: 'UNSUPPORTED_UQC' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source-type normalizers
// ─────────────────────────────────────────────────────────────────────────────

export interface InvoiceItemSourceRow {
  id: string;
  invoiceId: string;
  description: string;
  quantity: number;
  netGoldWeight: unknown;
  hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
  hsnCodeId: string | null;
  uqc: string | null;
  taxRate: unknown;
  taxableValue: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  lineTotalTax: unknown;
}

export interface InvoiceGstContext {
  invoiceNumber?: string | null;
  invoiceDate?: Date | null;
  /** SalesInvoice.status — e.g. 'VOID'. Passed through, never used to drop the line here. */
  invoiceStatus?: string | null;
  /** From TaxInvoice — null when the invoice has no tax record (non-INR / non-taxable sale). */
  buyerGstin: string | null;
  placeOfSupply: string | null;
  sellerRegistrationId: string | null;
  reverseCharge?: boolean | null;
}

/** Normalizes one InvoiceItem row. Every field used is a persisted snapshot (G1 Part D / G2g-3a)
 *  — no GST or quantity recalculation from today's HSN/metal-rate master (rule 6). */
export function normalizeInvoiceItemLine(item: InvoiceItemSourceRow, ctx: InvoiceGstContext): GstReportingLine {
  const { uqc, source: uqcSource } = resolveReportingUqc(item.uqc, item.hsnCode?.defaultUqc);
  const { quantity, basis: quantityBasis } = normalizeGstQuantity({
    uqc,
    hasPhysicalQuantity: true, // every real invoice line is a physical/billing line — see the module comment on normalizeGstQuantity
    billingQuantity: item.quantity,
    netWeight: Number(item.netGoldWeight),
  });

  const taxableValue = Number(item.taxableValue);
  const lineTotalTax = Number(item.lineTotalTax);
  const buyerGstin = ctx.buyerGstin;

  return {
    sourceType: 'INVOICE',
    sourceId: item.id,
    invoiceId: item.invoiceId,
    invoiceItemId: item.id,
    invoiceNumber: ctx.invoiceNumber ?? null,
    invoiceDate: ctx.invoiceDate ?? null,
    invoiceStatus: ctx.invoiceStatus ?? null,
    hsnCode: item.hsnCode?.code ?? null,
    hsnCodeId: item.hsnCodeId,
    description: item.description,
    uqc, uqcSource,
    quantity, quantityBasis,
    value: round2(taxableValue + lineTotalTax),
    taxableValue,
    cgstAmount: Number(item.cgstAmount),
    sgstAmount: Number(item.sgstAmount),
    igstAmount: Number(item.igstAmount),
    cessAmount: 0,
    gstRate: Number(item.taxRate),
    buyerGstin,
    isRegisteredRecipient: !!buyerGstin?.trim(),
    placeOfSupply: ctx.placeOfSupply,
    reverseCharge: ctx.reverseCharge ?? null,
    sellerRegistrationId: ctx.sellerRegistrationId,
    isCredit: false,
  };
}

export interface SalesReturnItemSourceRow {
  id: string;
  returnId: string;
  invoiceId: string;
  amount: unknown; // tax-inclusive
  invoiceItem: {
    id: string;
    description: string;
    quantity: number;
    netGoldWeight: unknown;
    hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
    hsnCodeId: string | null;
    uqc: string | null;
    taxRate: unknown;
    /** Only used to read the same-state/inter-state split off the original sale — same
     *  `cgstAmount > 0` signal finance.service.ts's getGstSummary already reads for this exact
     *  purpose (a SalesReturnItem has no same-state flag of its own). */
    cgstAmount: unknown;
  };
}

export interface SalesReturnGstContext {
  invoiceNumber?: string | null;
  invoiceDate?: Date | null;
  invoiceStatus?: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  sellerRegistrationId: string | null;
  /** Whether this SalesReturn already has a Path A CreditNote — see hasLinkedCreditNote's own doc. */
  hasLinkedCreditNote: boolean;
}

/**
 * Normalizes one SalesReturnItem row. `SalesReturnItem.amount` is a tax-inclusive figure with no
 * persisted per-line tax breakdown of its own (unlike InvoiceItem/CreditNoteItem), so it is split
 * using the ORIGINAL InvoiceItem's own persisted taxRate — the identical backing-out formula
 * already used in three other places in this codebase (sales.service.ts's createSalesReturn,
 * creditNote.service.ts's buildLineFromInvoiceItem, finance.service.ts's getGstSummary). This is
 * that same established formula reapplied on the read side, not a new GST calculation engine
 * (rule 6) — it never consults today's HSN rate, only the rate already snapshotted on the sale.
 */
export function normalizeSalesReturnItemLine(row: SalesReturnItemSourceRow, ctx: SalesReturnGstContext): GstReportingLine {
  const line = row.invoiceItem;
  const { uqc, source: uqcSource } = resolveReportingUqc(line.uqc, line.hsnCode?.defaultUqc);
  const { quantity, basis: quantityBasis } = normalizeGstQuantity({
    uqc,
    hasPhysicalQuantity: true, // a SalesReturn is inherently physical — the tagged piece came back
    billingQuantity: line.quantity,
    netWeight: Number(line.netGoldWeight),
  });

  const taxRate = Number(line.taxRate);
  const amount = Number(row.amount);
  const taxableValue = round2(amount / (1 + taxRate));
  const taxPortion = round2(amount - taxableValue);
  const isSameState = Number(line.cgstAmount) > 0;
  const cgstAmount = isSameState ? round2(taxPortion / 2) : 0;
  const sgstAmount = isSameState ? round2(taxPortion / 2) : 0;
  const igstAmount = isSameState ? 0 : taxPortion;
  const buyerGstin = ctx.buyerGstin;

  return {
    sourceType: 'SALES_RETURN',
    sourceId: row.id,
    invoiceId: row.invoiceId,
    invoiceItemId: line.id,
    invoiceNumber: ctx.invoiceNumber ?? null,
    invoiceDate: ctx.invoiceDate ?? null,
    invoiceStatus: ctx.invoiceStatus ?? null,
    salesReturnId: row.returnId,
    hasLinkedCreditNote: ctx.hasLinkedCreditNote,
    hsnCode: line.hsnCode?.code ?? null,
    hsnCodeId: line.hsnCodeId,
    description: line.description,
    uqc, uqcSource,
    quantity, quantityBasis,
    value: round2(amount),
    taxableValue,
    cgstAmount, sgstAmount, igstAmount,
    cessAmount: 0,
    gstRate: taxRate,
    buyerGstin,
    isRegisteredRecipient: !!buyerGstin?.trim(),
    placeOfSupply: ctx.placeOfSupply,
    sellerRegistrationId: ctx.sellerRegistrationId,
    isCredit: true,
  };
}

export interface CreditNoteItemSourceRow {
  id: string;
  creditNoteId: string;
  description: string;
  hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
  hsnCodeId: string | null;
  uqc: string | null;
  /** Decimal | null. null on EVERY value-only (Path B) line — see normalizeGstQuantity's doc. */
  quantity: unknown;
  taxRate: unknown;
  taxableValue: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  totalValue: unknown;
  /** Decimal | null — populated for traceability even on some value-only lines; never used to
   *  decide physical-vs-value-only on its own (see normalizeGstQuantity's doc). */
  netWeight: unknown;
}

export interface CreditNoteGstContext {
  invoiceId: string;
  invoiceNumber?: string | null;
  salesReturnId: string | null;
  creditNoteNumber?: string | null;
  creditNoteDate?: Date | null;
  /** CreditNote.status as persisted — 'ISSUED' | 'CANCELLED' (free-text convention, no enum). */
  status: string;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  sellerRegistrationId: string | null;
}

/**
 * Normalizes one CreditNoteItem row. CreditNote carries its own immutable seller/buyer/place-of-
 * supply snapshot (mirrors TaxInvoice's — see the schema comment on CreditNote), so unlike
 * SALES_RETURN this needs no join back to the original invoice's TaxInvoice for those fields.
 *
 * Path A vs Path B (rule 8) is read straight off `salesReturnId` — present only on a Path A note
 * (creditNote.service.ts's createCreditNoteForReturn always sets it; createStandaloneCreditNote
 * never does). Cancellation (rule 8's "cancelled CN remains identifiable") is preserved as-is via
 * `status` — this normalizer never drops a CANCELLED line; excluding it is the aggregator's job.
 */
export function normalizeCreditNoteItemLine(item: CreditNoteItemSourceRow, ctx: CreditNoteGstContext): GstReportingLine {
  const { uqc, source: uqcSource } = resolveReportingUqc(item.uqc, item.hsnCode?.defaultUqc);
  const persistedQuantity = item.quantity != null ? Number(item.quantity) : null;
  const persistedNetWeight = item.netWeight != null ? Number(item.netWeight) : null;
  const { quantity, basis: quantityBasis } = normalizeGstQuantity({
    uqc,
    hasPhysicalQuantity: persistedQuantity != null,
    billingQuantity: persistedQuantity,
    netWeight: persistedNetWeight,
  });

  const taxableValue = Number(item.taxableValue);
  const totalValue = Number(item.totalValue);
  const buyerGstin = ctx.buyerGstin;

  return {
    sourceType: 'CREDIT_NOTE',
    sourceId: item.id,
    invoiceId: ctx.invoiceId,
    invoiceNumber: ctx.invoiceNumber ?? null,
    salesReturnId: ctx.salesReturnId ?? undefined,
    creditNoteId: item.creditNoteId,
    creditNoteNumber: ctx.creditNoteNumber ?? null,
    creditNoteDate: ctx.creditNoteDate ?? null,
    creditNotePath: ctx.salesReturnId ? 'A_WRAPS_RETURN' : 'B_STANDALONE',
    creditNoteStatus: ctx.status,
    hsnCode: item.hsnCode?.code ?? null,
    hsnCodeId: item.hsnCodeId,
    description: item.description,
    uqc, uqcSource,
    quantity, quantityBasis,
    value: round2(totalValue),
    taxableValue,
    cgstAmount: Number(item.cgstAmount),
    sgstAmount: Number(item.sgstAmount),
    igstAmount: Number(item.igstAmount),
    cessAmount: 0,
    gstRate: Number(item.taxRate),
    buyerGstin,
    isRegisteredRecipient: !!buyerGstin?.trim(),
    placeOfSupply: ctx.placeOfSupply,
    sellerRegistrationId: ctx.sellerRegistrationId,
    isCredit: true,
  };
}
