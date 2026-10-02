// G2g-7c — Basic ITC eligibility classification (brief §11). Pure, synchronous, no Prisma.
//
// SCOPE OF WHAT "ELIGIBLE" MEANS HERE: this is a FOUNDATION-PHASE classification, not a complete
// statutory determination. "ELIGIBLE" means: every condition this phase's data model can actually
// check has passed. It does NOT mean a final, audit-proof statement that Section 16(4)/17(5), the
// place-of-supply restriction, and the 180-day payment condition are all satisfied — this phase's
// data model cannot determine any of those four (see gstr3bItcReportDiagnostics.ts for why), so
// they are reported once, at the report level, as capability gaps — never as a per-line gate that
// would make every single line UNRESOLVED and the ELIGIBLE bucket permanently empty. That would
// defeat the report's purpose (brief §1: "what can CURRENTLY be considered eligible ITC") just as
// much as the opposite failure mode (silently treating book GST as automatically eligible) would.
//
// The five foundational conditions actually checked, in priority order (first match wins):
//   1. Buyer GST registration — must match the report's registration, or be unassigned (UNRESOLVED).
//      A line explicitly attributed to a DIFFERENT registration isn't unresolved, it's simply out
//      of scope for this report (the caller filters it out before classification even runs).
//   2. Supplier is NOT a Composition Scheme dealer (Section 10) — a composition supplier's bill
//      never carries GST a buyer can claim as ITC; this is the one explicit, reliable statutory
//      exclusion this phase's data model can establish on its own (brief §11's INELIGIBLE bar).
//   3. Supplier GSTIN is present and structurally valid (full checksum via shared/gstin.ts, not
//      just a 15-character regex) — an absent or malformed GSTIN means the supplier's registered
//      status cannot be relied on, so nothing is assumed either way.
//   4. Tax category (PoItem.taxCategory, read via the relation — GrnItem itself has no snapshot of
//      its own, a documented limitation, see PHASE_G2G7C_IMPLEMENTATION.md §C) is TAXABLE. EXEMPT /
//      NIL_RATED / NON_GST / ZERO_RATED means no GST was legally chargeable on the supply at all,
//      so whatever is booked cannot be eligible ITC. Unknown (null, a pre-G2g-7a row) is UNRESOLVED
//      — never guessed from a zero tax rate (brief §10/§15: a 0% rate and a genuinely non-taxable
//      supply are different facts).
//   5. Not RCM / not import / not ISD — trivially true for every line this phase's loaders can even
//      produce: the loaders only ever read GoodsReceiptNote/GrnItem/PurchaseReturn/DebitNote rows,
//      which this codebase has no RCM/import/ISD representation for at all (G2g-7a deliberately
//      deferred that data model to G2g-7d). This is not an inference — it is a true statement about
//      what IS and ISN'T in the data this engine is ever handed.
//
// A line with zero total input tax (nothing booked) still gets classified (so the diagnostics stay
// informative), but contributes zero to every bucket — the aggregator does the actual rounding/
// netting, this module only ever decides WHICH bucket a line's amount goes into.

import { validateGstin } from '../../../shared/gstin';
import type { Gstr3bItcClassification, Gstr3bItcLineFacts } from './gstr3bItc.types';

export function classifyInwardTaxLine(
  facts: Gstr3bItcLineFacts,
  requestedGstRegistrationId: string,
): Gstr3bItcClassification {
  const buyerReg = facts.buyerRegistrationId?.trim() || null;

  // 1. Registration scope.
  if (buyerReg && buyerReg !== requestedGstRegistrationId) {
    return { scope: 'EXCLUDED_OTHER_REGISTRATION', status: 'UNRESOLVED', diagnosticCode: null, reason: null };
  }
  if (!buyerReg) {
    return {
      scope: 'IN_SCOPE',
      status: 'UNRESOLVED',
      diagnosticCode: 'BUYER_REGISTRATION_UNASSIGNED',
      reason: 'This inward tax line has no buyerRegistrationId — it cannot be safely attributed to any GST registration, so it is reported as unresolved rather than silently assigned to the primary registration.',
    };
  }

  // 2. Composition-scheme supplier — a reliable, established exclusion (Section 10).
  if (facts.supplierIsComposition) {
    return {
      scope: 'IN_SCOPE',
      status: 'INELIGIBLE',
      diagnosticCode: 'SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE',
      reason: 'The supplier is registered under the GST Composition Scheme (Section 10) — a composition dealer cannot charge GST that a buyer may claim as input tax credit.',
    };
  }

  // 3. Supplier GSTIN presence + structural validity (full checksum, not just length/regex).
  const gstinCheck = validateGstin(facts.supplierGstin ?? '');
  if (!gstinCheck.valid) {
    return {
      scope: 'IN_SCOPE',
      status: 'UNRESOLVED',
      diagnosticCode: 'SUPPLIER_GSTIN_UNAVAILABLE',
      reason: facts.supplierGstin?.trim()
        ? `Supplier GSTIN "${facts.supplierGstin}" failed structural validation (${gstinCheck.errors.join('; ')}) — the supplier's registered status cannot be relied on.`
        : 'The supplier has no GSTIN on file — their registered status cannot be relied on for an ITC-eligibility decision.',
    };
  }

  // 4. Tax category.
  if (facts.taxCategory == null) {
    return {
      scope: 'IN_SCOPE',
      status: 'UNRESOLVED',
      diagnosticCode: 'TAX_CATEGORY_UNAVAILABLE',
      reason: 'This line\'s purchase order has no taxCategory classification recorded (a pre-G2g-7a line, or the final GRN tax event carries no snapshot of its own — see the documented limitation in PHASE_G2G7C_IMPLEMENTATION.md).',
    };
  }
  if (facts.taxCategory !== 'TAXABLE') {
    return {
      scope: 'IN_SCOPE',
      status: 'INELIGIBLE',
      diagnosticCode: 'TAX_CATEGORY_NON_TAXABLE',
      reason: `This line's purchase order classifies the supply as ${facts.taxCategory} — no GST was legally chargeable on it, so no ITC can arise from it regardless of any amount booked.`,
    };
  }

  // 5. Not RCM / not import / not ISD is true by construction — see this module's header.
  return { scope: 'IN_SCOPE', status: 'ELIGIBLE', diagnosticCode: null, reason: null };
}
