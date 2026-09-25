// Shared between EstimateTemplateDesignerPage.tsx (builds/edits this shape) and
// printTagEstimate.ts (renders it) — kept in one place so the two can never drift apart on what a
// saved template's `layout` JSON actually contains. Sale-side only, matching the rest of the
// Estimation module: there is no cost-data bound field or column to pick, by design.

export type EstimateBoundField =
  | 'tagNumber' | 'itemName' | 'metalKarat' | 'grossWeight' | 'netWeight' | 'stoneWeight'
  | 'branchName' | 'estimateNumber' | 'generatedOn' | 'validUntil'
  | 'totalSaleAmount' | 'makingChargeAmount' | 'saleMcRate' | 'saleVaPercent'
  | 'taxRate' | 'gstAmount' | 'netPayableAmount'
  | 'huid' | 'metalType' | 'makeType' | 'mrp' | 'notes' | 'currency' | 'printDate';

export type EstimateTextAlign = 'left' | 'center' | 'right';

// Every element positions the same way — xMm/yMm from the page's top-left, period. There used to
// be a separate header/body/footer "band" concept where footer elements measured yMm from the
// BOTTOM instead, so a footer would stay glued to the page's bottom edge regardless of how tall
// the body above it grew. Removed: with a materials table that might be one row or ten, and other
// elements placed below it too, a second positioning system just added a mode to keep track of —
// one coordinate system, always measured from the top, is simpler to reason about.

// materialsTable-only. 'bottomOnly' (default, matches every template saved before this existed) —
// a thin rule under the header and under each row, the old hardcoded look. 'all' — a full ruled
// grid, every cell boxed.
export type EstimateTableBorderStyle = 'bottomOnly' | 'all';

export type EstimateElementType = 'text' | 'box' | 'line' | 'materialsTable' | 'barcode' | 'image';

export type EstimateTableColumnField = 'name' | 'weight' | 'unit' | 'saleRate' | 'saleAmount';

export interface EstimateTableColumn {
  field: EstimateTableColumnField;
  label: string;
  widthMm: number;
  // Overrides the table's own headerFontSize/rowFontSize for this one column (both header label and
  // row values) — lets a tight column (e.g. Amount) shrink to fit its own width without shrinking
  // every other column along with it. Unset = inherit the table-wide size, same as every column on
  // a template saved before this existed.
  fontSize?: number;
}

export interface EstimateTemplateElement {
  id: string;
  type: EstimateElementType;
  xMm: number;
  yMm: number;
  widthMm?: number;
  heightMm?: number;
  boundField?: EstimateBoundField;
  literalText?: string;
  // text-only — in points (pt), the same physical unit Microsoft Word uses (1pt = 1/72in, fixed),
  // not CSS px. Every other size on this template is already a physical unit (mm) — px was the
  // odd one out, and being a screen-oriented unit rather than a true physical one, it's also what
  // let the on-screen preview's measured text height drift from the printed page's real height.
  fontSize?: number;
  // text-only — only visibly does anything once Wrap Width is set (an unset, auto width box has
  // nothing to align within). Omitted = 'left', matching every template saved before this existed.
  align?: EstimateTextAlign;
  // materialsTable-only — a repeating region, not a fixed element: row count follows however many
  // items the estimate actually has (rendered as a normal HTML table, so rows size themselves).
  // The element's own widthMm is never hand-edited for a table — it's kept in lockstep with
  // sum(columns[].widthMm) by the designer (see EstimateTemplateDesignerPage's toggleColumn/
  // updateColumn), and the print/preview renderers recompute it from columns too rather than
  // trusting a possibly-stale stored value. That's what keeps the on-canvas footprint and the
  // printed footprint from drifting apart.
  columns?: EstimateTableColumn[];
  // materialsTable-only — in points (pt), same convention as the text element's fontSize. Every
  // template saved before this existed gets the old hardcoded look via the ?? defaults in
  // printTagEstimate.ts/EstimateTemplateDesignerPage.tsx (8pt header / 9pt row, bottomOnly borders).
  headerFontSize?: number;
  rowFontSize?: number;
  borderStyle?: EstimateTableBorderStyle;
  // materialsTable-only — appends two more rows after the real material lines: "MC" (making
  // charge, Rate shown as a ₹/g rate, same estimate.saleMcRate the Estimation page already lets
  // staff edit, itself defaulted from whatever was decided at tagging time) and "VA" (value
  // addition/wastage, Rate shown as a %, from estimate.saleVaPercent). Replaces binding a separate
  // text element to those fields — the numbers live where the other material lines already are,
  // in the same Rate/Amount shape, instead of floating elsewhere on the page. Unset/false on every
  // template saved before this existed.
  includeChargeRows?: boolean;
  // barcode-only — which bound field's raw value to encode (in practice tagNumber or
  // estimateNumber; not restricted to those since any short code-like field is a valid choice) and
  // whether to print the value as text underneath.
  humanReadable?: boolean;
  // image-only — a data: URI embedded directly in the template's own layout JSON (e.g. a company
  // logo). No upload/storage backend: the browser reads the picked file locally (FileReader) and
  // the resulting data URI becomes part of the saved template, same self-contained-blob approach
  // as everything else in `layout`.
  imageDataUrl?: string;
}

