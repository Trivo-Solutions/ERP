import { JewelryTag, Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';
import { resolveTagClassification } from './tagClassification';

// Accepts a Prisma Decimal directly (as read off a TagTemplate row) alongside a plain
// number/string, so callers don't need to pre-convert before calling generateTsplForTag.
type NumericInput = number | string | Prisma.Decimal;

// TSC TTP-244 Pro is a 203 dpi head — TSPL element coordinates are dots, not mm, so every
// template position gets converted here (never stored in dots — mm is what the designer canvas
// and a human editing a template actually think in).
const DOTS_PER_MM = 8;

export function mmToDots(mm: number): number {
  return Math.round(mm * DOTS_PER_MM);
}

const KNOWN_BOUND_FIELDS = [
  'tagNumber', 'name', 'makeType', 'metalType', 'metalKarat',
  'grossWeight', 'netWeight', 'stoneWeight', 'diamondWeight', 'colorStoneWeight', 'stonePieces',
  'huid', 'settingType',
  'categoryName', 'subCategoryName', 'collectionName', 'stockTypeName', 'manufacturerName',
  'categoryCode', 'subCategoryCode', 'collectionCode', 'stockTypeCode',
  'sizeName', 'sizeCode', 'noOfPcs', 'status', 'costMcRate', 'costVaPercent', 'netPurity',
  'sellingPrice', 'saleMcRate', 'saleVaPercent', 'costPrice',
  'notes', 'taggedDate', 'branchName', 'branchCode',
] as const;
export type BoundField = typeof KNOWN_BOUND_FIELDS[number];

type NamedRef = { name: string; code?: string | null } | null | undefined;

// Only the first eight are guaranteed; every other column is optional so a caller that loaded a
// lighter tag (or a test) still type-checks — an absent value just prints as an empty string.
export type TagForPrint = Pick<JewelryTag,
  'tagNumber' | 'name' | 'metalKarat' | 'grossWeight' | 'netWeight' | 'stoneWeight' | 'huid' | 'sellingPrice'
> & Partial<Pick<JewelryTag,
  'makeType' | 'metalType' | 'settingType' | 'costPrice' | 'saleMcRate' | 'saleVaPercent' | 'notes' | 'createdAt'
  | 'noOfPcs' | 'status' | 'costMcRate' | 'costVaPercent'
>> & {
  branch?: { name: string; branchCode?: string | null } | null;
  category?: NamedRef;
  subCategory?: NamedRef;
  collection?: NamedRef;
  stockType?: NamedRef;
  manufacturer?: NamedRef;
  size?: NamedRef;
  materials?: { materialType: string; weight: NumericInput; pieces?: number | null }[];
};

export interface TagTemplateElement {
  id: string;
  wing: 'front' | 'back';
  type: 'text' | 'barcode' | 'qrcode' | 'line' | 'box' | 'image';
  xMm: number;
  yMm: number;
  widthMm?: number;   // box/line only
  heightMm?: number;  // barcode height, or box/line height
  boundField?: BoundField;
  literalText?: string;
  fontSize?: number;  // points (text only); any value, 8 = the legacy default size
  fontFamily?: string; // text only; one of TAG_FONT_FAMILIES, defaults to Arial
  bold?: boolean;
  italic?: boolean;
  imageData?: string; // image only: data:image/(png|jpeg);base64,... (downscaled by the designer)
  rotation?: 0 | 90 | 180 | 270;
  humanReadable?: boolean; // barcode only, defaults true
}

// Fonts the print agent may ask Windows for. A whitelist, not free text: the name is sent to the
// counter PC's GDI, and an unknown face would silently fall back to a different one on print.
export const TAG_FONT_FAMILIES = [
  'Arial', 'Arial Narrow', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma',
  'Georgia', 'Calibri', 'Segoe UI', 'Trebuchet MS', 'Impact', 'Consolas',
] as const;
const MAX_IMAGE_DATA_CHARS = 400_000;
const IMAGE_DATA_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;
const PT_TO_MM = 25.4 / 72;

export interface TagTemplateLayout {
  elements: TagTemplateElement[];
  // Designer-only: where the folded tag creases. The printer ignores it (the whole strip prints in
  // one pass); the designer uses it to split elements into front/back.
  fold?: { orientation: 'none' | 'vertical' | 'horizontal'; positionMm: number };
}

export interface TagTemplateForPrint {
  widthMm: NumericInput;
  heightMm: NumericInput;
  gapMm: NumericInput;
  layout: TagTemplateLayout;
}

const rupees = (v: NumericInput) => `Rs.${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

// Same split the Stock Book uses: DIAMOND rows are diamonds, every other non-metal row counts as
// colour stone (weights already carats).
function stoneTotals(tag: TagForPrint) {
  let dia = 0; let cs = 0; let pieces = 0;
  for (const m of tag.materials ?? []) {
    if (m.materialType === 'METAL') continue;
    if (m.materialType === 'DIAMOND') dia += Number(m.weight); else cs += Number(m.weight);
    pieces += m.pieces ?? 0;
  }
  return { dia, cs, pieces };
}

// Throws on an unrecognized field name (a stale/typo'd template shouldn't silently print a blank
// label) but returns '' for a legitimately empty optional value (e.g. no HUID on this piece).
function resolveBoundField(tag: TagForPrint, field: string): string {
  if (!(KNOWN_BOUND_FIELDS as readonly string[]).includes(field)) {
    throw new AppError(`Unknown tag template bound field: ${field}`, 400);
  }
  switch (field as BoundField) {
    case 'tagNumber':        return tag.tagNumber;
    // Never the stored free-text name on its own: that copy goes stale when a master is renamed. The live
    // sub-category (else category) name; the stored name only for a legacy tag with no classification at all.
    case 'name':             return resolveTagClassification(tag).displayName;
    case 'makeType':         return tag.makeType ?? '';
    case 'metalType':        return tag.metalType ?? '';
    case 'metalKarat':       return tag.metalKarat ?? '';
    case 'grossWeight':      return `${Number(tag.grossWeight).toFixed(3)}g`;
    case 'netWeight':        return `${Number(tag.netWeight).toFixed(3)}g`;
    case 'stoneWeight':      return `${Number(tag.stoneWeight).toFixed(3)}ct`;
    case 'diamondWeight':    return `${stoneTotals(tag).dia.toFixed(3)}ct`;
    case 'colorStoneWeight': return `${stoneTotals(tag).cs.toFixed(3)}ct`;
    case 'stonePieces':      return String(stoneTotals(tag).pieces);
    case 'huid':             return tag.huid ?? '';
    case 'settingType':      return tag.settingType ?? '';
    case 'categoryName':     return tag.category?.name ?? '';
    case 'subCategoryName':  return tag.subCategory?.name ?? '';
    case 'collectionName':   return tag.collection?.name ?? '';
    case 'stockTypeName':    return tag.stockType?.name ?? '';
    case 'manufacturerName': return tag.manufacturer?.name ?? '';
    case 'sellingPrice':     return rupees(tag.sellingPrice);
    case 'saleMcRate':       return tag.saleMcRate == null ? '' : `${Number(tag.saleMcRate).toFixed(2)}/g`;
    case 'saleVaPercent':    return tag.saleVaPercent == null ? '' : `${Number(tag.saleVaPercent).toFixed(2)}%`;
    case 'costPrice':        return tag.costPrice == null ? '' : rupees(tag.costPrice);
    case 'notes':            return tag.notes ?? '';
    case 'taggedDate':       return tag.createdAt ? tag.createdAt.toLocaleDateString('en-GB').replace(/\//g, '-') : '';
    case 'branchName':       return tag.branch?.name ?? '';
    case 'branchCode':       return tag.branch?.branchCode ?? '';
    case 'categoryCode':     return tag.category?.code ?? '';
    case 'subCategoryCode':  return tag.subCategory?.code ?? '';
    case 'collectionCode':   return tag.collection?.code ?? '';
    case 'stockTypeCode':    return tag.stockType?.code ?? '';
    case 'sizeName':         return tag.size?.name ?? '';
    case 'sizeCode':         return tag.size?.code ?? '';
    case 'noOfPcs':          return tag.noOfPcs == null ? '' : String(tag.noOfPcs);
    case 'status':           return tag.status ?? '';
    case 'costMcRate':       return tag.costMcRate == null ? '' : `${Number(tag.costMcRate).toFixed(2)}/g`;
    case 'costVaPercent':    return tag.costVaPercent == null ? '' : `${Number(tag.costVaPercent).toFixed(2)}%`;
    case 'netPurity':        return tag.metalKarat ? `${tag.metalKarat} / ${Number(tag.netWeight).toFixed(3)}g` : `${Number(tag.netWeight).toFixed(3)}g`;
  }
}

// Every bound field resolved for one tag, for the designer's on-screen preview — the same strings
// the printed label would carry, so the preview can't drift from what generateTsplForTag emits.
export function resolveAllBoundFields(tag: TagForPrint): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of KNOWN_BOUND_FIELDS) out[f] = resolveBoundField(tag, f);
  return out;
}

// TSPL has no escape sequence for a literal double-quote inside a quoted string — the safe move
// is to drop it rather than let it terminate the command early and corrupt everything after it.
function escapeTspl(text: string): string {
  return text.replace(/"/g, "'");
}

function elementContent(el: TagTemplateElement, tag: TagForPrint): string {
  if (el.boundField) return resolveBoundField(tag, el.boundField);
  return el.literalText ?? '';
}

// The agent prints through the Windows driver, which can draw any installed font at any size; a
// printer that is sent this program raw ignores the REM line and falls back to the TEXT command's
// built-in font below. REM is TSPL's own comment command, so the program stays valid either way.
function textExtension(el: TagTemplateElement): string {
  const family = (TAG_FONT_FAMILIES as readonly string[]).includes(el.fontFamily ?? '') ? el.fontFamily : 'Arial';
  const sizeMm = Math.max(0.5, Number(el.fontSize ?? 8)) * PT_TO_MM;
  return `REM TRIVO-TEXT ${JSON.stringify({ font: family, bold: !!el.bold, italic: !!el.italic, sizeMm: Math.round(sizeMm * 100) / 100 })}`;
}

function imageCommand(el: TagTemplateElement): string | null {
  const m = IMAGE_DATA_RE.exec(el.imageData ?? '');
  if (!m || (el.imageData as string).length > MAX_IMAGE_DATA_CHARS) {
    throw new AppError('Tag template image is missing, not a PNG/JPEG, or too large', 400);
  }
  return `REM TRIVO-IMG ${JSON.stringify({
    x: mmToDots(el.xMm), y: mmToDots(el.yMm),
    w: mmToDots(el.widthMm ?? 10), h: mmToDots(el.heightMm ?? 10),
    rot: el.rotation ?? 0, data: m[2],
  })}`;
}

function textCommand(el: TagTemplateElement, content: string): string {
  // TSPL's built-in fonts are indexed, not point-sized — approximate an arbitrary fontSize as an
  // integer magnification of the standard "3" font's 8pt baseline (TSPL rejects fractional/zero
  // multipliers).
  const mult = Math.max(1, Math.round((el.fontSize ?? 8) / 8));
  return `TEXT ${mmToDots(el.xMm)},${mmToDots(el.yMm)},"3",${el.rotation ?? 0},${mult},${mult},"${escapeTspl(content)}"`;
}

function barcodeCommand(el: TagTemplateElement, content: string): string {
  const heightDots = mmToDots(el.heightMm ?? 10);
  const readable = el.humanReadable === false ? 0 : 1;
  return `BARCODE ${mmToDots(el.xMm)},${mmToDots(el.yMm)},"128",${heightDots},${readable},${el.rotation ?? 0},2,2,"${escapeTspl(content)}"`;
}

function qrcodeCommand(el: TagTemplateElement, content: string): string {
  return `QRCODE ${mmToDots(el.xMm)},${mmToDots(el.yMm)},M,4,A,${el.rotation ?? 0},"${escapeTspl(content)}"`;
}

function boxCommand(el: TagTemplateElement): string {
  const x1 = mmToDots(el.xMm);
  const y1 = mmToDots(el.yMm);
  const x2 = x1 + mmToDots(el.widthMm ?? 10);
  const y2 = y1 + mmToDots(el.heightMm ?? 10);
  return `BOX ${x1},${y1},${x2},${y2},2`;
}

function lineCommand(el: TagTemplateElement): string {
  return `BAR ${mmToDots(el.xMm)},${mmToDots(el.yMm)},${mmToDots(el.widthMm ?? 10)},${mmToDots(el.heightMm ?? 0.3)}`;
}

// The hardest-part function: template + real tag in, exact TSPL program out. `wing` is purely an
// organizational label on each element (which half of the physical strip it belongs to, so the
// Stage 3 designer can show a front/back tab) — both wings print in one program, at their own Y
// offsets on the same SIZE, because folding a printed strip in half needs no TSPL of its own.
export function generateTsplForTag(template: TagTemplateForPrint, tag: TagForPrint): string {
  const lines: string[] = [
    `SIZE ${Number(template.widthMm)} mm,${Number(template.heightMm)} mm`,
    `GAP ${Number(template.gapMm)} mm,0 mm`,
    'DIRECTION 1',
    'CLS',
  ];

  for (const el of template.layout.elements ?? []) {
    const content = elementContent(el, tag);
    switch (el.type) {
      case 'text':    lines.push(textExtension(el), textCommand(el, content)); break;
      case 'image':   lines.push(imageCommand(el) as string); break;
      case 'barcode': lines.push(barcodeCommand(el, content)); break;
      case 'qrcode':  lines.push(qrcodeCommand(el, content)); break;
      case 'box':     lines.push(boxCommand(el)); break;
      case 'line':    lines.push(lineCommand(el)); break;
      default:        throw new AppError(`Unknown tag template element type: ${(el as TagTemplateElement).type}`, 400);
    }
  }

  lines.push('PRINT 1,1');
  return lines.join('\r\n') + '\r\n';
}
