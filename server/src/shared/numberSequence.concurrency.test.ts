import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { nextDocumentNumber, nextSimpleCode, nextTagNumber } from './numberSequence';

// ═══════════════════════════════════════════════════
// Phase 4 Part C: concurrency proof for the one mechanism every company-specific document/code
// sequence in this codebase now goes through. The individual modules each have their own
// higher-level race tests (e.g. tagging.service.test.ts's double-tag GRN race), but this file
// proves the shared primitive itself — nextDocumentNumber/nextSimpleCode/nextTagNumber — never
// hands out a duplicate under real concurrent load, independent of any one module's business
// logic. Concurrency safety comes from number_sequences' atomic
// `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (see this file's own header comment) — Postgres
// takes the row lock as part of that single statement, so N simultaneous callers for the same key
// are guaranteed N distinct, non-colliding values.
// ═══════════════════════════════════════════════════

describe('Phase 4 Part C: NumberSequence concurrency', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyId: string;

  beforeAll(async () => {
    const company = await prisma.company.create({ data: { code: `NSQ-${suffix}`, name: 'NumberSequence Concurrency Test Co', stateCode: '24' } });
    companyId = company.id;
  });

  afterAll(async () => {
    await prisma.numberSequence.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it('50 concurrent nextDocumentNumber calls (same company/type/year) yield 50 unique, gapless-from-each-other numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => nextDocumentNumber(companyId, 'CONC-DOC', 'CD', undefined, 2026))
    );
    expect(new Set(results).size).toBe(50); // no duplicates
    const values = results.map((r) => Number(r.match(/(\d{6})$/)![1])).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => i + 1)); // exactly 1..50, no gaps, no repeats
  });

  it('50 concurrent nextSimpleCode calls (same company/type) yield 50 unique codes', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => nextSimpleCode(companyId, 'CONC-SIMPLE', 'CS', 5))
    );
    expect(new Set(results).size).toBe(50);
  });

  it('50 concurrent nextTagNumber calls (same company/stockType/category) yield 50 unique tag numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => nextTagNumber(companyId, 'R', 'RNG'))
    );
    expect(new Set(results).size).toBe(50);
  });

  it('two DIFFERENT companies never collide on the same document number even for the identical type/year', async () => {
    const companyB = await prisma.company.create({ data: { code: `NSQB-${suffix}`, name: 'NumberSequence Concurrency Test Co B', stateCode: '24' } });
    try {
      const [numA, numB] = await Promise.all([
        nextDocumentNumber(companyId, 'CONC-CROSS', 'CX', undefined, 2026),
        nextDocumentNumber(companyB.id, 'CONC-CROSS', 'CX', undefined, 2026),
      ]);
      // Both companies' FIRST number for this brand-new type/year is "CX-2026-000001" — proving
      // the counters are genuinely independent per company, not a shared global sequence that
      // just happened to interleave without colliding.
      expect(numA).toBe('CX-2026-000001');
      expect(numB).toBe('CX-2026-000001');
    } finally {
      await prisma.numberSequence.deleteMany({ where: { companyId: companyB.id } });
      await prisma.company.deleteMany({ where: { id: companyB.id } });
    }
  });
});
