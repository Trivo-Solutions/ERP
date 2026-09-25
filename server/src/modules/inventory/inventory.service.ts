import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { nextSimpleCode } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';

export async function getMetalStock(companyId: string, filters: {
  karat?: string; location?: string; minWeight?: number;
}) {
  return tenantQuery(companyId, (_tx) => _tx.metalStock.findMany({
    where: {
      companyId, isActive: true,
      ...(filters.karat && { karat: filters.karat }),
      ...(filters.location && { location: filters.location }),
      ...(filters.minWeight && { availableWt: { gte: filters.minWeight } }),
    },
    include: { reservations: { where: { status: 'ACTIVE' } } },
    orderBy: [{ karat: 'asc' }, { createdAt: 'desc' }],
  }));
}

// `tx` lets a caller that's already inside its own $transaction (e.g. D4's createOldGoldExchange,
// which must not leave an orphaned MetalStock row if the rest of that transaction fails) pass its
// transaction client through — same optional-client pattern used elsewhere. stockCode now uses
// the atomic NumberSequence mechanism (Phase 3) — the previous `count()+1` scheme raced under
// concurrent calls (confirmed by a Phase 2 isolation test hitting real stockCode collisions).
export async function addMetalStock(data: {
  materialName: string; karat: string; purity: number;
  grossWeight: number; netWeight: number; location?: string;
  sourceType: string; sourceRef?: string; avgCostPerGram: number;
}, companyId: string, userId: string, tx?: Prisma.TransactionClient): Promise<Awaited<ReturnType<Prisma.TransactionClient['metalStock']['create']>>> {
  // No surrounding transaction: open a tenant-scoped one (never fall back to the bare client — with row-level
  // security enforced that writes nothing / is refused).
  if (!tx) return tenantTransaction(companyId, (t) => addMetalStock(data, companyId, userId, t));
  const client = tx;
  const stockCode = await nextSimpleCode(companyId, 'METALSTOCK', 'MS', 6, client);
  const stock = await client.metalStock.create({
    data: {
      companyId,
      stockCode,
      ...data,
      availableWt: data.netWeight,
    },
  });
  await createAuditEntry('metal_stocks', stock.id, userId, 'CREATE', undefined, undefined, companyId);
  return stock;
}

export async function adjustMetalStock(
  id: string, adjustment: number, reason: string, ctx: TenantContext, userId: string
) {
  await assertOwnedByCompany('metalStock', id, ctx.companyId, 'Metal stock');
  const stock = await tenantQuery(ctx.companyId, (_tx) => _tx.metalStock.findUniqueOrThrow({ where: { id } }));
  const newAvailable = Number(stock.availableWt) + adjustment;
  if (newAvailable < 0) throw new AppError('Insufficient stock', 400);

  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.metalStock.update({
    where: { id },
    data: { availableWt: newAvailable, netWeight: { increment: adjustment } },
  }));
  await createAuditEntry('metal_stocks', id, userId, 'ADJUST', { availableWt: stock.availableWt } as any, { availableWt: newAvailable, reason } as any, ctx.companyId);
  return updated;
}

// Stone lots
export async function listStoneLots(companyId: string, filters: {
  stoneType?: string; status?: string; color?: string; clarity?: string;
}) {
  return tenantQuery(companyId, (_tx) => _tx.stoneLot.findMany({
    where: {
      companyId,
      ...(filters.stoneType && { stoneType: filters.stoneType }),
      ...(filters.status && { status: filters.status }),
      ...(filters.color && { color: filters.color }),
      ...(filters.clarity && { clarity: filters.clarity }),
    },
    include: { parentSplits: { include: { parentLot: { select: { lotNumber: true } } } } },
    orderBy: { createdAt: 'desc' },
  }));
}

export async function createStoneLot(data: {
  lotNumber?: string; stoneType: string; shape: string; color?: string;
  clarity?: string; cut?: string; caratWeight: number; pieces: number;
  sieveSize?: string; certNumber?: string; certLab?: string;
  avgCostPerCt: number; totalCost: number; location?: string; sourceRef?: string;
}, companyId: string, userId: string) {
  const lot = await tenantTransaction(companyId, async (tx) => {
    const lotNumber = data.lotNumber ?? await nextSimpleCode(companyId, 'STONELOT', 'SL', 6, tx);
    return tx.stoneLot.create({
      data: {
        companyId,
        lotNumber,
        ...data,
        availableCts: data.caratWeight,
        availablePcs: data.pieces,
      },
    });
  });
  await createAuditEntry('stone_lots', lot.id, userId, 'CREATE', undefined, undefined, companyId);
  return lot;
}

