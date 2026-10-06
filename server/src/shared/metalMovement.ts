import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';

// Metal Vault stock movements. A MetalStock row is one lot; every change the sell / buy-back flows make to a lot's
// availableWt is written here, in the SAME transaction as the change, as one signed MetalStockMovement row per lot touched.
//
// Idempotency: (company, movementType, referenceType, referenceId, lot) is unique. The cause of a movement (an invoice
// line, a return line, an exchange) can therefore never move the same lot in the same way twice — a replay is refused
// (409) before it touches the lot, and the unique index is the backstop if two replays ever race.
export const METAL_MOVEMENT = {
  MATERIAL_SALE: 'MATERIAL_SALE',
  MATERIAL_SALE_RETURN: 'MATERIAL_SALE_RETURN',
  CUSTOMER_PURCHASE: 'CUSTOMER_PURCHASE',
  CUSTOMER_PURCHASE_REVERSAL: 'CUSTOMER_PURCHASE_REVERSAL',
  OLD_GOLD_EXCHANGE: 'OLD_GOLD_EXCHANGE',
  OLD_GOLD_EXCHANGE_REVERSAL: 'OLD_GOLD_EXCHANGE_REVERSAL',
  MANUAL_ADD: 'MANUAL_ADD',
} as const;
export type MetalMovementType = typeof METAL_MOVEMENT[keyof typeof METAL_MOVEMENT];

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const EPS = 0.00005;

type LotLike = { id: string; materialName: string; karat: string; purity: unknown; availableWt: unknown; avgCostPerGram: unknown };

export type MovementMeta = {
  movementType: MetalMovementType;
  referenceType: string;
  referenceId: string;
  userId?: string | null;
  branchId?: string | null;
  reversesMovementId?: string | null;
};

// Writes one movement row. Refuses (409) a replay of the same cause on the same lot.
export async function insertMetalMovement(
  tx: Prisma.TransactionClient, companyId: string, lot: LotLike,
  delta: number, before: number, after: number, meta: MovementMeta,
) {
  const dup = await tx.metalStockMovement.findFirst({
    where: { companyId, movementType: meta.movementType, referenceType: meta.referenceType, referenceId: meta.referenceId, metalStockId: lot.id },
    select: { id: true },
  });
  if (dup) throw new AppError('This stock movement has already been processed', 409);
  return tx.metalStockMovement.create({
    data: {
      companyId, branchId: meta.branchId ?? null, metalStockId: lot.id,
      movementType: meta.movementType, referenceType: meta.referenceType, referenceId: meta.referenceId,
      reversesMovementId: meta.reversesMovementId ?? null,
      materialName: lot.materialName, karat: lot.karat, purity: Number(lot.purity),
      quantity: r4(delta), beforeAvailableWt: r4(before), afterAvailableWt: r4(after),
      unitCostPerGram: Number(lot.avgCostPerGram), userId: meta.userId ?? null,
    },
  });
}

// Moves a lot's availableWt by `delta` (negative = out) and records the movement. The write is a count-checked
// conditional update on the weight we just read, so two concurrent movers cannot both act on the same figure, and a lot
// can never be taken below zero.
async function moveLot(tx: Prisma.TransactionClient, companyId: string, lot: LotLike, delta: number, meta: MovementMeta) {
  const before = Number(lot.availableWt);
  const after = r4(before + delta);
  if (after < -EPS) throw new AppError(`Metal Vault lot would go negative (${r4(before)} g available, ${r4(-delta)} g requested)`, 409);
  // Check for a replay first so it is refused before the lot is touched.
  const dup = await tx.metalStockMovement.findFirst({
    where: { companyId, movementType: meta.movementType, referenceType: meta.referenceType, referenceId: meta.referenceId, metalStockId: lot.id },
    select: { id: true },
  });
  if (dup) throw new AppError('This stock movement has already been processed', 409);
  const claimed = await tx.metalStock.updateMany({
    where: { id: lot.id, companyId, availableWt: lot.availableWt as Prisma.Decimal },
    data: { availableWt: Math.max(after, 0) },
  });
  if (claimed.count !== 1) throw new AppError('Metal Vault stock changed just now — retry', 409);
  return insertMetalMovement(tx, companyId, lot, delta, before, after, meta);
}

