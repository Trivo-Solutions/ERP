// G2g-7a: a reusable statutory tax-category concept for a procurement line's supply —
// deliberately distinct from its GST *rate* (PoItem.hsnCodeId/taxRate). A 0% rate and an
// EXEMPT/NIL_RATED/NON_GST/ZERO_RATED supply are not the same fact under GST law (Schedule III /
// Section 11 notifications vs. a genuinely taxable 0%-rated HSN vs. a good outside GST's scope
// entirely), and this codebase must never infer one from the other — see isValidTaxCategory's
// callers, none of which derive a category from taxRate === 0.
//
// Framework-agnostic on purpose (no Prisma import) — same shape as shared/karatMaster.ts's
// isValidKarat(), minus the per-company DB lookup: these five values are fixed by GST law, not
// configurable per company, so there is no master table to check against.
export const TAX_CATEGORIES = ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

// The overwhelming common case for a jewellery procurement line, and the status quo this
// codebase already assumed everywhere before this column existed — used only as the default for
// a NEWLY created PoItem line that doesn't specify one. Never written onto an existing historical
// row (see the G2g-7a migration: existing PoItem rows are left with taxCategory = NULL).
export const DEFAULT_TAX_CATEGORY: TaxCategory = 'TAXABLE';

export function isValidTaxCategory(value: string): value is TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(value);
}
