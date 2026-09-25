-- CreateTable
CREATE TABLE "state_master" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "state_master_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "state_master_code_key" ON "state_master"("code");

-- CreateIndex
CREATE UNIQUE INDEX "state_master_name_key" ON "state_master"("name");

-- Seed the official GST state/UT codes (B2), inserted here — not just prisma/seed.ts — so the
-- table is never empty on any database that has run migrations, the same pattern used for the
-- default HSN code in 20260823184530_add_hsn_gst_rate.
INSERT INTO "state_master" ("id", "code", "name", "aliases") VALUES
    ('statecode_01', '01', 'Jammu and Kashmir', ARRAY['J&K','JK']),
    ('statecode_02', '02', 'Himachal Pradesh', ARRAY['HP']),
    ('statecode_03', '03', 'Punjab', ARRAY['PB']),
    ('statecode_04', '04', 'Chandigarh', ARRAY[]::TEXT[]),
    ('statecode_05', '05', 'Uttarakhand', ARRAY['UK','Uttaranchal']),
    ('statecode_06', '06', 'Haryana', ARRAY['HR']),
    ('statecode_07', '07', 'Delhi', ARRAY['NCT of Delhi','New Delhi']),
    ('statecode_08', '08', 'Rajasthan', ARRAY['RJ']),
    ('statecode_09', '09', 'Uttar Pradesh', ARRAY['UP']),
    ('statecode_10', '10', 'Bihar', ARRAY['BR']),
    ('statecode_11', '11', 'Sikkim', ARRAY[]::TEXT[]),
    ('statecode_12', '12', 'Arunachal Pradesh', ARRAY['AR']),
    ('statecode_13', '13', 'Nagaland', ARRAY[]::TEXT[]),
    ('statecode_14', '14', 'Manipur', ARRAY[]::TEXT[]),
    ('statecode_15', '15', 'Mizoram', ARRAY[]::TEXT[]),
    ('statecode_16', '16', 'Tripura', ARRAY[]::TEXT[]),
    ('statecode_17', '17', 'Meghalaya', ARRAY[]::TEXT[]),
    ('statecode_18', '18', 'Assam', ARRAY['AS']),
    ('statecode_19', '19', 'West Bengal', ARRAY['WB']),
    ('statecode_20', '20', 'Jharkhand', ARRAY['JH']),
    ('statecode_21', '21', 'Odisha', ARRAY['Orissa']),
    ('statecode_22', '22', 'Chhattisgarh', ARRAY['CG','Chattisgarh']),
    ('statecode_23', '23', 'Madhya Pradesh', ARRAY['MP']),
    ('statecode_24', '24', 'Gujarat', ARRAY['GJ']),
    ('statecode_26', '26', 'Dadra and Nagar Haveli and Daman and Diu', ARRAY['Dadra and Nagar Haveli','Daman and Diu']),
    ('statecode_27', '27', 'Maharashtra', ARRAY['MH']),
    ('statecode_29', '29', 'Karnataka', ARRAY['KA']),
    ('statecode_30', '30', 'Goa', ARRAY['GA']),
    ('statecode_31', '31', 'Lakshadweep', ARRAY[]::TEXT[]),
    ('statecode_32', '32', 'Kerala', ARRAY['KL']),
    ('statecode_33', '33', 'Tamil Nadu', ARRAY['TN']),
    ('statecode_34', '34', 'Puducherry', ARRAY['Pondicherry']),
    ('statecode_35', '35', 'Andaman and Nicobar Islands', ARRAY['Andaman and Nicobar']),
    ('statecode_36', '36', 'Telangana', ARRAY['TS','TG']),
    ('statecode_37', '37', 'Andhra Pradesh', ARRAY['AP']),
    ('statecode_38', '38', 'Ladakh', ARRAY[]::TEXT[]),
    ('statecode_97', '97', 'Other Territory', ARRAY[]::TEXT[]),
    ('statecode_99', '99', 'Centre Jurisdiction', ARRAY[]::TEXT[]);
