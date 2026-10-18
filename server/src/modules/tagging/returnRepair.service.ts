// Returned-jewellery pipeline: Sale Return -> Repair Transfer (branch -> Head Office) -> HO receipt -> inspection ->
// [repair -> final inspection] -> IN_STOCK | MELT_PENDING | retag.
//
// Design notes
//  - SalesReturn stays the *financial* record (sales.service.ts: createSalesReturn). Everything here is operational:
//    no function in this file posts a journal entry or touches Client.currentBalance, so a piece entering repair can
//    never double-credit a customer. The Metal Vault is not touched either — a melt is a separate, later transaction.
//  - The piece is always the SAME JewelryTag row. JewelryTag.status is what controls saleability (anything other
//    than IN_STOCK is invisible to selling/memo/transfer/audit code); RepairCase.status mirrors it through the
//    pipeline and RepairCase.currentLocation records physical custody separately. tag_history is written by the
//    database trigger on every tag change, so the lifecycle shows there without a second history mechanism.
//  - Every status change is a count-checked conditional updateMany ("WHERE status = <expected>") inside a
//    transaction, never a read-then-blind-write: a replayed or racing request finds the status already moved, matches
//    zero rows and fails with 409 — nothing is processed twice.
//  - "Head Office" is the company's Branch with isHeadOffice = true. Receiving / inspecting / repairing / retagging
//    require the caller to be granted that branch (and, at the router, the matching repair:* / retag:* permission),
//    so a branch-restricted user can send a piece but can never mark it received or inspected.
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { nextDocumentNumber, nextTagNumber } from '../../shared/numberSequence';
import {
  TenantContext, canAccessBranch, tenantQuery, tenantTransaction,
} from '../../shared/tenantContext';
import { assertBranchAccessible, assertOwnedByCompany } from '../../middleware/tenant';
import {
  REPAIR_STATUS, REPAIR_LOCATION,
  TAG_STATUS_RETURNED_PENDING_INSPECTION, TAG_STATUS_IN_TRANSIT_TO_HO, TAG_STATUS_HO_RECEIVED,
  TAG_STATUS_REPAIR_REQUIRED, TAG_STATUS_IN_REPAIR, TAG_STATUS_REPAIR_COMPLETED, TAG_STATUS_MELT_PENDING,
  TAG_STATUS_RETAGGED,
} from '../../shared/constants';

type Tx = Prisma.TransactionClient;

const OPEN_TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const needText = (v: unknown, label: string) => {
  const s = str(v);
  if (!s) throw new AppError(`${label} is required`, 400);
  return s;
};

// ─── Head Office ─────────────────────────────────────────────────────────────

/** The company's Head Office branch (where returned pieces are inspected/repaired/retagged). */
export async function getHeadOfficeBranch(ctx: TenantContext) {
  const ho = await tenantQuery(ctx.companyId, (tx) => tx.branch.findFirst({
    where: { companyId: ctx.companyId, isHeadOffice: true, isActive: true },
    orderBy: { createdAt: 'asc' },
  }));
  if (!ho) throw new AppError('No active Head Office branch is configured — mark one branch as Head Office first', 409);
  return ho;
}

/** HO-only action: the caller must be granted the company's Head Office branch. A branch-restricted user is refused. */
async function assertHeadOfficeUser(ctx: TenantContext, what: string) {
  const ho = await getHeadOfficeBranch(ctx);
  if (!canAccessBranch(ctx, ho.id)) throw new AppError(`Only Head Office users can ${what}`, 403);
  return ho;
}

// Who did it: users are global rows, so a name lookup needs no tenant context — but only ids that this company's own
// rows already carry are ever looked up.
async function userNames(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function assertCompanyMember(ctx: TenantContext, userId: string, label: string) {
  const m = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findFirst({ where: { companyId: ctx.companyId, userId }, select: { id: true } }));
  if (!m) throw new AppError(`${label} must be a user of this company`, 400);
}

// Branch scope for lists: an all-branches user sees everything; a restricted user only rows touching a branch they hold.
function branchScope(ctx: TenantContext): string[] | null {
  return ctx.branchAccess.allBranches ? null : ctx.branchAccess.branchIds;
}

// ─── Repair Transfers (branch -> Head Office custody) ────────────────────────

