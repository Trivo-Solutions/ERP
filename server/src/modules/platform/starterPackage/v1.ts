import type { StarterPackageDefinition } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// TRIVO Starter Package v1
//
// CLASSIFICATION of what the original single-company (SEA) setup contained — the reasoning
// behind every inclusion and exclusion below. Rule applied throughout: if a record is uncertain,
// it is COMPANY data and is NOT in the package.
//
//  STARTER (in this package)
//    roles                 the six permission bundles the app was built around
//    chart of accounts     the 38-account jewellery chart the ledger posting code depends on
//    karats                gold/silver/platinum purity list
//    design categories     Rings, Necklaces, Earrings, ...
//    product categories +  a standard jewellery taxonomy (new — SEA never had one; the screens
//    sub-categories        were simply empty)
//    material codes        standard metal / stone material codes
//    stock types           Ready / Sample / Consignment (single-letter code = tag-number prefix)
//    stone types + grades  diamond & common coloured stones with a small grading ladder
//    tag template          the "Default Jewelry Tag" 50x30mm label
//    estimate template     a generic 80mm roll estimate (new — SEA had none)
//    config                DEFAULT_GOLD_MARGIN only
//
//  COMPANY (never in the package — stays only with the company that entered it)
//    clients / suppliers / members / users / branches (SEA's "Head Office"; a new company gets its
//    own, created by provisioning from its own input) / cost centers (SEA's manufacturing
//    departments) / metal rates (a company's own daily quotes) / process tolerances and making
//    charges and price master (commercial policy) / collections (marketing & brand) / all
//    inventory, sales, purchase, finance and audit records.
//    Config excluded: SCALE_DEVICE_ID (a physical device), HALLMARKING_CENTER (a company's own
//    vendor choice).
//
//  PLATFORM (owned by TRIVO, no company): HSN codes, GST state master.
//
// A package is IMMUTABLE once released: to change starter data, add v2 (a new file); existing
// companies are never touched.
// ═══════════════════════════════════════════════════════════════════════════

