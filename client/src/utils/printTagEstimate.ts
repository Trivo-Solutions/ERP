import JsBarcode from 'jsbarcode';
import {
  EstimateBoundField, EstimateTemplateElement, EstimateTemplateLayout, MM_PER_PT, computeTableWidthMm,
  formatEstimateDate,
} from '../types/estimateTemplate';
import { computeMakingAmount } from './estimateCalc';
import { flowBelowTables } from './estimatePageLayout';

const INR = (v: number) => '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

interface PrintData {
  tag: any;
  estimate: any;
  makingChargeAmount: number;
}

function resolveBoundField(field: EstimateBoundField, data: PrintData): string {
  const { tag, estimate, makingChargeAmount } = data;
  switch (field) {
    case 'tagNumber': return tag.tagNumber ?? '';
    // The category's short master-data code alone (e.g. "NEC" for Necklace, "BNG" for Bangle) — not
    // the tag's own long generated tagNumber (that's the separate 'tagNumber' field above), and not
    // the full descriptive name either. Falls back to the descriptive name only for a tag with no
    // category assigned, so this never prints blank.
    case 'itemName': return tag.category?.code ?? tag.name ?? '';
    case 'metalKarat': return tag.metalKarat ?? '';
    case 'grossWeight': return `${Number(tag.grossWeight ?? 0).toFixed(3)} g`;
    case 'netWeight': return `${Number(tag.netWeight ?? 0).toFixed(3)} g`;
    case 'stoneWeight': return `${Number(tag.stoneWeight ?? 0).toFixed(3)} ct`;
    case 'branchName': return tag.branch?.name ?? '';
    case 'estimateNumber': return estimate.estimateNumber ?? '';
    case 'generatedOn': return formatEstimateDate(estimate.createdAt ?? new Date());
    case 'validUntil': return formatEstimateDate(estimate.validUntil);
    case 'totalSaleAmount': return INR(Number(estimate.totalSaleAmount ?? 0));
    case 'makingChargeAmount': return INR(makingChargeAmount);
    case 'saleMcRate': return INR(Number(estimate.saleMcRate ?? 0));
    case 'saleVaPercent': return `${Number(estimate.saleVaPercent ?? 0)}%`;
    case 'taxRate': return `${(Number(estimate.taxRate ?? 0) * 100).toFixed(0)}%`;
    case 'gstAmount': return INR(Number(estimate.gstAmount ?? 0));
    case 'netPayableAmount': return INR(Number(estimate.netPayableAmount ?? 0));
    case 'huid': return tag.huid ?? '';
    case 'metalType': return tag.metalType ?? '';
    case 'makeType': return tag.makeType ?? '';
    case 'mrp': return INR(Number(tag.sellingPrice ?? 0));
    case 'notes': return estimate.notes ?? '';
    case 'currency': return estimate.currency ?? '';
    // Today's date at the moment of printing — deliberately NOT estimate.createdAt (that's what
    // 'generatedOn' is for). Reprinting an estimate saved last week still stamps today's date here,
    // the same distinction a real invoice makes between "invoice date" and "printed on".
    case 'printDate': return formatEstimateDate(new Date());
    default: return '';
  }
}

// Barcode-only: the raw value to encode, not the formatted display string resolveBoundField
// produces (a barcode of "₹1,234.00" is meaningless) — in practice only tagNumber/estimateNumber
// are sensible choices here, but any field still resolves to something rather than erroring.
function resolveRawValue(field: EstimateBoundField, data: PrintData): string {
  const { tag, estimate } = data;
  switch (field) {
    case 'tagNumber': return tag.tagNumber ?? '';
    case 'estimateNumber': return estimate.estimateNumber ?? '';
    default: return resolveBoundField(field, data).replace(/[₹,%\s]/g, '');
  }
}

// JsBarcode renders into a real SVG DOM node — built detached (never attached to the visible page)
// so this can run synchronously in the calling window and the serialized markup gets embedded
// directly into the print HTML string. No CDN script, no network dependency at print time (the
// counter's printer may have no internet access at all), unlike loading a barcode library inside
// the popup window itself would require.
function renderBarcodeSvg(value: string, widthMm: number, heightMm: number, humanReadable: boolean): string {
  if (!value) return '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, value, { format: 'CODE128', displayValue: humanReadable, margin: 0, fontSize: 14 });
  } catch {
    return `<div style="font-size:10px; color:#900;">Invalid barcode value: ${escapeHtml(value)}</div>`;
  }
  // JsBarcode sizes the SVG in its own internal px units — pin explicit mm dimensions so it prints
  // at the size actually designed, regardless of that internal sizing.
  svg.setAttribute('width', `${widthMm}mm`);
  svg.setAttribute('height', `${heightMm}mm`);
  svg.removeAttribute('style'); // JsBarcode sets an inline width/height in px we just overrode
  return new XMLSerializer().serializeToString(svg);
}

