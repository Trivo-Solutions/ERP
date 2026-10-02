// G2g-7d — Inward RCM classification engine (brief §8). Pure, synchronous, no Prisma.
//
// SCOPE: this is a FOUNDATION-PHASE classification, same discipline as G2g-7c's
// classifyInwardTaxLine. "RCM_APPLICABLE" means: an explicit, notified rcmCategory was set on this
// line AND every condition this phase's data model can check (a buyer registration to be liable
// under, a consistent tax category) has passed. It is NOT a final statutory determination of place
// of supply, time of supply, or Section 17(5) blocked-credit status — those remain
// NOT_DETERMINABLE at the report level (see gstr3bRcmAggregation.ts).
//
// THIS DOES NOT GUESS RCM FROM SUPPLIER FACTS. CGST Act Section 9(4)'s blanket rule — "RCM applies
// to any purchase from an unregistered supplier" — has been suspended since February 2019 for
// everyone except real-estate promoters buying cement/capital goods (verified against official/
// authoritative sources this session; see PHASE_G2G7D_AUDIT.md §B.2). A blank supplier GSTIN is
// therefore NEVER, on its own, a reason to classify a line as RCM — it only ever affects the
// SEPARATE self-invoice-requirement decision below (Section 31(3)(f) only requires a self-invoice
// when RCM independently applies AND the supplier can't issue a valid tax document).
//
// The only trigger for RCM_APPLICABLE is an explicit, human-entered PoItem.rcmCategory
// (shared/rcmCategory.ts) naming a specific CBIC-notified category (Section 9(3)) — never inferred
// from materialType, taxRate, or registration status. The overwhelming majority of PoItem rows
// have rcmCategory NULL/NONE and classify as RCM_NOT_APPLICABLE, by construction — see
// PHASE_G2G7D_AUDIT.md §A.1/§B.1 for why that is the honest, correct state of TRIVO's real data
// today, not a bug or an incomplete rollout.
//
// Checks, in priority order (first match wins), once rcmCategory names a real category:
//   1. Registration scope — matches the report's requested registration, or is unassigned
//      (RCM_REGISTRATION_UNASSIGNED) or belongs to a different one (EXCLUDED_OTHER_REGISTRATION).
//      Mirrors classifyInwardTaxLine's identical first check.
//   2. Tax category consistency — a notified RCM category implies a real, positive tax liability;
//      an EXEMPT/NIL_RATED/NON_GST/ZERO_RATED taxCategory on the same line is an internal
//      inconsistency this phase refuses to silently resolve either way (RCM_TAX_CATEGORY_CONFLICT).

import type { Gstr3bRcmClassification, Gstr3bRcmLineFacts, Gstr3bRcmSelfInvoiceRequirement, Gstr3bRcmPaymentVoucherRequirement, Gstr3bRcmStatus } from './gstr3bRcm.types';
import { validateGstin } from '../../../shared/gstin';

export function classifyRcmSupply(
  facts: Gstr3bRcmLineFacts,
  requestedGstRegistrationId: string,
): Gstr3bRcmClassification {
  const category = facts.rcmCategory?.trim() || null;

  // No category, or explicitly NONE — the overwhelming default for a jewellery-stock line.
  if (!category || category === 'NONE') {
    return { scope: 'IN_SCOPE', status: 'RCM_NOT_APPLICABLE', diagnosticCode: null, reason: null };
  }

  // Flagged as possibly RCM but the category itself is not yet known — brief §3's own instruction
  // ("classify it as RCM_CLASSIFICATION_UNRESOLVED"), never guessed into one of the named ones.
  if (category === 'UNRESOLVED') {
    return {
      scope: 'IN_SCOPE',
      status: 'RCM_UNRESOLVED',
      diagnosticCode: 'RCM_CATEGORY_UNRESOLVED',
      reason: 'This line is flagged as possibly subject to reverse charge, but no specific notified category has been recorded — the category itself must be determined before a liability can be self-assessed.',
    };
  }

  // 1. Registration scope (mirrors classifyInwardTaxLine's identical first check).
  const buyerReg = facts.buyerRegistrationId?.trim() || null;
  if (buyerReg && buyerReg !== requestedGstRegistrationId) {
    return { scope: 'EXCLUDED_OTHER_REGISTRATION', status: 'RCM_UNRESOLVED', diagnosticCode: null, reason: null };
  }
  if (!buyerReg) {
    return {
      scope: 'IN_SCOPE',
      status: 'RCM_UNRESOLVED',
      diagnosticCode: 'RCM_REGISTRATION_UNASSIGNED',
      reason: 'This notified-category line has no buyerRegistrationId — the RCM liability cannot be safely attributed to any of the company\'s own GST registrations, so it is reported as unresolved rather than silently assigned to the primary one.',
    };
  }

  // 2. Tax category consistency — a notified category and a non-taxable classification on the
  // same line are contradictory facts; this phase reports the conflict rather than guessing which
  // one is right.
  if (facts.taxCategory && facts.taxCategory !== 'TAXABLE') {
    return {
      scope: 'IN_SCOPE',
      status: 'RCM_UNRESOLVED',
      diagnosticCode: 'RCM_TAX_CATEGORY_CONFLICT',
      reason: `This line carries notified RCM category "${category}" but its tax category is classified ${facts.taxCategory} — a notified reverse-charge category implies a real tax liability, so this combination is reported as an unresolved inconsistency rather than resolved either way.`,
    };
  }

  return { scope: 'IN_SCOPE', status: 'RCM_APPLICABLE', diagnosticCode: null, reason: null };
}

// Self-invoice (Section 31(3)(f)/Rule 46 2nd proviso/Rule 47A) is required only when RCM
// independently applies AND the supplier cannot issue a valid tax document of their own (i.e. is
// unregistered or their GSTIN fails structural validation) — never merely because RCM_APPLICABLE
// (brief §14: that would be legally overbroad). A registered supplier's own invoice, marked
// reverse-charge-applicable, already satisfies the documentation requirement.
export function determineSelfInvoiceRequirement(
  classificationStatus: Gstr3bRcmStatus,
  supplierGstin: string | null,
): Gstr3bRcmSelfInvoiceRequirement {
  if (classificationStatus === 'RCM_UNRESOLVED') return 'SELF_INVOICE_NOT_DETERMINED';
  if (classificationStatus === 'RCM_NOT_APPLICABLE') return 'SELF_INVOICE_NOT_REQUIRED';
  const gstinCheck = validateGstin(supplierGstin ?? '');
  return gstinCheck.valid ? 'SELF_INVOICE_NOT_REQUIRED' : 'SELF_INVOICE_REQUIRED';
}

// Payment voucher (Section 31(3)(g)) is tied to the RCM determination itself, not to the
// supplier's registration status — distinct from self-invoice above.
export function determinePaymentVoucherRequirement(classificationStatus: Gstr3bRcmStatus): Gstr3bRcmPaymentVoucherRequirement {
  if (classificationStatus === 'RCM_UNRESOLVED') return 'PAYMENT_VOUCHER_NOT_DETERMINED';
  if (classificationStatus === 'RCM_NOT_APPLICABLE') return 'PAYMENT_VOUCHER_NOT_REQUIRED';
  return 'PAYMENT_VOUCHER_REQUIRED';
}
