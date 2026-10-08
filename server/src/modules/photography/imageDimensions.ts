// Reads pixel dimensions from the container header of the formats Photography accepts (JPEG / PNG / WebP).
// Header parsing only — no decoding, no image library. Returns null when the header is truncated or unusual;
// width/height are nullable on TagImage, so an unreadable header never blocks an otherwise valid upload.
export interface Dimensions { width: number; height: number }

export function readImageDimensions(buf: Buffer, contentType: string): Dimensions | null {
  try {
    const d = contentType === 'image/png' ? png(buf) : contentType === 'image/jpeg' ? jpeg(buf) : contentType === 'image/webp' ? webp(buf) : null;
    return d && d.width > 0 && d.height > 0 ? d : null;
  } catch { return null; }
}

function png(b: Buffer): Dimensions | null {
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): Dimensions | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): Dimensions | null {
  if (b.length < 30) return null;
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}
