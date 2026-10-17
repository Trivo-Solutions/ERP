import { describe, it, expect } from 'vitest';
import { packBitmap, receiptDotsFor, toBase64, RECEIPT_WIDTH_DOTS } from '../utils/estimateReceipt';

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

describe('packBitmap', () => {
  it('packs MSB first, 1 = black, rows padded to whole bytes', () => {
    // 10 px wide, 1 row: black at x=0, x=7 and x=9, rest white
    const row = new Uint8ClampedArray(10 * 4).fill(255);
    for (const x of [0, 7, 9]) row.set([0, 0, 0, 255], x * 4);
    expect([...packBitmap(row, 10, 1)]).toEqual([0b10000001, 0b01000000]);
  });
  it('treats transparent as white and mid-grey above the threshold as white', () => {
    expect([...packBitmap(px(0, 0, 0, 0), 1, 1)]).toEqual([0]);
    expect([...packBitmap(px(200, 200, 200, 255), 1, 1)]).toEqual([0]);
    expect([...packBitmap(px(120, 120, 120, 255), 1, 1)]).toEqual([0x80]);
  });
});

describe('receiptDotsFor', () => {
  it('keeps the page aspect ratio at the printable width and never truncates', () => {
    expect(receiptDotsFor(80, 110)).toEqual({ widthDots: RECEIPT_WIDTH_DOTS, heightDots: Math.ceil(110 * 576 / 80) });
    expect(receiptDotsFor(80, 0.1).heightDots).toBeGreaterThanOrEqual(1);
    expect(RECEIPT_WIDTH_DOTS % 8).toBe(0);
  });
});

describe('toBase64', () => {
  it('round-trips a large buffer', () => {
    const b = new Uint8Array(200000).map((_, i) => i % 251);
    expect([...Uint8Array.from(atob(toBase64(b)), (c) => c.charCodeAt(0))]).toEqual([...b]);
  });
});
