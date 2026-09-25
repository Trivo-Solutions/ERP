-- CreateTable
CREATE TABLE "stock_audits" (
    "id" TEXT NOT NULL,
    "auditNumber" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "stock_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_audit_items" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "expected" BOOLEAN NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT false,
    "foundAt" TIMESTAMP(3),

    CONSTRAINT "stock_audit_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_audits_auditNumber_key" ON "stock_audits"("auditNumber");

-- CreateIndex
CREATE UNIQUE INDEX "stock_audit_items_auditId_tagId_key" ON "stock_audit_items"("auditId", "tagId");

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "stock_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
