-- Per-bill copy of a sold piece's material rows + MC/VA rates (edited at the counter; never written to the tag).
ALTER TABLE "invoice_items" ADD COLUMN "materialBreakdown" JSONB;