export async function createRepairTransfer(data: {
  fromBranchId: string; repairCaseIds: string[]; reason?: string; remarks?: string;
}, ctx: TenantContext, userId: string) {
  if (!Array.isArray(data.repairCaseIds) || data.repairCaseIds.length === 0) throw new AppError('At least one returned piece is required', 400);
  const caseIds = [...new Set(data.repairCaseIds)];
  await assertBranchAccessible(data.fromBranchId, ctx, 'From branch');
  const ho = await getHeadOfficeBranch(ctx);
  if (ho.id === data.fromBranchId) throw new AppError('Head Office is the destination — a repair transfer must start at another branch', 400);

  const cases = await tenantQuery(ctx.companyId, (tx) => tx.repairCase.findMany({
    where: { id: { in: caseIds }, companyId: ctx.companyId }, include: { tag: { select: { tagNumber: true, branchId: true, status: true } } },
  }));
  const found = new Set(cases.map((c) => c.id));
  const missing = caseIds.filter((id) => !found.has(id));
  if (missing.length) throw new AppError(`Repair record(s) not found: ${missing.join(', ')}`, 404);
  const notReady = cases.filter((c) => c.status !== REPAIR_STATUS.RETURNED_PENDING_TRANSFER || c.tag.status !== TAG_STATUS_RETURNED_PENDING_INSPECTION);
  if (notReady.length) throw new AppError(`Not awaiting transfer to Head Office: ${notReady.map((c) => c.tag.tagNumber).join(', ')}`, 409);
  const elsewhere = cases.filter((c) => c.tag.branchId !== data.fromBranchId);
  if (elsewhere.length) throw new AppError(`Not physically at the sending branch: ${elsewhere.map((c) => c.tag.tagNumber).join(', ')}`, 409);

  const transfer = await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise on the case rows, then make sure none is already on an open (DRAFT / IN_TRANSIT) transfer.
    await tx.$queryRaw`SELECT "id" FROM "repair_cases" WHERE "id" IN (${Prisma.join(caseIds)}) FOR UPDATE`;
    const already = await tx.repairTransferItem.findMany({
      where: { companyId: ctx.companyId, repairCaseId: { in: caseIds }, transfer: { status: { in: OPEN_TRANSFER_STATUSES } } },
      select: { repairCaseId: true },
    });
    if (already.length) throw new AppError('One or more pieces are already on an open repair transfer', 409);
    const transferNumber = await nextDocumentNumber(ctx.companyId, 'RT', 'RT', tx);
    return tx.repairTransfer.create({
      data: {
        companyId: ctx.companyId, transferNumber, fromBranchId: data.fromBranchId, toBranchId: ho.id,
        reason: str(data.reason), remarks: str(data.remarks), createdById: userId,
        items: { createMany: { data: caseIds.map((repairCaseId) => ({ repairCaseId })) } }, // nested under a composite FK: companyId is filled from the parent
      },
      include: { items: true },
    });
  });
  await createAuditEntry('repair_transfers', transfer.id, userId, 'CREATE', undefined, { transferNumber: transfer.transferNumber, pieces: caseIds.length }, ctx.companyId);
  return transfer;
}

async function loadTransfer(ctx: TenantContext, id: string) {
  const t = await tenantQuery(ctx.companyId, (tx) => tx.repairTransfer.findUnique({
    where: { id }, include: { items: { include: { repairCase: { include: { tag: { select: { tagNumber: true } } } } } } },
  }));
  if (!t || t.companyId !== ctx.companyId) throw new AppError('Repair transfer not found', 404);
  return t;
}

/** The branch hands the pieces over: the transfer goes IN_TRANSIT and every piece is in custody of no branch until HO receives it. */
export async function sendRepairTransfer(id: string, ctx: TenantContext, userId: string) {
  const t = await loadTransfer(ctx, id);
  await assertBranchAccessible(t.fromBranchId, ctx, 'From branch');
  if (t.status !== 'DRAFT') throw new AppError('Only a DRAFT repair transfer can be sent', 409);
  const caseIds = t.items.map((i) => i.repairCaseId);
  const tagIds = t.items.map((i) => i.repairCase.tagId);

  const sent = await tenantTransaction(ctx.companyId, async (tx) => {
    // Idempotency gate first: only one request can move DRAFT -> IN_TRANSIT.
    const gate = await tx.repairTransfer.updateMany({
      where: { id, companyId: ctx.companyId, status: 'DRAFT' },
      data: { status: 'IN_TRANSIT', sentAt: new Date(), sentById: userId },
    });
    if (gate.count !== 1) throw new AppError('This repair transfer has already been sent', 409);
    const tags = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, companyId: ctx.companyId, status: TAG_STATUS_RETURNED_PENDING_INSPECTION, branchId: t.fromBranchId },
      data: { status: TAG_STATUS_IN_TRANSIT_TO_HO },
    });
    const cases = await tx.repairCase.updateMany({
      where: { id: { in: caseIds }, companyId: ctx.companyId, status: REPAIR_STATUS.RETURNED_PENDING_TRANSFER },
      data: { status: REPAIR_STATUS.IN_TRANSIT_TO_HO, currentLocation: REPAIR_LOCATION.IN_TRANSIT, updatedById: userId },
    });
    if (tags.count !== tagIds.length || cases.count !== caseIds.length) {
      throw new AppError('A piece on this transfer is no longer awaiting transfer — nothing was sent', 409);
    }
    return tx.repairTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } });
  });
  await createAuditEntry('repair_transfers', id, userId, 'SEND', { status: 'DRAFT' }, { status: 'IN_TRANSIT', pieces: caseIds.length }, ctx.companyId);
  return sent;
}

