import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertBranchAccessible, assertOwnedByCompany } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction, canAccessBranch } from '../../shared/tenantContext';
import { PROVIDER_CATEGORIES, PROVIDER_METHODS, TERMINAL_METHODS } from '../../shared/paymentMetadata';

// Payment Configuration management: the provider master, which providers a branch collects through, and POS terminals.
// Pure master data - it feeds selection and reconciliation on a payment leg and is never a second accounting source.
// No credential of any kind is stored (no PIN/OTP/CVV/card data/API secret/account number), and a provider or terminal
// that was ever used is deactivated, never deleted (payment legs also snapshot their own copy of the identifiers).

type Methods = readonly string[];

function str(v: unknown, label: string, { max = 80, required = false }: { max?: number; required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AppError(`${label} is required`, 400);
    return undefined;
  }
  if (typeof v !== 'string') throw new AppError(`${label} must be text`, 400);
  const t = v.trim();
  if (!t) {
    if (required) throw new AppError(`${label} is required`, 400);
    return undefined;
  }
  if (t.length > max) throw new AppError(`${label} must be at most ${max} characters`, 400);
  return t;
}

function methods(v: unknown, allowed: Methods, label: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new AppError(`${label}: choose at least one payment method`, 400);
  const out = [...new Set(v.map((m) => (typeof m === 'string' ? m.trim().toUpperCase() : '')))];
  for (const m of out) if (!allowed.includes(m)) throw new AppError(`${label}: ${m || 'blank'} is not allowed (use ${allowed.join(', ')})`, 400);
  return out;
}

function bool(v: unknown, label: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new AppError(`${label} must be true or false`, 400);
  return v;
}

// A merchant reference / TID / MID is an identifier, not a secret - but anything that looks like a card number or a
// password field name is refused so nobody parks a credential here by habit.
function assertIdentifier(v: string, label: string) {
  if (!/^[A-Za-z0-9@._\-/ ]+$/.test(v)) throw new AppError(`${label} may only contain letters, digits and . _ - / @`, 400);
}

const branchScope = (ctx: TenantContext) => (ctx.branchAccess.allBranches ? {} : { branchId: { in: ctx.branchAccess.branchIds } });

// ─── Providers ────────────────────────────────────────────────────────────────

const providerSelect = {
  id: true, name: true, shortCode: true, category: true, supportedMethods: true, merchantRef: true,
  isActive: true, createdAt: true, updatedAt: true,
} satisfies Prisma.PaymentProviderSelect;

export async function listProviders(ctx: TenantContext, f: { q?: string; active?: boolean } = {}) {
  return tenantQuery(ctx.companyId, (tx) => tx.paymentProvider.findMany({
    where: {
      companyId: ctx.companyId,
      ...(f.active !== undefined && { isActive: f.active }),
      ...(f.q && { OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { shortCode: { contains: f.q, mode: 'insensitive' } }] }),
    },
    select: providerSelect, orderBy: { name: 'asc' },
  }));
}

type ProviderInput = { name?: unknown; shortCode?: unknown; category?: unknown; supportedMethods?: unknown; merchantRef?: unknown; isActive?: unknown };

function parseProvider(d: ProviderInput, partial: boolean) {
  const out: Prisma.PaymentProviderUncheckedUpdateInput = {};
  if (!partial || d.name !== undefined) out.name = str(d.name, 'Name', { required: true });
  if (d.shortCode !== undefined) { const v = str(d.shortCode, 'Short code', { max: 20 }); if (v) assertIdentifier(v, 'Short code'); out.shortCode = v ?? null; }
  if (!partial || d.category !== undefined) {
    const c = typeof d.category === 'string' ? d.category.trim().toUpperCase() : '';
    if (!(PROVIDER_CATEGORIES as readonly string[]).includes(c)) throw new AppError(`Category must be one of ${PROVIDER_CATEGORIES.join(', ')}`, 400);
    out.category = c;
  }
  if (!partial || d.supportedMethods !== undefined) out.supportedMethods = methods(d.supportedMethods, PROVIDER_METHODS, 'Supported methods');
  if (d.merchantRef !== undefined) { const v = str(d.merchantRef, 'Merchant reference', { max: 80 }); if (v) assertIdentifier(v, 'Merchant reference'); out.merchantRef = v ?? null; }
  const active = bool(d.isActive, 'isActive');
  if (active !== undefined) out.isActive = active;
  return out;
}

