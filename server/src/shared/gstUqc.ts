// G2g-3a — GST UQC (Unit Quantity Code) master. GSTR-1 Table 12 (HSN summary) and the e-invoice
// schema require every reported line to carry a UQC from the GST portal's own fixed code list —
// free text is not acceptable. This is the same "free-text convention, validated server-side
// against a fixed whitelist constant" pattern already used for CREDIT_NOTE_REASONS/
// DEBIT_NOTE_REASONS (see gstDocumentReasons.ts) and karat/makeType elsewhere in this codebase —
// a plain string constant, not a Prisma enum, so a future addition needs no migration.
//
// Source: the official GST UQC master as published for GSTR-1/e-invoice filing (the same list
// reproduced across the GST portal's offline utilities, the e-invoice API's MasterCodes, and CBIC
// guidance) — unchanged since GST's 2017 introduction.
//
// COMPLIANCE CONFIRMATION REQUIRED (same posture as gstDocumentReasons.ts's own caveat): this list
// was reproduced from general GST reference knowledge, not fetched from a live GSTN source at
// implementation time. Verify it against the current GST portal / e-invoice schema's UQC master
// before this foundation is relied on for actual GSTR-1 filing.
//
// This is reference data, not tenant data — no companyId, no CRUD screen. A company's transaction
// picks one of these codes; it never defines its own.
export const GST_UQC_CODES = [
  'BAG', // BAGS
  'BAL', // BALE
  'BDL', // BUNDLES
  'BKL', // BUCKLES
  'BOU', // BILLION OF UNITS
  'BOX', // BOX
  'BTL', // BOTTLES
  'BUN', // BUNCHES
  'CAN', // CANS
  'CBM', // CUBIC METERS
  'CCM', // CUBIC CENTIMETERS
  'CMS', // CENTIMETERS
  'CTN', // CARTONS
  'DOZ', // DOZENS
  'DRM', // DRUMS
  'GGK', // GREAT GROSS
  'GMS', // GRAMMES — the primary unit for jewellery sold/valued by weight
  'GRS', // GROSS
  'GYD', // GROSS YARDS
  'KGS', // KILOGRAMS
  'KLR', // KILOLITRE
  'KME', // KILOMETRE
  'LTR', // LITRES
  'MLT', // MILILITRE
  'MTR', // METERS
  'MTS', // METRIC TON
  'NOS', // NUMBERS
  'PAC', // PACKS
  'PCS', // PIECES — the primary unit for jewellery sold/valued per piece
  'PRS', // PAIRS — e.g. a pair of earrings
  'QTL', // QUINTAL
  'ROL', // ROLLS
  'SET', // SETS — e.g. a necklace-and-earring set
  'SQF', // SQUARE FEET
  'SQM', // SQUARE METERS
  'SQY', // SQUARE YARDS
  'TBS', // TABLETS
  'TGM', // TEN GROSS
  'THD', // THOUSANDS
  'TON', // TONNES
  'TUB', // TUBES
  'UGS', // US GALLONS
  'UNT', // UNITS
  'YDS', // YARDS
  'OTH', // OTHERS — the GST portal's own catch-all when nothing else fits
] as const;

export type GstUqc = (typeof GST_UQC_CODES)[number];

const GST_UQC_SET: ReadonlySet<string> = new Set(GST_UQC_CODES);

/** Strict membership check — exact case, exact code. Use when the value is already meant to be canonical (e.g. read back from the database). */
export function isValidGstUqc(code: unknown): code is GstUqc {
  return typeof code === 'string' && GST_UQC_SET.has(code);
}

/**
 * Tolerant lookup for a value a user/caller typed or sent — trims and uppercases before matching
 * (GST UQC codes are conventionally upper-case; a biller typing "gms" should not be rejected for
 * casing alone). Returns the canonical code, or null if it doesn't match any known UQC — callers
 * decide whether null is an error or an acceptable "not set."
 */
export function normalizeGstUqc(input: unknown): GstUqc | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toUpperCase();
  return isValidGstUqc(normalized) ? normalized : null;
}
