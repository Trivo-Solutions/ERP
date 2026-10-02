import { Prisma } from '@prisma/client';
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

// G2g-7a: resolves which of the company's OWN GST registrations an inward supply is attributed
// to — the receiving GRN's own branch link, else the company's primary active registration, else
// null (no registration configured at all, or no branch to resolve from). Mirrors
// resolveSellerRegistration (sales.service.ts) on the buy side, but — unlike that function —
// returns a plain nullable id with no legacy Company-row fallback: buyerRegistrationId is a new,
// purely additive attribution column (CLAUDE.md §13: never fabricate historical attribution), so
// there is no existing "always non-null" behavior for a fallback to preserve. The caller stamps
// the result onto GrnItem at the exact moment it books that line's taxableValue/inputCgst/Sgst/
// Igst (createTagFromGrnItem for a FINISHED_GOODS line, openPurchaseLot for a FINISHED_LOT line)
// — never re-resolved later, same immutable-snapshot rule as the sell side.
//
// Deliberately takes the GRN's RECEIVING branch, never a tag's own (possibly different,
// overridable) branch — the inward supply was legally received wherever the GRN says it was,
// regardless of which branch a piece is later tagged/held at.
export async function resolveBuyerRegistration(
  tx: Prisma.TransactionClient, companyId: string, receivingBranchId: string | null,
): Promise<string | null> {
  if (!receivingBranchId) return null;
  const branch = await tx.branch.findFirst({ where: { id: receivingBranchId, companyId }, select: { gstRegistrationId: true } });
  const reg = branch?.gstRegistrationId
    ? await tx.companyGstRegistration.findFirst({ where: { id: branch.gstRegistrationId, companyId, isActive: true } })
    : await tx.companyGstRegistration.findFirst({ where: { companyId, isPrimary: true, isActive: true } });
  return reg?.id ?? null;
}
