// Interprets the small TSPL subset server/src/shared/tsplGenerator.ts emits (SIZE, GAP, DIRECTION,
// CLS, TEXT, BARCODE 128, QRCODE, BOX, BAR, PRINT) into a drawing model. Coordinates stay in dots
// (203 dpi, 8 dots/mm) exactly as the generator wrote them; conversion to mm happens at draw time.
export const DOTS_PER_MM = 8;

export type DrawItem =
  | { type: 'text'; x: number; y: number; rot: number; mult: number; text: string }
  | { type: 'barcode'; x: number; y: number; rot: number; height: number; readable: boolean; narrow: number; text: string }
  | { type: 'qrcode'; x: number; y: number; rot: number; cell: number; text: string }
  | { type: 'box'; x1: number; y1: number; x2: number; y2: number; thick: number }
  | { type: 'bar'; x: number; y: number; w: number; h: number };

export interface ParsedLabel {
  widthMm: number;
  heightMm: number;
  copies: number;
  items: DrawItem[];
}

const num = (s: string) => Number(s.trim());

export function parseTspl(tspl: string): ParsedLabel {
  const label: ParsedLabel = { widthMm: 0, heightMm: 0, copies: 1, items: [] };
  for (const raw of tspl.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^SIZE\s+([\d.]+)\s*mm\s*,\s*([\d.]+)\s*mm/i))) {
      label.widthMm = num(m[1]); label.heightMm = num(m[2]);
    } else if ((m = line.match(/^TEXT\s+(-?\d+),(-?\d+),"[^"]*",(\d+),(\d+),(\d+),"(.*)"$/i))) {
      label.items.push({ type: 'text', x: num(m[1]), y: num(m[2]), rot: num(m[3]), mult: Math.max(1, num(m[4])), text: m[6] });
    } else if ((m = line.match(/^BARCODE\s+(-?\d+),(-?\d+),"[^"]*",(\d+),(\d+),(\d+),(\d+),(\d+),"(.*)"$/i))) {
      label.items.push({ type: 'barcode', x: num(m[1]), y: num(m[2]), height: num(m[3]), readable: num(m[4]) === 1, rot: num(m[5]), narrow: Math.max(1, num(m[6])), text: m[8] });
    } else if ((m = line.match(/^QRCODE\s+(-?\d+),(-?\d+),\w+,(\d+),\w+,(\d+),"(.*)"$/i))) {
      label.items.push({ type: 'qrcode', x: num(m[1]), y: num(m[2]), cell: Math.max(1, num(m[3])), rot: num(m[4]), text: m[5] });
    } else if ((m = line.match(/^BOX\s+(-?\d+),(-?\d+),(-?\d+),(-?\d+),(\d+)/i))) {
      label.items.push({ type: 'box', x1: num(m[1]), y1: num(m[2]), x2: num(m[3]), y2: num(m[4]), thick: num(m[5]) });
    } else if ((m = line.match(/^BAR\s+(-?\d+),(-?\d+),(\d+),(\d+)/i))) {
      label.items.push({ type: 'bar', x: num(m[1]), y: num(m[2]), w: num(m[3]), h: num(m[4]) });
    } else if ((m = line.match(/^PRINT\s+(\d+)(?:,(\d+))?/i))) {
      label.copies = Math.max(1, num(m[2] ?? m[1]));
    }
  }
  if (!label.widthMm || !label.heightMm) throw new Error('TSPL has no SIZE command; cannot determine label size.');
  return label;
}