export async function cancelRepairTransfer(id: string, ctx: TenantContext, userId: string) {
  const t = await loadTransfer(ctx, id);
  await assertBranchAccessible(t.fromBranchId, ctx, 'From branch');
  if (t.status !== 'DRAFT') throw new AppError('Only a DRAFT repair transfer can be cancelled — a sent one must be received at Head Office', 409);
  const res = await tenantTransaction(ctx.companyId, async (tx) => {
    const gate = await tx.repairTransfer.updateMany({ where: { id, companyId: ctx.companyId, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
    if (gate.count !== 1) throw new AppError('This repair transfer is no longer a draft', 409);
    return tx.repairTransfer.findUniqueOrThrow({ where: { id } });
  });
  await createAuditEntry('repair_transfers', id, userId, 'CANCEL', { status: 'DRAFT' }, { status: 'CANCELLED' }, ctx.companyId);
  return res;
}

/**
 * Head Office physically takes the pieces in. Optional `repairCaseIds` = only the pieces actually verified in the bag
 * (the rest stay in transit; the transfer becomes RECEIVED when the last one is in). Receiving twice is refused.
 */
export async function receiveRepairTransfer(id: string, ctx: TenantContext, userId: string, repairCaseIds?: string[]) {
  const t = await loadTransfer(ctx, id);
  // The destination is Head Office and only a user granted it may receive — the sending branch cannot.
  await assertBranchAccessible(t.toBranchId, ctx, 'Head Office');
  const ho = await assertHeadOfficeUser(ctx, 'receive repair transfers');
  if (ho.id !== t.toBranchId) throw new AppError('This transfer is not addressed to Head Office', 409);
  if (t.status !== 'IN_TRANSIT') throw new AppError(t.status === 'RECEIVED' ? 'This repair transfer has already been received' : 'Only an IN_TRANSIT repair transfer can be received', 409);

  const outstanding = t.items.filter((i) => !i.receivedAt);
  const wanted = repairCaseIds ? [...new Set(repairCaseIds)] : outstanding.map((i) => i.repairCaseId);
  if (wanted.length === 0) throw new AppError('Verify at least one piece to receive', 400);
  const outstandingIds = new Set(outstanding.map((i) => i.repairCaseId));
  if (wanted.some((c) => !outstandingIds.has(c))) throw new AppError('Some pieces are not awaiting receipt on this transfer (wrong transfer, or already received)', 409);
  const tagIds = t.items.filter((i) => wanted.includes(i.repairCaseId)).map((i) => i.repairCase.tagId);
  const now = new Date();

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    // Gate: the transfer must still be IN_TRANSIT (a concurrent full receipt flips it to RECEIVED).
    const gate = await tx.repairTransfer.updateMany({ where: { id, companyId: ctx.companyId, status: 'IN_TRANSIT' }, data: { receivedById: userId } });
    if (gate.count !== 1) throw new AppError('This repair transfer is no longer in transit', 409);
    const items = await tx.repairTransferItem.updateMany({
      where: { transferId: id, companyId: ctx.companyId, repairCaseId: { in: wanted }, receivedAt: null },
      data: { receivedAt: now, receivedById: userId },
    });
    if (items.count !== wanted.length) throw new AppError('Some pieces were already received — nothing was changed', 409);
    // Physically at Head Office from this moment: the tag's branch moves to HO, and it is held for inspection.
    const tags = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, companyId: ctx.companyId, status: TAG_STATUS_IN_TRANSIT_TO_HO },
      data: { status: TAG_STATUS_HO_RECEIVED, branchId: t.toBranchId },
    });
    const cases = await tx.repairCase.updateMany({
      where: { id: { in: wanted }, companyId: ctx.companyId, status: REPAIR_STATUS.IN_TRANSIT_TO_HO },
      data: { status: REPAIR_STATUS.HO_RECEIVED, currentLocation: REPAIR_LOCATION.HEAD_OFFICE, hoReceivedById: userId, hoReceivedAt: now, updatedById: userId },
    });
    if (tags.count !== wanted.length || cases.count !== wanted.length) throw new AppError('A piece is no longer in transit and cannot be received', 409);
    if (wanted.length === outstanding.length) {
      await tx.repairTransfer.updateMany({ where: { id, companyId: ctx.companyId, status: 'IN_TRANSIT' }, data: { status: 'RECEIVED', receivedAt: now, receivedById: userId } });
    }
    return tx.repairTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } });
  });
  await createAuditEntry('repair_transfers', id, userId, 'RECEIVE', { status: 'IN_TRANSIT' },
    { status: result.status, received: wanted.length, outstanding: outstanding.length - wanted.length }, ctx.companyId);
  for (const cid of wanted) {
    await createAuditEntry('repair_cases', cid, userId, 'HO_RECEIVE', { status: REPAIR_STATUS.IN_TRANSIT_TO_HO }, { status: REPAIR_STATUS.HO_RECEIVED, transferId: id }, ctx.companyId);
  }
  return result;
}

// ─── Inspection / repair / final inspection (Head Office) ────────────────────

async function loadCaseForHo(ctx: TenantContext, id: string, what: string) {
  const c = await tenantQuery(ctx.companyId, (tx) => tx.repairCase.findUnique({ where: { id }, include: { tag: true } }));
  if (!c || c.companyId !== ctx.companyId) throw new AppError('Repair record not found', 404);
  const ho = await assertHeadOfficeUser(ctx, what);
  return { c, ho };
}

/**
 * One guarded step of the pipeline: tag and case must both currently be at `from` (tag/case statuses), and both move
 * together in the caller's transaction. Zero rows matched = somebody already moved it = 409, so no step runs twice.
 */
