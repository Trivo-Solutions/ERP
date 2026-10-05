-- Internal manufacturing loss is no longer used (trading business); sale wastage (VA%) stays.
ALTER TABLE "making_charges" DROP COLUMN "wastagePercent";
