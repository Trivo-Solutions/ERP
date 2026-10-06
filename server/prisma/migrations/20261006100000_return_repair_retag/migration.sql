-- Returned-jewellery pipeline: Repair Register (repair_cases), Branch->HO custody (repair_transfers/_items) and
-- controlled retagging (tag_retags). Purely additive: new tables + one composite-FK-target unique index. No UPDATE, no
-- backfill, no existing row touched.

-- CreateTable
CREATE TABLE "repair_cases" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "repairNumber" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "salesReturnItemId" TEXT,
    "originBranchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RETURNED_PENDING_TRANSFER',
    "currentLocation" TEXT NOT NULL DEFAULT 'BRANCH',
    "returnReason" TEXT,
    "description" TEXT NOT NULL,
    "karat" TEXT,
    "grossWeight" DECIMAL(10,4) NOT NULL,
    "stoneWeight" DECIMAL(10,4) NOT NULL,
    "netWeight" DECIMAL(10,4) NOT NULL,
    "hoReceivedById" TEXT,
    "hoReceivedAt" TIMESTAMP(3),
    "inspectionResult" TEXT,
    "inspectedById" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "repairReason" TEXT,
    "assignedToId" TEXT,
    "repairEmployeeId" TEXT,
    "repairStartedAt" TIMESTAMP(3),
    "repairCompletedAt" TIMESTAMP(3),
    "repairDetails" TEXT,
    "repairCost" DECIMAL(12,2),
    "finalInspectedById" TEXT,
    "finalInspectedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_transfers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "remarks" TEXT,
    "createdById" TEXT NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_transfer_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "repairCaseId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,

    CONSTRAINT "repair_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_retags" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "retagNumber" TEXT NOT NULL,
    "oldTagId" TEXT NOT NULL,
    "newTagId" TEXT NOT NULL,
    "repairCaseId" TEXT,
    "branchId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "oldDetails" JSONB NOT NULL,
    "newDetails" JSONB NOT NULL,
    "retaggedById" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_retags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repair_cases_companyId_status_idx" ON "repair_cases"("companyId", "status");

-- CreateIndex
CREATE INDEX "repair_cases_companyId_tagId_idx" ON "repair_cases"("companyId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "repair_cases_companyId_repairNumber_key" ON "repair_cases"("companyId", "repairNumber");

-- CreateIndex
CREATE UNIQUE INDEX "repair_cases_salesReturnItemId_companyId_key" ON "repair_cases"("salesReturnItemId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "repair_cases_id_companyId_key" ON "repair_cases"("id", "companyId");

-- CreateIndex
CREATE INDEX "repair_transfers_companyId_status_idx" ON "repair_transfers"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "repair_transfers_companyId_transferNumber_key" ON "repair_transfers"("companyId", "transferNumber");

-- CreateIndex
CREATE UNIQUE INDEX "repair_transfers_id_companyId_key" ON "repair_transfers"("id", "companyId");

-- CreateIndex
CREATE INDEX "repair_transfer_items_companyId_idx" ON "repair_transfer_items"("companyId");

-- CreateIndex
CREATE INDEX "repair_transfer_items_repairCaseId_idx" ON "repair_transfer_items"("repairCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "repair_transfer_items_transferId_repairCaseId_key" ON "repair_transfer_items"("transferId", "repairCaseId");

-- CreateIndex
CREATE INDEX "tag_retags_companyId_idx" ON "tag_retags"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_retags_companyId_retagNumber_key" ON "tag_retags"("companyId", "retagNumber");

-- CreateIndex
CREATE UNIQUE INDEX "tag_retags_oldTagId_companyId_key" ON "tag_retags"("oldTagId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_retags_newTagId_companyId_key" ON "tag_retags"("newTagId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_retags_repairCaseId_companyId_key" ON "tag_retags"("repairCaseId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_items_id_companyId_key" ON "sales_return_items"("id", "companyId");

-- AddForeignKey
ALTER TABLE "repair_cases" ADD CONSTRAINT "repair_cases_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_cases" ADD CONSTRAINT "repair_cases_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_cases" ADD CONSTRAINT "repair_cases_salesReturnItemId_companyId_fkey" FOREIGN KEY ("salesReturnItemId", "companyId") REFERENCES "sales_return_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_cases" ADD CONSTRAINT "repair_cases_originBranchId_companyId_fkey" FOREIGN KEY ("originBranchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfers" ADD CONSTRAINT "repair_transfers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfers" ADD CONSTRAINT "repair_transfers_fromBranchId_companyId_fkey" FOREIGN KEY ("fromBranchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfers" ADD CONSTRAINT "repair_transfers_toBranchId_companyId_fkey" FOREIGN KEY ("toBranchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfer_items" ADD CONSTRAINT "repair_transfer_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfer_items" ADD CONSTRAINT "repair_transfer_items_transferId_companyId_fkey" FOREIGN KEY ("transferId", "companyId") REFERENCES "repair_transfers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transfer_items" ADD CONSTRAINT "repair_transfer_items_repairCaseId_companyId_fkey" FOREIGN KEY ("repairCaseId", "companyId") REFERENCES "repair_cases"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_retags" ADD CONSTRAINT "tag_retags_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_retags" ADD CONSTRAINT "tag_retags_oldTagId_companyId_fkey" FOREIGN KEY ("oldTagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_retags" ADD CONSTRAINT "tag_retags_newTagId_companyId_fkey" FOREIGN KEY ("newTagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_retags" ADD CONSTRAINT "tag_retags_repairCaseId_companyId_fkey" FOREIGN KEY ("repairCaseId", "companyId") REFERENCES "repair_cases"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_retags" ADD CONSTRAINT "tag_retags_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security: same tenant_isolation policy every company table carries.
ALTER TABLE "repair_cases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "repair_cases"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "repair_transfers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "repair_transfers"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "repair_transfer_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "repair_transfer_items"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "tag_retags" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tag_retags"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
