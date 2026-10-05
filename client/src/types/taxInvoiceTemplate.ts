// Shared between TaxInvoiceTemplateDesignerPage.tsx (builds/edits this shape) and
// printTaxInvoiceTemplate.ts (renders it) — one place, so what the designer saves and what the
// printer reads can never drift apart. Same free-form canvas idea as EstimateTemplate/TagTemplate
// (every element positioned in mm from the page's top-left), extended for what a statutory GST
// tax invoice needs that a tag estimate does not: several repeating tables (items, HSN-wise tax
// summary, category summary, payments), amount in words, e-invoice IRN + QR, multiple copies
// (Original / Duplicate / Triplicate) and multi-page flow.
//
// Presentation only (G1 Part G): a template chooses WHAT prints, WHERE and under what label. Every
// value comes from the invoice's own immutable snapshot (SalesInvoice + TaxInvoice + InvoiceItem);
// nothing here can compute or override a GSTIN, a rate or a tax amount. The server independently
// whitelists every key below at save time (server/src/shared/taxInvoiceBoundFields.ts) — keep the
// two lists identical.

export type TaxInvoiceElementType =
  | 'text' | 'box' | 'line' | 'image' | 'barcode' | 'qrcode' | 'table';

export type TaxInvoiceTableKind = 'items' | 'hsnSummary' | 'categorySummary' | 'payments';

export type TaxInvoiceTextAlign = 'left' | 'center' | 'right';
export type TaxInvoiceTableBorderStyle = 'bottomOnly' | 'all' | 'none';

export interface TaxInvoiceTableColumn {
  field: string;
  label: string;
  widthMm: number;
  fontSize?: number;
  align?: TaxInvoiceTextAlign;
}

export interface TaxInvoiceTemplateElement {
  id: string;
  type: TaxInvoiceElementType;
  xMm: number;
  yMm: number;
  widthMm?: number;
  heightMm?: number;
  // text: a single bound field, OR literalText which may embed {{field.key}} placeholders
  // ("CGST @ {{totals.cgstRate}} : {{totals.cgst}}") so a label and its value share one box.
  // barcode: the bound field whose raw value is encoded. qrcode: ignored (always the e-invoice QR).
  boundField?: string;
  literalText?: string;
  fontSize?: number;           // pt
  align?: TaxInvoiceTextAlign;
  bold?: boolean;
  italic?: boolean;
  uppercase?: boolean;
  color?: string;              // text colour (#rrggbb)
  fillColor?: string;          // box background (#rrggbb)
  noCurrencySymbol?: boolean;  // text: print money without the leading ₹
  hideIfEmpty?: boolean;       // text: print nothing when every {{field}} in it is blank
  // Print on every page of a multi-page invoice, not only the first (header band, page footer).
  repeatOnEveryPage?: boolean;
  // table-only
  tableKind?: TaxInvoiceTableKind;
  columns?: TaxInvoiceTableColumn[];
  headerFontSize?: number;
  rowFontSize?: number;
  borderStyle?: TaxInvoiceTableBorderStyle;
  headerFill?: boolean;        // shaded header row
  showTotalRow?: boolean;      // closing row summing the numeric columns
  // barcode-only
  humanReadable?: boolean;
  // image-only — data: URI embedded in the layout (company logo, signature, stamp)
  imageDataUrl?: string;
}

export interface TaxInvoiceDesignerLayout {
  page: { widthMm: number; heightMm: number };
  // One full pass of the invoice is printed per entry, with `invoice.copyLabel` set to it, e.g.
  // ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']. Empty/
  // omitted = a single, unlabelled copy.
  copies?: string[];
  elements: TaxInvoiceTemplateElement[];
}

export const DEFAULT_PAGE_WIDTH_MM = 210;
export const DEFAULT_PAGE_HEIGHT_MM = 297;
// Bottom margin kept clear when rows flow onto a further page.
export const PAGE_BOTTOM_MARGIN_MM = 8;
export const MM_PER_PT = 25.4 / 72;
export const COMMON_FONT_SIZES_PT = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36];

export function isDesignerLayout(layout: any): layout is TaxInvoiceDesignerLayout {
  return !!layout && Array.isArray(layout.elements);
}

// ─── Bound fields ────────────────────────────────────────────────────────────────────────────

export interface TaxInvoiceFieldDef {
  key: string;
  label: string;
  group: string;
  sample: string;
}

