import { amountInWordsINR } from './amountInWords';

const INR = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DATE = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

const REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Sales Return / Goods Returned',
  POST_SALE_DISCOUNT: 'Post-Sale Discount / Price Adjustment',
  DEFICIENCY_IN_SERVICE: 'Deficiency in Service / Waived Charges',
  CORRECTION_IN_INVOICE: 'Correction in Invoice Details',
  CHANGE_IN_POS: 'Correction in Place of Supply',
  OTHER: 'Other / Mutual Agreement',
};

function formatReason(code?: string): string {
  if (!code) return '—';
  return REASON_LABELS[code] ?? code.replace(/_/g, ' ');
}

export function buildCreditNoteHtml(creditNote: any, template?: any): string {
  const isCancelled = creditNote.status === 'CANCELLED';
  const layout = template?.sections ?? creditNote.printTemplate?.sections;
  const isInterState = Number(creditNote.igst ?? 0) > 0;

  const sellerName = creditNote.sellerLegalName || creditNote.company?.name || 'Company Name';
  const sellerTrade = creditNote.sellerTradeName || '';
  const sellerAddress = [creditNote.sellerAddress, creditNote.sellerCity, creditNote.sellerDistrict, creditNote.sellerStateCode, creditNote.sellerPincode]
    .filter(Boolean).join(', ');
  const sellerGstin = creditNote.gstin || '—';

  const buyerName = creditNote.buyerName || creditNote.client?.name || '—';
  const buyerCode = creditNote.client?.clientCode || '';
  const buyerPhone = creditNote.client?.phone || creditNote.buyerPhone || '';
  const buyerGstin = creditNote.buyerGstin || creditNote.client?.gstNumber || '';
  const buyerPan = creditNote.buyerPan || creditNote.client?.panNumber || '';
  const buyerAddress = [creditNote.buyerAddress || creditNote.client?.address, creditNote.buyerCity || creditNote.client?.city, creditNote.buyerState || creditNote.client?.state, creditNote.buyerPincode]
    .filter(Boolean).join(', ');

  const items: any[] = creditNote.items ?? [];
  const hasJewelleryWeights = items.some((i) => i.grossWeight || i.netWeight || i.karat);

  const headerTitle = layout?.header?.title || 'CREDIT NOTE';
  const showSignatory = layout?.footer?.showSignatory !== false;
  const termsText = layout?.footer?.termsText || 'Credit Note issued under Section 34 of the CGST Act, 2017.';

  const isReturnLinked = !!creditNote.salesReturnId || !!creditNote.salesReturn;
  const returnNumber = creditNote.salesReturn?.returnNumber || (creditNote.salesReturnId ? 'Linked' : '');

  const amountInWords = amountInWordsINR(Number(creditNote.totalAmount || 0));

  const itemsHtml = items.map((item, idx) => {
    const hsn = item.hsnCode?.code || item.hsnCodeId || '—';
    const ratePercent = item.taxRate != null ? `${(Number(item.taxRate) * 100).toFixed(0)}%` : '—';
    return `
      <tr>
        <td style="text-align:center">${idx + 1}</td>
        <td>
          <div style="font-weight:600">${item.description || 'Adjustment'}</div>
          ${item.karat ? `<div style="font-size:10px;color:#777">Karat: ${item.karat}</div>` : ''}
        </td>
        <td style="text-align:center;font-family:'Courier New',monospace">${hsn}</td>
        ${hasJewelleryWeights ? `
          <td style="text-align:right;font-family:'Courier New',monospace">${item.grossWeight != null ? Number(item.grossWeight).toFixed(3) : '—'}</td>
          <td style="text-align:right;font-family:'Courier New',monospace">${item.netWeight != null ? Number(item.netWeight).toFixed(3) : '—'}</td>
        ` : ''}
        <td style="text-align:center">${item.uom || 'PCS'}</td>
        <td style="text-align:right;font-family:'Courier New',monospace">₹ ${INR(item.taxableValue)}</td>
        <td style="text-align:center;font-size:11px">${ratePercent}</td>
        ${isInterState ? `
          <td style="text-align:right;font-family:'Courier New',monospace">₹ ${INR(item.igstAmount)}</td>
        ` : `
          <td style="text-align:right;font-family:'Courier New',monospace">₹ ${INR(Number(item.cgstAmount ?? 0) + Number(item.sgstAmount ?? 0))}</td>
        `}
        <td style="text-align:right;font-family:'Courier New',monospace;font-weight:600">₹ ${INR(item.totalValue)}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${headerTitle} — ${creditNote.creditNoteNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      color: #1A1A1A;
      background: #fff;
    }
    .page {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      padding: 14mm 16mm;
      position: relative;
    }

    /* Print action bar */
    .print-btn {
      display: flex; gap: 8px;
      justify-content: flex-end;
      padding: 12px 16px;
      background: #F5F5F5;
      border-bottom: 1px solid #E0E0E0;
      position: sticky; top: 0; z-index: 100;
    }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-print { background: #44C47A; color: #fff; }
    .btn-close { background: #EEE; color: #333; }

    /* Cancellation styling */
    ${isCancelled ? `
    .watermark {
      position: absolute;
      top: 40%;
      left: 15%;
      transform: rotate(-30deg);
      font-size: 72px;
      font-weight: 900;
      color: rgba(211, 47, 47, 0.12);
      pointer-events: none;
      z-index: 10;
      letter-spacing: 0.1em;
      border: 6px dashed rgba(211, 47, 47, 0.2);
      padding: 12px 36px;
      border-radius: 12px;
      text-transform: uppercase;
    }
    .cancelled-alert {
      background: #FDEDED;
      border: 1px solid #F5C2C7;
      color: #842029;
      padding: 10px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 16px;
    }
    ` : ''}

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid ${isCancelled ? '#D32F2F' : '#44C47A'};
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .logo-block { display: flex; align-items: center; gap: 12px; }
    .logo-circle {
      width: 48px; height: 48px; border-radius: 8px;
      background: ${isCancelled ? '#D32F2F' : '#44C47A'};
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 900; color: #fff;
    }
    .company-name { font-size: 18px; font-weight: 700; color: ${isCancelled ? '#D32F2F' : '#44C47A'}; }
    .company-sub { font-size: 11px; color: #666; margin-top: 2px; }
    .company-gstin { font-size: 11px; color: #333; margin-top: 3px; font-family: 'Courier New', monospace; font-weight: 600; }

    .doc-meta { text-align: right; }
    .doc-title { font-size: 16px; font-weight: 700; color: #333; letter-spacing: 0.05em; text-transform: uppercase; }
    .doc-number { font-size: 13px; font-family: 'Courier New', monospace; color: ${isCancelled ? '#D32F2F' : '#44C47A'}; font-weight: 700; margin-top: 4px; }
    .doc-date { font-size: 11px; color: #666; margin-top: 2px; }
    .status-badge {
      display: inline-block;
      margin-top: 6px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: ${isCancelled ? '#FFEBEE' : '#E8F5E9'};
      color: ${isCancelled ? '#C62828' : '#2E7D32'};
      border: 1px solid ${isCancelled ? '#FFCDD2' : '#C8E6C9'};
    }

    .info-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 0 16px;
      margin-bottom: 16px;
    }
    .info-box {
      background: #FAFAF5; border: 1px solid #EEE; border-radius: 8px; padding: 10px 14px;
    }
    .info-box .title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; font-weight: 700; margin-bottom: 6px; }
    .info-box .name { font-size: 13px; font-weight: 700; color: #111; }
    .info-box .line { font-size: 11px; color: #444; margin-top: 2px; }

    .meta-strip {
      background: #F4F6F8;
      border: 1px solid #E5E8EC;
      border-radius: 6px;
      padding: 8px 12px;
      display: flex; gap: 20px; flex-wrap: wrap;
      font-size: 11px; color: #555;
      margin-bottom: 16px;
    }
    .meta-strip b { color: #1A1A1A; }

    table.items {
      width: 100%; border-collapse: collapse;
      margin-bottom: 12px;
    }
    table.items thead th {
      background: #FAFAF5; text-align: left;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #666;
      padding: 7px 8px; border-bottom: 2px solid #E0E0E0;
    }
    table.items tbody td {
      padding: 7px 8px; border-bottom: 1px solid #F0F0F0; font-size: 11px; vertical-align: middle;
    }

    .summary-wrap {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 12px;
      gap: 24px;
    }
    .words-and-notes {
      flex: 1;
      background: #FAFAF8;
      border: 1px solid #E8E8E8;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 11px;
    }
    .words-box { margin-bottom: 8px; }
    .words-box .label { font-size: 10px; text-transform: uppercase; color: #888; font-weight: 700; }
    .words-box .val { font-weight: 700; color: #222; font-style: italic; margin-top: 2px; }

    .summary-box { width: 320px; }
    .tax-table { width: 100%; border-collapse: collapse; }
    .tax-table td { padding: 4px 8px; font-size: 12px; }
    .tax-table td.label { color: #444; width: 55%; }
    .tax-table td.value { text-align: right; font-family: 'Courier New', monospace; font-size: 12px; }
    .tax-table tr.total-row {
      border-top: 2px solid #44C47A;
      background: #FAFAF5;
      font-weight: 700;
    }
    .tax-table tr.total-row td.accent {
      color: ${isCancelled ? '#D32F2F' : '#44C47A'};
      font-size: 15px;
      font-weight: 800;
    }

    .signature-wrap {
      margin-top: 36px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .sign-box { text-align: center; }
    .sign-line {
      border-top: 1px solid #888;
      width: 180px;
      padding-top: 4px;
      font-size: 10px;
      color: #555;
    }

    .footer {
      margin-top: 24px;
      border-top: 1px solid #E0E0E0;
      padding-top: 8px;
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: #888;
    }

    @media print {
      .print-btn { display: none; }
      .page { padding: 10mm 12mm; }
      body { font-size: 12px; }
    }
  </style>
</head>
<body>

<div class="print-btn">
  <button class="btn btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn btn-print" onclick="window.print()">🖨 Print / Save PDF</button>
</div>

<div class="page">
  ${isCancelled ? `<div class="watermark">CANCELLED</div>` : ''}

  <div class="header">
    <div class="logo-block">
      <div class="logo-circle">${(sellerName || 'C').charAt(0)}</div>
      <div>
        <div class="company-name">${sellerName}${sellerTrade ? ` <span style="font-size:12px;color:#666">(${sellerTrade})</span>` : ''}</div>
        ${sellerAddress ? `<div class="company-sub">${sellerAddress}</div>` : ''}
        <div class="company-gstin">GSTIN: ${sellerGstin} &nbsp;|&nbsp; State Code: ${creditNote.sellerStateCode || '—'}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">${headerTitle}</div>
      <div class="doc-number">${creditNote.creditNoteNumber}</div>
      <div class="doc-date">Date: ${DATE(creditNote.creditNoteDate)}</div>
      <div><span class="status-badge">${isCancelled ? 'CANCELLED' : 'ACTIVE'}</span></div>
    </div>
  </div>

  ${isCancelled ? `
    <div class="cancelled-alert">
      ⚠️ This Credit Note was CANCELLED on ${DATE(creditNote.cancelledAt)}${creditNote.cancelReason ? ` — Reason: "${creditNote.cancelReason}"` : ''}.
      It is invalid for tax deduction or ledger settlement.
    </div>
  ` : ''}

  <div class="info-grid">
    <div class="info-box">
      <div class="title">Bill To (Customer Details)</div>
      <div class="name">${buyerName}${buyerCode ? ` <span style="font-size:11px;color:#666">(${buyerCode})</span>` : ''}</div>
      ${buyerGstin ? `<div class="line"><b>GSTIN:</b> ${buyerGstin}</div>` : ''}
      ${buyerPan ? `<div class="line"><b>PAN:</b> ${buyerPan}</div>` : ''}
      ${buyerPhone ? `<div class="line"><b>Phone:</b> ${buyerPhone}</div>` : ''}
      ${buyerAddress ? `<div class="line"><b>Address:</b> ${buyerAddress}</div>` : ''}
    </div>

    <div class="info-box">
      <div class="title">Reference & Statutory Details</div>
      <div class="line"><b>Original Invoice #:</b> ${creditNote.originalInvoiceNumber}</div>
      <div class="line"><b>Original Invoice Date:</b> ${DATE(creditNote.originalInvoiceDate)}</div>
      ${isReturnLinked ? `
        <div class="line" style="color:#0277BD;font-weight:600"><b>Sales Return #:</b> ${returnNumber || 'Linked'}</div>
      ` : `
        <div class="line"><b>Document Type:</b> Standalone Value Adjustment</div>
      `}
      <div class="line"><b>Reason:</b> ${formatReason(creditNote.reasonCode)}</div>
      <div class="line"><b>Place of Supply:</b> ${creditNote.placeOfSupply || '—'} (${isInterState ? 'Inter-State' : 'Intra-State'})</div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:30px;text-align:center">#</th>
        <th>Description</th>
        <th style="width:65px;text-align:center">HSN</th>
        ${hasJewelleryWeights ? `
          <th style="width:70px;text-align:right">Gross Wt (g)</th>
          <th style="width:70px;text-align:right">Net Wt (g)</th>
        ` : ''}
        <th style="width:45px;text-align:center">UOM</th>
        <th style="width:90px;text-align:right">Taxable</th>
        <th style="width:45px;text-align:center">Rate</th>
        <th style="width:85px;text-align:right">${isInterState ? 'IGST' : 'CGST+SGST'}</th>
        <th style="width:95px;text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml || `<tr><td colspan="${hasJewelleryWeights ? 10 : 8}" style="text-align:center;color:#999;padding:16px">No items</td></tr>`}
    </tbody>
  </table>

  <div class="summary-wrap">
    <div class="words-and-notes">
      <div class="words-box">
        <div class="label">Amount in Words</div>
        <div class="val">${amountInWords}</div>
      </div>
      <div class="words-box" style="margin-top:6px">
        <div class="label">Reason / Remarks</div>
        <div style="color:#333;margin-top:2px">${creditNote.reasonNotes || formatReason(creditNote.reasonCode)}</div>
      </div>
      ${isReturnLinked ? `
        <div style="margin-top:8px;font-size:10px;color:#0277BD">
          ℹ️ Note: This is an official GST Credit Note referencing Sales Return ${returnNumber}. Customer balance movement is accounted via the Sales Return.
        </div>
      ` : ''}
    </div>

    <div class="summary-box">
      <table class="tax-table">
        <tbody>
          <tr>
            <td class="label">Taxable Amount</td>
            <td class="value">₹ ${INR(creditNote.taxableAmount)}</td>
          </tr>
          ${!isInterState ? `
            <tr>
              <td class="label">CGST</td>
              <td class="value">₹ ${INR(creditNote.cgst)}</td>
            </tr>
            <tr>
              <td class="label">SGST</td>
              <td class="value">₹ ${INR(creditNote.sgst)}</td>
            </tr>
          ` : `
            <tr>
              <td class="label">IGST</td>
              <td class="value">₹ ${INR(creditNote.igst)}</td>
            </tr>
          `}
          <tr>
            <td class="label">Total Tax</td>
            <td class="value">₹ ${INR(creditNote.totalTax)}</td>
          </tr>
          <tr class="total-row">
            <td class="label" style="font-size:13px">TOTAL CREDIT VALUE</td>
            <td class="value accent">₹ ${INR(creditNote.totalAmount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="signature-wrap">
    <div style="font-size:10px;color:#666;max-width:320px">
      ${termsText}
    </div>
    ${showSignatory ? `
      <div class="sign-box">
        <div class="sign-line">For ${sellerName}<br /><b>Authorized Signatory</b></div>
      </div>
    ` : ''}
  </div>

  <div class="footer">
    <span>${sellerName} &nbsp;|&nbsp; Credit Note No: ${creditNote.creditNoteNumber}</span>
    <span>Printed on ${new Date().toLocaleString('en-IN')}</span>
  </div>
</div>

</body>
</html>`;
}

export function printCreditNote(creditNote: any, template?: any): void {
  const html = buildCreditNoteHtml(creditNote, template);
  const win = window.open('', '_blank', 'width=900,height=750,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => win.focus();
}
