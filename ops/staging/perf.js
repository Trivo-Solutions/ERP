// Performance baseline over the real stack. Both companies hold ~20k tags / 5k clients / 5k invoices.
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
// usage: node perf.js
const fs = require('fs');
const V = JSON.parse(fs.readFileSync(HARNESS + '/VASAVI.json'));
const S = JSON.parse(fs.readFileSync(HARNESS + '/SHREE.json'));
const API = 'http://localhost:8080/api/v1';
const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function call(token, method, path, body) {
  const t = now();
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ms: now() - t, bytes: Buffer.byteLength(text), text };
}
async function login(c) { const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyCode: c.code, identifier: c.email, password: c.password }) }); return (await r.json()).data; }

(async () => {
  const vt = (await login(V)).accessToken, st = (await login(S)).accessToken;
  const today = new Date(); const from = new Date(today.getTime() - 400 * 864e5).toISOString(), to = today.toISOString();
  const clientId = JSON.parse((await call(vt, 'GET', '/orders/clients')).text).data[10].id;
  const READS = [
    ['GET /tagging/tags (page of 30)', '/tagging/tags?limit=30'],
    ['GET /tagging/tags?status=IN_STOCK', '/tagging/tags?status=IN_STOCK&limit=30'],
    ['GET /tagging/tags/search?q=', '/tagging/tags/search?q=Ring%2012'],
    ['GET /tagging/tags/search (huid)', '/tagging/tags/search?q=HVAS0000001'],
    ['GET /orders/clients (all 5k)', '/orders/clients'],
    ['GET /sales/invoices', '/sales/invoices'],
    ['GET /finance/journals', '/finance/journals'],
    ['GET /finance/accounts', '/finance/accounts'],
    ['GET /finance/reports/trial-balance', '/finance/reports/trial-balance'],
    ['GET /finance/reports/pnl (1y)', `/finance/reports/pnl?from=${from}&to=${to}`],
    ['GET /finance/reports/balance-sheet', '/finance/reports/balance-sheet'],
    ['GET /finance/reports/dealer-aging', '/finance/reports/dealer-aging'],
    ['GET /finance/reports/day-book', '/finance/reports/day-book'],
    ['GET /finance/reports/gst-summary (1y)', `/finance/reports/gst-summary?from=${from}&to=${to}`],
    ['GET /finance/reports/client-ledger/:id', `/finance/reports/client-ledger/${clientId}`],
    ['GET /sales/reports/register (1y)', `/sales/reports/register?from=${from}&to=${to}`],
    ['GET /tagging/reports/stock-on-hand', '/tagging/reports/stock-on-hand'],
    ['GET /tagging/reports/dead-stock', '/tagging/reports/dead-stock'],
    ['GET /tagging/branches/stock-summary', '/tagging/branches/stock-summary'],
    ['GET /reports/dashboard', '/reports/dashboard'],
    ['GET /masters/karats', '/masters/karats'],
  ];
  const rows = [];
  for (const [name, path] of READS) {
    for (const [co, tok] of [['VASAVI', vt], ['SHREE', st]]) {
      await call(tok, 'GET', path); // warm
      const ms = []; let bytes = 0, status = 0;
      for (let i = 0; i < 12; i++) { const r = await call(tok, 'GET', path); ms.push(r.ms); bytes = r.bytes; status = r.status; }
      rows.push({ name, co, status, p50: +pct(ms, 50).toFixed(0), p95: +pct(ms, 95).toFixed(0), max: +Math.max(...ms).toFixed(0), kb: +(bytes / 1024).toFixed(0) });
    }
  }
  console.log('\nSEQUENTIAL (12 samples each; ms)');
  console.log('endpoint'.padEnd(44), 'co'.padEnd(7), 'st', 'p50'.padStart(6), 'p95'.padStart(6), 'max'.padStart(6), 'KB'.padStart(7));
  for (const r of rows) console.log(r.name.padEnd(44), r.co.padEnd(7), r.status, String(r.p50).padStart(6), String(r.p95).padStart(6), String(r.max).padStart(6), String(r.kb).padStart(7));

  // ── concurrent mixed read load: 30 workers, both companies, 15s ──
  const mix = ['/tagging/tags?limit=30', '/tagging/tags/search?q=Ring%201', '/orders/clients', '/sales/invoices', '/finance/reports/dealer-aging', '/reports/dashboard', '/tagging/reports/stock-on-hand', '/finance/reports/day-book', '/masters/categories'];
  const lat = []; let errors = 0, total = 0; const end = Date.now() + 15000;
  const worker = async (i) => { const tok = i % 2 ? vt : st; let k = i; while (Date.now() < end) { const r = await call(tok, 'GET', mix[k++ % mix.length]); total++; lat.push(r.ms); if (r.status >= 400) errors++; } };
  const t0 = Date.now(); await Promise.all(Array.from({ length: 30 }, (_, i) => worker(i)));
  const secs = (Date.now() - t0) / 1000;
  console.log(`\nCONCURRENT READ MIX: 30 workers × 15s, 2 companies interleaved: ${total} requests, ${(total / secs).toFixed(1)} req/s, errors ${errors}, p50 ${pct(lat, 50).toFixed(0)}ms p95 ${pct(lat, 95).toFixed(0)}ms p99 ${pct(lat, 99).toFixed(0)}ms max ${Math.max(...lat).toFixed(0)}ms`);

  // ── write path: real invoices (validate → flip tag → journal → balance) ──
  const writeRun = async (label, tok, cid, branchId, conc, n) => {
    const st_ = JSON.parse((await call(tok, 'GET', '/tagging/tags?status=IN_STOCK&limit=' + Math.min(200, n + 20))).text).tags;
    const clients = JSON.parse((await call(tok, 'GET', '/orders/clients')).text).data;
    let idx = 0; const ms = []; let ok = 0, bad = 0; const errs = {};
    const w = async () => { while (idx < n) { const i = idx++; const tag = st_[i]; const r = await call(tok, 'POST', '/sales/invoices', { clientId: clients[i % clients.length].id, branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', items: [{ productCode: tag.tagNumber, description: tag.name, quantity: 1, grossWeight: Number(tag.grossWeight), netGoldWeight: Number(tag.netWeight), rateType: 'FIXED', goldRate: Number(tag.sellingPrice) || 1000, makingCharge: 0, tagId: tag.id }], payments: [{ mode: 'CASH', amount: 1 }] }); ms.push(r.ms); if (r.status === 201) ok++; else { bad++; errs[r.status + ' ' + r.text.slice(0, 90)] = (errs[r.status + ' ' + r.text.slice(0, 90)] ?? 0) + 1; } } };
    const t = Date.now(); await Promise.all(Array.from({ length: conc }, w)); const s2 = (Date.now() - t) / 1000;
    console.log(`  ${label}: ${n} invoices @${conc} concurrent → ${ok} ok / ${bad} failed, ${(ok / s2).toFixed(1)} inv/s, p50 ${pct(ms, 50).toFixed(0)}ms p95 ${pct(ms, 95).toFixed(0)}ms max ${Math.max(...ms).toFixed(0)}ms`, bad ? JSON.stringify(errs) : '');
  };
  console.log('\nWRITE PATH (POST /sales/invoices, tag-aware, with journal + payment)');
  await writeRun('VASAVI sequential', vt, V.companyId, V.branchId, 1, 30);
  await writeRun('VASAVI 10 concurrent', vt, V.companyId, V.branchId, 10, 100);
  await Promise.all([writeRun('VASAVI 8 concurrent (both)', vt, V.companyId, V.branchId, 8, 80), writeRun('SHREE  8 concurrent (both)', st, S.companyId, S.branchId, 8, 80)]);
  console.log('\nresult written'); fs.writeFileSync(HARNESS + '/perf-result.json', JSON.stringify({ rows, at: new Date().toISOString() }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