async function step(tx: Tx, ctx: TenantContext, userId: string, c: { id: string; tagId: string },
  from: { tag: string; case: string }, to: { tag: string; case: string },
  caseData: Prisma.RepairCaseUncheckedUpdateManyInput, replayMsg: string) {
  const tag = await tx.jewelryTag.updateMany({ where: { id: c.tagId, companyId: ctx.companyId, status: from.tag }, data: { status: to.tag } });
  const cs = await tx.repairCase.updateMany({
    where: { id: c.id, companyId: ctx.companyId, status: from.case },
    data: { ...caseData, status: to.case, updatedById: userId },
  });
  if (tag.count !== 1 || cs.count !== 1) throw new AppError(replayMsg, 409);
}

export async function inspectRepairCase(id: string, data: {
  result: 'PASS' | 'REPAIR_REQUIRED' | 'MELT'; reason?: string; assignedToId?: string; remarks?: string;
}, ctx: TenantContext, userId: string) {
  const { c } = await loadCaseForHo(ctx, id, 'inspect returned jewellery');
  if (c.status !== REPAIR_STATUS.HO_RECEIVED) throw new AppError(`Only a piece received at Head Office can be inspected (current status: ${c.status})`, 409);
  const now = new Date();
  const base = { inspectedById: userId, inspectedAt: now, remarks: str(data.remarks) ?? c.remarks };
  const from = { tag: TAG_STATUS_HO_RECEIVED, case: REPAIR_STATUS.HO_RECEIVED };
  const replay = 'This piece has already been inspected';

  let after: { status: string; inspectionResult: string };
  if (data.result === 'PASS') {
    // The SAME tag row goes back on sale — same tag number, at Head Office until someone transfers it out.
    await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c, from, { tag: 'IN_STOCK', case: REPAIR_STATUS.INSPECTION_PASSED }, { ...base, inspectionResult: 'PASS' }, replay));
    after = { status: REPAIR_STATUS.INSPECTION_PASSED, inspectionResult: 'PASS' };
  } else if (data.result === 'REPAIR_REQUIRED') {
    const reason = needText(data.reason, 'Repair / correction reason');
    const assignedToId = str(data.assignedToId);
    if (assignedToId) await assertCompanyMember(ctx, assignedToId, 'Assigned employee');
    await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c, from, { tag: TAG_STATUS_REPAIR_REQUIRED, case: REPAIR_STATUS.REPAIR_REQUIRED },
      { ...base, inspectionResult: 'REPAIR_REQUIRED', repairReason: reason, assignedToId: assignedToId ?? null }, replay));
    after = { status: REPAIR_STATUS.REPAIR_REQUIRED, inspectionResult: 'REPAIR_REQUIRED' };
  } else if (data.result === 'MELT') {
    needText(data.reason ?? data.remarks, 'A reason');
    // Not resaleable. It only waits: turning it into old gold / material is a separate, explicit transaction.
    await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c, from, { tag: TAG_STATUS_MELT_PENDING, case: REPAIR_STATUS.MELT_PENDING },
      { ...base, inspectionResult: 'MELT', repairReason: str(data.reason) ?? null }, replay));
    after = { status: REPAIR_STATUS.MELT_PENDING, inspectionResult: 'MELT' };
  } else {
    throw new AppError('Inspection result must be PASS, REPAIR_REQUIRED or MELT', 400);
  }
  await createAuditEntry('repair_cases', id, userId, 'INSPECT', { status: c.status }, { ...after, reason: str(data.reason), remarks: str(data.remarks) }, ctx.companyId);
  return getRepairCase(ctx, id);
}

export async function startRepair(id: string, data: { repairEmployeeId?: string; remarks?: string }, ctx: TenantContext, userId: string) {
  const { c } = await loadCaseForHo(ctx, id, 'carry out repairs');
  if (c.status !== REPAIR_STATUS.REPAIR_REQUIRED) throw new AppError(`Repair can only start on a piece marked REPAIR_REQUIRED (current status: ${c.status})`, 409);
  const repairEmployeeId = str(data.repairEmployeeId) ?? c.assignedToId ?? null;
  if (repairEmployeeId) await assertCompanyMember(ctx, repairEmployeeId, 'Repair employee');
  await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c,
    { tag: TAG_STATUS_REPAIR_REQUIRED, case: REPAIR_STATUS.REPAIR_REQUIRED }, { tag: TAG_STATUS_IN_REPAIR, case: REPAIR_STATUS.IN_REPAIR },
    { repairEmployeeId, repairStartedAt: new Date(), remarks: str(data.remarks) ?? c.remarks }, 'Repair has already been started on this piece'));
  await createAuditEntry('repair_cases', id, userId, 'REPAIR_START', { status: c.status }, { status: REPAIR_STATUS.IN_REPAIR, repairEmployeeId }, ctx.companyId);
  return getRepairCase(ctx, id);
}

export async function completeRepair(id: string, data: { details: string; repairCost?: number; remarks?: string }, ctx: TenantContext, userId: string) {
  const details = needText(data.details, 'Work / correction details');
  if (data.repairCost !== undefined && !(Number(data.repairCost) >= 0)) throw new AppError('Repair cost must be zero or more', 400);
  const { c } = await loadCaseForHo(ctx, id, 'complete repairs');
  if (c.status !== REPAIR_STATUS.IN_REPAIR) throw new AppError(`Only a piece IN_REPAIR can be completed (current status: ${c.status})`, 409);
  await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c,
    { tag: TAG_STATUS_IN_REPAIR, case: REPAIR_STATUS.IN_REPAIR }, { tag: TAG_STATUS_REPAIR_COMPLETED, case: REPAIR_STATUS.REPAIR_COMPLETED },
    { repairCompletedAt: new Date(), repairDetails: details, repairCost: data.repairCost ?? null, remarks: str(data.remarks) ?? c.remarks },
    'This repair has already been completed'));
  await createAuditEntry('repair_cases', id, userId, 'REPAIR_COMPLETE', { status: c.status }, { status: REPAIR_STATUS.REPAIR_COMPLETED, details }, ctx.companyId);
  return getRepairCase(ctx, id);
}

