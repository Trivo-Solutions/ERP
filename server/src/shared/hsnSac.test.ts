import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database';
import { searchHSN, searchSAC, getHSN, getSAC, validateCode } from './hsnSac';

// HsnCode is global platform reference data (no companyId — see its schema comment and
// CLAUDE.md §11's allow-list), so these tests create/delete their own uniquely-suffixed rows
// directly, the same pattern already used by finance.service.test.ts / sales.service.test.ts.
describe('hsnSac', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const hsnCode = `HS${suffix}`;
  const inactiveHsnCode = `HI${suffix}`;
  const sacCode = `SC${suffix}`;
  const ids: string[] = [];

  beforeAll(async () => {
    const hsn = await prisma.hsnCode.create({
      data: { code: hsnCode, description: `Test HSN jewellery ${suffix}`, gstRate: 0.03, isActive: true, codeType: 'HSN' },
    });
    const inactiveHsn = await prisma.hsnCode.create({
      data: { code: inactiveHsnCode, description: `Test inactive HSN ${suffix}`, gstRate: 0.05, isActive: false, codeType: 'HSN' },
    });
    const sac = await prisma.hsnCode.create({
      data: { code: sacCode, description: `Test SAC service ${suffix}`, gstRate: 0.18, isActive: true, codeType: 'SAC' },
    });
    ids.push(hsn.id, inactiveHsn.id, sac.id);
  });

  afterAll(async () => {
    await prisma.hsnCode.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  describe('searchHSN / searchSAC', () => {
    it('finds an HSN row by exact code (prefix match)', async () => {
      const { results, total } = await searchHSN(hsnCode);
      expect(total).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe(hsnCode);
      expect(results[0].codeType).toBe('HSN');
      expect(results[0].gstRate).toBe(0.03);
    });

    it('finds an HSN row by description substring', async () => {
      const { results } = await searchHSN(`jewellery ${suffix}`);
      expect(results.some((r) => r.code === hsnCode)).toBe(true);
    });

    it('never returns an inactive HSN row', async () => {
      const { results } = await searchHSN(inactiveHsnCode);
      expect(results).toHaveLength(0);
    });

    it('an empty/absent query returns results without loading everything unfiltered (still limited)', async () => {
      const { results } = await searchHSN(undefined, { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('respects limit/offset (pagination)', async () => {
      const page1 = await searchHSN(undefined, { limit: 1, offset: 0 });
      const page2 = await searchHSN(undefined, { limit: 1, offset: 1 });
      expect(page1.results).toHaveLength(1);
      expect(page2.results).toHaveLength(1);
      expect(page1.results[0].code).not.toBe(page2.results[0].code);
      expect(page1.total).toBe(page2.total);
    });

    it('an HSN search never returns a SAC row, and vice versa', async () => {
      const hsnResults = await searchHSN(suffix);
      expect(hsnResults.results.some((r) => r.code === sacCode)).toBe(false);

      const sacResults = await searchSAC(suffix);
      expect(sacResults.results.some((r) => r.code === hsnCode)).toBe(false);
      expect(sacResults.results.some((r) => r.code === sacCode)).toBe(true);
    });

    it('a query with no matches returns an empty result, not an error', async () => {
      const { results, total } = await searchHSN(`NO-SUCH-CODE-${suffix}`);
      expect(results).toEqual([]);
      expect(total).toBe(0);
    });
  });

  describe('getHSN / getSAC', () => {
    it('exact HSN lookup returns the row', async () => {
      const row = await getHSN(hsnCode);
      expect(row?.code).toBe(hsnCode);
      expect(row?.codeType).toBe('HSN');
    });

    it('exact SAC lookup returns the row', async () => {
      const row = await getSAC(sacCode);
      expect(row?.code).toBe(sacCode);
      expect(row?.codeType).toBe('SAC');
    });

    it('an HSN code looked up via getSAC (wrong type) returns null', async () => {
      expect(await getSAC(hsnCode)).toBeNull();
    });

    it('a nonexistent code returns null, not an error', async () => {
      expect(await getHSN(`NOPE-${suffix}`)).toBeNull();
    });
  });

  describe('validateCode', () => {
    it('a known active HSN code validates', async () => {
      const result = await validateCode(hsnCode, 'HSN');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('a known but inactive HSN code fails validation with a clear reason', async () => {
      const result = await validateCode(inactiveHsnCode, 'HSN');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/inactive/);
    });

    it('an unknown code fails validation', async () => {
      const result = await validateCode(`UNKNOWN-${suffix}`, 'HSN');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/not a known/);
    });

    it('empty/whitespace code is invalid without querying the database', async () => {
      const result = await validateCode('   ', 'HSN');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/required/);
    });

    it('a code of the wrong type is invalid (HSN code checked as SAC)', async () => {
      const result = await validateCode(hsnCode, 'SAC');
      expect(result.valid).toBe(false);
    });
  });
});
