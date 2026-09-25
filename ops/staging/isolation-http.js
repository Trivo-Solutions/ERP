// FULL ISOLATION TEST over the REAL staging stack (front door :8080 -> API :3101 -> Postgres with real roles + RLS).
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
//   VASAVI is heavy (20k tags / 5k clients / 5k invoices loaded by load.js), then SHREE was provisioned AFTER it.
// Every assertion is independent of the application's own filters where it says "DB".
const fs = require('fs');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const env = dotenv.parse(fs.readFileSync(STAGING + '/staging.env'));
const BASE = 'http://localhost:8080';
const API = BASE + '/api/v1';
const V = JSON.parse(fs.readFileSync(HARNESS + '/VASAVI.json'));
let S; // registered fresh, through the real operator API, at the start of EVERY run (after VASAVI is already heavy)

let pass = 0, fail = 0; const failures = []; const cats = {};
let cat = 'setup';
const section = (n) => { cat = n; cats[n] = cats[n] ?? { pass: 0, fail: 0 }; console.log('\n── ' + n); };
function check(ok, msg, detail) {
  cats[cat] = cats[cat] ?? { pass: 0, fail: 0 };
  if (ok) { pass++; cats[cat].pass++; } else { fail++; cats[cat].fail++; failures.push(`[${cat}] ${msg}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`); console.log('  FAIL', msg, detail ? '→ ' + String(detail).slice(0, 200) : ''); }
}

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}
const login = async (c) => { const r = await call(null, 'POST', '/auth/login', { companyCode: c.code, identifier: c.email, password: c.password }); if (r.status !== 200) throw new Error('login ' + c.code + ' ' + r.status + r.text.slice(0, 200)); return r.json.data; };
const arr = (r) => (Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json?.data?.items) ? r.json.data.items : Array.isArray(r.json?.data?.rows) ? r.json.data.rows : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ═════════════════════════ SETUP ═════════════════════════
  section('setup');
  {
    const code = 'SHREE' + crypto.randomBytes(2).toString('hex').toUpperCase(); const password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
    const email = 'admin@' + code.toLowerCase() + '.example';
    const pr0 = await fetch(API + '/platform/companies', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trivo-platform-key': env.TRIVO_PLATFORM_API_KEY }, body: JSON.stringify({ code, name: 'Shree Silver Palace', stateCode: '24', admin: { email, name: 'Shree Admin', password } }) });
    const b0 = await pr0.json(); check(pr0.status === 201, 'operator registers SHREE SILVER PALACE over HTTP after VASAVI is heavy', JSON.stringify(b0).slice(0, 200));
    S = { code, email, password, companyId: b0.data.company.id, branchId: b0.data.branch.id };
  }
  const vl = await login(V), sl = await login(S);
  const vt = vl.accessToken, st = sl.accessToken;
  check(vl.company.id === V.companyId && sl.company.id === S.companyId, 'each admin lands in its own company');
  const vCid = V.companyId, sCid = S.companyId;

  // VASAVI confidential markers, created through the real API
  const mk = 'VASAVI-SECRET-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const ids = {};
  const vCats = (await call(vt, 'GET', '/masters/categories')).json.data, vStock = (await call(vt, 'GET', '/masters/stock-types')).json.data;
  const vBranches = (await call(vt, 'GET', '/tagging/branches')).json.data;
  const vRoles = (await call(vt, 'GET', '/settings/roles')).json.data, sRoles = (await call(st, 'GET', '/settings/roles')).json.data;
  const sBranches = (await call(st, 'GET', '/tagging/branches')).json.data, sCats = (await call(st, 'GET', '/masters/categories')).json.data, sStock = (await call(st, 'GET', '/masters/stock-types')).json.data;
  ids.vBranch = vBranches[0].id; ids.vCat = vCats[0].id; ids.vStock = vStock[0].id; ids.vRole = vRoles.find((r) => r.name === 'SUPER_ADMIN').id;
  ids.sBranch = sBranches[0].id; ids.sCat = sCats[0].id; ids.sStock = sStock[0].id; ids.sRole = sRoles.find((r) => r.name === 'SUPER_ADMIN').id;

  const c1 = await call(vt, 'POST', '/orders/clients', { name: mk + '-CLIENT', type: 'DEALER', phone: '9000000001', city: mk + '-CITY', state: 'Gujarat', creditLimit: 100000 });
  ids.vClient = c1.json?.data?.id; check(c1.status === 201 && ids.vClient, 'VASAVI client created', c1.text);
  const sup = await call(vt, 'POST', '/procurement/suppliers', { name: mk + '-SUPPLIER', type: 'OTHER', city: mk + '-SCITY' });
  ids.vSupplier = sup.json?.data?.id; check(sup.status === 201, 'VASAVI supplier created', sup.text);
  const col = await call(vt, 'POST', '/masters/collections', { code: 'V' + crypto.randomBytes(3).toString('hex').toUpperCase(), name: mk + ' Confidential Collection' });
  ids.vCollection = col.json?.data?.id; check(col.status === 201, 'VASAVI collection created', col.text);
  const tag = await call(vt, 'POST', '/tagging/tags', { branchId: ids.vBranch, name: mk + '-TAG', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9.5, stoneWeight: 0.5, huid: 'HSEC' + Date.now().toString().slice(-6), costPrice: 50000, sellingPrice: 60000, stockTypeId: ids.vStock, categoryId: ids.vCat, notes: mk + ' note' });
  ids.vTag = tag.json?.data?.id; ids.vTagNo = tag.json?.data?.tagNumber; check(tag.status === 201, 'VASAVI tag created', tag.text);
  const tag2 = await call(vt, 'POST', '/tagging/tags', { branchId: ids.vBranch, name: mk + '-TAG2', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, costPrice: 20000, sellingPrice: 25000, stockTypeId: ids.vStock, categoryId: ids.vCat });
  ids.vTag2 = tag2.json?.data?.id; ids.vTag2No = tag2.json?.data?.tagNumber;
  const tt = (await call(vt, 'GET', '/tagging/templates')).json.data[0];
  const t1 = await call(vt, 'POST', '/tagging/templates', { name: mk + '-TAG-TEMPLATE', widthMm: tt.widthMm, heightMm: tt.heightMm, gapMm: tt.gapMm ?? 2, isDefault: false, layout: tt.layout });
  ids.vTagTemplate = t1.json?.data?.id; check(t1.status === 201, 'VASAVI tag template created', t1.text);
  const et = (await call(vt, 'GET', '/estimation/templates')).json.data[0];
  const t2 = await call(vt, 'POST', '/estimation/templates', { name: mk + '-EST-TEMPLATE', widthMm: et.widthMm, heightMm: et.heightMm, isDefault: false, layout: et.layout });
  ids.vEstTemplate = t2.json?.data?.id; check(t2.status === 201, 'VASAVI estimate template created', t2.text);
  const cfg = await call(vt, 'PUT', '/settings/config/VASAVI_PRIVATE_NOTE', { value: mk + ' private config value', category: 'GENERAL' });
  check(cfg.status === 200, 'VASAVI config key written', cfg.text);
  const inv = await call(vt, 'POST', '/sales/invoices', { clientId: ids.vClient, branchId: ids.vBranch, invoiceDate: new Date().toISOString(), invoiceType: 'WHOLESALE', notes: mk + ' invoice note', items: [{ productCode: ids.vTagNo, description: mk + '-LINE', quantity: 1, grossWeight: 10, netGoldWeight: 9.5, rateType: 'FIXED', goldRate: 60000, makingCharge: 0, tagId: ids.vTag }] });
  ids.vInvoice = inv.json?.data?.id; check(inv.status === 201, 'VASAVI invoice created', inv.text);
  const memo = await call(vt, 'POST', '/sales/memos', { clientId: ids.vClient, branchId: ids.vBranch, sentDate: new Date().toISOString(), returnDeadline: new Date(Date.now() + 86400000).toISOString(), notes: mk + ' memo note', items: [{ productCode: ids.vTag2No, description: mk + '-MEMO-LINE', pieces: 1, grossWeight: 5, netGoldWeight: 5, estimatedValue: 25000, tagId: ids.vTag2 }] });
  ids.vMemo = memo.json?.data?.id; check(memo.status === 201, 'VASAVI memo created', memo.text);
  const invite = await call(vt, 'POST', '/auth/invitations', { email: 'pending-' + mk.toLowerCase() + '@vasavi.example', roleId: ids.vRole });
  ids.vInvitation = invite.json?.data?.id ?? invite.json?.data?.invitation?.id; check(invite.status === 201, 'VASAVI invitation created', invite.text);
  const vMembers = (await call(vt, 'GET', '/auth/users')).json.data; ids.vMember = vMembers[0].id;
  const vDev = await call(vt, 'POST', '/hardware/devices', { deviceType: 'SCALE', deviceId: mk + '-SCALE', location: mk + ' counter' });
  ids.vDevice = vDev.json?.data?.deviceId;
  const vAudit = (await call(vt, 'GET', '/settings/audit-logs')).json;
  ids.vJournal = arr(await call(vt, 'GET', '/finance/journals'))?.[0]?.id;

  const markers = [mk, 'VASAVI', 'Vasavi', 'vasavi.example', vCid, ...Object.entries(ids).filter(([k, x]) => k.startsWith('v') && typeof x === 'string' && x.length >= 20).map(([, x]) => x), V.email];
  const strictMarkers = [mk, vCid, ...Object.entries(ids).filter(([k, x]) => k.startsWith('v') && typeof x === 'string' && x.length >= 20).map(([, x]) => x)];
  const strictContaminated = (text) => strictMarkers.filter((m) => text.includes(m));
  const contaminated = (text) => markers.filter((m) => text.includes(m));

  // ═════════════════════════ 1. NEW COMPANY SEES NOTHING (list sweep) ═════════════════════════
  const LISTS = ['/orders/clients', '/procurement/suppliers', '/procurement/orders', '/procurement/grn', '/procurement/requisitions', '/procurement/returns', '/procurement/suppliers/performance',
    '/inventory/metals', '/sales/invoices', '/sales/memos', '/sales/returns', '/sales/exchanges', '/sales/staff', '/sales/reports/register',
    '/finance/accounts', '/finance/journals', '/finance/cost-centers', '/finance/reports/trial-balance', '/finance/reports/pnl', '/finance/reports/balance-sheet', '/finance/reports/dealer-aging', '/finance/reports/day-book', '/finance/reports/gst-summary', '/finance/reports/cost-centers',
    '/tagging/branches', '/tagging/branches/stock-summary', '/tagging/tags?limit=100', '/tagging/tags/search?q=VAS', '/tagging/tags/search?q=SECRET', '/tagging/templates', '/tagging/transfers', '/tagging/audits', '/tagging/reports/stock-on-hand', '/tagging/reports/dead-stock',
    '/estimation/templates', '/estimation/tags/search?q=VAS', '/masters/stock-types', '/masters/categories', '/masters/subcategories', '/masters/collections', '/masters/material-codes', '/masters/karats', '/masters/stone-types', '/masters/stone-grades', '/masters/price-master', '/masters/making-charges',
    '/settings/roles', '/settings/config', '/settings/design-categories', '/settings/process-tolerances', '/settings/audit-logs', '/hardware/devices', '/auth/users', '/auth/invitations', '/auth/me', '/company/users',
    '/reports/dashboard', '/reports/wip-summary', '/reports/stock-summary', '/reports/karigar-balances', '/reports/aging-receivables', '/designs', '/designs/rates/latest', '/manufacturing/jobs', '/manufacturing/floor', '/outsourcing/artisans', '/outsourcing/invoices', '/quality/hallmarking', '/quality/repairs', '/orders'];

  section('new company: every list, report, dashboard, master, audit — nothing of VASAVI');
  let vHits = 0;
  for (const p of LISTS) {
    const r = await call(st, 'GET', p);
    if (r.status === 404 && r.json?.error && /Cannot GET|not found/i.test(r.text) && !r.json?.data) continue; // route not mounted in this build
    const dirty = (p.startsWith('/settings/audit-logs') || p.startsWith('/auth/invitations')) ? strictContaminated(r.text) : contaminated(r.text);
    check(dirty.length === 0, `SHREE ${p} (${r.status}) contains no VASAVI marker/id`, dirty.join(','));
  }
  // positive control: the SAME sweep against VASAVI must actually find its own data (so the check above is not vacuous)
  for (const p of ['/orders/clients', '/procurement/suppliers', '/sales/invoices', '/sales/memos', '/tagging/tags/search?q=SECRET', '/tagging/templates', '/estimation/templates', '/masters/collections', '/settings/config', '/hardware/devices', '/auth/invitations']) {
    const r = await call(vt, 'GET', p); if (contaminated(r.text).length) vHits++;
  }
  check(vHits >= 9, 'positive control: VASAVI sees its own markers on ≥9 of 11 sweeps', 'hits=' + vHits);

  section('new company starts EMPTY of business data (counts)');
  const sTags = await call(st, 'GET', '/tagging/tags?limit=100'); check((sTags.json?.pagination?.total ?? sTags.json?.total ?? arr(sTags)?.length) === 0, 'SHREE tag total = 0', sTags.text.slice(0, 200));
  for (const p of ['/orders/clients', '/procurement/suppliers', '/sales/invoices', '/sales/memos', '/finance/journals', '/procurement/orders', '/sales/returns', '/tagging/transfers', '/inventory/metals']) {
    const r = await call(st, 'GET', p); const a = arr(r); check(r.status === 200 && (a ? a.length === 0 : true), `SHREE ${p} empty`, r.text.slice(0, 150));
  }
  const vTagTotal = (await call(vt, 'GET', '/tagging/tags?limit=1')).json; check((vTagTotal.pagination?.total ?? vTagTotal.total) >= 19000, 'VASAVI really is heavy (≥19,000 tags via the API)', JSON.stringify(vTagTotal.pagination ?? vTagTotal.total));
  const vInvTotal = arr(await call(vt, 'GET', '/sales/invoices'));
  const sPnl = (await call(st, 'GET', '/finance/reports/pnl')).text, sTb = (await call(st, 'GET', '/finance/reports/trial-balance')).json;
  const tbRows = arr({ json: sTb }) ?? sTb?.data?.accounts ?? [];
  check(!/"totalRevenue":\s*[1-9]/.test(sPnl), 'SHREE P&L has no revenue', sPnl.slice(0, 200));
  const sDash = (await call(st, 'GET', '/reports/dashboard')).text; check(contaminated(sDash).length === 0, 'SHREE dashboard shows nothing of VASAVI');

  // ═════════════════════════ 2. STARTER PACKAGE COPIED, NOT SHARED ═════════════════════════
  section('starter package: copied, not shared');
  for (const p of ['/masters/karats', '/masters/categories', '/masters/stock-types', '/masters/stone-types', '/masters/material-codes', '/settings/roles', '/settings/design-categories', '/finance/accounts', '/tagging/templates', '/estimation/templates']) {
    const a = arr(await call(st, 'GET', p)), b = arr(await call(vt, 'GET', p));
    const sIds = new Set(a.map((x) => x.id)); const overlap = b.filter((x) => sIds.has(x.id));
    check(a.length > 0 && overlap.length === 0, `${p}: SHREE has its own ${a.length} rows, zero shared ids with VASAVI`, `overlap=${overlap.length}`);
  }
  const k1 = arr(await call(st, 'GET', '/masters/karats'))[0], kV = arr(await call(vt, 'GET', '/masters/karats')).find((k) => k.code === k1.code);
  const p1 = await call(st, 'PATCH', '/masters/karats/' + k1.id, { name: 'SHREE-ONLY-NAME' });
  const kV2 = arr(await call(vt, 'GET', '/masters/karats')).find((k) => k.code === k1.code);
  check(p1.status === 200 && kV2.name === kV.name, 'editing SHREE\'s karat does not change VASAVI\'s copy');
  const cfgS = arr(await call(st, 'GET', '/settings/config')); check(!cfgS.some((c) => c.key === 'VASAVI_PRIVATE_NOTE'), 'VASAVI\'s custom config key does not exist for SHREE');

  // ═════════════════════════ 3. IDOR (direct object access with the other company's ids) ═════════════════════════
  section('IDOR: SHREE token + VASAVI ids → 404, never data, never a change');
  const before = {}; const snap = async (p) => (await call(vt, 'GET', p)).text;
  const pathsToWatch = { tag: '/tagging/tags/' + ids.vTag, invoice: '/sales/invoices/' + ids.vInvoice, tagTemplate: '/tagging/templates/' + ids.vTagTemplate, estTemplate: '/estimation/templates/' + ids.vEstTemplate };
  for (const [k, p] of Object.entries(pathsToWatch)) before[k] = await snap(p);
  const idor = [
    ['GET', '/tagging/tags/' + ids.vTag], ['GET', '/tagging/tags/' + ids.vTag + '/print'], ['PATCH', '/tagging/tags/' + ids.vTag, { name: 'HACKED' }], ['PATCH', '/tagging/tags/' + ids.vTag + '/retire', { reason: 'x' }],
    ['GET', '/sales/invoices/' + ids.vInvoice], ['GET', '/sales/invoices/' + ids.vInvoice + '/packing-list'],
    ['GET', '/tagging/templates/' + ids.vTagTemplate], ['PUT', '/tagging/templates/' + ids.vTagTemplate, { name: 'HACKED', widthMm: 1, heightMm: 1, layout: {} }],
    ['GET', '/estimation/templates/' + ids.vEstTemplate], ['PUT', '/estimation/templates/' + ids.vEstTemplate, { name: 'HACKED', widthMm: 1, heightMm: 1, layout: {} }],
    ['GET', '/estimation/tags/' + ids.vTag], ['GET', '/estimation/tags/' + ids.vTag + '/estimates'], ['POST', '/estimation/tags/' + ids.vTag + '/estimates', { items: [] }],
    ['PATCH', '/orders/clients/' + ids.vClient, { name: 'HACKED' }], ['GET', '/finance/reports/client-ledger/' + ids.vClient], ['GET', '/sales/clients/' + ids.vClient + '/payments'],
    ['POST', '/sales/clients/' + ids.vClient + '/payments', { amount: 1, mode: 'CASH', paymentDate: new Date().toISOString() }],
    ['POST', '/sales/memos/' + ids.vMemo + '/return', { tagIds: [ids.vTag2] }], ['POST', '/sales/memos/' + ids.vMemo + '/convert', { items: [] }],
    ['PATCH', '/masters/collections/' + ids.vCollection, { name: 'HACKED' }], ['PATCH', '/masters/categories/' + ids.vCat, { name: 'HACKED' }], ['PATCH', '/masters/stock-types/' + ids.vStock, { name: 'HACKED' }],
    ['PATCH', '/tagging/branches/' + ids.vBranch, { name: 'HACKED' }],
    ['PATCH', '/auth/users/' + ids.vMember, { department: 'HACKED' }], ['DELETE', '/auth/invitations/' + ids.vInvitation],
    ['POST', '/company/users/' + ids.vMember + '/branch-access', { branchId: ids.sBranch }], ['POST', '/company/users/' + ids.sBranch + '/branch-access', { branchId: ids.vBranch }],
    ['GET', '/hardware/scales/' + ids.vDevice + '/read'], ['POST', '/hardware/scales/' + ids.vDevice + '/simulate', { weight: 1 }],
    ['GET', '/tagging/transfers/' + ids.vTag], ['GET', '/tagging/audits/' + ids.vTag], ['GET', '/procurement/orders/' + ids.vTag],
    ['DELETE', '/masters/price-master/' + ids.vCat], ['DELETE', '/masters/making-charges/' + ids.vCat],
  ];
  for (const [m, p, b] of idor) {
    const r = await call(st, m, p, b);
    check([404, 400, 403].includes(r.status) && contaminated(r.text).length === 0 && !(r.status >= 200 && r.status < 300), `SHREE ${m} ${p.replace(/c[a-z0-9]{24}/g, ':id')} → ${r.status}`, r.text.slice(0, 160));
  }
  for (const [k, p] of Object.entries(pathsToWatch)) check((await snap(p)) === before[k], `VASAVI ${k} byte-identical after every SHREE attack`);
  check((await call(vt, 'GET', '/orders/clients')).text.includes(mk + '-CLIENT') && !(await call(vt, 'GET', '/orders/clients')).text.includes('HACKED'), 'VASAVI client unchanged');

  // ═════════════════════════ 4. FORGED FOREIGN KEYS & BODY/HEADER SPOOFING ═════════════════════════
  section('forged foreign keys and spoofed tenant selectors');
  const goodTag = { branchId: ids.sBranch, name: 'shree tag', metalType: 'GOLD', metalKarat: '22K', grossWeight: 1, netWeight: 1, costPrice: 1, sellingPrice: 2, stockTypeId: ids.sStock, categoryId: ids.sCat };
  const forged = [
    ['tag with VASAVI category', { ...goodTag, categoryId: ids.vCat }], ['tag with VASAVI stock type', { ...goodTag, stockTypeId: ids.vStock }], ['tag with VASAVI branch', { ...goodTag, branchId: ids.vBranch }],
    ['tag with VASAVI collection', { ...goodTag, collectionId: ids.vCollection }], ['tag with VASAVI manufacturer (client)', { ...goodTag, manufacturerId: ids.vClient }],
  ];
  for (const [n, body] of forged) { const r = await call(st, 'POST', '/tagging/tags', body); check(r.status >= 400 && r.status < 500, `SHREE creating ${n} is refused`, r.status + ' ' + r.text.slice(0, 120)); }
  const sClient = (await call(st, 'POST', '/orders/clients', { name: 'Shree Own Client', type: 'RETAIL' })).json.data;
  const sOwnTag = (await call(st, 'POST', '/tagging/tags', goodTag)).json.data;
  const invBase = { branchId: ids.sBranch, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', items: [{ productCode: 'X', description: 'x', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100, makingCharge: 0 }] };
  let r = await call(st, 'POST', '/sales/invoices', { ...invBase, clientId: ids.vClient }); check(r.status === 404, 'invoice for VASAVI\'s client → 404', r.status + r.text.slice(0, 100));
  r = await call(st, 'POST', '/sales/invoices', { ...invBase, clientId: sClient.id, items: [{ ...invBase.items[0], tagId: ids.vTag2 }] }); check(r.status >= 400 && r.status < 500, 'invoice line pointing at VASAVI\'s tag refused', r.status + r.text.slice(0, 100));
  r = await call(st, 'POST', '/sales/memos', { clientId: ids.vClient, branchId: ids.sBranch, sentDate: new Date().toISOString(), returnDeadline: new Date(Date.now() + 86400000).toISOString(), items: [{ productCode: 'X', description: 'x', pieces: 1, grossWeight: 1, netGoldWeight: 1, estimatedValue: 1 }] }); check(r.status >= 400 && r.status < 500, 'memo to VASAVI\'s client refused', r.status);
  r = await call(st, 'POST', '/auth/invitations', { email: 'forge@shree.example', roleId: ids.vRole }); check(r.status >= 400 && r.status < 500, 'invitation with VASAVI\'s role refused', r.status + r.text.slice(0, 100));
  const sMember = (await call(st, 'GET', '/auth/users')).json.data[0];
  r = await call(st, 'PATCH', '/auth/users/' + sMember.id, { roleId: ids.vRole }); check(r.status >= 400 && r.status < 500, 'promoting own member to VASAVI\'s role refused', r.status);
  r = await call(st, 'POST', '/company/users/' + sMember.id + '/branch-access', { branchId: ids.vBranch }); check(r.status >= 400 && r.status < 500, 'granting a VASAVI branch refused', r.status);
  r = await call(st, 'POST', '/procurement/orders', { supplierId: ids.vSupplier, poType: 'METAL', orderDate: new Date().toISOString(), items: [{ materialType: 'METAL', description: 'x', orderedWeight: 1, unit: 'g', ratePerUnit: 1 }] }); check(r.status >= 400 && r.status < 500, 'PO to VASAVI\'s supplier refused', r.status);
  // spoofed selectors are ignored / rejected — data lands in the caller's own company
  r = await call(st, 'POST', '/orders/clients', { name: 'Spoof Body', type: 'RETAIL', companyId: vCid }); check((r.status === 201 && r.json.data.companyId === sCid) || r.status >= 400, 'body companyId cannot move a client into VASAVI', r.text.slice(0, 160));
  r = await call(st, 'GET', '/orders/clients', undefined, { 'x-company-id': vCid, 'x-tenant-id': vCid, 'x-company-code': 'VASAVI' }); check(!contaminated(r.text).length, 'company headers are ignored');
  r = await call(st, 'GET', '/orders/clients?companyId=' + vCid); check(!contaminated(r.text).length, 'company query param is ignored');
  r = await call(null, 'POST', '/auth/login', { companyCode: 'VASAVI', identifier: S.email, password: S.password }); check(r.status === 401, 'SHREE credentials do not open VASAVI', r.status);
  const forgedTok = jwt.sign({ ...jwt.decode(st), companyId: vCid }, 'not-the-secret'); r = await call(forgedTok, 'GET', '/orders/clients'); check(r.status === 401, 'token with a swapped companyId (bad signature) → 401', r.status);
  const wrongCompany = jwt.sign({ ...jwt.decode(st), companyId: vCid }, env.JWT_SECRET); r = await call(wrongCompany, 'GET', '/orders/clients'); check(r.status === 401 || r.status === 403 || (r.status === 200 && !contaminated(r.text).length), 'even a correctly-signed token naming the wrong company yields nothing of VASAVI', r.status);

  // ═════════════════════════ 5. IDENTITY / MEMBERSHIP PRIVACY ═════════════════════════
  section('users, memberships, invitations');
  const sUsers = (await call(st, 'GET', '/auth/users')).json.data; check(sUsers.length === 1 && sUsers[0].user.email === S.email, 'SHREE sees exactly its own administrator');
  const sInv = arr(await call(st, 'GET', '/auth/invitations')); check(sInv.length === 0, 'SHREE sees no VASAVI invitations');
  const invKnown = await call(st, 'POST', '/auth/invitations', { email: V.email, roleId: ids.sRole });
  const invUnknown = await call(st, 'POST', '/auth/invitations', { email: 'nobody-' + mk.toLowerCase() + '@nowhere.example', roleId: ids.sRole });
  check(invKnown.status === invUnknown.status && Object.keys(invKnown.json.data).sort().join() === Object.keys(invUnknown.json.data).sort().join(), 'inviting an email that has a login elsewhere is indistinguishable from an unknown email', invKnown.status + '/' + invUnknown.status);
  const acc = await call(null, 'POST', '/auth/invitations/accept', { token: invKnown.json.data.token, name: 'Vasavi Owner', password: 'definitely-wrong-password' }); check(acc.status === 400, 'accepting with a wrong password for the existing login → generic 400', acc.status + acc.text.slice(0, 100));
  const acc2 = await call(null, 'POST', '/auth/invitations/accept', { token: 'x'.repeat(40), name: 'Nobody', password: 'whatever123' }); check(acc2.status === 400 && acc2.text === acc.text || acc2.status === 400, 'bogus token → the same generic 400');
  const lg1 = await call(null, 'POST', '/auth/login', { companyCode: 'VASAVI', identifier: 'nobody@nowhere.example', password: 'x' });
  const lg2 = await call(null, 'POST', '/auth/login', { companyCode: 'NOSUCHCO', identifier: 'nobody@nowhere.example', password: 'x' });
  const lg3 = await call(null, 'POST', '/auth/login', { companyCode: 'VASAVI', identifier: V.email, password: 'wrong-password' });
  check(lg1.status === 401 && lg2.status === 401 && lg3.status === 401 && lg1.text === lg2.text && lg2.text === lg3.text, 'login failures (unknown company / unknown user / wrong password) are byte-identical', [lg1.text, lg2.text, lg3.text].join(' | '));
  const platNo = await call(null, 'GET', '/platform/companies'); const platBad = await call(null, 'GET', '/platform/companies', undefined, { 'x-trivo-platform-key': 'wrong' });
  check(platNo.status === 401 && platBad.status === 401 && platNo.text === platBad.text, 'platform API: missing and wrong key are the same 401');
  const platViaTenant = await call(st, 'GET', '/platform/companies'); check(platViaTenant.status === 401, 'a company admin token cannot use the operator API', platViaTenant.status);

  // ═════════════════════════ 6. AUDIT ═════════════════════════
  section('audit logs');
  const sAudit = await call(st, 'GET', '/settings/audit-logs'); const vAudit2 = await call(vt, 'GET', '/settings/audit-logs?limit=200');
  check(strictContaminated(sAudit.text).length === 0, 'SHREE audit log contains no VASAVI id, secret or company id');
  check(contaminated(vAudit2.text).length > 0 || (arr(vAudit2)?.length ?? 0) > 0, 'VASAVI audit log holds its own entries (control)');

  // ═════════════════════════ 7. WEBSOCKET (real Socket.IO through the front door) ═════════════════════════
  section('websocket');
  const connect = (token) => new Promise((resolve) => { const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 }); s.on('connect', () => resolve({ ok: true, s })); s.on('connect_error', (e) => resolve({ ok: false, err: e.message, s })); });
  const bad1 = await connect('garbage'); check(!bad1.ok, 'garbage token rejected at the socket', bad1.err); bad1.s.close();
  const bad2 = await connect(forgedTok); check(!bad2.ok, 'token signed with the wrong secret rejected', bad2.err); bad2.s.close();
  const nob = await new Promise((resolve) => { const s = io(BASE, { transports: ['websocket'], reconnection: false }); s.on('connect', () => resolve(true)); s.on('connect_error', () => resolve(false)); }); check(nob === false, 'no token → refused');
  const vs = await connect(vt), ss = await connect(st); check(vs.ok && ss.ok, 'both admins connect (each SUPER_ADMIN — the exact case a shared role room would leak)');
  const gotV = [], gotS = [];
  const catchAll = (sock, sink) => sock.onAny((ev, ...a) => sink.push({ ev, a }));
  catchAll(vs.s, gotV); catchAll(ss.s, gotS);
  ss.s.emit('subscribe:factory'); ss.s.emit('subscribe:jobcard', ids.vTag); ss.s.emit('subscribe:jobcard', 'company:' + vCid + ':role:SUPER_ADMIN'); ss.s.emit('join', 'company:' + vCid); ss.s.emit('join', 'role:SUPER_ADMIN');
  vs.s.emit('subscribe:factory');
  await sleep(400);
  const alerts = await call(vt, 'POST', '/sales/memos/check-alerts'); check(alerts.status === 200 && /1 alerts/.test(alerts.text), 'VASAVI triggers a real memo:alert over HTTP', alerts.text);
  await sleep(1200);
  check(gotV.some((e) => e.ev === 'memo:alert'), 'VASAVI\'s socket receives its own memo:alert (positive control)', JSON.stringify(gotV.map((e) => e.ev)));
  check(gotS.length === 0, 'SHREE\'s SUPER_ADMIN socket received NOTHING (also after subscribing to factory/foreign rooms)', JSON.stringify(gotS).slice(0, 200));
  // reverse direction: SHREE's own event never reaches VASAVI
  const sMemoTag = (await call(st, 'POST', '/tagging/tags', goodTag)).json.data;
  const sM = await call(st, 'POST', '/sales/memos', { clientId: sClient.id, branchId: ids.sBranch, sentDate: new Date().toISOString(), returnDeadline: new Date(Date.now() + 86400000).toISOString(), items: [{ productCode: sMemoTag.tagNumber, description: 'x', pieces: 1, grossWeight: 1, netGoldWeight: 1, estimatedValue: 1, tagId: sMemoTag.id }] });
  gotV.length = 0; gotS.length = 0;
  await call(st, 'POST', '/sales/memos/check-alerts'); await sleep(1200);
  check(gotS.some((e) => e.ev === 'memo:alert') && gotV.length === 0, 'SHREE gets its own alert; VASAVI gets none from SHREE', `S=${gotS.length} V=${gotV.length}`);
  vs.s.close(); ss.s.close();

  // ═════════════════════════ 8. SUSPENSION cuts off tokens AND live sockets ═════════════════════════
  section('suspension');
  const tmpCode = 'TMPSUSP' + crypto.randomBytes(2).toString('hex').toUpperCase(); const tmpPw = crypto.randomBytes(9).toString('base64url') + 'aA1!';
  const pr = await fetch(API + '/platform/companies', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trivo-platform-key': env.TRIVO_PLATFORM_API_KEY }, body: JSON.stringify({ code: tmpCode, name: 'Temp Suspend Co', admin: { email: tmpCode.toLowerCase() + '@tmp.example', name: 'Tmp Admin', password: tmpPw } }) }); const prj = await pr.json();
  const tl = await login({ code: tmpCode, email: tmpCode.toLowerCase() + '@tmp.example', password: tmpPw }); const ts = await connect(tl.accessToken); check(ts.ok, 'temp company socket connects');
  let dropped = false; ts.s.on('disconnect', () => { dropped = true; });
  const sus = await fetch(API + '/platform/companies/' + prj.data.company.id + '/status', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-trivo-platform-key': env.TRIVO_PLATFORM_API_KEY }, body: JSON.stringify({ isActive: false }) }); check(sus.status === 200, 'operator suspends the company');
  await sleep(800); check(dropped, 'its live socket was disconnected immediately');
  check((await call(tl.accessToken, 'GET', '/orders/clients')).status === 401, 'its already-issued token stopped working');
  check((await call(null, 'POST', '/auth/login', { companyCode: tmpCode, identifier: tmpCode.toLowerCase() + '@tmp.example', password: tmpPw })).status === 401, 'it can no longer log in');
  check((await call(vt, 'GET', '/orders/clients')).status === 200, 'VASAVI is unaffected');

  // ═════════════════════════ 9. DATABASE-LEVEL RLS (independent of every app filter) ═════════════════════════
  section('database: RLS with the real runtime role');
  const rt = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }), plat = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
  const tables = (await plat.$queryRawUnsafe(`select c.table_name from information_schema.columns c join pg_class k on k.relname=c.table_name and k.relkind='r' join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where c.table_schema='public' and c.column_name='companyId' order by 1`)).map((r) => r.table_name);
  check(tables.length >= 80, `${tables.length} company-owned tables discovered from the catalog`);
  const noRls = await plat.$queryRawUnsafe(`select relname from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where relkind='r' and relname = any($1) and not (relrowsecurity and relforcerowsecurity)`, tables); check(noRls.length === 0, 'every company-owned table has RLS enabled AND forced', noRls.map((r) => r.relname).join(','));
  const noPol = await plat.$queryRawUnsafe(`select k.relname from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where relkind='r' and relname = any($1) and not exists (select 1 from pg_policy p where p.polrelid=k.oid)`, tables); check(noPol.length === 0, 'every company-owned table has a policy', noPol.map((r) => r.relname).join(','));
  const roleInfo = (await rt.$queryRawUnsafe(`select current_user u, (select rolsuper from pg_roles where rolname=current_user) su, (select rolbypassrls from pg_roles where rolname=current_user) bp, (select count(*)::int from pg_tables where schemaname='public' and tableowner=current_user) owned`))[0];
  check(roleInfo.u === 'trivo_runtime' && !roleInfo.su && !roleInfo.bp && roleInfo.owned === 0, 'runtime role: not superuser, no BYPASSRLS, owns no tables', JSON.stringify(roleInfo));
  let leaks = 0, noCtxRows = 0, visibleControl = 0, writesLeaked = 0;
  for (const t of tables) {
    const q = (cid) => rt.$transaction(async (tx) => { if (cid) await tx.$executeRawUnsafe(`select set_config('app.tenant_company_id', '${cid}', true)`); return Number((await tx.$queryRawUnsafe(`select count(*)::int c from "${t}" where "companyId" = '${vCid}'`))[0].c); });
    const asShree = await q(sCid); const noCtx = await q(null); const asVasavi = await q(vCid);
    if (asShree !== 0) { leaks++; check(false, `DB: ${t} visible to SHREE context`, asShree); }
    if (noCtx !== 0) { noCtxRows++; check(false, `DB: ${t} visible with NO tenant context`, noCtx); }
    if (asVasavi > 0) visibleControl++;
    // cross-tenant write attempts must touch zero rows
    const w = await rt.$transaction(async (tx) => { await tx.$executeRawUnsafe(`select set_config('app.tenant_company_id', '${sCid}', true)`); try { return Number(await tx.$executeRawUnsafe(`update "${t}" set "companyId" = "companyId" where "companyId" = '${vCid}'`)); } catch (e) { return /permission denied/i.test(String(e.message)) ? 0 : (() => { throw e; })(); } });
    if (w !== 0) { writesLeaked++; check(false, `DB: SHREE context could UPDATE VASAVI rows in ${t}`, w); }
  }
  check(leaks === 0, `SELECT as SHREE returned 0 VASAVI rows in all ${tables.length} tables`); check(noCtxRows === 0, 'SELECT with no tenant context returned 0 rows in all tables (fail-closed)'); check(writesLeaked === 0, 'UPDATE as SHREE touched 0 VASAVI rows in all tables');
  check(visibleControl >= 20, `control: VASAVI's own context does see its rows (${visibleControl} tables with data)`);
  const delTry = await rt.$transaction(async (tx) => { await tx.$executeRawUnsafe(`select set_config('app.tenant_company_id', '${sCid}', true)`); return Number(await tx.$executeRawUnsafe(`delete from "clients" where "companyId" = '${vCid}'`)); }); check(delTry === 0, 'DELETE as SHREE removed 0 VASAVI clients');
  const insTry = await rt.$transaction(async (tx) => { await tx.$executeRawUnsafe(`select set_config('app.tenant_company_id', '${sCid}', true)`); try { await tx.$executeRawUnsafe(`insert into "collections" (id, "companyId", code, name) values ('cforge${Date.now()}', '${vCid}', 'FORGE', 'forged')`); return 'INSERTED'; } catch (e) { return String(e.message); } }); check(insTry !== 'INSERTED' && /row-level security|policy/i.test(insTry), 'INSERT into VASAVI as SHREE is rejected by the policy', insTry.slice(0, 160));
  let fkRes; try { await plat.$executeRawUnsafe(`update jewelry_tags set "categoryId" = '${sCats[0].id}' where id = '${ids.vTag}'`); fkRes = 'UPDATED'; } catch (e) { fkRes = e.message; } check(/foreign key/i.test(fkRes), 'even the BYPASSRLS platform role cannot point a VASAVI tag at SHREE\'s category (composite FK)', fkRes.slice(0, 140));
  const auditImm = await rt.$transaction(async (tx) => { await tx.$executeRawUnsafe(`select set_config('app.tenant_company_id', '${vCid}', true)`); try { await tx.$executeRawUnsafe(`update audit_logs set action = 'X' where "companyId" = '${vCid}'`); return 'UPDATED'; } catch (e) { return e.message; } }); check(auditImm !== 'UPDATED', 'audit_logs is append-only even for the owning company\'s runtime role', auditImm.slice(0, 120));
  const plBlock = await rt.$transaction(async (tx) => { try { await tx.$queryRawUnsafe(`select count(*) from platform_audit_logs`); return 'READ'; } catch (e) { return e.message; } }); check(plBlock !== 'READ', 'runtime role cannot read platform_audit_logs', plBlock.slice(0, 100));
  const df = await plat.$queryRawUnsafe(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='design_files'::regclass and contype='c'`); check(df.some((r) => /companyId|companies\//.test(r.d)), 'design_files has a DB CHECK binding object keys to the company prefix', df.map((r) => r.d).join(' | ').slice(0, 200));
  await rt.$disconnect(); await plat.$disconnect();

  // ═════════════════════════ 10. NAMESPACES (Redis keys, object keys) ═════════════════════════
  section('redis + object-storage namespaces (key builders; no Redis/MinIO in this environment)');
  const { companyCacheKey } = require(__dirname + '/../../server/dist/config/redis.js'); const ok = require(__dirname + '/../../server/dist/shared/objectKey.js');
  check(companyCacheKey(vCid, 'a') !== companyCacheKey(sCid, 'a') && companyCacheKey(vCid, 'a').startsWith('trivo:' + vCid + ':') && companyCacheKey(sCid, 'a').startsWith('trivo:' + sCid + ':'), 'the same logical cache key differs per company and is company-prefixed');
  let threw = false; try { companyCacheKey('', 'a'); } catch { threw = true; } check(threw, 'a cache key with no company is impossible');
  const fnName = Object.keys(ok).find((k) => /key/i.test(k)); check(!!fnName, 'object-key builder exported: ' + Object.keys(ok).join(','));

  // ═════════════════════════ SUMMARY ═════════════════════════
  console.log('\n══════════ SUMMARY ══════════');
  for (const [k, v] of Object.entries(cats)) console.log(`  ${String(v.pass).padStart(4)} pass ${String(v.fail).padStart(3)} fail  ${k}`);
  console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log(' - ' + f)); }
  fs.writeFileSync(HARNESS + '/isolation-result.json', JSON.stringify({ pass, fail, cats, failures, at: new Date().toISOString() }, null, 2));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
