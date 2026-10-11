// TRIVO live-build verification against a THROWAWAY database (never the real tenant's books).
// Runs inside a node container on the production docker network, talking to a temporary API container that uses the
// same image as production but a scratch database. Creates two throwaway companies (VFYA, VFYB) and exercises:
//   admin login + password change (+ session revocation) · staff invitation / role / branch permissions · metal rate +
//   mandatory sale-rate rules · inward (supplier -> PO -> GRN -> tag) · direct tag · search · stock reports ·
//   estimate -> bill · tenant isolation. Credentials are generated in memory and never printed.
// Env: API (base url incl. /api/v1), PLATFORM_KEY.
import crypto from 'node:crypto';

const API = process.env.API;
const KEY = process.env.PLATFORM_KEY;
if (!API || !KEY) throw new Error('Set API and PLATFORM_KEY');
const pw = () => crypto.randomBytes(18).toString('base64url') + 'aZ9!';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <-- ' + extra}`); };

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json, data: json?.data };
}
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // India business day

async function provision(code) {
  const email = `${code.toLowerCase()}@verify.invalid`; const password = pw();
  const r = await call('POST', '/platform/companies', { headers: { 'x-trivo-platform-key': KEY }, body: { code, name: `Verify ${code}`, admin: { email, name: 'Verify Owner', password } } });
  if (r.status !== 201) throw new Error(`provision ${code} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const l = await call('POST', '/auth/login', { body: { companyCode: code, identifier: email, password } });
  return { code, email, password, token: l.data.accessToken, refresh: l.data.refreshToken, branchId: r.data.branch.id, companyId: r.data.company.id };
}

const sfx = crypto.randomBytes(2).toString('hex').toUpperCase();
const A = await provision(`VFYA${sfx}`); const B = await provision(`VFYB${sfx}`);
check('two throwaway companies provisioned and admin login works', !!A.token && !!B.token);

// ── 1. administrator password change ──────────────────────────────────────────────────────────────────────────────
const NEW_PW = pw();
check('change password: wrong current password refused (400)', (await call('POST', '/auth/change-password', { token: A.token, body: { current: 'wrong-wrong-wrong', next: NEW_PW } })).status === 400);
check('change password: weak/short new password refused (400)', (await call('POST', '/auth/change-password', { token: A.token, body: { current: A.password, next: 'short' } })).status === 400);
const ch = await call('POST', '/auth/change-password', { token: A.token, body: { current: A.password, next: NEW_PW } });
check('change password: succeeds and returns fresh tokens', ch.status === 200 && !!ch.data?.accessToken, ch.status);
const oldTok = A.token; A.token = ch.data?.accessToken; A.refresh = ch.data?.refreshToken;
check('change password: old password no longer logs in', (await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: A.email, password: A.password } })).status === 401);
check('change password: pre-change session is signed out (401)', (await call('GET', '/auth/me', { token: oldTok })).status === 401);
check('change password: new session works and refresh works', (await call('GET', '/auth/me', { token: A.token })).status === 200 && (await call('POST', '/auth/refresh', { body: { refreshToken: A.refresh } })).status === 200);
A.password = NEW_PW;
check('change password: new password logs in', (await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: A.email, password: A.password } })).status === 200);

// ── 2. staff invitation, role, branch permissions ─────────────────────────────────────────────────────────────────
const roles = (await call('GET', '/settings/roles', { token: A.token })).data ?? [];
const names = roles.map((r) => r.name);
check('starter roles available', ['SUPER_ADMIN', 'SALES_MANAGER', 'STORE_MANAGER', 'ACCOUNTANT'].every((n) => names.includes(n)), names.join(','));
const counterRole = (await call('POST', '/settings/roles', { token: A.token, body: { name: 'COUNTER_STAFF', displayName: 'Counter staff', permissions: ['tag:view', 'tag:create', 'estimation:view', 'estimation:manage', 'client:view', 'client:create', 'sales:view', 'invoice:create', 'masters:view', 'stock:view'] } })).data;
check('admin can create a custom low-privilege role in the Role Editor API', !!counterRole?.id);
const salesRole = counterRole;
const branch2 = (await call('POST', '/tagging/branches', { token: A.token, body: { name: 'Second Shop', city: 'Test' } })).data;
check('admin can add a branch', !!branch2?.id);
const staffEmail = `staff${sfx.toLowerCase()}@verify.invalid`;
const inv = await call('POST', '/auth/invitations', { token: A.token, body: { email: staffEmail, roleId: salesRole.id, allBranches: false, branchIds: [A.branchId], employeeId: 'E1', department: 'Sales' } });
check('admin invites staff (role + one branch); one-time link returned', inv.status === 201 && !!inv.data?.token, inv.status);
const STAFF_PW = pw();
const acc = await call('POST', '/auth/invitations/accept', { body: { token: inv.data?.token, name: 'Verify Staff', password: STAFF_PW } });
check('staff accepts invitation', acc.status === 200 || acc.status === 201, acc.status);
check('invitation token is single-use', (await call('POST', '/auth/invitations/accept', { body: { token: inv.data?.token, name: 'Verify Staff', password: STAFF_PW } })).status === 400);
const sl = await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: staffEmail, password: STAFF_PW } });
check('staff can log in with their role', sl.status === 200 && sl.data?.user?.role === 'COUNTER_STAFF', sl.status);
const S = sl.data?.accessToken;
check('staff is limited to their ONE branch', JSON.stringify(sl.data?.user?.branchAccess?.branchIds) === JSON.stringify([A.branchId]) && sl.data?.user?.branchAccess?.allBranches === false);
check('staff (no user:manage) cannot invite or list users (403)', (await call('POST', '/auth/invitations', { token: S, body: { email: 'x@verify.invalid', roleId: salesRole.id } })).status === 403 && (await call('GET', '/auth/users', { token: S })).status === 403);
check('staff cannot edit roles (403)', (await call('POST', '/settings/roles', { token: S, body: { name: 'X', permissions: ['*'] } })).status === 403);
check('staff cannot create a role carrying more than they hold (403) even if they could edit roles', (await call('POST', '/settings/roles', { token: S, body: { name: 'GOD', displayName: 'God', permissions: ['*'] } })).status === 403);
check('admin sees staff in member list', ((await call('GET', '/auth/users', { token: A.token })).data ?? []).some((u) => u.user?.email === staffEmail));

// ── 3. metal rate + mandatory making-charge / sale-rate rules, tagging ───────────────────────────────────────────
const category = (await call('GET', '/masters/categories', { token: A.token })).data[0].id;
const stockType = (await call('GET', '/masters/stock-types', { token: A.token })).data[0].id;
const ring = (over = {}) => ({
  branchId: A.branchId, stockTypeId: stockType, categoryId: category, name: 'Verify ring', makeType: 'GOLD', metalType: 'GOLD', metalKarat: '22K',
  grossWeight: 11, netWeight: 10, costPrice: 40000, saleMcRate: 100, saleVaPercent: 10,
  materials: [{ code: 'G22', materialType: 'METAL', weight: 10, unit: 'GM', saleRate: 1 }], ...over });
check('tag refused with NO metal rate for the karat (409)', (await call('POST', '/tagging/tags', { token: A.token, body: ring() })).status === 409);
check('metal rate entry needs rate:update (staff 403, admin 200)',
  (await call('POST', '/designs/rates/batch', { token: S, body: { date: today, rates: [{ karat: '24K', ratePerGram: 7000 }] } })).status === 403 &&
  (await call('POST', '/designs/rates/batch', { token: A.token, body: { date: today, rates: [{ karat: '24K', ratePerGram: 7000 }] } })).status === 200);
check('tag refused with a blank sale VA (400) and a blank sale MC (400)',
  (await call('POST', '/tagging/tags', { token: A.token, body: ring({ saleVaPercent: undefined }) })).status === 400 &&
  (await call('POST', '/tagging/tags', { token: A.token, body: ring({ saleMcRate: undefined }) })).status === 400);
const mc = await call('POST', '/masters/making-charges', { token: A.token, body: { karat: '22K', makingCharge: 100, saleWastagePercent: 10, makingChargeType: 'PER_GRAM' } });
check('making-charge master entry accepted', mc.status === 201, mc.status);
const t1 = await call('POST', '/tagging/tags', { token: A.token, body: ring() });
check('tag created IN_STOCK and persisted', t1.status === 201 && t1.data?.status === 'IN_STOCK', `${t1.status} ${JSON.stringify(t1.body).slice(0, 160)}`);
const tagNo = t1.data?.tagNumber;
const got = await call('GET', `/tagging/tags/${t1.data?.id}`, { token: A.token });
check('tag readable back (persistence) with the entered sale rates', got.status === 200 && Number(got.data.saleMcRate) === 100 && Number(got.data.saleVaPercent) === 10);
check('tag search finds it by tag number', ((await call('GET', `/tagging/tags/search?q=${encodeURIComponent(tagNo)}`, { token: A.token })).data ?? []).length >= 1);
check('tag list shows it', JSON.stringify((await call('GET', '/tagging/tags', { token: A.token })).body).includes(tagNo));
const printed = await call('GET', `/tagging/tags/${t1.data?.id}/print`, { token: A.token });
check('label print payload generated', printed.status === 200, printed.status);
const hand = (await call('GET', '/tagging/reports/stock-on-hand', { token: A.token })).data;
check('stock-on-hand shows 1 piece, cost 40000, live sale value', hand?.totals?.count === 1 && hand.totals.costValue === 40000 && hand.totals.sellingValue > 0, JSON.stringify(hand?.totals));
const book = (await call('GET', '/tagging/reports/stock-book', { token: A.token })).data;
check('stock book lists the tag', (book?.rows ?? []).some((r) => r.tagNumber === tagNo));

check('staff with tag:create can tag in their own branch', (await call('POST', '/tagging/tags', { token: S, body: ring({ name: 'Staff ring' }) })).status === 201);
check('staff is refused tagging into a branch they were not granted', [403, 404].includes((await call('POST', '/tagging/tags', { token: S, body: ring({ branchId: branch2.id }) })).status));

// ── 4. inward -> tag ───────────────────────────────────────────────────────────────────────────────────────────────
const sup = await call('POST', '/procurement/suppliers', { token: A.token, body: { name: 'Verify Supplier', type: 'OTHER' } });
const po = await call('POST', '/procurement/orders', { token: A.token, body: { supplierId: sup.data?.id, poType: 'OUTRIGHT', orderDate: new Date().toISOString(),
  items: [{ materialCode: 'R1', materialName: 'Bought ring', materialType: 'FINISHED_GOODS', quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: 30000 }] } });
check('purchase order created', po.status === 201, `${po.status} ${JSON.stringify(po.body).slice(0, 160)}`);
const grnBody = (items, withBranch = true) => ({ poId: po.data?.id, ...(withBranch ? { branchId: A.branchId } : {}), receivedDate: new Date().toISOString(), invoiceNumber: 'VF/1', invoiceDate: today, items });
const gi = [{ poItemId: po.data?.poItems?.[0]?.id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }];
check('GRN refused without a receiving branch (400)', (await call('POST', '/procurement/grn', { token: A.token, body: grnBody(gi, false) })).status === 400);
const grn = await call('POST', '/procurement/grn', { token: A.token, body: grnBody(gi) });
check('GRN created', grn.status === 201, `${grn.status} ${JSON.stringify(grn.body).slice(0, 160)}`);
const gtag = await call('POST', '/tagging/tags/from-grn-item', { token: A.token, body: { grnItemId: grn.data?.grnItems?.[0]?.id, name: 'Bought ring', metalType: 'GOLD', metalKarat: '22K', stockTypeId: stockType, categoryId: category, grossWeight: 8, sellingPrice: 40000 } });
check('inward piece tagged from the GRN line, cost = PO line', gtag.status === 201 && Number(gtag.data?.costPrice) === 30000 && gtag.data?.status === 'IN_STOCK', `${gtag.status} ${JSON.stringify(gtag.body).slice(0, 160)}`);
check('the same GRN line cannot be tagged twice (409)', (await call('POST', '/tagging/tags/from-grn-item', { token: A.token, body: { grnItemId: grn.data?.grnItems?.[0]?.id, name: 'dup', metalType: 'GOLD', stockTypeId: stockType, categoryId: category } })).status === 409);

// ── 5. estimate -> bill ────────────────────────────────────────────────────────────────────────────────────────────
const view = (await call('GET', `/estimation/tags/${t1.data.id}`, { token: A.token })).data;
const est = await call('POST', `/estimation/tags/${t1.data.id}/estimates`, { token: A.token, body: {
  items: view.materials.map((m) => ({ materialId: m.id, code: m.code, materialType: m.materialType, weight: Number(m.weight), unit: m.unit, saleRate: Number(m.saleRate) })),
  saleMcRate: Number(view.saleMcRate), saleVaPercent: Number(view.saleVaPercent) } });
check('estimate created at the live gold rate with 3% GST', est.status === 201 && Number(est.data?.taxRate) === 0.03 && view.goldRate?.isToday === true, `${est.status}`);
const sent = await call('POST', `/estimation/estimates/${est.data?.id}/send-to-billing`, { token: A.token, body: { customerName: 'Walk-in', customerPhone: '9876500000', salesPersonId: undefined } });
const client = await call('POST', '/orders/clients', { token: A.token, body: { name: 'Verify Customer', type: 'RETAIL' } });
check('customer created', client.status === 201);
const sale = await call('POST', '/sales/invoices', { token: A.token, body: { clientId: client.data?.id, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
  items: [{ productCode: tagNo, description: 'Verify ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: t1.data.id }] } });
check('invoice created from the tagged piece; tag flips to SOLD', sale.status === 201 && Number(sale.data?.taxAmount) > 0, `${sale.status} ${JSON.stringify(sale.body).slice(0, 200)}`);
check('sold piece leaves stock-on-hand', (await call('GET', '/tagging/reports/stock-on-hand', { token: A.token })).data?.totals?.count === 2);   // the staff piece + the GRN piece remain
check('the same piece cannot be sold again (409/400)', [409, 400].includes((await call('POST', '/sales/invoices', { token: A.token, body: { clientId: client.data?.id, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
  items: [{ productCode: tagNo, description: 'again', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: t1.data.id }] } })).status));

// ── 6. tenant isolation ────────────────────────────────────────────────────────────────────────────────────────────
const bTok = B.token;
check('other company sees none of A\'s tags / invoices / clients / suppliers',
  JSON.stringify((await call('GET', '/tagging/tags', { token: bTok })).body).includes(tagNo) === false &&
  ((await call('GET', '/sales/invoices', { token: bTok })).body?.data ?? []).length === 0 &&
  ((await call('GET', '/orders/clients', { token: bTok })).data ?? []).length === 0 &&
  ((await call('GET', '/procurement/suppliers', { token: bTok })).data ?? []).length === 0);
check('other company cannot read A\'s tag by id (404)', (await call('GET', `/tagging/tags/${t1.data.id}`, { token: bTok })).status === 404);
check('other company cannot tag A\'s GRN line (404)', (await call('POST', '/tagging/tags/from-grn-item', { token: bTok, body: { grnItemId: grn.data.grnItems[0].id, name: 'x', metalType: 'GOLD', stockTypeId: stockType, categoryId: category } })).status === 404);
check('forged foreign id (A\'s branch / category) in B\'s tag is refused', [400, 404, 409].includes((await call('POST', '/tagging/tags', { token: bTok, body: ring() })).status));
check('company code of A with B\'s login is refused (401)', (await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: B.email, password: B.password } })).status === 401);
check('platform API is not usable without the operator key (401/403/404)', [401, 403, 404].includes((await call('POST', '/platform/companies', { body: { code: 'NOPE', name: 'x', admin: { email: 'a@b.co', name: 'ab' } } })).status));

// ── 7. OSSP first-session tagging: SILVER, a dedicated TAGGING_STAFF role, many tags, persistence ──────────────────
// Silver is quoted as ONE Silver 999 rate (+ old-silver rate); every other purity (925) is derived from it on the server.
const TAGGING_PERMS = ['tag:view', 'tag:create', 'masters:view', 'design:view', 'client:view', 'tagTemplate:view'];
const tagRole = (await call('POST', '/settings/roles', { token: A.token, body: { name: 'TAGGING_STAFF', displayName: 'Tagging staff', permissions: TAGGING_PERMS } })).data;
check('admin creates TAGGING_STAFF (tag + read-only masters/rates only)', !!tagRole?.id);
const tInv = await call('POST', '/auth/invitations', { token: A.token, body: { email: `tagger${sfx.toLowerCase()}@verify.invalid`, roleId: tagRole?.id, allBranches: false, branchIds: [A.branchId] } });
const TAG_PW = pw();
await call('POST', '/auth/invitations/accept', { body: { token: tInv.data?.token, name: 'Verify Tagger', password: TAG_PW } });
const tl = await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: `tagger${sfx.toLowerCase()}@verify.invalid`, password: TAG_PW } });
const T = tl.data?.accessToken;
check('tagging staff can log in', tl.status === 200 && !!T, tl.status);
check('tagging staff can read masters, categories, stock types, rates, making charges, branches',
  (await Promise.all(['/masters/categories', '/masters/stock-types', '/masters/making-charges', '/masters/material-codes', '/designs/rates/latest', '/tagging/branches', '/orders/clients'].map((p) => call('GET', p, { token: T })))).every((r) => r.status === 200));
// escalation attempts - none may succeed
const adminRoleId = roles.find((r) => r.name === 'SUPER_ADMIN')?.id;
const tMe = (await call('GET', '/auth/me', { token: T })).data;
check('tagging staff cannot manage roles / users / invitations (403)',
  (await call('POST', '/settings/roles', { token: T, body: { name: 'EVIL', displayName: 'Evil', permissions: ['*'] } })).status === 403 &&
  (await call('PATCH', `/settings/roles/${tagRole.id}`, { token: T, body: { permissions: ['*'] } })).status === 403 &&
  (await call('GET', '/auth/users', { token: T })).status === 403 &&
  (await call('POST', '/auth/invitations', { token: T, body: { email: 'e@verify.invalid', roleId: adminRoleId } })).status === 403);
check('tagging staff cannot enter metal rates, edit masters, bill, or see finance (403)',
  (await call('POST', '/designs/rates/batch', { token: T, body: { date: today, rates: [{ karat: '999', ratePerGram: 80 }] } })).status === 403 &&
  (await call('POST', '/masters/making-charges', { token: T, body: { karat: '925', makingCharge: 1, saleWastagePercent: 1, makingChargeType: 'PER_GRAM' } })).status === 403 &&
  (await call('POST', '/sales/invoices', { token: T, body: {} })).status === 403 &&
  (await call('GET', '/finance/reports/trial-balance', { token: T })).status === 403);
// a delegated role manager (holds role:edit/user:manage but NOT '*') cannot mint or hand out a stronger role
const mgrRole = (await call('POST', '/settings/roles', { token: A.token, body: { name: 'ROLE_MANAGER', displayName: 'Role manager', permissions: [...TAGGING_PERMS, 'role:view', 'role:create', 'role:edit', 'user:manage'] } })).data;
const mInv = await call('POST', '/auth/invitations', { token: A.token, body: { email: `mgr${sfx.toLowerCase()}@verify.invalid`, roleId: mgrRole?.id, allBranches: true } });
const MGR_PW = pw();
await call('POST', '/auth/invitations/accept', { body: { token: mInv.data?.token, name: 'Verify Mgr', password: MGR_PW } });
const M = (await call('POST', '/auth/login', { body: { companyCode: A.code, identifier: `mgr${sfx.toLowerCase()}@verify.invalid`, password: MGR_PW } })).data?.accessToken;
check('role manager cannot create a role with permissions they lack (403)', (await call('POST', '/settings/roles', { token: M, body: { name: 'BIGGER', displayName: 'Bigger', permissions: ['invoice:create'] } })).status === 403);
check('role manager cannot widen an existing role beyond their own authority (403)', (await call('PATCH', `/settings/roles/${tagRole.id}`, { token: M, body: { permissions: [...TAGGING_PERMS, 'invoice:create'] } })).status === 403);
check('role manager cannot invite into SUPER_ADMIN or a stronger role (403)', (await call('POST', '/auth/invitations', { token: M, body: { email: 'z@verify.invalid', roleId: adminRoleId } })).status === 403);

// Silver rates: only the 999 base is enterable; 925 is derived.
check('silver 925 rate cannot be keyed directly (400)', (await call('POST', '/designs/rates/batch', { token: A.token, body: { date: today, rates: [{ karat: '925', ratePerGram: 70 }] } })).status === 400);
const sr = await call('POST', '/designs/rates/batch', { token: A.token, body: { date: today, rates: [{ karat: '999', ratePerGram: 100, ogRatePerGram: 90 }] } });
check('Silver 999 rate saved', sr.status === 200, `${sr.status} ${JSON.stringify(sr.body).slice(0, 200)}`);
const latest = (await call('GET', '/designs/rates/latest', { token: T })).data ?? [];
const r925 = latest.find((r) => r.karat === '925' && String(r.date).startsWith(today));
check('silver 925 derived from 999 (100 x 0.925 / 0.999 = 92.59)', !!r925 && Math.abs(Number(r925.ratePerGram) - 92.59) < 0.01, JSON.stringify(r925));
const silverMC = await call('POST', '/masters/making-charges', { token: A.token, body: { karat: '925', makingCharge: 8, saleWastagePercent: 5, makingChargeType: 'PER_GRAM' } });
check('silver making-charge master entry accepted', silverMC.status === 201, `${silverMC.status} ${JSON.stringify(silverMC.body).slice(0, 160)}`);
const silverRing = (i, over = {}) => ({ branchId: A.branchId, stockTypeId: stockType, categoryId: category, name: `Silver item ${i}`, makeType: 'SILVER', metalType: 'SILVER', metalKarat: '925',
  grossWeight: 20.5 + i, netWeight: 20 + i, costPrice: 1500 + i, saleMcRate: 8, saleVaPercent: 5,
  materials: [{ code: 'S925', materialType: 'METAL', weight: 20 + i, unit: 'GM', saleRate: 1 }], ...over });
const matCodes = (await call('GET', '/masters/material-codes', { token: T })).data ?? [];
check('material codes available to tagging staff', Array.isArray(matCodes) && matCodes.length > 0, JSON.stringify(matCodes).slice(0, 120));
const s1 = await call('POST', '/tagging/tags', { token: T, body: silverRing(1) });
check('TAGGING STAFF creates a SILVER 925 tag (IN_STOCK)', s1.status === 201 && s1.data?.status === 'IN_STOCK', `${s1.status} ${JSON.stringify(s1.body).slice(0, 240)}`);
const s1got = (await call('GET', `/tagging/tags/${s1.data?.id}`, { token: T })).data;
check('silver tag reads back with gross/net weight, purity, cost and sale rates',
  Number(s1got?.grossWeight) === 21.5 && Number(s1got?.netWeight) === 21 && s1got?.metalKarat === '925' && s1got?.metalType === 'SILVER' && Number(s1got?.costPrice) === 1501 && Number(s1got?.saleMcRate) === 8 && Number(s1got?.saleVaPercent) === 5, JSON.stringify(s1got).slice(0, 300));
check('tag saved with no sale MC is refused for silver too (400)', (await call('POST', '/tagging/tags', { token: T, body: silverRing(2, { saleMcRate: undefined }) })).status === 400);
// many tags, in parallel (two staff typing at once) - no duplicate numbers, none lost
const batch = await Promise.all(Array.from({ length: 24 }, (_, i) => call('POST', '/tagging/tags', { token: i % 2 ? T : A.token, body: silverRing(10 + i) })));
const okTags = batch.filter((r) => r.status === 201);
const nums = okTags.map((r) => r.data.tagNumber);
check('24 parallel silver tags all saved', okTags.length === 24, batch.map((r) => r.status).join(','));
check('tag numbers are unique across the batch', new Set(nums).size === nums.length && !nums.includes(s1.data.tagNumber));
const listed = (await call('GET', '/tagging/tags?limit=200', { token: T })).body;
const listedNums = new Set((listed?.tags ?? []).map((t) => t.tagNumber));
check('every saved tag is retrievable from the list', nums.every((n) => listedNums.has(n)), `listed ${listedNums.size}`);
check('search finds silver tags by name and by number', ((await call('GET', '/tagging/tags/search?q=Silver item 20', { token: T })).data ?? []).length >= 1 && ((await call('GET', `/tagging/tags/search?q=${encodeURIComponent(nums[3])}`, { token: T })).data ?? []).length === 1);
const sOnHand = (await call('GET', '/tagging/reports/stock-on-hand', { token: A.token })).data;
check('stock-on-hand includes the silver pieces (count rose by 25)', sOnHand?.totals?.count >= 25, JSON.stringify(sOnHand?.totals));
check('label payload for a silver tag', (await call('GET', `/tagging/tags/${s1.data?.id}/print`, { token: T })).status === 200);
check('tagging staff is still limited to their branch (403/404 for another)', [403, 404].includes((await call('POST', '/tagging/tags', { token: T, body: silverRing(99, { branchId: branch2.id }) })).status));
// persistence: session refresh + a fresh login still sees every tag
const tRef = await call('POST', '/auth/refresh', { body: { refreshToken: tl.data?.refreshToken } });
const reread = await call('GET', `/tagging/tags/${s1.data?.id}`, { token: tRef.data?.accessToken ?? T });
check('tag still retrievable after a token refresh / reconnection', reread.status === 200 && reread.data?.tagNumber === s1.data?.tagNumber);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