/** After repair: PASS puts the same tag back IN_STOCK; FAIL sends it back to REPAIR_REQUIRED — never to stock. */
export async function finalInspect(id: string, data: { result: 'PASS' | 'FAIL'; remarks?: string }, ctx: TenantContext, userId: string) {
  const { c } = await loadCaseForHo(ctx, id, 'perform final inspection');
  if (c.status !== REPAIR_STATUS.REPAIR_COMPLETED) throw new AppError(`Final inspection applies to a completed repair (current status: ${c.status})`, 409);
  const from = { tag: TAG_STATUS_REPAIR_COMPLETED, case: REPAIR_STATUS.REPAIR_COMPLETED };
  const fin = { finalInspectedById: userId, finalInspectedAt: new Date() };
  const replay = 'Final inspection has already been recorded for this piece';
  if (data.result === 'PASS') {
    await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c, from, { tag: 'IN_STOCK', case: REPAIR_STATUS.INSPECTION_PASSED },
      { ...fin, remarks: str(data.remarks) ?? c.remarks }, replay));
  } else if (data.result === 'FAIL') {
    const remarks = needText(data.remarks, 'Remarks explaining the failed correction');
    await tenantTransaction(ctx.companyId, (tx) => step(tx, ctx, userId, c, from, { tag: TAG_STATUS_REPAIR_REQUIRED, case: REPAIR_STATUS.REPAIR_REQUIRED },
      { ...fin, remarks, repairReason: remarks, repairCompletedAt: null }, replay));
  } else {
    throw new AppError('Final inspection result must be PASS or FAIL', 400);
  }
  await createAuditEntry('repair_cases', id, userId, data.result === 'PASS' ? 'FINAL_INSPECTION_PASS' : 'FINAL_INSPECTION_FAIL',
    { status: c.status }, { status: data.result === 'PASS' ? REPAIR_STATUS.INSPECTION_PASSED : REPAIR_STATUS.REPAIR_REQUIRED, remarks: str(data.remarks) }, ctx.companyId);
  return getRepairCase(ctx, id);
}

// ─── Reprint & retag ─────────────────────────────────────────────────────────

/**
 * The physical label is damaged/lost but nothing about the piece changed: same tag, same number, no new row. The
 * reprint is recorded in the audit trail (tag_history is trigger-written from row changes only, and a reprint changes none).
 */
export async function reprintTag(tagId: string, reason: string | undefined, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('jewelryTag', tagId, ctx.companyId, 'Tag');
  const tag = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findUniqueOrThrow({ where: { id: tagId } }));
  await assertBranchAccessible(tag.branchId, ctx, 'Tag');
  if (tag.status === TAG_STATUS_RETAGGED || tag.status === 'RETIRED') throw new AppError(`A ${tag.status} tag cannot be reprinted`, 409);
  await createAuditEntry('jewelry_tags', tagId, userId, 'REPRINT', undefined, { tagNumber: tag.tagNumber, reason: str(reason) ?? null }, ctx.companyId);
  return { id: tag.id, tagNumber: tag.tagNumber, status: tag.status, branchId: tag.branchId };
}

const RETAG_NUMERIC = ['grossWeight', 'netWeight', 'stoneWeight'] as const;
const RETAG_TEXT = ['name', 'metalKarat', 'huid', 'settingType', 'notes'] as const;

/**
 * True retagging — the piece's specification changed and the business needs a new Jewel Code. The OLD tag becomes
 * RETAGGED (it stays, permanently linked through TagRetag), a NEW tag is created at Head Office carrying the old tag's
 * lineage, cost (immutable) and materials, and goes IN_STOCK only when this whole transaction commits. Allowed once
 * per tag, only for a piece Head Office holds and has not yet cleared (received, or repair completed).
 */
