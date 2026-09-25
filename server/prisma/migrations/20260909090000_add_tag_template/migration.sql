-- CreateTable
CREATE TABLE "tag_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "widthMm" DECIMAL(6,2) NOT NULL,
    "heightMm" DECIMAL(6,2) NOT NULL,
    "gapMm" DECIMAL(6,2) NOT NULL DEFAULT 2.0,
    "layout" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tag_templates_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "tag_templates" ADD CONSTRAINT "tag_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the default label so Stage 1 (TSPL generation) has something real to generate against
-- before the visual designer (Stage 3) exists. Mirrors NewTagPage.tsx's TagLabel field set
-- (tagNumber barcode, name, karat, weights, HUID, selling price). 50mm x 30mm, single wing
-- ("front" only) — the Stage 3 designer edits this row like any other template.
INSERT INTO "tag_templates" ("id", "name", "isDefault", "widthMm", "heightMm", "gapMm", "layout", "updatedAt")
VALUES (
  'tagtemplate_default',
  'Default Jewelry Tag',
  true,
  50.00,
  30.00,
  2.00,
  '{"elements":[
    {"id":"el1","wing":"front","type":"barcode","xMm":4,"yMm":2,"boundField":"tagNumber","barcodeType":"CODE128","heightMm":10,"humanReadable":true},
    {"id":"el2","wing":"front","type":"text","xMm":4,"yMm":14,"boundField":"name","fontSize":9},
    {"id":"el3","wing":"front","type":"text","xMm":4,"yMm":19,"boundField":"metalKarat","fontSize":8},
    {"id":"el4","wing":"front","type":"text","xMm":22,"yMm":19,"boundField":"grossWeight","fontSize":8},
    {"id":"el5","wing":"front","type":"text","xMm":4,"yMm":24,"boundField":"sellingPrice","fontSize":10},
    {"id":"el6","wing":"front","type":"text","xMm":4,"yMm":27,"boundField":"huid","fontSize":7}
  ]}'::jsonb,
  CURRENT_TIMESTAMP
);
