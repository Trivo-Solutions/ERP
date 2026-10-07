import { amountInWordsINR } from './amountInWords';

const INR = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DATETIME = (v: unknown) =>
  v ? new Date(v as string).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

const MODE_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', UPI: 'UPI', BANK_TRANSFER: 'Bank Transfer', CHEQUE: 'Cheque' };
export const advanceModeLabel = (m: string) => MODE_LABEL[m] ?? m;

// User-entered text (names, notes, reference) goes into a document.write()-ed page — always escaped.
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const ADVANCE_RECEIPT_TERMS =
  'This receipt acknowledges payment received as a customer advance for future purchases. The advance is maintained separately from Store Credit and will be adjusted against eligible future invoices according to company policy.';

export function buildAdvanceReceiptHtml(advance: any, companyName: string): string {
  const reversed = advance.status === 'REVERSED';
  const available = reversed ? 0 : Number(advance.availableAmount ?? 0);
  const row = (label: string, value: string) =>
    value ? `<tr><td class="k">${label}</td><td class="v">${value}</td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Advance Receipt ${esc(advance.advanceNumber)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2933; margin: 0; background: #f3f4f6; }
  .toolbar { position: sticky; top: 0; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e7eb; text-align: right; }
  .toolbar button { padding: 7px 16px; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; margin-left: 8px; }
  .toolbar .p { background: #1f2933; color: #fff; } .toolbar .c { background: #e5e7eb; }
  .sheet { position: relative; max-width: 180mm; margin: 16px auto; background: #fff; padding: 12mm; border: 1px solid #d1d5db; overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f2933; padding-bottom: 10px; }
  .co { font-size: 20px; font-weight: 700; } .br { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .title { text-align: right; } .title h1 { margin: 0; font-size: 17px; letter-spacing: .5px; text-transform: uppercase; }
  .title .no { font-family: 'Courier New', monospace; font-size: 14px; font-weight: 700; margin-top: 4px; }
  .notinv { margin: 10px 0; padding: 6px 10px; background: #f9fafb; border: 1px solid #e5e7eb; font-size: 11.5px; text-align: center; font-weight: 600; letter-spacing: .3px; }
  table.d { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.d td { padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; vertical-align: top; }
  td.k { width: 38%; color: #6b7280; } td.v { font-weight: 600; }
  .amt { margin: 14px 0 6px; padding: 12px 14px; border: 1.5px solid #1f2933; border-radius: 6px; display: flex; justify-content: space-between; align-items: baseline; }
  .amt .l { font-size: 12px; text-transform: uppercase; color: #6b7280; } .amt .n { font-size: 24px; font-weight: 700; font-family: 'Courier New', monospace; }
  .words { font-size: 12.5px; margin-bottom: 8px; } .words b { font-weight: 600; }
  .avail { display: flex; justify-content: space-between; font-size: 13px; padding: 8px 0; border-top: 1px dashed #9ca3af; border-bottom: 1px dashed #9ca3af; margin: 8px 0; }
  .terms { font-size: 10.5px; color: #4b5563; line-height: 1.5; margin-top: 12px; }
  .sign { display: flex; justify-content: space-between; margin-top: 38px; font-size: 11.5px; color: #4b5563; }
  .sign div { border-top: 1px solid #9ca3af; padding-top: 4px; width: 42%; text-align: center; }
  .rev { margin: 10px 0; padding: 8px 10px; border: 1.5px solid #b91c1c; color: #b91c1c; font-size: 12.5px; font-weight: 600; border-radius: 4px; }
  .wm { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%) rotate(-24deg); font-size: 96px; font-weight: 800; color: rgba(185, 28, 28, .16); border: 8px solid rgba(185, 28, 28, .16); padding: 0 24px; pointer-events: none; }
  .strike { text-decoration: line-through; color: #9ca3af; }
  @media print { body { background: #fff; } .toolbar { display: none; } .sheet { border: 0; margin: 0; padding: 0; max-width: none; } }
</style></head><body>
<div class="toolbar"><button class="c" onclick="window.close()">Close</button><button class="p" onclick="window.print()">Print</button></div>
<div class="sheet">
  ${reversed ? '<div class="wm">REVERSED</div>' : ''}
  <div class="head">
    <div><div class="co">${esc(companyName)}</div><div class="br">${esc(advance.branch?.name ?? '')}</div></div>
    <div class="title"><h1>Customer Advance Receipt</h1><div class="no">${esc(advance.advanceNumber)}</div>
      <div class="br">${esc(DATETIME(advance.advanceDate))}</div></div>
  </div>
  <div class="notinv">CUSTOMER ADVANCE &mdash; THIS IS NOT A SALES INVOICE</div>
  ${reversed ? `<div class="rev">REVERSED on ${esc(DATETIME(advance.reversedAt))}${advance.reversalReason ? ` &mdash; ${esc(advance.reversalReason)}` : ''}. This advance is no longer available.</div>` : ''}
  <table class="d">
    ${row('Received from', esc(advance.client?.name))}
    ${row('Customer code', esc(advance.client?.clientCode))}
    ${row('Phone', esc(advance.client?.phone))}
    ${row('Payment mode', esc(advanceModeLabel(advance.mode)))}
    ${row('Reference no.', esc(advance.referenceNo))}
    ${row('Received by', esc(advance.createdBy?.name))}
  </table>
  <div class="amt"><span class="l">Advance received</span><span class="n ${reversed ? 'strike' : ''}">&#8377; ${INR(advance.amount)}</span></div>
  <div class="words"><b>Amount in words:</b> ${esc(amountInWordsINR(Number(advance.amount || 0)))}</div>
  <div class="avail"><span>Available Advance${reversed ? ' (after reversal)' : ''}</span><b>&#8377; ${INR(available)}</b></div>
  ${advance.notes ? `<div class="words"><b>Notes:</b> ${esc(advance.notes)}</div>` : ''}
  <div class="terms">${esc(ADVANCE_RECEIPT_TERMS)}</div>
  <div class="sign"><div>Customer signature</div><div>Authorised signatory</div></div>
</div>
</body></html>`;
}

export function printAdvanceReceipt(advance: any, companyName: string): void {
  const win = window.open('', '_blank', 'width=900,height=800,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(buildAdvanceReceiptHtml(advance, companyName));
  win.document.close();
  win.onload = () => win.focus();
}
