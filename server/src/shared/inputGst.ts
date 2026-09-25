import { resolveStateCode } from './stateMaster';

// Purchase-side (input) GST helpers, shared by PO creation, finished-goods intake and purchase returns.

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// A GSTIN's first two digits ARE the registrant's state code, so for a registered supplier that is
// the most reliable place-of-supply signal — better than the free-text `state` on the supplier row.
// Falls back to resolving that free text; null when neither yields a confident answer.
export async function resolveSupplierStateCode(
  supplier: { gstNumber?: string | null; state?: string | null },
): Promise<string | null> {
  const fromGstin = supplier.gstNumber?.trim().match(/^(0[1-9]|[12]\d|3[0-8])[0-9A-Z]{13}$/i)?.[1];
  if (fromGstin) return fromGstin;
  return resolveStateCode(supplier.state);
}

// Intra-state purchase (supplier state == company state) => CGST + SGST halves; anything else,
// including an unresolvable supplier state, => IGST — the same fallback the sell side uses
// (sales.service.ts), so the two ledgers stay symmetrical when a state cannot be pinned down.
export function splitInputGst(taxable: number, rate: number, supplierStateCode: string | null, companyStateCode: string | null) {
  const total = round2(taxable * rate);
  if (total <= 0) return { cgst: 0, sgst: 0, igst: 0, total: 0 };
  const intra = !!supplierStateCode && !!companyStateCode && supplierStateCode === companyStateCode;
  if (!intra) return { cgst: 0, sgst: 0, igst: total, total };
  const cgst = round2(total / 2);
  return { cgst, sgst: round2(total - cgst), igst: 0, total };
}
