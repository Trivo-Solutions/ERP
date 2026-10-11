import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Everything a NEW company starts with — roles, chart of accounts, masters, templates, default config —
// comes from the versioned TRIVO Starter Package (src/modules/platform/starterPackage). This seed builds
// the development company "SEA" from that same package, then adds SEA-specific DEMO data (sample clients,
// suppliers, rates, cost centers, ...) that is COMPANY data and deliberately not part of the package.

async function main() {
  console.log('🌱 Seeding SEA ERP database...');

  // ─── The existing business as Company #1 ────────────────────────────────────
  // Replaces the old singleton SystemConfig COMPANY_NAME/GSTIN/COMPANY_STATE_CODE rows — those
  // were correct for exactly one company and would have collided the moment a second one
  // existed. "SEA" is this company's Company Code for the Company Code + Username/Email +
  // Password login.
  const { applyStarterPackage, getStarterPackage } = await import('../src/modules/platform/starterPackage');
  const pkg = getStarterPackage(1);
  let company = await prisma.company.findUnique({ where: { code: 'SEA' } });
  const isNewCompany = !company;
  if (!company) {
    company = await prisma.company.create({
      data: {
        code: 'SEA',
        name: 'SEA Jewelry Pvt. Ltd.',
        gstin: '24ABCDE1234F1Z5',
        stateCode: '24',
        address: '123 Jewelers Street, Surat, Gujarat 395003',
        defaultCurrency: 'INR',
        starterPackageVersion: pkg.version,
        starterPackageAppliedAt: new Date(),
      },
    });
    // Copy the Starter Package into the new company (roles, chart of accounts, masters, templates, config).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${company!.id}, true)`;
      await applyStarterPackage(tx, company!.id, pkg);
    }, { timeout: 60_000 });
  }
  console.log(`✅ Company ${isNewCompany ? 'created + Starter Package v' + pkg.version + ' applied' : 'already exists (left untouched)'}: ${company.code} — ${company.name}`);

  const roles = await prisma.role.findMany({ where: { companyId: company.id } });
  const adminRole = roles.find((r) => r.name === 'SUPER_ADMIN')!;
  const prodRole = roles.find((r) => r.name === 'PRODUCTION_MANAGER')!;
  console.log(`✅ ${roles.length} roles present in ${company.code}`);

  // ─── Head Office branch ──────────────────────────────────────────────────────
  const headOffice = await prisma.branch.upsert({
    where: { companyId_branchCode: { companyId: company.id, branchCode: 'HO' } },
    update: {},
    create: { companyId: company.id, branchCode: 'HO', name: 'Head Office', isHeadOffice: true },
  });
  console.log(`✅ Branch seeded: ${headOffice.branchCode} — ${headOffice.name}`);

  // ─── Users + company membership ──────────────────────────────────────────────
  // User is a global identity (no roleId of its own — see the multi-tenant blueprint's explicit
  // reasoning); role/branch-access live on the CompanyUser membership instead. allBranches: true
  // for both seeded users — this is the one company that exists at seed time, with one branch,
  // so there is nothing to meaningfully restrict yet.
  // DEV/DEMO DATA ONLY (the SEA demo company with well-known logins). Never run against a live database — a real company is
  // created with provisionCompany / npm run company:provision, which generates its own credentials.
  if (process.env.NODE_ENV === 'production') throw new Error('prisma/seed.ts is dev-only demo data; refusing to run with NODE_ENV=production');
  const adminPass = await bcrypt.hash('Admin@123', 12);
  const defaultPass = await bcrypt.hash('Welcome@123', 12);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@sea-erp.com' },
    update: {},
    create: {
      email: 'admin@sea-erp.com', password: adminPass,
      name: 'System Administrator',
    },
  });
  const prodUser = await prisma.user.upsert({
    where: { email: 'manager@sea-erp.com' },
    update: {},
    create: {
      email: 'manager@sea-erp.com', password: defaultPass,
      name: 'Production Manager',
    },
  });

  await prisma.companyUser.upsert({
    where: { companyId_userId: { companyId: company.id, userId: adminUser.id } },
    update: {},
    // Employee id / department are this company's own facts about the person, so they live on the
    // membership (not the global User). update: {} — never overwrite what the company has since edited.
    create: { companyId: company.id, userId: adminUser.id, roleId: adminRole.id, allBranches: true, isDefault: true, employeeId: 'EMP-001', department: 'Administration' },
  });
  await prisma.companyUser.upsert({
    where: { companyId_userId: { companyId: company.id, userId: prodUser.id } },
    update: {},
    create: { companyId: company.id, userId: prodUser.id, roleId: prodRole.id, allBranches: true, isDefault: true, employeeId: 'EMP-002', department: 'Production' },
  });

  console.log('✅ 2 users seeded (admin@sea-erp.com / Admin@123), each with a CompanyUser membership in SEA');

  // ─── Process Tolerances ───────────────────────────────────────────────────
  const tolerances = [
    { processName: 'MELTING', maxLossPercent: 1.5, deductionRate: 5000, alertThreshold: 1.0 },
    { processName: 'CASTING', maxLossPercent: 2.0, deductionRate: 4500, alertThreshold: 1.5 },
    { processName: 'FILING', maxLossPercent: 1.0, deductionRate: 3500, alertThreshold: 0.8 },
    { processName: 'PRE_POLISH', maxLossPercent: 0.8, deductionRate: 3000, alertThreshold: 0.5 },
    { processName: 'SETTING', maxLossPercent: 0.5, deductionRate: 2000, alertThreshold: 0.3 },
    { processName: 'POLISH', maxLossPercent: 1.5, deductionRate: 3000, alertThreshold: 1.0 },
    { processName: 'RHODIUM', maxLossPercent: 0.3, deductionRate: 1000, alertThreshold: 0.2 },
  ];

  for (const tol of tolerances) {
    await prisma.processTolerance.upsert({
      where: { companyId_processName: { companyId: company.id, processName: tol.processName } },
      update: tol,
      create: { ...tol, companyId: company.id },
    });
  }
  console.log('✅ 7 process tolerances seeded');

  // ─── Metal Rates ──────────────────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const metalRates = [
    { karat: '24K', purity: 0.9999, ratePerGram: 6850, source: 'IBJA' },
    { karat: '22K', purity: 0.916, ratePerGram: 6276, source: 'IBJA' },
    { karat: '18K', purity: 0.75, ratePerGram: 5137, source: 'IBJA' },
    { karat: '14K', purity: 0.585, ratePerGram: 4007, source: 'IBJA' },
    { karat: 'SILVER', purity: 0.925, ratePerGram: 87.5, source: 'MCX' },
    { karat: 'PT', purity: 0.95, ratePerGram: 3200, source: 'IBJA' },
  ];

  for (const rate of metalRates) {
    await prisma.metalRate.upsert({
      where: { companyId_date_karat_currency: { companyId: company.id, date: today, karat: rate.karat, currency: 'INR' } },
      update: { ratePerGram: rate.ratePerGram },
      create: { companyId: company.id, date: today, currency: 'INR', ...rate },
    });
  }
  console.log('✅ Metal rates seeded for today');

  // ─── HSN / GST Rates ──────────────────────────────────────────────────────
  await prisma.hsnCode.upsert({
    where: { code: '7113' },
    update: {},
    create: {
      code: '7113',
      description: 'Articles of jewellery and parts thereof, of precious metal',
      gstRate: 0.03,
    },
  });
  console.log('✅ HSN 7113 (jewellery, 3% GST) seeded');

  // ─── GST State Master ─────────────────────────────────────────────────────
  // Full list also inserted directly by migration 20260824085712_add_state_master, so it's
  // present on any migrated DB even without running this seed script. Kept here too so a fresh
  // `db:seed` run is self-sufficient and to keep this list visible alongside the rest of seed data.
  const gstStates: Array<{ code: string; name: string; aliases?: string[] }> = [
    { code: '01', name: 'Jammu and Kashmir', aliases: ['J&K', 'JK'] },
    { code: '02', name: 'Himachal Pradesh', aliases: ['HP'] },
    { code: '03', name: 'Punjab', aliases: ['PB'] },
    { code: '04', name: 'Chandigarh' },
    { code: '05', name: 'Uttarakhand', aliases: ['UK', 'Uttaranchal'] },
    { code: '06', name: 'Haryana', aliases: ['HR'] },
    { code: '07', name: 'Delhi', aliases: ['NCT of Delhi', 'New Delhi'] },
    { code: '08', name: 'Rajasthan', aliases: ['RJ'] },
    { code: '09', name: 'Uttar Pradesh', aliases: ['UP'] },
    { code: '10', name: 'Bihar', aliases: ['BR'] },
    { code: '11', name: 'Sikkim' },
    { code: '12', name: 'Arunachal Pradesh', aliases: ['AR'] },
    { code: '13', name: 'Nagaland' },
    { code: '14', name: 'Manipur' },
    { code: '15', name: 'Mizoram' },
    { code: '16', name: 'Tripura' },
    { code: '17', name: 'Meghalaya' },
    { code: '18', name: 'Assam', aliases: ['AS'] },
    { code: '19', name: 'West Bengal', aliases: ['WB'] },
    { code: '20', name: 'Jharkhand', aliases: ['JH'] },
    { code: '21', name: 'Odisha', aliases: ['Orissa'] },
    { code: '22', name: 'Chhattisgarh', aliases: ['CG', 'Chattisgarh'] },
    { code: '23', name: 'Madhya Pradesh', aliases: ['MP'] },
    { code: '24', name: 'Gujarat', aliases: ['GJ'] },
    { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', aliases: ['Dadra and Nagar Haveli', 'Daman and Diu'] },
    { code: '27', name: 'Maharashtra', aliases: ['MH'] },
    { code: '29', name: 'Karnataka', aliases: ['KA'] },
    { code: '30', name: 'Goa', aliases: ['GA'] },
    { code: '31', name: 'Lakshadweep' },
    { code: '32', name: 'Kerala', aliases: ['KL'] },
    { code: '33', name: 'Tamil Nadu', aliases: ['TN'] },
    { code: '34', name: 'Puducherry', aliases: ['Pondicherry'] },
    { code: '35', name: 'Andaman and Nicobar Islands', aliases: ['Andaman and Nicobar'] },
    { code: '36', name: 'Telangana', aliases: ['TS', 'TG'] },
    { code: '37', name: 'Andhra Pradesh', aliases: ['AP'] },
    { code: '38', name: 'Ladakh' },
    { code: '97', name: 'Other Territory' },
    { code: '99', name: 'Centre Jurisdiction' },
  ];

  for (const state of gstStates) {
    await prisma.stateMaster.upsert({
      where: { code: state.code },
      update: { name: state.name, aliases: state.aliases ?? [] },
      create: { code: state.code, name: state.name, aliases: state.aliases ?? [] },
    });
  }
  console.log(`✅ ${gstStates.length} GST state codes seeded`);

  // ─── Cost Centers ─────────────────────────────────────────────────────────
  // Phase 2: CostCenter is now company-owned too (companyId + @@unique([companyId, code])).
  const costCenters = [
    { code: 'CC-ADMIN', name: 'Administration', department: 'ADMIN' },
    { code: 'CC-CAD', name: 'CAD / 3D Design Room', department: 'CAD_ROOM' },
    { code: 'CC-CAST', name: 'Casting Department', department: 'CASTING' },
    { code: 'CC-POL', name: 'Polishing Department', department: 'POLISHING' },
    { code: 'CC-SET', name: 'Diamond Setting', department: 'SETTING' },
    { code: 'CC-RHD', name: 'Rhodium Plating', department: 'RHODIUM' },
    { code: 'CC-SALES', name: 'Sales & Marketing', department: 'SALES' },
  ];

  for (const cc of costCenters) {
    await prisma.costCenter.upsert({
      where: { companyId_code: { companyId: company.id, code: cc.code } },
      update: {},
      create: { ...cc, companyId: company.id },
    });
  }
  console.log(`✅ 7 cost centers seeded for ${company.code}`);

  // ─── SEA-specific configuration (COMPANY data — not in the Starter Package) ────
  // SCALE_DEVICE_ID names a physical device and HALLMARKING_CENTER is this company's own vendor choice, so
  // neither is a TRIVO default; only SEA has them. (DEFAULT_GOLD_MARGIN came from the package.)
  const seaConfigs = [
    { key: 'SCALE_DEVICE_ID', value: 'default-scale', category: 'HARDWARE' },
    { key: 'HALLMARKING_CENTER', value: 'BIS Hallmarking Center', category: 'COMPLIANCE' },
  ];
  for (const config of seaConfigs) {
    await prisma.systemConfig.upsert({
      where: { companyId_key: { companyId: company.id, key: config.key } },
      update: { value: config.value },
      create: { companyId: company.id, ...config },
    });
  }
  console.log(`✅ SEA-specific configuration seeded for ${company.code}`);

  // ─── Sample Design ────────────────────────────────────────────────────────
  const rngCat = await prisma.designCategory.findUnique({ where: { companyId_code: { companyId: company.id, code: 'RNG' } } });
  if (rngCat) {
    await prisma.design.upsert({
      where: { companyId_designCode: { companyId: company.id, designCode: 'RNG-0001' } },
      update: {},
      create: {
        companyId: company.id, designCode: 'RNG-0001', name: 'Classic Solitaire Ring',
        categoryId: rngCat.id, metalKarat: '18K',
        grossWeightMin: 4.5, grossWeightMax: 5.2,
        netWeightMin: 3.8, netWeightMax: 4.4,
        description: 'Classic 4-prong solitaire ring with round brilliant centre stone',
        status: 'APPROVED',
        bomItems: {
          createMany: {
            data: [
              { companyId: company.id, materialType: 'METAL', materialCode: '18K-YG', materialName: '18K Yellow Gold', quantity: 4.5, unit: 'GM', karat: '18K', wastagePercent: 2, sequence: 1 },
              { companyId: company.id, materialType: 'DIAMOND', materialCode: 'DIA-RB-1CT', materialName: 'Diamond Round Brilliant 1.00ct', quantity: 1, unit: 'PC', quality: 'VS1', wastagePercent: 0, sequence: 2 },
            ],
          },
        },
        bomProcesses: {
          createMany: {
            data: [
              { companyId: company.id, processName: 'MELTING', sequence: 1, makingChargeType: 'PER_GRAM', makingChargeValue: 150, wastagePercent: 1.5, estimatedMinutes: 30 },
              { companyId: company.id, processName: 'CASTING', sequence: 2, makingChargeType: 'PER_PIECE', makingChargeValue: 200, wastagePercent: 2, estimatedMinutes: 45 },
              { companyId: company.id, processName: 'FILING', sequence: 3, makingChargeType: 'PER_PIECE', makingChargeValue: 100, wastagePercent: 1, estimatedMinutes: 60 },
              { companyId: company.id, processName: 'PRE_POLISH', sequence: 4, makingChargeType: 'PER_PIECE', makingChargeValue: 80, wastagePercent: 0.8, estimatedMinutes: 45 },
              { companyId: company.id, processName: 'SETTING', sequence: 5, makingChargeType: 'FIXED', makingChargeValue: 500, wastagePercent: 0.5, estimatedMinutes: 90, isOutsourced: false },
              { companyId: company.id, processName: 'POLISH', sequence: 6, makingChargeType: 'PER_PIECE', makingChargeValue: 120, wastagePercent: 1.5, estimatedMinutes: 30 },
              { companyId: company.id, processName: 'RHODIUM', sequence: 7, makingChargeType: 'PER_PIECE', makingChargeValue: 80, wastagePercent: 0.3, estimatedMinutes: 20 },
            ],
          },
        },
      },
    });
    console.log('✅ Sample design RNG-0001 seeded');
  }

  // ─── Sample Supplier ──────────────────────────────────────────────────────
  // SEA demo data (COMPANY data — not part of the Starter Package).
  await prisma.supplier.upsert({
    where: { companyId_supplierCode: { companyId: company.id, supplierCode: 'MR-0001' } },
    update: {},
    create: {
      companyId: company.id, supplierCode: 'MR-0001', name: 'Rajesh Gold Refinery',
      type: 'METAL_REFINER', gstNumber: '24AABCR1234A1Z1',
      city: 'Ahmedabad', state: 'Gujarat', phone: '+91-79-12345678',
      email: 'info@rajeshgold.com',
    },
  });

  await prisma.supplier.upsert({
    where: { companyId_supplierCode: { companyId: company.id, supplierCode: 'SD-0001' } },
    update: {},
    create: {
      companyId: company.id, supplierCode: 'SD-0001', name: 'Mumbai Diamond House',
      type: 'STONE_DEALER', gstNumber: '27AABCM5678B1Z2',
      city: 'Mumbai', state: 'Maharashtra', phone: '+91-22-87654321',
    },
  });

  console.log('✅ 2 sample suppliers seeded');

  // ─── Sample Clients ───────────────────────────────────────────────────────
  // Client IS in the prototype's tenant-scoped model set — companyId required.
  await prisma.client.upsert({
    where: { companyId_clientCode: { companyId: company.id, clientCode: 'CL-00001' } },
    update: {},
    create: {
      companyId: company.id,
      clientCode: 'CL-00001', name: 'Priya Sharma',
      type: 'RETAIL', phone: '+91-98765-43210',
    },
  });

  await prisma.client.upsert({
    where: { companyId_clientCode: { companyId: company.id, clientCode: 'CL-00002' } },
    update: {},
    create: {
      companyId: company.id,
      clientCode: 'CL-00002', name: 'Aurum Jewellers Pvt. Ltd.',
      type: 'WHOLESALE', gstNumber: '27AAACA1234B1Z5', panNumber: 'AAACA1234B',
      city: 'Mumbai', state: 'Maharashtra', phone: '+91-22-40123456',
      email: 'accounts@aurumjewellers.example', creditLimit: 500000, pricingTier: 'PREFERRED',
    },
  });

  console.log('✅ 2 sample clients seeded');

  console.log('\n🎉 Database seeding complete!');
  console.log('\n📋 Default Credentials (Company Code: SEA):');
  console.log('  Admin:   SEA / admin@sea-erp.com  /  Admin@123');
  console.log('  Manager: SEA / manager@sea-erp.com  /  Welcome@123');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('Seed error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
