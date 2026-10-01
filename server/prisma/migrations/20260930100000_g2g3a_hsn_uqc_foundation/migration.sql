-- G2g-3a: HSN/UQC foundation for future GSTR-1 Table 12 reporting (HSN + UQC + Quantity + Rate).
-- Purely additive — no column is renamed, dropped, or repurposed, and no historical transactional
-- row is backfilled with a fabricated value (see CLAUDE.md/PART 6 of the execution prompt: no
-- blind "all HSN 7113 -> GMS" or "all quantity -> 1" backfill). Existing rows read as NULL on
-- every new column, which is the correct, honest state for data this system never actually
-- captured a statutory quantity/UQC for.

-- AlterTable: HsnCode.defaultUqc — the UQC a line under this HSN defaults to when the transaction
-- itself doesn't specify one. Global/platform reference data (see HsnCode's own model comment) —
-- no companyId, no tenant scoping.
ALTER TABLE "hsn_codes" ADD COLUMN     "defaultUqc" TEXT;

-- Business default (NOT a statutory rule) for the one HSN row this system has always seeded:
-- 7113 (articles of jewellery, of precious metal). TRIVO jewellery is conventionally sold/valued
-- by weight, so GMS is a reasonable operational default — but it is a configurable TRIVO
-- convention, replaceable per-company via the HSN master, not a GST-mandated pairing. Scoped by
-- id to the exact row the earlier 20260823184530_add_hsn_gst_rate migration seeded; does nothing
-- if that row was since edited or removed.
UPDATE "hsn_codes" SET "defaultUqc" = 'GMS' WHERE "id" = 'hsncode_default_7113';

-- AlterTable: InvoiceItem.uqc — statutory GST UQC snapshot, added alongside the existing (always
-- null in practice) `uom` column rather than renaming it, since `uom` is read by column name by
-- the existing tax-invoice/credit-note/debit-note print-template whitelists
-- (taxInvoiceBoundFields.ts and siblings) — renaming would silently blank that column on every
-- past invoice's template rendering. See InvoiceItem.uqc's schema comment for the full rationale.
ALTER TABLE "invoice_items" ADD COLUMN     "uqc" TEXT;

-- AlterTable: CreditNoteItem.quantity/uqc — same additive rationale. quantity is DECIMAL(10,4),
-- not INTEGER, since a GMS credit can be fractional (e.g. 11.2500) while a PCS credit is whole
-- (1, 2, 5) — same precision already used by this table's grossWeight/netWeight/stoneWeight
-- columns. Both nullable: existing rows, and any future row this system cannot establish a real
-- quantity/UQC for (a value-only price adjustment with no physical quantity), stay NULL rather
-- than carry a fabricated statutory fact.
ALTER TABLE "credit_note_items" ADD COLUMN     "quantity" DECIMAL(10,4),
ADD COLUMN     "uqc" TEXT;
