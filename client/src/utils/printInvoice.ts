// G1 Part J/F: no hardcoded seller identity — every seller/buyer value comes from the invoice's
// own immutable snapshot (invoice.taxDetails.seller*/buyer* — see TaxInvoice in schema.prisma and
// sales.service.ts's resolveSellerRegistration/buyerSnapshot), and section layout/labels/column
// choice come from invoice.printTemplate (resolved server-side by GET /sales/invoices/:id — branch
// override, else company default, else a safe built-in layout — see taxInvoiceTemplate.service.ts).
// The template controls PRESENTATION ONLY: which of these already-computed values show, in what
// order, under what label — never the values themselves (G1 Part G's statutory/presentation split).

const INR = (v: unknown) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

function row(label: string, value: string, bold = false, accent = false) {
  return `
    <tr>
      <td class="label">${label}</td>
      <td class="value ${bold ? 'bold' : ''} ${accent ? 'accent' : ''}">${value}</td>
    </tr>`;
}

// Mirrors server/src/shared/taxInvoiceBoundFields.ts's field list — presentation lookup only
// (the template merely picks which of these already-server-computed values to show and in what
// order; it can never inject a value that isn't one of these).
function fieldValue(key: string, invoice: any, tax: any): { label: string; value: string } {
  const seller: Record<string, [string, string]> = {
    'seller.legalName': ['Seller', tax?.sellerLegalName ?? invoice.company?.name ?? '—'],
    'seller.tradeName': ['Trade Name', tax?.sellerTradeName ?? ''],
    'seller.gstin': ['GSTIN', tax?.gstin ?? '—'],
    'seller.stateCode': ['State Code', tax?.sellerStateCode ?? ''],
    'seller.address': ['Address', tax?.sellerAddress ?? ''],
    'seller.city': ['City', tax?.sellerCity ?? ''],
    'seller.district': ['District', tax?.sellerDistrict ?? ''],
    'seller.pincode': ['PIN', tax?.sellerPincode ?? ''],
    'seller.country': ['Country', tax?.sellerCountry ?? ''],
  };
  const buyer: Record<string, [string, string]> = {
    'buyer.name': ['Bill To', tax?.buyerName ?? invoice.client?.name ?? '—'],
    'buyer.gstin': ['GSTIN', tax?.buyerGstin ?? invoice.client?.gstNumber ?? ''],
    'buyer.pan': ['PAN', tax?.buyerPan ?? invoice.client?.panNumber ?? ''],
    'buyer.address': ['Address', tax?.buyerAddress ?? invoice.client?.address ?? ''],
    'buyer.city': ['City', tax?.buyerCity ?? invoice.client?.city ?? ''],
    'buyer.state': ['State', tax?.buyerState ?? invoice.client?.state ?? ''],
    'buyer.stateCode': ['State Code', tax?.buyerStateCode ?? ''],
    'buyer.pincode': ['PIN', tax?.buyerPincode ?? ''],
    'buyer.phone': ['Mobile', invoice.client?.phone ?? ''],
    'buyer.email': ['Email', invoice.client?.email ?? ''],
  };
  const invMeta: Record<string, [string, string]> = {
    'invoice.number': ['Invoice No.', invoice.invoiceNumber],
    'invoice.date': ['Date', DATE(invoice.invoiceDate)],
    'invoice.financialYear': ['Financial Year', ''],
    'invoice.type': ['Invoice Type', invoice.invoiceType],
    'invoice.placeOfSupply': ['Place of Supply', tax?.placeOfSupply || '—'],
    'invoice.reverseCharge': ['Reverse Charge', tax?.reverseCharge ? 'Yes' : 'No'],
    'invoice.terms': ['Terms', invoice.terms ?? ''],
    'invoice.salesPerson': ['Sales Executive', invoice.salesPerson?.name ?? ''],
  };
  const totals: Record<string, [string, string]> = {
    'totals.subtotal': ['Subtotal', `₹ ${INR(invoice.subtotal)}`],
    'totals.taxableValue': ['Taxable Value', `₹ ${INR(tax?.taxableAmount ?? invoice.subtotal)}`],
    'totals.cgst': ['CGST', `₹ ${INR(tax?.cgst)}`],
    'totals.sgst': ['SGST', `₹ ${INR(tax?.sgst)}`],
    'totals.igst': ['IGST', `₹ ${INR(tax?.igst)}`],
    'totals.otherCharges': ['Shipping / Other Charges', `+ ₹ ${INR(invoice.otherCharges)}`],
    'totals.discount': ['Discount', `- ₹ ${INR(invoice.discountAmount)}`],
    'totals.roundOff': ['Round off', `${Number(invoice.roundOff ?? 0) >= 0 ? '+' : '-'} ₹ ${INR(Math.abs(Number(invoice.roundOff ?? 0)))}`],
    'totals.grandTotal': ['Total', `₹ ${INR(invoice.totalAmount)}`],
  };
  const payment: Record<string, [string, string]> = {
    'payment.paidAmount': ['Paid', `₹ ${INR(invoice.paidAmount ?? 0)}`],
    'payment.balanceDue': ['Balance Due', `₹ ${INR(invoice.balanceDue ?? invoice.totalAmount)}`],
  };
  const all = { ...seller, ...buyer, ...invMeta, ...totals, ...payment };
  const [label, value] = all[key] ?? [key, ''];
  return { label, value };
}

