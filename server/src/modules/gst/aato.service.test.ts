import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { createGstRegistration } from '../company/company.service';
import { saveAato, getAato, getAatoHistory } from './aato.service';
import { tenantQuery } from '../../shared/tenantContext';
import { AppError } from '../../middleware/error';

describe('AATO Service (Phase D)', () => {
  const suffix = `aato-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let regA1Id: string;
  let regA2Id: string;
  let regB1Id: string;

  beforeAll(async () => {
    tenantA = await createTestTenant(suffix, ['gst:registration_view', 'gst:registration_create', 'gst:registration_edit']);
    tenantB = await createTestTenant(`${suffix}-b`, ['gst:registration_view', 'gst:registration_create', 'gst:registration_edit']);

    // Create registrations for Tenant A
    const regA1 = await createGstRegistration(tenantA.ctx, {
      gstin: '24AAAAA0000A1Z8',
      legalName: 'Tenant A Primary Corp',
      stateCode: '24',
      isPrimary: true,
    });
    regA1Id = regA1.id;

    const regA2 = await createGstRegistration(tenantA.ctx, {
      gstin: '27AAAAA0000A1Z5',
      legalName: 'Tenant A Secondary Corp',
      stateCode: '27',
      isPrimary: false,
    });
    regA2Id = regA2.id;

    // Create registration for Tenant B
    const regB1 = await createGstRegistration(tenantB.ctx, {
      gstin: '29AAAAA0000A1Z1',
      legalName: 'Tenant B Corp',
      stateCode: '29',
      isPrimary: true,
    });
    regB1Id = regB1.id;
  });

  afterAll(async () => {
    // Clear FKs and delete RLS-enforced rows via tenantQuery
    await prisma.branch.updateMany({ where: { companyId: tenantA.company.id }, data: { gstRegistrationId: null } });
    await prisma.branch.updateMany({ where: { companyId: tenantB.company.id }, data: { gstRegistrationId: null } });

    for (const companyId of [tenantA.company.id, tenantB.company.id]) {
      await tenantQuery(companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { companyId } }));
      await tenantQuery(companyId, (tx) => tx.companyGstAato.deleteMany({ where: { companyId } }));
      await tenantQuery(companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId } }));
    }

    await cleanupTestTenant(tenantA);
    await cleanupTestTenant(tenantB);
  });

  describe('create and retrieve AATO', () => {
    it('creates an AATO record with UNVERIFIED status by default for MANUAL source', async () => {
      const created = await saveAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2024-25',
        turnover: 12500000, // 1.25 Cr
        source: 'MANUAL',
        notes: 'Initial manual entry',
      });

      expect(created.id).toBeDefined();
      expect(created.companyId).toBe(tenantA.company.id);
      expect(created.gstRegistrationId).toBe(regA1Id);
      expect(created.financialYear).toBe('2024-25');
      expect(created.turnover).toBe(12500000);
      expect(created.source).toBe('MANUAL');
      expect(created.verificationStatus).toBe('UNVERIFIED');
      expect(created.verifiedDate).toBeNull();
      expect(created.notes).toBe('Initial manual entry');

      // Fetch via getAato
      const fetched = await getAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2024-25',
      });

      expect(fetched.aato).not.toBeNull();
      expect(fetched.aato?.id).toBe(created.id);
      expect(fetched.aato?.turnover).toBe(12500000);
      expect(fetched.financialYear).toBe('2024-25');
      expect(fetched.precedingFinancialYear).toBe('2023-24');
    });

    it('returns null aato if no record exists for the given financial year', async () => {
      const res = await getAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2020-21',
      });

      expect(res.aato).toBeNull();
      expect(res.financialYear).toBe('2020-21');
      expect(res.precedingFinancialYear).toBe('2019-20');
    });
  });

  describe('update and duplicate prevention', () => {
    it('updates in place without creating a duplicate for the same company + registration + FY', async () => {
      // First save
      const initial = await saveAato(tenantA.ctx, {
        gstRegistrationId: regA2Id,
        financialYear: '2024-25',
        turnover: 5000000,
        source: 'MANUAL',
      });

      // Second save with new turnover and verified status
      const updated = await saveAato(tenantA.ctx, {
        gstRegistrationId: regA2Id,
        financialYear: '2024-25',
        turnover: 7500000,
        source: 'GST_PORTAL',
        verificationStatus: 'VERIFIED',
        notes: 'Verified from portal summary',
      });

      expect(updated.id).toBe(initial.id); // Same ID - updated in place!
      expect(updated.turnover).toBe(7500000);
      expect(updated.source).toBe('GST_PORTAL');
      expect(updated.verificationStatus).toBe('VERIFIED');
      expect(updated.verifiedDate).not.toBeNull();
      expect(updated.notes).toBe('Verified from portal summary');

      // Verify DB count is exactly 1 (using tenantQuery to respect RLS)
      const count = await tenantQuery(tenantA.company.id, (tx) =>
        tx.companyGstAato.count({
          where: {
            companyId: tenantA.company.id,
            gstRegistrationId: regA2Id,
            financialYear: '2024-25',
          },
        })
      );
      expect(count).toBe(1);
    });
  });

  describe('preceding FY relationship', () => {
    it('resolves preceding FY AATO from the preceding FY record when not explicitly overridden', async () => {
      // Create preceding FY (2023-24)
      await saveAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2023-24',
        turnover: 9800000,
        source: 'GST_PORTAL',
        verificationStatus: 'VERIFIED',
      });

      // Get current FY (2024-25)
      const res = await getAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2024-25',
      });

      expect(res.aato?.turnover).toBe(12500000);
      expect(res.precedingAato?.financialYear).toBe('2023-24');
      expect(res.precedingAato?.turnover).toBe(9800000);
      expect(res.precedingAato?.verificationStatus).toBe('VERIFIED');
    });

    it('supports explicit precedingTurnover on current FY record', async () => {
      await saveAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2022-23',
        turnover: 8000000,
        precedingTurnover: 6500000, // Explicit FY 2021-22 turnover
      });

      const res = await getAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2022-23',
      });

      expect(res.aato?.precedingTurnover).toBe(6500000);
      expect(res.precedingAato?.turnover).toBe(6500000);
    });
  });

  describe('verification rules', () => {
    it('manual values do NOT automatically become VERIFIED', async () => {
      const res = await saveAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2025-26',
        turnover: 15000000,
        source: 'MANUAL',
      });
      expect(res.verificationStatus).toBe('UNVERIFIED');
      expect(res.verifiedDate).toBeNull();
    });

    it('explicit VERIFIED status records verifiedDate and user', async () => {
      const res = await saveAato(tenantA.ctx, {
        gstRegistrationId: regA1Id,
        financialYear: '2025-26',
        turnover: 15000000,
        source: 'MANUAL',
        verificationStatus: 'VERIFIED',
      });
      expect(res.verificationStatus).toBe('VERIFIED');
      expect(res.verifiedDate).not.toBeNull();
      expect(res.verifiedBy).toBe(tenantA.ctx.userId);
    });
  });

  describe('audit history', () => {
    it('tracks audit history across creations, updates, and verifications', async () => {
      const history = await getAatoHistory(tenantA.ctx, {
        gstRegistrationId: regA2Id,
        financialYear: '2024-25',
      });

      expect(history.length).toBeGreaterThanOrEqual(2);
      // Most recent should be UPDATE/VERIFY
      expect(history[0].action).toMatch(/UPDATE|VERIFY/);
      expect(history[0].turnover).toBe(7500000);
      // Older should be CREATE
      const createEntry = history.find((h) => h.action === 'CREATE');
      expect(createEntry).toBeDefined();
      expect(createEntry?.turnover).toBe(5000000);
    });
  });

  describe('tenant isolation', () => {
    it('Tenant A cannot retrieve Tenant B AATO', async () => {
      // First save an AATO for Tenant B
      await saveAato(tenantB.ctx, {
        gstRegistrationId: regB1Id,
        financialYear: '2024-25',
        turnover: 20000000,
        source: 'MANUAL',
      });

      // Tenant A trying to get Tenant B's registration AATO must be rejected with 404 (not owned)
      await expect(
        getAato(tenantA.ctx, {
          gstRegistrationId: regB1Id,
          financialYear: '2024-25',
        })
      ).rejects.toThrow(AppError);
    });

    it('Tenant A cannot save/update Tenant B AATO', async () => {
      await expect(
        saveAato(tenantA.ctx, {
          gstRegistrationId: regB1Id,
          financialYear: '2024-25',
          turnover: 99999999,
          source: 'MANUAL',
        })
      ).rejects.toThrow(AppError);

      // Verify Tenant B's record remains intact
      const resB = await getAato(tenantB.ctx, {
        gstRegistrationId: regB1Id,
        financialYear: '2024-25',
      });
      expect(resB.aato?.turnover).toBe(20000000);
    });

    it('Tenant A cannot view Tenant B AATO history', async () => {
      await expect(
        getAatoHistory(tenantA.ctx, {
          gstRegistrationId: regB1Id,
        })
      ).rejects.toThrow(AppError);
    });
  });

  describe('validation errors', () => {
    it('rejects invalid financial year format', async () => {
      await expect(
        saveAato(tenantA.ctx, {
          gstRegistrationId: regA1Id,
          financialYear: '2024-26', // invalid sequence
          turnover: 10000,
        })
      ).rejects.toThrow(/Invalid financial year/);
    });

    it('rejects negative turnover', async () => {
      await expect(
        saveAato(tenantA.ctx, {
          gstRegistrationId: regA1Id,
          financialYear: '2024-25',
          turnover: -500,
        })
      ).rejects.toThrow(/non-negative/);
    });

    it('rejects invalid source', async () => {
      await expect(
        saveAato(tenantA.ctx, {
          gstRegistrationId: regA1Id,
          financialYear: '2024-25',
          turnover: 5000,
          source: 'INVALID_SOURCE' as any,
        })
      ).rejects.toThrow(/Invalid source/);
    });
  });
});
