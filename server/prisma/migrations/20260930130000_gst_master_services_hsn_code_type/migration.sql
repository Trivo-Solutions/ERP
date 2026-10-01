-- GST Phase C (GST Master Services): HsnCode.codeType.
--
-- Reuses the existing HsnCode table instead of creating a new SAC table, per this phase's "do not
-- create unnecessary GST tables" instruction. Purely additive: a NOT NULL column with a default of
-- 'HSN' means every existing row (this app has only ever seeded HSN 7113, articles of jewellery of
-- precious metal) keeps reading exactly as it did before this migration — nothing is renamed,
-- dropped, or repurposed, and no consumer of HsnCode (createInvoice, createTagFromGrnItem,
-- creditNote.service.ts, debitNote.service.ts, procurement.service.ts, getTaxContext, ...) needs
-- any change, since none of them filter or care about codeType.
--
-- No SAC row is seeded here or anywhere else in this migration: there is no authoritative SAC/rate
-- source in this application today (a jewellery ERP that sells goods, not services), so fabricating
-- one would violate this phase's "do not invent GST rates / do not create a fake rate database"
-- instruction. shared/hsnSac.ts's searchSAC()/getSAC() are written to simply return no rows until a
-- real SAC master is added — which, like every HsnCode row, can only happen via a migration: this
-- table is read-only to the API (db-secure.sql grants trivo_runtime SELECT only on hsn_codes).

-- AlterTable
ALTER TABLE "hsn_codes" ADD COLUMN     "codeType" TEXT NOT NULL DEFAULT 'HSN';

-- CreateIndex
CREATE INDEX "hsn_codes_codeType_idx" ON "hsn_codes"("codeType");
