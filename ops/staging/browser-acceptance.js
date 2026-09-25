// Browser acceptance: two companies, real Chromium, real built SPA behind the front door, real API + Postgres + RLS.
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = 'http://localhost:8080';
const API = BASE + '/api/v1';
const V = JSON.parse(fs.readFileSync(HARNESS + '/VASAVI.json'));
const S = JSON.parse(fs.readFileSync(HARNESS + '/SHREE.json'));
const SHOTS = HARNESS + '/shots'; fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0; const failures = []; const results = {};
let cat = 'setup';
const section = (n) => { cat = n; results[n] = results[n] ?? { pass: 0, fail: 0 }; console.log('\n── ' + n); };
const check = (ok, msg, detail) => { results[cat] = results[cat] ?? { pass: 0, fail: 0 }; if (ok) { pass++; results[cat].pass++; } else { fail++; results[cat].fail++; failures.push(`[${cat}] ${msg}${detail ? ' :: ' + String(detail).slice(0, 250) : ''}`); console.log('  FAIL', msg, detail ? '→ ' + String(detail).slice(0, 200) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = [
  '/', '/workflow', '/masters', '/settings', '/hardware',
  '/orders/clients', '/procurement/suppliers', '/procurement/orders', '/procurement/grn', '/procurement/returns', '/procurement/requisitions',
  '/inventory/metals', '/inventory/stones', '/inventory/consumables',
  '/tagging/tags', '/tagging/tags/new', '/tagging/lookup', '/tagging/templates', '/tagging/branch-stock', '/tagging/audits', '/tagging/branches', '/tagging/transfers',
  '/estimation', '/estimation/templates',
  '/sales/memos', '/sales/invoices', '/sales/invoices/new', '/sales/exchanges',
  '/finance/journals', '/finance/accounts', '/finance/trial-balance', '/finance/pnl', '/finance/cost-centers', '/finance/dealer-aging', '/finance/client-ledger',
  '/reports/sales-register', '/reports/stock-on-hand', '/reports/dead-stock', '/reports/day-book', '/reports/gst-summary', '/reports/stock', '/reports/aging', '/reports/wip',
  '/manufacturing', '/manufacturing/jobs', '/manufacturing/qc', '/designs', '/orders', '/orders/reservations',
  '/outsourcing/ledger', '/outsourcing/transactions', '/outsourcing/invoices', '/quality/hallmarking', '/quality/repairs',
];

async function api(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function apiLogin(c) { const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyCode: c.code, identifier: c.email, password: c.password }) }); return (await r.json()).data; }

