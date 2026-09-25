-- Supplier payments (money paid OUT to a supplier) and a live supplier payable.
--
-- supplier_payments mirrors invoice_payments on the buy side. Recording one posts Dr Accounts Payable /
-- Cr Cash-or-Bank and reduces suppliers.currentDue. currentDue is now maintained by the application:
-- finished-goods intake adds (goods + GST), a purchase return and a payment reduce it.

CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" TEXT NOT NULL,
    "referenceNo" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_payments_companyId_paymentNumber_key" ON "supplier_payments"("companyId", "paymentNumber");
CREATE INDEX "supplier_payments_companyId_idx" ON "supplier_payments"("companyId");
CREATE INDEX "supplier_payments_supplierId_idx" ON "supplier_payments"("supplierId");

ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- composite FK: the database itself refuses a payment pointing at another company's supplier
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_companyId_fkey"
  FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same policy every tenant table carries (db-secure.sql FORCEs it and grants the runtime role).
ALTER TABLE "supplier_payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier_payments"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- Opening payable for existing suppliers: everything bought into stock through a GRN (the tag's cost)
-- less everything returned. Input GST was not booked before this release, so there is none to add.
-- Only suppliers still at 0 are touched — a figure someone already keyed into currentDue by hand is
-- left alone and simply becomes the opening balance the new movements add to.
--
-- These are tenant tables: under FORCEd row-level security even the owner running this would read zero
-- rows and update none, so FORCE is lifted for the statement and restored (only where it was on).
DO $$
DECLARE t text; forced text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'jewelry_tags', 'grn_items', 'po_items', 'purchase_orders', 'purchase_returns'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t AND relnamespace = 'public'::regnamespace AND relforcerowsecurity) THEN
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
      forced := forced || t;
    END IF;
  END LOOP;

  UPDATE "suppliers" s SET "currentDue" =
    COALESCE((
      SELECT SUM(t."costPrice")
      FROM "jewelry_tags" t
      JOIN "grn_items" g ON g."id" = t."grnItemId"
      JOIN "po_items" pi ON pi."id" = g."poItemId"
      JOIN "purchase_orders" po ON po."id" = pi."poId"
      WHERE po."supplierId" = s."id" AND po."companyId" = s."companyId"
    ), 0)
    - COALESCE((
      SELECT SUM(r."totalAmount") FROM "purchase_returns" r
      WHERE r."supplierId" = s."id" AND r."companyId" = s."companyId"
    ), 0)
  WHERE s."currentDue" = 0;

  FOREACH t IN ARRAY forced LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
