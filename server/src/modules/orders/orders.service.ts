import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { nextSimpleCode, nextDocumentNumber } from '../../shared/numberSequence';
import { createAuditEntry } from '../../middleware/audit';
import { TenantContext, tenantTransaction, tenantQuery, tenantBatch } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { normalizePan } from '../../shared/compliance';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';

export async function listOrders(companyId: string, filters: {
  status?: string; clientId?: string; priority?: string;
  page?: number; limit?: number;
}) {
  const { status, clientId, priority, page = 1, limit = 20 } = filters;
  const where = {
    companyId,
    ...(status && { status }),
    ...(clientId && { clientId }),
    ...(priority && { priority }),
  };
  const [orders, total] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.salesOrder.findMany({
      where,
      include: {
        client: { select: { name: true, clientCode: true, phone: true } },
        orderItems: { include: { design: { select: { name: true, designCode: true } } } },
        _count: { select: { jobCards: true } },
      },
      orderBy: [{ priority: 'asc' }, { orderDate: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    })),
    tenantQuery(companyId, (_tx) => _tx.salesOrder.count({ where })),
  ]);
  return { orders, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getOrder(companyId: string, id: string) {
  const order = await tenantQuery(companyId, (_tx) => _tx.salesOrder.findUnique({
    where: { id },
    include: {
      client: true,
      orderItems: { include: { design: { include: { bomItems: true, bomProcesses: true } } } },
      reservations: { include: { metalStock: true, stoneLot: true } },
      jobCards: { include: { processes: true } },
      notifications: { orderBy: { sentAt: 'desc' }, take: 10 },
    },
  }));
  if (!order || order.companyId !== companyId) throw new AppError('Order not found', 404);
  return order;
}

export async function createOrder(data: {
  clientId: string; orderDate: Date; deliveryDate?: Date; priority?: string;
  specialInstructions?: string; advanceAmount?: number; advanceType?: string; advanceRef?: string;
  items: Array<{ designId: string; quantity: number; unitPrice: number; customizations?: any; referencePhoto?: string; }>;
}, ctx: TenantContext, userId: string) {
  // Layer 2: client and every referenced design must belong to this company.
  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  for (const item of data.items) {
    await assertOwnedByCompany('design', item.designId, ctx.companyId, 'Design');
  }

  const items = data.items.map((i) => ({ ...i, companyId: ctx.companyId, totalPrice: i.quantity * i.unitPrice }));
  const totalEstimated = items.reduce((s, i) => s + i.totalPrice, 0);

  const order = await tenantTransaction(ctx.companyId, async (tx) => {
    const orderNumber = await nextDocumentNumber(ctx.companyId, 'SO', 'SO', tx, data.orderDate.getFullYear());
    return tx.salesOrder.create({
      data: {
        companyId: ctx.companyId,
        orderNumber,
        clientId: data.clientId,
        orderDate: data.orderDate,
        deliveryDate: data.deliveryDate,
        priority: data.priority ?? 'NORMAL',
        specialInstructions: data.specialInstructions,
        advanceAmount: data.advanceAmount ?? 0,
        advanceType: data.advanceType,
        advanceRef: data.advanceRef,
        totalEstimated,
        orderItems: { createMany: { data: items } },
      },
      include: { client: true, orderItems: { include: { design: true } } },
    });
  });

  await createAuditEntry('sales_orders', order.id, userId, 'CREATE', undefined, undefined, ctx.companyId);

  // Trigger material reservation
  await autoReserveMaterials(order.id, ctx.companyId);

  return order;
}

async function autoReserveMaterials(orderId: string, companyId: string) {
  const order = await tenantQuery(companyId, (_tx) => _tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { orderItems: { include: { design: { include: { bomItems: true } } } } },
  }));

  for (const item of order.orderItems) {
    for (const bomItem of item.design.bomItems) {
      if (bomItem.materialType === 'METAL') {
        const required = Number(bomItem.quantity) * item.quantity;
        const stock = await tenantQuery(companyId, (_tx) => _tx.metalStock.findFirst({
          where: { companyId, karat: bomItem.karat ?? item.design.metalKarat, availableWt: { gte: required }, isActive: true },
          orderBy: { createdAt: 'asc' },
        }));

        if (stock) {
          await tenantBatch(companyId, (tx) => [
            tx.materialReservation.create({
              data: {
                companyId, orderId, reservationType: 'METAL', metalStockId: stock.id,
                reservedWeight: required, status: 'ACTIVE',
              },
            }),
            tx.metalStock.update({
              where: { id: stock.id },
              data: { availableWt: { decrement: required } },
            }),
          ]);
        }
      }
    }
  }
}

