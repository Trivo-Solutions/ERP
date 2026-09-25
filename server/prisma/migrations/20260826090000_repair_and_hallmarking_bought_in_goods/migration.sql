-- G1: extend RepairJob for the post-pivot "customer brings a piece in to fix" flow — a real
-- Client link and a JewelryTag link (both optional, alongside the untouched free-text
-- clientName/originalJobCardId from the older manufacturing QC-failure/rework flow),
-- receivedDate/deliveredDate for explicit "in/out" tracking, and invoiceId (set once billed) so
-- a repair can't be charged twice.
ALTER TABLE "repair_jobs" ADD COLUMN "clientId" TEXT;
ALTER TABLE "repair_jobs" ADD COLUMN "tagId" TEXT;
ALTER TABLE "repair_jobs" ADD COLUMN "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "repair_jobs" ADD COLUMN "deliveredDate" TIMESTAMP(3);
ALTER TABLE "repair_jobs" ADD COLUMN "invoiceId" TEXT;

CREATE UNIQUE INDEX "repair_jobs_invoiceId_key" ON "repair_jobs"("invoiceId");

ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- G2: a HallmarkingItem used to require a JobCard, so a purchased finished-goods piece (no
-- JobCard — CLAUDE.md §3) could never be sent for hallmarking. jobCardId becomes optional;
-- tagId is the bought-in alternative. createHallmarkingBatch enforces "at least one of the two"
-- at the app layer, same as every other optional-FK pair in this schema.
ALTER TABLE "hallmarking_items" ALTER COLUMN "jobCardId" DROP NOT NULL;
ALTER TABLE "hallmarking_items" ADD COLUMN "tagId" TEXT;

ALTER TABLE "hallmarking_items" ADD CONSTRAINT "hallmarking_items_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;
