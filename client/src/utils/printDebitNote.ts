import { amountInWordsINR } from './amountInWords';

const INR = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DATE = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

const REASON_LABELS: Record<string, string> = {
  PURCHASE_RETURN: 'Purchase Return / Goods Returned',
  PRICE_VARIANCE: 'Price Variance / Rate Adjustment',
  SHORT_SUPPLY: 'Short Supply / Billed More Than Received',
  QUALITY_DEDUCTION: 'Quality Deduction / Material Discrepancy',
  CORRECTION_IN_GRN: 'Correction in GRN Details',
  OTHER: 'Other / Agreed Adjustment',
};

function formatReason(code?: string): string {
  if (!code) return '—';
  return REASON_LABELS[code] ?? code.replace(/_/g, ' ');
}

export function buildDebitNoteHtml(debitNote: any, template?: any): string {
  const isCancelled = debitNote.status === 'CANCELLED';
  const layout = template?.sections ?? debitNote.printTemplate?.sections;
  const isInterState = Number(debitNote.igst ?? 0) > 0;

  // Issuer is OUR company (seller.* in whitelist)
  const sellerLegalName =
    debitNote.seller?.legalName ||
    debitNote.sellerLegalName ||
    debitNote.company?.name ||
    'Company Name';
  const sellerTradeName =
    debitNote.seller?.tradeName ||
    debitNote.sellerTradeName ||
    '';
  const sellerAddress =
    debitNote.seller?.address ||
    [debitNote.sellerAddress, debitNote.sellerCity, debitNote.sellerDistrict, debitNote.sellerStateCode, debitNote.sellerPincode]
      .filter(Boolean)
      .join(', ') ||
    '';
  const sellerGstin = debitNote.seller?.gstin || debitNote.sellerGstin || debitNote.gstin || '—';
  const sellerStateCode = debitNote.seller?.stateCode || debitNote.sellerStateCode || '';

  // Counterparty is the Supplier (supplier.* in whitelist)
  const supplier = debitNote.supplier ?? {};
  const supplierName = supplier.name || debitNote.supplierName || '—';
  const supplierCode = supplier.supplierCode || '';
  const supplierGstin = supplier.gstNumber || supplier.gstin || debitNote.supplierGstin || '';
  const supplierPan = supplier.panNumber || supplier.pan || debitNote.supplierPan || '';
  const supplierPhone = supplier.phone || debitNote.supplierPhone || '';
  const supplierEmail = supplier.email || debitNote.supplierEmail || '';
  const supplierAddress =
    [supplier.address, supplier.city, supplier.state, supplier.pincode].filter(Boolean).join(', ') ||
    debitNote.supplierAddress ||
    '';

  // Original transaction references
  const grnNumber = debitNote.grn?.grnNumber || debitNote.originalGrn?.number || '';
  const grnDate = debitNote.grn?.receivedDate || debitNote.originalGrn?.date || '';
  const supplierInvoiceNumber =
    debitNote.supplierInvoiceNumber || debitNote.grn?.invoiceNumber || debitNote.supplierInvoice?.number || '';
  const supplierInvoiceDate =
    debitNote.supplierInvoiceDate || debitNote.grn?.invoiceDate || debitNote.supplierInvoice?.date || '';
  const isReturnLinked = !!debitNote.purchaseReturnId || !!debitNote.purchaseReturn;
  const purchaseReturnNumber =
    debitNote.purchaseReturn?.returnNumber || debitNote.purchaseReturn?.number || (debitNote.purchaseReturnId ? 'Linked' : '');
  const purchaseReturnDate = debitNote.purchaseReturn?.returnDate || debitNote.purchaseReturn?.date || '';

  const headerTitle = layout?.header?.title || 'DEBIT NOTE';
  const showSignatory = layout?.footer?.showSignatory !== false;
  const showAcknowledgement = layout?.footer?.showAcknowledgement === true;
  const termsText =
    layout?.footer?.termsText ||
    'Debit Note issued for adjustment against Goods Receipt Note under applicable GST provisions.';
  const notesText = layout?.footer?.notesText || '';

  const amountInWords = amountInWordsINR(Number(debitNote.totalAmount || 0));

  const items: any[] = debitNote.items ?? [];
  const hasJewelleryWeights = items.some((i) => i.grossWeight || i.netWeight || i.karat);

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
  <title>${headerTitle} — ${debitNote.debitNoteNumber}</title>
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
      <div class="logo-circle">${(sellerLegalName || 'C').charAt(0)}</div>
      <div>
        <div class="company-name">${sellerLegalName}${sellerTradeName ? ` <span style="font-size:12px;color:#666">(${sellerTradeName})</span>` : ''}</div>
        ${sellerAddress ? `<div class="company-sub">${sellerAddress}</div>` : ''}
        <div class="company-gstin">GSTIN: ${sellerGstin} &nbsp;|&nbsp; State Code: ${sellerStateCode || '—'}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">${headerTitle}</div>
      <div class="doc-number">${debitNote.debitNoteNumber}</div>
      <div class="doc-date">Date: ${DATE(debitNote.debitNoteDate)}</div>
      <div><span class="status-badge">${isCancelled ? 'CANCELLED' : 'ACTIVE'}</span></div>
    </div>
  </div>

  ${isCancelled ? `
    <div class="cancelled-alert">
      ⚠️ This Debit Note was CANCELLED on ${DATE(debitNote.cancelledAt)}${debitNote.cancelReason ? ` — Reason: "${debitNote.cancelReason}"` : ''}.
      It is invalid for tax deduction or ledger settlement.
    </div>
  ` : ''}

  <div class="info-grid">
    <div class="info-box">
      <div class="title">Issued To (Supplier Details)</div>
      <div class="name">${supplierName}${supplierCode ? ` <span style="font-size:11px;color:#666">(${supplierCode})</span>` : ''}</div>
      ${supplierGstin ? `<div class="line"><b>GSTIN:</b> ${supplierGstin}</div>` : ''}
      ${supplierPan ? `<div class="line"><b>PAN:</b> ${supplierPan}</div>` : ''}
      ${supplierPhone ? `<div class="line"><b>Phone:</b> ${supplierPhone}</div>` : ''}
      ${supplierEmail ? `<div class="line"><b>Email:</b> ${supplierEmail}</div>` : ''}
      ${supplierAddress ? `<div class="line"><b>Address:</b> ${supplierAddress}</div>` : ''}
    </div>

    <div class="info-box">
      <div class="title">Reference & Transaction Details</div>
      ${grnNumber ? `<div class="line"><b>Original GRN #:</b> ${grnNumber}</div>` : ''}
      ${grnDate ? `<div class="line"><b>GRN Date:</b> ${DATE(grnDate)}</div>` : ''}
      ${supplierInvoiceNumber ? `<div class="line"><b>Supplier Inv #:</b> ${supplierInvoiceNumber}</div>` : ''}
      ${supplierInvoiceDate ? `<div class="line"><b>Supplier Inv Date:</b> ${DATE(supplierInvoiceDate)}</div>` : ''}
      ${isReturnLinked ? `
        <div class="line" style="color:#0277BD;font-weight:600"><b>Purchase Return #:</b> ${purchaseReturnNumber || 'Linked'}</div>
        ${purchaseReturnDate ? `<div class="line"><b>Return Date:</b> ${DATE(purchaseReturnDate)}</div>` : ''}
      ` : `
        <div class="line"><b>Document Type:</b> Standalone GRN Adjustment</div>
      `}
      <div class="line"><b>Reason:</b> ${formatReason(debitNote.reasonCode)}</div>
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
        <div style="color:#333;margin-top:2px">${debitNote.reasonNotes || formatReason(debitNote.reasonCode)}</div>
      </div>
      ${notesText ? `
        <div class="words-box" style="margin-top:6px">
          <div class="label">Notes</div>
          <div style="color:#555;margin-top:2px">${notesText}</div>
        </div>
      ` : ''}
      ${isReturnLinked ? `
        <div style="margin-top:8px;font-size:10px;color:#0277BD">
          ℹ️ Note: This is an official GST Debit Note referencing Purchase Return ${purchaseReturnNumber}. Supplier ledger movement is accounted via the Purchase Return.
        </div>
      ` : ''}
    </div>

    <div class="summary-box">
      <table class="tax-table">
        <tbody>
          <tr>
            <td class="label">Taxable Amount</td>
            <td class="value">₹ ${INR(debitNote.taxableAmount)}</td>
          </tr>
          ${!isInterState ? `
            <tr>
              <td class="label">CGST</td>
              <td class="value">₹ ${INR(debitNote.cgst)}</td>
            </tr>
            <tr>
              <td class="label">SGST</td>
              <td class="value">₹ ${INR(debitNote.sgst)}</td>
            </tr>
          ` : `
            <tr>
              <td class="label">IGST</td>
              <td class="value">₹ ${INR(debitNote.igst)}</td>
            </tr>
          `}
          <tr>
            <td class="label">Total Tax</td>
            <td class="value">₹ ${INR(debitNote.totalTax)}</td>
          </tr>
          <tr class="total-row">
            <td class="label" style="font-size:13px">TOTAL DEBIT VALUE</td>
            <td class="value accent">₹ ${INR(debitNote.totalAmount)}</td>
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
        <div class="sign-line">For ${sellerLegalName}<br /><b>Authorized Signatory</b></div>
      </div>
    ` : ''}
    ${showAcknowledgement ? `
      <div class="sign-box">
        <div class="sign-line">Received & Acknowledged By<br /><b>Supplier Signature / Stamp</b></div>
      </div>
    ` : ''}
  </div>

  <div class="footer">
    <span>${sellerLegalName} &nbsp;|&nbsp; Debit Note No: ${debitNote.debitNoteNumber}</span>
    <span>Printed on ${new Date().toLocaleString('en-IN')}</span>
  </div>
</div>

</body>
</html>`;
}

export function printDebitNote(debitNote: any, template?: any): void {
  const html = buildDebitNoteHtml(debitNote, template);
  const win = window.open('', '_blank', 'width=900,height=750,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => win.focus();
}
