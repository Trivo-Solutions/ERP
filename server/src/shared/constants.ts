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

// InvoicePayment.mode values that are NOT money received — they settle an invoice out of a credit the
// customer already holds (Client.currentBalance below zero). The credit was booked when it arose (a sales
// return, or an old-gold exchange), so these rows move no cash, post no journal and leave the client's
// balance alone; they only mark the invoice as paid. Anything that sums InvoicePayment as receipts
// (client ledger, day book) must skip them, or the same credit is counted twice.
export const PAYMENT_MODE_OLD_GOLD = 'OLD_GOLD';       // customer's old metal, valued and melted in on this very bill
export const PAYMENT_MODE_STORE_CREDIT = 'STORE_CREDIT'; // credit already on the customer's account (return / earlier exchange)
export const CREDIT_SETTLEMENT_MODES: string[] = [PAYMENT_MODE_OLD_GOLD, PAYMENT_MODE_STORE_CREDIT];
