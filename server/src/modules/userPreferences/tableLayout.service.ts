import { AppError } from '../../middleware/error';
import { TenantContext, tenantQuery } from '../../shared/tenantContext';

// A member's saved column layout per data table. Strictly personal: every read and write is keyed by the caller's OWN
// membership (ctx.companyUserId, from the verified token) inside their company - no id of another user, company or
// layout is ever accepted from the request, so there is nothing to forge. RLS and the composite FK back this up.

export interface TableLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

const TABLE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_COLUMNS = 200;
const MAX_TABLES_PER_USER = 300;
const MIN_WIDTH = 20;
const MAX_WIDTH = 4000;

function assertTableId(tableId: unknown): string {
  if (typeof tableId !== 'string' || !TABLE_ID.test(tableId)) throw new AppError('Invalid table id', 400);
  return tableId;
}

function keyList(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_COLUMNS) throw new AppError(`layout.${label} must be a list of at most ${MAX_COLUMNS} column keys`, 400);
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== 'string' || !k || k.length > 120) throw new AppError(`layout.${label} holds an invalid column key`, 400);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// Whitelists the shape: anything else in the body is dropped, never stored.
export function parseLayout(raw: unknown): TableLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('layout is required', 400);
  const l = raw as Record<string, unknown>;
  const order = keyList(l.order ?? [], 'order');
  const hidden = keyList(l.hidden ?? [], 'hidden');
  const widthsIn = l.widths ?? {};
  if (typeof widthsIn !== 'object' || Array.isArray(widthsIn) || widthsIn === null) throw new AppError('layout.widths must be an object', 400);
  const entries = Object.entries(widthsIn as Record<string, unknown>);
  if (entries.length > MAX_COLUMNS) throw new AppError('layout.widths has too many columns', 400);
  const widths: Record<string, number> = {};
  for (const [k, w] of entries) {
    if (!k || k.length > 120 || typeof w !== 'number' || !Number.isFinite(w)) throw new AppError('layout.widths holds an invalid entry', 400);
    widths[k] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
  }
  return { order, hidden, widths };
}

/** Every layout the caller has saved in this company, keyed by table id. */
export async function listMyLayouts(ctx: TenantContext): Promise<Record<string, TableLayout>> {
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.userTableLayout.findMany({
    where: { companyId: ctx.companyId, companyUserId: ctx.companyUserId },
    select: { tableId: true, layout: true },
  }));
  const out: Record<string, TableLayout> = {};
  for (const r of rows) out[r.tableId] = r.layout as unknown as TableLayout;
  return out;
}

export async function saveMyLayout(ctx: TenantContext, tableIdIn: unknown, layoutIn: unknown): Promise<TableLayout> {
  const tableId = assertTableId(tableIdIn);
  const layout = parseLayout(layoutIn);
  const key = { companyUserId_tableId: { companyUserId: ctx.companyUserId, tableId } };
  const existing = await tenantQuery(ctx.companyId, (tx) => tx.userTableLayout.findUnique({ where: key, select: { id: true } }));
  if (!existing) {
    const count = await tenantQuery(ctx.companyId, (tx) => tx.userTableLayout.count({ where: { companyId: ctx.companyId, companyUserId: ctx.companyUserId } }));
    if (count >= MAX_TABLES_PER_USER) throw new AppError('Too many saved table layouts', 400);
  }
  await tenantQuery(ctx.companyId, (tx) => tx.userTableLayout.upsert({
    where: key,
    create: { companyId: ctx.companyId, companyUserId: ctx.companyUserId, tableId, layout: layout as any },
    update: { layout: layout as any },
  }));
  return layout;
}

/** Forgets the caller's saved layout for one table (back to the page defaults). Idempotent. */
export async function resetMyLayout(ctx: TenantContext, tableIdIn: unknown): Promise<void> {
  const tableId = assertTableId(tableIdIn);
  await tenantQuery(ctx.companyId, (tx) => tx.userTableLayout.deleteMany({
    where: { companyId: ctx.companyId, companyUserId: ctx.companyUserId, tableId },
  }));
}