const dupProvider = (e: unknown) => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    // Postgres omits key details on RLS tables, so the clash is never read off meta.target.
    throw new AppError('A provider with that name or short code already exists', 409);
  }
  throw e;
};

export async function createProvider(ctx: TenantContext, d: ProviderInput) {
  const data = parseProvider(d, false) as { name: string; category: string; supportedMethods: string[] } & Prisma.PaymentProviderUncheckedUpdateInput;
  const row = await tenantTransaction(ctx.companyId, (tx) =>
    tx.paymentProvider.create({ data: { ...(data as object), companyId: ctx.companyId } as Prisma.PaymentProviderUncheckedCreateInput, select: providerSelect }),
  ).catch(dupProvider);
  await createAuditEntry('payment_providers', row.id, ctx.userId, 'CREATE', undefined, row as unknown as Record<string, unknown>, ctx.companyId);
  return row;
}

export async function updateProvider(ctx: TenantContext, id: string, d: ProviderInput) {
  await assertOwnedByCompany('paymentProvider', id, ctx.companyId, 'Provider');
  const data = parseProvider(d, true);
  if (Object.keys(data).length === 0) throw new AppError('Nothing to update', 400);
  const { before, after } = await tenantTransaction(ctx.companyId, async (tx) => {
    const b = await tx.paymentProvider.findUniqueOrThrow({ where: { id }, select: providerSelect });
    const a = await tx.paymentProvider.update({ where: { id }, data, select: providerSelect });
    return { before: b, after: a };
  }).catch(dupProvider);
  const action = after.isActive !== before.isActive ? (after.isActive ? 'REACTIVATE' : 'DEACTIVATE') : 'EDIT';
  await createAuditEntry('payment_providers', id, ctx.userId, action, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ctx.companyId);
  return after;
}

// ─── Branch ↔ provider allocation ────────────────────────────────────────────

export async function listBranchProviders(ctx: TenantContext, branchId?: string) {
  if (branchId) await assertBranchAccessible(branchId, ctx);
  return tenantQuery(ctx.companyId, (tx) => tx.branchPaymentProvider.findMany({
    where: { companyId: ctx.companyId, ...(branchId ? { branchId } : branchScope(ctx)) },
    select: { id: true, branchId: true, providerId: true, isActive: true, createdAt: true, provider: { select: { name: true, shortCode: true, isActive: true } } },
    orderBy: [{ branchId: 'asc' }, { createdAt: 'asc' }],
  }));
}

/** Allocates a provider to a branch (or re-enables an earlier allocation). Idempotent. */
export async function allocateProvider(ctx: TenantContext, branchId: string, providerId: string) {
  await assertBranchAccessible(branchId, ctx);
  await assertOwnedByCompany('paymentProvider', providerId, ctx.companyId, 'Provider');
  const { row, changed } = await tenantTransaction(ctx.companyId, async (tx) => {
    const existing = await tx.branchPaymentProvider.findFirst({ where: { companyId: ctx.companyId, branchId, providerId } });
    if (existing?.isActive) return { row: existing, changed: false };
    if (existing) return { row: await tx.branchPaymentProvider.update({ where: { id: existing.id }, data: { isActive: true } }), changed: true };
    return { row: await tx.branchPaymentProvider.create({ data: { companyId: ctx.companyId, branchId, providerId } }), changed: true };
  });
  // An idempotent repeat changes nothing, so it writes no audit entry either.
  if (changed) await createAuditEntry('branch_payment_providers', row.id, ctx.userId, 'ALLOCATE', undefined, { branchId, providerId }, ctx.companyId);
  return row;
}

