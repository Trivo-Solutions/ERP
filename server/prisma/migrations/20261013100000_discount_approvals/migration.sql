-- Offer management step 3: store-manager approval for selling below an offer. Purely additive - a new table, no existing
-- row read or changed. Never cascades. Requester != approver is enforced by the database as well as the service.
CREATE TABLE "discount_approvals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tagId" TEXT,
    "offerId" TEXT,
    "requestedRates" JSONB NOT NULL,
    "offeredRates" JSONB NOT NULL,
    "rateHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "usedAt" TIMESTAMP(3),
    "usedInvoiceId" TEXT,
    CONSTRAINT "discount_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "discount_approvals_scope_valid" CHECK ("scope" IN ('LINE', 'DISCOUNT')),
    CONSTRAINT "discount_approvals_status_valid" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'USED')),
    CONSTRAINT "discount_approvals_line_has_tag" CHECK ("scope" <> 'LINE' OR "tagId" IS NOT NULL),
    CONSTRAINT "discount_approvals_two_people" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById"),
    CONSTRAINT "discount_approvals_used_has_invoice" CHECK ("status" <> 'USED' OR "usedInvoiceId" IS NOT NULL)
);

CREATE UNIQUE INDEX "discount_approvals_id_companyId_key" ON "discount_approvals"("id", "companyId");
CREATE INDEX "discount_approvals_companyId_status_requestedAt_idx" ON "discount_approvals"("companyId", "status", "requestedAt");
CREATE INDEX "discount_approvals_usedInvoiceId_idx" ON "discount_approvals"("usedInvoiceId");

ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_tagId_companyId_fkey"
  FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_offerId_companyId_fkey"
  FOREIGN KEY ("offerId", "companyId") REFERENCES "offers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_usedInvoiceId_companyId_fkey"
  FOREIGN KEY ("usedInvoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security (FORCE is applied by db-secure.sql to every table carrying this policy).
ALTER TABLE "discount_approvals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "discount_approvals"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
