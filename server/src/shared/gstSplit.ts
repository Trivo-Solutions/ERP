// Pure GST same-state/inter-state split, extracted from the three identical inline copies that
// existed at sales.service.ts (createInvoice, amendInvoice, convertMemoToInvoice) — see
// PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §6. No Prisma, no tenant context, no rounding beyond
// what the original inline code did (none — callers already pass an already-resolved taxAmount and
// round wherever they did before).
export function splitGst(taxAmount: number, isSameState: boolean): { cgst: number; sgst: number; igst: number } {
  return isSameState
    ? { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0 }
    : { cgst: 0, sgst: 0, igst: taxAmount };
}