export async function retagTag(data: {
  repairCaseId: string; reason: string; remarks?: string;
  changes: Partial<Record<(typeof RETAG_NUMERIC)[number], number>> & Partial<Record<(typeof RETAG_TEXT)[number], string>> & { sellingPrice?: number; noOfPcs?: number };
}, ctx: TenantContext, userId: string) {
  const reason = needText(data.reason, 'Retag reason');
  const { c, ho } = await loadCaseForHo(ctx, data.repairCaseId, 'retag jewellery');
  if (c.status !== REPAIR_STATUS.HO_RECEIVED && c.status !== REPAIR_STATUS.REPAIR_COMPLETED) {
    throw new AppError(`Only a piece received at Head Office or with a completed repair can be retagged (current status: ${c.status})`, 409);
  }
  const old = c.tag;
  if (!old.stockTypeId || !old.categoryId) throw new AppError('This tag has no category / stock type, so a new tag number cannot be built for it', 409);

  const changes = data.changes ?? {};
  const newVals: Record<string, unknown> = {};
  for (const k of RETAG_NUMERIC) {
    if (changes[k] === undefined) continue;
    const n = Number(changes[k]);
    if (!(n >= 0)) throw new AppError(`${k} must be zero or more`, 400);
    newVals[k] = n;
  }
  for (const k of RETAG_TEXT) { if (changes[k] !== undefined) newVals[k] = String(changes[k]); }
  if (changes.sellingPrice !== undefined) {
    if (!(Number(changes.sellingPrice) >= 0)) throw new AppError('Selling price must be zero or more', 400);
    newVals.sellingPrice = Number(changes.sellingPrice);
  }
  if (changes.noOfPcs !== undefined) newVals.noOfPcs = Math.trunc(Number(changes.noOfPcs));

  const changed = Object.entries(newVals).filter(([k, v]) => {
    const was = (old as unknown as Record<string, unknown>)[k];
    return (typeof v === 'number' ? Number(was ?? 0) !== v : (was ?? '') !== v);
  });
  if (changed.length === 0) throw new AppError('Nothing about the piece changed — reprint the existing tag instead of retagging', 400);
  const gross = Number(newVals.grossWeight ?? old.grossWeight);
  const net = Number(newVals.netWeight ?? old.netWeight);
  if (net > gross + 0.00005) throw new AppError('Net weight cannot exceed gross weight', 400);

  const snap = (t: { grossWeight: unknown; netWeight: unknown; stoneWeight: unknown; metalKarat: string | null; name: string; huid: string | null; sellingPrice: unknown; noOfPcs: number | null; settingType: string | null }) => ({
    name: t.name, metalKarat: t.metalKarat, grossWeight: Number(t.grossWeight), netWeight: Number(t.netWeight), stoneWeight: Number(t.stoneWeight),
    huid: t.huid, sellingPrice: Number(t.sellingPrice), noOfPcs: t.noOfPcs, settingType: t.settingType,
  });

  const out = await tenantTransaction(ctx.companyId, async (tx) => {
    const stockType = await tx.stockType.findFirstOrThrow({ where: { id: old.stockTypeId!, companyId: ctx.companyId } });
    const category = await tx.productCategory.findFirstOrThrow({ where: { id: old.categoryId!, companyId: ctx.companyId } });

    // Gate first: only one retag of this tag can win (status must still be what we read; the unique old-tag index backs it).
    await step(tx, ctx, userId, c, { tag: c.tag.status, case: c.status }, { tag: TAG_STATUS_RETAGGED, case: REPAIR_STATUS.RETAGGED },
      { inspectionResult: c.inspectionResult ?? 'RETAG', remarks: str(data.remarks) ?? c.remarks }, 'This piece has already been retagged or has moved on');

    const tagNumber = await nextTagNumber(ctx.companyId, stockType.code, category.code, tx);
    const created = await tx.jewelryTag.create({
      data: {
        companyId: ctx.companyId, tagNumber, branchId: ho.id, status: 'IN_STOCK', createdById: userId,
        name: old.name, makeType: old.makeType, metalType: old.metalType, metalKarat: old.metalKarat,
        grossWeight: old.grossWeight, netWeight: old.netWeight, stoneWeight: old.stoneWeight, huid: old.huid,
        settingType: old.settingType, costPrice: old.costPrice, sellingPrice: old.sellingPrice, pricingMode: old.pricingMode, // costPrice is immutable: inherited, never repriced
        saleMcRate: old.saleMcRate, saleVaPercent: old.saleVaPercent, costMcRate: old.costMcRate, costVaPercent: old.costVaPercent,
        notes: old.notes, stockTypeId: old.stockTypeId, categoryId: old.categoryId, subCategoryId: old.subCategoryId,
        collectionId: old.collectionId, sizeId: old.sizeId, noOfPcs: old.noOfPcs, manufacturerId: old.manufacturerId,
        jobCardId: old.jobCardId, designId: old.designId,
        ...newVals as Record<string, never>,
        // grnItemId (unique) and purchaseLotId stay with the old tag: the lineage is the old tag's, and a lot's tagged
        // totals are live sums over its tags — copying the lot link would count the same bag twice.
      },
    });
    const mats = await tx.jewelryTagMaterial.findMany({ where: { tagId: old.id, companyId: ctx.companyId } });
    if (mats.length) {
      await tx.jewelryTagMaterial.createMany({
        data: mats.map((m) => ({
          companyId: ctx.companyId, tagId: created.id, materialCodeId: m.materialCodeId, stoneGradeId: m.stoneGradeId, code: m.code,
          materialType: m.materialType, size: m.size, pieces: m.pieces, weight: m.weight, unit: m.unit,
          costRate: m.costRate, costAmount: m.costAmount, saleRate: m.saleRate, saleAmount: m.saleAmount,
        })),
      });
    }
    const retagNumber = await nextDocumentNumber(ctx.companyId, 'RTG', 'RTG', tx);
    const retag = await tx.tagRetag.create({
      data: {
        companyId: ctx.companyId, retagNumber, oldTagId: old.id, newTagId: created.id, repairCaseId: c.id, branchId: ho.id,
        reason, remarks: str(data.remarks), oldDetails: snap(old), newDetails: snap(created),
        retaggedById: userId, approvedById: userId,
      },
    });
    return { retag, newTag: created };
  });
  await createAuditEntry('tag_retags', out.retag.id, userId, 'CREATE', undefined,
    { retagNumber: out.retag.retagNumber, oldTagNumber: old.tagNumber, newTagNumber: out.newTag.tagNumber, reason }, ctx.companyId);
  await createAuditEntry('repair_cases', c.id, userId, 'RETAG', { status: c.status }, { status: REPAIR_STATUS.RETAGGED, newTagNumber: out.newTag.tagNumber }, ctx.companyId);
  return { ...out.retag, oldTagNumber: old.tagNumber, newTagNumber: out.newTag.tagNumber, newTagId: out.newTag.id };
}

