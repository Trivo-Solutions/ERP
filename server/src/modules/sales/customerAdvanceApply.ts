import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';

// Customer Advances, Phase 3: the row-level mechanics of spending / releasing an advance. Deliberately free of any
// import from sales.service (which calls these from inside applyPayment), so there is no module cycle.
// An advance is NEVER Store Credit and never touches Client.currentBalance as a source — it is its own liability
// (ledger 2400) that is drawn down here.

const paise = (d: Prisma.Decimal | number | string) => Math.round(Number(d) * 100);
const rupees = (p: number) => p / 100;

/** Lock the advance rows (in id order — a fixed order so two bills touching the same advances cannot deadlock). */
export async function lockAdvances(tx: Prisma.TransactionClient, companyId: string, advanceIds: string[]) {
  const ids = Array.from(new Set(advanceIds)).sort();
  for (const id of ids) {
    await tx.$queryRaw`SELECT "id" FROM "customer_advances" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
  }
}

/** Reads a (locked) advance and refuses anything that cannot fund this customer's bill. Returns what is left in it. */
export async function loadSpendableAdvance(tx: Prisma.TransactionClient, companyId: string, advanceId: unknown, invoiceClientId: string) {
  if (typeof advanceId !== 'string' || !advanceId) throw new AppError('advanceId is required for a CUSTOMER_ADVANCE payment', 400);
  // Another company's advance is invisible here (RLS + the company filter): reported exactly like a missing one.
  const adv = await tx.customerAdvance.findFirst({ where: { id: advanceId, companyId } });
  if (!adv) throw new AppError('Advance not found', 404);
  if (adv.clientId !== invoiceClientId) throw new AppError('This advance belongs to a different customer and cannot be applied to this invoice', 409);
  if (adv.reversedAt) throw new AppError(`Advance ${adv.advanceNumber} has been reversed`, 409);
  const remaining = paise(adv.amount) - paise(adv.appliedAmount) - paise(adv.refundedAmount);
  if (remaining <= 0) throw new AppError(`Advance ${adv.advanceNumber} has no balance left to apply`, 409);
  return { adv, remaining: rupees(remaining) };
}

/** Draws `amount` from the advance and records the application against its InvoicePayment. Count-checked. */
export async function recordAdvanceApplication(
  tx: Prisma.TransactionClient,
  a: {
    companyId: string; advanceId: string; clientId: string; invoiceId: string; invoicePaymentId: string;
    amount: number; appliedById: string; idempotencyKey?: string;
  },
) {
  const adv = await tx.customerAdvance.findFirst({ where: { id: a.advanceId, companyId: a.companyId } });
  if (!adv) throw new AppError('Advance not found', 404);
  const remaining = paise(adv.amount) - paise(adv.appliedAmount) - paise(adv.refundedAmount);
  if (paise(a.amount) > remaining) {
    throw new AppError(`Advance ${adv.advanceNumber} has only ${rupees(remaining).toFixed(2)} left; ${a.amount.toFixed(2)} was asked for`, 409);
  }
  const claimed = await tx.customerAdvance.updateMany({
    where: { id: adv.id, companyId: a.companyId, reversedAt: null, appliedAmount: adv.appliedAmount, refundedAmount: adv.refundedAmount },
    data: { appliedAmount: rupees(paise(adv.appliedAmount) + paise(a.amount)) },
  });
  if (claimed.count !== 1) throw new AppError('This advance was changed by another operation just now — retry', 409);
  await tx.customerAdvanceApplication.create({
    data: {
      companyId: a.companyId, advanceId: a.advanceId, clientId: a.clientId, invoiceId: a.invoiceId,
      invoicePaymentId: a.invoicePaymentId, amount: a.amount, appliedById: a.appliedById, idempotencyKey: a.idempotencyKey,
    },
  });
  return adv;
}

/** Reversal side: marks the application reversed (count-checked) and gives its amount back to the advance. */
export async function releaseAdvanceApplication(tx: Prisma.TransactionClient, companyId: string, invoicePaymentId: string, userId: string, reason: string) {
  const app = await tx.customerAdvanceApplication.findFirst({ where: { invoicePaymentId, companyId } });
  if (!app) throw new AppError('Cannot reverse: the customer-advance application for this payment could not be found', 500);
  // Lock the advance (payment → invoice → advance, the same order every other path takes).
  await lockAdvances(tx, companyId, [app.advanceId]);
  const marked = await tx.customerAdvanceApplication.updateMany({
    where: { id: app.id, companyId, reversedAt: null },
    data: { reversedAt: new Date(), reversedById: userId, reversalReason: reason },
  });
  if (marked.count !== 1) throw new AppError('This advance application has already been reversed', 409);
  const adv = await tx.customerAdvance.findFirstOrThrow({ where: { id: app.advanceId, companyId } });
  const next = paise(adv.appliedAmount) - paise(app.amount);
  if (next < 0) throw new AppError('Cannot reverse: the advance\'s applied amount is lower than this application', 409);
  const restored = await tx.customerAdvance.updateMany({
    where: { id: adv.id, companyId, appliedAmount: adv.appliedAmount },
    data: { appliedAmount: rupees(next) },
  });
  if (restored.count !== 1) throw new AppError('This advance was changed by another operation just now — retry the reversal', 409);
  return { app, advance: adv, appliedBefore: Number(adv.appliedAmount), appliedAfter: rupees(next) };
}
