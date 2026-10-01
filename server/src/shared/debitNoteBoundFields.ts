import { AppError } from '../middleware/error';

// G2e — whitelist of bound fields a Debit Note Template is checked against, enforced SERVER-SIDE
// with a hard throw on anything unrecognized (mirrors creditNoteBoundFields.ts exactly). A Debit
// Note is issued BY this company TO a supplier, so — unlike CreditNoteBoundFields — 'seller.*'
// here is OUR OWN company (the issuer) and 'supplier.*' takes the place of CreditNote's 'buyer.*'
// (the counterparty). No 'branch.*' or 'einvoice.*' sections: purchase has no per-branch GST
// identity and a Debit Note is never itself an e-invoice document on our side (see the schema's
// own DebitNote model comment).
export const DEBIT_NOTE_BOUND_FIELDS = [
  'seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.stateCode', 'seller.address',
  'seller.city', 'seller.district', 'seller.pincode', 'seller.country',
  'supplier.name', 'supplier.gstin', 'supplier.pan', 'supplier.address', 'supplier.city', 'supplier.state',
  'supplier.pincode', 'supplier.phone', 'supplier.email',
  'debitNote.number', 'debitNote.date', 'debitNote.financialYear', 'debitNote.status',
  'debitNote.reasonCode', 'debitNote.reasonNotes',
  'originalGrn.number', 'originalGrn.date',
  'supplierInvoice.number', 'supplierInvoice.date',
  'purchaseReturn.number', 'purchaseReturn.date',
  'totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal',
] as const;
export type DebitNoteBoundField = typeof DEBIT_NOTE_BOUND_FIELDS[number];

// Item-table column whitelist for Debit Note line items — mirrors CreditNoteItemColumn minus
// productCode/quantity (DebitNoteItem has neither field; see schema).
export const DEBIT_NOTE_ITEM_COLUMNS = [
  'srNo', 'description', 'hsnCode', 'uom', 'grossWeight', 'stoneWeight', 'netWeight', 'karat',
  'taxRate', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalValue',
] as const;
export type DebitNoteItemColumn = typeof DEBIT_NOTE_ITEM_COLUMNS[number];

const INR = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE = (v: unknown) => (v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '');

export interface DebitNotePrintModel {
  seller: { legalName: string | null; tradeName: string | null; gstin: string | null; stateCode: string | null; address: string | null; city: string | null; district: string | null; pincode: string | null; country: string | null };
  supplier: { name: string; gstin: string | null; pan: string | null; address: string | null; city: string | null; state: string | null; pincode: string | null; phone: string | null; email: string | null };
  debitNote: { number: string; date: string; financialYear: number; status: string; reasonCode: string; reasonNotes: string | null };
  originalGrn: { number: string; date: string };
  supplierInvoice?: { number: string | null; date: string | null };
  purchaseReturn?: { number: string | null; date: string | null };
  totals: { taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number; grandTotal: number };
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

const MONEY_FIELDS = new Set(['totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal']);
const DATE_FIELDS = new Set(['debitNote.date', 'originalGrn.date', 'supplierInvoice.date', 'purchaseReturn.date']);

/** Resolves one bound field against the print model — throws on anything not in the whitelist. */
export function resolveDebitNoteBoundField(model: DebitNotePrintModel, field: string): string {
  if (!(DEBIT_NOTE_BOUND_FIELDS as readonly string[]).includes(field as any)) {
    throw new AppError(`Unknown debit note template bound field: ${field}`, 400);
  }
  const value = get(model, field);
  if (value === null || value === undefined) return '';
  if (MONEY_FIELDS.has(field)) return INR(value);
  if (DATE_FIELDS.has(field)) return DATE(value);
  return String(value);
}

/** Resolves one item-table column for one line — throws on anything not in the whitelist. */
export function resolveDebitNoteItemColumn(item: Record<string, unknown>, index: number, column: string): string {
  if (!(DEBIT_NOTE_ITEM_COLUMNS as readonly string[]).includes(column as any)) {
    throw new AppError(`Unknown debit note template item column: ${column}`, 400);
  }
  if (column === 'srNo') return String(index + 1);
  const value = item[column];
  if (value === null || value === undefined) return '';
  const MONEY_COLUMNS = new Set(['taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalValue']);
  if (MONEY_COLUMNS.has(column)) return INR(value);
  return String(value);
}