function itemColumnHeader(col: string): string {
  const labels: Record<string, string> = {
    srNo: '#', description: 'Description', productCode: 'Tag No.', hsnCode: 'HSN', quantity: 'Qty',
    uom: 'UOM', grossWeight: 'Gross Wt', stoneWeight: 'Stone Wt', netWeight: 'Net Wt (g)',
    rate: 'Rate', makingCharge: 'Making Charge', lineDiscountAmount: 'Discount',
    taxableValue: 'Taxable Value', cgstAmount: 'CGST', sgstAmount: 'SGST', igstAmount: 'IGST',
    lineTotalTax: 'Tax', totalPrice: 'Amount',
  };
  return labels[col] ?? col;
}

function itemColumnValue(col: string, item: any, idx: number): string {
  switch (col) {
    case 'srNo': return String(idx + 1);
    case 'description': return `<div>${item.description}</div>${item.productCode ? `<div style="font-size:10px;color:#999">${item.productCode}${item.huid ? ` &nbsp;|&nbsp; HUID ${item.huid}` : ''}</div>` : ''}`;
    case 'productCode': return item.productCode ?? '—';
    case 'hsnCode': return item.hsnCode?.code ?? '—';
    case 'quantity': return String(item.quantity);
    case 'uom': return item.uom ?? '—';
    case 'grossWeight': return Number(item.grossWeight ?? 0).toFixed(3);
    case 'stoneWeight': return Number(item.stoneWeight ?? 0).toFixed(3);
    case 'netWeight': return Number(item.netGoldWeight ?? 0).toFixed(3);
    case 'rate': return `₹ ${INR(item.goldRate)}`;
    case 'makingCharge': return `₹ ${INR(item.makingCharge)}`;
    case 'lineDiscountAmount': return `₹ ${INR(item.lineDiscountAmount)}`;
    case 'taxableValue': return `₹ ${INR(item.taxableValue)}`;
    case 'cgstAmount': return `₹ ${INR(item.cgstAmount)}`;
    case 'sgstAmount': return `₹ ${INR(item.sgstAmount)}`;
    case 'igstAmount': return `₹ ${INR(item.igstAmount)}`;
    case 'lineTotalTax': return `₹ ${INR(item.lineTotalTax)}`;
    case 'totalPrice': return `₹ ${INR(item.totalPrice)}`;
    default: return '—';
  }
}

