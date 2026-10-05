import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { apiGet } from '../api/client';
import {
  TaxInvoiceDesignerLayout, TaxInvoiceTemplateElement, computeTableWidthMm, PAGE_BOTTOM_MARGIN_MM,
} from '../types/taxInvoiceTemplate';
import {
  InvoiceContext, PageInfo, buildInvoiceContext, buildTableData, resolveField, interpolate, placeholderKeys,
} from './taxInvoiceData';
import { planPages, PagePlan } from './taxInvoicePaging';

// Renders a designer-format TaxInvoiceTemplate (layout.elements) against a real invoice and opens
// the browser print window — the same window.open/write/print pattern as printTagEstimate.ts, plus
// what an invoice needs on top of an estimate: the item table flows (grows, and continues onto
// further pages with its header repeated) while everything beneath it moves down with it, and one
// full pass is printed per configured copy (Original / Duplicate / Triplicate).

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function pxPerMm(): number {
  const ruler = document.createElement('div');
  ruler.style.cssText = 'position:absolute; visibility:hidden; width:100mm; height:0; left:-99999px; top:0;';
  document.body.appendChild(ruler);
  const px = ruler.getBoundingClientRect().width;
  document.body.removeChild(ruler);
  return px / 100;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

// ─── Element → HTML ──────────────────────────────────────────────────────────────────────────

interface RenderEnv {
  ctx: InvoiceContext;
  page: PageInfo;
  pageWidthMm: number;
  qrSvg: string | null; // pre-rendered e-invoice QR, or null when the invoice has no QR data
}

function barcodeSvg(value: string, widthMm: number, heightMm: number, humanReadable: boolean): string {
  if (!value) return '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, value, { format: 'CODE128', displayValue: humanReadable, margin: 0, fontSize: 14 });
  } catch {
    return `<div style="font-size:8px;color:#900;">Invalid barcode value</div>`;
  }
  svg.setAttribute('width', `${widthMm}mm`);
  svg.setAttribute('height', `${heightMm}mm`);
  svg.removeAttribute('style');
  return new XMLSerializer().serializeToString(svg);
}

function textStyle(el: TaxInvoiceTemplateElement): string {
  return [
    `font-size:${el.fontSize ?? 9}pt`,
    'font-family:Arial, sans-serif',
    `text-align:${el.align ?? 'left'}`,
    el.bold ? 'font-weight:700' : '',
    el.italic ? 'font-style:italic' : '',
    el.uppercase ? 'text-transform:uppercase' : '',
    el.color && SAFE_COLOR.test(el.color) ? `color:${el.color}` : '',
  ].filter(Boolean).join('; ');
}

function textContent(el: TaxInvoiceTemplateElement, env: RenderEnv): string {
  const symbol = !el.noCurrencySymbol;
  if (el.boundField) return resolveField(el.boundField, env.ctx, env.page, symbol);
  return interpolate(el.literalText ?? '', env.ctx, env.page, symbol);
}