function elementHtml(el: EstimateTemplateElement, data: PrintData, pageWidthMm: number): string {
  const pos = `position:absolute; left:${el.xMm}mm; top:${el.yMm}mm;`;

  if (el.type === 'text') {
    const content = el.boundField ? resolveBoundField(el.boundField, data) : (el.literalText ?? '');
    const fontSize = el.fontSize ?? 12;
    const align = el.align ?? 'left';
    // Alignment only does anything once the box has a real width to align within — a Wrap Width
    // set explicitly wraps at exactly that. Left unset (the pre-existing default), it used to run
    // as wide as the content needed with no limit — invisible in the designer for a short literal
    // label, but a bound field's real value (a long item name, say) could run past the page edge
    // and get silently clipped there (see the .page overflow:hidden below) instead of wrapping.
    // Capping at the remaining page width from this element's own x position is the same safety
    // net the materials table already has: content that's too long wraps onto another line rather
    // than disappearing.
    const widthRule = el.widthMm != null
      ? `width:${el.widthMm}mm; white-space:pre-wrap; overflow-wrap:break-word;`
      : `max-width:${Math.max(5, pageWidthMm - el.xMm)}mm; white-space:pre-wrap; overflow-wrap:break-word;`;
    // pt, not px — a true physical unit (1pt = 1/72in, same as Microsoft Word), consistent with
    // every other size on the page already being in mm. Using px here was the actual cause of the
    // printed page sometimes running longer than the on-screen measurement predicted (see
    // measureElementHeightsMm below): px is a screen-oriented unit whose real physical size a
    // browser is free to interpret slightly differently between contexts, unlike pt/mm/in.
    return `<div style="${pos} font-size:${fontSize}pt; font-family:Arial, sans-serif; text-align:${align}; ${widthRule}">${escapeHtml(content)}</div>`;
  }
  if (el.type === 'box') {
    return `<div style="${pos} width:${el.widthMm ?? 10}mm; height:${el.heightMm ?? 10}mm; border:1.5px solid #000;"></div>`;
  }
  if (el.type === 'line') {
    return `<div style="${pos} width:${el.widthMm ?? 10}mm; height:${el.heightMm ?? 0.3}mm; background:#000;"></div>`;
  }
  if (el.type === 'materialsTable') {
    const columns = el.columns ?? [];
    const realItems = data.estimate.items ?? [];
    // Same formula as estimateCalc.ts's computeMakingAmount, split into its two terms instead of
    // one combined total — MC (₹/g × metal weight) and VA (VA% × metal sale value) need their own
    // rows, each with its own Rate/Amount, not one merged "Making Charge" figure.
    const metalWeight = realItems.filter((i: any) => i.materialType === 'METAL').reduce((s: number, i: any) => s + Number(i.weight || 0), 0);
    const metalSaleAmt = realItems.filter((i: any) => i.materialType === 'METAL').reduce((s: number, i: any) => s + Number(i.saleAmount || 0), 0);
    const saleMcRate = Number(data.estimate.saleMcRate ?? 0);
    const saleVaPercent = Number(data.estimate.saleVaPercent ?? 0);
    const items = el.includeChargeRows
      ? [
          ...realItems,
          { code: 'MC', chargeKind: 'MC', weight: 0, unit: '', saleRate: saleMcRate, saleAmount: metalWeight * saleMcRate },
          { code: 'VA', chargeKind: 'VA', weight: 0, unit: '', saleRate: saleVaPercent, saleAmount: (metalSaleAmt * saleVaPercent) / 100 },
        ]
      : realItems;
    const widthMm = computeTableWidthMm(el.columns, el.widthMm ?? 180);
    const headerFontSize = el.headerFontSize ?? 8;
    const rowFontSize = el.rowFontSize ?? 9;
    const allBorders = el.borderStyle === 'all';
    const headerBorder = allBorders ? 'border:1px solid #333;' : 'border-bottom:1.5px solid #333;';
    const cellBorder = allBorders ? 'border:1px solid #ccc;' : 'border-bottom:1px solid #eee;';
    // colgroup, not a width on every <th>/<td> — table-layout:fixed then reads column widths from
    // here alone, so the browser can't reconcile/re-derive them from cell content (the previous
    // width-on-<th>-only approach let a long value in a <td> quietly widen its column past what was
    // designed, which is exactly why the printed table could end up wider than the designer showed).
    const colgroup = columns.map((c) => `<col style="width:${c.widthMm}mm;">`).join('');
    // Wraps onto a second line rather than truncating with "…" — a column narrower than its
    // content should never silently hide part of a value (a rupee amount, a weight), it should
    // just make that one row taller. Truncation was tried first (to match the fixed column width
    // exactly) but a price document is the one place "…" instead of a real number is worse than an
    // uneven-looking row.
    const headerCells = columns.map((c) =>
      `<th style="text-align:${c.field === 'name' ? 'left' : 'right'}; ${headerBorder} padding:3px 6px; font-size:${c.fontSize ?? headerFontSize}pt; text-transform:uppercase; letter-spacing:0.03em; white-space:normal; word-break:break-word;">${escapeHtml(c.label)}</th>`
    ).join('');
    const bodyRows = items.map((it: any) => {
      const cells = columns.map((c) => {
        let v = '';
        switch (c.field) {
          case 'name': v = it.code || it.name; break; // short code, not the full descriptive name
          case 'weight': v = it.chargeKind ? '' : Number(it.weight ?? 0).toFixed(3); break;
          case 'unit': v = it.chargeKind ? '' : (it.unit ?? ''); break;
          case 'saleRate':
            // VA is a percentage, MC a flat ₹/g rate — neither is a plain ₹ amount like every
            // other row's Rate, so each gets its own unit suffix instead of INR()'s bare currency.
            if (it.chargeKind === 'VA') v = `${Number(it.saleRate ?? 0).toFixed(2)}%`;
            else if (it.chargeKind === 'MC') v = `${INR(Number(it.saleRate ?? 0))}/g`;
            else v = INR(Number(it.saleRate ?? 0));
            break;
          case 'saleAmount': v = INR(Number(it.saleAmount ?? 0)); break;
        }
        return `<td style="text-align:${c.field === 'name' ? 'left' : 'right'}; ${cellBorder} padding:3px 6px; font-size:${c.fontSize ?? rowFontSize}pt; white-space:normal; word-break:break-word;">${escapeHtml(String(v))}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<div style="${pos} width:${widthMm}mm;">
      <table style="width:100%; table-layout:fixed; border-collapse:collapse;">
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody>
      </table>
    </div>`;
  }
  if (el.type === 'barcode') {
    const raw = el.boundField ? resolveRawValue(el.boundField, data) : '';
    const widthMm = el.widthMm ?? 40;
    const heightMm = el.heightMm ?? 15;
    const svg = renderBarcodeSvg(raw, widthMm, heightMm, el.humanReadable !== false);
    return `<div style="${pos}">${svg}</div>`;
  }
  if (el.type === 'image') {
    if (!el.imageDataUrl) return '';
    const widthMm = el.widthMm ?? 30;
    const heightMm = el.heightMm ?? 30;
    return `<img src="${el.imageDataUrl}" style="${pos} width:${widthMm}mm; height:${heightMm}mm; object-fit:contain;" />`;
  }
  return '';
}

// The popup's base reset, shared so the measuring frame lays out under exactly the rules the
// printed page uses (the app window's global CSS, e.g. MUI's line-height, differs).
export const BASE_CSS = '* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: Arial, sans-serif; }';

// Lays every element out in a hidden same-origin iframe carrying the popup's own CSS and returns
// each element's real rendered height in mm, by id. document.write into about:blank is synchronous,
// so this stays sync (the print popup must still open inside the click's user activation). Nothing
// loads asynchronously: Arial is a system font, and barcodes/images have explicit mm sizes.
function measureElementHeightsMm(elements: EstimateTemplateElement[], data: PrintData, widthMm: number): Record<string, number> {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute; left:-99999px; top:0; width:2000px; height:2000px; border:0; visibility:hidden;';
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    if (!doc) return {};
    const rendered = elements.map((el) => ({ el, html: elementHtml(el, data, widthMm) })).filter((r) => r.html);
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><style>${BASE_CSS}</style></head><body><div id="p" style="position:relative; width:${widthMm}mm;">${rendered.map((r) => r.html).join('\n')}</div></body></html>`);
    doc.close();
    const ruler = doc.createElement('div');
    ruler.style.cssText = 'position:absolute; width:100mm; height:0;';
    doc.body.appendChild(ruler);
    const pxPerMm = ruler.getBoundingClientRect().width / 100;
    const out: Record<string, number> = {};
    if (!(pxPerMm > 0)) return out;
    const kids = Array.from(doc.getElementById('p')!.children);
    rendered.forEach((r, i) => {
      const rect = kids[i]?.getBoundingClientRect();
      if (rect) out[r.el.id] = rect.height / pxPerMm;
    });
    return out;
  } finally {
    document.body.removeChild(frame);
  }
}

// Renders a saved EstimateTemplate against a real tag + (saved or in-progress) estimate, and opens
// a browser print window — same window.open/write/print pattern as printEstimate.ts/printInvoice.ts,
// just driven by the template's element list instead of a hardcoded layout. Paper size comes from
// the template itself, not a fixed A4 — the real target may be a narrow continuous-roll thermal/
// receipt printer, so widthMm is whatever that template was designed for; heightMm only seeds the
// *designer canvas*'s size — the actual page height is always computed from real content below.
export interface EstimatePage { contentHtml: string; widthMm: number; heightMm: number }

// The laid-out estimate (element HTML in mm + the real page height), shared by the browser print
// window below and the receipt-printer path (estimateReceipt.ts) so both print the same page.
export function buildEstimatePage(template: { layout: EstimateTemplateLayout; widthMm: number; heightMm: number }, tag: any, estimate: any): EstimatePage {
  const items = estimate.items ?? [];
  const metalWeight = items.filter((i: any) => i.materialType === 'METAL').reduce((s: number, i: any) => s + Number(i.weight || 0), 0);
  const metalSaleAmt = items.filter((i: any) => i.materialType === 'METAL').reduce((s: number, i: any) => s + Number(i.saleAmount || 0), 0);
  const makingChargeAmount = computeMakingAmount(metalWeight, metalSaleAmt, Number(estimate.saleMcRate ?? 0), Number(estimate.saleVaPercent ?? 0));

  const data: PrintData = { tag, estimate, makingChargeAmount };
  const widthMm = template.widthMm;
  // Elements below the materials table follow the table's real height (up for a short estimate,
  // down for a long one) and the page height is the real content bottom, bounded - see
  // estimatePageLayout.ts. Previously every element stayed at its design-time y, so the paper was
  // never shorter than the template's footer position, however few rows there were.
  const heights = measureElementHeightsMm(template.layout.elements ?? [], data, widthMm);
  const flowed = flowBelowTables(template.layout.elements ?? [], heights, template.heightMm);
  const contentHtml = flowed.elements.map((el) => elementHtml(el, data, widthMm)).join('\n');
  return { contentHtml, widthMm, heightMm: flowed.pageHeightMm };
}

export function printTagEstimate(template: { layout: EstimateTemplateLayout; widthMm: number; heightMm: number }, tag: any, estimate: any) {
  const { contentHtml, widthMm, heightMm } = buildEstimatePage(template, tag, estimate);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Estimate — ${estimate.estimateNumber ?? ''}</title>
  <style>
    ${BASE_CSS}
    body { background: #eee; }
    .page {
      position: relative;
      width: ${widthMm}mm; height: ${heightMm}mm;
      margin: 0 auto; background: #fff; box-shadow: 0 0 8px rgba(0,0,0,0.15);
      /* Matches the designer canvas's own overflow:hidden — an element positioned past the page's
         physical width is genuinely gone, not just visually confusing, so both views agree. */
      overflow: hidden;
    }
    .print-btn {
      display: flex; gap: 8px; justify-content: flex-end;
      padding: 12px 16px; background: #F5F5F5; position: sticky; top: 0; z-index: 100;
    }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-print { background: #44C47A; color: #fff; }
    .btn-close { background: #EEE; color: #333; }
    /* Custom paper size hint for the print dialog/driver — a continuous-roll thermal/receipt
       printer (e.g. Epson POS) is typically configured in the OS as a fixed-width custom size;
       height here is the real measured content height (see measureElementHeightsMm above), not
       just the template's design-time guess. */
    @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
    @media print {
      body { background: #fff; }
      .print-btn { display: none; }
      .page { box-shadow: none; margin: 0; }
    }
  </style>
</head>
<body>
  <div class="print-btn">
    <button class="btn btn-close" onclick="window.close()">✕ Close</button>
    <button class="btn btn-print" onclick="window.print()">🖨 Print / Save PDF</button>
  </div>
  <div class="page">${contentHtml}</div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=1000,height=800,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => win.focus();
}
