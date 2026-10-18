import { BASE_CSS, buildEstimatePage } from './printTagEstimate';
import { printReceiptViaAgent, ReceiptPrintResult } from './printAgent';
import { buildEscPosRaster, sendToNetworkPrinter } from './networkReceiptPrinter';
import type { EstimateTemplateLayout } from '../types/estimateTemplate';

// Prints an estimate on the ESC/POS receipt printer through the local print agent: the same page
// the browser print window shows is drawn to a canvas, reduced to a 1-bit bitmap exactly as tall
// as the content, and sent as raster data. The printer then feeds precisely that length - there is
// no driver paper size ("Roll Paper 80 x 297 mm") to pad it out.

// 80 mm paper at 203 dpi prints 576 dots (72 mm). The page is scaled to fit that width, so a
// template designed for the full 80 mm is reduced ~10% rather than cut at the edges.
export const RECEIPT_WIDTH_DOTS = 576;
const CSS_PX_PER_MM = 96 / 25.4;
const BLACK_BELOW = 170; // grayscale threshold: anti-aliased text edges darker than this print black

// RGBA pixels -> packed 1-bit rows (MSB first, 1 = black). Transparent counts as white.
export function packBitmap(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
      if (lum < BLACK_BELOW) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function receiptDotsFor(widthMm: number, heightMm: number, widthDots = RECEIPT_WIDTH_DOTS) {
  return { widthDots, heightDots: Math.max(1, Math.ceil((heightMm * widthDots) / widthMm)) };
}

async function rasterize(contentHtml: string, widthMm: number, heightMm: number, widthDots: number, heightDots: number): Promise<Uint8Array> {
  const pxW = widthMm * CSS_PX_PER_MM;
  const pxH = heightMm * CSS_PX_PER_MM;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative; width:${widthMm}mm; height:${heightMm}mm; background:#fff; overflow:hidden;">`
    + `<style>${BASE_CSS}</style>${contentHtml}</div></foreignObject></svg>`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not draw the estimate for the receipt printer.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.drawImage(img, 0, 0, widthDots, heightDots);
  return packBitmap(ctx.getImageData(0, 0, widthDots, heightDots).data, widthDots, heightDots);
}

// jobId is the duplicate guard: the agent never sends the same id to the printer twice. Pass the
// SAME id when retrying a print whose outcome is unknown (timeout); use a fresh one for a
// deliberate reprint.
// Same slip, sent straight to a network Epson (Android / no PC). Resolves once the printer itself
// acknowledged the job; throws with the printer's own reason otherwise.
export async function printEstimateToNetworkPrinter(
  host: string,
  template: { layout: EstimateTemplateLayout; widthMm: number; heightMm: number },
  tag: any, estimate: any,
): Promise<void> {
  const page = buildEstimatePage(template, tag, estimate);
  const { widthDots, heightDots } = receiptDotsFor(page.widthMm, page.heightMm);
  const bits = await rasterize(page.contentHtml, page.widthMm, page.heightMm, widthDots, heightDots);
  await sendToNetworkPrinter(host, buildEscPosRaster(bits, widthDots, heightDots));
}

export async function printEstimateToReceiptPrinter(
  template: { layout: EstimateTemplateLayout; widthMm: number; heightMm: number },
  tag: any, estimate: any, jobId: string,
): Promise<ReceiptPrintResult> {
  const page = buildEstimatePage(template, tag, estimate);
  const { widthDots, heightDots } = receiptDotsFor(page.widthMm, page.heightMm);
  const bits = await rasterize(page.contentHtml, page.widthMm, page.heightMm, widthDots, heightDots);
  return printReceiptViaAgent({ jobId, widthDots, heightDots, data: toBase64(bits) });
}
