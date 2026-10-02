// G2g-7d — Inward RCM booking (write side). The counterpart to gstr3bRcmReporting.service.ts.
//
// bookRcmLiabilityIfApplicable() is the integration point: called inline, inside the SAME
// transaction, from the two places this codebase already books ordinary input GST on an inward
// line — tagging.service.ts's createTagFromGrnItem (FINISHED_GOODS) and
// procurement.service.ts's openPurchaseLot (FINISHED_LOT) — the exact moment PHASE_G2G7D_AUDIT.md
// identified as the one existing "inward GST booking" hook in this codebase. It is a no-op
// (returns null, nothing is created) for the overwhelming majority of lines, whose
// PoItem.rcmCategory is NONE — see the RcmLiability model's own header comment.
//
// markRcmLiabilityPaid() is a separate, explicit, later action — RCM tax must be paid in cash
// (Rule 86(2)) before the corresponding ITC becomes available, and this codebase cannot represent
// an actual electronic-cash-ledger payment to the government (no such model exists anywhere) — the
// closest safe, honest representation is a company bank/cash movement the business itself records,
// exactly the same shape as any other Dr-liability/Cr-cash-or-bank settlement journal already in
// this codebase (e.g. recordSupplierPayment).

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { postAutoJournalEntry } from '../finance.service';
import { LEDGER_ACCOUNT, cashOrBankAccount } from '../../../shared/ledgerAccounts';
import { nextDocumentNumber, gstFinancialYear } from '../../../shared/numberSequence';
import { TenantContext, tenantBatch, tenantTransaction } from '../../../shared/tenantContext';
import { classifyRcmSupply, determineSelfInvoiceRequirement, determinePaymentVoucherRequirement } from './gstr3bRcmClassification';
import { calculateRcmTax } from './gstr3bRcmTaxCalculation';
import { assertGstr3bPeriodMutable, auditGstr3bMutationBlocked } from './gstr3bFilingProtection';
import type { Gstr3bRcmLineFacts } from './gstr3bRcm.types';

export interface BookRcmLiabilityParams {
  ctx: TenantContext;
  userId: string;
  grn: { grnNumber: string; receivedDate: Date };
  grnItemId: string;
  poItem: { rcmCategory: string | null; taxCategory: string | null; hsnCodeId: string | null; totalAmount: number | Prisma.Decimal };
  supplier: { id: string; gstNumber: string | null };
  supplierStateCode: string | null;
  companyStateCode: string | null;
  /** G2g-7a's resolveBuyerRegistration() result for this same GRN line — never re-resolved here. */
  buyerRegistrationId: string | null;
}

/**
 * Classifies a GRN line's RCM facts and, when the line is anything other than
 * RCM_NOT_APPLICABLE, creates an RcmLiability row (+ self-invoice if required, + the
 * liability-recognition journal if the classification is a confirmed RCM_APPLICABLE). Returns
 * null for the overwhelming common case (rcmCategory NONE/null) — no row, no journal, no change
 * to the caller's existing behavior.
 */
export async function bookRcmLiabilityIfApplicable(
  tx: Prisma.TransactionClient,
  params: BookRcmLiabilityParams,
): Promise<{ id: string } | null> {
  const facts: Gstr3bRcmLineFacts = {
    rcmCategory: params.poItem.rcmCategory,
    buyerRegistrationId: params.buyerRegistrationId,
    taxCategory: params.poItem.taxCategory,
  };

  // The "requested" registration at booking time is simply whatever was just resolved for this
  // line — there is no separate report-scope concept here, only at report time (gstr3bRcmAggregation.ts).
  const classification = classifyRcmSupply(facts, params.buyerRegistrationId ?? '');
  if (classification.status === 'RCM_NOT_APPLICABLE') return null;

  const taxableValue = Number(params.poItem.totalAmount);
  const hsn = params.poItem.hsnCodeId
    ? await tx.hsnCode.findUnique({ where: { id: params.poItem.hsnCodeId }, select: { gstRate: true } })
    : null;
  const taxRate = hsn ? Number(hsn.gstRate) : 0;
  const tax = calculateRcmTax({
    taxableValue, taxRate,
    supplierStateCode: params.supplierStateCode, companyStateCode: params.companyStateCode,
  });

  const selfInvoiceRequirement = determineSelfInvoiceRequirement(classification.status, params.supplier.gstNumber);
  const paymentVoucherRequirement = determinePaymentVoucherRequirement(classification.status);

  const liability = await tx.rcmLiability.create({
    data: {
      companyId: params.ctx.companyId,
      gstRegistrationId: params.buyerRegistrationId,
      grnItemId: params.grnItemId,
      supplierId: params.supplier.id,
      rcmCategory: facts.rcmCategory as string,
      taxableValue: tax.taxableValue, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, cess: tax.cess,
      selfInvoiceRequirement, paymentVoucherRequirement,
      createdById: params.userId,
    },
  });

  // Only a CONFIRMED (RCM_APPLICABLE) liability is posted to the books — an RCM_UNRESOLVED line
  // is a flagged fact for a person to resolve, not yet a number to post (brief §25).
  if (classification.status === 'RCM_APPLICABLE' && tax.totalTax > 0) {
    const entry = await postAutoJournalEntry(tx, params.ctx.companyId, {
      date: params.grn.receivedDate,
      description: `RCM self-assessed liability — GRN ${params.grn.grnNumber}`,
      referenceType: 'RcmLiability', referenceId: liability.id, userId: params.userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.RCM_INPUT_TAX_CREDIT, debit: tax.totalTax },
        { accountCode: LEDGER_ACCOUNT.RCM_TAX_PAYABLE, credit: tax.totalTax },
      ],
    });
    if (entry) {
      await tx.rcmLiability.update({ where: { id: liability.id }, data: { journalEntryId: entry.id } });
    }
  }

  if (selfInvoiceRequirement === 'SELF_INVOICE_REQUIRED') {
    const financialYear = gstFinancialYear(params.grn.receivedDate);
    const selfInvoiceNumber = await nextDocumentNumber(
      params.ctx.companyId, `SELFINV:${params.buyerRegistrationId ?? 'LEGACY'}`, 'SELFINV', tx, financialYear,
    );
    const supplierRow = await tx.supplier.findUnique({ where: { id: params.supplier.id }, select: { name: true, address: true } });
    await tx.selfInvoice.create({
      data: {
        companyId: params.ctx.companyId,
        selfInvoiceNumber, financialYear,
        gstRegistrationId: params.buyerRegistrationId,
        rcmLiabilityId: liability.id,
        supplierId: params.supplier.id,
        supplierName: supplierRow?.name ?? '',
        supplierAddress: supplierRow?.address ?? null,
        issueDate: params.grn.receivedDate,
        taxableValue: tax.taxableValue, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, cess: tax.cess,
        hsnCodeId: params.poItem.hsnCodeId,
        createdById: params.userId,
      },
    });
  }

  return { id: liability.id };
}

