import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { tenantTransaction } from './tenantContext';

// ═══════════════════════════════════════════════════
// Atomic, company-scoped document numbering.
//
// Replaces the old global "find the row with the highest matching prefix, then +1" scan
// (shared/numbering.ts: generateNumber/generateTagNumber) for the prototype's two document
// types (SalesInvoice.invoiceNumber, JewelryTag.tagNumber). That old mechanism had two
// independent problems: (1) it scanned globally, so two companies' first invoice of the year
// would collide on the same unique constraint; (2) even scoped per company, "read latest, then
// write" has a race window under concurrent callers for the SAME company.
//
// This fixes both by keying a dedicated counter table on (companyId, documentType,
// financialYear) and incrementing it with a single atomic `INSERT ... ON CONFLICT DO UPDATE`
// statement — Postgres takes the necessary row lock internally as part of that one statement,
// so two simultaneous callers for the same key are guaranteed two different, non-colliding
// values with no separate check-then-write race window in application code. It also never
// scans the parent table (sales_invoices/jewelry_tags), so its cost doesn't grow with that
// table's row count.
//
// Deliberately NOT gapless: a rolled-back transaction that already consumed a number leaves a
// gap. Uniqueness, concurrency-safety, and correct company/year/type scoping are the actual
// requirements here — gaplessness was never a stated legal/business requirement, and chasing it
// would require holding a lock across the whole business transaction (reintroducing exactly the
// long-held-lock problem this design avoids).
// ═══════════════════════════════════════════════════

// G1 Part C: the Indian GST financial year runs Apr–Mar, not Jan–Dec. Returns the calendar year
// the FY STARTS in (e.g. 2026-03-31 -> 2025, meaning "FY 2025-26"; 2026-04-01 -> 2026, "FY
// 2026-27"). getMonth() is 0-indexed, so Jan/Feb/Mar are months 0-2 — before April, the FY
// started the PREVIOUS calendar year.
//
// No backfill was needed for the cutover to this from the old (calendar-year) key: for any
// invoice dated April-December, the FY-start year and the calendar year are IDENTICAL, so every
// existing number_sequences row keyed by a plain calendar year already reads as the correct FY
// key today. Only a January-March invoice would have used the "wrong" (next) sequence under the
// old scheme — and one keyed collision away, the FIRST such invoice after this ships correctly
// resumes the FY's own already-running counter (the one Apr-Dec of that FY used), rather than
// starting a fresh "new year" counter at 1, which is the actual bug this fixes.
export function gstFinancialYear(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth();
  return month < 3 ? year - 1 : year;
}

export interface NumberSequenceKey {
  companyId: string;
  documentType: string;
  financialYear?: number | null;
}

// Postgres multi-column UNIQUE constraints treat NULL as never equal to another NULL, so
// `ON CONFLICT ("companyId","documentType","financialYear")` never fires when financialYear is
// actually NULL — every "non-year-scoped" call (nextSimpleCode/nextTagNumber) would silently
// INSERT a brand-new row instead of incrementing the existing one, handing out "1" forever
// instead of a real sequence (caught by the tagNumber unique-constraint collisions this fix
// resolves). Sentinel 0 stands in for "no financial year" in the actual row/constraint so every
// call for the same key hits the same real row; callers' public API still speaks in `null`.
const NO_FINANCIAL_YEAR = 0;

/** Atomically increments and returns the next raw integer value for this key. */
async function nextSequenceValue(
  key: NumberSequenceKey,
  tx?: Prisma.TransactionClient | typeof prisma
): Promise<number> {
  // No surrounding transaction supplied: open a tenant-scoped one for this increment (never a bare
  // `prisma` call — with row-level security enforced that would see and write nothing).
  if (!tx) return tenantTransaction(key.companyId, (t) => nextSequenceValue(key, t));
  const financialYear = key.financialYear ?? NO_FINANCIAL_YEAR;
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "number_sequences" ("id", "companyId", "documentType", "financialYear", "lastValue", "updatedAt")
    VALUES (gen_random_uuid()::text, ${key.companyId}, ${key.documentType}, ${financialYear}, 1, now())
    ON CONFLICT ("companyId", "documentType", "financialYear")
    DO UPDATE SET "lastValue" = "number_sequences"."lastValue" + 1, "updatedAt" = now()
    RETURNING "lastValue"
  `;
  return rows[0].lastValue;
}

/**
 * Year-scoped document number, e.g. "INV-2026-000001". `tx` should be the same transaction
 * client the surrounding business operation is already using (see tenantContext.ts) so the
 * increment participates in the same atomic unit of work as the row it numbers.
 */
export async function nextDocumentNumber(
  companyId: string,
  documentType: string,
  prefix: string,
  tx?: Prisma.TransactionClient | typeof prisma,
  year: number = gstFinancialYear(new Date())
): Promise<string> {
  const value = await nextSequenceValue({ companyId, documentType, financialYear: year }, tx);
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
}

/**
 * Non-year-scoped codes (e.g. Client/Supplier codes) — these are master-data identifiers, not
 * yearly transaction documents, so they must NOT reset their sequence every financial year the
 * way an invoice/PO number does. financialYear stays null; documentType alone is the key.
 */
export async function nextSimpleCode(
  companyId: string,
  documentType: string,
  prefix: string,
  padWidth: number,
  tx?: Prisma.TransactionClient | typeof prisma
): Promise<string> {
  const value = await nextSequenceValue({ companyId, documentType, financialYear: null }, tx);
  return `${prefix}-${String(value).padStart(padWidth, '0')}`;
}

/**
 * Tag-number generation is scoped by (StockType code, Category code), not by financial year —
 * documentType itself encodes that combination (financialYear stays null for this counter),
 * e.g. documentType "TAG:R:RNG" for Ready-stock Rings. Format matches the existing convention:
 * prefix + 5-digit zero-padded sequence (e.g. "RRNG00001").
 */
export async function nextTagNumber(
  companyId: string,
  stockTypeCode: string,
  categoryCode: string,
  tx?: Prisma.TransactionClient | typeof prisma
): Promise<string> {
  const prefix = `${stockTypeCode}${categoryCode}`.toUpperCase();
  const documentType = `TAG:${stockTypeCode}:${categoryCode}`.toUpperCase();
  const value = await nextSequenceValue({ companyId, documentType, financialYear: null }, tx);
  return `${prefix}${String(value).padStart(5, '0')}`;
}