/** Removes a provider from a branch. Past payments are untouched - they carry their own provider snapshot. */
export async function removeAllocation(ctx: TenantContext, branchId: string, providerId: string) {
  await assertBranchAccessible(branchId, ctx);
  await assertOwnedByCompany('paymentProvider', providerId, ctx.companyId, 'Provider');
  const removed = await tenantTransaction(ctx.companyId, async (tx) => {
    const existing = await tx.branchPaymentProvider.findFirst({ where: { companyId: ctx.companyId, branchId, providerId } });
    if (!existing) throw new AppError('That provider is not allocated to this branch', 404);
    await tx.branchPaymentProvider.delete({ where: { id: existing.id } });
    return existing;
  });
  await createAuditEntry('branch_payment_providers', removed.id, ctx.userId, 'REMOVE', { branchId, providerId, isActive: removed.isActive }, undefined, ctx.companyId);
}

// ─── POS terminals ────────────────────────────────────────────────────────────

const terminalSelect = {
  id: true, code: true, name: true, providerId: true, tid: true, mid: true, supportedMethods: true, branchId: true,
  isActive: true, createdAt: true, updatedAt: true,
  provider: { select: { name: true, isActive: true } }, branch: { select: { name: true, branchCode: true } },
} satisfies Prisma.PosTerminalSelect;

export async function listTerminals(ctx: TenantContext, f: { branchId?: string; providerId?: string; active?: boolean; q?: string } = {}) {
  if (f.branchId) await assertBranchAccessible(f.branchId, ctx);
  return tenantQuery(ctx.companyId, (tx) => tx.posTerminal.findMany({
    where: {
      companyId: ctx.companyId,
      // A restricted user only ever sees terminals of the branches they are granted.
      ...(f.branchId ? { branchId: f.branchId } : branchScope(ctx)),
      ...(f.providerId && { providerId: f.providerId }),
      ...(f.active !== undefined && { isActive: f.active }),
      ...(f.q && { OR: [{ code: { contains: f.q, mode: 'insensitive' } }, { name: { contains: f.q, mode: 'insensitive' } }, { tid: { contains: f.q, mode: 'insensitive' } }] }),
    },
    select: terminalSelect, orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
  }));
}

type TerminalInput = { code?: unknown; name?: unknown; providerId?: unknown; tid?: unknown; mid?: unknown; supportedMethods?: unknown; branchId?: unknown; isActive?: unknown };

function parseTerminal(d: TerminalInput, partial: boolean) {
  const out: Prisma.PosTerminalUncheckedUpdateInput = {};
  if (!partial || d.code !== undefined) { const v = str(d.code, 'Terminal code', { max: 30, required: true })!; assertIdentifier(v, 'Terminal code'); out.code = v; }
  if (!partial || d.name !== undefined) out.name = str(d.name, 'Terminal name', { required: true });
  if (!partial || d.tid !== undefined) { const v = str(d.tid, 'TID', { max: 30, required: true })!; assertIdentifier(v, 'TID'); out.tid = v; }
  if (d.mid !== undefined) { const v = str(d.mid, 'MID', { max: 30 }); if (v) assertIdentifier(v, 'MID'); out.mid = v ?? null; }
  if (!partial || d.supportedMethods !== undefined) out.supportedMethods = methods(d.supportedMethods, TERMINAL_METHODS, 'Supported methods');
  for (const k of ['providerId', 'branchId'] as const) {
    if (!partial || d[k] !== undefined) {
      if (typeof d[k] !== 'string' || !d[k]) throw new AppError(`${k} is required`, 400);
      out[k] = d[k] as string;
    }
  }
  const active = bool(d.isActive, 'isActive');
  if (active !== undefined) out.isActive = active;
  return out;
}

const tidClash = (e: unknown) => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new AppError('A terminal with that code, or with that TID for the same provider and MID, already exists', 409);
  }
  throw e;
};

export async function createTerminal(ctx: TenantContext, d: TerminalInput) {
  const data = parseTerminal(d, false) as Record<string, any>;
  await assertBranchAccessible(data.branchId, ctx);
  await assertOwnedByCompany('paymentProvider', data.providerId, ctx.companyId, 'Provider');
  const row = await tenantTransaction(ctx.companyId, async (tx) => {
    const p = await tx.paymentProvider.findUniqueOrThrow({ where: { id: data.providerId } });
    if (!p.isActive) throw new AppError(`${p.name} is inactive`, 409);
    return tx.posTerminal.create({ data: { ...data, companyId: ctx.companyId } as Prisma.PosTerminalUncheckedCreateInput, select: terminalSelect });
  }).catch(tidClash);
  await createAuditEntry('pos_terminals', row.id, ctx.userId, 'CREATE', undefined, snapshot(row), ctx.companyId);
  return row;
}