const G = {
  seller: 'Seller / Company',
  branch: 'Branch',
  buyer: 'Buyer / Customer',
  invoice: 'Invoice Details',
  einv: 'e-Invoice & e-Way Bill',
  totals: 'Totals & Tax',
  weights: 'Weights & Quantity Totals',
  payment: 'Payment',
  page: 'Page & Print',
} as const;

export const TAX_INVOICE_FIELDS: TaxInvoiceFieldDef[] = [
  { key: 'seller.legalName', label: 'Seller Legal Name', group: G.seller, sample: 'Sample Jewellers Pvt Ltd' },
  { key: 'seller.tradeName', label: 'Seller Trade Name', group: G.seller, sample: 'Sample Jewellers' },
  { key: 'seller.gstin', label: 'Seller GSTIN', group: G.seller, sample: '24SAMPL1234F1Z5' },
  { key: 'seller.pan', label: 'Seller PAN (from GSTIN)', group: G.seller, sample: 'SAMPL1234F' },
  { key: 'seller.stateCode', label: 'Seller State Code', group: G.seller, sample: '24' },
  { key: 'seller.address', label: 'Seller Address', group: G.seller, sample: '1 Sample Street, Ring Road' },
  { key: 'seller.city', label: 'Seller City', group: G.seller, sample: 'Ahmedabad' },
  { key: 'seller.district', label: 'Seller District', group: G.seller, sample: 'Ahmedabad' },
  { key: 'seller.pincode', label: 'Seller PIN Code', group: G.seller, sample: '380001' },
  { key: 'seller.country', label: 'Seller Country', group: G.seller, sample: 'India' },
  { key: 'seller.fullAddress', label: 'Seller Full Address (one block)', group: G.seller, sample: '1 Sample Street, Ring Road, Ahmedabad - 380001' },

  { key: 'branch.name', label: 'Branch Name', group: G.branch, sample: 'Main Branch' },
  { key: 'branch.code', label: 'Branch Code', group: G.branch, sample: 'BR01' },
  { key: 'branch.address', label: 'Branch Address', group: G.branch, sample: '12 Market Road' },
  { key: 'branch.city', label: 'Branch City', group: G.branch, sample: 'Ahmedabad' },
  { key: 'branch.state', label: 'Branch State', group: G.branch, sample: 'Gujarat' },
  { key: 'branch.phone', label: 'Branch Phone', group: G.branch, sample: '079-12345678' },
  { key: 'branch.email', label: 'Branch Email', group: G.branch, sample: 'store@sample.com' },

  { key: 'buyer.name', label: 'Buyer Name', group: G.buyer, sample: 'Sample Customer' },
  { key: 'buyer.code', label: 'Customer Code', group: G.buyer, sample: 'CL-00042' },
  { key: 'buyer.gstin', label: 'Buyer GSTIN', group: G.buyer, sample: '27SAMPL1234E1Z9' },
  { key: 'buyer.pan', label: 'Buyer PAN', group: G.buyer, sample: 'SAMPL1234E' },
  { key: 'buyer.registrationType', label: 'Registration Type (Registered / Unregistered)', group: G.buyer, sample: 'Registered' },
  { key: 'buyer.address', label: 'Buyer Address', group: G.buyer, sample: '45 Sample Lane' },
  { key: 'buyer.city', label: 'Buyer City', group: G.buyer, sample: 'Mumbai' },
  { key: 'buyer.district', label: 'Buyer District', group: G.buyer, sample: 'Mumbai' },
  { key: 'buyer.state', label: 'Buyer State', group: G.buyer, sample: 'Maharashtra' },
  { key: 'buyer.stateCode', label: 'Buyer State Code', group: G.buyer, sample: '27' },
  { key: 'buyer.pincode', label: 'Buyer PIN Code', group: G.buyer, sample: '400001' },
  { key: 'buyer.country', label: 'Buyer Country', group: G.buyer, sample: 'India' },
  { key: 'buyer.phone', label: 'Buyer Mobile', group: G.buyer, sample: '9876543210' },
  { key: 'buyer.email', label: 'Buyer Email', group: G.buyer, sample: 'customer@sample.com' },
  { key: 'buyer.fullAddress', label: 'Buyer Full Address (one block)', group: G.buyer, sample: '45 Sample Lane, Mumbai - 400001' },

  { key: 'invoice.number', label: 'Invoice Number', group: G.invoice, sample: 'INV-2026-000123' },
  { key: 'invoice.date', label: 'Invoice Date', group: G.invoice, sample: '05/10/2026' },
  { key: 'invoice.dueDate', label: 'Due Date', group: G.invoice, sample: '20/10/2026' },
  { key: 'invoice.financialYear', label: 'Financial Year', group: G.invoice, sample: '2026-27' },
  { key: 'invoice.type', label: 'Invoice Type (Retail / Wholesale)', group: G.invoice, sample: 'RETAIL' },
  { key: 'invoice.status', label: 'Invoice Status', group: G.invoice, sample: 'PAID' },
  { key: 'invoice.currency', label: 'Currency', group: G.invoice, sample: 'INR' },
  { key: 'invoice.placeOfSupply', label: 'Place of Supply (state code)', group: G.invoice, sample: '27' },
  { key: 'invoice.supplyType', label: 'Supply Type (Intra / Inter-State)', group: G.invoice, sample: 'Intra-State (CGST + SGST)' },
  { key: 'invoice.reverseCharge', label: 'Reverse Charge (Yes / No)', group: G.invoice, sample: 'No' },
  { key: 'invoice.terms', label: 'Terms (entered on the bill)', group: G.invoice, sample: 'Payment due on receipt' },
  { key: 'invoice.notes', label: 'Notes (entered on the bill)', group: G.invoice, sample: 'Thank you for your business' },
  { key: 'invoice.salesPerson', label: 'Sales Executive', group: G.invoice, sample: 'Ravi Kumar' },
  { key: 'invoice.copyLabel', label: 'Copy Label (Original / Duplicate…)', group: G.invoice, sample: 'ORIGINAL FOR RECIPIENT' },

  { key: 'einvoice.irn', label: 'e-Invoice IRN', group: G.einv, sample: 'a1b2c3d4e5f6…64-char IRN' },
  { key: 'einvoice.ackNumber', label: 'e-Invoice Ack No.', group: G.einv, sample: '112010012345678' },
  { key: 'einvoice.ackDate', label: 'e-Invoice Ack Date', group: G.einv, sample: '05/10/2026' },
  { key: 'ewb.number', label: 'e-Way Bill No.', group: G.einv, sample: '281012345678' },
  { key: 'ewb.validUntil', label: 'e-Way Bill Valid Until', group: G.einv, sample: '07/10/2026' },

  { key: 'totals.subtotal', label: 'Sub-total (lines, before discount)', group: G.totals, sample: '₹ 50,000.00' },
  { key: 'totals.discount', label: 'Discount', group: G.totals, sample: '₹ 500.00' },
  { key: 'totals.otherCharges', label: 'Shipping / Other Charges', group: G.totals, sample: '₹ 100.00' },
  { key: 'totals.taxableValue', label: 'Total Taxable Value', group: G.totals, sample: '₹ 49,500.00' },
  { key: 'totals.cgst', label: 'Total CGST', group: G.totals, sample: '₹ 742.50' },
  { key: 'totals.sgst', label: 'Total SGST', group: G.totals, sample: '₹ 742.50' },
  { key: 'totals.igst', label: 'Total IGST', group: G.totals, sample: '₹ 0.00' },
  { key: 'totals.cess', label: 'Total Cess', group: G.totals, sample: '₹ 0.00' },
  { key: 'totals.totalTax', label: 'Total GST', group: G.totals, sample: '₹ 1,485.00' },
  { key: 'totals.cgstRate', label: 'CGST Rate (when one rate)', group: G.totals, sample: '1.5%' },
  { key: 'totals.sgstRate', label: 'SGST Rate (when one rate)', group: G.totals, sample: '1.5%' },
  { key: 'totals.igstRate', label: 'IGST Rate (when one rate)', group: G.totals, sample: '3%' },
  { key: 'totals.roundOff', label: 'Round Off', group: G.totals, sample: '₹ 0.50' },
  { key: 'totals.grandTotal', label: 'Grand Total', group: G.totals, sample: '₹ 50,985.50' },
  { key: 'totals.grandTotalInWords', label: 'Grand Total in Words', group: G.totals, sample: 'Rupees Fifty Thousand Nine Hundred Eighty Five and Fifty Paise Only' },
  { key: 'totals.totalTaxInWords', label: 'Total GST in Words', group: G.totals, sample: 'Rupees One Thousand Four Hundred Eighty Five Only' },
  { key: 'totals.makingCharge', label: 'Total Making Charges', group: G.totals, sample: '₹ 2,000.00' },
  { key: 'totals.stoneValue', label: 'Total Stone Value', group: G.totals, sample: '₹ 0.00' },
  { key: 'totals.metalValue', label: 'Total Metal Value', group: G.totals, sample: '₹ 49,300.00' },

  { key: 'totals.lineCount', label: 'Number of Line Items', group: G.weights, sample: '3' },
  { key: 'totals.totalQuantity', label: 'Total Pieces', group: G.weights, sample: '4' },
  { key: 'totals.totalGrossWeight', label: 'Total Gross Weight (g)', group: G.weights, sample: '42.500' },
  { key: 'totals.totalNetWeight', label: 'Total Net Weight (g)', group: G.weights, sample: '40.000' },
  { key: 'totals.totalStoneWeight', label: 'Total Stone Weight', group: G.weights, sample: '2.500' },

  { key: 'payment.paidAmount', label: 'Amount Paid', group: G.payment, sample: '₹ 50,985.50' },
  { key: 'payment.balanceDue', label: 'Balance Due', group: G.payment, sample: '₹ 0.00' },
  { key: 'payment.status', label: 'Payment Status (Paid / Part / Unpaid)', group: G.payment, sample: 'PAID' },
  { key: 'payment.modes', label: 'Payment Modes (Cash, UPI…)', group: G.payment, sample: 'Cash, UPI' },
  { key: 'payment.details', label: 'Payment Breakdown (mode: amount)', group: G.payment, sample: 'Cash ₹ 20,000.00; UPI ₹ 30,985.50' },

  { key: 'page.number', label: 'Page Number', group: G.page, sample: '1' },
  { key: 'page.total', label: 'Total Pages', group: G.page, sample: '1' },
  { key: 'page.label', label: 'Page X of Y', group: G.page, sample: 'Page 1 of 1' },
  { key: 'print.date', label: 'Print Date', group: G.page, sample: '05/10/2026' },
  { key: 'print.dateTime', label: 'Print Date & Time', group: G.page, sample: '05/10/2026 14:32' },
];

