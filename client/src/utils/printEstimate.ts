const INR = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function row(label: string, value: string, bold = false, accent = false) {
  return `
    <tr>
      <td class="label">${label}</td>
      <td class="value ${bold ? 'bold' : ''} ${accent ? 'accent' : ''}">${value}</td>
    </tr>`;
}

export function printEstimate(estimate: any, design: any) {
  const validUntil = new Date(estimate.validUntil).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
  const generatedOn = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const metalCost    = Number(estimate.metalCost);
  const stoneCost    = Number(estimate.stoneCost);
  const makingCharge = Number(estimate.makingCharges);
  const wastageAmt   = Number(estimate.wastageAmount);
  const totalCost    = Number(estimate.totalCost);
  const margin       = Number(estimate.marginPercent);
  const selling      = Number(estimate.sellingPrice);
  const spotRate     = Number(estimate.metalSpotRate);

  const netWeight = design
    ? ((Number(design.netWeightMin) + Number(design.netWeightMax)) / 2).toFixed(3)
    : '—';

  const companyName  = 'SEA Jewelry Pvt. Ltd.';
  const companyAddr  = 'Jewelry Manufacturing Division';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Cost Estimate — ${estimate.estimateNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13px;
      color: #1A1A1A;
      background: #fff;
      padding: 0;
    }

    /* ── Page layout ── */
    .page {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      padding: 14mm 16mm;
    }

    /* ── Header ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #44C47A;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    .logo-block { display: flex; align-items: center; gap: 12px; }
    .logo-circle {
      width: 48px; height: 48px; border-radius: 8px;
      background: linear-gradient(135deg, #44C47A, #44C47A);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 900; color: #000;
    }
    .company-name { font-size: 20px; font-weight: 700; color: #44C47A; }
    .company-sub  { font-size: 11px; color: #666; margin-top: 2px; }

    .doc-meta { text-align: right; }
    .doc-title { font-size: 16px; font-weight: 700; color: #333; letter-spacing: 0.05em; text-transform: uppercase; }
    .doc-number { font-size: 13px; font-family: 'Courier New', monospace; color: #44C47A; font-weight: 700; margin-top: 4px; }
    .doc-date   { font-size: 11px; color: #666; margin-top: 2px; }

    /* ── Watermark ── */
    .watermark {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-35deg);
      font-size: 80px; font-weight: 900;
      color: rgba(204,136,0,0.04);
      pointer-events: none; z-index: 0; white-space: nowrap;
    }

    /* ── Section titles ── */
    .section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.1em; color: #888;
      margin: 20px 0 8px;
    }

    /* ── Info grid (design details) ── */
    .info-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px 24px;
      background: #FAFAF5;
      border: 1px solid #EEE;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .info-item .key   { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; }
    .info-item .val   { font-size: 13px; font-weight: 600; color: #1A1A1A; margin-top: 2px; }

    /* ── Cost breakdown table ── */
    .cost-table {
      width: 100%; border-collapse: collapse;
      margin-top: 8px;
    }
    .cost-table tr.divider td { border-top: 1px solid #EEE; }
    .cost-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #F4F6FB;
    }
    .cost-table td.label  { color: #444; width: 60%; }
    .cost-table td.value  { text-align: right; font-family: 'Courier New', monospace; font-size: 13px; }
    .cost-table td.bold   { font-weight: 700; }
    .cost-table td.accent { color: #44C47A; font-size: 15px; }
    .cost-table tr.total-row { background: #FAFAF5; }
    .cost-table tr.price-row { background: linear-gradient(90deg, #FFF8E7, #FFF); }

    /* ── Margin badge ── */
    .margin-badge {
      display: inline-block; background: #FFF3CD;
      color: #856404; border: 1px solid #FFEAA7;
      border-radius: 4px; padding: 1px 8px;
      font-size: 11px; font-weight: 700;
    }

    /* ── Validity pill ── */
    .validity {
      display: flex; align-items: center; gap: 8px;
      background: #E8F5E9; border: 1px solid #C8E6C9;
      border-radius: 8px; padding: 10px 14px;
      margin-top: 20px;
    }
    .validity-icon { font-size: 18px; }
    .validity-text { font-size: 12px; color: #2E7D32; }
    .validity-date { font-weight: 700; }

    /* ── Notes ── */
    .notes {
      margin-top: 20px;
      font-size: 11px; color: #777;
      border-top: 1px solid #EEE;
      padding-top: 12px;
      line-height: 1.8;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 32px;
      border-top: 2px solid #44C47A;
      padding-top: 10px;
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #999;
    }

    /* ── Print button (hidden when printing) ── */
    .print-btn {
      display: flex; gap: 8px;
      justify-content: flex-end;
      padding: 12px 16px;
      background: #F5F5F5;
      position: sticky; top: 0; z-index: 100;
    }
    .btn {
      padding: 8px 20px; border: none; border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 600;
    }
    .btn-print  { background: #44C47A; color: #fff; }
    .btn-close  { background: #EEE; color: #333; }

    @media print {
      .print-btn { display: none; }
      .watermark { position: fixed; }
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
  <div class="watermark">ESTIMATE</div>

  <!-- Header -->
  <div class="header">
    <div class="logo-block">
      <div class="logo-circle">S</div>
      <div>
        <div class="company-name">${companyName}</div>
        <div class="company-sub">${companyAddr}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">Cost Estimate</div>
      <div class="doc-number">${estimate.estimateNumber}</div>
      <div class="doc-date">Generated: ${generatedOn}</div>
    </div>
  </div>

  <!-- Design Details -->
  <div class="section-title">Design Details</div>
  <div class="info-grid">
    <div class="info-item">
      <div class="key">Design Code</div>
      <div class="val">${design?.designCode ?? '—'}</div>
    </div>
    <div class="info-item">
      <div class="key">Design Name</div>
      <div class="val">${design?.name ?? '—'}</div>
    </div>
    <div class="info-item">
      <div class="key">Metal / Karat</div>
      <div class="val">${design?.metalKarat ?? '—'}</div>
    </div>
    <div class="info-item">
      <div class="key">Avg Net Weight</div>
      <div class="val">${netWeight} g</div>
    </div>
    <div class="info-item">
      <div class="key">Weight Range (Net)</div>
      <div class="val">${Number(design?.netWeightMin ?? 0).toFixed(3)} g — ${Number(design?.netWeightMax ?? 0).toFixed(3)} g</div>
    </div>
    <div class="info-item">
      <div class="key">Gold Spot Rate</div>
      <div class="val">₹ ${INR(spotRate)} / gram</div>
    </div>
  </div>

  <!-- Cost Breakdown -->
  <div class="section-title">Cost Breakdown</div>
  <table class="cost-table">
    <tbody>
      ${row('Metal Cost  &nbsp;<span style="font-size:10px;color:#999">(avg net wt × spot rate)</span>', `₹ ${INR(metalCost)}`)}
      ${row('Stone / Diamond Cost', `₹ ${INR(stoneCost)}`)}
      ${row('Making Charges', `₹ ${INR(makingCharge)}`)}
      ${row('Wastage Amount', `₹ ${INR(wastageAmt)}`)}
      <tr class="divider total-row">
        ${row('Total Cost (Ex-Margin)', `₹ ${INR(totalCost)}`, true)}
      </tr>
      <tr class="divider">
        ${row(`Profit Margin &nbsp;<span class="margin-badge">${margin}%</span>`, `₹ ${INR(selling - totalCost)}`)}
      </tr>
      <tr class="divider price-row">
        <td class="label bold" style="font-size:15px">Client Selling Price</td>
        <td class="value bold accent" style="font-size:18px">₹ ${INR(selling)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Validity -->
  <div class="validity">
    <span class="validity-icon">📅</span>
    <div class="validity-text">
      This estimate is valid until <span class="validity-date">${validUntil}</span>.
      Prices are subject to change based on daily metal rates after the validity date.
    </div>
  </div>

  <!-- Notes -->
  <div class="notes">
    <strong>Terms & Conditions:</strong><br>
    1. This is a cost estimate only. Final invoice price will be calculated using the metal rate on the date of billing.<br>
    2. Stone prices are based on current market rates and may vary based on final stone selection.<br>
    3. Making charges are fixed per the approved BOM and process routing.<br>
    4. An advance payment is required to confirm the order and reserve raw materials.<br>
    5. All prices are exclusive of GST (3% applicable on jewelry as per Government of India norms).
  </div>

  <!-- Footer -->
  <div class="footer">
    <span>${companyName} &nbsp;|&nbsp; Estimate No: ${estimate.estimateNumber}</span>
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
  // Give styles time to load before auto-focusing
  win.onload = () => win.focus();
}