export const STARTER_PACKAGE_V1: StarterPackageDefinition = {
  version: 1,
  name: 'TRIVO Starter Package v1 — Jewellery Trading',

  roles: [
    { name: 'SUPER_ADMIN', displayName: 'Super Administrator', permissions: ['*'] },
    {
      name: 'PRODUCTION_MANAGER', displayName: 'Production Manager',
      permissions: [
        'design:view', 'bom:manage', 'cost:estimate',
        'po:view', 'grn:create', 'stock:view', 'stone:manage', 'stone:split',
        'order:view', 'order:create', 'order:approve', 'reservation:manage',
        'job:view', 'job:create', 'job:update', 'wip:update', 'qc:inspect', 'qc:approve',
        'karigar:view', 'karigar:issue', 'karigar:return',
        'hallmark:manage', 'repair:manage', 'invoice:create', 'report:view', 'masters:view',
      ],
    },
    {
      name: 'ACCOUNTANT', displayName: 'Accountant',
      permissions: [
        'finance:view', 'journal:create', 'journal:post',
        'report:view', 'tax:manage', 'invoice:create',
        'sales:view', 'stock:view', 'order:view', 'masters:view',
      ],
    },
    {
      name: 'SALES_MANAGER', displayName: 'Sales Manager',
      permissions: [
        'sales:view', 'sales:create', 'memo:manage', 'invoice:create',
        'export:doc', 'order:view', 'order:create', 'report:view', 'masters:view',
        'estimation:view', 'estimation:manage', 'estimateTemplate:view',
        'tag:view', 'tag:create', 'branch:manage', 'branch:transfer', 'branch:approve',
        'stock:adjust', 'user:manage', 'role:manage', 'system:config', 'audit:view',
      ],
    },
    { name: 'FLOOR_WORKER', displayName: 'Floor Worker', permissions: ['job:view', 'wip:update', 'karigar:view'] },
    {
      name: 'STORE_MANAGER', displayName: 'Store / Inventory Manager',
      permissions: [
        'stock:view', 'stock:adjust', 'stone:manage', 'stone:split',
        'consumable:manage', 'po:view', 'grn:create', 'grn:verify', 'report:view', 'masters:view',
        'tagTemplate:manage', 'estimation:view', 'estimation:manage',
        'estimateTemplate:view', 'estimateTemplate:manage',
      ],
    },
  ],

  chartOfAccounts: [
    // Assets
    { code: '1000', name: 'Current Assets', type: 'ASSET', subType: 'CURRENT_ASSET', isSystem: true },
    { code: '1100', name: 'Cash & Bank', type: 'ASSET', subType: 'CASH', isSystem: true },
    { code: '1101', name: 'Cash in Hand', type: 'ASSET', subType: 'CASH', isSystem: true },
    { code: '1102', name: 'Bank Account', type: 'ASSET', subType: 'BANK', isSystem: true },
    { code: '1200', name: 'Accounts Receivable', type: 'ASSET', subType: 'RECEIVABLE', isSystem: true },
    { code: '1300', name: 'Inventory - Gold Stock', type: 'ASSET', subType: 'INVENTORY', isSystem: true },
    { code: '1301', name: 'Inventory - Diamond Stock', type: 'ASSET', subType: 'INVENTORY', isSystem: true },
    { code: '1302', name: 'WIP Stock', type: 'ASSET', subType: 'INVENTORY', isSystem: true },
    { code: '1400', name: 'Advance Payments', type: 'ASSET', subType: 'PREPAID', isSystem: true },
    // Input tax credit: GST paid to suppliers on finished-goods intake (LEDGER_ACCOUNT.INPUT_*).
    { code: '1401', name: 'Input CGST (ITC)', type: 'ASSET', subType: 'TAX', isSystem: true },
    { code: '1402', name: 'Input SGST (ITC)', type: 'ASSET', subType: 'TAX', isSystem: true },
    { code: '1403', name: 'Input IGST (ITC)', type: 'ASSET', subType: 'TAX', isSystem: true },
    { code: '1500', name: 'Fixed Assets', type: 'ASSET', subType: 'FIXED_ASSET', isSystem: true },
    { code: '1501', name: 'Machinery & Equipment', type: 'ASSET', subType: 'FIXED_ASSET', isSystem: true },
    // Liabilities
    { code: '2000', name: 'Current Liabilities', type: 'LIABILITY', subType: 'CURRENT', isSystem: true },
    { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', subType: 'PAYABLE', isSystem: true },
    { code: '2200', name: 'GST Payable', type: 'LIABILITY', subType: 'TAX', isSystem: true },
    { code: '2201', name: 'CGST Payable', type: 'LIABILITY', subType: 'TAX', isSystem: true },
    { code: '2202', name: 'SGST Payable', type: 'LIABILITY', subType: 'TAX', isSystem: true },
    { code: '2203', name: 'IGST Payable', type: 'LIABILITY', subType: 'TAX', isSystem: true },
    { code: '2300', name: 'Loan Payable', type: 'LIABILITY', subType: 'LOAN', isSystem: true },
    // Equity
    { code: '3000', name: 'Owner Equity', type: 'EQUITY', isSystem: true },
    { code: '3100', name: 'Retained Earnings', type: 'EQUITY', isSystem: true },
    // Revenue
    { code: '4000', name: 'Sales Revenue', type: 'REVENUE', isSystem: true },
    { code: '4100', name: 'Gold Jewelry Sales', type: 'REVENUE', isSystem: true },
    { code: '4200', name: 'Diamond Jewelry Sales', type: 'REVENUE', isSystem: true },
    { code: '4300', name: 'Making Charges Received', type: 'REVENUE', isSystem: true },
    { code: '4400', name: 'Export Sales', type: 'REVENUE', isSystem: true },
    // Expenses
    { code: '5000', name: 'Cost of Goods', type: 'EXPENSE', isSystem: true },
    { code: '5100', name: 'Raw Material - Gold', type: 'EXPENSE', isSystem: true },
    { code: '5200', name: 'Raw Material - Diamonds', type: 'EXPENSE', isSystem: true },
    { code: '5300', name: 'Making Charges Paid', type: 'EXPENSE', isSystem: true },
    { code: '5400', name: 'Manufacturing Overhead', type: 'EXPENSE', isSystem: true },
    { code: '5500', name: 'Wastage & Loss', type: 'EXPENSE', isSystem: true },
    { code: '6000', name: 'Operating Expenses', type: 'EXPENSE', isSystem: true },
    { code: '6100', name: 'Salary & Wages', type: 'EXPENSE', isSystem: true },
    { code: '6200', name: 'Rent & Utilities', type: 'EXPENSE', isSystem: true },
    { code: '6300', name: 'Administrative Expenses', type: 'EXPENSE', isSystem: true },
    { code: '6400', name: 'Hallmarking Charges', type: 'EXPENSE', isSystem: true },
    { code: '6500', name: 'Bank Charges', type: 'EXPENSE', isSystem: true },
    { code: '7000', name: 'Forex Gain/Loss', type: 'EXPENSE', isSystem: true },
  ],

  masters: {
    karats: [
      { code: '24K', metalType: 'GOLD', purity: '0.9999' },
      { code: '22K', metalType: 'GOLD', purity: '0.9160' },
      { code: '18K', metalType: 'GOLD', purity: '0.7500' },
      { code: '14K', metalType: 'GOLD', purity: '0.5850' },
      { code: '10K', metalType: 'GOLD', purity: '0.4170' },
      { code: 'SILVER', metalType: 'SILVER', purity: '0.9250' },
      { code: '925', metalType: 'SILVER', purity: '0.9250' },
      { code: 'PT', metalType: 'PLATINUM', purity: '0.9500' },
    ],

    designCategories: [
      { code: 'RNG', name: 'Rings' },
      { code: 'NKL', name: 'Necklaces' },
      { code: 'ERG', name: 'Earrings' },
      { code: 'BRC', name: 'Bracelets & Bangles' },
      { code: 'PND', name: 'Pendants' },
      { code: 'BSS', name: 'Brooches & Sets' },
    ],

    productCategories: [
      { code: 'RNG', name: 'Rings' },
      { code: 'NKL', name: 'Necklaces' },
      { code: 'CHN', name: 'Chains' },
      { code: 'ERG', name: 'Earrings' },
      { code: 'BNG', name: 'Bangles' },
      { code: 'BRC', name: 'Bracelets' },
      { code: 'PND', name: 'Pendants' },
      { code: 'MNG', name: 'Mangalsutra' },
      { code: 'ANK', name: 'Anklets' },
      { code: 'NSP', name: 'Nose Pins' },
      { code: 'SET', name: 'Jewellery Sets' },
      { code: 'COI', name: 'Coins & Bars' },
      { code: 'OTH', name: 'Others' },
    ],

    subCategories: [
      { code: 'RNG-SOL', name: 'Solitaire', categoryCode: 'RNG' },
      { code: 'RNG-BND', name: 'Band', categoryCode: 'RNG' },
      { code: 'RNG-CKT', name: 'Cocktail', categoryCode: 'RNG' },
      { code: 'RNG-CPL', name: 'Couple', categoryCode: 'RNG' },
      { code: 'NKL-CHK', name: 'Choker', categoryCode: 'NKL' },
      { code: 'NKL-HAR', name: 'Haar', categoryCode: 'NKL' },
      { code: 'NKL-LNG', name: 'Long Necklace', categoryCode: 'NKL' },
      { code: 'ERG-STD', name: 'Studs', categoryCode: 'ERG' },
      { code: 'ERG-JHM', name: 'Jhumka', categoryCode: 'ERG' },
      { code: 'ERG-HPS', name: 'Hoops', categoryCode: 'ERG' },
      { code: 'ERG-DRP', name: 'Drops', categoryCode: 'ERG' },
      { code: 'BNG-PLN', name: 'Plain Bangle', categoryCode: 'BNG' },
      { code: 'BNG-KDA', name: 'Kada', categoryCode: 'BNG' },
      { code: 'BNG-STN', name: 'Stone Bangle', categoryCode: 'BNG' },
    ],

    // Collections are brand/marketing choices — company data. None by default.
    collections: [],

    materialCodes: [
      { code: 'G24', name: 'Gold 24K', materialType: 'METAL', karat: '24K', unit: 'GM' },
      { code: 'G22', name: 'Gold 22K', materialType: 'METAL', karat: '22K', unit: 'GM' },
      { code: 'G18', name: 'Gold 18K', materialType: 'METAL', karat: '18K', unit: 'GM' },
      { code: 'G14', name: 'Gold 14K', materialType: 'METAL', karat: '14K', unit: 'GM' },
      { code: 'S925', name: 'Silver 925', materialType: 'METAL', karat: '925', unit: 'GM' },
      { code: 'PT950', name: 'Platinum 950', materialType: 'METAL', karat: 'PT', unit: 'GM' },
      { code: 'DIA', name: 'Diamond', materialType: 'DIAMOND', unit: 'CT' },
      { code: 'STN', name: 'Colour Stone', materialType: 'STONE', unit: 'CT' },
    ],

    stockTypes: [
      { code: 'R', name: 'Ready Stock', description: 'Finished pieces available for sale' },
      { code: 'S', name: 'Sample Stock', description: 'Showroom / sample pieces' },
      { code: 'C', name: 'Consignment Stock', description: 'Pieces held on consignment' },
    ],

    stoneTypes: [
      { code: 'DIA', name: 'Diamond', itemType: 'DIAMOND', unit: 'CT' },
      { code: 'RUB', name: 'Ruby', itemType: 'STONE', unit: 'CT' },
      { code: 'EMR', name: 'Emerald', itemType: 'STONE', unit: 'CT' },
      { code: 'SAP', name: 'Blue Sapphire', itemType: 'STONE', unit: 'CT' },
      { code: 'CZ', name: 'Cubic Zirconia', itemType: 'STONE', unit: 'CT' },
      { code: 'PRL', name: 'Pearl', itemType: 'PEARL', unit: 'GM' },
    ],

    stoneGrades: [
      { stoneTypeCode: 'DIA', shape: 'Round', color: 'F', clarity: 'VVS1', cut: 'Excellent' },
      { stoneTypeCode: 'DIA', shape: 'Round', color: 'G', clarity: 'VS1', cut: 'Very Good' },
      { stoneTypeCode: 'DIA', shape: 'Round', color: 'H', clarity: 'SI1', cut: 'Good' },
      { stoneTypeCode: 'RUB', quality: 'AAA' },
      { stoneTypeCode: 'RUB', quality: 'AA' },
      { stoneTypeCode: 'EMR', quality: 'AAA' },
      { stoneTypeCode: 'EMR', quality: 'AA' },
      { stoneTypeCode: 'SAP', quality: 'AAA' },
      { stoneTypeCode: 'SAP', quality: 'AA' },
    ],
  },

  templates: {
    tag: [
      {
        name: 'Default Jewelry Tag', isDefault: true, widthMm: 50, heightMm: 30, gapMm: 2,
        layout: {
          elements: [
            { id: 'el1', wing: 'front', type: 'barcode', xMm: 4, yMm: 2, boundField: 'tagNumber', barcodeType: 'CODE128', heightMm: 10, humanReadable: true },
            { id: 'el2', wing: 'front', type: 'text', xMm: 4, yMm: 14, boundField: 'name', fontSize: 9 },
            { id: 'el3', wing: 'front', type: 'text', xMm: 4, yMm: 19, boundField: 'metalKarat', fontSize: 8 },
            { id: 'el4', wing: 'front', type: 'text', xMm: 22, yMm: 19, boundField: 'grossWeight', fontSize: 8 },
            { id: 'el5', wing: 'front', type: 'text', xMm: 4, yMm: 24, boundField: 'sellingPrice', fontSize: 10 },
            { id: 'el6', wing: 'front', type: 'text', xMm: 4, yMm: 27, boundField: 'huid', fontSize: 7 },
          ],
        },
      },
    ],
    estimate: [
      {
        name: 'Default Estimate (80mm roll)', isDefault: true, widthMm: 80, heightMm: 160,
        layout: {
          elements: [
            { id: 'e1', type: 'text', xMm: 4, yMm: 4, widthMm: 72, literalText: 'ESTIMATE', fontSize: 14, align: 'center' },
            { id: 'e2', type: 'text', xMm: 4, yMm: 11, widthMm: 72, boundField: 'branchName', fontSize: 9, align: 'center' },
            { id: 'e3', type: 'text', xMm: 4, yMm: 18, literalText: 'Estimate No', fontSize: 8 },
            { id: 'e4', type: 'text', xMm: 30, yMm: 18, boundField: 'estimateNumber', fontSize: 8 },
            { id: 'e5', type: 'text', xMm: 4, yMm: 23, literalText: 'Date', fontSize: 8 },
            { id: 'e6', type: 'text', xMm: 30, yMm: 23, boundField: 'generatedOn', fontSize: 8 },
            { id: 'e7', type: 'text', xMm: 4, yMm: 28, literalText: 'Valid Until', fontSize: 8 },
            { id: 'e8', type: 'text', xMm: 30, yMm: 28, boundField: 'validUntil', fontSize: 8 },
            { id: 'e9', type: 'text', xMm: 4, yMm: 36, boundField: 'itemName', fontSize: 10 },
            { id: 'e10', type: 'text', xMm: 4, yMm: 42, boundField: 'tagNumber', fontSize: 8 },
            {
              id: 'e11', type: 'materialsTable', xMm: 4, yMm: 48, includeChargeRows: true,
              columns: [
                { field: 'name', label: 'Item', widthMm: 30 },
                { field: 'weight', label: 'Wt', widthMm: 12 },
                { field: 'saleRate', label: 'Rate', widthMm: 14 },
                { field: 'saleAmount', label: 'Amount', widthMm: 16 },
              ],
            },
            { id: 'e12', type: 'text', xMm: 4, yMm: 118, literalText: 'GST', fontSize: 8 },
            { id: 'e13', type: 'text', xMm: 40, yMm: 118, boundField: 'gstAmount', fontSize: 8 },
            { id: 'e14', type: 'text', xMm: 4, yMm: 124, literalText: 'Net Payable', fontSize: 10 },
            { id: 'e15', type: 'text', xMm: 40, yMm: 124, boundField: 'netPayableAmount', fontSize: 10 },
            { id: 'e16', type: 'text', xMm: 4, yMm: 134, widthMm: 72, literalText: 'This is an estimate, not a tax invoice.', fontSize: 7, align: 'center' },
          ],
        },
      },
    ],
  },

  // The ONLY configuration that is a genuine TRIVO default. SCALE_DEVICE_ID (a physical device) and
  // HALLMARKING_CENTER (a company's own vendor) exist in SEA but are company data.
  config: [
    { key: 'DEFAULT_GOLD_MARGIN', value: '15', category: 'PRICING' },
  ],
};