export async function splitStoneLot(
  parentId: string,
  splits: Array<{ weight: number; pieces: number; color?: string; clarity?: string; sieveSize?: string }>,
  ctx: TenantContext,
  userId: string
) {
  await assertOwnedByCompany('stoneLot', parentId, ctx.companyId, 'Stone lot');
  const parent = await tenantQuery(ctx.companyId, (_tx) => _tx.stoneLot.findUniqueOrThrow({ where: { id: parentId } }));

  const totalSplitWeight = splits.reduce((s, sp) => s + sp.weight, 0);
  if (totalSplitWeight > Number(parent.availableCts)) {
    throw new AppError('Split weight exceeds available carats', 400);
  }

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    const childLots = [];

    for (const split of splits) {
      const lotNumber = await nextSimpleCode(ctx.companyId, 'STONELOT', 'SL', 6, tx);
      const child = await tx.stoneLot.create({
        data: {
          companyId: ctx.companyId,
          lotNumber,
          stoneType: parent.stoneType,
          shape: parent.shape,
          color: split.color ?? parent.color ?? undefined,
          clarity: split.clarity ?? parent.clarity ?? undefined,
          cut: parent.cut ?? undefined,
          caratWeight: split.weight,
          pieces: split.pieces,
          sieveSize: split.sieveSize ?? parent.sieveSize ?? undefined,
          certLab: parent.certLab ?? undefined,
          avgCostPerCt: parent.avgCostPerCt,
          totalCost: Number(parent.avgCostPerCt) * split.weight,
          availableCts: split.weight,
          availablePcs: split.pieces,
          location: parent.location ?? undefined,
          sourceRef: parent.lotNumber,
        },
      });

      await tx.stoneLotSplit.create({
        data: {
          companyId: ctx.companyId,
          parentLotId: parentId, childLotId: child.id,
          splitWeight: split.weight, splitPieces: split.pieces,
        },
      });

      childLots.push(child);
    }

    await tx.stoneLot.update({
      where: { id: parentId },
      data: {
        availableCts: { decrement: totalSplitWeight },
        availablePcs: { decrement: splits.reduce((s, sp) => s + sp.pieces, 0) },
        status: Number(parent.availableCts) - totalSplitWeight < 0.01 ? 'EXHAUSTED' : 'PARTIALLY_USED',
      },
    });

    return childLots;
  });

  await createAuditEntry('stone_lots', parentId, userId, 'SPLIT', undefined, undefined, ctx.companyId);
  return result;
}

// Consumables
export async function listConsumables(companyId: string, category?: string) {
  return tenantQuery(companyId, (_tx) => _tx.consumable.findMany({
    where: { companyId, isActive: true, ...(category && { category }) },
    include: { _count: { select: { transactions: true } } },
    orderBy: { name: 'asc' },
  }));
}

export async function consumableTransaction(
  consumableId: string,
  type: 'IN' | 'OUT' | 'ADJUSTMENT',
  quantity: number,
  ctx: TenantContext,
  reference?: string,
  notes?: string
) {
  await assertOwnedByCompany('consumable', consumableId, ctx.companyId, 'Consumable');
  return tenantTransaction(ctx.companyId, async (tx) => {
    const item = await tx.consumable.findUniqueOrThrow({ where: { id: consumableId } });
    const newQty = type === 'OUT'
      ? Number(item.currentQty) - quantity
      : Number(item.currentQty) + quantity;
    if (newQty < 0) throw new AppError('Insufficient consumable stock', 400);

    const updated = await tx.consumable.update({
      where: { id: consumableId }, data: { currentQty: newQty },
    });
    await tx.consumableTransaction.create({
      data: { companyId: ctx.companyId, consumableId, type, quantity, balanceAfter: newQty, reference, notes },
    });
    return updated;
  });
}
