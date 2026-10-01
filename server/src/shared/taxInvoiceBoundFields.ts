import { AppError } from '../middleware/error';

// G1 Part F/G — the whitelist a Tax Invoice Template's bound fields are checked against, enforced
// SERVER-SIDE with a hard throw on anything unrecognized (the tsplGenerator.ts/KNOWN_BOUND_FIELDS
// pattern, not printTagEstimate.ts's silent-empty-string one — see PHASE_G0 audit's research on
// which of the two existing template systems to follow: a statutory document must never let a
// template author bind to, or override, anything beyond exactly these pre-computed values).
//
// This is presentation-only: a template can choose WHETHER/WHERE `seller.gstin` prints and what
// label it carries, but the value itself always comes from TaxInvoicePrintModel — the same
// snapshot sales.service.ts already computed and stored at invoice-creation time. There is no
// bound field, whitelisted or not, that can change what GSTIN or tax amount gets printed.
export const TAX_INVOICE_BOUND_FIELDS = [
  'seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.stateCode', 'seller.address',
  'seller.city', 'seller.district', 'seller.pincode', 'seller.country',
  'branch.name', 'branch.address', 'branch.city', 'branch.phone', 'branch.email',
  'buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state',
  'buyer.stateCode', 'buyer.pincode', 'buyer.phone', 'buyer.email',
  'invoice.number', 'invoice.date', 'invoice.financialYear', 'invoice.type', 'invoice.placeOfSupply',
  'invoice.reverseCharge', 'invoice.terms', 'invoice.salesPerson',
  'totals.subtotal', 'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst',
  'totals.otherCharges', 'totals.discount', 'totals.roundOff', 'totals.grandTotal',
  'payment.paidAmount', 'payment.balanceDue',
  'einvoice.irn', 'einvoice.ackNumber', 'einvoice.ackDate', 'einvoice.qrCodeData',
] as const;
export type TaxInvoiceBoundField = typeof TAX_INVOICE_BOUND_FIELDS[number];

// Item-table column whitelist (Part F "item table" section) — same enforcement, separate list
// since a column is picked from a fixed per-line vocabulary, not the header/footer bound fields above.
export const TAX_INVOICE_ITEM_COLUMNS = [
  'srNo', 'description', 'productCode', 'hsnCode', 'quantity', 'uom', 'grossWeight', 'stoneWeight',
  'netWeight', 'rate', 'makingCharge', 'lineDiscountAmount', 'taxableValue', 'cgstAmount',
  'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalPrice',
] as const;
export type TaxInvoiceItemColumn = typeof TAX_INVOICE_ITEM_COLUMNS[number];

const INR = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE = (v: unknown) => (v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '');

// The only shape a bound field may ever be resolved against — an explicit Pick-style structure
// built by the caller (sales.router.ts) from SalesInvoice + TaxInvoice + Branch, never the raw
// Prisma row. Adding a new bound field means adding it here AND to the whitelist above, never one
// without the other.
export interface TaxInvoicePrintModel {
  seller: { legalName: string | null; tradeName: string | null; gstin: string; stateCode: string | null; address: string | null; city: string | null; district: string | null; pincode: string | null; country: string | null };
  branch: { name: string; address: string | null; city: string | null; phone: string | null; email: string | null };
  buyer: { name: string | null; gstin: string | null; pan: string | null; address: string | null; city: string | null; state: string | null; stateCode: string | null; pincode: string | null; phone: string | null; email: string | null };
  invoice: { number: string; date: string; financialYear: number; type: string; placeOfSupply: string; reverseCharge: boolean; terms: string | null; salesPerson: string | null };
  totals: { subtotal: number; taxableValue: number; cgst: number; sgst: number; igst: number; otherCharges: number; discount: number; roundOff: number; grandTotal: number };
  payment: { paidAmount: number; balanceDue: number };
  einvoice: { irn: string | null; ackNumber: string | null; ackDate: string | null; qrCodeData: string | null };
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

const MONEY_FIELDS = new Set(['totals.subtotal', 'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.otherCharges', 'totals.discount', 'totals.roundOff', 'totals.grandTotal', 'payment.paidAmount', 'payment.balanceDue']);
const DATE_FIELDS = new Set(['invoice.date', 'einvoice.ackDate']);

/** Resolves one bound field against the print model — throws on anything not in the whitelist. */
export function resolveTaxInvoiceBoundField(model: TaxInvoicePrintModel, field: string): string {
  if (!(TAX_INVOICE_BOUND_FIELDS as readonly string[]).includes(field)) {
    throw new AppError(`Unknown tax invoice template bound field: ${field}`, 400);
  }
  const value = get(model, field);
  if (value === null || value === undefined) return '';
  if (field === 'invoice.reverseCharge') return value ? 'Yes' : 'No';
  if (MONEY_FIELDS.has(field)) return INR(value);
  if (DATE_FIELDS.has(field)) return DATE(value);
  return String(value);
}

/** Resolves one item-table column for one line — throws on anything not in the whitelist. */
export function resolveTaxInvoiceItemColumn(item: Record<string, unknown>, index: number, column: string): string {
  if (!(TAX_INVOICE_ITEM_COLUMNS as readonly string[]).includes(column)) {
    throw new AppError(`Unknown tax invoice template item column: ${column}`, 400);
  }
  if (column === 'srNo') return String(index + 1);
  const value = item[column];
  if (value === null || value === undefined) return '';
  const MONEY_COLUMNS = new Set(['rate', 'makingCharge', 'lineDiscountAmount', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalPrice']);
  if (MONEY_COLUMNS.has(column)) return INR(value);
  return String(value);
}