export const TAX_INVOICE_FIELD_MAP = new Map(TAX_INVOICE_FIELDS.map((f) => [f.key, f]));

export function taxInvoiceFieldGroups(): { label: string; fields: TaxInvoiceFieldDef[] }[] {
  const out: { label: string; fields: TaxInvoiceFieldDef[] }[] = [];
  for (const f of TAX_INVOICE_FIELDS) {
    let g = out.find((x) => x.label === f.group);
    if (!g) { g = { label: f.group, fields: [] }; out.push(g); }
    g.fields.push(f);
  }
  return out;
}

// ─── Tables ──────────────────────────────────────────────────────────────────────────────────

export interface TaxInvoiceColumnDef {
  field: string;
  label: string;
  widthMm: number;
  align: TaxInvoiceTextAlign;
  sample: string;
  // Summed on the table's optional closing Total row.
  summable?: boolean;
}

export const TABLE_KIND_OPTIONS: { value: TaxInvoiceTableKind; label: string }[] = [
  { value: 'items', label: 'Item lines (the invoice body — flows across pages)' },
  { value: 'hsnSummary', label: 'HSN-wise tax summary' },
  { value: 'categorySummary', label: 'Category-wise summary' },
  { value: 'payments', label: 'Payments received' },
];

export const TABLE_COLUMN_CATALOG: Record<TaxInvoiceTableKind, TaxInvoiceColumnDef[]> = {
  items: [
    { field: 'srNo', label: 'Sr', widthMm: 8, align: 'center', sample: '1' },
    { field: 'description', label: 'Description of Goods', widthMm: 48, align: 'left', sample: 'Gold Ring 22K' },
    { field: 'descriptionDetail', label: 'Description (with Tag / HUID / Karat)', widthMm: 56, align: 'left', sample: 'Gold Ring 22K\nRRNG00001 · HUID AB12CD34 · 22K' },
    { field: 'productCode', label: 'Tag No.', widthMm: 20, align: 'left', sample: 'RRNG00001' },
    { field: 'huid', label: 'HUID', widthMm: 18, align: 'left', sample: 'AB12CD34' },
    { field: 'karat', label: 'Karat', widthMm: 11, align: 'center', sample: '22K' },
    { field: 'category', label: 'Category', widthMm: 20, align: 'left', sample: 'Rings' },
    { field: 'hsnCode', label: 'HSN', widthMm: 14, align: 'center', sample: '7113' },
    { field: 'quantity', label: 'Qty', widthMm: 9, align: 'right', sample: '1', summable: true },
    { field: 'uom', label: 'UQC', widthMm: 10, align: 'center', sample: 'PCS' },
    { field: 'grossWeight', label: 'Gross Wt', widthMm: 16, align: 'right', sample: '8.500', summable: true },
    { field: 'stoneWeight', label: 'Stone Wt', widthMm: 14, align: 'right', sample: '0.000', summable: true },
    { field: 'netWeight', label: 'Net Wt', widthMm: 16, align: 'right', sample: '8.500', summable: true },
    { field: 'rate', label: 'Rate / g', widthMm: 17, align: 'right', sample: '5,800.00' },
    { field: 'wastagePercent', label: 'VA %', widthMm: 12, align: 'right', sample: '8.00' },
    { field: 'makingCharge', label: 'Making', widthMm: 17, align: 'right', sample: '2,000.00', summable: true },
    { field: 'stoneValue', label: 'Stone Value', widthMm: 17, align: 'right', sample: '0.00', summable: true },
    { field: 'unitPrice', label: 'Value', widthMm: 20, align: 'right', sample: '51,300.00', summable: true },
    { field: 'lineDiscountAmount', label: 'Discount', widthMm: 16, align: 'right', sample: '500.00', summable: true },
    { field: 'taxableValue', label: 'Taxable Value', widthMm: 22, align: 'right', sample: '49,500.00', summable: true },
    { field: 'taxRate', label: 'GST %', widthMm: 11, align: 'right', sample: '3%' },
    { field: 'cgstRate', label: 'CGST %', widthMm: 11, align: 'right', sample: '1.5%' },
    { field: 'cgstAmount', label: 'CGST', widthMm: 16, align: 'right', sample: '742.50', summable: true },
    { field: 'sgstRate', label: 'SGST %', widthMm: 11, align: 'right', sample: '1.5%' },
    { field: 'sgstAmount', label: 'SGST', widthMm: 16, align: 'right', sample: '742.50', summable: true },
    { field: 'igstRate', label: 'IGST %', widthMm: 11, align: 'right', sample: '3%' },
    { field: 'igstAmount', label: 'IGST', widthMm: 16, align: 'right', sample: '0.00', summable: true },
    { field: 'lineTotalTax', label: 'Total Tax', widthMm: 16, align: 'right', sample: '1,485.00', summable: true },
    { field: 'totalPrice', label: 'Amount', widthMm: 22, align: 'right', sample: '50,985.00', summable: true },
    { field: 'vaAmount', label: 'VA Amount', widthMm: 17, align: 'right', sample: '160.00', summable: true },
    { field: 'makingWithVa', label: 'Making + VA', widthMm: 19, align: 'right', sample: '2,160.00', summable: true },
    { field: 'makingRate', label: 'MC / g', widthMm: 14, align: 'right', sample: '235.29' },
    { field: 'metalValue', label: 'Metal Value', widthMm: 20, align: 'right', sample: '49,300.00', summable: true },
    { field: 'discountPercent', label: 'Disc %', widthMm: 11, align: 'right', sample: '1.00' },
    { field: 'metalType', label: 'Metal', widthMm: 14, align: 'left', sample: 'GOLD' },
    { field: 'tagName', label: 'Item Name', widthMm: 28, align: 'left', sample: 'Bridal Ring' },
    { field: 'subCategory', label: 'Sub-category', widthMm: 20, align: 'left', sample: 'Solitaire' },
    { field: 'collection', label: 'Collection', widthMm: 20, align: 'left', sample: 'Bridal' },
    { field: 'itemSize', label: 'Size', widthMm: 12, align: 'center', sample: '14' },
    { field: 'settingType', label: 'Setting', widthMm: 16, align: 'left', sample: 'Prong' },
    { field: 'stoneDetails', label: 'Stone', widthMm: 20, align: 'left', sample: 'DIA\nRUB' },
    { field: 'stoneWeights', label: 'Stone Wt', widthMm: 16, align: 'right', sample: '0.250\n0.400' },
    { field: 'stonePieces', label: 'Stone Pcs', widthMm: 12, align: 'right', sample: '3\n1' },
    { field: 'stoneRates', label: 'Stone Rate', widthMm: 20, align: 'right', sample: '45,000.00\n12,000.00' },
    { field: 'stoneAmounts', label: 'Stone Amount', widthMm: 20, align: 'right', sample: '11,250.00\n4,800.00' },
    { field: 'materialDetails', label: 'Material (metal + stones)', widthMm: 24, align: 'left', sample: 'GOLD22\nDIA' },
    { field: 'materialWeights', label: 'Material Wt', widthMm: 16, align: 'right', sample: '8.500\n0.250' },
    { field: 'materialPieces', label: 'Material Pcs', widthMm: 13, align: 'right', sample: '\n3' },
    { field: 'materialRates', label: 'Material Rate', widthMm: 20, align: 'right', sample: '5,800.00\n45,000.00' },
    { field: 'materialAmounts', label: 'Material Amount', widthMm: 22, align: 'right', sample: '49,300.00\n11,250.00' },
    { field: 'lineTotalWithTax', label: 'Amount incl. GST', widthMm: 24, align: 'right', sample: '50,985.00', summable: true },
  ],
  hsnSummary: [
    { field: 'hsnCode', label: 'HSN / SAC', widthMm: 24, align: 'left', sample: '7113' },
    { field: 'quantity', label: 'Qty', widthMm: 14, align: 'right', sample: '4', summable: true },
    { field: 'netWeight', label: 'Net Wt', widthMm: 20, align: 'right', sample: '40.000', summable: true },
    { field: 'taxableValue', label: 'Taxable Value', widthMm: 28, align: 'right', sample: '49,500.00', summable: true },
    { field: 'taxRate', label: 'GST %', widthMm: 14, align: 'right', sample: '3%' },
    { field: 'cgstAmount', label: 'CGST', widthMm: 22, align: 'right', sample: '742.50', summable: true },
    { field: 'sgstAmount', label: 'SGST', widthMm: 22, align: 'right', sample: '742.50', summable: true },
    { field: 'igstAmount', label: 'IGST', widthMm: 22, align: 'right', sample: '0.00', summable: true },
    { field: 'totalTax', label: 'Total Tax', widthMm: 24, align: 'right', sample: '1,485.00', summable: true },
  ],
  categorySummary: [
    { field: 'category', label: 'Category', widthMm: 50, align: 'left', sample: 'Rings' },
    { field: 'pieces', label: 'Pieces', widthMm: 18, align: 'right', sample: '4', summable: true },
    { field: 'grossWeight', label: 'Gross Wt (g)', widthMm: 24, align: 'right', sample: '42.500', summable: true },
    { field: 'netWeight', label: 'Net Wt (g)', widthMm: 24, align: 'right', sample: '40.000', summable: true },
    { field: 'amount', label: 'Amount', widthMm: 30, align: 'right', sample: '50,985.00', summable: true },
  ],
  payments: [
    { field: 'paymentDate', label: 'Date', widthMm: 24, align: 'left', sample: '05/10/2026' },
    { field: 'mode', label: 'Mode', widthMm: 26, align: 'left', sample: 'UPI' },
    { field: 'referenceNo', label: 'Reference', widthMm: 40, align: 'left', sample: 'UTR123456' },
    { field: 'amount', label: 'Amount', widthMm: 30, align: 'right', sample: '30,985.50', summable: true },
  ],
};

