// G2g-7d: a reusable statutory RCM (reverse-charge) category for a procurement line's supply —
// shared/taxCategory.ts's sibling, same framework-agnostic shape (no Prisma import). Lives on
// PoItem.rcmCategory, decided explicitly at PO entry, never inferred from the supplier's
// registration status or a blank gstNumber (CGST Act §9(4)'s blanket unregistered-supplier RCM has
// been suspended since Feb 2019 — see PHASE_G2G7D_AUDIT.md §B.2). RCM turns on the specific
// notified supply, not on who the supplier is (brief §5/§9) — this column is deliberately
// line-level, there is no Supplier.isRcm anywhere in this codebase.
//
// NONE is the overwhelming default for every line (TRIVO buys jewellery stock, which is not itself
// an RCM-notified supply). The other values are the realistic §9(3) categories for a trading
// business — all services this codebase has no line-item representation for today (see
// PHASE_G2G7D_AUDIT.md §A.1) — plus UNRESOLVED for "this may be RCM but the category is not yet
// known" (brief §3: "classify it as RCM_CLASSIFICATION_UNRESOLVED" rather than guess).
export const RCM_CATEGORIES = [
  'NONE',
  'GTA_FREIGHT',
  'LEGAL_SERVICES',
  'SECURITY_SERVICES',
  'DIRECTOR_SERVICES',
  'SPONSORSHIP',
  'RENT_A_CAB',
  'OTHER_NOTIFIED',
  'UNRESOLVED',
] as const;

export type RcmCategory = (typeof RCM_CATEGORIES)[number];

// The status quo for every PoItem line before this column existed, and the overwhelming common
// case for a jewellery procurement line going forward — used only as the default for a NEWLY
// created line that doesn't specify one. Never written onto an existing historical row.
export const DEFAULT_RCM_CATEGORY: RcmCategory = 'NONE';

export function isValidRcmCategory(value: string): value is RcmCategory {
  return (RCM_CATEGORIES as readonly string[]).includes(value);
}
