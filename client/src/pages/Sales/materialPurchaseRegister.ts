import type { CsvColumn } from '../../utils/exportToCsv';

// Pure helpers for the Material Purchase register. Every figure shown or exported is the server's stored value —
// nothing here recalculates fine weight, rates or purchase value.

// Only materials the server actually values today. Silver/Platinum/Other stay out until their valuation is defined.
export const SUPPORTED_MATERIALS = [{ value: 'GOLD', label: 'Gold' }];
export const materialLabel = (t?: string | null) => SUPPORTED_MATERIALS.find((m) => m.value === t)?.label ?? t ?? '—';

export interface RegisterFilters {
  from: string; to: string; clientId: string; metalType: string; branchId: string; exchangeNumber: string; createdById: string;
}
export const EMPTY_FILTERS: RegisterFilters = { from: '', to: '', clientId: '', metalType: '', branchId: '', exchangeNumber: '', createdById: '' };

/** Query params for GET /sales/material-purchases — blanks are dropped; `to` covers the whole chosen day. */
export function buildListParams(f: RegisterFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.from) p.from = new Date(`${f.from}T00:00:00`).toISOString();
  if (f.to) p.to = new Date(`${f.to}T23:59:59.999`).toISOString();
  if (f.clientId) p.clientId = f.clientId;
  if (f.metalType) p.metalType = f.metalType;
  if (f.branchId) p.branchId = f.branchId;
  if (f.exchangeNumber.trim()) p.exchangeNumber = f.exchangeNumber.trim();
  if (f.createdById) p.createdById = f.createdById;
  return p;
}

const dt = (v: any) => (v ? new Date(v).toLocaleString('en-IN') : '');

export const creditLabel = (x: any) => (x.reversedAt ? 'Reversed' : null);

/** All register fields (not only the visible columns) for the CSV export. */
export const MATERIAL_PURCHASE_CSV_COLUMNS: CsvColumn<any>[] = [
  { header: 'Purchase No.', value: (x) => x.exchangeNumber ?? '' },
  { header: 'Date & Time', value: (x) => dt(x.createdAt ?? x.exchangeDate) },
  { header: 'Customer Code', value: (x) => x.client?.clientCode ?? '' },
  { header: 'Customer', value: (x) => x.client?.name ?? '' },
  { header: 'Branch', value: (x) => x.branch?.name ?? '' },
  { header: 'Material', value: (x) => materialLabel(x.metalType) },
  { header: 'Description', value: (x) => x.description ?? '' },
  { header: 'Gross Weight (g)', value: (x) => Number(x.grossWeight).toFixed(3) },
  { header: 'Tested Purity %', value: (x) => Number(x.testedPurityPercent).toFixed(2) },
  { header: 'Fine Weight (g)', value: (x) => Number(x.fineWeight).toFixed(4) },
  { header: '24K Old Gold Rate', value: (x) => Number(x.baseRate24K).toFixed(2) },
  { header: 'Effective Rate', value: (x) => Number(x.effectivePurchaseRate).toFixed(2) },
  { header: 'Purchase Value', value: (x) => Number(x.valuedAmount).toFixed(2) },
  { header: 'Store Credit', value: (x) => Number(x.creditCreated ?? x.valuedAmount).toFixed(2) },
  { header: 'Status', value: (x) => (x.reversedAt ? 'Reversed' : 'Completed') },
  { header: 'Reversed At', value: (x) => dt(x.reversedAt) },
  { header: 'Reversal Reason', value: (x) => x.reversalReason ?? '' },
  { header: 'Notes', value: (x) => x.notes ?? '' },
  { header: 'Created By', value: (x) => x.createdByName ?? '' },
];

const money = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Label/value pairs for the read-only details view. */
export function purchaseDetailItems(x: any): [string, string][] {
  return [
    ['Purchase No.', x.exchangeNumber],
    ['Date & Time', dt(x.createdAt ?? x.exchangeDate)],
    ['Customer', `${x.client?.clientCode ? x.client.clientCode + ' — ' : ''}${x.client?.name ?? ''}`],
    ['Branch', x.branch?.name ?? '—'],
    ['Material', materialLabel(x.metalType)],
    ['Gross Weight', `${Number(x.grossWeight).toFixed(3)} g`],
    ['Tested Purity', `${Number(x.testedPurityPercent).toFixed(2)}%`],
    ['Fine Weight', `${Number(x.fineWeight).toFixed(4)} g`],
    ['24K Old Gold Rate', `${money(Number(x.baseRate24K))} /g`],
    ['Effective Rate', `${money(Number(x.effectivePurchaseRate))} /g`],
    ['Purchase Value', money(Number(x.valuedAmount))],
    ['Store Credit', money(Number(x.creditCreated ?? x.valuedAmount))],
    ['Created By', x.createdByName ?? '—'],
    ...(x.description ? [['Description', x.description] as [string, string]] : []),
    ...(x.notes ? [['Notes', x.notes] as [string, string]] : []),
  ];
}