export async function updateOrderStatus(orderId: string, status: string, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('salesOrder', orderId, ctx.companyId, 'Order');
  const order = await tenantQuery(ctx.companyId, (_tx) => _tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId }, include: { client: true },
  }));

  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.salesOrder.update({
    where: { id: orderId }, data: { status },
  }));

  // Send client notification
  const milestones: Record<string, string> = {
    IN_PRODUCTION: 'Your order is now in production',
    QC_CHECK: 'Your order is undergoing quality inspection',
    READY: 'Your order is ready for delivery',
  };

  if (milestones[status] && order.client.phone) {
    await tenantQuery(ctx.companyId, (_tx) => _tx.clientNotification.create({
      data: {
        companyId: ctx.companyId,
        orderId, type: 'SMS', milestone: status,
        message: `Dear ${order.client.name}, ${milestones[status]}. Order: ${order.orderNumber}`,
        phone: order.client.phone, status: 'PENDING',
      },
    }));
  }

  await createAuditEntry('sales_orders', orderId, userId, 'UPDATE', { status: order.status } as any, { status } as any, ctx.companyId);
  return updated;
}

// companyId is always taken from the caller's authenticated tenant context (never a request
// parameter) — every Client row is company-owned (multi-tenant blueprint, Client row).
export async function listClients(companyId: string, search?: string) {
  return tenantQuery(companyId, (_tx) => _tx.client.findMany({
    where: {
      companyId,
      isActive: true,
      ...(search && { OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { clientCode: { contains: search, mode: 'insensitive' } },
      ]}),
    },
    orderBy: { name: 'asc' },
  }));
}

type ClientWritable = {
  name: string; type: string; gstNumber: string; panNumber: string | null; form60Received: boolean;
  address: string; city: string; district: string; state: string; pincode: string; phone: string;
  email: string; contactPerson: string; creditLimit: number; pricingTier: string;
  dateOfBirth: Date | null;
};
// J3 Decision 3 (B1): isActive is deliberately NOT writable through ordinary client:edit — toggling
// it is its own lifecycle action (client:deactivate — see setClientActive below), not a detail edit.
// A delegate trusted to fix a client's phone number is not automatically trusted to make that
// client un-billable.
const CLIENT_WRITABLE_KEYS: Array<keyof ClientWritable> = [
  'name', 'type', 'gstNumber', 'panNumber', 'form60Received', 'address', 'city', 'district', 'state',
  'pincode', 'phone', 'email', 'contactPerson', 'creditLimit', 'pricingTier',
  'dateOfBirth',
];

// Only the fields a person may edit by hand. currentBalance is moved by invoices/payments alone, never typed in.
function pickClientFields(body: Record<string, unknown>): Partial<ClientWritable> {
  const out: Record<string, unknown> = {};
  for (const k of CLIENT_WRITABLE_KEYS) if (body[k] !== undefined) out[k] = body[k];
  if ('panNumber' in out) out.panNumber = normalizePan(out.panNumber); // upper-cased, shape-checked; '' clears it
  if ('dateOfBirth' in out) { // 'YYYY-MM-DD'; '' / null clears it
    const raw = out.dateOfBirth as string | null;
    const d = raw ? new Date(`${String(raw).slice(0, 10)}T00:00:00.000Z`) : null;
    if (d && (Number.isNaN(d.getTime()) || d.getTime() > Date.now())) throw new AppError('Date of birth is not valid', 400);
    out.dateOfBirth = d;
  }
  return out as Partial<ClientWritable>;
}

export async function createClient(companyId: string, data: Partial<ClientWritable> & { name: string; type: string }) {
  const clientCode = await nextSimpleCode(companyId, 'CLIENT', 'CL', 5);
  const fields = pickClientFields(data);
  return tenantQuery(companyId, (_tx) => _tx.client.create({
    data: { ...fields, name: data.name, type: data.type, companyId, clientCode },
  }));
}