function tableHtml(
  el: TaxInvoiceTemplateElement, env: RenderEnv, posCss: string,
  slice?: { start: number; end: number; withTotal: boolean; fillMm: number },
): string {
  const columns = el.columns ?? [];
  const kind = el.tableKind ?? 'items';
  const data = buildTableData(kind, columns, env.ctx, !!el.showTotalRow);
  const widthMm = computeTableWidthMm(columns, el.widthMm ?? 190);
  const hf = el.headerFontSize ?? 7.5;
  const rf = el.rowFontSize ?? 8;
  const style = el.borderStyle ?? 'all';
  const cellBorder = style === 'all' ? 'border:0.25mm solid #444;' : style === 'bottomOnly' ? 'border-bottom:0.2mm solid #bbb;' : '';
  const headBorder = style === 'all' ? 'border:0.25mm solid #444;' : style === 'bottomOnly' ? 'border-bottom:0.35mm solid #333;' : '';
  const headBg = el.headerFill ? 'background:#eeeeee;' : '';
  const align = (i: number) => columns[i].align ?? 'left';

  const rows = slice ? data.rows.slice(slice.start, slice.end) : data.rows;
  const showTotal = slice ? slice.withTotal : true;
  const colgroup = columns.map((c) => `<col style="width:${c.widthMm}mm;">`).join('');
  const th = columns.map((c, i) =>
    `<th style="text-align:${align(i)}; ${headBorder} ${headBg} padding:0.8mm 1mm; font-size:${c.fontSize ?? hf}pt; font-weight:700; white-space:normal; word-break:break-word;">${escapeHtml(c.label)}</th>`).join('');
  const td = (cells: string[], bold = false, bg = '') => `<tr>${cells.map((v, i) =>
    `<td style="text-align:${align(i)}; ${cellBorder} ${bg} padding:0.7mm 1mm; font-size:${columns[i].fontSize ?? rf}pt; ${bold ? 'font-weight:700;' : ''} ${align(i) === 'left' ? 'white-space:pre-line; word-break:break-word;' : 'white-space:nowrap;'} vertical-align:top;">${escapeHtml(v)}</td>`).join('')}</tr>`;
  const body = rows.map((r) => td(r)).join('');
  const fill = slice && slice.fillMm > 0.5
    ? `<tr style="height:${slice.fillMm}mm;">${columns.map(() => `<td style="${style === 'all' ? 'border-left:0.25mm solid #444;border-right:0.25mm solid #444;' : ''}padding:0;"></td>`).join('')}</tr>`
    : '';
  const total = data.total && showTotal ? td(data.total, true, 'background:#f5f5f5;') : '';
  return `<div style="${posCss} width:${widthMm}mm;"><table data-flow="1" style="width:100%; table-layout:fixed; border-collapse:collapse; font-family:Arial, sans-serif;"><colgroup>${colgroup}</colgroup><thead><tr>${th}</tr></thead><tbody>${body}${fill}${total}</tbody></table></div>`;
}

function elementHtml(
  el: TaxInvoiceTemplateElement, env: RenderEnv,
  override?: { yMm?: number; heightMm?: number; slice?: { start: number; end: number; withTotal: boolean; fillMm: number } },
): string {
  const y = override?.yMm ?? el.yMm;
  const pos = `position:absolute; left:${el.xMm}mm; top:${y}mm;`;
  if (el.type === 'text') {
    const content = textContent(el, env);
    if (!content) return '';
    // "Hide when empty": a label whose every {{field}} resolved blank (e.g. "IRN: {{einvoice.irn}}" on a
    // bill with no IRN) prints nothing instead of a dangling label.
    if (el.hideIfEmpty && !el.boundField) {
      const keys = placeholderKeys(el.literalText ?? '');
      if (keys.length && keys.every((k) => !resolveField(k, env.ctx, env.page, false))) return '';
    }
    const widthRule = el.widthMm != null
      ? `width:${el.widthMm}mm;`
      : `max-width:${Math.max(5, env.pageWidthMm - el.xMm)}mm;`;
    return `<div style="${pos} ${widthRule} white-space:pre-wrap; overflow-wrap:break-word; ${textStyle(el)}">${escapeHtml(content)}</div>`;
  }
  if (el.type === 'box') {
    const h = override?.heightMm ?? el.heightMm ?? 10;
    const fill = el.fillColor && SAFE_COLOR.test(el.fillColor) ? `background:${el.fillColor};` : '';
    return `<div style="${pos} width:${el.widthMm ?? 10}mm; height:${h}mm; border:0.3mm solid #000; ${fill}"></div>`;
  }
  if (el.type === 'line') {
    return `<div style="${pos} width:${el.widthMm ?? 10}mm; height:${el.heightMm ?? 0.3}mm; background:#000;"></div>`;
  }
  if (el.type === 'image') {
    if (!el.imageDataUrl || !el.imageDataUrl.startsWith('data:image/')) return '';
    return `<img src="${el.imageDataUrl}" style="${pos} width:${el.widthMm ?? 30}mm; height:${el.heightMm ?? 30}mm; object-fit:contain;" />`;
  }
  if (el.type === 'barcode') {
    const raw = el.boundField ? resolveField(el.boundField, env.ctx, env.page, false).replace(/[₹,\s]/g, '') : '';
    return `<div style="${pos}">${barcodeSvg(raw, el.widthMm ?? 40, el.heightMm ?? 12, el.humanReadable !== false)}</div>`;
  }
  if (el.type === 'qrcode') {
    if (!env.qrSvg) return '';
    return `<div style="${pos} width:${el.widthMm ?? 22}mm; height:${el.heightMm ?? 22}mm;">${env.qrSvg.replace('<svg', `<svg style="width:100%;height:100%;display:block;"`)}</div>`;
  }
  if (el.type === 'table') return tableHtml(el, env, pos, override?.slice);
  return '';
}