export interface EstimateTemplateLayout {
  elements: EstimateTemplateElement[];
}

// 1pt = 1/72in = 25.4/72mm exactly, by the CSS/print spec — used anywhere a font size (pt) needs
// converting to the mm-based geometry the rest of a template is designed in (the canvas preview's
// on-screen scale).
export const MM_PER_PT = 25.4 / 72;

// Common Microsoft Word point sizes, offered as a <datalist> so the Font Size field autocompletes
// the same way Word's own size box does while still accepting any custom value typed in.
export const COMMON_FONT_SIZES_PT = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 72];

// Not fixed to A4 — paper size is per-template (EstimateTemplate.widthMm/heightMm), since the
// actual target may be a narrow continuous-roll thermal/receipt printer (e.g. an Epson POS unit)
// rather than a sheet-fed printer. These are only the starting values for a brand-new template.
export const DEFAULT_TEMPLATE_WIDTH_MM = 80;
export const DEFAULT_TEMPLATE_HEIGHT_MM = 200;

export const BOUND_FIELD_OPTIONS: { value: EstimateBoundField; label: string }[] = [
  { value: 'tagNumber', label: 'Tag Number' },
  { value: 'itemName', label: 'Item Code (Category)' },
  { value: 'metalKarat', label: 'Metal Karat' },
  { value: 'grossWeight', label: 'Gross Weight' },
  { value: 'netWeight', label: 'Net Weight' },
  { value: 'stoneWeight', label: 'Stone Weight' },
  { value: 'branchName', label: 'Branch Name' },
  { value: 'estimateNumber', label: 'Estimate Number' },
  { value: 'generatedOn', label: 'Generated On' },
  { value: 'validUntil', label: 'Valid Until' },
  { value: 'totalSaleAmount', label: 'Total Estimate Amount' },
  { value: 'makingChargeAmount', label: 'Making Charge Amount' },
  { value: 'saleMcRate', label: 'MC Rate' },
  { value: 'saleVaPercent', label: 'VA %' },
  { value: 'taxRate', label: 'GST Rate' },
  { value: 'gstAmount', label: 'GST Amount' },
  { value: 'netPayableAmount', label: 'Net Payable' },
  { value: 'huid', label: 'HUID' },
  { value: 'metalType', label: 'Metal Type' },
  { value: 'makeType', label: 'Make Type' },
  { value: 'mrp', label: 'MRP (Tag Listed Price)' },
  { value: 'notes', label: 'Notes' },
  { value: 'currency', label: 'Currency' },
  { value: 'printDate', label: "Print Date (today's date)" },
];

// Shared by the print renderer (a real date) and the designer canvas (a sample date placeholder)
// so the two can never show two different date formats again — dd/mm/yy, not a spelled-out month,
// for every date-bound field (Generated On, Valid Until, Print Date).
export function formatEstimateDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = new Date(d);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// The single source of truth for a materialsTable element's rendered width — always the sum of
// its own columns, never a separately stored/edited number. Used by both the designer canvas and
// the print renderer so the two can never disagree about how wide the table really is, even for a
// template saved before columns could drift out of sync with a stale widthMm.
export function computeTableWidthMm(columns: EstimateTableColumn[] | undefined, fallbackMm = 180): number {
  if (!columns || columns.length === 0) return fallbackMm;
  return columns.reduce((s, c) => s + c.widthMm, 0);
}

export const ALL_TABLE_COLUMNS: { field: EstimateTableColumnField; defaultLabel: string; defaultWidthMm: number }[] = [
  { field: 'name', defaultLabel: 'Item', defaultWidthMm: 60 },
  { field: 'weight', defaultLabel: 'Weight', defaultWidthMm: 30 },
  { field: 'unit', defaultLabel: 'Unit', defaultWidthMm: 20 },
  { field: 'saleRate', defaultLabel: 'Rate', defaultWidthMm: 35 },
  { field: 'saleAmount', defaultLabel: 'Amount', defaultWidthMm: 35 },
];
