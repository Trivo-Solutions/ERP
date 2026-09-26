import { describe, it, expect } from 'vitest';
import {
  STARTER_PACKAGE_V1, collectStarterPackageErrors, validateStarterPackage, registerStarterPackage,
  getStarterPackage, latestStarterPackageVersion, listStarterPackageVersions, type StarterPackageDefinition,
} from './starterPackage';
import { confusableKey, collidesWithExisting, validateCompanyCodeFormat, normalizeCompanyCode } from './companyCode';

const clone = (): StarterPackageDefinition => JSON.parse(JSON.stringify(STARTER_PACKAGE_V1));

describe('TRIVO Starter Package v1', () => {
  it('is valid, and is registered as version 1', () => {
    expect(collectStarterPackageErrors(STARTER_PACKAGE_V1)).toEqual([]);
    expect(getStarterPackage(1)).toBe(STARTER_PACKAGE_V1);
    expect(listStarterPackageVersions()).toContain(1);
    expect(latestStarterPackageVersion()).toBeGreaterThanOrEqual(1);
  });

  it('carries only reusable defaults: no ids, no company references, no timestamps, anywhere', () => {
    // Template layouts legitimately carry the designer's own element ids (el1, e2…) — those are part of
    // the layout JSON, not database ids — so they are examined separately below.
    const { templates, ...rest } = STARTER_PACKAGE_V1;
    const text = JSON.stringify(rest);
    expect(JSON.stringify(templates)).not.toMatch(/companyId|createdAt|updatedAt/);
    for (const forbidden of ['"id"', '"companyId"', '"createdAt"', '"updatedAt"', '"userId"', '"branchId"', '"clientId"', '"supplierId"']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('contains exactly the sections a starter may have — nothing operational is even representable', () => {
    expect(Object.keys(STARTER_PACKAGE_V1).sort()).toEqual(['chartOfAccounts', 'config', 'masters', 'name', 'roles', 'templates', 'version']);
    expect(Object.keys(STARTER_PACKAGE_V1.masters).sort()).toEqual([
      'collections', 'designCategories', 'karats', 'materialCodes', 'productCategories', 'stockTypes', 'stoneGrades', 'stoneTypes', 'subCategories',
    ]);
    expect(Object.keys(STARTER_PACKAGE_V1.templates).sort()).toEqual(['estimate', 'tag']);
  });

  it('classification: the SEA-specific configuration is NOT a starter default', () => {
    const keys = STARTER_PACKAGE_V1.config.map((c) => c.key);
    expect(keys).toEqual(['DEFAULT_GOLD_MARGIN']);
    expect(keys).not.toContain('SCALE_DEVICE_ID');      // a physical device
    expect(keys).not.toContain('HALLMARKING_CENTER');   // a company's own vendor
  });

  it('classification: no collections (brand/marketing) and no company-identifying template text', () => {
    expect(STARTER_PACKAGE_V1.masters.collections).toEqual([]);
    const layouts = JSON.stringify([STARTER_PACKAGE_V1.templates.tag, STARTER_PACKAGE_V1.templates.estimate]);
    expect(layouts).not.toMatch(/SEA|Vasavi|Shree|@/);
  });

  it('every sub-category resolves to a category, and every stone grade to a stone type', () => {
    const cats = new Set(STARTER_PACKAGE_V1.masters.productCategories.map((c) => c.code));
    for (const s of STARTER_PACKAGE_V1.masters.subCategories) expect(cats.has(s.categoryCode), s.code).toBe(true);
    const stones = new Set(STARTER_PACKAGE_V1.masters.stoneTypes.map((c) => c.code));
    for (const g of STARTER_PACKAGE_V1.masters.stoneGrades) expect(stones.has(g.stoneTypeCode)).toBe(true);
  });

  it('includes the chart-of-accounts codes the ledger posting code depends on', () => {
    const codes = new Set(STARTER_PACKAGE_V1.chartOfAccounts.map((a) => a.code));
    for (const c of ['1101', '1102', '1200', '1300', '1401', '1402', '1403', '2100', '2201', '2202', '2203', '4000', '5000', '6600']) expect(codes.has(c), c).toBe(true);
  });
});

describe('Starter Package validator — rejects anything that is not a reusable default', () => {
  const errorsFor = (mutate: (p: any) => void) => { const p = clone() as any; mutate(p); return collectStarterPackageErrors(p); };

  it('an id / companyId / timestamp on any item', () => {
    expect(errorsFor((p) => { p.masters.productCategories[0].id = 'x'; }).join()).toMatch(/unexpected field 'id'/);
    expect(errorsFor((p) => { p.masters.karats[0].companyId = 'c1'; }).join()).toMatch(/unexpected field 'companyId'/);
    expect(errorsFor((p) => { p.roles[0].createdAt = 'now'; }).join()).toMatch(/unexpected field 'createdAt'/);
  });

  it('an operational / company section that has no business in a package', () => {
    for (const section of ['clients', 'suppliers', 'tags', 'invoices', 'users', 'branches', 'hardwareDevices']) {
      expect(errorsFor((p) => { p[section] = []; }).join(), section).toMatch(new RegExp(`unexpected top-level field '${section}'`));
    }
    expect(errorsFor((p) => { p.masters.customers = []; }).join()).toMatch(/unexpected section 'customers'/);
  });

  it('configuration describing a company\'s own equipment, integrations, identity or credentials', () => {
    for (const key of ['SCALE_DEVICE_ID', 'PRINTER_PORT', 'SMTP_HOST', 'API_KEY', 'GSTIN', 'COMPANY_ADDRESS', 'BANK_ACCOUNT_NO', 'HALLMARKING_CENTER', 'WEBHOOK_URL', 'UPI_ID']) {
      const errs = errorsFor((p) => { p.config.push({ key, value: 'x', category: 'GENERAL' }); });
      expect(errs.join(), key).toMatch(/company-specific/);
    }
    expect(errorsFor((p) => { p.config.push({ key: 'SOMETHING', value: 'x', category: 'HARDWARE' }); }).join()).toMatch(/not an allowed starter category/);
  });

  it('an unresolved reference, a duplicate code, a second default template', () => {
    expect(errorsFor((p) => { p.masters.subCategories.push({ code: 'X', name: 'x', categoryCode: 'NOPE' }); }).join()).toMatch(/unknown categoryCode/);
    expect(errorsFor((p) => { p.masters.stoneGrades.push({ stoneTypeCode: 'NOPE' }); }).join()).toMatch(/unknown stoneTypeCode/);
    expect(errorsFor((p) => { p.masters.karats.push({ ...p.masters.karats[0] }); }).join()).toMatch(/duplicate/);
    expect(errorsFor((p) => { p.templates.tag.push({ ...p.templates.tag[0], name: 'Second', isDefault: true }); }).join()).toMatch(/more than one default/);
  });

  it('a print template carrying an e-mail address or a phone-like number', () => {
    expect(errorsFor((p) => { p.templates.estimate[0].layout.elements.push({ id: 'z', type: 'text', xMm: 0, yMm: 0, literalText: 'owner@shop.example' }); }).join()).toMatch(/e-mail/);
    expect(errorsFor((p) => { p.templates.tag[0].layout.elements.push({ id: 'z', type: 'text', xMm: 0, yMm: 0, literalText: 'Call 9876543210' }); }).join()).toMatch(/digit run/);
  });

  it('validateStarterPackage throws with every problem listed', () => {
    const bad = clone() as any; bad.masters.karats[0].id = 'x'; bad.customers = [];
    expect(() => validateStarterPackage(bad)).toThrow(/unexpected top-level field 'customers'[\s\S]*unexpected field 'id'/);
  });
});

describe('Starter Package versioning', () => {
  it('a released version is immutable: registering the same version again is refused', () => {
    expect(() => registerStarterPackage(clone())).toThrow(/already registered/);
  });
  it('an invalid package cannot be registered at all', () => {
    const bad = clone() as any; bad.version = 99; bad.masters.karats[0].id = 'x';
    expect(() => registerStarterPackage(bad)).toThrow(/Invalid Starter Package/);
    expect(listStarterPackageVersions()).not.toContain(99);
  });
  it('asking for an unknown version fails clearly', () => {
    expect(() => getStarterPackage(12345)).toThrow(/Unknown Starter Package/);
  });
});

describe('company code rules', () => {
  it('normalizes: trims and upper-cases (login does the same, so what is typed compares equal to what is stored)', () => {
    expect(normalizeCompanyCode('  vasavi ')).toBe('VASAVI');
    expect(validateCompanyCodeFormat(' shree ')).toEqual({ ok: true, code: 'SHREE' });
  });
  it('rejects malformed codes', () => {
    for (const bad of ['', 'AB', 'A', '1ABC', 'HAS SPACE', 'HYPHEN-X', 'UNDER_SCORE', 'TOOLONGCODE123', 'ÜBER', "X'; DROP", 'a/b']) {
      expect(validateCompanyCodeFormat(bad), bad).toEqual({ ok: false, reason: 'FORMAT' });
    }
  });
  it('rejects reserved words in any case', () => {
    for (const r of ['admin', 'TRIVO', 'Platform', 'api', 'login', 'null', 'undefined', 'root']) {
      expect(validateCompanyCodeFormat(r), r).toEqual({ ok: false, reason: 'RESERVED' });
    }
  });
  it('treats look-alikes as the same code (VASAV1 / VASAVL / VASAVI, SEA0 / SEAO)', () => {
    expect(confusableKey('VASAV1')).toBe(confusableKey('VASAVI'));
    expect(confusableKey('VASAVL')).toBe(confusableKey('VASAVI'));
    expect(confusableKey('SEA0')).toBe(confusableKey('SEAO'));
    expect(collidesWithExisting('VASAV1', ['SEA', 'VASAVI'])).toBe(true);
    expect(collidesWithExisting('SHREE', ['SEA', 'VASAVI'])).toBe(false);
  });
});