const snapshot = (r: { code: string; name: string; providerId: string; tid: string; mid: string | null; supportedMethods: string[]; branchId: string; isActive: boolean }) => ({
  code: r.code, name: r.name, providerId: r.providerId, tid: r.tid, mid: r.mid, supportedMethods: r.supportedMethods, branchId: r.branchId, isActive: r.isActive,
});

export async function updateTerminal(ctx: TenantContext, id: string, d: TerminalInput) {
  await assertOwnedByCompany('posTerminal', id, ctx.companyId, 'POS terminal');
  const data = parseTerminal(d, true) as Record<string, any>;
  if (Object.keys(data).length === 0) throw new AppError('Nothing to update', 400);
  // Moving a terminal needs access to BOTH ends: it leaves one branch's counter and arrives at another's.
  if (data.branchId) await assertBranchAccessible(data.branchId, ctx);
  if (data.providerId) await assertOwnedByCompany('paymentProvider', data.providerId, ctx.companyId, 'Provider');
  const { before, after } = await tenantTransaction(ctx.companyId, async (tx) => {
    const b = await tx.posTerminal.findUniqueOrThrow({ where: { id }, select: terminalSelect });
    if (!canAccessBranch(ctx, b.branchId)) throw new AppError('POS terminal not found', 404);
    if (data.providerId && data.providerId !== b.providerId) {
      const p = await tx.paymentProvider.findUniqueOrThrow({ where: { id: data.providerId } });
      if (!p.isActive) throw new AppError(`${p.name} is inactive`, 409);
    }
    // Past payment legs hold their own snapshot of code/TID/MID/provider, so none of this rewrites history.
    const a = await tx.posTerminal.update({ where: { id }, data, select: terminalSelect });
    return { before: b, after: a };
  }).catch(tidClash);
  const action = after.branchId !== before.branchId ? 'REASSIGN'
    : after.isActive !== before.isActive ? (after.isActive ? 'REACTIVATE' : 'DEACTIVATE')
      : 'EDIT';
  await createAuditEntry('pos_terminals', id, ctx.userId, action, snapshot(before), snapshot(after), ctx.companyId);
  return after;
}

// ─── What a collection screen may offer ──────────────────────────────────────

/**
 * The active providers and terminals usable for a payment at ONE branch the caller is allowed in. The server re-checks
 * every chosen id when the payment is saved (resolvePaymentLegMeta) - this list only drives the dropdowns.
 */
export async function getCollectionOptions(ctx: TenantContext, branchId: string) {
  if (typeof branchId !== 'string' || !branchId) throw new AppError('branchId is required', 400);
  await assertBranchAccessible(branchId, ctx);
  return tenantTransaction(ctx.companyId, async (tx) => {
    const [links, terminals] = await Promise.all([
      tx.branchPaymentProvider.findMany({
        where: { companyId: ctx.companyId, branchId, isActive: true, provider: { isActive: true } },
        select: { provider: { select: { id: true, name: true, shortCode: true, category: true, supportedMethods: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      tx.posTerminal.findMany({
        where: { companyId: ctx.companyId, branchId, isActive: true, provider: { isActive: true } },
        select: { id: true, code: true, name: true, tid: true, mid: true, supportedMethods: true, providerId: true, provider: { select: { name: true } } },
        orderBy: { code: 'asc' },
      }),
    ]);
    const providers = links.map((l) => l.provider).sort((a, b) => a.name.localeCompare(b.name));
    return {
      branchId,
      providers,
      terminals: terminals.map((t) => ({ id: t.id, code: t.code, name: t.name, tid: t.tid, mid: t.mid, supportedMethods: t.supportedMethods, providerId: t.providerId, providerName: t.provider.name })),
      // The same switches resolvePaymentLegMeta applies on save, so the UI can mark the field required up front.
      requireTerminalForCard: terminals.some((t) => t.supportedMethods.includes('CARD')),
      requireProviderForBankTransfer: providers.some((p) => p.supportedMethods.includes('BANK_TRANSFER')),
      requireProviderForUpi: providers.some((p) => p.supportedMethods.includes('UPI')),
    };
  });
}