// ─── Page assembly ───────────────────────────────────────────────────────────────────────────

type Placement = 'above' | 'band' | 'decor' | 'below' | 'fixed';

interface Measured {
  /** Bottom edge (mm, page coords) of each non-flow element as actually laid out with real data. */
  bottom: Map<string, number>;
  headerMm: number;
  rowMm: number[];
  totalRowMm: number;
  /** Actual rendered height of each secondary table. */
  tableHeight: Map<string, number>;
}

function measure(layout: TaxInvoiceDesignerLayout, env: RenderEnv, flow: TaxInvoiceTemplateElement | undefined): Measured {
  const container = document.createElement('div');
  container.style.cssText = `position:absolute; visibility:hidden; left:-99999px; top:0; width:${layout.page.widthMm}mm; font-family:Arial, sans-serif;`;
  const parts: string[] = [];
  const order: TaxInvoiceTemplateElement[] = [];
  for (const el of layout.elements) {
    if (el.type === 'table' && el === flow) {
      // Measured with every row + the total row in ONE table so wrapped rows get their true height.
      parts.push(tableHtml(el, env, `position:absolute; left:${el.xMm}mm; top:${el.yMm}mm;`));
    } else {
      parts.push(elementHtml(el, env));
    }
    order.push(el);
  }
  // Each element renders to exactly one top-level child (or '' → none); map by walking in order.
  container.innerHTML = parts.join('');
  document.body.appendChild(container);
  const ratio = pxPerMm();
  const top = container.getBoundingClientRect().top;
  const bottom = new Map<string, number>();
  const tableHeight = new Map<string, number>();
  let headerMm = 0; let rowMm: number[] = []; let totalRowMm = 0;
  let child = 0;
  const kids = Array.from(container.children) as HTMLElement[];
  for (let k = 0; k < order.length; k++) {
    if (!parts[k]) continue;
    const node = kids[child++];
    if (!node) break;
    const rect = node.getBoundingClientRect();
    const el = order[k];
    bottom.set(el.id, (rect.bottom - top) / ratio);
    if (el.type === 'table') {
      tableHeight.set(el.id, rect.height / ratio);
      if (el === flow) {
        const table = node.querySelector('table')!;
        headerMm = table.querySelector('thead')!.getBoundingClientRect().height / ratio;
        const trs = Array.from(table.querySelectorAll('tbody tr')) as HTMLElement[];
        const hasTotal = !!el.showTotalRow;
        const dataTrs = hasTotal ? trs.slice(0, -1) : trs;
        rowMm = dataTrs.map((tr) => tr.getBoundingClientRect().height / ratio);
        totalRowMm = hasTotal && trs.length ? trs[trs.length - 1].getBoundingClientRect().height / ratio : 0;
      }
    }
  }
  document.body.removeChild(container);
  return { bottom, headerMm, rowMm, totalRowMm, tableHeight };
}

function estimatedHeight(el: TaxInvoiceTemplateElement, m: Measured): number {
  const b = m.bottom.get(el.id);
  if (b != null) return Math.max(0, b - el.yMm);
  return el.heightMm ?? (el.type === 'text' ? ((el.fontSize ?? 9) * 25.4) / 72 * 1.3 : 0);
}