// A material (loose-metal) sale: takes `weight` grams of `karat` out of the vault, oldest lot first (FIFO), spilling over
// into the next lot when one is not enough. Rejects — before anything is written — when the vault does not hold enough.
// Returns the cost of the metal taken (weight x each lot's own avgCostPerGram) for the COGS / Inventory entry.
export async function consumeVaultMetal(
  tx: Prisma.TransactionClient, companyId: string,
  args: { karat: string; weight: number; meta: Omit<MovementMeta, 'movementType'> },
): Promise<{ cost: number }> {
  const weight = r4(args.weight);
  if (!(weight > 0)) throw new AppError('Material sale weight must be more than zero', 400);
  const lots = await tx.metalStock.findMany({
    where: { companyId, karat: args.karat, isActive: true, availableWt: { gt: 0 } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const available = r4(lots.reduce((s, l) => s + Number(l.availableWt), 0));
  if (available + EPS < weight) {
    throw new AppError(`Insufficient Metal Vault stock for ${args.karat}: ${weight} g needed, ${available} g available`, 409);
  }
  let left = weight;
  let cost = 0;
  for (const lot of lots) {
    if (left <= EPS) break;
    const take = r4(Math.min(left, Number(lot.availableWt)));
    await moveLot(tx, companyId, lot, -take, { ...args.meta, movementType: METAL_MOVEMENT.MATERIAL_SALE });
    cost += take * Number(lot.avgCostPerGram);
    left = r4(left - take);
  }
  return { cost };
}

// Gives `weight` grams of a material sale back to the vault — to the SAME lots the sale drew from, at the SAME cost, via
// the sale's own movements. Refuses to restore more than the sale took out and has not already been given back, so
// returning a line twice (or a void after a return) can never inflate the vault. Returns the cost restored.
export async function restoreVaultMetal(
  tx: Prisma.TransactionClient, companyId: string,
  args: { saleReferenceType: string; saleReferenceId: string; weight: number; meta: Omit<MovementMeta, 'movementType' | 'reversesMovementId'> },
): Promise<{ cost: number }> {
  const weight = r4(args.weight);
  if (!(weight > 0)) throw new AppError('Return weight must be more than zero', 400);
  const sales = await tx.metalStockMovement.findMany({
    where: { companyId, movementType: METAL_MOVEMENT.MATERIAL_SALE, referenceType: args.saleReferenceType, referenceId: args.saleReferenceId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (sales.length === 0) throw new AppError('No Metal Vault movement was recorded for this sale line — nothing to restore', 409);
  const restoredRows = await tx.metalStockMovement.findMany({
    where: { companyId, movementType: METAL_MOVEMENT.MATERIAL_SALE_RETURN, reversesMovementId: { in: sales.map((s) => s.id) } },
    select: { reversesMovementId: true, quantity: true },
  });
  const restoredBy = new Map<string, number>();
  for (const r of restoredRows) restoredBy.set(r.reversesMovementId!, (restoredBy.get(r.reversesMovementId!) ?? 0) + Number(r.quantity));

  let left = weight;
  let cost = 0;
  for (const sale of sales) {
    if (left <= EPS) break;
    const remaining = r4(-Number(sale.quantity) - (restoredBy.get(sale.id) ?? 0));
    if (remaining <= EPS) continue;
    const give = r4(Math.min(left, remaining));
    const lot = await tx.metalStock.findFirst({ where: { id: sale.metalStockId, companyId } });
    if (!lot) throw new AppError('The Metal Vault lot this sale drew from no longer exists', 409);
    await moveLot(tx, companyId, lot, give, {
      ...args.meta, movementType: METAL_MOVEMENT.MATERIAL_SALE_RETURN, reversesMovementId: sale.id,
    });
    cost += give * Number(sale.unitCostPerGram);
    left = r4(left - give);
  }
  if (left > EPS) {
    throw new AppError(`Cannot restore ${weight} g to the vault — only ${r4(weight - left)} g of this sale is still outstanding`, 409);
  }
  return { cost };
}