// Layer 2: the id is validated as belonging to companyId BEFORE the update runs — Postgres FK
// checks alone would not catch a Company-B client id here (RLS does not protect FK references),
// so this explicit ownership check is the actual defense, not a formality.
export async function updateClient(id: string, companyId: string, data: Partial<ClientWritable>) {
  const existing = await tenantQuery(companyId, (_tx) => _tx.client.findUnique({ where: { id }, select: { companyId: true } }));
  if (!existing || existing.companyId !== companyId) throw new AppError('Client not found', 404);
  return tenantQuery(companyId, (_tx) => _tx.client.update({ where: { id }, data: pickClientFields(data) }));
}

export async function getClient(id: string, companyId: string) {
  const client = await tenantQuery(companyId, (_tx) => _tx.client.findUnique({ where: { id } }));
  if (!client || client.companyId !== companyId) throw new AppError('Client not found', 404);
  return client;
}

// J3 Decision 3 (B1): deactivate/reactivate is its own action — separately permissioned
// (client:deactivate), separately audited, and fully reversible. It touches nothing else on the
// row. The protective half (an inactive client is rejected for a NEW sale/memo/payment) lives at
// the three call sites that start those transactions — see sales.service.ts.
export async function setClientActive(
  id: string, companyId: string, isActive: boolean, userId: string, reason: string | undefined,
) {
  const existing = await tenantQuery(companyId, (_tx) => _tx.client.findUnique({ where: { id } }));
  if (!existing || existing.companyId !== companyId) throw new AppError('Client not found', 404);
  if (existing.isActive === isActive) {
    throw new AppError(`${existing.name} is already ${isActive ? 'active' : 'inactive'}`, 409);
  }

  const updated = await tenantQuery(companyId, (_tx) => _tx.client.update({ where: { id }, data: { isActive } }));
  await createAuditEntry(
    'clients', id, userId, isActive ? 'REACTIVATE' : 'DEACTIVATE',
    { isActive: existing.isActive }, { isActive, reason: reason ?? null }, companyId,
  );
  return updated;
}

// J3 Decision 3: a real but narrow capability — permanent removal, only when the client has ZERO
// rows across every one of the eight dependent relations (PHASE_J3_DESIGN_AUDIT.md §6). The FK
// layer (every one of these relations is the Postgres default/RESTRICT, never CASCADE) already
// guarantees this at the database level even if this count check had a bug — this is defense in
// depth, not the only thing standing between a hard delete and an erased transaction history.
// Never cascades; never touches the dependent rows themselves.
export async function deleteClient(id: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to permanently delete a client', 400);

  const existing = await tenantQuery(ctx.companyId, (tx) => tx.client.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          salesOrders: true, memoOuts: true, salesInvoices: true, salesReturns: true,
          oldGoldExchanges: true, payments: true, repairJobs: true, manufacturedTags: true,
        },
      },
    },
  }));
  if (!existing || existing.companyId !== ctx.companyId) throw new AppError('Client not found', 404);

  const dependents = Object.entries(existing._count).filter(([, n]) => n > 0);
  if (dependents.length > 0) {
    throw new AppError(
      `Cannot permanently delete ${existing.name}: this client has transaction history (${dependents.map(([k, n]) => `${n} ${k}`).join(', ')}). Deactivate it instead.`,
      409,
    );
  }

  // J3.5 Finding 6: the dependency count-check above and this delete are two separate statements —
  // a dependent row created in that narrow window is still caught (the FK layer is the real backstop,
  // per the comment above), but it would otherwise surface as a raw, ungraceful 500. Translate it into
  // the same clean 409 the check above already gives for the non-racy case, matching the established
  // isBlockedByForeignKey convention (masters.router.ts, settings.service.ts) — never weakened, just
  // given a friendlier shape.
  try {
    await tenantTransaction(ctx.companyId, (tx) => tx.client.delete({ where: { id } }));
  } catch (err) {
    if (isBlockedByForeignKey(err)) {
      throw new AppError(`Cannot permanently delete ${existing.name}: a transaction was recorded against this client just now. Deactivate it instead.`, 409);
    }
    throw err;
  }
  await createAuditEntry(
    'clients', id, userId, 'FORCE_DELETE',
    { name: existing.name, clientCode: existing.clientCode, type: existing.type, isActive: existing.isActive, reason },
    undefined, ctx.companyId,
  );
  return { id, deleted: true };
}
