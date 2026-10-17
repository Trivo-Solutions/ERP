// ESC/POS encoding for the receipt printer (Epson TM-m30III and compatibles). Pure functions, no
// I/O, so the byte layout is unit-tested without a printer. Separate from the TSPL label path.

export const MAX_RECEIPT_WIDTH_DOTS = 832; // widest common ESC/POS head (112 mm at 203 dpi)
export const MAX_RECEIPT_HEIGHT_DOTS = 12000; // ~1.5 m at 203 dpi - far beyond any estimate
// GS v 0 is sent in bands so no single command overruns the printer's receive buffer.
const BAND_ROWS = 256;

const ESC_INIT = Buffer.from([0x1b, 0x40]);

export interface ReceiptBitmap {
  widthDots: number;   // multiple of 8
  heightDots: number;
  bits: Buffer;        // 1 bit per dot, MSB first, 1 = black, row-major, widthDots/8 bytes per row
}

export function validateBitmap(b: ReceiptBitmap): string | null {
  if (!Number.isInteger(b.widthDots) || b.widthDots <= 0 || b.widthDots % 8 !== 0) return 'widthDots must be a positive multiple of 8.';
  if (b.widthDots > MAX_RECEIPT_WIDTH_DOTS) return `widthDots must be at most ${MAX_RECEIPT_WIDTH_DOTS}.`;
  if (!Number.isInteger(b.heightDots) || b.heightDots <= 0) return 'heightDots must be a positive integer.';
  if (b.heightDots > MAX_RECEIPT_HEIGHT_DOTS) return `heightDots must be at most ${MAX_RECEIPT_HEIGHT_DOTS}.`;
  if (b.bits.length !== (b.widthDots / 8) * b.heightDots) return 'Bitmap data length does not match widthDots x heightDots.';
  return null;
}

// Init, raster image in bands, feed, partial cut. feedDots is the blank paper left under the last
// row before the cutter (the cutter sits ~10-15 mm below the print head).
export function buildReceiptJob(b: ReceiptBitmap, opts: { feedDots?: number; cut?: boolean } = {}): Buffer {
  const err = validateBitmap(b);
  if (err) throw new Error(err);
  const bytesPerRow = b.widthDots / 8;
  const parts: Buffer[] = [ESC_INIT];
  for (let row = 0; row < b.heightDots; row += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, b.heightDots - row);
    // GS v 0 m xL xH yL yH d1...dk   (m=0: normal density)
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]));
    parts.push(b.bits.subarray(row * bytesPerRow, (row + rows) * bytesPerRow));
  }
  const feed = Math.min(Math.max(Math.round(opts.feedDots ?? 96), 0), 255 * 3);
  // ESC J n: feed n dots (n <= 255) - repeated for larger values.
  for (let left = feed; left > 0; left -= 255) parts.push(Buffer.from([0x1b, 0x4a, Math.min(left, 255)]));
  if (opts.cut !== false) parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V 66 0: feed to cut position, partial cut
  return Buffer.concat(parts);
}

// A text-only job for the "test print": exercises init, text, feed and cut with no bitmap.
export function buildTestJob(lines: string[]): Buffer {
  const ascii = lines.map((l) => l.replace(/[^\x20-\x7e]/g, '?')).join('\n') + '\n';
  return Buffer.concat([ESC_INIT, Buffer.from(ascii, 'latin1'), Buffer.from([0x1b, 0x4a, 96]), Buffer.from([0x1d, 0x56, 0x42, 0x00])]);
}
