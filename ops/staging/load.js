// Bulk-loads a realistic operational data set into ONE company (platform role, createMany in chunks).
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
// usage: node load.js CODE tags clients invoices
// Everything is stamped with the company's own id; historical documents use a HIST- number prefix so they can never
// collide with numbers the live sequence generates afterwards.
const fs = require('fs');
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync(STAGING + '/staging.env'));
process.env.DATABASE_URL = env.PLATFORM_DATABASE_URL;
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
const [code, nTags, nClients, nInvoices] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5]];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const r2 = (n) => Math.round(n * 100) / 100;
const chunk = async (rows, size, fn) => { for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size)); };
const cuid = () => 'c' + require('crypto').randomBytes(12).toString('hex');
const NAMES = ['Ring', 'Necklace', 'Bangle', 'Chain', 'Earring', 'Pendant', 'Bracelet', 'Nose Pin', 'Mangalsutra', 'Anklet'];
const FIRST = ['Aarav', 'Vivaan', 'Diya', 'Anaya', 'Rohan', 'Meera', 'Kabir', 'Ishita', 'Neel', 'Riya', 'Karan', 'Sneha', 'Om', 'Pooja', 'Yash', 'Tara'];
const LAST = ['Shah', 'Patel', 'Mehta', 'Jain', 'Gupta', 'Reddy', 'Nair', 'Iyer', 'Desai', 'Rao', 'Kapoor', 'Joshi'];
const STATES = ['Gujarat', 'Maharashtra', 'Telangana', 'Karnataka', 'Tamil Nadu', 'Delhi', 'Rajasthan'];