function buildPagesHtml(layout: TaxInvoiceDesignerLayout, invoice: any, copyLabel: string, qrSvg: string | null): string[] {
  const ctx = buildInvoiceContext(invoice, copyLabel);
  const W = layout.page.widthMm;
  const H = layout.page.heightMm;
  const els = layout.elements;
  const tables = els.filter((e) => e.type === 'table');
  const flow = tables.find((e) => e.tableKind === 'items');
  const baseEnv: RenderEnv = { ctx, page: { number: 1, total: 1 }, pageWidthMm: W, qrSvg };
  const m = measure(layout, baseEnv, flow);

  const reserved = (t: TaxInvoiceTemplateElement) => t.heightMm ?? 30;
  // Secondary tables grow downward past their reserved height — everything below them moves too.
  const secondary = tables.filter((t) => t !== flow);
  const secShift = (y: number) => secondary.reduce((s, t) => {
    const bottomDesign = t.yMm + reserved(t);
    return bottomDesign <= y + 0.5 ? s + Math.max(0, (m.tableHeight.get(t.id) ?? 0) - reserved(t)) : s;
  }, 0);

  // Single page, nothing flows: every element where it was designed (secondary tables still push what is below them).
  const place = (el: TaxInvoiceTemplateElement): number => (el.repeatOnEveryPage ? el.yMm : el.yMm + secShift(el.yMm));

  const wrap = (inner: string, num: number, total: number) =>
    `<div class="page" style="width:${W}mm; height:${H}mm;">${inner}</div><!--${num}/${total}-->`;

  if (!flow) {
    const html = els.map((el) => elementHtml(el, baseEnv, { yMm: place(el) })).join('');
    return [wrap(html, 1, 1)];
  }

  const flowTop = flow.yMm + secShift(flow.yMm);
  const flowReserved = reserved(flow);
  const flowBottomDesign = flow.yMm + flowReserved;

  const placementOf = (el: TaxInvoiceTemplateElement): Placement => {
    if (el === flow) return 'band';
    if (el.repeatOnEveryPage) return 'fixed';
    const h = estimatedHeight(el, m);
    if ((el.type === 'box' || el.type === 'line') && el.yMm <= flow.yMm + 0.5 && el.yMm + (el.heightMm ?? h) >= flowBottomDesign - 0.5) return 'decor';
    if (el.yMm >= flowBottomDesign - 0.5) return 'below';
    if (el.yMm >= flow.yMm - 0.5) return 'band';
    return 'above';
  };
  const placed = els.map((el) => ({ el, p: placementOf(el) }));
  // Continuation pages start the table just under the repeating header content. Frames and rules
  // (box/line) are decoration, not header content — a full-page frame would otherwise push it off the page.
  const headerBottoms = placed
    .filter((x) => x.p === 'fixed' && x.el.type !== 'box' && x.el.type !== 'line' && x.el.yMm < flow.yMm)
    .map((x) => m.bottom.get(x.el.id) ?? x.el.yMm)
    .filter((b) => b <= flow.yMm + 0.5);
  const contTop = headerBottoms.length ? Math.max(...headerBottoms) + 2 : 10;
  const belowBottom = Math.max(
    flowBottomDesign,
    ...placed.filter((x) => x.p === 'below').map((x) => (m.bottom.get(x.el.id) ?? x.el.yMm) + secShift(x.el.yMm)),
  );

  const plans: PagePlan[] = planPages({
    pageHeightMm: H, tableTopMm: flowTop, reservedMm: flowReserved, headerMm: m.headerMm, rowMm: m.rowMm,
    totalRowMm: m.totalRowMm, contTopMm: contTop, belowBottomMm: belowBottom, bottomMarginMm: PAGE_BOTTOM_MARGIN_MM,
  });

  return plans.map((plan, idx) => {
    const env: RenderEnv = { ...baseEnv, page: { number: idx + 1, total: plans.length } };
    const out: string[] = [];
    for (const { el, p } of placed) {
      if (el === flow) {
        out.push(elementHtml(el, env, {
          yMm: plan.topMm, slice: { start: plan.rowStart, end: plan.rowEnd, withTotal: plan.withTotal, fillMm: plan.fillMm },
        }));
      } else if (p === 'fixed') {
        out.push(elementHtml(el, env));
      } else if (p === 'above') {
        if (plan.isFirst) out.push(elementHtml(el, env, { yMm: place(el) }));
      } else if (p === 'band') {
        if (plan.isFirst) out.push(elementHtml(el, env, { yMm: place(el) }));
      } else if (p === 'decor') {
        // A frame/rule that wraps the table: spans from its design top to the table's end on the last
        // page, or to the page's bottom margin when the table continues past this page.
        const top = plan.isFirst ? el.yMm : plan.topMm - (flow.yMm - el.yMm);
        const designBelowPad = (el.yMm + (el.heightMm ?? 0)) - flowBottomDesign;
        const bottom = plan.isLast
          ? Math.min(H, plan.topMm + plan.usedMm + Math.max(plan.isFirst ? flowReserved - plan.usedMm : 0, 0) + designBelowPad)
          : H - PAGE_BOTTOM_MARGIN_MM + Math.max(0, designBelowPad);
        out.push(elementHtml(el, env, { yMm: top, heightMm: Math.max(0.3, bottom - top) }));
      } else if (p === 'below') {
        if (plan.isLast) out.push(elementHtml(el, env, { yMm: place(el) + plan.shiftMm }));
      }
    }
    return wrap(out.join(''), idx + 1, plans.length);
  });
}

