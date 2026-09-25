-- Cost rates on a bag's category rows.
--
-- Entered once on the PO (metal cost per gram, making charge per gram, value-addition %), pre-filled on every tag cut
-- from that category and editable per tag, instead of being typed again on each tag. All optional; existing rows
-- are unchanged.

ALTER TABLE "po_item_categories"
  ADD COLUMN "costRate" DECIMAL(12,4),
  ADD COLUMN "mcRate" DECIMAL(12,4),
  ADD COLUMN "vaPercent" DECIMAL(5,2);