(async () => {
  const t0 = Date.now();
  const company = await prisma.company.findUniqueOrThrow({ where: { code } });
  const cid = company.id;
  const P = code.slice(0, 3);
  const offC = await prisma.client.count({ where: { companyId: cid } }), offT = await prisma.jewelryTag.count({ where: { companyId: cid } }), offI = await prisma.salesInvoice.count({ where: { companyId: cid } });
  const branch = await prisma.branch.findFirstOrThrow({ where: { companyId: cid } });
  const admin = await prisma.companyUser.findFirstOrThrow({ where: { companyId: cid }, select: { userId: true } });
  const cats = await prisma.productCategory.findMany({ where: { companyId: cid }, select: { id: true } });
  const stockTypes = await prisma.stockType.findMany({ where: { companyId: cid }, select: { id: true } });
  const acct = Object.fromEntries((await prisma.account.findMany({ where: { companyId: cid, code: { in: ['1101', '1102', '1200', '4000', '2203', '2201', '2202'] } }, select: { id: true, code: true } })).map((a) => [a.code, a.id]));

  // ── clients ──
  const clients = Array.from({ length: nClients }, (_, i) => {
    const dealer = i % 6 === 0;
    return {
      id: cuid(), companyId: cid, clientCode: `${P}-C${String(offC + i + 1).padStart(6, '0')}`,
      name: `${pick(FIRST)} ${pick(LAST)} ${P}${offC + i + 1}`, type: dealer ? 'DEALER' : 'RETAIL',
      phone: `98${String(10000000 + i).slice(0, 8)}`, state: pick(STATES), city: 'Surat',
      gstNumber: dealer ? `24${String(1000000000 + i).slice(0, 10)}1Z5` : null, creditLimit: dealer ? 5000000 : null,
    };
  });
  await chunk(clients, 2000, (c) => prisma.client.createMany({ data: c }));
  console.log(code, 'clients', clients.length, Date.now() - t0, 'ms');

  // ── tags (first nInvoices become SOLD; a few ON_APPROVAL) ──
  const tags = Array.from({ length: nTags }, (_, i) => {
    const gross = r2(rnd(1.5, 60)), stone = r2(rnd(0, 2)), cost = r2(gross * rnd(5800, 6400));
    return {
      id: cuid(), companyId: cid, tagNumber: `${P}-T${String(offT + i + 1).padStart(6, '0')}`, branchId: branch.id,
      name: `${pick(NAMES)} ${offT + i + 1}`, metalType: 'GOLD', metalKarat: pick(['22K', '18K', '24K']),
      grossWeight: gross, netWeight: r2(gross - stone), stoneWeight: stone,
      costPrice: cost, sellingPrice: r2(cost * 1.12), huid: i % 3 === 0 ? `H${P}${String(offT + i + 1).padStart(7, '0')}` : null,
      createdById: admin.userId, categoryId: pick(cats).id, stockTypeId: pick(stockTypes).id,
      status: i < nInvoices ? 'SOLD' : (i % 97 === 0 ? 'ON_APPROVAL' : 'IN_STOCK'),
    };
  });
  await chunk(tags, 2000, (c) => prisma.jewelryTag.createMany({ data: c }));
  console.log(code, 'tags', tags.length, Date.now() - t0, 'ms');

  // ── invoices + items + tax invoice + journal (+ payments for ~70%) ──
  const invoices = [], items = [], taxes = [], entries = [], lines = [], pays = [], payEntries = [], payLines = [];
  const balances = new Map();
  const now = Date.now();
  for (let i = 0; i < nInvoices; i++) {
    const t = tags[i], client = clients[Math.floor(Math.random() * clients.length)];
    const date = new Date(now - Math.floor(Math.random() * 365) * 86400000);
    const taxable = r2(Number(t.sellingPrice)), tax = r2(taxable * 0.03), total = r2(taxable + tax);
    const paid = i % 10 < 7 ? total : 0;
    const invId = cuid(), num = `HIST-${P}-${String(offI + i + 1).padStart(6, '0')}`;
    invoices.push({ id: invId, companyId: cid, branchId: branch.id, invoiceNumber: num, clientId: client.id, invoiceDate: date, invoiceType: client.type === 'DEALER' ? 'WHOLESALE' : 'RETAIL', subtotal: taxable, taxAmount: tax, totalAmount: total, paidAmount: paid, balanceDue: r2(total - paid), status: paid ? 'PAID' : 'UNPAID' });
    items.push({ id: cuid(), companyId: cid, invoiceId: invId, tagId: t.id, productCode: t.tagNumber, description: t.name, quantity: 1, grossWeight: t.grossWeight, netGoldWeight: t.netWeight, rateType: 'FIXED', goldRate: taxable, makingCharge: 0, unitPrice: taxable, totalPrice: taxable, taxRate: 0.03 });
    taxes.push({ id: cuid(), companyId: cid, invoiceId: invId, gstin: '24AAAAA0000A1Z5', placeOfSupply: '24', taxableAmount: taxable, cgst: r2(tax / 2), sgst: r2(tax / 2), totalTax: tax });
    const eid = cuid();
    entries.push({ id: eid, companyId: cid, entryNumber: `HIST-JE-${P}-${offI + i + 1}`, date, description: `Sale ${num}`, totalDebit: total, totalCredit: total, referenceType: 'INVOICE', referenceId: invId });
    lines.push({ id: cuid(), companyId: cid, entryId: eid, accountId: acct['1200'], debit: total, credit: 0 }, { id: cuid(), companyId: cid, entryId: eid, accountId: acct['4000'], debit: 0, credit: taxable }, { id: cuid(), companyId: cid, entryId: eid, accountId: acct['2201'], debit: 0, credit: r2(tax / 2) }, { id: cuid(), companyId: cid, entryId: eid, accountId: acct['2202'], debit: 0, credit: r2(tax - r2(tax / 2)) });
    balances.set(client.id, (balances.get(client.id) ?? 0) + (total - paid));
    if (paid) {
      pays.push({ id: cuid(), companyId: cid, paymentNumber: `HIST-PMT-${P}-${offI + i + 1}`, invoiceId: invId, clientId: client.id, paymentDate: date, amount: total, mode: pick(['CASH', 'UPI', 'CARD']) });
      const pe = cuid();
      payEntries.push({ id: pe, companyId: cid, entryNumber: `HIST-JP-${P}-${offI + i + 1}`, date, description: `Payment ${num}`, totalDebit: total, totalCredit: total, referenceType: 'PAYMENT', referenceId: invId });
      payLines.push({ id: cuid(), companyId: cid, entryId: pe, accountId: acct['1101'], debit: total, credit: 0 }, { id: cuid(), companyId: cid, entryId: pe, accountId: acct['1200'], debit: 0, credit: total });
    }
  }
  await chunk(invoices, 1500, (c) => prisma.salesInvoice.createMany({ data: c }));
  await chunk(items, 1500, (c) => prisma.invoiceItem.createMany({ data: c }));
  await chunk(taxes, 1500, (c) => prisma.taxInvoice.createMany({ data: c }));
  await chunk(pays, 1500, (c) => prisma.invoicePayment.createMany({ data: c }));
  await chunk([...entries, ...payEntries], 1500, (c) => prisma.journalEntry.createMany({ data: c }));
  await chunk([...lines, ...payLines], 3000, (c) => prisma.journalLine.createMany({ data: c }));
  for (const [id, bal] of balances) await prisma.client.update({ where: { id }, data: { currentBalance: r2(bal) } });
  console.log(code, 'invoices', invoices.length, 'items', items.length, 'payments', pays.length, 'journal entries', entries.length + payEntries.length, Date.now() - t0, 'ms');
  await prisma.$queryRawUnsafe('ANALYZE');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
