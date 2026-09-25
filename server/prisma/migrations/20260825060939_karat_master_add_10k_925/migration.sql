-- Add the two codes NewTagPage.tsx's (separately hardcoded, now-retired) karat dropdown
-- already allowed that the initial karat_master seed missed: 10K (41.7% gold) and 925
-- (sterling silver notation — same purity as SILVER, kept as a distinct code since both
-- names are in real use). OTHER was intentionally dropped, not carried over — a fixed
-- purity master has nothing to enforce for a code with no fixed purity; karat stays
-- optional on JewelryTag for a piece that's genuinely ambiguous.
INSERT INTO "karat_master" ("id", "code", "metalType", "purity", "isActive") VALUES
    ('karatmaster_10k', '10K', 'GOLD', 0.4170, true),
    ('karatmaster_925', '925', 'SILVER', 0.9250, true);