// ─── Registers ───────────────────────────────────────────────────────────────

/** Employees of this company who can be named on a repair (assigned / repairing). Active members only. */
export async function listRepairEmployees(ctx: TenantContext) {
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: { companyId: ctx.companyId, isActive: true }, select: { userId: true, user: { select: { name: true } } },
  }));
  return rows.map((r) => ({ id: r.userId, name: r.user.name })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface RepairRegisterFilters {
  dateFrom?: Date; dateTo?: Date; branchId?: string; headOffice?: boolean; repairNumber?: string; tagNumber?: string;
  returnNumber?: string; invoiceNumber?: string; customer?: string; status?: string; assignedToId?: string;
  repairEmployeeId?: string; inspectionResult?: string;
}

const caseInclude = {
  tag: { select: { tagNumber: true, branchId: true, status: true, category: { select: { name: true } }, branch: { select: { name: true, branchCode: true } } } },
  originBranch: { select: { name: true, branchCode: true } },
  salesReturnItem: { select: { return: { select: { id: true, returnNumber: true, returnDate: true, client: { select: { name: true } }, invoice: { select: { invoiceNumber: true } } } } } },
  transferItems: { select: { receivedAt: true, transfer: { select: { id: true, transferNumber: true, status: true, sentAt: true, receivedAt: true } } }, orderBy: { id: 'desc' as const } },
  retag: { select: { retagNumber: true, newTag: { select: { tagNumber: true } } } },
};

export async function listRepairCases(ctx: TenantContext, f: RepairRegisterFilters = {}) {
  const scope = branchScope(ctx);
  const ho = f.headOffice ? await getHeadOfficeBranch(ctx) : null;
  const and: Prisma.RepairCaseWhereInput[] = [];
  if (scope) and.push({ OR: [{ originBranchId: { in: scope } }, { tag: { branchId: { in: scope } } }] });
  if (f.branchId) and.push({ OR: [{ originBranchId: f.branchId }, { tag: { branchId: f.branchId } }] });
  if (ho) and.push({ tag: { branchId: ho.id } });
  if (f.customer) and.push({ salesReturnItem: { return: { client: { name: { contains: f.customer, mode: 'insensitive' } } } } });
  if (f.returnNumber) and.push({ salesReturnItem: { return: { returnNumber: { contains: f.returnNumber, mode: 'insensitive' } } } });
  if (f.invoiceNumber) and.push({ salesReturnItem: { return: { invoice: { invoiceNumber: { contains: f.invoiceNumber, mode: 'insensitive' } } } } });
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.repairCase.findMany({
    where: {
      companyId: ctx.companyId,
      ...(f.dateFrom || f.dateTo ? { createdAt: { ...(f.dateFrom && { gte: f.dateFrom }), ...(f.dateTo && { lte: f.dateTo }) } } : {}),
      ...(f.repairNumber && { repairNumber: { contains: f.repairNumber, mode: 'insensitive' } }),
      ...(f.tagNumber && { tag: { tagNumber: { contains: f.tagNumber, mode: 'insensitive' } } }),
      ...(f.status && { status: f.status }),
      ...(f.assignedToId && { assignedToId: f.assignedToId }),
      ...(f.repairEmployeeId && { repairEmployeeId: f.repairEmployeeId }),
      ...(f.inspectionResult && { inspectionResult: f.inspectionResult }),
      ...(and.length && { AND: and }),
    },
    include: caseInclude, orderBy: { createdAt: 'desc' }, take: 2000,
  }));
  return shapeCases(rows);
}

