import { JewelryTag, Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';

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
  'tagNumber', 'name', 'metalKarat', 'grossWeight', 'netWeight',
  'stoneWeight', 'huid', 'sellingPrice', 'branchName',
] as const;
export type BoundField = typeof KNOWN_BOUND_FIELDS[number];

export type TagForPrint = Pick<JewelryTag,
  'tagNumber' | 'name' | 'metalKarat' | 'grossWeight' | 'netWeight' | 'stoneWeight' | 'huid' | 'sellingPrice'
> & { branch?: { name: string } | null };

export interface TagTemplateElement {
  id: string;
  wing: 'front' | 'back';
  type: 'text' | 'barcode' | 'qrcode' | 'line' | 'box';
  xMm: number;
  yMm: number;
  widthMm?: number;   // box/line only
  heightMm?: number;  // barcode height, or box/line height
  boundField?: BoundField;
  literalText?: string;
  fontSize?: number;
  rotation?: 0 | 90 | 180 | 270;
  humanReadable?: boolean; // barcode only, defaults true
}

export interface TagTemplateLayout {
  elements: TagTemplateElement[];
}

export interface TagTemplateForPrint {
  widthMm: NumericInput;
  heightMm: NumericInput;
  gapMm: NumericInput;
  layout: TagTemplateLayout;
}

// Throws on an unrecognized field name (a stale/typo'd template shouldn't silently print a blank
// label) but returns '' for a legitimately empty optional value (e.g. no HUID on this piece).
function resolveBoundField(tag: TagForPrint, field: string): string {
  if (!(KNOWN_BOUND_FIELDS as readonly string[]).includes(field)) {
    throw new AppError(`Unknown tag template bound field: ${field}`, 400);
  }
  switch (field as BoundField) {
    case 'tagNumber':    return tag.tagNumber;
    case 'name':          return tag.name;
    case 'metalKarat':    return tag.metalKarat ?? '';
    case 'grossWeight':   return `${Number(tag.grossWeight).toFixed(3)}g`;
    case 'netWeight':     return `${Number(tag.netWeight).toFixed(3)}g`;
    case 'stoneWeight':   return `${Number(tag.stoneWeight).toFixed(3)}ct`;
    case 'huid':          return tag.huid ?? '';
    case 'sellingPrice':  return `Rs.${Number(tag.sellingPrice).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    case 'branchName':    return tag.branch?.name ?? '';
  }
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
      case 'text':    lines.push(textCommand(el, content)); break;
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
