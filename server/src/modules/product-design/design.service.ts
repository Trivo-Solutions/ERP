import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { nextSimpleCode } from '../../shared/numberSequence';
import { nextDocumentNumber } from '../../shared/numberSequence';
import { TenantContext, tenantTransaction, tenantQuery, tenantBatch } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';

export async function listDesigns(companyId: string, filters: {
  status?: string; categoryId?: string; search?: string;
  page?: number; limit?: number;
}) {
  const { status, categoryId, search, page = 1, limit = 20 } = filters;
  const where: Prisma.DesignWhereInput = {
    companyId,
    ...(status && { status }),
    ...(categoryId && { categoryId }),
    ...(search && {
      OR: [
        { designCode: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [designs, total] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.design.findMany({
      where,
      include: {
        category: true,
        _count: { select: { designFiles: true, bomItems: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    })),
    tenantQuery(companyId, (_tx) => _tx.design.count({ where })),
  ]);

  return { designs, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getDesignById(companyId: string, id: string) {
  const design = await tenantQuery(companyId, (_tx) => _tx.design.findUnique({
    where: { id },
    include: {
      category: true,
      designFiles: { where: { isActive: true } },
      bomItems: { orderBy: { sequence: 'asc' } },
      bomProcesses: { orderBy: { sequence: 'asc' } },
      costEstimates: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  }));
  if (!design || design.companyId !== companyId) throw new AppError('Design not found', 404);
  return design;
}

export async function createDesign(data: {
  designCode?: string; name: string; categoryId: string; metalKarat: string;
  grossWeightMin: number; grossWeightMax: number; netWeightMin: number; netWeightMax: number;
  description?: string;
}, companyId: string, userId: string) {
  // Layer 2: DesignCategory is company-owned — a Company-B categoryId must 404, not attach.
  await assertOwnedByCompany('designCategory', data.categoryId, companyId, 'Design category');
  const design = await tenantTransaction(companyId, async (tx) => {
    const code = data.designCode ?? await generateDesignCode(companyId, data.categoryId, tx);
    return tx.design.create({
      data: { ...data, companyId, designCode: code },
      include: { category: true },
    });
  });
  await createAuditEntry('designs', design.id, userId, 'CREATE', undefined, design as any, companyId);
  return design;
}

export async function updateDesign(
  id: string,
  data: Partial<{ name: string; metalKarat: string; status: string; description: string;
    grossWeightMin: number; grossWeightMax: number; netWeightMin: number; netWeightMax: number; }>,
  companyId: string, userId: string
) {
  await assertOwnedByCompany('design', id, companyId, 'Design');
  const existing = await tenantQuery(companyId, (_tx) => _tx.design.findUniqueOrThrow({ where: { id } }));
  const updated = await tenantQuery(companyId, (_tx) => _tx.design.update({
    where: { id },
    data: { ...data, version: { increment: 1 } },
    include: { category: true },
  }));
  await createAuditEntry('designs', id, userId, 'UPDATE', existing as any, updated as any, companyId);
  return updated;
}

export async function saveBom(
  designId: string,
  items: Array<{ materialType: string; materialCode: string; materialName: string;
    quantity: number; unit: string; karat?: string; quality?: string;
    sieveSize?: string; wastagePercent?: number; sequence?: number; }>,
  processes: Array<{ processName: string; sequence: number; makingChargeType: string;
    makingChargeValue: number; wastagePercent?: number; estimatedMinutes?: number;
    isOutsourced?: boolean; }>,
  companyId: string, userId: string
) {
  await assertOwnedByCompany('design', designId, companyId, 'Design');
  await tenantBatch(companyId, (tx) => [
    tx.bomItem.deleteMany({ where: { designId, companyId } }),
    tx.bomProcess.deleteMany({ where: { designId, companyId } }),
    tx.bomItem.createMany({ data: items.map((i) => ({ ...i, companyId, designId })) }),
    tx.bomProcess.createMany({ data: processes.map((p) => ({ ...p, companyId, designId })) }),
  ]);
  await createAuditEntry('bom', designId, userId, 'UPDATE', undefined, undefined, companyId);
}

export async function generateCostEstimate(designId: string, ctx: TenantContext, currency = 'INR') {
  await assertOwnedByCompany('design', designId, ctx.companyId, 'Design');
  const design = await tenantQuery(ctx.companyId, (_tx) => _tx.design.findUniqueOrThrow({
    where: { id: designId },
    include: { bomItems: true, bomProcesses: { orderBy: { sequence: 'asc' } } },
  }));

  const rate = await tenantQuery(ctx.companyId, (_tx) => _tx.metalRate.findFirst({
    where: { companyId: ctx.companyId, karat: design.metalKarat, currency },
    orderBy: { date: 'desc' },
  }));

  if (!rate) throw new AppError(`No metal rate found for ${design.metalKarat}`, 404);

  // Prisma Decimal.valueOf() returns the string representation, so arithmetic via + concatenates
  // instead of adding. Explicitly convert to JS number before any arithmetic.
  const avgNetWeight = (Number(design.netWeightMin) + Number(design.netWeightMax)) / 2;
  const metalCost = avgNetWeight * Number(rate.ratePerGram);

  let stoneCost = 0;
  // Stone costs are pulled from stone lot average costs when lots are linked to the BOM
  for (const item of design.bomItems) {
    if (item.materialType !== 'METAL') stoneCost += 0;
  }

  let makingCharges = 0;
  let wastageAmount = 0;
  for (const proc of design.bomProcesses) {
    const chargeValue = Number(proc.makingChargeValue);
    if (proc.makingChargeType === 'PER_GRAM') {
      makingCharges += chargeValue * avgNetWeight;
    } else {
      makingCharges += chargeValue;
    }
    wastageAmount += metalCost * (Number(proc.wastagePercent) / 100);
  }

  const totalCost = metalCost + stoneCost + makingCharges + wastageAmount;
  const marginPercent = 15;
  const sellingPrice = totalCost * (1 + marginPercent / 100);

  const estimate = await tenantTransaction(ctx.companyId, async (tx) => {
    const estimateNumber = await nextDocumentNumber(ctx.companyId, 'EST', 'EST', tx);
    return tx.costEstimate.create({
      data: {
        companyId: ctx.companyId,
        designId,
        estimateNumber,
        metalSpotRate: rate.ratePerGram,
        metalCost: Number(metalCost.toFixed(2)),
        stoneCost: Number(stoneCost.toFixed(2)),
        makingCharges: Number(makingCharges.toFixed(2)),
        wastageAmount: Number(wastageAmount.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        marginPercent,
        sellingPrice: Number(sellingPrice.toFixed(2)),
        currency,
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  });

  return estimate;
}

async function generateDesignCode(companyId: string, categoryId: string, tx: Prisma.TransactionClient): Promise<string> {
  const cat = await tx.designCategory.findFirstOrThrow({ where: { id: categoryId, companyId } });
  return nextSimpleCode(companyId, `DESIGN:${cat.code}`, cat.code, 4, tx);
}

// companyId required (Phase 3) — MetalRate is each company's own quoted rate (see the schema's
// own comment on why this isn't a shared market feed). This endpoint is the LIVE daily-rate
// entry point (mounted at /design/rates for historical reasons, but resolveMetalRate — used by
// createInvoice/createTagFromGrnItem/createOldGoldExchange — is not dormant).
export async function upsertMetalRate(companyId: string, data: {
  date: Date; karat: string; ratePerGram: number; currency?: string; source?: string;
}) {
  const purity: Record<string, number> = {
    '24K': 0.9999, '22K': 0.916, '18K': 0.75, '14K': 0.585, 'SILVER': 0.925, 'PT': 0.95,
  };
  return tenantQuery(companyId, (_tx) => _tx.metalRate.upsert({
    where: {
      companyId_date_karat_currency: {
        companyId, date: data.date, karat: data.karat, currency: data.currency ?? 'INR',
      },
    },
    create: { ...data, companyId, currency: data.currency ?? 'INR', purity: purity[data.karat] ?? 0.75 },
    update: { ratePerGram: data.ratePerGram, source: data.source },
  }));
}

// ─── Daily rate sheet (one date, every purity) ───────────────────────────────

const RATE_CURRENCY = 'INR';

/**
 * Every active karat/purity of the company with the rate saved for EXACTLY `date` (null when none yet),
 * plus the most recent earlier rate as a hint for typing a new one. Reads the same MetalRate rows the
 * single-rate POST /rates writes — no separate storage; a different date is never touched.
 */
export async function getRateSheet(companyId: string, date: Date) {
  return tenantTransaction(companyId, async (tx) => {
    const [karats, onDate, earlier] = await Promise.all([
      tx.karatMaster.findMany({ where: { companyId, isActive: true }, orderBy: [{ metalType: 'asc' }, { purity: 'desc' }] }),
      tx.metalRate.findMany({ where: { companyId, date, currency: RATE_CURRENCY } }),
      tx.metalRate.findMany({
        where: { companyId, date: { lt: date }, currency: RATE_CURRENCY },
        orderBy: { date: 'desc' },
      }),
    ]);
    const byKarat = new Map(onDate.map((r) => [r.karat, r]));
    const prevByKarat = new Map<string, (typeof earlier)[number]>();
    for (const r of earlier) if (!prevByKarat.has(r.karat)) prevByKarat.set(r.karat, r);
    return karats.map((k) => {
      const r = byKarat.get(k.code);
      const prev = prevByKarat.get(k.code);
      return {
        karat: k.code,
        metalType: k.metalType,
        purity: k.purity,
        ratePerGram: r ? r.ratePerGram : null,
        source: r?.source ?? null,
        previousRate: prev ? prev.ratePerGram : null,
        previousDate: prev ? prev.date : null,
      };
    });
  });
}

/**
 * Saves several purities' rates for one date in a single transaction (all-or-nothing). Each row is the
 * same (company, date, karat, currency) upsert upsertMetalRate does, so re-saving a date edits it and
 * no other date changes. Karats must be this company's own active karats (the purity comes from there).
 */
export async function saveRateSheet(companyId: string, date: Date, rates: Array<{ karat: string; ratePerGram: number }>, source?: string) {
  if (!Array.isArray(rates) || rates.length === 0) throw new AppError('No rates to save', 400);
  const seen = new Set<string>();
  for (const r of rates) {
    if (typeof r?.karat !== 'string' || !r.karat) throw new AppError('Karat is required', 400);
    if (seen.has(r.karat)) throw new AppError(`Duplicate karat ${r.karat}`, 400);
    seen.add(r.karat);
    if (typeof r.ratePerGram !== 'number' || !Number.isFinite(r.ratePerGram) || r.ratePerGram <= 0) {
      throw new AppError(`Rate for ${r.karat} must be a number greater than 0`, 400);
    }
  }
  return tenantTransaction(companyId, async (tx) => {
    const karats = await tx.karatMaster.findMany({ where: { companyId, code: { in: [...seen] }, isActive: true } });
    const purityByCode = new Map(karats.map((k) => [k.code, k.purity]));
    for (const code of seen) if (!purityByCode.has(code)) throw new AppError(`Unknown karat/purity code: ${code}`, 400);
    const saved = [];
    for (const r of rates) {
      saved.push(await tx.metalRate.upsert({
        where: { companyId_date_karat_currency: { companyId, date, karat: r.karat, currency: RATE_CURRENCY } },
        create: { companyId, date, karat: r.karat, currency: RATE_CURRENCY, ratePerGram: r.ratePerGram, purity: purityByCode.get(r.karat)!, source },
        update: { ratePerGram: r.ratePerGram, source },
      }));
    }
    return saved;
  });
}
