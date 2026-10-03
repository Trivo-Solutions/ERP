// G8c — deterministic builder: persisted invoice facts → provider-neutral CanonicalIrnRequest.
// Pure. It copies the persisted, already-snapshotted GST values (InvoiceItem tax columns, TaxInvoice
// seller/buyer snapshots) and never re-prices or re-computes tax — the invoice's own numbers are the
// source of truth. It refuses to build for a document the eligibility engine did not clear.
import { EInvoiceSource, CanonicalIrnRequest, CanonicalIrnLine, CanonicalIrnParty } from './eInvoice.types';
import { evaluateEInvoiceEligibility, num } from './eInvoiceEligibility';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

// Business timezone: Asia/Kolkata, fixed +5:30, no DST — same constant every GST serializer uses.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar day of a persisted invoice instant, as [yyyy, mm, dd]. Reads the UTC fields of the
 *  IST-shifted instant, so the result never depends on the machine's own timezone. */
function istCalendarParts(d: Date): [string, string, string] {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return [String(s.getUTCFullYear()), String(s.getUTCMonth() + 1).padStart(2, '0'), String(s.getUTCDate()).padStart(2, '0')];
}

/** Canonical business date, ISO `YYYY-MM-DD` (IST calendar day). */
export function formatDocumentDate(d: Date): string {
  const [y, m, day] = istCalendarParts(d);
  return `${y}-${m}-${day}`;
}

/** The same business day in the `DD/MM/YYYY` form the IRP expects — for the provider-boundary mapping. */
export function formatIrpDate(d: Date): string {
  const [y, m, day] = istCalendarParts(d);
  return `${day}/${m}/${y}`;
}

/**
 * Picks the unit price whose quantity x price reproduces the persisted line value (`gross`) to the paisa.
 * The persisted 2-dp InvoiceItem.unitPrice is preferred when it does; otherwise gross/qty at 2 then 3 dp
 * (3 dp is the most the IRP accepts). `drift` is whatever paisa gap remains (0 in the normal case) — reported,
 * never absorbed into the line value, which stays the persisted amount.
 */
function reconcileUnitPrice(gross: number, quantity: number, persisted: number | null): { unitPrice: number; drift: number } {
  const candidates = [persisted, r2(gross / quantity), r3(gross / quantity)].filter((c): c is number => c !== null && Number.isFinite(c));
  for (const c of candidates) if (r2(c * quantity) === gross) return { unitPrice: c, drift: 0 };
  const unitPrice = r3(gross / quantity);
  return { unitPrice, drift: r2(gross - quantity * unitPrice) };
}

/** Splits at the last space within 100 characters; eligibility already caps the whole at 200. */
function splitAddress(raw: string): [string, string | null] {
  const a = raw.trim().replace(/\s+/g, ' ');
  if (a.length <= 100) return [a, null];
  const cut = a.lastIndexOf(' ', 100);
  const at = cut > 0 ? cut : 100;
  return [a.slice(0, at).trim(), a.slice(at).trim() || null];
}

export function buildCanonicalIrnRequest(src: EInvoiceSource): CanonicalIrnRequest {
  const eligibility = evaluateEInvoiceEligibility(src);
  if (!eligibility.technicallyEligible) {
    throw new Error(`Cannot build an IRN request for an ineligible document (${eligibility.blockingReasons.map((r) => r.code).join(', ')})`);
  }
  const { invoice, tax, registration } = src;
  const t = tax!;

  const [sa1, sa2] = splitAddress(t.sellerAddress!);
  const seller: CanonicalIrnParty = {
    gstin: registration.gstin.trim().toUpperCase(),
    legalName: t.sellerLegalName!.trim(),
    tradeName: t.sellerTradeName?.trim() || null,
    addressLine1: sa1, addressLine2: sa2,
    city: t.sellerCity!.trim(), pincode: t.sellerPincode!, stateCode: String(Number(t.sellerStateCode)).padStart(2, '0'),
  };
  const [ba1, ba2] = splitAddress(t.buyerAddress!);
  const buyerGstin = t.buyerGstin!.trim().toUpperCase();
  const buyerStateCode = buyerGstin.slice(0, 2);
  const buyer: CanonicalIrnParty = {
    gstin: buyerGstin,
    legalName: t.buyerName!.trim(),
    tradeName: null,
    addressLine1: ba1, addressLine2: ba2,
    city: t.buyerCity!.trim(), pincode: t.buyerPincode!, stateCode: buyerStateCode,
  };

  const lines: CanonicalIrnLine[] = src.items.map((it, i) => {
    const taxable = r2(num(it.taxableValue));
    const discount = r2(num(it.lineDiscountAmount));
    const gross = r2(taxable + discount);
    const cgst = r2(num(it.cgstAmount)), sgst = r2(num(it.sgstAmount)), igst = r2(num(it.igstAmount));
    const { unitPrice, drift } = reconcileUnitPrice(gross, it.quantity, it.unitPrice === undefined ? null : r2(num(it.unitPrice)));
    return {
      lineNumber: i + 1,
      description: it.description.trim(),
      isService: false,
      hsnCode: it.hsnCode!.trim(),
      quantity: it.quantity,
      uqc: it.uqc!.trim().toUpperCase(),
      unitPrice,
      unitPriceDrift: drift,
      grossAmount: gross,
      discountAmount: discount,
      taxableValue: taxable,
      gstRatePercent: r2(num(it.taxRate) * 100),
      igstAmount: igst, cgstAmount: cgst, sgstAmount: sgst, cessAmount: 0,
      totalAmount: r2(taxable + cgst + sgst + igst),
    };
  });

  const sum = (k: 'taxableValue' | 'cgstAmount' | 'sgstAmount' | 'igstAmount') => r2(lines.reduce((a, l) => a + l[k], 0));
  const igst = sum('igstAmount');
  return {
    documentType: src.documentType,
    documentNumber: invoice.invoiceNumber,
    documentDate: formatDocumentDate(invoice.invoiceDate),
    supplyType: 'B2B',
    reverseCharge: t.reverseCharge,
    igstOnIntra: igst > 0 && seller.stateCode === buyer.stateCode,
    seller, buyer,
    placeOfSupplyStateCode: String(Number(t.placeOfSupply)).padStart(2, '0'),
    currency: 'INR',
    lines,
    totals: {
      taxableValue: sum('taxableValue'), cgst: sum('cgstAmount'), sgst: sum('sgstAmount'), igst, cess: 0,
      otherCharges: r2(num(invoice.otherCharges)), roundOff: r2(num(invoice.roundOff)), invoiceTotal: r2(num(invoice.totalAmount)),
    },
  };
}