export function columnDef(kind: TaxInvoiceTableKind, field: string): TaxInvoiceColumnDef | undefined {
  return TABLE_COLUMN_CATALOG[kind].find((c) => c.field === field);
}

export function computeTableWidthMm(columns: TaxInvoiceTableColumn[] | undefined, fallbackMm = 190): number {
  if (!columns || columns.length === 0) return fallbackMm;
  return columns.reduce((s, c) => s + c.widthMm, 0);
}

export function defaultColumns(kind: TaxInvoiceTableKind, fields: string[]): TaxInvoiceTableColumn[] {
  return fields.map((f) => {
    const d = columnDef(kind, f)!;
    return { field: f, label: d.label, widthMm: d.widthMm, align: d.align };
  });
}

// Scales a column set so its widths sum to targetMm (kept to 0.5mm so the sum stays exact-ish).
export function scaleColumnsTo(columns: TaxInvoiceTableColumn[], targetMm: number): TaxInvoiceTableColumn[] {
  const cur = computeTableWidthMm(columns);
  if (!columns.length || cur <= 0 || targetMm <= 0) return columns;
  const k = targetMm / cur;
  return columns.map((c) => ({ ...c, widthMm: Math.max(6, Math.round(c.widthMm * k * 2) / 2) }));
}

// ─── Standard layout ─────────────────────────────────────────────────────────────────────────

