import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';

// Statutory checks a jewellery counter has to make on every sale. Kept in one place so the invoice, the
// memo-conversion and the payment paths cannot drift apart — the same lesson as the A1 currency bug.
//
// These encode the rules as generally understood; they are not tax advice. The thresholds are constants
// so a change in law is a one-line edit — confirm with your CA before relying on them for filing.

/** Sec 269ST: no person may receive ₹2,00,000 OR MORE in cash from one person in a day. */
export const CASH_RECEIPT_LIMIT = 200_000;

/** Rule 114B: PAN (or Form 60) must be quoted on a sale EXCEEDING ₹2,00,000 in a single transaction. */
export const PAN_REQUIRED_ABOVE = 200_000;

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Exported for shared/istDate.ts (GST report date-boundary hardening) — same fixed offset, India
// has no DST so a constant is always correct, not just an approximation.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Trim + upper-case a PAN and check its shape; '' / null / undefined mean "no PAN" (returned as null). */
export function normalizePan(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const pan = String(raw).trim().toUpperCase();
  if (pan === '') return null;
  if (!PAN_REGEX.test(pan)) throw new AppError('PAN must be 10 characters like ABCDE1234F', 400);
  return pan;
}

/** A GSTIN embeds its holder's PAN (characters 3-12), so a registered dealer already "has a PAN on file". */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const m = gstin?.trim().toUpperCase().match(/^\d{2}([A-Z]{5}[0-9]{4}[A-Z])[0-9A-Z]{3}$/);
  return m ? m[1] : null;
}

/** Rule 114B. Throws unless the client has a PAN (their own, or the one inside their GSTIN) or a Form 60. */
export function assertPanIfRequired(
  client: { name: string; panNumber: string | null; gstNumber: string | null; form60Received: boolean },
  saleAmount: number,
) {
  if (saleAmount <= PAN_REQUIRED_ABOVE) return;
  if (client.panNumber || panFromGstin(client.gstNumber) || client.form60Received) return;
  throw new AppError(
    `PAN required: this sale is ${inr(saleAmount)}, above ${inr(PAN_REQUIRED_ABOVE)}. Add ${client.name}'s PAN ` +
    `(or record that a Form 60 was received) on their client record first.`,
    400,
  );
}

// A payment's calendar day in IST — the day the business actually trades in, not the server's or UTC's.
function istDayBounds(d: Date) {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * 60 * 1000), label: shifted.toISOString().slice(0, 10) };
}

/**
 * Sec 269ST. Call inside the transaction that is about to record a payment, BEFORE writing it: adds this
 * payment to every cash payment already recorded for the same client on the same day (invoice-linked and
 * standalone alike — including earlier splits of the same sale, which are already written) and refuses if
 * the total would reach the limit. Non-cash modes are never limited. The "single transaction" and "one
 * event" limbs of the section are approximated by the daily aggregate, which is always the tighter test.
 */
export async function assertCashLimit(
  tx: Prisma.TransactionClient,
  companyId: string,
  clientId: string,
  payment: { paymentDate: Date; amount: number; mode: string },
) {
  if (payment.mode.trim().toUpperCase() !== 'CASH') return;

  const { start, end, label } = istDayBounds(payment.paymentDate);
  const agg = await tx.invoicePayment.aggregate({
    // J3.5 Finding 4: a reversed cash receipt didn't actually leave cash in hand — exclude it, or
    // reversing a mistaken cash entry would keep consuming this client's daily allowance and could
    // wrongly block a later, legitimate cash payment the same day.
    where: { companyId, clientId, mode: { equals: 'CASH', mode: 'insensitive' }, paymentDate: { gte: start, lt: end }, reversedAt: null },
    _sum: { amount: true },
  });
  // Customer Advance cash receipts are cash received from this client too: same day, same limit.
  const advAgg = await tx.customerAdvance.aggregate({
    where: { companyId, clientId, mode: { equals: 'CASH', mode: 'insensitive' }, advanceDate: { gte: start, lt: end }, reversedAt: null },
    _sum: { amount: true },
  });
  const already = Number(agg._sum.amount ?? 0) + Number(advAgg._sum.amount ?? 0);
  const total = already + payment.amount;
  if (total >= CASH_RECEIPT_LIMIT) {
    throw new AppError(
      `Cash limit (Sec 269ST): ${inr(already)} already received in cash from this client on ${label}; accepting ` +
      `${inr(payment.amount)} more would make ${inr(total)}, at or above the ${inr(CASH_RECEIPT_LIMIT)} daily limit. ` +
      `Take the rest by UPI, card, cheque or bank transfer.`,
      400,
    );
  }
}