async function qrFor(invoice: any): Promise<string | null> {
  const data = invoice.taxDetails?.qrCodeData;
  if (!data) return null;
  try {
    return await QRCode.toString(String(data), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
}

export async function renderTaxInvoiceHtml(layout: TaxInvoiceDesignerLayout, invoice: any): Promise<string> {
  const qrSvg = await qrFor(invoice);
  const copies = layout.copies?.filter((c) => c.trim()) ?? [];
  const labels = copies.length ? copies : [''];
  const pages = labels.flatMap((label) => buildPagesHtml(layout, invoice, label, qrSvg));
  const W = layout.page.widthMm;
  const H = layout.page.heightMm;
  const title = `Tax Invoice — ${invoice.invoiceNumber ?? ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #eee; }
    .page { position: relative; margin: 8px auto; background: #fff; box-shadow: 0 0 8px rgba(0,0,0,0.15); overflow: hidden; page-break-after: always; break-after: page; }
    .page:last-of-type { page-break-after: auto; break-after: auto; }
    .print-btn { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; background: #F5F5F5; position: sticky; top: 0; z-index: 100; }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-print { background: #44C47A; color: #fff; }
    .btn-close { background: #EEE; color: #333; }
    @page { size: ${W}mm ${H}mm; margin: 0; }
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
  ${pages.join('\n')}
</body>
</html>`;
}

// `invoice` may be a partial object (the POST /invoices response has no branch/tax snapshot). When it
// carries an id, the full invoice is fetched first so every bound field has its data. The window is
// opened synchronously (inside the click) and filled afterwards — opening it after an await would be
// blocked as a pop-up.
export async function printTaxInvoiceTemplate(invoice: any, layout: TaxInvoiceDesignerLayout): Promise<void> {
  const win = window.open('', '_blank', 'width=1000,height=800,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write('<p style="font-family:Arial;padding:16px;color:#555">Preparing invoice…</p>');
  try {
    let full = invoice;
    if (invoice?.id && (!invoice.taxDetails || !invoice.branch || !invoice.payments)) {
      const res: any = await apiGet<any>(`/sales/invoices/${invoice.id}`);
      full = res?.data ?? res;
    }
    const html = await renderTaxInvoiceHtml(layout, full);
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.onload = () => win.focus();
  } catch (e: any) {
    win.document.open();
    win.document.write(`<p style="font-family:Arial;padding:16px;color:#b00">Could not prepare the invoice: ${escapeHtml(String(e?.message ?? e))}</p>`);
    win.document.close();
  }
}