async function shapeCases(rows: Array<Prisma.RepairCaseGetPayload<{ include: typeof caseInclude }>>) {
  const names = await userNames(rows.flatMap((r) => [r.assignedToId, r.repairEmployeeId, r.hoReceivedById, r.inspectedById, r.finalInspectedById, r.createdById]));
  const nm = (id: string | null) => (id ? names.get(id) ?? null : null);
  return rows.map((r) => {
    const ret = r.salesReturnItem?.return;
    const lastTransfer = r.transferItems[0];
    return {
      id: r.id, repairNumber: r.repairNumber, tagId: r.tagId, tagNumber: r.tag.tagNumber, description: r.description,
      category: r.tag.category?.name ?? null, karat: r.karat,
      grossWeight: Number(r.grossWeight), stoneWeight: Number(r.stoneWeight), netWeight: Number(r.netWeight),
      originBranch: r.originBranch.name, originBranchId: r.originBranchId,
      currentLocation: r.currentLocation, currentBranch: r.tag.branch.name, currentBranchId: r.tag.branchId, tagStatus: r.tag.status,
      customer: ret?.client.name ?? null, returnId: ret?.id ?? null, returnNumber: ret?.returnNumber ?? null,
      invoiceNumber: ret?.invoice.invoiceNumber ?? null, returnDate: ret?.returnDate ?? null, returnReason: r.returnReason,
      transferId: lastTransfer?.transfer.id ?? null, transferNumber: lastTransfer?.transfer.transferNumber ?? null,
      transferStatus: lastTransfer?.transfer.status ?? null, hoReceivedAt: r.hoReceivedAt, hoReceivedBy: nm(r.hoReceivedById),
      inspectionResult: r.inspectionResult, inspectedAt: r.inspectedAt, inspectedBy: nm(r.inspectedById),
      repairReason: r.repairReason, assignedTo: nm(r.assignedToId), assignedToId: r.assignedToId,
      repairEmployee: nm(r.repairEmployeeId), repairEmployeeId: r.repairEmployeeId,
      repairStartedAt: r.repairStartedAt, repairCompletedAt: r.repairCompletedAt, repairDetails: r.repairDetails, repairCost: r.repairCost == null ? null : Number(r.repairCost),
      finalInspectedAt: r.finalInspectedAt, finalInspectedBy: nm(r.finalInspectedById),
      status: r.status, remarks: r.remarks, createdBy: nm(r.createdById), createdAt: r.createdAt, updatedAt: r.updatedAt,
      retagNumber: r.retag?.retagNumber ?? null, newTagNumber: r.retag?.newTag.tagNumber ?? null,
    };
  });
}

export async function getRepairCase(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('repairCase', id, ctx.companyId, 'Repair record');
  const row = await tenantQuery(ctx.companyId, (tx) => tx.repairCase.findUniqueOrThrow({ where: { id }, include: caseInclude }));
  if (!canAccessBranch(ctx, row.originBranchId) && !canAccessBranch(ctx, row.tag.branchId)) throw new AppError('Repair record not found', 404);
  return (await shapeCases([row]))[0];
}

export interface RepairTransferFilters {
  dateFrom?: Date; dateTo?: Date; branchId?: string; tagNumber?: string; transferNumber?: string; status?: string; repairNumber?: string;
}

/** One row per piece on a transfer: which returned jewellery moved from which branch to HO, and whether HO has received it. */
export async function listRepairTransfers(ctx: TenantContext, f: RepairTransferFilters = {}) {
  const scope = branchScope(ctx);
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.repairTransfer.findMany({
    where: {
      companyId: ctx.companyId,
      ...(scope && { OR: [{ fromBranchId: { in: scope } }, { toBranchId: { in: scope } }] }),
      ...(f.branchId && { fromBranchId: f.branchId }),
      ...(f.status && { status: f.status }),
      ...(f.transferNumber && { transferNumber: { contains: f.transferNumber, mode: 'insensitive' } }),
      ...(f.dateFrom || f.dateTo ? { createdAt: { ...(f.dateFrom && { gte: f.dateFrom }), ...(f.dateTo && { lte: f.dateTo }) } } : {}),
      ...((f.tagNumber || f.repairNumber) && {
        items: { some: {
          ...(f.repairNumber && { repairCase: { repairNumber: { contains: f.repairNumber, mode: 'insensitive' } } }),
          ...(f.tagNumber && { repairCase: { tag: { tagNumber: { contains: f.tagNumber, mode: 'insensitive' } } } }),
        } },
      }),
    },
    include: {
      fromBranch: { select: { name: true } }, toBranch: { select: { name: true } },
      items: { include: { repairCase: { select: { id: true, repairNumber: true, tag: { select: { tagNumber: true } }, salesReturnItem: { select: { return: { select: { returnNumber: true } } } } } } } },
    },
    orderBy: { createdAt: 'desc' }, take: 1000,
  }));
  const names = await userNames(rows.flatMap((r) => [r.createdById, r.sentById, r.receivedById]));
  const nm = (id: string | null) => (id ? names.get(id) ?? null : null);
  return rows.flatMap((t) => t.items
    .filter((i) => (!f.tagNumber || i.repairCase.tag.tagNumber.toLowerCase().includes(f.tagNumber.toLowerCase()))
      && (!f.repairNumber || i.repairCase.repairNumber.toLowerCase().includes(f.repairNumber.toLowerCase())))
    .map((i) => ({
      transferId: t.id, transferNumber: t.transferNumber, repairCaseId: i.repairCaseId, repairNumber: i.repairCase.repairNumber,
      tagNumber: i.repairCase.tag.tagNumber, returnNumber: i.repairCase.salesReturnItem?.return.returnNumber ?? null,
      fromBranch: t.fromBranch.name, fromBranchId: t.fromBranchId, toBranch: t.toBranch.name, toBranchId: t.toBranchId,
      status: t.status, itemReceivedAt: i.receivedAt, reason: t.reason, remarks: t.remarks,
      createdAt: t.createdAt, createdBy: nm(t.createdById), sentAt: t.sentAt, sentBy: nm(t.sentById), receivedAt: i.receivedAt ?? t.receivedAt, receivedBy: nm(i.receivedById ?? t.receivedById),
    })));
}

export async function getRepairTransfer(ctx: TenantContext, id: string) {
  const t = await loadTransfer(ctx, id);
  if (!canAccessBranch(ctx, t.fromBranchId) && !canAccessBranch(ctx, t.toBranchId)) throw new AppError('Repair transfer not found', 404);
  return t;
}
