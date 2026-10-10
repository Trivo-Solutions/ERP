// Pure data layer for the tax invoice template printer: turns a saved invoice (SalesInvoice +
// TaxInvoice snapshot + InvoiceItem lines, as GET /sales/invoices/:id returns it) into every value
// a template's bound fields and tables can show. No DOM, no template knowledge beyond field keys —
// so it is unit-testable in node and the designer/printer can never disagree about a value.
//
// Nothing is computed that the invoice did not already store: seller/buyer come from the immutable
// TaxInvoice snapshot (falling back to the live client only where the snapshot has no column),
// money/tax come from the stored invoice/line columns. The only derivations are presentational
// (sums for display totals, amount in words, the PAN embedded in a GSTIN, a financial-year label).

import { amountInWordsINR } from './amountInWords';
import {
  TaxInvoiceTableKind, TaxInvoiceTableColumn, TAX_INVOICE_FIELD_MAP, columnDef,
} from '../types/taxInvoiceTemplate';

export const INR = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WT = (v: unknown) => Number(v ?? 0).toFixed(3);
const money = (v: unknown, symbol: boolean) => (symbol ? `₹ ${INR(v)}` : INR(v));
const PCT = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

export function formatDMY(v: unknown): string {
  if (!v) return '';
  const d = new Date(v as string);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function formatDMYHM(d: Date): string {
  return `${formatDMY(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Indian financial year label (April–March) for an invoice date: 2026-27.
export function financialYearLabel(v: unknown): string {
  const d = v ? new Date(v as string) : new Date();
  const start = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
  return `${start}-${String(start + 1).slice(-2)}`;
}

export interface InvoiceItemView {
  raw: any;
  qty: number;
  grossWeight: number; // line total (per-piece × quantity)
  stoneWeight: number;
  netWeight: number;
  taxRate: number;     // fraction (0.03)
  hsn: string;
  category: string;
}

export interface InvoiceContext {
  inv: any;
  tax: any;
  client: any;
  branch: any;
  items: InvoiceItemView[];
  isInterState: boolean;
  singleRate: number | null; // the one GST rate every taxed line shares, else null
  totals: {
    subtotal: number; taxableValue: number; cgst: number; sgst: number; igst: number; cess: number;
    totalTax: number; otherCharges: number; discount: number; roundOff: number; grandTotal: number;
    quantity: number; grossWeight: number; netWeight: number; stoneWeight: number;
    makingCharge: number; stoneValue: number; metalValue: number;
  };
  payments: any[];
  copyLabel: string;
}

function n(v: unknown): number { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; }

export function buildInvoiceContext(invoice: any, copyLabel = ''): InvoiceContext {
  const tax = invoice.taxDetails ?? null;
  const rawItems: any[] = invoice.items ?? [];
  const items: InvoiceItemView[] = rawItems.map((it) => {
    const qty = n(it.quantity) || 1;
    return {
      raw: it, qty,
      grossWeight: n(it.grossWeight) * qty,
      stoneWeight: n(it.stoneWeight) * qty,
      netWeight: n(it.netGoldWeight) * qty,
      taxRate: n(it.taxRate),
      hsn: it.hsnCode?.code ?? (typeof it.hsnCode === 'string' ? it.hsnCode : '') ?? '',
      category: it.category?.name ?? 'Uncategorized',
    };
  });
  const cgst = n(tax?.cgst), sgst = n(tax?.sgst), igst = n(tax?.igst);
  const isInterState = igst > 0 || (!!tax && cgst === 0 && sgst === 0 && n(tax?.totalTax) > 0);
  const rates = Array.from(new Set(items.filter((i) => i.taxRate > 0).map((i) => i.taxRate)));
  const totals = {
    subtotal: n(invoice.subtotal),
    taxableValue: tax ? n(tax.taxableAmount) : n(invoice.subtotal) - n(invoice.discountAmount) + n(invoice.otherCharges),
    cgst, sgst, igst, cess: n(tax?.cess),
    totalTax: tax ? n(tax.totalTax) : n(invoice.taxAmount),
    otherCharges: n(invoice.otherCharges), discount: n(invoice.discountAmount),
    roundOff: n(invoice.roundOff), grandTotal: n(invoice.totalAmount),
    quantity: items.reduce((s, i) => s + i.qty, 0),
    grossWeight: items.reduce((s, i) => s + i.grossWeight, 0),
    netWeight: items.reduce((s, i) => s + i.netWeight, 0),
    stoneWeight: items.reduce((s, i) => s + i.stoneWeight, 0),
    makingCharge: items.reduce((s, i) => s + lineSplit(i).mc, 0),
    stoneValue: items.reduce((s, i) => s + lineSplit(i).stone, 0),
    metalValue: items.reduce((s, i) => s + lineSplit(i).metalValue, 0),
  };
  return {
    inv: invoice, tax, client: invoice.client ?? {}, branch: invoice.branch ?? {},
    items, isInterState, singleRate: rates.length === 1 ? rates[0] : null, totals,
    // A reversed payment is not a receipt; a credit settlement (old gold / store credit) is still a payment mode the customer sees.
    payments: (invoice.payments ?? []).filter((p: any) => !p.reversedAt),
    copyLabel,
  };
}

export interface PageInfo { number: number; total: number }

const NO_PAGE: PageInfo = { number: 1, total: 1 };

function joinAddress(parts: unknown[], pin?: unknown, sep = ', '): string {
  const body = parts.map((p) => (p ?? '').toString().trim()).filter(Boolean).join(sep);
  const p = (pin ?? '').toString().trim();
  return p ? (body ? `${body} - ${p}` : p) : body;
}

function paymentSummary(ctx: InvoiceContext): { modes: string; details: string } {
  const byMode = new Map<string, number>();
  for (const p of ctx.payments) byMode.set(p.mode, (byMode.get(p.mode) ?? 0) + n(p.amount));
  const modes = Array.from(byMode.keys()).map((m) => String(m).replace(/_/g, ' ')).join(', ');
  const details = Array.from(byMode.entries()).map(([m, a]) => `${String(m).replace(/_/g, ' ')} ₹ ${INR(a)}`).join('; ');
  return { modes, details };
}

export function resolveField(key: string, ctx: InvoiceContext, page: PageInfo = NO_PAGE, symbol = true): string {
  const { inv, tax, client, branch, totals } = ctx;
  const t = tax ?? {};
  switch (key) {
    case 'seller.legalName': return t.sellerLegalName ?? inv.company?.name ?? '';
    case 'seller.tradeName': return t.sellerTradeName ?? '';
    case 'seller.gstin': return t.gstin ?? '';
    case 'seller.pan': return t.gstin && String(t.gstin).length >= 12 ? String(t.gstin).slice(2, 12) : '';
    case 'seller.stateCode': return t.sellerStateCode ?? '';
    case 'seller.address': return t.sellerAddress ?? '';
    case 'seller.city': return t.sellerCity ?? '';
    case 'seller.district': return t.sellerDistrict ?? '';
    case 'seller.pincode': return t.sellerPincode ?? '';
    case 'seller.country': return t.sellerCountry ?? '';
    case 'seller.fullAddress': return joinAddress([t.sellerAddress, t.sellerCity, t.sellerDistrict], t.sellerPincode);

    case 'branch.name': return branch.name ?? '';
    case 'branch.code': return branch.branchCode ?? '';
    case 'branch.address': return branch.address ?? '';
    case 'branch.city': return branch.city ?? '';
    case 'branch.state': return branch.state ?? '';
    case 'branch.phone': return branch.phone ?? '';
    case 'branch.email': return branch.email ?? '';

    case 'buyer.name': return t.buyerName ?? client.name ?? '';
    case 'buyer.code': return client.clientCode ?? '';
    case 'buyer.gstin': return t.buyerGstin ?? client.gstNumber ?? '';
    case 'buyer.pan': return t.buyerPan ?? client.panNumber ?? '';
    case 'buyer.registrationType': return (t.buyerGstin ?? client.gstNumber) ? 'Registered' : 'Unregistered (B2C)';
    case 'buyer.address': return t.buyerAddress ?? client.address ?? '';
    case 'buyer.city': return t.buyerCity ?? client.city ?? '';
    case 'buyer.district': return client.district ?? '';
    case 'buyer.state': return t.buyerState ?? client.state ?? '';
    case 'buyer.stateCode': return t.buyerStateCode ?? '';
    case 'buyer.pincode': return t.buyerPincode ?? client.pincode ?? '';
    case 'buyer.country': return t.buyerCountry ?? client.country ?? '';
    case 'buyer.phone': return client.phone ?? '';
    case 'buyer.email': return client.email ?? '';
    case 'buyer.fullAddress':
      return joinAddress([t.buyerAddress ?? client.address, t.buyerCity ?? client.city, client.district], t.buyerPincode ?? client.pincode);

    case 'invoice.number': return inv.invoiceNumber ?? '';
    case 'invoice.date': return formatDMY(inv.invoiceDate);
    case 'invoice.dueDate': return formatDMY(inv.dueDate);
    case 'invoice.financialYear': return financialYearLabel(inv.invoiceDate);
    case 'invoice.type': return inv.invoiceType ?? '';
    case 'invoice.status': return inv.status ?? '';
    case 'invoice.currency': return inv.currency ?? 'INR';
    case 'invoice.placeOfSupply': return t.placeOfSupply ?? '';
    case 'invoice.supplyType':
      return tax ? (ctx.isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)') : '';
    case 'invoice.reverseCharge': return tax ? (t.reverseCharge ? 'Yes' : 'No') : '';
    case 'invoice.terms': return inv.terms ?? '';
    case 'invoice.notes': return inv.notes ?? '';
    case 'invoice.salesPerson': return inv.salesPerson?.name ?? '';
    case 'invoice.copyLabel': return ctx.copyLabel;

    case 'einvoice.irn': return t.irn ?? '';
    case 'einvoice.ackNumber': return t.ackNumber ?? '';
    case 'einvoice.ackDate': return formatDMY(t.ackDate);
    case 'ewb.number': return t.ewbNumber ?? '';
    case 'ewb.validUntil': return formatDMY(t.ewbValidUntil);

    case 'totals.subtotal': return money(totals.subtotal, symbol);
    case 'totals.discount': return money(totals.discount, symbol);
    case 'totals.otherCharges': return money(totals.otherCharges, symbol);
    case 'totals.taxableValue': return money(totals.taxableValue, symbol);
    case 'totals.cgst': return money(totals.cgst, symbol);
    case 'totals.sgst': return money(totals.sgst, symbol);
    case 'totals.igst': return money(totals.igst, symbol);
    case 'totals.cess': return money(totals.cess, symbol);
    case 'totals.totalTax': return money(totals.totalTax, symbol);
    case 'totals.cgstRate': return ctx.singleRate != null && !ctx.isInterState ? PCT(ctx.singleRate / 2) : '';
    case 'totals.sgstRate': return ctx.singleRate != null && !ctx.isInterState ? PCT(ctx.singleRate / 2) : '';
    case 'totals.igstRate': return ctx.singleRate != null && ctx.isInterState ? PCT(ctx.singleRate) : '';
    case 'totals.roundOff': return money(totals.roundOff, symbol);
    case 'totals.grandTotal': return money(totals.grandTotal, symbol);
    case 'totals.grandTotalInWords': return amountInWordsINR(totals.grandTotal);
    case 'totals.totalTaxInWords': return amountInWordsINR(totals.totalTax);
    case 'totals.makingCharge': return money(totals.makingCharge, symbol);
    case 'totals.stoneValue': return money(totals.stoneValue, symbol);
    case 'totals.metalValue': return money(totals.metalValue, symbol);
    case 'totals.lineCount': return String(ctx.items.length);
    case 'totals.totalQuantity': return String(totals.quantity);
    case 'totals.totalGrossWeight': return WT(totals.grossWeight);
    case 'totals.totalNetWeight': return WT(totals.netWeight);
    case 'totals.totalStoneWeight': return WT(totals.stoneWeight);

    case 'payment.paidAmount': return money(inv.paidAmount ?? 0, symbol);
    case 'payment.balanceDue': return money(inv.balanceDue ?? inv.totalAmount, symbol);
    case 'payment.status': {
      const due = n(inv.balanceDue ?? inv.totalAmount);
      const paid = n(inv.paidAmount);
      return due <= 0.005 ? 'PAID' : paid > 0.005 ? 'PARTLY PAID' : 'UNPAID';
    }
    case 'payment.modes': return paymentSummary(ctx).modes;
    case 'payment.details': return paymentSummary(ctx).details;

    case 'page.number': return String(page.number);
    case 'page.total': return String(page.total);
    case 'page.label': return `Page ${page.number} of ${page.total}`;
    case 'print.date': return formatDMY(new Date());
    case 'print.dateTime': return formatDMYHM(new Date());
    default: return '';
  }
}

export const KNOWN_FIELD_KEYS = TAX_INVOICE_FIELD_MAP;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

// Replaces every {{field.key}} in a literal text; an unknown key prints nothing (the server
// rejects unknown keys at save time, so this only guards a hand-edited layout).
export function interpolate(text: string, ctx: InvoiceContext, page: PageInfo, symbol: boolean): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => (KNOWN_FIELD_KEYS.has(key) ? resolveField(key, ctx, page, symbol) : ''));
}

export function placeholderKeys(text: string): string[] {
  const out: string[] = [];
  text.replace(PLACEHOLDER, (_m, key: string) => { out.push(key); return ''; });
  return out;
}

// ─── Tables ──────────────────────────────────────────────────────────────────────────────────

export interface TableData {
  header: string[];
  rows: string[][];
  total: string[] | null;
}

interface MaterialRow { code: string; type: string; weight: number; unit: string; pieces: number | null; rate: number | null; amount: number }

function materialsOf(v: InvoiceItemView, stonesOnly: boolean): MaterialRow[] {
  const rows: any[] = v.raw.tag?.materials ?? [];
  return rows
    .filter((m) => !stonesOnly || String(m.materialType).toUpperCase() !== 'METAL')
    .map((m) => {
      const weight = n(m.weight);
      const rate = m.saleRate != null ? n(m.saleRate) : null;
      return {
        code: String(m.code ?? ''), type: String(m.materialType ?? ''), weight, unit: m.unit ?? '', pieces: m.pieces != null ? n(m.pieces) : null,
        rate, amount: m.saleAmount != null ? n(m.saleAmount) : (rate ?? 0) * weight,
      };
    });
}
const joinLines = (xs: string[]) => xs.join('\n');

// How a line splits into metal / making charge (MC) / value addition (VA) / other materials - the one pricing rule: MC = metal
// weight x MC rate, VA = a % of the METAL's value (never of MC or stones). A line billed from a material breakdown (every tagged
// line, estimate lines) carries its own rows + MC/VA rates, so its split is read from there; any other line uses its stored
// per-unit figures. (The stored makingCharge of a breakdown line is MC + VA together, so it is never printed as "MC".)
interface LineSplit { metalValue: number; metalRate: number; mc: number; va: number; vaPercent: number; mcRate: number; stone: number }
function lineSplit(v: InvoiceItemView): LineSplit {
  const it = v.raw;
  const bd = it.materialBreakdown;
  if (bd && Array.isArray(bd.rows)) {
    const metal = bd.rows.filter((r: any) => r.materialType === 'METAL');
    const wt = metal.reduce((s: number, r: any) => s + n(r.weight), 0);
    const metalValue = metal.reduce((s: number, r: any) => s + n(r.weight) * n(r.rate), 0);
    const stone = bd.rows.filter((r: any) => r.materialType !== 'METAL').reduce((s: number, r: any) => s + n(r.weight) * n(r.rate), 0);
    const mcRate = n(bd.mcRate), vaPercent = n(bd.vaPercent);
    return { metalValue, metalRate: wt > 0 ? metalValue / wt : 0, mc: wt * mcRate, va: metalValue * vaPercent / 100, vaPercent, mcRate, stone };
  }
  const flat = it.rateType === 'FIXED';
  const metalValue = flat ? 0 : v.netWeight * n(it.goldRate);
  const mc = n(it.makingCharge) * v.qty;
  const vaPercent = n(it.wastagePercent);
  return { metalValue, metalRate: n(it.goldRate), mc, va: metalValue * vaPercent / 100, vaPercent, mcRate: v.netWeight > 0 ? mc / v.netWeight : 0, stone: n(it.stoneValue) * v.qty };
}
const vaOf = (v: InvoiceItemView) => lineSplit(v).va;

function lineCell(field: string, v: InvoiceItemView, idx: number, ctx: InvoiceContext): string {
  const it = v.raw;
  const cgst = n(it.cgstAmount), sgst = n(it.sgstAmount), igst = n(it.igstAmount);
  const inter = igst > 0;
  switch (field) {
    case 'srNo': return String(idx + 1);
    case 'description': return it.description ?? '';
    case 'descriptionDetail': {
      const sub = [it.productCode, it.huid ? `HUID ${it.huid}` : '', it.karat].filter(Boolean).join(' · ');
      return sub ? `${it.description ?? ''}\n${sub}` : (it.description ?? '');
    }
    case 'productCode': return it.productCode ?? '';
    case 'huid': return it.huid ?? '';
    case 'karat': return it.karat ?? '';
    case 'category': return v.category;
    case 'hsnCode': return v.hsn;
    case 'quantity': return String(v.qty);
    case 'uom': return it.uom ?? it.uqc ?? '';
    case 'grossWeight': return WT(v.grossWeight);
    case 'stoneWeight': return WT(v.stoneWeight);
    case 'netWeight': return WT(v.netWeight);
    case 'rate': return INR(lineSplit(v).metalRate);
    case 'wastagePercent': return lineSplit(v).vaPercent.toFixed(2);
    case 'makingCharge': return INR(lineSplit(v).mc);
    case 'stoneValue': return INR(lineSplit(v).stone);
    case 'unitPrice': return INR(it.unitPrice);
    case 'lineDiscountAmount': return INR(it.lineDiscountAmount);
    case 'taxableValue': return INR(it.taxableValue);
    case 'taxRate': return PCT(v.taxRate);
    case 'cgstRate': return inter ? '' : PCT(v.taxRate / 2);
    case 'cgstAmount': return INR(cgst);
    case 'sgstRate': return inter ? '' : PCT(v.taxRate / 2);
    case 'sgstAmount': return INR(sgst);
    case 'igstRate': return inter ? PCT(v.taxRate) : '';
    case 'igstAmount': return INR(igst);
    case 'lineTotalTax': return INR(it.lineTotalTax);
    case 'totalPrice': return INR(it.totalPrice);
    case 'lineTotalWithTax': return INR(n(it.taxableValue) + n(it.lineTotalTax));
    case 'vaAmount': return INR(vaOf(v));
    case 'makingWithVa': return INR(lineSplit(v).mc + lineSplit(v).va);
    case 'makingRate': return v.netWeight > 0 ? INR(lineSplit(v).mcRate) : '';
    case 'metalValue': return lineSplit(v).metalValue > 0 || it.rateType !== 'FIXED' ? INR(lineSplit(v).metalValue) : '';
    case 'discountPercent': {
      const gross = n(it.totalPrice);
      return gross > 0 && n(it.lineDiscountAmount) > 0 ? n((n(it.lineDiscountAmount) / gross * 100).toFixed(2)).toFixed(2) : '';
    }
    case 'metalType': return it.tag?.metalType ?? '';
    case 'tagName': return it.tag?.name ?? '';
    case 'subCategory': return it.tag?.subCategory?.name ?? '';
    case 'collection': return it.tag?.collection?.name ?? '';
    case 'itemSize': return it.tag?.size?.name ?? '';
    case 'settingType': return it.tag?.settingType ?? '';
    case 'stoneDetails': return joinLines(materialsOf(v, true).map((m) => m.code));
    case 'stoneWeights': return joinLines(materialsOf(v, true).map((m) => WT(m.weight)));
    case 'stonePieces': return joinLines(materialsOf(v, true).map((m) => (m.pieces ? String(m.pieces) : '')));
    case 'stoneRates': return joinLines(materialsOf(v, true).map((m) => (m.rate != null ? INR(m.rate) : '')));
    case 'stoneAmounts': return joinLines(materialsOf(v, true).map((m) => INR(m.amount)));
    case 'materialDetails': return joinLines(materialsOf(v, false).map((m) => m.code));
    case 'materialWeights': return joinLines(materialsOf(v, false).map((m) => WT(m.weight)));
    case 'materialPieces': return joinLines(materialsOf(v, false).map((m) => (m.pieces ? String(m.pieces) : '')));
    case 'materialRates': return joinLines(materialsOf(v, false).map((m) => (m.rate != null ? INR(m.rate) : '')));
    case 'materialAmounts': return joinLines(materialsOf(v, false).map((m) => INR(m.amount)));
    default: return '';
  }
}

// The numeric value a summable items column contributes to the Total row.
function lineNumber(field: string, v: InvoiceItemView): number {
  const it = v.raw;
  switch (field) {
    case 'quantity': return v.qty;
    case 'grossWeight': return v.grossWeight;
    case 'stoneWeight': return v.stoneWeight;
    case 'netWeight': return v.netWeight;
    case 'makingCharge': return lineSplit(v).mc;
    case 'stoneValue': return lineSplit(v).stone;
    case 'unitPrice': return n(it.unitPrice);
    case 'lineDiscountAmount': return n(it.lineDiscountAmount);
    case 'taxableValue': return n(it.taxableValue);
    case 'cgstAmount': return n(it.cgstAmount);
    case 'sgstAmount': return n(it.sgstAmount);
    case 'igstAmount': return n(it.igstAmount);
    case 'lineTotalTax': return n(it.lineTotalTax);
    case 'totalPrice': return n(it.totalPrice);
    case 'lineTotalWithTax': return n(it.taxableValue) + n(it.lineTotalTax);
    case 'vaAmount': return vaOf(v);
    case 'makingWithVa': return lineSplit(v).mc + lineSplit(v).va;
    case 'metalValue': return lineSplit(v).metalValue;
    default: return 0;
  }
}

const WEIGHT_FIELDS = new Set(['grossWeight', 'stoneWeight', 'netWeight']);
const COUNT_FIELDS = new Set(['quantity', 'pieces']);
function fmtSum(field: string, value: number): string {
  if (WEIGHT_FIELDS.has(field)) return WT(value);
  if (COUNT_FIELDS.has(field)) return String(value);
  return INR(value);
}

interface HsnGroup { hsn: string; rate: number; qty: number; net: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number }

function hsnGroups(ctx: InvoiceContext): HsnGroup[] {
  const map = new Map<string, HsnGroup>();
  for (const v of ctx.items) {
    const key = `${v.hsn}|${v.taxRate}`;
    const g = map.get(key) ?? { hsn: v.hsn, rate: v.taxRate, qty: 0, net: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    g.qty += v.qty; g.net += v.netWeight;
    g.taxable += n(v.raw.taxableValue); g.cgst += n(v.raw.cgstAmount); g.sgst += n(v.raw.sgstAmount);
    g.igst += n(v.raw.igstAmount); g.tax += n(v.raw.lineTotalTax);
    map.set(key, g);
  }
  return Array.from(map.values());
}

function hsnCell(field: string, g: HsnGroup): string {
  switch (field) {
    case 'hsnCode': return g.hsn;
    case 'quantity': return String(g.qty);
    case 'netWeight': return WT(g.net);
    case 'taxableValue': return INR(g.taxable);
    case 'taxRate': return PCT(g.rate);
    case 'cgstAmount': return INR(g.cgst);
    case 'sgstAmount': return INR(g.sgst);
    case 'igstAmount': return INR(g.igst);
    case 'totalTax': return INR(g.tax);
    default: return '';
  }
}
function hsnNumber(field: string, g: HsnGroup): number {
  switch (field) {
    case 'quantity': return g.qty; case 'netWeight': return g.net; case 'taxableValue': return g.taxable;
    case 'cgstAmount': return g.cgst; case 'sgstAmount': return g.sgst; case 'igstAmount': return g.igst;
    case 'totalTax': return g.tax; default: return 0;
  }
}

interface CatGroup { name: string; pieces: number; gross: number; net: number; amount: number }
function catGroups(ctx: InvoiceContext): CatGroup[] {
  const map = new Map<string, CatGroup>();
  for (const v of ctx.items) {
    const g = map.get(v.category) ?? { name: v.category, pieces: 0, gross: 0, net: 0, amount: 0 };
    g.pieces += v.qty; g.gross += v.grossWeight; g.net += v.netWeight; g.amount += n(v.raw.totalPrice);
    map.set(v.category, g);
  }
  return Array.from(map.values());
}
function catCell(field: string, g: CatGroup): string {
  switch (field) {
    case 'category': return g.name; case 'pieces': return String(g.pieces);
    case 'grossWeight': return WT(g.gross); case 'netWeight': return WT(g.net); case 'amount': return INR(g.amount);
    default: return '';
  }
}
function catNumber(field: string, g: CatGroup): number {
  switch (field) {
    case 'pieces': return g.pieces; case 'grossWeight': return g.gross; case 'netWeight': return g.net;
    case 'amount': return g.amount; default: return 0;
  }
}

function paymentCell(field: string, p: any): string {
  switch (field) {
    case 'paymentDate': return formatDMY(p.paymentDate);
    case 'mode': return String(p.mode ?? '').replace(/_/g, ' ');
    case 'referenceNo': return p.referenceNo ?? '';
    case 'amount': return INR(p.amount);
    default: return '';
  }
}

export function buildTableData(
  kind: TaxInvoiceTableKind, columns: TaxInvoiceTableColumn[], ctx: InvoiceContext, withTotal: boolean,
): TableData {
  const header = columns.map((c) => c.label);
  let rows: string[][] = [];
  let sums: ((field: string) => number) | null = null;
  const sumOf = <T,>(list: T[], num: (f: string, x: T) => number) => (field: string) => list.reduce((s, x) => s + num(field, x), 0);

  if (kind === 'items') {
    rows = ctx.items.map((v, i) => columns.map((c) => lineCell(c.field, v, i, ctx)));
    sums = sumOf(ctx.items, (f, v) => lineNumber(f, v));
  } else if (kind === 'hsnSummary') {
    const g = hsnGroups(ctx);
    rows = g.map((x) => columns.map((c) => hsnCell(c.field, x)));
    sums = sumOf(g, (f, x) => hsnNumber(f, x));
  } else if (kind === 'categorySummary') {
    const g = catGroups(ctx);
    rows = g.map((x) => columns.map((c) => catCell(c.field, x)));
    sums = sumOf(g, (f, x) => catNumber(f, x));
  } else {
    rows = ctx.payments.map((p) => columns.map((c) => paymentCell(c.field, p)));
    sums = sumOf(ctx.payments, (f, p) => (f === 'amount' ? n(p.amount) : 0));
  }

  let total: string[] | null = null;
  if (withTotal && sums) {
    // The "Total" label goes in the first text column wide enough to hold it, not a narrow Sr column.
    const isSummable = (c: TaxInvoiceTableColumn) => !!columnDef(kind, c.field)?.summable;
    const labelCol = columns.find((c) => !isSummable(c) && c.widthMm >= 14) ?? columns.find((c) => !isSummable(c));
    total = columns.map((c) => {
      if (isSummable(c)) return fmtSum(c.field, sums!(c.field));
      return c === labelCol ? 'Total' : '';
    });
  }
  return { header, rows, total };
}

// Sample data for the designer canvas: one representative line per table kind, taken from the
// column catalog's own sample values.
export function sampleTableRows(kind: TaxInvoiceTableKind, columns: TaxInvoiceTableColumn[], count = 3): string[][] {
  return Array.from({ length: count }, (_x, i) =>
    columns.map((c) => {
      if (c.field === 'srNo') return String(i + 1);
      return columnDef(kind, c.field)?.sample ?? '';
    }));
}

// Representative invoice for the designer's "Preview with sample data".
export function sampleInvoiceForPreview(): any {
  const line = (n: number, desc: string, code: string, net: number, rate: number, making: number) => {
    const unit = net * rate + making;
    const tax = Math.round(unit * 0.03 * 100) / 100;
    return {
      description: desc, productCode: code, huid: `HU${1000 + n}AB`, karat: '22K', quantity: 1,
      grossWeight: net + 0.2, netGoldWeight: net, stoneWeight: 0.2, rateType: 'PER_GRAM', goldRate: rate,
      makingCharge: making, wastagePercent: 8, stoneValue: 0, unitPrice: unit, totalPrice: unit, taxRate: 0.03,
      uom: 'PCS', taxableValue: unit, lineDiscountAmount: 0, cgstAmount: tax / 2, sgstAmount: tax / 2, igstAmount: 0,
      lineTotalTax: tax, hsnCode: { code: '7113' }, category: { name: n % 2 ? 'Rings' : 'Necklaces' },
      tag: {
        name: desc, metalType: 'GOLD', settingType: 'Prong', subCategory: { name: 'Solitaire' }, collection: { name: 'Bridal' }, size: { name: '14' },
        materials: [
          { code: 'GOLD22', materialType: 'METAL', weight: net, unit: 'GM', saleRate: rate, saleAmount: net * rate },
          { code: 'DIA', materialType: 'DIAMOND', weight: 0.25, unit: 'CT', pieces: 3, saleRate: 45000, saleAmount: 11250 },
        ],
      },
    };
  };
  const items = [
    line(1, 'Gold Ring 22K', 'RRNG00001', 8.5, 5800, 2000),
    line(2, 'Gold Necklace 22K', 'RNEC00002', 24.2, 5800, 5500),
    line(3, 'Gold Chain 22K', 'RCHN00003', 12.1, 5800, 2800),
  ];
  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const tax = items.reduce((s, i) => s + i.lineTotalTax, 0);
  const total = Math.round(subtotal + tax);
  return {
    invoiceNumber: 'INV-2026-000123', invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', status: 'PAID',
    currency: 'INR', subtotal, discountAmount: 0, otherCharges: 0, taxAmount: tax, roundOff: total - (subtotal + tax),
    totalAmount: total, paidAmount: total, balanceDue: 0, terms: 'Payment due on receipt', notes: '',
    salesPerson: { name: 'Sample Sales Executive' },
    client: { name: 'Sample Customer', clientCode: 'CL-00042', gstNumber: '27SAMPL1234E1Z9', panNumber: 'SAMPL1234E', address: '45 Sample Lane', city: 'Mumbai', district: 'Mumbai', state: 'Maharashtra', pincode: '400001', phone: '9876543210', email: 'customer@sample.com' },
    branch: { name: 'Main Branch', branchCode: 'BR01', address: '12 Market Road', city: 'Ahmedabad', state: 'Gujarat', phone: '079-12345678', email: 'store@sample.com' },
    taxDetails: {
      gstin: '24SAMPL1234F1Z5', placeOfSupply: '27', reverseCharge: false, taxableAmount: subtotal,
      cgst: tax / 2, sgst: tax / 2, igst: 0, cess: 0, totalTax: tax, irn: null, qrCodeData: null,
      sellerLegalName: 'Sample Jewellers Pvt Ltd', sellerTradeName: 'Sample Jewellers', sellerStateCode: '24',
      sellerAddress: '1 Sample Street, Ring Road', sellerCity: 'Ahmedabad', sellerDistrict: 'Ahmedabad', sellerPincode: '380001', sellerCountry: 'India',
      buyerName: 'Sample Customer', buyerGstin: '27SAMPL1234E1Z9', buyerPan: 'SAMPL1234E', buyerAddress: '45 Sample Lane',
      buyerCity: 'Mumbai', buyerState: 'Maharashtra', buyerStateCode: '27', buyerPincode: '400001', buyerCountry: 'India',
    },
    payments: [{ mode: 'CASH', amount: 20000, paymentDate: new Date().toISOString() }, { mode: 'UPI', amount: total - 20000, paymentDate: new Date().toISOString(), referenceNo: 'UTR123456' }],
    items,
  };
}
