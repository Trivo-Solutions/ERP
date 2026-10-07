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
// Customer Advance (money received before the bill, held in ledger 2400) applied to an invoice. Unlike the two
// modes above it is NOT a CREDIT_SETTLEMENT_MODE: it moves the receivable (Dr 2400 / Cr AR) like a receipt.
export const PAYMENT_MODE_CUSTOMER_ADVANCE = 'CUSTOMER_ADVANCE';
export const CREDIT_SETTLEMENT_MODES: string[] = [PAYMENT_MODE_OLD_GOLD, PAYMENT_MODE_STORE_CREDIT];

// ─── Returned-jewellery pipeline (sale return → HO inspection → repair → stock / melt / retag) ───
// While a returned piece is in this pipeline its JewelryTag.status is one of the values below — none of them is
// IN_STOCK, so nothing that sells, memos, transfers or counts stock ("status = IN_STOCK") can touch it. Only an
// authorised inspection PASS (or a passed final inspection) returns the SAME tag to IN_STOCK.
export const TAG_STATUS_RETURNED_PENDING_INSPECTION = 'RETURNED_PENDING_INSPECTION'; // sold piece came back; still at its branch
export const TAG_STATUS_IN_TRANSIT_TO_HO = 'IN_TRANSIT_TO_HO';                       // on a RepairTransfer, not yet received
export const TAG_STATUS_HO_RECEIVED = 'HO_RECEIVED';                                 // at Head Office, awaiting inspection
export const TAG_STATUS_REPAIR_REQUIRED = 'REPAIR_REQUIRED';                         // inspected: needs correction
export const TAG_STATUS_IN_REPAIR = 'IN_REPAIR';
export const TAG_STATUS_REPAIR_COMPLETED = 'REPAIR_COMPLETED';                       // awaiting final inspection
export const TAG_STATUS_MELT_PENDING = 'MELT_PENDING';                               // not resaleable; waits for a separate old-gold/melt transaction
export const TAG_STATUS_RETAGGED = 'RETAGGED';                                       // replaced by a new tag (see TagRetag); terminal
export const NON_SALEABLE_RETURN_TAG_STATUSES: string[] = [
  TAG_STATUS_RETURNED_PENDING_INSPECTION, TAG_STATUS_IN_TRANSIT_TO_HO, TAG_STATUS_HO_RECEIVED, TAG_STATUS_REPAIR_REQUIRED,
  TAG_STATUS_IN_REPAIR, TAG_STATUS_REPAIR_COMPLETED, TAG_STATUS_MELT_PENDING, TAG_STATUS_RETAGGED,
];

// RepairCase.status (the Repair Register). It follows the tag's status through the pipeline, plus INSPECTION_PASSED
// as the terminal "back in stock" state (the tag itself is IN_STOCK again by then).
export const REPAIR_STATUS = {
  RETURNED_PENDING_TRANSFER: 'RETURNED_PENDING_TRANSFER',
  IN_TRANSIT_TO_HO: 'IN_TRANSIT_TO_HO',
  HO_RECEIVED: 'HO_RECEIVED',
  REPAIR_REQUIRED: 'REPAIR_REQUIRED',
  IN_REPAIR: 'IN_REPAIR',
  REPAIR_COMPLETED: 'REPAIR_COMPLETED',
  INSPECTION_PASSED: 'INSPECTION_PASSED',
  MELT_PENDING: 'MELT_PENDING',
  RETAGGED: 'RETAGGED',
} as const;
export const REPAIR_STATUS_VALUES: string[] = Object.values(REPAIR_STATUS);
export const REPAIR_LOCATION = { BRANCH: 'BRANCH', IN_TRANSIT: 'IN_TRANSIT', HEAD_OFFICE: 'HEAD_OFFICE' } as const;
export const REPAIR_TRANSFER_STATUS_VALUES = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'];