function watch(page, label) {
  const bag = { errors5xx: [], consoleErrors: [], failed: [], wsFrames: [] };
  page.on('response', (r) => { if (r.status() >= 500) bag.errors5xx.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/favicon|WS error|Failed to load resource: the server responded with a status of (401|403|404|429)/i.test(t)) bag.consoleErrors.push(t.slice(0, 200)); } });
  page.on('pageerror', (e) => bag.consoleErrors.push('PAGEERROR ' + String(e.message).slice(0, 200)));
  page.on('requestfailed', (r) => { if (!/socket\.io/.test(r.url())) bag.failed.push(r.url().replace(BASE, '') + ' ' + (r.failure()?.errorText ?? '')); });
  return bag;
}
async function wsListener(page, bag) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (e) => bag.wsFrames.push(String(e.response.payloadData).slice(0, 300)));
  return cdp;
}
async function uiLogin(page, c) {
  await page.goto(BASE + '/login');
  await page.getByLabel('Company Code').fill(c.code);
  await page.getByLabel('Email or Username').fill(c.email);
  await page.getByLabel('Password').fill(c.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.getByText('TRIVO ERP').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const mkCtx = () => browser.newContext({ viewport: { width: 1440, height: 900 } });
  const vApi = await apiLogin(V), sApi = await apiLogin(S);
  const marks = { V: ['VASAVI', 'Vasavi', 'VAS-T', 'VAS-C', 'HIST-VAS', 'vasavi.example'], S: ['SHREE', 'Shree', 'SHR-T', 'SHR-C', 'HIST-SHR', 'shreesilver'] };
  const other = { V: 'S', S: 'V' };

  // ═══ 1. login page + auth guard ═══
  section('login + route guard');
  {
    const ctx = await mkCtx(); const page = await ctx.newPage(); watch(page, 'guard');
    await page.goto(BASE + '/orders/clients'); await page.waitForURL(/\/login/, { timeout: 10000 });
    check(/\/login/.test(page.url()), 'unauthenticated deep link is redirected to /login');
    check((await page.title()) === 'TRIVO ERP' && (await page.locator('body').innerText()).includes('TRIVO ERP'), 'login page is branded TRIVO ERP (not SEA)');
    await page.getByLabel('Company Code').fill('VASAVI'); await page.getByLabel('Email or Username').fill(V.email); await page.getByLabel('Password').fill('wrong-password-123');
    await page.getByRole('button', { name: 'Sign In' }).click(); await page.getByText('Invalid credentials').waitFor({ timeout: 8000 });
    check(true, 'wrong password shows the generic "Invalid credentials"');
    await page.getByLabel('Company Code').fill('NOSUCHCO'); await page.getByRole('button', { name: 'Sign In' }).click(); await page.getByText('Invalid credentials').waitFor({ timeout: 8000 });
    check(true, 'unknown company shows the same generic message');
    await page.screenshot({ path: SHOTS + '/01-login.png' }); await ctx.close();
  }

  // ═══ 2. each company: login, walk every screen, isolation of displayed data ═══
  const sessions = {};
  for (const [key, c] of [['V', V], ['S', S]]) {
    section(`${c.code}: sign in and walk every screen`);
    const ctx = await mkCtx(); const page = await ctx.newPage(); const bag = watch(page, c.code); await wsListener(page, bag);
    sessions[key] = { ctx, page, bag, c };
    await uiLogin(page, c);
    const ownName = c.code === 'VASAVI' ? 'Vasavi Gold & Diamonds' : 'Shree Silver Palace';
    await page.getByText(ownName).first().waitFor({ timeout: 10000 }).catch(() => {});
    const side = await page.locator('body').innerText();
    check(side.includes(ownName), `${c.code}: sidebar shows the company's own name`);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.MuiChip-label')).some((e) => e.textContent === 'LIVE'), null, { timeout: 15000 }).catch(() => {});
    check((await page.locator('.MuiChip-label').allInnerTexts()).includes('LIVE'), `${c.code}: header shows the realtime connection LIVE`);
    check(!marks[other[key]].some((m) => side.includes(m)), `${c.code}: dashboard shows nothing of the other company`);
    await page.screenshot({ path: `${SHOTS}/02-${c.code}-dashboard.png` });
    let walked = 0;
    for (const r of ROUTES) {
      bag.errors5xx.length = 0; bag.consoleErrors.length = 0;
      await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await sleep(150);
      const text = await page.locator('body').innerText();
      const leaked = marks[other[key]].filter((m) => text.includes(m));
      const crashed = /Something went wrong|Application error|Cannot read properties/i.test(text);
      const ok = !leaked.length && !crashed && !bag.errors5xx.length && !bag.consoleErrors.length && !/\/login/.test(page.url());
      check(ok, `${c.code} ${r}`, [leaked.length && 'LEAK ' + leaked, crashed && 'crash text', bag.errors5xx.join(';'), bag.consoleErrors.join(' | '), /\/login/.test(page.url()) && 'bounced to login'].filter(Boolean).join(' / '));
      walked++;
      if (['/tagging/tags', '/sales/invoices', '/orders/clients', '/finance/pnl', '/reports/gst-summary'].includes(r)) await page.screenshot({ path: `${SHOTS}/03-${c.code}-${r.replace(/\//g, '_')}.png` });
    }
    check(walked === ROUTES.length, `${c.code}: walked ${walked} screens`);
  }

  // ═══ 3. real data on screen ═══
  section('data on screen belongs to the right company');
  {
    const { page: vp } = sessions.V; const { page: sp } = sessions.S;
    await vp.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' }); const vt = await vp.locator('body').innerText();
    check(/VAS-C\d{6}|VAS\d/.test(vt) && !/SHR-C|SHR\d/.test(vt), 'VASAVI customers screen lists VASAVI customers only');
    await sp.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' }); const st = await sp.locator('body').innerText();
    check(/SHR-C\d{6}|SHR\d/.test(st) && !/VAS-C|VAS\d/.test(st), 'SHREE customers screen lists SHREE customers only');
    // stock lookup by tag number
    await vp.goto(BASE + '/tagging/lookup', { waitUntil: 'networkidle' }); await vp.getByPlaceholder(/Scan barcode/).fill('VAS-T000010'); await vp.keyboard.press('Enter'); await sleep(1200);
    check((await vp.locator('body').innerText()).includes('VAS-T000010'), 'VASAVI finds its own tag VAS-T000010 in stock lookup');
    await sp.goto(BASE + '/tagging/lookup', { waitUntil: 'networkidle' }); await sp.getByPlaceholder(/Scan barcode/).fill('VAS-T000010'); await sp.keyboard.press('Enter'); await sleep(1200);
    const lt = await sp.locator('body').innerText();
    check(!lt.includes('VAS-T000010') || /not found|no (tag|result|match)/i.test(lt), 'SHREE searching VASAVI\'s tag number finds nothing', lt.slice(0, 200));
    await sp.getByPlaceholder(/Scan barcode/).fill('SHR-T000010'); await sp.keyboard.press('Enter'); await sleep(1200);
    check((await sp.locator('body').innerText()).includes('SHR-T000010'), 'SHREE finds its own tag SHR-T000010');
    await vp.screenshot({ path: SHOTS + '/04-lookup-VASAVI.png' }); await sp.screenshot({ path: SHOTS + '/04-lookup-SHREE.png' });
  }

  // ═══ 4. create a customer through the UI ═══
  section('create a customer through the UI');
  {
    const { page } = sessions.S; const name = 'Playwright Customer ' + Date.now();
    await page.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Add Client/ }).click();
    await page.getByLabel('Company / Client Name').fill(name); await page.getByLabel('Phone').fill('9999900000'); await page.getByLabel('City').fill('Surat');
    await page.getByRole('button', { name: 'Save Client' }).click();
    await sleep(1500);
    const list = (await api(sApi.accessToken, 'GET', '/orders/clients')).json.data;
    const listV = (await api(vApi.accessToken, 'GET', '/orders/clients')).json.data;
    check(list.some((x) => x.name === name), 'the new customer was saved in SHREE');
    check(!listV.some((x) => x.name === name), 'and does not exist in VASAVI');
  }

  // ═══ 5. realtime in the browser ═══
  section('websocket: browser receives its own company events only');
  {
    const { bag: vb } = sessions.V; const { bag: sb } = sessions.S;
    const vBranch = (await api(vApi.accessToken, 'GET', '/tagging/branches')).json.data[0].id;
    const tags = (await api(vApi.accessToken, 'GET', '/tagging/tags?status=IN_STOCK&limit=1')).json.tags;
    vb.wsFrames.length = 0; sb.wsFrames.length = 0;
    await api(vApi.accessToken, 'POST', '/sales/memos', { clientId: (await api(vApi.accessToken, 'GET', '/orders/clients')).json.data[0].id, branchId: vBranch, sentDate: new Date().toISOString(), returnDeadline: new Date(Date.now() + 86400000).toISOString(), items: [{ productCode: tags[0].tagNumber, description: 'ws test', pieces: 1, grossWeight: 1, netGoldWeight: 1, estimatedValue: 1, tagId: tags[0].id }] });
    await api(vApi.accessToken, 'POST', '/sales/memos/check-alerts');
    await sleep(2000);
    check(vb.wsFrames.some((f) => f.includes('memo:alert')), 'VASAVI\'s open browser tab received memo:alert over its WebSocket', JSON.stringify(vb.wsFrames).slice(0, 200));
    check(!sb.wsFrames.some((f) => f.includes('memo:alert')), 'SHREE\'s open browser tab (also SUPER_ADMIN) received NONE of it', JSON.stringify(sb.wsFrames).slice(0, 200));
  }

  // ═══ 6. logout; and a company switch in one tab must not inherit the old socket ═══
  section('logout + company switch in the same tab');
  {
    const ctx = await mkCtx(); const page = await ctx.newPage(); const bag = watch(page, 'switch'); await wsListener(page, bag);
    await uiLogin(page, V);
    await page.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    check(/VAS-C|VAS\d/.test(await page.locator('body').innerText()), 'tab shows VASAVI customers');
    await page.getByLabel('Logout').click(); await page.waitForURL(/\/login/, { timeout: 8000 });
    const stored = await page.evaluate(() => localStorage.getItem('sea-erp-auth'));
    check(/\/login/.test(page.url()) && (!stored || !JSON.parse(stored).state.accessToken), 'logout returns to /login and clears the stored session');
    await uiLogin(page, S);
    await page.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    const txt = await page.locator('body').innerText();
    check(/SHR-C|SHR\d/.test(txt) && !/VAS-C|VAS\d/.test(txt), 'same tab, now SHREE: shows SHREE customers and nothing of VASAVI');
    // Realtime: VASAVI raises an alert. This tab is SHREE now — its socket must be SHREE's, and hear nothing.
    bag.wsFrames.length = 0;
    const vBranch = (await api(vApi.accessToken, 'GET', '/tagging/branches')).json.data[0].id;
    const tags = (await api(vApi.accessToken, 'GET', '/tagging/tags?status=IN_STOCK&limit=1')).json.tags;
    await api(vApi.accessToken, 'POST', '/sales/memos', { clientId: (await api(vApi.accessToken, 'GET', '/orders/clients')).json.data[1].id, branchId: vBranch, sentDate: new Date().toISOString(), returnDeadline: new Date(Date.now() + 86400000).toISOString(), items: [{ productCode: tags[0].tagNumber, description: 'ws switch', pieces: 1, grossWeight: 1, netGoldWeight: 1, estimatedValue: 1, tagId: tags[0].id }] });
    await api(vApi.accessToken, 'POST', '/sales/memos/check-alerts'); await sleep(2000);
    check(!bag.wsFrames.some((f) => f.includes('memo:alert')), 'tab that switched VASAVI→SHREE receives none of VASAVI\'s realtime events', JSON.stringify(bag.wsFrames).slice(0, 200));
    await ctx.close();
  }

  // ═══ 7. cross-tab session behaviour (same browser profile) ═══
  section('cross-tab logout / login');
  {
    const ctx = await mkCtx(); const p1 = await ctx.newPage(); const p2 = await ctx.newPage();
    await uiLogin(p1, V);
    await p1.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    await p2.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    check(!/\/login/.test(p2.url()), 'a second tab in the same browser shares the signed-in session');
    await p2.getByLabel('Logout').click(); await p2.waitForURL(/\/login/, { timeout: 8000 });
    await p1.waitForURL(/\/login/, { timeout: 8000 }).catch(() => {});
    check(/\/login/.test(p1.url()), 'logging out in tab 2 signs tab 1 out too (no lingering session)');
    check(!/VAS-C|VAS\d/.test(await p1.locator('body').innerText()), 'tab 1 no longer displays VASAVI data');
    await uiLogin(p2, S);
    await sleep(1500);
    await p1.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' });
    const t1 = await p1.locator('body').innerText();
    check(/SHR-C|SHR\d/.test(t1) && !/VAS-C|VAS\d/.test(t1), 'after tab 2 signs in as SHREE, tab 1 shows SHREE data only');
    // stale cache: tab 1 is on SHREE; tab 2 logs out and VASAVI signs in in tab 2 -> tab 1 must not keep SHREE data on screen as VASAVI's
    await p2.getByLabel('Logout').click(); await p2.waitForURL(/\/login/); await uiLogin(p2, V); await sleep(2000);
    const t1b = await p1.locator('body').innerText();
    check(!/SHR-C|SHR\d/.test(t1b) || /VAS-C|VAS\d/.test(t1b) || /Sign In/.test(t1b), 'tab 1 does not keep showing SHREE data after the session switched to VASAVI', t1b.slice(0, 200));
    const st = JSON.parse(await p1.evaluate(() => localStorage.getItem('sea-erp-auth')));
    check(st.state.company.code === 'VASAVI', 'tab 1\'s stored session follows the switch (VASAVI)');
    await p1.screenshot({ path: SHOTS + '/05-crosstab.png' }); await ctx.close();
  }

  // ═══ 8. suspended company: a live browser session is cut off ═══
  section('suspension seen from the browser');
  {
    const key = require('dotenv').parse(fs.readFileSync(STAGING + '/staging.env')).TRIVO_PLATFORM_API_KEY;
    const code = 'BRW' + Math.random().toString(36).slice(2, 6).toUpperCase(); const pw = 'Brw-' + Math.random().toString(36).slice(2, 12) + 'A1!';
    const mk = await fetch(API + '/platform/companies', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trivo-platform-key': key }, body: JSON.stringify({ code, name: 'Browser Suspend Co', admin: { email: `admin@${code.toLowerCase()}.example`, name: 'Admin', password: pw } }) }); const mj = await mk.json();
    const ctx = await mkCtx(); const page = await ctx.newPage(); await uiLogin(page, { code, email: `admin@${code.toLowerCase()}.example`, password: pw });
    await fetch(API + '/platform/companies/' + mj.data.company.id + '/status', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-trivo-platform-key': key }, body: JSON.stringify({ isActive: false }) });
    await page.goto(BASE + '/orders/clients', { waitUntil: 'networkidle' }).catch(() => {}); await page.waitForURL('**/login', { timeout: 8000 }).catch(() => {});
    check(/\/login/.test(page.url()), 'the suspended company\'s open browser session is bounced to /login on its next action');
    await ctx.close();
  }

  await browser.close();
  console.log('\n══════════ BROWSER ACCEPTANCE ══════════');
  for (const [k, v] of Object.entries(results)) console.log(`  ${String(v.pass).padStart(4)} pass ${String(v.fail).padStart(3)} fail  ${k}`);
  console.log(`\nTOTAL ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log(' - ' + f)); }
  fs.writeFileSync(HARNESS + '/browser-result.json', JSON.stringify({ pass, fail, results, failures, at: new Date().toISOString() }, null, 2));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
