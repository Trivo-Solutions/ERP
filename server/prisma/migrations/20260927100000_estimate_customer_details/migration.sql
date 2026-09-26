-- Estimate -> billing: the hand-off now carries the customer's full details and the sales employee, so the
-- biller does not ask again. Client gains a date of birth (date only).
--
-- Existing estimates and clients keep NULL in every new column: nothing was captured for them.

ALTER TABLE "clients" ADD COLUMN "dateOfBirth" DATE;

ALTER TABLE "tag_estimates"
  ADD COLUMN "customerDob" DATE,
  ADD COLUMN "customerAddress" TEXT,
  ADD COLUMN "customerPan" TEXT,
  ADD COLUMN "salesPersonId" TEXT;

ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_salesPersonId_fkey"
  FOREIGN KEY ("salesPersonId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
