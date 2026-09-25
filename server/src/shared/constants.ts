// PoItem.materialType convention marking a purchase line as a finished piece
// (bought ready-to-sell) rather than raw material bound for manufacturing.
export const FINISHED_GOODS_MATERIAL_TYPE = 'FINISHED_GOODS';

// PoItem.materialType for a bag of finished pieces billed as ONE invoice line (a category's worth,
// with a piece count and gross/net weight), tagged piece by piece afterwards. Receiving it on a GRN
// opens a PurchaseLot; see shared/purchaseLot.ts.
export const FINISHED_LOT_MATERIAL_TYPE = 'FINISHED_LOT';

// Fallback HSN for an invoice line that doesn't specify one — 7113, articles of jewellery of
// precious metal, 3% GST. Seeded directly by migration 20260823184530_add_hsn_gst_rate (not just
// prisma/seed.ts), so it exists in every database that has run migrations.
export const DEFAULT_HSN_CODE = '7113';
