import { AppError } from '../middleware/error';

// G2d — whitelist of bound fields a Credit Note Template is checked against, enforced
// SERVER-SIDE with a hard throw on anything unrecognized (mirrors taxInvoiceBoundFields.ts).
export const CREDIT_NOTE_BOUND_FIELDS = [
  'seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.stateCode', 'seller.address',
  'seller.city', 'seller.district', 'seller.pincode', 'seller.country',
  'branch.name', 'branch.address', 'branch.city', 'branch.phone', 'branch.email',
  'buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state',
  'buyer.stateCode', 'buyer.pincode', 'buyer.phone', 'buyer.email',
  'creditNote.number', 'creditNote.date', 'creditNote.financialYear', 'creditNote.status',
  'creditNote.placeOfSupply', 'creditNote.reasonCode', 'creditNote.reasonNotes',
  'originalInvoice.number', 'originalInvoice.date', 'originalInvoice.placeOfSupply',
  'salesReturn.number', 'salesReturn.date',
  'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal',
  'einvoice.irn', 'einvoice.ackNumber', 'einvoice.ackDate', 'einvoice.qrCodeData',
] as const;
export type CreditNoteBoundField = typeof CREDIT_NOTE_BOUND_FIELDS[number];

// Item-table column whitelist for Credit Note line items
export const CREDIT_NOTE_ITEM_COLUMNS = [
  'srNo', 'description', 'productCode', 'hsnCode', 'quantity', 'uom', 'grossWeight', 'stoneWeight',
  'netWeight', 'karat', 'taxRate', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount',
  'lineTotalTax', 'totalValue',
] as const;
export type CreditNoteItemColumn = typeof CREDIT_NOTE_ITEM_COLUMNS[number];

const INR = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE = (v: unknown) => (v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '');

export interface CreditNotePrintModel {
  seller: { legalName: string | null; tradeName: string | null; gstin: string; stateCode: string | null; address: string | null; city: string | null; district: string | null; pincode: string | null; country: string | null };
  branch?: { name: string; address: string | null; city: string | null; phone: string | null; email: string | null };
  buyer: { name: string | null; gstin: string | null; pan: string | null; address: string | null; city: string | null; state: string | null; stateCode: string | null; pincode: string | null; phone: string | null; email: string | null };
  creditNote: { number: string; date: string; financialYear: number; status: string; placeOfSupply: string; reasonCode: string; reasonNotes: string | null };
  originalInvoice: { number: string; date: string; placeOfSupply?: string };
  salesReturn?: { number: string | null; date: string | null };
  totals: { taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number; grandTotal: number };
  einvoice?: { irn: string | null; ackNumber: string | null; ackDate: string | null; qrCodeData: string | null };
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

const MONEY_FIELDS = new Set(['totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal']);
const DATE_FIELDS = new Set(['creditNote.date', 'originalInvoice.date', 'salesReturn.date', 'einvoice.ackDate']);

/** Resolves one bound field against the print model — throws on anything not in the whitelist. */
export function resolveCreditNoteBoundField(model: CreditNotePrintModel, field: string): string {
  if (!(CREDIT_NOTE_BOUND_FIELDS as readonly string[]).includes(field as any)) {
    throw new AppError(`Unknown credit note template bound field: ${field}`, 400);
  }
  const value = get(model, field);
  if (value === null || value === undefined) return '';
  if (MONEY_FIELDS.has(field)) return INR(value);
  if (DATE_FIELDS.has(field)) return DATE(value);
  return String(value);
}

/** Resolves one item-table column for one line — throws on anything not in the whitelist. */
export function resolveCreditNoteItemColumn(item: Record<string, unknown>, index: number, column: string): string {
  if (!(CREDIT_NOTE_ITEM_COLUMNS as readonly string[]).includes(column as any)) {
    throw new AppError(`Unknown credit note template item column: ${column}`, 400);
  }
  if (column === 'srNo') return String(index + 1);
  const value = item[column];
  if (value === null || value === undefined) return '';
  const MONEY_COLUMNS = new Set(['taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalValue']);
  if (MONEY_COLUMNS.has(column)) return INR(value);
  return String(value);
}
