import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { nextSimpleCode } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { insertMetalMovement, METAL_MOVEMENT, MetalMovementType, VaultMetal, vaultMetalWhere, parseVaultMetal } from '../../shared/metalMovement';

export async function getMetalStock(companyId: string, filters: {
  karat?: string; location?: string; minWeight?: number;
  // Only the lots eligible as this metal (same rule a material sale draws with: shared/metalMovement.ts vaultMetalWhere).
  metalType?: VaultMetal;
}) {
  return tenantQuery(companyId, (_tx) => _tx.metalStock.findMany({
    where: {
      companyId, isActive: true,
      ...(filters.metalType && vaultMetalWhere(filters.metalType)),
      ...(filters.karat && { karat: filters.karat }),
      ...(filters.location && { location: filters.location }),
      ...(filters.minWeight && { availableWt: { gte: filters.minWeight } }),
    },
    include: { reservations: { where: { status: 'ACTIVE' } } },
    orderBy: [{ karat: 'asc' }, { createdAt: 'desc' }],
  }));
}

// The karats the Metal Vault can hold (this company's active GOLD / SILVER karats), for the vault's own form and tiles. Served under
// the vault's `stock:view` so the screen does not depend on `masters:view`; it exposes only code / metal / purity, never the rest of
// the master, and addMetalStockEntry still re-checks the chosen karat against the master on every write.
export async function listVaultKarats(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.karatMaster.findMany({
    where: { companyId, isActive: true, metalType: { in: ['GOLD', 'SILVER'] } },
    select: { code: true, metalType: true, purity: true },
    orderBy: { code: 'asc' },
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
  // GOLD | SILVER — omitted leaves NULL, which every reader treats as GOLD.
  metalType?: string;
  sourceType: string; sourceRef?: string; avgCostPerGram: number;
}, companyId: string, userId: string, tx?: Prisma.TransactionClient,
// What brought this metal in — recorded as the lot's opening MetalStockMovement. Defaults to a manual add.
movement?: { movementType: MetalMovementType; referenceType: string; referenceId: string; branchId?: string | null },
): Promise<Awaited<ReturnType<Prisma.TransactionClient['metalStock']['create']>>> {
  // No surrounding transaction: open a tenant-scoped one (never fall back to the bare client — with row-level
  // security enforced that writes nothing / is refused).
  if (!tx) return tenantTransaction(companyId, (t) => addMetalStock(data, companyId, userId, t, movement));
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
  await insertMetalMovement(client, companyId, stock, Number(stock.availableWt), 0, Number(stock.availableWt), {
    movementType: movement?.movementType ?? METAL_MOVEMENT.MANUAL_ADD,
    referenceType: movement?.referenceType ?? 'MetalStock',
    referenceId: movement?.referenceId ?? stock.id,
    branchId: movement?.branchId, userId,
  });
  await createAuditEntry('metal_stocks', stock.id, userId, 'CREATE', undefined, undefined, companyId);
  return stock;
}

// A hand-entered Metal Vault lot (POST /inventory/metals). The request is NOT spread into the row: only the fields below are read.
// The lot's metal is the Karat master's, never the client's - the karat must be one of THIS company's active karats and its
// metalType (GOLD or SILVER) is what gets stored. A client-supplied `metalType` is only a cross-check: if it is present and
// disagrees with the master the entry is refused (400), so a silver lot can never be filed as gold or the reverse. Omitted
// is fine - the master decides.
export async function addMetalStockEntry(input: Record<string, unknown>, companyId: string, userId: string) {
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || v.trim() === '') throw new AppError(`${name} is required`, 400);
    return v.trim();
  };
  const num = (v: unknown, name: string, { min = 0, allowZero = true }: { min?: number; allowZero?: boolean } = {}) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < min || (!allowZero && n === min)) throw new AppError(`${name} must be a valid number`, 400);
    return n;
  };

  const karat = text(input.karat, 'Karat');
  const stated = parseVaultMetal(input.metalType, 'metalType');
  const master = await tenantQuery(companyId, (tx) =>
    tx.karatMaster.findFirst({ where: { companyId, code: karat, isActive: true }, select: { metalType: true, purity: true } }));
  if (!master) throw new AppError(`Karat "${karat}" is not an active karat in the Karat master`, 400);
  if (master.metalType !== 'GOLD' && master.metalType !== 'SILVER') {
    throw new AppError(`${karat} is a ${String(master.metalType).toLowerCase()} karat - the Metal Vault holds gold and silver only`, 400);
  }
  const metalType: VaultMetal = master.metalType;
  if (stated && stated !== metalType) {
    throw new AppError(`${karat} is a ${metalType.toLowerCase()} karat in the Karat master, but the stock was entered as ${stated.toLowerCase()}`, 400);
  }

  const grossWeight = num(input.grossWeight, 'Gross weight', { allowZero: false });
  const netWeight = num(input.netWeight, 'Net weight', { allowZero: false });
  if (netWeight > grossWeight) throw new AppError('Net weight cannot exceed gross weight', 400);
  return addMetalStock({
    materialName: text(input.materialName, 'Material description'),
    karat,
    purity: input.purity === undefined || input.purity === null || input.purity === '' ? Number(master.purity) : num(input.purity, 'Purity', { min: 0, allowZero: false }),
    grossWeight, netWeight,
    ...(input.location !== undefined && input.location !== null && input.location !== '' && { location: text(input.location, 'Location') }),
    metalType,
    sourceType: text(input.sourceType, 'Source type'),
    ...(input.sourceRef !== undefined && input.sourceRef !== null && input.sourceRef !== '' && { sourceRef: text(input.sourceRef, 'Source reference') }),
    avgCostPerGram: num(input.avgCostPerGram ?? 0, 'Cost per gram'),
  }, companyId, userId);
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
