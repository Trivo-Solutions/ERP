const INR = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function row(label: string, value: string, bold = false, accent = false) {
  return `
    <tr>
      <td class="label">${label}</td>
      <td class="value ${bold ? 'bold' : ''} ${accent ? 'accent' : ''}">${value}</td>
    </tr>`;
}

export function printInvoice(invoice: any) {
  const items: any[] = invoice.items ?? [];
  const tax = invoice.taxDetails;

  const invoiceDate = new Date(invoice.invoiceDate).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const subtotal = Number(invoice.subtotal);
  const discount = Number(invoice.discountAmount ?? 0);
  const otherCharges = Number(invoice.otherCharges ?? 0);
  const taxAmount = Number(invoice.taxAmount ?? 0);
  const total = Number(invoice.totalAmount);
  const cgst = Number(tax?.cgst ?? 0);
  const sgst = Number(tax?.sgst ?? 0);
  const igst = Number(tax?.igst ?? 0);
  const isInterState = igst > 0;

  const companyName = 'SEA Jewelry Pvt. Ltd.';
  const companyAddr = 'Jewelry Wholesale & Retail Division';
  const companyGstin = tax?.gstin ?? '—';

  const itemRows = items.map((item, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td style="font-family:'Courier New',monospace;font-size:11px">${item.hsnCode?.code ?? '—'}</td>
      <td>
        <div>${item.description}</div>
        ${item.productCode ? `<div style="font-size:10px;color:#999">${item.productCode}${item.huid ? ` &nbsp;|&nbsp; HUID ${item.huid}` : ''}</div>` : ''}
      </td>
      <td style="font-size:11px">${item.category?.name ?? '—'}</td>
      <td style="text-align:right">${item.quantity}</td>
      <td style="text-align:right">${Number(item.netGoldWeight).toFixed(3)}</td>
      <td style="text-align:right">${item.taxRate != null ? (Number(item.taxRate) * 100).toFixed(0) + '%' : '—'}</td>
      <td style="text-align:right;font-family:'Courier New',monospace">₹ ${INR(Number(item.totalPrice))}</td>
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Tax Invoice — ${invoice.invoiceNumber}</title>
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
      display: flex; gap: 24px;
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
    table.items thead th:nth-child(4),
    table.items thead th:nth-child(5),
    table.items thead th:nth-child(6),
    table.items thead th:nth-child(7) { text-align: right; }
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
      <div class="logo-circle">S</div>
      <div>
        <div class="company-name">${companyName}</div>
        <div class="company-sub">${companyAddr}</div>
        <div class="company-gstin">GSTIN: ${companyGstin}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">Tax Invoice</div>
      <div class="doc-number">${invoice.invoiceNumber}</div>
      <div class="doc-date">${invoiceDate}</div>
    </div>
  </div>

  <div class="meta-strip">
    <div>Invoice Type: <b>${invoice.invoiceType}</b></div>
    <div>Currency: <b>${invoice.currency}</b></div>
    <div>Place of Supply: <b>${tax?.placeOfSupply || '—'}</b></div>
    <div>Supply Type: <b>${isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)'}</b></div>
    ${invoice.salesPerson?.name ? `<div>Sales Executive: <b>${invoice.salesPerson.name}</b></div>` : ''}
    ${invoice.terms ? `<div>Terms: <b>${invoice.terms}</b></div>` : ''}
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="title">Bill To</div>
      <div class="name">${invoice.client?.name ?? '—'}</div>
      ${invoice.client?.address ? `<div class="line">${invoice.client.address}</div>` : ''}
      ${invoice.client?.city || invoice.client?.state ? `<div class="line">${[invoice.client?.city, invoice.client?.state].filter(Boolean).join(', ')}</div>` : ''}
      <div class="line">${invoice.client?.gstNumber ? `GSTIN: ${invoice.client.gstNumber}` : 'Unregistered (B2C)'}</div>
      ${invoice.client?.phone ? `<div class="line">${invoice.client.phone}</div>` : ''}
    </div>
    <div class="info-box">
      <div class="title">Payment Status</div>
      <div class="line">Total: <b>₹ ${INR(total)}</b></div>
      <div class="line">Paid: ₹ ${INR(Number(invoice.paidAmount ?? 0))}</div>
      <div class="line">Balance Due: <b>₹ ${INR(Number(invoice.balanceDue ?? total))}</b></div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th>#</th><th>HSN</th><th>Description</th><th>Category</th><th>Qty</th><th>Net Wt (g)</th><th>GST</th><th>Amount</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows || '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">No items</td></tr>'}
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
          ${row('Subtotal', `₹ ${INR(subtotal)}`)}
          ${otherCharges > 0 ? row('Shipping / Other Charges', `+ ₹ ${INR(otherCharges)}`) : ''}
          ${discount > 0 ? row('Discount', `- ₹ ${INR(discount)}`) : ''}
          ${!isInterState ? row('CGST', `₹ ${INR(cgst)}`) : ''}
          ${!isInterState ? row('SGST', `₹ ${INR(sgst)}`) : ''}
          ${isInterState ? row('IGST', `₹ ${INR(igst)}`) : ''}
          <tr class="divider total-row">
            <td class="label bold" style="font-size:15px">Total</td>
            <td class="value bold accent" style="font-size:18px">₹ ${INR(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="signature">
    <div class="signature-box">
      <div class="signature-line">Authorized Signatory</div>
    </div>
  </div>

  <div class="footer">
    <span>${companyName} &nbsp;|&nbsp; Invoice No: ${invoice.invoiceNumber}</span>
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