let seq = 0;
const nid = () => `el_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function text(xMm: number, yMm: number, literalText: string, o: Partial<TaxInvoiceTemplateElement> = {}): TaxInvoiceTemplateElement {
  return { id: nid(), type: 'text', xMm, yMm, literalText, fontSize: 9, ...o };
}
function bound(xMm: number, yMm: number, boundField: string, o: Partial<TaxInvoiceTemplateElement> = {}): TaxInvoiceTemplateElement {
  return { id: nid(), type: 'text', xMm, yMm, boundField, fontSize: 9, ...o };
}
function box(xMm: number, yMm: number, widthMm: number, heightMm: number, o: Partial<TaxInvoiceTemplateElement> = {}): TaxInvoiceTemplateElement {
  return { id: nid(), type: 'box', xMm, yMm, widthMm, heightMm, ...o };
}
function line(xMm: number, yMm: number, widthMm: number, heightMm = 0.3): TaxInvoiceTemplateElement {
  return { id: nid(), type: 'line', xMm, yMm, widthMm, heightMm };
}

// A complete, ready-to-print A4 GST tax invoice — the designer's starting point ("Load Standard
// Layout") so nobody has to assemble the statutory minimum from a blank canvas. Everything on it is
// an ordinary element and can be moved, restyled or deleted.
export function buildStandardLayout(opts: { title?: string; itemFields?: string[] } = {}): TaxInvoiceDesignerLayout {
  const title = opts.title || 'TAX INVOICE';
  const itemFields = opts.itemFields?.length ? opts.itemFields
    : ['srNo', 'descriptionDetail', 'hsnCode', 'quantity', 'netWeight', 'rate', 'makingCharge', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalPrice'];
  const W = 210;
  const items = defaultColumns('items', itemFields);
  const hsn = defaultColumns('hsnSummary', ['hsnCode', 'taxableValue', 'taxRate', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalTax']);

  const elements: TaxInvoiceTemplateElement[] = [
    // page frame
    box(5, 5, W - 10, 287, { repeatOnEveryPage: true }),

    // header band
    bound(8, 8, 'seller.legalName', { fontSize: 15, bold: true, widthMm: 130, repeatOnEveryPage: true }),
    bound(8, 15, 'seller.fullAddress', { fontSize: 8.5, widthMm: 130, repeatOnEveryPage: true }),
    text(8, 24, 'GSTIN: {{seller.gstin}}   PAN: {{seller.pan}}   State Code: {{seller.stateCode}}', { fontSize: 8.5, bold: true, widthMm: 130, repeatOnEveryPage: true }),
    text(8, 29, 'Phone: {{branch.phone}}   Email: {{branch.email}}', { fontSize: 8, widthMm: 130, repeatOnEveryPage: true }),
    text(140, 8, title, { fontSize: 14, bold: true, align: 'right', widthMm: 62, repeatOnEveryPage: true }),
    bound(140, 15, 'invoice.copyLabel', { fontSize: 7.5, align: 'right', widthMm: 62, repeatOnEveryPage: true }),
    { id: nid(), type: 'qrcode', xMm: 180, yMm: 19, widthMm: 22, heightMm: 22 },
    line(5, 36, W - 10),

    // buyer / invoice block
    text(8, 38, 'Bill To', { fontSize: 8, bold: true, uppercase: true, color: '#555555' }),
    bound(8, 42.5, 'buyer.name', { fontSize: 10.5, bold: true, widthMm: 95 }),
    bound(8, 48, 'buyer.fullAddress', { fontSize: 8.5, widthMm: 95 }),
    text(8, 58, 'GSTIN: {{buyer.gstin}}   PAN: {{buyer.pan}}', { fontSize: 8.5, widthMm: 95 }),
    text(8, 63, 'State: {{buyer.state}} ({{buyer.stateCode}})   Mobile: {{buyer.phone}}', { fontSize: 8.5, widthMm: 95 }),
    box(105, 36, 0.3, 32),
    text(108, 38.5, 'Invoice No.: {{invoice.number}}', { fontSize: 9.5, bold: true, widthMm: 94 }),
    text(108, 44, 'Date: {{invoice.date}}', { fontSize: 9, widthMm: 94 }),
    text(108, 49, 'Place of Supply: {{invoice.placeOfSupply}}   Reverse Charge: {{invoice.reverseCharge}}', { fontSize: 8.5, widthMm: 94 }),
    text(108, 54, 'Supply: {{invoice.supplyType}}', { fontSize: 8.5, widthMm: 94 }),
    text(108, 59, 'Sales Executive: {{invoice.salesPerson}}', { fontSize: 8.5, widthMm: 94 }),
    text(108, 64, 'IRN: {{einvoice.irn}}', { fontSize: 6.5, widthMm: 72, hideIfEmpty: true }),
    line(5, 68.5, W - 10),

    // items
    {
      id: nid(), type: 'table', tableKind: 'items', xMm: 5, yMm: 69, heightMm: 112,
      widthMm: computeTableWidthMm(scaleColumnsTo(items, W - 10)), columns: scaleColumnsTo(items, W - 10),
      headerFontSize: 7.5, rowFontSize: 8, borderStyle: 'all', headerFill: true, showTotalRow: true,
    },

    // below the items: totals block
    line(5, 183, W - 10),
    text(8, 185, 'Total in words:', { fontSize: 8, bold: true }),
    bound(8, 189.5, 'totals.grandTotalInWords', { fontSize: 8.5, widthMm: 100 }),
    text(8, 200, 'Payment: {{payment.details}}', { fontSize: 8, widthMm: 100 }),

    text(112, 185, 'Taxable Value', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 185, 'totals.taxableValue', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 190, 'Discount', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 190, 'totals.discount', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 195, 'Shipping / Other', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 195, 'totals.otherCharges', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 200, 'CGST', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 200, 'totals.cgst', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 205, 'SGST', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 205, 'totals.sgst', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 210, 'IGST', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 210, 'totals.igst', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 215, 'Round Off', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 215, 'totals.roundOff', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    line(110, 220, 92),
    text(112, 222, 'Grand Total', { fontSize: 11, bold: true, widthMm: 52 }),
    bound(150, 222, 'totals.grandTotal', { fontSize: 11, bold: true, align: 'right', widthMm: 50 }),
    text(112, 229, 'Paid', { fontSize: 8.5, widthMm: 52 }),
    bound(160, 229, 'payment.paidAmount', { fontSize: 8.5, align: 'right', widthMm: 40 }),
    text(112, 234, 'Balance Due', { fontSize: 8.5, bold: true, widthMm: 52 }),
    bound(160, 234, 'payment.balanceDue', { fontSize: 8.5, bold: true, align: 'right', widthMm: 40 }),

    // HSN-wise tax summary
    {
      id: nid(), type: 'table', tableKind: 'hsnSummary', xMm: 8, yMm: 206, heightMm: 28,
      widthMm: computeTableWidthMm(scaleColumnsTo(hsn, 98)), columns: scaleColumnsTo(hsn, 98),
      headerFontSize: 6.5, rowFontSize: 7, borderStyle: 'all', headerFill: true, showTotalRow: true,
    },

    // footer
    line(5, 252, W - 10),
    text(8, 254, 'Terms & Conditions', { fontSize: 8, bold: true }),
    text(8, 258.5, '1. Goods once sold will not be taken back or exchanged.\n2. All disputes are subject to local jurisdiction only.\n3. Hallmarked jewellery as per BIS norms; HUID as mentioned.', { fontSize: 7.5, widthMm: 110 }),
    text(8, 276, 'Bank: <your bank name>   A/c No.: <account number>   IFSC: <ifsc>', { fontSize: 7.5, widthMm: 130 }),
    text(125, 254, 'For {{seller.legalName}}', { fontSize: 9, bold: true, align: 'right', widthMm: 75 }),
    text(125, 280, 'Authorised Signatory', { fontSize: 8.5, align: 'right', widthMm: 75 }),
    bound(8, 288, 'page.label', { fontSize: 7, color: '#666666', repeatOnEveryPage: true }),
    text(125, 288, 'This is a computer generated invoice', { fontSize: 7, align: 'right', widthMm: 75, color: '#666666', repeatOnEveryPage: true }),
  ];

  return { page: { widthMm: W, heightMm: 297 }, copies: [], elements };
}

// Common alternative paper presets for the designer.
export const PAGE_PRESETS: { label: string; widthMm: number; heightMm: number }[] = [
  { label: 'A4 portrait (210 × 297)', widthMm: 210, heightMm: 297 },
  { label: 'A4 landscape (297 × 210)', widthMm: 297, heightMm: 210 },
  { label: 'A5 portrait (148 × 210)', widthMm: 148, heightMm: 210 },
  { label: 'A5 landscape (210 × 148)', widthMm: 210, heightMm: 148 },
  { label: 'Letter (216 × 279)', widthMm: 216, heightMm: 279 },
  { label: 'Thermal roll 80 mm (80 × 200)', widthMm: 80, heightMm: 200 },
];