export async function listRcmLiabilities(
  ctx: TenantContext,
  filters: { status?: string; page?: number; limit?: number } = {},
) {
  const { status, page = 1, limit = 20 } = filters;
  const where: Prisma.RcmLiabilityWhereInput = { companyId: ctx.companyId, ...(status && { status }) };
  const [rows, total] = await tenantBatch(ctx.companyId, (tx) => [
    tx.rcmLiability.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        supplier: { select: { name: true } },
        grnItem: { select: { grn: { select: { grnNumber: true } } } },
        selfInvoice: { select: { selfInvoiceNumber: true } },
      },
    }),
    tx.rcmLiability.count({ where }),
  ]);
  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Records that this RCM liability's tax was actually paid (Rule 86(2): from the electronic cash
 * ledger, never the credit ledger) — the only event that can make its future ITC claim ELIGIBLE
 * (gstr3bRcmItcEligibility.ts). Posts Dr RCM Tax Payable / Cr Cash-or-Bank, closing the
 * self-assessed liability exactly like any other liability settlement in this codebase.
 */
export async function markRcmLiabilityPaid(
  ctx: TenantContext,
  rcmLiabilityId: string,
  data: { paymentDate: Date; mode: string },
  userId: string,
) {
  let result: any;
  try {
    result = await tenantTransaction(ctx.companyId, async (tx) => {
    const liability = await tx.rcmLiability.findFirst({
      where: { id: rcmLiabilityId, companyId: ctx.companyId },
      include: { grnItem: { include: { grn: { select: { receivedDate: true } } } } },
    });
    if (!liability) throw new AppError('RCM liability not found', 404);
    if (liability.status === 'TAX_PAID') throw new AppError('This RCM liability has already been marked paid', 409);
    // G2g-7g: marking an RCM liability paid is the one event (Rule 86(2)) that can change its
    // future ITC eligibility (gstr3bRcmItcEligibility.ts) — and that liability is reported, by the
    // ORIGINAL GRN receivedDate (gstr3bRcmReporting.service.ts's loader), in whatever period that
    // date falls in. If that period is already FILED/LOCKED, retroactively flipping eligibility for
    // it is exactly the kind of settlement mutation brief §3/§10 calls out.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'RCM_LIABILITY', documentId: rcmLiabilityId,
      gstRegistrationId: liability.gstRegistrationId, documentDate: liability.grnItem.grn.receivedDate, action: 'marked paid',
    });

    const totalTax = Number(liability.cgst) + Number(liability.sgst) + Number(liability.igst) + Number(liability.cess);
    let paymentJournalEntryId: string | null = null;
    if (totalTax > 0) {
      const entry = await postAutoJournalEntry(tx, ctx.companyId, {
        date: data.paymentDate,
        description: `RCM tax paid — liability ${liability.id}`,
        referenceType: 'RcmLiability', referenceId: liability.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.RCM_TAX_PAYABLE, debit: totalTax },
          { accountCode: cashOrBankAccount(data.mode), credit: totalTax },
        ],
      });
      paymentJournalEntryId = entry?.id ?? null;
    }

    // Count-checked, not a blind update — a concurrent mark-paid call must not post two payment
    // journals for the same liability (same lost-update class of bug as J3.5's hardening pass).
    const updateResult = await tx.rcmLiability.updateMany({
      where: { id: rcmLiabilityId, companyId: ctx.companyId, status: 'LIABILITY_RECOGNIZED' },
      data: { status: 'TAX_PAID', paidAt: data.paymentDate, paidById: userId, paymentMode: data.mode, paymentJournalEntryId },
    });
    if (updateResult.count !== 1) {
      throw new AppError('This RCM liability was already marked paid by a concurrent request', 409);
    }

    return tx.rcmLiability.findUniqueOrThrow({ where: { id: rcmLiabilityId } });
    });
  } catch (err) {
    await auditGstr3bMutationBlocked(err, 'rcm_liabilities', userId, ctx.companyId);
    throw err;
  }

  await createAuditEntry('rcm_liabilities', result.id, userId, 'EDIT', undefined, undefined, ctx.companyId);
  return result;
}
