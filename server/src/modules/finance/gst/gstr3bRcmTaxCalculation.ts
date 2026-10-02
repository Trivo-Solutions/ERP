// G2g-7d — Inward RCM tax calculator (brief §10). Pure, synchronous, no Prisma.
//
// Deliberately thin: it reuses shared/inputGst.ts's splitInputGst() verbatim for the CGST/SGST-vs-
// IGST split — the exact same logic the ordinary purchase-side GST booking already uses — rather
// than duplicating that split. The only thing this module adds on top is the RCM-specific
// posUnresolved flag: when neither state code could be resolved, splitInputGst still has to fall
// back to something (IGST, "the same fallback the sell side uses"), and for an RCM liability this
// phase refuses to let that fallback pass silently as a confident place-of-supply determination —
// see gstr3bRcmAggregation.ts's RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE diagnostic, which this flag
// feeds at the report level.

import { splitInputGst, round2 } from '../../../shared/inputGst';
import type { Gstr3bRcmTaxCalculation, Gstr3bRcmTaxCalculationInput } from './gstr3bRcm.types';

export function calculateRcmTax(input: Gstr3bRcmTaxCalculationInput): Gstr3bRcmTaxCalculation {
  const gst = splitInputGst(input.taxableValue, input.taxRate, input.supplierStateCode, input.companyStateCode);
  const cess = round2(input.cess ?? 0);
  return {
    taxableValue: round2(input.taxableValue),
    cgst: gst.cgst,
    sgst: gst.sgst,
    igst: gst.igst,
    cess,
    totalTax: round2(gst.total + cess),
    posUnresolved: !input.supplierStateCode || !input.companyStateCode,
  };
}