const RIGHT_ALIGNED = new Set(['quantity', 'uom', 'grossWeight', 'stoneWeight', 'netWeight', 'rate', 'makingCharge', 'lineDiscountAmount', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'lineTotalTax', 'totalPrice']);

export function printInvoice(invoice: any) {
  const items: any[] = invoice.items ?? [];
  const tax = invoice.taxDetails;
  const layout = invoice.printTemplate?.sections;

  const isInterState = Number(tax?.igst ?? 0) > 0;

  const sellerFields: string[] = layout?.seller?.fields ?? ['seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.address', 'seller.city', 'seller.stateCode'];
  const buyerFields: string[] = layout?.buyer?.fields ?? ['buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state'];
  const invoiceMetaFields: string[] = layout?.invoiceMeta?.fields ?? ['invoice.number', 'invoice.date', 'invoice.type', 'invoice.placeOfSupply'];
  const itemColumns: string[] = layout?.items?.columns ?? ['srNo', 'hsnCode', 'description', 'quantity', 'netWeight', 'rate', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalPrice'];
  const totalsFields: string[] = layout?.totals?.fields ?? ['totals.subtotal', 'totals.discount', 'totals.otherCharges', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.roundOff', 'totals.grandTotal'];
  const headerTitle = layout?.header?.title ?? 'Tax Invoice';
  const footerTerms = layout?.footer?.termsText;
  const showSignatory = layout?.footer?.showSignatory !== false;

  const sellerLine = fieldValue('seller.legalName', invoice, tax);
  const sellerTradeName = fieldValue('seller.tradeName', invoice, tax).value;
  const sellerRest = sellerFields.filter((f) => f !== 'seller.legalName' && f !== 'seller.tradeName' && f !== 'seller.gstin')
    .map((f) => fieldValue(f, invoice, tax).value).filter(Boolean).join(', ');
  const sellerGstin = fieldValue('seller.gstin', invoice, tax).value;

  const itemColHeaders = itemColumns.map((c) => `<th${RIGHT_ALIGNED.has(c) ? ' style="text-align:right"' : ''}>${itemColumnHeader(c)}</th>`).join('');
  const itemRows = items.map((item, idx) => `
    <tr>
      ${itemColumns.map((c) => `<td${RIGHT_ALIGNED.has(c) ? ' style="text-align:right;font-family:\'Courier New\',monospace"' : ''}>${itemColumnValue(c, item, idx)}</td>`).join('')}
    </tr>`).join('');

  const categoryTotals = items.reduce((acc: Record<string, { pieces: number; netWeight: number; amount: number }>, item) => {
    const key = item.category?.name ?? 'Uncategorized';
    const bucket = acc[key] ?? { pieces: 0, netWeight: 0, amount: 0 };
    bucket.pieces += Number(item.quantity) || 1;
    bucket.netWeight += Number(item.netGoldWeight) || 0;
    bucket.amount += Number(item.totalPrice) || 0;
    acc[key] = bucket;
    return acc;
  }, {});
  const categoryRows = Object.entries(categoryTotals);
  const categoryTableRows = categoryRows.map(([name, t]) => `
    <tr>
      <td>${name}</td>
      <td style="text-align:right">${t.pieces}</td>
      <td style="text-align:right">${t.netWeight.toFixed(3)}</td>
      <td style="text-align:right;font-family:'Courier New',monospace">₹ ${INR(t.amount)}</td>
    </tr>`).join('');

  const totalsRows = totalsFields
    .filter((f) => f !== 'totals.grandTotal')
    .filter((f) => !((f === 'totals.cgst' || f === 'totals.sgst') && isInterState) && !(f === 'totals.igst' && !isInterState))
    .filter((f) => {
      if (f === 'totals.otherCharges') return Number(invoice.otherCharges ?? 0) > 0;
      if (f === 'totals.discount') return Number(invoice.discountAmount ?? 0) > 0;
      if (f === 'totals.roundOff') return Math.abs(Number(invoice.roundOff ?? 0)) >= 0.005;
      return true;
    })
    .map((f) => {
      const { label, value } = fieldValue(f, invoice, tax);
      return row(label, value);
    }).join('');

  const eInvoiceSection = layout?.eInvoice?.enabled !== false && tax?.irn ? `
    <div class="info-box" style="margin-top:12px">
      <div class="title">e-Invoice</div>
      <div class="line">IRN: ${tax.irn}</div>
      ${tax.ackNumber ? `<div class="line">Ack No: ${tax.ackNumber}</div>` : ''}
      ${tax.ackDate ? `<div class="line">Ack Date: ${DATE(tax.ackDate)}</div>` : ''}
    </div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${headerTitle} — ${invoice.invoiceNumber}</title>
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
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #44C47A;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .logo-block { display: flex; align-items: center; gap: 12px; }
    .logo-circle {
      width: 48px; height: 48px; border-radius: 8px;
      background: #44C47A;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 900; color: #000;
    }
    .company-name { font-size: 20px; font-weight: 700; color: #44C47A; }
    .company-sub  { font-size: 11px; color: #666; margin-top: 2px; }
    .company-gstin { font-size: 11px; color: #444; margin-top: 4px; font-family: 'Courier New', monospace; }

    .doc-meta { text-align: right; }
    .doc-title { font-size: 16px; font-weight: 700; color: #333; letter-spacing: 0.05em; text-transform: uppercase; }
    .doc-number { font-size: 13px; font-family: 'Courier New', monospace; color: #44C47A; font-weight: 700; margin-top: 4px; }
    .doc-date   { font-size: 11px; color: #666; margin-top: 2px; }

    .info-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 0 24px;
      margin-bottom: 16px;
    }
    .info-box {
      background: #FAFAF5; border: 1px solid #EEE; border-radius: 8px; padding: 12px 14px;
    }
    .info-box .title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; margin-bottom: 6px; }
    .info-box .name { font-size: 14px; font-weight: 700; }
    .info-box .line { font-size: 12px; color: #444; margin-top: 2px; }

    .meta-strip {
      display: flex; gap: 24px; flex-wrap: wrap;
      font-size: 11px; color: #666;
      margin-bottom: 16px;
    }
    .meta-strip b { color: #1A1A1A; }

    table.items {
      width: 100%; border-collapse: collapse;
      margin-bottom: 12px;
    }
    table.items thead th {
      background: #FAFAF5; text-align: left;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #888;
      padding: 8px 10px; border-bottom: 2px solid #EEE;
    }
    table.items tbody td {
      padding: 8px 10px; border-bottom: 1px solid #F4F6FB; font-size: 12px; vertical-align: top;
    }

    .tax-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .tax-table tr.divider td { border-top: 1px solid #EEE; }
    .tax-table td { padding: 6px 12px; border-bottom: 1px solid #F4F6FB; }
    .tax-table td.label { color: #444; width: 60%; }
    .tax-table td.value { text-align: right; font-family: 'Courier New', monospace; font-size: 13px; }
    .tax-table td.bold { font-weight: 700; }
    .tax-table td.accent { color: #44C47A; font-size: 16px; }
    .tax-table tr.total-row { background: #FAFAF5; }

    .summary-wrap { display: flex; justify-content: flex-end; }
    .summary-box { width: 320px; }

    .footer {
      margin-top: 32px;
      border-top: 2px solid #44C47A;
      padding-top: 10px;
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #999;
    }

    .signature {
      margin-top: 40px;
      display: flex; justify-content: flex-end;
    }
    .signature-box { text-align: center; }
    .signature-line { border-top: 1px solid #999; width: 180px; margin-top: 40px; padding-top: 4px; font-size: 11px; color: #666; }

    .print-btn {
      display: flex; gap: 8px;
      justify-content: flex-end;
      padding: 12px 16px;
      background: #F5F5F5;
      position: sticky; top: 0; z-index: 100;
    }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-print { background: #44C47A; color: #fff; }
    .btn-close { background: #EEE; color: #333; }

    @media print {
      .print-btn { display: none; }
      .page { padding: 10mm 14mm; }
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
  <div class="header">
    <div class="logo-block">
      ${layout?.header?.showLogo === false ? '' : `<div class="logo-circle">${(sellerLine.value || 'S').charAt(0)}</div>`}
      <div>
        <div class="company-name">${sellerLine.value}${sellerTradeName ? ` <span style="font-size:12px;color:#666">(${sellerTradeName})</span>` : ''}</div>
        ${sellerRest ? `<div class="company-sub">${sellerRest}</div>` : ''}
        <div class="company-gstin">GSTIN: ${sellerGstin}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">${headerTitle}</div>
      <div class="doc-number">${invoice.invoiceNumber}</div>
      <div class="doc-date">${DATE(invoice.invoiceDate)}</div>
    </div>
  </div>

  <div class="meta-strip">
    ${invoiceMetaFields.filter((f) => f !== 'invoice.number' && f !== 'invoice.date').map((f) => {
      const { label, value } = fieldValue(f, invoice, tax);
      return value ? `<div>${label}: <b>${value}</b></div>` : '';
    }).join('')}
    <div>Supply Type: <b>${isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)'}</b></div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="title">Bill To</div>
      ${buyerFields.map((f) => {
        const { label, value } = fieldValue(f, invoice, tax);
        if (!value) return '';
        if (f === 'buyer.name') return `<div class="name">${value}</div>`;
        if (f === 'buyer.gstin') return `<div class="line">GSTIN: ${value}</div>`;
        return `<div class="line">${label}: ${value}</div>`;
      }).join('') || `<div class="line">Unregistered (B2C)</div>`}
    </div>
    <div class="info-box">
      <div class="title">Payment Status</div>
      <div class="line">Total: <b>₹ ${INR(invoice.totalAmount)}</b></div>
      <div class="line">Paid: ₹ ${INR(invoice.paidAmount ?? 0)}</div>
      <div class="line">Balance Due: <b>₹ ${INR(invoice.balanceDue ?? invoice.totalAmount)}</b></div>
    </div>
  </div>
  ${eInvoiceSection}

  <table class="items">
    <thead><tr>${itemColHeaders}</tr></thead>
    <tbody>
      ${itemRows || `<tr><td colspan="${itemColumns.length}" style="text-align:center;color:#999;padding:20px">No items</td></tr>`}
    </tbody>
  </table>

  ${categoryRows.length > 0 ? `
  <table class="items" style="margin-bottom:16px">
    <thead>
      <tr><th>By Category</th><th style="text-align:right">Pieces</th><th style="text-align:right">Net Wt (g)</th><th style="text-align:right">Amount</th></tr>
    </thead>
    <tbody>${categoryTableRows}</tbody>
  </table>` : ''}

  <div class="summary-wrap">
    <div class="summary-box">
      <table class="tax-table">
        <tbody>
          ${totalsRows}
          <tr class="divider total-row">
            <td class="label bold" style="font-size:15px">Total</td>
            <td class="value bold accent" style="font-size:18px">₹ ${INR(invoice.totalAmount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  ${showSignatory ? `
  <div class="signature">
    <div class="signature-box">
      <div class="signature-line">Authorized Signatory</div>
    </div>
  </div>` : ''}

  ${footerTerms ? `<div style="margin-top:16px;font-size:10px;color:#666">${footerTerms}</div>` : ''}

  <div class="footer">
    <span>${sellerLine.value} &nbsp;|&nbsp; Invoice No: ${invoice.invoiceNumber}</span>
    <span>Printed on ${new Date().toLocaleString('en-IN')}</span>
  </div>
</div>

</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => win.focus();
}
