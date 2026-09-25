-- CreateTable
CREATE TABLE "hsn_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "gstRate" DECIMAL(5,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hsn_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hsn_codes_code_key" ON "hsn_codes"("code");

-- Seed the default HSN every sale used implicitly until now: 7113 (articles of jewellery, of
-- precious metal), 3% GST — the same flat rate createInvoice/convertMemoToInvoice hardcoded
-- before this migration. B1 makes that rate line-level and table-driven instead of hardcoded.
INSERT INTO "hsn_codes" ("id", "code", "description", "gstRate", "isActive")
VALUES ('hsncode_default_7113', '7113', 'Articles of jewellery and parts thereof, of precious metal', 0.0300, true);

-- AlterTable: taxRate is a snapshot copied from HsnCode.gstRate at sale time (like costPrice on
-- JewelryTag) so a later rate change never silently reprices a past invoice. Existing rows were
-- all taxed at the old flat 3% — backfilled below to the default HSN, then the temporary column
-- default is dropped so the app is required to pass taxRate explicitly on every new row.
ALTER TABLE "invoice_items" ADD COLUMN     "hsnCodeId" TEXT,
ADD COLUMN     "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.0300;

UPDATE "invoice_items" SET "hsnCodeId" = 'hsncode_default_7113' WHERE "hsnCodeId" IS NULL;

ALTER TABLE "invoice_items" ALTER COLUMN "taxRate" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
