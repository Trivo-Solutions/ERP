// G2g-7d — RCM ITC eligibility (brief §17). Pure, synchronous, no Prisma.
//
// Deliberately separate from classification (gstr3bRcmClassification.ts): an RCM_APPLICABLE
// liability's ITC eligibility is gated on whether the self-assessed tax was actually PAID, never
// on classification or liability-creation alone. Rule 86(2) of the CGST Rules requires RCM tax to
// be paid from the electronic cash ledger (never the credit ledger) before the corresponding ITC
// can be claimed — so "the liability was recognized" and "the ITC is usable" are legally distinct
// moments, and this engine never collapses them into one (brief §16: "the implementation must not
// claim that merely creating an RCM liability makes ITC available").
//
// "ELIGIBLE" here means only "paid, under the rules this phase can currently check" — same
// foundation-phase caveat as G2g-7c's classifyInwardTaxLine: Section 17(5) blocked-credit
// categories are not modeled for RCM in this phase (see gstr3bRcmAggregation.ts's
// RCM_SECTION_17_5_NOT_DETERMINABLE diagnostic), so INELIGIBLE is never actually reachable today —
// it exists in the type for future extensibility, not as a currently-exercised branch.

import type { Gstr3bRcmItcClassification, Gstr3bRcmLiabilityStatus } from './gstr3bRcm.types';

export function classifyRcmItc(liabilityStatus: Gstr3bRcmLiabilityStatus): Gstr3bRcmItcClassification {
  if (liabilityStatus === 'TAX_PAID') {
    return { status: 'ELIGIBLE', diagnosticCode: null, reason: null };
  }
  return {
    status: 'UNRESOLVED',
    diagnosticCode: 'RCM_PAYMENT_NOT_RECORDED',
    reason: 'RCM tax must be paid from the electronic cash ledger (Rule 86(2)) before the corresponding ITC can be claimed — this liability has not yet been marked paid.',
  };
}
