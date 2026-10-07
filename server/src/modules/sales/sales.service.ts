import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { priceMaterialBreakdown } from '../../shared/materialBreakdown';
import { createAuditEntry } from '../../middleware/audit';
import { emit } from '../../shared/websocket';
import {
  DEFAULT_HSN_CODE, CREDIT_SETTLEMENT_MODES, PAYMENT_MODE_OLD_GOLD, PAYMENT_MODE_STORE_CREDIT, PAYMENT_MODE_CUSTOMER_ADVANCE,
  TAG_STATUS_RETURNED_PENDING_INSPECTION, REPAIR_STATUS, REPAIR_LOCATION,
} from '../../shared/constants';
import { assertPanIfRequired, assertCashLimit } from '../../shared/compliance';
import { resolveStateCode } from '../../shared/stateMaster';
import { splitGst } from '../../shared/gstSplit';
import { normalizeGstUqc } from '../../shared/gstUqc';
import { createCreditNoteForReturn } from './creditNote.service';
import { resolveMetalRate, GOLD_BASE_KARAT } from '../../shared/metalRate';
import { isValidKarat } from '../../shared/karatMaster';
import { addMetalStock } from '../inventory/inventory.service';
import { METAL_MOVEMENT, MetalMovementType, consumeVaultMetal, restoreVaultMetal, insertMetalMovement } from '../../shared/metalMovement';
import { postAutoJournalEntry } from '../finance/finance.service';
import { lockAdvances, loadSpendableAdvance, recordAdvanceApplication, releaseAdvanceApplication } from './customerAdvanceApply';
import { LEDGER_ACCOUNT, cashOrBankAccount } from '../../shared/ledgerAccounts';
import { nextDocumentNumber, gstFinancialYear } from '../../shared/numberSequence';
import { TenantContext, tenantTransaction, tenantQuery, tenantBatch } from '../../shared/tenantContext';
import { assertBranchAccessible, assertOwnedByCompany, assertAllOwned } from '../../middleware/tenant';
import { assertGstr1DocumentMutable, auditGstr1MutationBlocked } from '../finance/gst/gstr1FilingProtection';
import { assertGstr3bPeriodMutable, auditGstr3bMutationBlocked } from '../finance/gst/gstr3bFilingProtection';

// The customer's old metal handed over against this bill (mode OLD_GOLD) — see createInvoice.
type OldGoldInput = {
  description: string; karat: string; grossWeight: number; stoneWeight?: number; deductionPercent?: number;
};

type PaymentInput = {
  paymentDate: Date; amount: number; mode: string;
  referenceNo?: string; forexRate?: number; notes?: string;
  /** Required when mode is OLD_GOLD; `amount` is then ignored — the server values the metal itself. */
  oldGold?: OldGoldInput;
  /** Required when mode is CUSTOMER_ADVANCE: which advance of this customer pays `amount`. */
  advanceId?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const normalizeMode = (mode: string) => mode.trim().toUpperCase();

// OLD_GOLD / STORE_CREDIT only exist inside createInvoice (they settle a bill from credit); a standalone
// "record a payment" has no such thing to draw on, so it must not accept them.
function assertReceiptMode(mode: string) {
  if (normalizeMode(mode) === PAYMENT_MODE_CUSTOMER_ADVANCE) {
    throw new AppError('A customer advance is applied from the Customer Advances screen or while creating an invoice, not as a plain receipt', 400);
  }
  if (CREDIT_SETTLEMENT_MODES.includes(normalizeMode(mode))) {
    throw new AppError(`${mode} can only be used while creating an invoice`, 400);
  }
}

export async function createMemoOut(data: {
  clientId: string; branchId: string; sentDate: Date; returnDeadline: Date; notes?: string;
  items: Array<{
    productCode: string; description: string; huid?: string; karat?: string;
    pieces: number; grossWeight: number; netGoldWeight: number; stoneWeight?: number;
    estimatedValue: number;
    tagId?: string; // optional link to JewelryTag
  }>;
}, ctx: TenantContext, userId: string) {
  // Layer 2: branch and client are explicitly validated against the caller's own company/branch
  // access BEFORE anything else — same reasoning as createTag()/createInvoice(). MemoOut now
  // carries its own companyId+branchId (Phase 2) rather than needing either derived from a tag
  // afterward.
  await assertBranchAccessible(data.branchId, ctx);
  const client = await tenantQuery(ctx.companyId, (_tx) => _tx.client.findUnique({ where: { id: data.clientId }, select: { companyId: true, name: true, isActive: true } }));
  if (!client || client.companyId !== ctx.companyId) throw new AppError('Client not found', 404);
  assertClientActive(client);

  // Validate any linked tags are both IN_STOCK and actually owned by this company — a
  // Company-B tagId must be indistinguishable from a nonexistent one, exactly like
  // createInvoice()'s tag resolution.
  const tagIds = data.items.map((i) => i.tagId).filter(Boolean) as string[];
  if (tagIds.length > 0) {
    const tags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } }));
    const foundIds = new Set(tags.map((t) => t.id));
    const missing = tagIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);
    const notAvailable = tags.filter((t) => t.status !== 'IN_STOCK');
    if (notAvailable.length > 0) {
      throw new AppError(
        `Tags not available: ${notAvailable.map((t) => t.tagNumber).join(', ')}`, 400
      );
    }
  }

  const totalValue = data.items.reduce((s, i) => s + i.estimatedValue, 0);

  const memo = await tenantTransaction(ctx.companyId, async (tx) => {
    const memoNumber = await nextDocumentNumber(ctx.companyId, 'MEM', 'MEM', tx, data.sentDate.getFullYear());
    const created = await tx.memoOut.create({
      data: {
        companyId: ctx.companyId, branchId: data.branchId,
        memoNumber, clientId: data.clientId, sentDate: data.sentDate,
        returnDeadline: data.returnDeadline, totalValue, notes: data.notes,
        items: {
          createMany: {
            data: data.items.map((i) => ({
              productCode: i.productCode,
              description: i.description,
              huid: i.huid,
              karat: i.karat,
              pieces: i.pieces,
              grossWeight: i.grossWeight,
              netGoldWeight: i.netGoldWeight,
              stoneWeight: i.stoneWeight ?? 0,
              estimatedValue: i.estimatedValue,
              tagId: i.tagId ?? null,
            })),
          },
        },
      },
      include: { client: true, items: true },
    });

    // Mark linked tags as ON_APPROVAL — re-scoped to companyId again here (not just at the
    // pre-check above) since this is the query that actually mutates status.
    if (tagIds.length > 0) {
      const flipped = await tx.jewelryTag.updateMany({
        where: { id: { in: tagIds }, companyId: ctx.companyId, status: 'IN_STOCK' },
        data: { status: 'ON_APPROVAL' },
      });
      if (flipped.count !== tagIds.length) {
        throw new AppError('One or more items became unavailable just now', 409);
      }
    }

    return created;
  });

  await createAuditEntry('memo_outs', memo.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return memo;
}

// Company-scoped operational sweep, triggered today by a manual per-company endpoint
// (memo:manage, an ordinary company permission). Phase 3 fix: this used to scan every company's
// overdue memos in one pass with no companyId filter — each alert still routed correctly via the
// memo's OWN companyId (emit.memoAlert), so it was never a *read* leak, but an ordinary company
// user's memo:manage permission was silently triggering a platform-wide sweep (marking OTHER
// companies' memos alertSent=true, and folding their count into the response) — exactly the
// "reachable from an ordinary company user's request" case shared/tenantContext.ts's
// runAsPlatform doc says a platform-level op must never allow. Scoped to companyId like every
// other tenant-scoped endpoint; a real future scheduled job can loop this per company (or call it
// once per company via runAsPlatform) rather than reintroducing an unscoped scan.
export async function checkMemoAlerts(companyId: string) {
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const expiring = await tenantQuery(companyId, (_tx) => _tx.memoOut.findMany({
    where: { companyId, status: 'OUT', returnDeadline: { lte: threeDaysFromNow }, alertSent: false },
  }));

  for (const memo of expiring) {
    const daysLeft = Math.floor((new Date(memo.returnDeadline).getTime() - Date.now()) / 86400000);
    emit.memoAlert(memo.id, daysLeft, memo.companyId);
    await tenantQuery(companyId, (_tx) => _tx.memoOut.update({ where: { id: memo.id }, data: { alertSent: true } }));
  }

  return expiring.length;
}

// F3: dealer credit limit. A soft business-policy guardrail, not a correctness invariant like the
// tag-flip guards elsewhere in this file — it reads Client.creditLimit/currentBalance and compares
// within the caller's transaction, but doesn't row-lock, so two genuinely concurrent sales to the
// same dealer could both pass before either commits. Acceptable: over-extending a dealer by one
// racing sale is a policy nudge to catch, not data corruption like double-selling one physical tag.
// No creditLimit set (the common case — a lightweight walk-in retail Client) means unlimited,
// same as before this check existed.
// J3 Decision 3 (A1): isActive now has real teeth — an inactive client cannot be used to START a
// new sale, memo, or payment. Existing historical transactions are untouched (this is a forward-
// looking gate, not a retroactive one). Checked at every entry point that begins a NEW transaction
// for a client — deliberately not in amendInvoice/createSalesReturn/convertMemoToInvoice, which act
// on a transaction that already exists (a memo predates any later deactivation, and a return/amend
// corrects something already on the books).
function assertClientActive(client: { name: string; isActive: boolean }) {
  if (!client.isActive) {
    throw new AppError(`${client.name} is deactivated and cannot be used for a new transaction`, 409);
  }
}

// Every sales employee a request names (invoice header and/or lines) must be an active member of the caller's own
// company — User is a global identity, so a bare FK would accept anyone's id. `alreadyOnInvoice` lets an amend keep an
// employee who has since been deactivated on a line that already carried them.
async function assertSalesPeopleInCompany(
  ctx: TenantContext, ids: Array<string | null | undefined>, alreadyOnInvoice: Set<string> = new Set(),
) {
  const wanted = Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && !alreadyOnInvoice.has(x))));
  if (wanted.length === 0) return;
  const found = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: { companyId: ctx.companyId, userId: { in: wanted }, isActive: true, user: { isActive: true } },
    select: { userId: true },
  }));
  if (found.length !== wanted.length) throw new AppError('Sales employee not found', 404);
}

function checkCreditLimit(
  client: { name: string; creditLimit: unknown; currentBalance: unknown },
  additionalAmount: number,
) {
  if (client.creditLimit == null) return;
  const limit = Number(client.creditLimit);
  const projected = Number(client.currentBalance) + additionalAmount;
  if (projected > limit) {
    throw new AppError(
      `This sale would put ${client.name}'s balance at ₹${projected.toFixed(2)}, over their ₹${limit.toFixed(2)} credit limit`,
      400
    );
  }
}

// What the New Sale screen needs to preview a bill the way createInvoice will price it: the HSN codes a line can be
// billed under (with their GST rate) and whether this customer is same-state (CGST + SGST) or inter-state (IGST).
// Read-only; the answer createInvoice acts on is always recomputed there, never taken from here.
export async function getTaxContext(ctx: TenantContext, clientId?: string) {
  const hsnCodes = await prisma.hsnCode.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  let sameState = false;
  if (clientId) {
    const [company, client] = await tenantBatch(ctx.companyId, (tx) => [
      tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } }),
      tx.client.findFirst({ where: { id: clientId, companyId: ctx.companyId }, select: { state: true } }),
    ]);
    // Same comparison as createInvoice: no confident match for the client's state counts as inter-state.
    const clientStateCode = client ? await resolveStateCode(client.state) : null;
    sameState = clientStateCode != null && clientStateCode === (company.stateCode ?? '');
  }
  return {
    defaultHsnCode: DEFAULT_HSN_CODE,
    hsnCodes: hsnCodes.map((h) => ({ code: h.code, description: h.description, gstRate: Number(h.gstRate) })),
    sameState,
  };
}

// The most a bill can be nudged by round-off. Rounding to the rupee never exceeds 50 paise; a biller keying it
// by hand gets some room, but a bigger movement must go through Discount so it is visible as one.
export const MAX_ROUND_OFF = 10;

// One line of an invoice as the caller sends it (createInvoice and amendInvoice share this).
type InvoiceItemInput = { productCode: string; description: string; huid?: string; karat?: string;
  quantity: number; grossWeight: number; netGoldWeight: number; stoneWeight?: number;
  rateType: string; goldRate?: number; /* omit on a PER_GRAM line to price off today's
    MetalRate for `karat` as of invoiceDate (C2) — an explicit value always wins (clerk
    override). FIXED lines must always supply it: it IS the decided price. */
  makingCharge?: number; /* omit on a PER_GRAM line to use the tagged piece's own settled
    saleMcRate (whatever was decided at tagging time — see JewelryTag's schema comment), or —
    only when untagged or the tag predates that column — the MakingCharge master's rate for the
    line's karat + category (+ tag's makeType, if tagged) (C3). An explicit value always wins.
    Most-specific master row wins (karat+category beats either alone). */
  stoneValue?: number;
  wastagePercent?: number; /* "VA%" — marks up makingCharge, PER_GRAM lines only (see below).
    Same resolution order as makingCharge: explicit > tag's own saleVaPercent > master's
    saleWastagePercent (C3). */
  hsnCode?: string; /* HSN/GST rate lookup key — defaults to DEFAULT_HSN_CODE (jewellery, 3%) */
  uqc?: string; /* G2g-3a: statutory GST UQC for this line (e.g. "GMS", "PCS") — omit to use the
    line's HSN's own defaultUqc (case-insensitive on input; snapshotted at creation time, like
    hsnCodeId/taxRate — see InvoiceItem.uqc's schema comment). Rejected if not a recognized GST
    UQC (shared/gstUqc.ts). */
  categoryId?: string; /* ProductCategory — tagged lines default to the tag's own category */
  /* karat (above, near goldRate) doubles as the MakingCharge master's other match key —
    tagged lines default it to the tag's own metalKarat when omitted, same as categoryId. */
  tagId?: string; /* optional link to real inventory — see JewelryTag */
  materialSale?: boolean; /* a loose-metal line sold out of the Metal Vault (no tagId): `karat` + netGoldWeight x quantity grams
    leave the vault with the bill (rejected if the vault is short) and come back on a return/void. */
  materialBreakdown?: unknown; /* this bill's own material rows + MC/VA rates (shared/materialBreakdown.ts). When present
    the server recomputes the line as a flat price from it (rateType/goldRate/makingCharge/stoneValue from the client are
    ignored) and stores it on the InvoiceItem. Never touches the JewelryTag. */
  salesPersonId?: string | null; /* the employee credited with this line (a User id of this company). Omit/null = the
    line reports under the invoice's own salesPersonId. */
  id?: string; /* amendInvoice only: the existing InvoiceItem this line replaces. Ignored by createInvoice. */ };

export async function createInvoice(data: {
  clientId: string; invoiceDate: Date; dueDate?: Date; invoiceType: string;
  currency?: string; exchangeRate?: number; discountAmount?: number; otherCharges?: number; notes?: string;
  /** Adjustment to the bill total. Omit to round an INR bill to the nearest rupee automatically; send a number
   *  (0 = none) to key it by hand. Within ±MAX_ROUND_OFF — anything bigger is a discount, not a round-off. */
  roundOff?: number;
  salesPersonId?: string; terms?: string;
  /** Estimates (TagEstimate, status SENT) this invoice bills. Each must be for a tag that is on this invoice; they are
   *  marked INVOICED against it in the same transaction, so an estimate can never be billed twice. */
  estimateIds?: string[];
  // Optional bill-and-collect-in-one-screen payment, split across any number of modes (e.g. part
  // cash, part UPI) in one screen. Each split is applied via the same applyPayment() the
  // standalone recordPayment endpoint uses — see the note on that function.
  payments?: PaymentInput[];
  items: InvoiceItemInput[];
  branchId: string; /* required, direct — never inferred from clientId or from line items
    (see the multi-tenant blueprint's §7 finding). Validated below against the caller's own
    company AND branch-access grant, same as createTag(). */
}, ctx: TenantContext, userId: string) {
  // Layer 2: branch ownership + access — see createTag()'s identical reasoning. Checked first,
  // before any pricing/tag work, so a request for an unauthorized branch fails fast.
  await assertBranchAccessible(data.branchId, ctx);
  await assertSalesPeopleInCompany(ctx, [data.salesPersonId, ...data.items.map((i) => i.salesPersonId)]);

  const { currency, tagIds, items, subtotal, discount, otherCharges, taxableAmount, taxAmount, roundOffExact, totalAmount, discountScale } =
    await priceInvoice(data, ctx);

  // Estimates being billed: each must exist in this company, still be awaiting billing, and be for a piece
  // that is actually a line on this invoice (a quote for ring A cannot be billed against ring B).
  const estimateIds = Array.from(new Set(data.estimateIds ?? []));
  if (estimateIds.length > 0) {
    await assertAllOwned('tagEstimate', estimateIds, ctx.companyId, 'Estimate');
    const estimates = await tenantQuery(ctx.companyId, (tx) => tx.tagEstimate.findMany({
      where: { id: { in: estimateIds }, companyId: ctx.companyId },
      select: { estimateNumber: true, status: true, tagId: true },
    }));
    for (const e of estimates) {
      if (e.status !== 'SENT') throw new AppError(`Estimate ${e.estimateNumber} is not awaiting billing (${e.status})`, 409);
      if (!tagIds.includes(e.tagId)) throw new AppError(`Estimate ${e.estimateNumber} is for a piece that is not on this invoice`, 400);
    }
  }

  // Old gold / store credit splits (payment modes that settle the bill from credit rather than take money).
  // Old metal is valued up front — rate, karat and weights are checked before any tag is touched, so a bad
  // karat or a missing rate fails the bill before it flips inventory it would only have to unwind.
  const oldGoldValuations = new Map<PaymentInput, OldGoldValuation>();
  for (const p of data.payments ?? []) {
    const mode = normalizeMode(p.mode);
    if (!CREDIT_SETTLEMENT_MODES.includes(mode)) continue;
    if (currency !== 'INR') throw new AppError('Old gold and store credit can only be used on a rupee invoice', 400);
    if (mode === PAYMENT_MODE_OLD_GOLD) {
      if (!p.oldGold) throw new AppError('Old gold details (description, karat, weight) are required for an OLD_GOLD payment', 400);
      oldGoldValuations.set(p, await valueOldGold(p.oldGold, p.paymentDate, ctx));
    }
  }

  const advancePayments = (data.payments ?? []).filter((p) => normalizeMode(p.mode) === PAYMENT_MODE_CUSTOMER_ADVANCE);
  if (advancePayments.length > 0 && currency !== 'INR') throw new AppError('Customer advances can only be applied to a rupee invoice', 400);
  for (const p of advancePayments) {
    if (typeof p.amount !== 'number' || !(p.amount > 0) || Math.abs(p.amount * 100 - Math.round(p.amount * 100)) > 1e-6) throw new AppError('Customer advance amount must be positive with at most 2 decimal places', 400);
  }

  const invoice = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoiceNumber = await nextDocumentNumber(ctx.companyId, 'INV', 'INV', tx, gstFinancialYear(data.invoiceDate));

    // F3: dealer credit limit — checked first, before any tag is touched, so a sale that's going
    // to be rejected doesn't flip inventory it'll just have to unwind.
    // Layer 2: clientId is explicitly scoped to ctx.companyId — a Company-B clientId must fail
    // here (404, "not found") exactly like a nonexistent id, not proceed to be billed against.
    // Spending store credit: lock the customer's row first so the balance below is read, and the credit consumed,
    // one transaction at a time — a memo conversion / second invoice for the same customer waits here and then sees
    // the reduced credit (the invoice-number lock alone does not serialise those other writers).
    if ((data.payments ?? []).some((p) => normalizeMode(p.mode) === PAYMENT_MODE_STORE_CREDIT)) {
      await tx.$queryRaw`SELECT "id" FROM "clients" WHERE "id" = ${data.clientId} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
    }
    const client = await tx.client.findUnique({ where: { id: data.clientId } });
    if (!client || client.companyId !== ctx.companyId) {
      throw new AppError('Client not found', 404);
    }
    assertClientActive(client);
    // Customer advances settle part of this bill straight away, so they count toward the credit-limit test: the
    // exposure that is left is the bill minus what the advances pay. Locked and validated here, before any tag is
    // touched, from the server's own rows — never a client-supplied balance.
    let advanceCover = 0;
    if (advancePayments.length > 0) {
      await lockAdvances(tx, ctx.companyId, advancePayments.map((p) => p.advanceId as string));
      const drawn = new Map<string, number>();
      for (const p of advancePayments) {
        const { remaining } = await loadSpendableAdvance(tx, ctx.companyId, p.advanceId, data.clientId);
        const used = round2((drawn.get(p.advanceId!) ?? 0) + p.amount);
        if (used > remaining + 0.005) throw new AppError(`Advance has only ${remaining.toFixed(2)} available; ${used.toFixed(2)} was asked for`, 409);
        drawn.set(p.advanceId!, used);
        advanceCover += p.amount;
      }
      if (advanceCover > totalAmount + 0.005) throw new AppError('Customer advances applied are more than the bill total', 400);
    }
    checkCreditLimit(client, round2(totalAmount - advanceCover));
    // Credit the customer already holds, read BEFORE this invoice's own debit below. Negative currentBalance =
    // money we owe them (from a return, or an earlier exchange). No row lock is needed to spend it safely: the
    // INV number just taken above locks this company's invoice-number row until commit, so two invoices can
    // never read the same credit at once, and nothing else in the system spends credit.
    let creditAvailable = Math.max(-Number(client.currentBalance), 0);
    // Rule 114B: a sale above ₹2,00,000 needs the customer's PAN (or a Form 60 on file). Rupee
    // sales only — the threshold is in rupees, and an export invoice has no PAN to quote.
    if (currency === 'INR') assertPanIfRequired(client, totalAmount);

    // Validate -> flip -> link (same pattern as convertMemoToInvoice), but guarded: unlike the
    // memo path, a direct sale has no prior reservation step, so the flip itself must be
    // conditional. A friendly pre-check gives a clear error in the common case; the count-checked
    // updateMany below is the authoritative guard — it atomically flips only rows still IN_STOCK,
    // so a concurrent sale of the same tag loses the race here, not after partial work is done.
    // Sum of tagged lines' own JewelryTag.costPrice — the F1 COGS entry below. costPrice stays
    // immutable by sales (CLAUDE.md rule); this only reads it, never writes it back.
    let cogsAmount = 0;
    if (tagIds.length > 0) {
      // Layer 2, again, inside the transaction: this is the query that actually flips tag
      // status below, so it is re-scoped to companyId here too, not just at the earlier
      // pricing-enrichment lookup — a forged Company-B tagId must be rejected at the exact
      // point it would otherwise be mutated, not just fail to price nicely.
      const tags = await tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } });
      const foundIds = new Set(tags.map((t) => t.id));
      const missing = tagIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);
      }
      const notAvailable = tags.filter((t) => t.status !== 'IN_STOCK');
      if (notAvailable.length > 0) {
        throw new AppError(
          `Tags not available: ${notAvailable.map((t) => t.tagNumber).join(', ')}`, 409
        );
      }

      const flipped = await tx.jewelryTag.updateMany({
        where: { id: { in: tagIds }, status: 'IN_STOCK', companyId: ctx.companyId },
        data: { status: 'SOLD' },
      });
      if (flipped.count !== tagIds.length) {
        throw new AppError('One or more items were sold by another transaction just now', 409);
      }

      cogsAmount = tags.reduce((s, t) => s + Number(t.costPrice), 0);
    }

    // Material (loose-metal) lines: the weight leaves the Metal Vault in this same transaction — a short vault rejects
    // the whole bill (tag flips above included roll back with it). Each line gets its id up front so its vault
    // movements can name it as their cause (the idempotency key a later return/void restores against).
    const materialLineIds = new Map<number, string>();
    for (const [idx, it] of items.entries()) {
      if (!it.materialSale) continue;
      const lineId = randomUUID();
      materialLineIds.set(idx, lineId);
      const { cost } = await consumeVaultMetal(tx, ctx.companyId, {
        karat: it.karat!, weight: it.netGoldWeight * it.quantity,
        meta: { referenceType: 'InvoiceItem', referenceId: lineId, userId, branchId: data.branchId },
      });
      cogsAmount += cost;
    }

    // GST record prep — resolved BEFORE the invoice/items are written, so each line's own
    // cgst/sgst/igst can be embedded directly in the createMany below (G1 Part D) instead of a
    // second write pass. cgstAmt/sgstAmt/igstAmt default to 0 (non-INR sale, or a
    // fully-discounted taxableAmount <= 0 sale) and feed the F1 journal entry either way.
    let cgstAmt = 0, sgstAmt = 0, igstAmt = 0;
    let isSameState = false;
    const seller = await resolveSellerRegistration(tx, ctx.companyId, data.branchId);
    let clientStateCode: string | null = null;
    if (currency === 'INR') {
      // A taxable INR sale must never emit an e-invoice claiming zero GST — if this trips, some
      // future change reintroduced a divergent rate calc; fail loudly rather than filing a bad
      // TaxInvoice. (A fully-discounted sale with taxableAmount <= 0 legitimately owes no tax.)
      if (taxableAmount > 0 && taxAmount <= 0) {
        throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
      }
      // G2g-7g: a brand-new invoice dated into an already-FILED/LOCKED GSTR-3B period for this
      // registration must never be created — unlike GSTR-1's document-traceability guard, this is
      // a date-based check, so it also catches a document that doesn't exist yet (see
      // gstr3bFilingProtection.ts's own header for why).
      await assertGstr3bPeriodMutable(tx, ctx.companyId, {
        documentType: 'SALES_INVOICE', documentId: invoiceNumber,
        gstRegistrationId: seller.registrationId, documentDate: data.invoiceDate, action: 'created',
      });
      // B2: client.state is free text (e.g. "Gujarat"), not a GST code — resolve it via the state
      // master before comparing. No confident match (blank/unrecognized — the common case for a
      // lightweight walk-in retail Client) is treated as inter-state, same as before this fix.
      clientStateCode = await resolveStateCode(client.state);
      isSameState = clientStateCode === seller.stateCode;

      ({ cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt } = splitGst(taxAmount, isSameState));
    }

    // G1 Part D: each line's own slice of tax/discount, snapshotted alongside its already-snapshotted
    // taxRate. Zero for a non-INR sale (matches the invoice-level amounts, which are also 0 then).
    const lineTax = allocateLineTax(items, discountScale, currency === 'INR' && isSameState);
    const itemsWithTax = items.map((i, idx) => ({ ...i, ...lineTax[idx], ...(materialLineIds.has(idx) ? { id: materialLineIds.get(idx)! } : {}) }));

    const inv = await tx.salesInvoice.create({
      data: {
        companyId: ctx.companyId, branchId: data.branchId,
        invoiceNumber, clientId: data.clientId, invoiceDate: data.invoiceDate,
        dueDate: data.dueDate, invoiceType: data.invoiceType,
        currency, exchangeRate: data.exchangeRate ?? 1,
        subtotal, discountAmount: discount, otherCharges, taxAmount, roundOff: roundOffExact, totalAmount,
        balanceDue: totalAmount, notes: data.notes,
        salesPersonId: data.salesPersonId ?? null, terms: data.terms ?? null,
        // Every InvoiceItem is stamped with the SAME companyId as its parent invoice —
        // denormalized on purpose (see the multi-tenant blueprint's RLS-denormalization rule)
        // so InvoiceItem can carry its own tenant filter/policy without a correlated subquery
        // up to sales_invoices on every row.
        items: { createMany: { data: itemsWithTax } }, // (no companyId here: this row is written through a COMPOSITE relation, so Prisma fills it from the parent)
      },
      include: { client: true, items: true, salesPerson: { select: { id: true, name: true } } },
    });

    // Create GST tax record if INR invoice — including the immutable seller/buyer snapshot
    // (G1 Part E) so a later Client/Company/registration edit never rewrites this invoice's print.
    if (currency === 'INR') {
      await tx.taxInvoice.create({
        data: {
          companyId: ctx.companyId,
          invoiceId: inv.id,
          gstin: seller.gstin,
          placeOfSupply: clientStateCode ?? client.state ?? '',
          taxableAmount,
          cgst: cgstAmt,
          sgst: sgstAmt,
          igst: igstAmt,
          totalTax: taxAmount,
          sellerRegistrationId: seller.registrationId,
          sellerLegalName: seller.sellerLegalName, sellerTradeName: seller.sellerTradeName,
          sellerStateCode: seller.sellerStateCode, sellerAddress: seller.sellerAddress,
          sellerCity: seller.sellerCity, sellerDistrict: seller.sellerDistrict,
          sellerPincode: seller.sellerPincode, sellerCountry: seller.sellerCountry,
          ...buyerSnapshot(client, clientStateCode),
        },
      });
    }

    // Estimates billed here: count-checked SENT -> INVOICED, so two counters billing the same estimate at once
    // cannot both win (the loser fails here and the whole sale rolls back, tag flip included).
    if (estimateIds.length > 0) {
      const billed = await tx.tagEstimate.updateMany({
        where: { id: { in: estimateIds }, companyId: ctx.companyId, status: 'SENT' },
        data: { status: 'INVOICED', invoiceId: inv.id },
      });
      if (billed.count !== estimateIds.length) {
        throw new AppError('One or more estimates were billed by someone else just now', 409);
      }
    }

    // F1: revenue + GST payable + COGS/inventory in one compound entry — Dr totalAmount (AR) +
    // cogsAmount (COGS) must equal Cr taxableAmount (Revenue) + taxAmount (GST) + cogsAmount
    // (Inventory) + roundOff, which holds by construction (totalAmount = taxableAmount + taxAmount + roundOff).
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: data.invoiceDate, description: `Sales Invoice ${invoiceNumber}`,
      referenceType: 'SalesInvoice', referenceId: inv.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, credit: taxableAmount },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, credit: cgstAmt },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, credit: sgstAmt },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, credit: igstAmt },
        // Billed up to the rupee = credit; billed down = debit (postAutoJournalEntry drops a zero line).
        { accountCode: LEDGER_ACCOUNT.ROUND_OFF, credit: roundOffExact > 0 ? roundOffExact : 0, debit: roundOffExact < 0 ? -roundOffExact : 0 },
        { accountCode: LEDGER_ACCOUNT.COST_OF_GOODS, debit: cogsAmount },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, credit: cogsAmount },
      ],
    });

    // Debit client account for the sale
    await tx.client.update({
      where: { id: data.clientId },
      data: { currentBalance: { increment: totalAmount } },
    });

    // Optional bill-and-collect-in-one-screen payment, possibly split across several modes.
    // Applied one split at a time via the same applyPayment() the standalone recordPayment
    // endpoint uses — each split's client.currentBalance credit-back nets correctly against the
    // debit just above, in the same transaction. runningInvoice carries paidAmount forward split
    // to split so each one's "amount so far" is correct, not just the pre-payment total.
    if (data.payments && data.payments.length > 0) {
      let runningInvoice = inv;
      for (const p of data.payments) {
        const mode = normalizeMode(p.mode);
        const remaining = Math.max(Number(inv.totalAmount) - Number(runningInvoice.paidAmount), 0);
        let result: { paidAmount: number } | null;

        if (mode === PAYMENT_MODE_OLD_GOLD) {
          // The customer's old metal: booked exactly like a standalone exchange (client credited, metal into the
          // vault, Dr Inventory / Cr AR), then that fresh credit is used to settle this bill. If the metal is worth
          // more than what is still due, only the due part settles the bill — the rest stays as credit on the
          // customer's account for next time (it is already in currentBalance).
          const v = oldGoldValuations.get(p)!;
          const exchange = await bookOldGoldExchange(tx, ctx, userId, { clientId: data.clientId, ...p.oldGold!, notes: p.notes, branchId: data.branchId }, v, METAL_MOVEMENT.OLD_GOLD_EXCHANGE);
          const settle = round2(Math.min(v.valuedAmount, remaining));
          result = settle > 0.005
            ? await applyPayment(tx, ctx.companyId, runningInvoice, {
                ...p, amount: settle, referenceNo: exchange.exchangeNumber, notes: p.oldGold!.description,
              }, userId, { fromCredit: true })
            : null;
        } else if (mode === PAYMENT_MODE_STORE_CREDIT) {
          if (!(p.amount > 0)) throw new AppError('Store credit amount must be positive', 400);
          if (p.amount > creditAvailable + 0.005) {
            throw new AppError(`Only ${round2(creditAvailable)} of store credit is available for ${client.name}; ${p.amount} was asked for`, 400);
          }
          if (p.amount > remaining + 0.005) {
            throw new AppError(`Store credit of ${p.amount} is more than the ${round2(remaining)} still due on this bill`, 400);
          }
          creditAvailable -= p.amount;
          result = await applyPayment(tx, ctx.companyId, runningInvoice, p, userId, { fromCredit: true });
        } else if (mode === PAYMENT_MODE_CUSTOMER_ADVANCE) {
          if (p.amount > remaining + 0.005) {
            throw new AppError(`Customer advance of ${p.amount} is more than the ${round2(remaining)} still due on this bill`, 400);
          }
          result = await applyPayment(tx, ctx.companyId, runningInvoice, p, userId, { advanceId: p.advanceId });
        } else {
          result = await applyPayment(tx, ctx.companyId, runningInvoice, p, userId);
        }
        if (result) runningInvoice = { ...runningInvoice, paidAmount: result.paidAmount as any };
      }
      return tx.salesInvoice.findUniqueOrThrow({
        where: { id: inv.id },
        include: { client: true, items: true, salesPerson: { select: { id: true, name: true } } },
      });
    }

    return inv;
  });

  await createAuditEntry('sales_invoices', invoice.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return invoice;
}

// Prices an invoice's lines and totals — everything createInvoice and amendInvoice must compute identically: per-line
// pricing (FIXED / PER_GRAM, master rates, making charge + VA%), per-line GST by HSN, discount spreading, round-off.
// Read-only: it touches no stock and writes nothing, so it can run before any transaction opens.
async function priceInvoice(
  data: { invoiceDate: Date; currency?: string; discountAmount?: number; otherCharges?: number; roundOff?: number; items: InvoiceItemInput[] },
  ctx: TenantContext,
) {
  // Layer 2: a line's categoryId is a company-owned master id supplied by the client and stored on
  // the InvoiceItem — a Company-B category must 404, never attach to this invoice.
  await assertAllOwned('productCategory', data.items.map((i) => i.categoryId), ctx.companyId, 'Category');

  // Tag-aware lines are optional: tagged (real inventory) and free-text lines coexist.
  const tagIds = data.items.map((i) => i.tagId).filter(Boolean) as string[];
  if (new Set(tagIds).size !== tagIds.length) {
    throw new AppError('The same tag cannot appear on more than one line of an invoice', 400);
  }

  // A tagged line's category defaults to the tag's own (ProductCategory, already on JewelryTag) —
  // read-only enrichment, not an authorization check; the transaction below still validates each
  // tag's existence/availability independently. makeType rides along for the C3 making-charge
  // lookup below (a free-text line has no makeType to match on).
  //
  // Layer 2, not RLS: companyId is included in this `where` explicitly. A Company-B tagId
  // supplied here simply won't resolve (PostgreSQL FK checks alone would NOT catch this later —
  // referential-integrity checks bypass RLS — so this explicit filter, not the eventual FK
  // insert, is what prevents a cross-company tag from ever being priced/linked onto this
  // invoice). The existing "missing tag" validation a few lines below (tagIds.length vs
  // resolved count) does double duty as the tenant check for free — a Company-B id simply comes
  // back as "not found," same error as a nonexistent id.
  const tagInfoById = tagIds.length > 0
    ? new Map(
        (await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findMany({
          where: { id: { in: tagIds }, companyId: ctx.companyId },
          // saleMcRate/saleVaPercent: whatever was actually decided for this piece at tagging time
          // (see JewelryTag's schema comment) — preferred below over a fresh MakingCharge master
          // lookup, so a later master-rate change never silently re-prices an already-tagged piece.
          select: { id: true, categoryId: true, makeType: true, metalKarat: true, saleMcRate: true, saleVaPercent: true },
        }))).map((t) => [t.id, t])
      )
    : new Map<string, { categoryId: string | null; makeType: string; metalKarat: string | null; saleMcRate: any; saleVaPercent: any }>();

  // Per-line GST (B1): each line's HSN determines its own rate. Resolved once, up front, and the
  // rate is copied onto the row (like costPrice on JewelryTag) — a later change to the HSN master
  // must not silently reprice a past invoice. DEFAULT_HSN_CODE is always fetched too, regardless
  // of what lines request, since otherCharges (below) is taxed at that rate independent of lines.
  const hsnCodesRequested = Array.from(new Set([
    ...data.items.map((i) => i.hsnCode ?? DEFAULT_HSN_CODE), DEFAULT_HSN_CODE,
  ]));
  const hsnRows = await prisma.hsnCode.findMany({
    where: { code: { in: hsnCodesRequested }, isActive: true },
  });
  const hsnByCode = new Map(hsnRows.map((h) => [h.code, h]));
  const missingHsn = hsnCodesRequested.filter((c) => !hsnByCode.has(c));
  if (missingHsn.length > 0) {
    throw new AppError(`Unknown or inactive HSN code(s): ${missingHsn.join(', ')}`, 400);
  }

  // Resolved here (not after the items map, as before) — the market-rate lookup below needs it
  // too, and it must still be the one value the tax-rate calc and invoice row write both use.
  const currency = data.currency ?? 'INR';

  // C2: a PER_GRAM line that omits goldRate prices off today's MetalRate for its karat, as of
  // invoiceDate — not a hand-typed number. Resolved once per distinct karat, up front, same
  // pattern as the HSN batch above.
  const karatsNeedingRate = Array.from(new Set(
    data.items
      .filter((i) => i.rateType !== 'FIXED' && (i.goldRate === undefined || i.goldRate === null) && i.karat)
      .map((i) => i.karat!)
  ));
  const rateByKarat = new Map<string, number>();
  for (const karat of karatsNeedingRate) {
    const rate = await resolveMetalRate(ctx.companyId, karat, data.invoiceDate, currency);
    if (!rate) throw new AppError(`No metal rate found for ${karat} on or before ${data.invoiceDate.toDateString()}`, 404);
    rateByKarat.set(karat, Number(rate.ratePerGram));
  }

  // C3 (extended): a PER_GRAM line missing an explicit makingCharge/wastagePercent pulls the
  // MakingCharge master's rate for its karat + category (+ tag's makeType, if tagged) — e.g. 22K
  // gold necklaces can carry a different VA% than 18K bangles. Loaded once, unfiltered: this is a
  // small admin-maintained rate card (not a transactional table), and a wildcard row (karat/
  // category left blank on the master row, meaning "any") has no fixed value to batch-filter by,
  // so trying to scope the query would risk silently excluding the very wildcard fallback rows
  // this lookup depends on.
  const makingChargeRows = await tenantQuery(ctx.companyId, (_tx) => _tx.makingCharge.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    orderBy: { effectiveDate: 'desc' },
  }));
  // Most-specific-match-wins across three independent dimensions: a row only matches when every
  // field IT has pinned (non-null) agrees with the line — a null field on the row means "any" for
  // that dimension. Among matches, the row pinning the most dimensions wins (e.g. karat+category
  // beats category-only), and effectiveDate desc (the query's own order) breaks ties.
  function findMakingCharge(
    categoryId: string | null | undefined,
    karat: string | null | undefined,
    makeType: string | null | undefined,
  ) {
    const eligible = makingChargeRows.filter((m) =>
      (m.categoryId == null || m.categoryId === categoryId) &&
      (m.karat == null || m.karat === karat) &&
      (m.makeType == null || m.makeType === makeType)
    );
    if (eligible.length === 0) return undefined;
    const specificity = (m: typeof eligible[number]) =>
      (m.categoryId != null ? 1 : 0) + (m.karat != null ? 1 : 0) + (m.makeType != null ? 1 : 0);
    const bestScore = Math.max(...eligible.map(specificity));
    return eligible.find((m) => specificity(m) === bestScore);
  }

  const items = data.items.map((line) => {
    // A line carrying a material breakdown is priced from it, as a flat amount, whatever else the client sent.
    const bd = line.materialBreakdown != null ? priceMaterialBreakdown(line.materialBreakdown) : null;
    const i: InvoiceItemInput = bd
      ? { ...line, rateType: 'FIXED', goldRate: bd.total, makingCharge: bd.making, wastagePercent: 0, stoneValue: bd.otherMaterials }
      : line;
    const { hsnCode, categoryId, uqc: uqcInput, id: _lineId, materialBreakdown: _bd, ...rest } = i; // id never reaches the row data
    // rateType 'FIXED': goldRate IS the decided flat unit price (e.g. a tag's own JewelryTag.sellingPrice)
    // — used as-is, no metal-value math. Anything else ('PER_GRAM', the default): goldRate is ₹/gram,
    // either explicit or resolved above from today's MetalRate (C2).
    if (i.rateType === 'FIXED' && (i.goldRate === undefined || i.goldRate === null)) {
      throw new AppError('FIXED-rate lines require an explicit goldRate', 400);
    }
    const goldRate = i.goldRate ?? (i.karat ? rateByKarat.get(i.karat) : undefined);
    if (goldRate === undefined) {
      throw new AppError('goldRate or karat (to resolve today\'s rate) is required', 400);
    }
    if (i.materialSale) {
      if (i.tagId) throw new AppError('A material sale line cannot also carry a tag', 400);
      if (!i.karat) throw new AppError('A material sale line needs the metal karat/purity it is drawn from', 400);
      if (!(i.netGoldWeight > 0)) throw new AppError('A material sale line needs a weight to sell', 400);
      if (!Number.isInteger(i.quantity) || i.quantity < 1) throw new AppError('A material sale line needs a quantity of at least 1', 400);
      if (bd) throw new AppError('A material sale line cannot carry a material breakdown', 400);
    }
    const tagInfo = i.tagId ? tagInfoById.get(i.tagId) : undefined;
    const resolvedCategoryId = categoryId ?? tagInfo?.categoryId ?? null;
    const resolvedKarat = i.karat ?? tagInfo?.metalKarat ?? null;

    // VA% marks up the making charge (same formula NewTagPage.tsx already uses for the
    // MakingCharge master's wastagePercent — reused, not reinvented). FIXED-rate lines ignore
    // both, same as they already ignore netGoldWeight/goldRate math: goldRate is the whole price.
    //
    // Resolution order per field: an explicit request value always wins; otherwise a tagged line
    // prefers the tag's OWN settled saleMcRate/saleVaPercent (whatever was actually decided when
    // the piece was priced — see JewelryTag's schema comment) over a fresh master lookup, so a
    // later master-rate change never silently re-prices an already-tagged piece; only an untagged
    // line, or a tag that predates that column, falls back to the master.
    const tagSaleMcRate = tagInfo?.saleMcRate != null ? Number(tagInfo.saleMcRate) : undefined;
    const tagSaleVaPercent = tagInfo?.saleVaPercent != null ? Number(tagInfo.saleVaPercent) : undefined;
    const masterCharge = i.rateType !== 'FIXED' && (tagSaleMcRate === undefined || tagSaleVaPercent === undefined)
      ? findMakingCharge(resolvedCategoryId, resolvedKarat, tagInfo?.makeType)
      : undefined;
    const makingCharge = i.makingCharge ?? (tagSaleMcRate !== undefined
      ? tagSaleMcRate * i.netGoldWeight
      : masterCharge
        ? (masterCharge.makingChargeType === 'PER_GRAM'
            ? Number(masterCharge.makingCharge) * i.netGoldWeight
            : Number(masterCharge.makingCharge))
        : 0);
    const wastagePercent = i.wastagePercent ?? (tagSaleVaPercent !== undefined
      ? tagSaleVaPercent
      : masterCharge ? Number(masterCharge.saleWastagePercent) : 0);

    const effectiveMakingCharge = makingCharge * (1 + wastagePercent / 100);
    const unitPrice = i.rateType === 'FIXED'
      ? goldRate
      : i.netGoldWeight * goldRate + effectiveMakingCharge + (i.stoneValue ?? 0);
    const totalPrice = unitPrice * i.quantity;
    const hsn = hsnByCode.get(hsnCode ?? DEFAULT_HSN_CODE)!;
    // G2g-3a: an explicit line uqc is validated (case-insensitive) against the GST UQC catalog and
    // used as-is; omitted falls back to the line's own HSN's defaultUqc — resolved and snapshotted
    // here, once, at sale time, never re-derived later (see InvoiceItem.uqc's schema comment).
    let uqc: string | null;
    if (uqcInput !== undefined && uqcInput !== null) {
      const normalized = normalizeGstUqc(uqcInput);
      if (!normalized) throw new AppError(`Unknown GST UQC: ${uqcInput}`, 400);
      uqc = normalized;
    } else {
      uqc = hsn.defaultUqc ?? null;
    }
    return {
      ...rest, tagId: i.tagId ?? null, materialSale: !!i.materialSale, goldRate, makingCharge, wastagePercent,
      // Stored as the bill's own record; an amended line that no longer carries one clears the old copy.
      materialBreakdown: bd ? (bd.normalized as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      stoneWeight: i.stoneWeight ?? 0, stoneValue: i.stoneValue ?? 0, unitPrice, totalPrice,
      hsnCodeId: hsn.id, taxRate: Number(hsn.gstRate), uqc,
      categoryId: resolvedCategoryId,
    };
  });

  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const discount = data.discountAmount ?? 0;
  const otherCharges = data.otherCharges ?? 0;
  // otherCharges (shipping/packing/misc — GATI's "Add & Less") is taxable base like the lines
  // themselves, not tied to any one line: Gross (subtotal) + otherCharges - discount = taxable.
  const taxableAmount = subtotal + otherCharges - discount;
  // Each line is taxed at its own HSN rate; a discount is spread proportionally across lines by
  // value (reduces to the old taxableAmount * flatRate exactly when every line shares one rate).
  // otherCharges is taxed separately at the default HSN rate — it isn't tied to any line, so it
  // can't be spread by the same per-line scale (that scale is 0 when subtotal is 0, which would
  // silently drop otherCharges' tax entirely on a line-less or all-zero-value sale).
  const discountScale = subtotal > 0 ? (subtotal - discount) / subtotal : 0;
  const defaultHsnRate = Number(hsnByCode.get(DEFAULT_HSN_CODE)!.gstRate);
  const taxAmount = currency === 'INR'
    ? items.reduce((s, i) => s + i.totalPrice * discountScale * i.taxRate, 0) + otherCharges * defaultHsnRate
    : 0;
  const preRoundTotal = taxableAmount + taxAmount;
  // Round-off: automatic to the nearest rupee on an INR bill unless the biller keyed a figure. Kept unrounded here so
  // the journal below balances to the paisa; the row stores it at 2 dp.
  if (data.roundOff !== undefined && data.roundOff !== null) {
    if (typeof data.roundOff !== 'number' || !Number.isFinite(data.roundOff) || Math.abs(data.roundOff) > MAX_ROUND_OFF) {
      throw new AppError(`Round-off must be a number within ±₹${MAX_ROUND_OFF} — use Discount for a larger adjustment`, 400);
    }
  }
  const roundOffExact = data.roundOff != null
    ? data.roundOff
    : currency === 'INR' ? Math.round(preRoundTotal) - preRoundTotal : 0;
  const totalAmount = preRoundTotal + roundOffExact;

  return {
    currency, tagIds, items, lineIds: data.items.map((i) => i.id), subtotal, discount, otherCharges, taxableAmount, taxAmount,
    roundOffExact, totalAmount, discountScale,
  };
}

// G1 Part E: resolves which GST registration a sale is invoiced under — the invoice's own branch
// link, else the company's primary active registration, else (a company with neither — e.g. one
// that never set up a GSTIN at all) a legacy fallback built straight from the Company row, so the
// long-standing `company.gstin ?? 'N/A'` behavior for such a company is completely unchanged.
// companyId/branchId are both already-scoped by the caller (assertBranchAccessible ran first).
async function resolveSellerRegistration(tx: Prisma.TransactionClient, companyId: string, branchId: string) {
  const [branch, company] = await Promise.all([
    tx.branch.findUniqueOrThrow({ where: { id: branchId }, select: { gstRegistrationId: true } }),
    tx.company.findUniqueOrThrow({ where: { id: companyId } }),
  ]);

  const reg = branch.gstRegistrationId
    ? await tx.companyGstRegistration.findFirst({ where: { id: branch.gstRegistrationId, companyId, isActive: true } })
    : await tx.companyGstRegistration.findFirst({ where: { companyId, isPrimary: true, isActive: true } });

  if (reg) {
    return {
      registrationId: reg.id as string | null, gstin: reg.gstin, stateCode: reg.stateCode,
      sellerLegalName: reg.legalName as string | null, sellerTradeName: reg.tradeName,
      sellerStateCode: reg.stateCode as string | null, sellerAddress: reg.address,
      sellerCity: reg.city, sellerDistrict: reg.district, sellerPincode: reg.pincode, sellerCountry: reg.country as string | null,
    };
  }
  return {
    registrationId: null as string | null, gstin: company.gstin ?? 'N/A', stateCode: company.stateCode ?? '',
    sellerLegalName: company.name as string | null, sellerTradeName: null as string | null,
    sellerStateCode: company.stateCode as string | null, sellerAddress: company.address,
    sellerCity: null as string | null, sellerDistrict: null as string | null, sellerPincode: null as string | null,
    sellerCountry: 'India' as string | null,
  };
}

// G1 Part E: the buyer's immutable snapshot, captured from the Client row exactly as it reads at
// invoice-creation time. resolvedStateCode is whatever the caller already resolved via
// resolveStateCode(client.state) (shared across the same-state tax split, so never re-resolved here).
function buyerSnapshot(
  client: { name: string; gstNumber: string | null; panNumber: string | null; address: string | null; city: string | null; state: string | null; pincode: string | null; country: string | null },
  resolvedStateCode: string | null,
) {
  return {
    buyerName: client.name, buyerGstin: client.gstNumber, buyerPan: client.panNumber,
    buyerAddress: client.address, buyerCity: client.city, buyerState: client.state,
    buyerStateCode: resolvedStateCode, buyerPincode: client.pincode, buyerCountry: client.country ?? 'India',
  };
}

// G1 Part D: each line's own slice of the invoice's discount/tax, split same-state/inter-state
// exactly like the invoice-level TaxInvoice.cgst/sgst/igst split (createInvoice/amendInvoice/
// convertMemoToInvoice all compute isSameState once and pass it in here) — never a second,
// divergent tax calculation, just the same numbers broken out per line for e-invoice readiness.
function allocateLineTax<T extends { totalPrice: number; taxRate: number }>(
  items: T[], discountScale: number, isSameState: boolean,
) {
  return items.map((i) => {
    const taxableValue = round2(i.totalPrice * discountScale);
    const lineTax = round2(taxableValue * Number(i.taxRate));
    return {
      taxableValue,
      lineDiscountAmount: round2(i.totalPrice - taxableValue),
      cgstAmount: isSameState ? round2(lineTax / 2) : 0,
      sgstAmount: isSameState ? round2(lineTax / 2) : 0,
      igstAmount: isSameState ? 0 : lineTax,
      lineTotalTax: lineTax,
    };
  });
}

// Edit an issued invoice — lines, prices, discount, GST, customer, dates, everything. Gated by `invoice:edit`
// (SUPER_ADMIN, or a role that has been granted it). The body is the invoice's full NEW state: `items` replaces the
// lines (a line carrying an existing InvoiceItem `id` is updated in place, one without is added, an existing line left
// out is removed); the header fields are optional and keep their value when omitted.
//
// It is an amendment, not a silent rewrite, all in ONE transaction:
//   - stock: a piece taken off the bill goes back to IN_STOCK, a piece added is flipped to SOLD (count-checked, same
//     guard as createInvoice) — a piece that stays is not touched;
//   - ledger: the original entries are never edited or deleted. One adjustment entry is posted for the DIFFERENCE
//     (revenue, GST, round-off, COGS/inventory, receivable), so the books show the sale and then the amendment;
//   - the customer's balance moves by the difference in the bill total (payments stay exactly as recorded, so the
//     invoice's paid / due / status are re-derived from them — a bill cut below what was paid shows a negative due);
//   - the GST record is rewritten to match; the audit log keeps the full before/after (lines included) and the reason.
// Lines that were returned (D1) are locked: the return already reversed them. A payment or return also pins the
// customer, since those rows belong to whoever was billed.
export async function amendInvoice(invoiceId: string, data: {
  clientId?: string; invoiceDate?: Date; dueDate?: Date | null; invoiceType?: string;
  discountAmount?: number; otherCharges?: number; roundOff?: number;
  salesPersonId?: string | null; terms?: string | null; notes?: string | null;
  reason?: string;
  items: InvoiceItemInput[];
}, ctx: TenantContext, userId: string) {
  if (!Array.isArray(data.items) || data.items.length === 0) throw new AppError('An invoice needs at least one line', 400);

  await assertOwnedByCompany('salesInvoice', invoiceId, ctx.companyId, 'Invoice');
  const head = await tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.findUniqueOrThrow({
    where: { id: invoiceId }, select: { branchId: true, currency: true, invoiceDate: true, clientId: true },
  }));
  await assertBranchAccessible(head.branchId, ctx);
  if (data.clientId && data.clientId !== head.clientId) await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  if (data.salesPersonId) {
    const member = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.count({ where: { companyId: ctx.companyId, userId: data.salesPersonId! } }));
    if (member === 0) throw new AppError('Sales executive not found', 404);
  }
  // Line attribution: an employee already credited on this invoice's stored lines may stay (even if since deactivated).
  const storedLineSales = await tenantQuery(ctx.companyId, (tx) => tx.invoiceItem.findMany({
    where: { invoiceId, companyId: ctx.companyId, salesPersonId: { not: null } }, select: { salesPersonId: true },
  }));
  await assertSalesPeopleInCompany(ctx, data.items.map((i) => i.salesPersonId), new Set(storedLineSales.map((r) => r.salesPersonId!)));
  const lineIdsIn = data.items.map((i) => i.id).filter(Boolean) as string[];
  if (new Set(lineIdsIn).size !== lineIdsIn.length) throw new AppError('The same invoice line appears twice', 400);

  const invoiceDate = data.invoiceDate ?? head.invoiceDate;
  const priced = await priceInvoice({
    invoiceDate, currency: head.currency, discountAmount: data.discountAmount, otherCharges: data.otherCharges,
    roundOff: data.roundOff, items: data.items,
  }, ctx);
  const { currency, tagIds: newTagIds, items, lineIds, subtotal, discount, otherCharges, taxableAmount, taxAmount, roundOffExact, discountScale } = priced;
  const newTotal = round2(priced.totalAmount);

  const snapshot = (inv: any) => JSON.parse(JSON.stringify({
    invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, invoiceType: inv.invoiceType, clientId: inv.clientId,
    salesPersonId: inv.salesPersonId, terms: inv.terms, notes: inv.notes,
    subtotal: inv.subtotal, discountAmount: inv.discountAmount, otherCharges: inv.otherCharges, taxAmount: inv.taxAmount,
    roundOff: inv.roundOff, totalAmount: inv.totalAmount, paidAmount: inv.paidAmount, balanceDue: inv.balanceDue, status: inv.status,
    items: inv.items.map((i: any) => ({
      id: i.id, productCode: i.productCode, description: i.description, tagId: i.tagId, quantity: i.quantity,
      netGoldWeight: i.netGoldWeight, rateType: i.rateType, goldRate: i.goldRate, makingCharge: i.makingCharge,
      wastagePercent: i.wastagePercent, stoneValue: i.stoneValue, taxRate: i.taxRate, totalPrice: i.totalPrice,
    })),
  }));

  // G2g-6d: the whole `tenantTransaction` call is wrapped so a `Gstr1FilingProtectionError` thrown
  // by the guard inside it can still be audited (brief §18) once the transaction has aborted — an
  // IIFE, not a pre-declared `let`, so `before`/`after`/`updated` keep their real inferred types
  // rather than widening to `any`.
  const { before, after, updated } = await (async () => {
    try {
      return await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise amendments of the same invoice, then read its state FRESH — payments, returns and tag statuses as
    // they are now, not as they were when the screen was opened.
    await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const inv = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        items: true, taxDetails: true, payments: { select: { id: true } },
        returns: { include: { items: { select: { invoiceItemId: true } } } },
        // G2c: a Credit Note also locks its touched lines (§5.3) — rewriting a line a Credit Note
        // already referenced would invalidate that document's own immutable snapshot.
        creditNotes: { select: { items: { select: { invoiceItemId: true } } } },
      },
    });
    // J3 Decision 5: a voided invoice is closed — no further amend, payment, or return against it.
    if (inv.status === 'VOID') throw new AppError('This invoice has been voided and cannot be amended', 409);
    // A material (vault) line moved metal out of the Metal Vault when it was billed; re-pricing it in place would leave
    // the vault and the bill disagreeing. Void the bill and issue a new one instead.
    if (inv.items.some((i) => i.materialSale) || items.some((i) => i.materialSale)) {
      throw new AppError('An invoice with a material (Metal Vault) line cannot be amended — void it and issue a new one', 409);
    }
    // G1 Part N: the same IRN guard voidInvoice already has (sales.service.ts's voidInvoice,
    // below) — an e-invoice with a live IRN can never be silently rewritten in-app; the only
    // legal corrections after IRN generation are a GST credit/debit note or an IRP cancellation,
    // neither of which this amend path performs.
    if (inv.taxDetails?.irn) {
      throw new AppError('An e-invoice (IRN) has already been generated for this invoice — it cannot be amended in-app; a GST credit/debit note or IRN cancellation must be used instead', 409);
    }
    // G2g-6d: an invoice represented in an accepted GSTR-1 filing is closed to a direct rewrite of
    // its own filed tax/reporting facts — the only legal corrections are a later-period Credit/
    // Debit Note or Sales Return, neither of which this amend path is.
    await assertGstr1DocumentMutable(tx, ctx.companyId, {
      documentType: 'SALES_INVOICE', documentId: invoiceId,
      gstRegistrationId: inv.taxDetails?.sellerRegistrationId, action: 'amended',
    });
    // G2g-7g: the invoice's CURRENT period — reject the amend outright if the period it is already
    // reported in is FILED/LOCKED, before any of this edit's own new values are even computed.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_INVOICE', documentId: invoiceId,
      gstRegistrationId: inv.taxDetails?.sellerRegistrationId, documentDate: inv.invoiceDate, action: 'amended',
    });

    const newClientId = data.clientId ?? inv.clientId;
    const clientChanged = newClientId !== inv.clientId;
    if (clientChanged && (inv.payments.length > 0 || inv.returns.length > 0)) {
      throw new AppError('The customer cannot be changed once a payment or return is recorded on this invoice', 409);
    }

    const oldById = new Map(inv.items.map((i) => [i.id, i]));
    for (const id of lineIdsIn) if (!oldById.has(id)) throw new AppError(`Invoice line not found on this invoice: ${id}`, 404);

    // Returned or credited lines are locked — the return has already reversed them (tag back in
    // stock, ledger, customer credit), and a Credit Note's own snapshot must not be invalidated
    // by a later rewrite of the line it referenced (G2c, §5.3).
    const lockedIds = new Set([
      ...inv.returns.flatMap((r) => r.items.map((x) => x.invoiceItemId)),
      ...inv.creditNotes.flatMap((cn) => cn.items.map((x) => x.invoiceItemId).filter((id): id is string => !!id)),
    ]);
    for (const id of lockedIds) {
      const old = oldById.get(id)!;
      const at = lineIds.indexOf(id);
      const now = at >= 0 ? items[at] : undefined;
      if (!now || (now.tagId ?? null) !== old.tagId || now.quantity !== old.quantity || Math.abs(now.totalPrice - Number(old.totalPrice)) > 0.005) {
        throw new AppError(`Line ${old.productCode} has been returned or credited and cannot be changed or removed`, 409);
      }
    }
    const removedIds = inv.items.filter((i) => !lineIdsIn.includes(i.id)).map((i) => i.id);

    // Stock — only pieces that actually enter or leave this bill move.
    const oldTagIds = inv.items.filter((i) => i.tagId).map((i) => i.tagId!);
    const removedTagIds = oldTagIds.filter((t) => !newTagIds.includes(t));
    const addedTagIds = newTagIds.filter((t) => !oldTagIds.includes(t));
    const tagRows = await tx.jewelryTag.findMany({ where: { id: { in: [...oldTagIds, ...newTagIds] }, companyId: ctx.companyId } });
    const tagById = new Map(tagRows.map((t) => [t.id, t]));
    const missing = addedTagIds.filter((t) => !tagById.has(t));
    if (missing.length > 0) throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);
    const unavailable = addedTagIds.map((t) => tagById.get(t)!).filter((t) => t.status !== 'IN_STOCK');
    if (unavailable.length > 0) throw new AppError(`Tags not available: ${unavailable.map((t) => t.tagNumber).join(', ')}`, 409);
    const notSold = removedTagIds.map((t) => tagById.get(t)).filter((t) => !t || t.status !== 'SOLD');
    if (notSold.length > 0) throw new AppError(`Tag(s) not currently SOLD, cannot take off this invoice: ${notSold.map((t) => t?.tagNumber).join(', ')}`, 409);
    if (addedTagIds.length > 0) {
      const flipped = await tx.jewelryTag.updateMany({ where: { id: { in: addedTagIds }, status: 'IN_STOCK', companyId: ctx.companyId }, data: { status: 'SOLD' } });
      if (flipped.count !== addedTagIds.length) throw new AppError('One or more items were sold by another transaction just now', 409);
    }
    if (removedTagIds.length > 0) {
      const flipped = await tx.jewelryTag.updateMany({ where: { id: { in: removedTagIds }, status: 'SOLD', companyId: ctx.companyId }, data: { status: 'IN_STOCK' } });
      if (flipped.count !== removedTagIds.length) throw new AppError('One or more tags changed status just now — retry the edit', 409);
      // A piece taken off the bill is no longer billed by the estimate that quoted it: back to awaiting billing.
      await tx.tagEstimate.updateMany({ where: { companyId: ctx.companyId, invoiceId, tagId: { in: removedTagIds } }, data: { status: 'SENT', invoiceId: null } });
    }
    const costOf = (ids: string[]) => ids.reduce((s, t) => s + Number(tagById.get(t)?.costPrice ?? 0), 0);
    const oldCogs = costOf(oldTagIds);
    const newCogs = costOf(newTagIds);

    // Customer: credit limit / PAN only where this edit makes the customer's position worse.
    const client = await tx.client.findUnique({ where: { id: newClientId } });
    if (!client || client.companyId !== ctx.companyId) throw new AppError('Client not found', 404);
    const oldTotal = Number(inv.totalAmount);
    const delta = round2(newTotal - oldTotal);
    if (clientChanged) checkCreditLimit(client, newTotal);
    else if (delta > 0.005) checkCreditLimit(client, delta);
    if (currency === 'INR' && (clientChanged || delta > 0.005)) assertPanIfRequired(client, newTotal);

    // GST record — same-state vs inter-state is re-resolved from the (possibly new) customer.
    // Seller snapshot is re-resolved too (G1 Part E): an amendment is a deliberate rewrite of this
    // invoice's own state, unlike a later, unrelated Client/Company edit — so it legitimately
    // re-snapshots against whatever the registration/branch/client look like right now.
    let cgstAmt = 0, sgstAmt = 0, igstAmt = 0, isSameState = false;
    let clientStateCode: string | null = null;
    const seller = await resolveSellerRegistration(tx, ctx.companyId, head.branchId);
    if (currency === 'INR') {
      if (taxableAmount > 0 && taxAmount <= 0) throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
      // G2g-7g: also reject if this edit moves the invoice INTO a different, already-FILED/LOCKED
      // period (e.g. the invoiceDate itself is being changed) — the check above only covered the
      // period the invoice is CURRENTLY reported in.
      await assertGstr3bPeriodMutable(tx, ctx.companyId, {
        documentType: 'SALES_INVOICE', documentId: invoiceId,
        gstRegistrationId: seller.registrationId, documentDate: invoiceDate, action: 'amended',
      });
      clientStateCode = await resolveStateCode(client.state);
      isSameState = clientStateCode === seller.stateCode;
      ({ cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt } = splitGst(taxAmount, isSameState));
      const gst = {
        gstin: seller.gstin, placeOfSupply: clientStateCode ?? client.state ?? '',
        taxableAmount, cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt, totalTax: taxAmount,
        sellerRegistrationId: seller.registrationId,
        sellerLegalName: seller.sellerLegalName, sellerTradeName: seller.sellerTradeName,
        sellerStateCode: seller.sellerStateCode, sellerAddress: seller.sellerAddress,
        sellerCity: seller.sellerCity, sellerDistrict: seller.sellerDistrict,
        sellerPincode: seller.sellerPincode, sellerCountry: seller.sellerCountry,
        ...buyerSnapshot(client, clientStateCode),
      };
      if (inv.taxDetails) await tx.taxInvoice.update({ where: { invoiceId }, data: gst });
      else await tx.taxInvoice.create({ data: { companyId: ctx.companyId, invoiceId, ...gst } });
    }

    // G1 Part D: each line's own tax/discount slice, same split as the invoice-level amounts above.
    const lineTax = allocateLineTax(items, discountScale, currency === 'INR' && isSameState);
    const itemsWithTax = items.map((it, idx) => ({ ...it, ...lineTax[idx] }));

    // Lines: update in place, add, remove.
    if (removedIds.length > 0) await tx.invoiceItem.deleteMany({ where: { id: { in: removedIds }, invoiceId, companyId: ctx.companyId } });
    const toCreate: typeof itemsWithTax = [];
    for (let i = 0; i < itemsWithTax.length; i++) {
      if (lineIds[i]) await tx.invoiceItem.update({ where: { id: lineIds[i]! }, data: itemsWithTax[i] });
      else toCreate.push(itemsWithTax[i]);
    }
    if (toCreate.length > 0) await tx.invoiceItem.createMany({ data: toCreate.map((i) => ({ ...i, invoiceId, companyId: ctx.companyId })) });

    // Header. Payments are untouched, so paid / due / status are re-derived from what has actually been received.
    const paid = Number(inv.paidAmount);
    const balanceDue = round2(newTotal - paid);
    const status = paid > 0.005 ? (balanceDue <= 0.005 ? 'PAID' : 'PARTIALLY_PAID') : inv.status;
    const upd = await tx.salesInvoice.update({
      where: { id: invoiceId },
      data: {
        clientId: newClientId, invoiceDate, invoiceType: data.invoiceType ?? inv.invoiceType,
        dueDate: data.dueDate === undefined ? inv.dueDate : data.dueDate,
        salesPersonId: data.salesPersonId === undefined ? inv.salesPersonId : data.salesPersonId,
        terms: data.terms === undefined ? inv.terms : data.terms,
        notes: data.notes === undefined ? inv.notes : data.notes,
        subtotal, discountAmount: discount, otherCharges, taxAmount, roundOff: roundOffExact, totalAmount: newTotal,
        balanceDue, status,
      },
      include: {
        client: true, items: { include: { hsnCode: true, category: true } }, taxDetails: true, payments: true,
        salesPerson: { select: { id: true, name: true } },
      },
    });

    // Ledger: one adjustment entry for the difference. Revenue is the balancing figure, so the entry balances to the
    // paisa even where the stored 2-dp figures round differently from the originals.
    const oldTax = inv.taxDetails;
    const dCgst = round2(cgstAmt - Number(oldTax?.cgst ?? 0));
    const dSgst = round2(sgstAmt - Number(oldTax?.sgst ?? 0));
    const dIgst = round2(igstAmt - Number(oldTax?.igst ?? 0));
    const dRound = round2(roundOffExact - Number(inv.roundOff));
    const dRevenue = round2(delta - dCgst - dSgst - dIgst - dRound);
    const dCogs = round2(newCogs - oldCogs);
    const dr = (v: number) => (v > 0 ? v : 0);      // a positive change in a debit-normal account is a debit
    const cr = (v: number) => (v < 0 ? -v : 0);     // ...and a negative one a credit
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Sales Invoice ${inv.invoiceNumber} amended`,
      referenceType: 'SalesInvoiceAmendment', referenceId: invoiceId, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: dr(delta), credit: cr(delta) },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, debit: cr(dRevenue), credit: dr(dRevenue) },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, debit: cr(dCgst), credit: dr(dCgst) },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, debit: cr(dSgst), credit: dr(dSgst) },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, debit: cr(dIgst), credit: dr(dIgst) },
        { accountCode: LEDGER_ACCOUNT.ROUND_OFF, debit: cr(dRound), credit: dr(dRound) },
        { accountCode: LEDGER_ACCOUNT.COST_OF_GOODS, debit: dr(dCogs), credit: cr(dCogs) },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: cr(dCogs), credit: dr(dCogs) },
      ],
    });

    // Customer balance follows the bill total (a new customer takes the whole bill, the old one gives it up).
    if (clientChanged) {
      await tx.client.update({ where: { id: inv.clientId }, data: { currentBalance: { decrement: oldTotal } } });
      await tx.client.update({ where: { id: newClientId }, data: { currentBalance: { increment: newTotal } } });
    } else if (Math.abs(delta) > 0.005) {
      await tx.client.update({ where: { id: newClientId }, data: { currentBalance: { increment: delta } } });
    }

    return { before: snapshot(inv), after: snapshot(upd), updated: upd };
      });
    } catch (err) {
      await auditGstr1MutationBlocked(err, 'sales_invoices', userId, ctx.companyId);
      await auditGstr3bMutationBlocked(err, 'sales_invoices', userId, ctx.companyId);
      throw err;
    }
  })();

  await createAuditEntry('sales_invoices', invoiceId, userId, 'AMEND', before, { ...after, reason: data.reason ?? null }, ctx.companyId);
  return updated;
}

// J3 Decision 5 (A1 eligibility / B2 GST guard): a whole-invoice reversal, never a hard delete.
// PHASE_J3_DESIGN_AUDIT.md §6 found a raw hard delete unsafe even in its narrowest theoretically-
// reachable case — it would Cascade-wipe InvoiceItem with no recovery, and orphan the
// JournalEntry/JournalLine rows postAutoJournalEntry created alongside the invoice, permanently
// unbalancing the ledger. Void instead reuses exactly createSalesReturn's own proven mechanics (tag
// flip, ledger reversal, client credit), applied to every line and the whole header at once, and
// marks the row VOID rather than removing it — an invoice number that simply vanishes looks worse
// under a GST audit than one explicitly marked void, and GST-return continuity is preserved.
//
// Eligibility (strict, matching amendInvoice's own "customer locked once paid/returned" rule):
// zero InvoicePayment rows, zero SalesReturn rows, not already VOID. Also refuses if
// TaxInvoice.irn is already set — this system has no GST e-invoice IRN-cancellation integration
// (explicitly out of scope, same posture as the already-documented I3 GST-credit-note gap), so a
// Void must never leave this database saying VOID while the tax authority's own record of a live
// e-invoice still stands; that invoice's only remaining correction path is a return for what's on
// it, or a manual, outside-the-system IRN cancellation followed by an administrative decision.
export async function voidInvoice(invoiceId: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to void an invoice', 400);
  await assertOwnedByCompany('salesInvoice', invoiceId, ctx.companyId, 'Invoice');

  const { before, after } = await (async () => {
    try {
      return await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise, then read fresh — same lock amendInvoice takes on the same row, for the same
    // reason: payments/returns as they are right now, not as they were when the screen was opened.
    await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const invoice = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        items: true, taxDetails: true, payments: { select: { id: true } }, returns: { select: { id: true } },
        // G2c (§5.3): a Credit Note is also an irreversible-enough document to block a void.
        creditNotes: { select: { id: true } },
      },
    });
    if (invoice.status === 'VOID') throw new AppError('This invoice has already been voided', 409);
    if (invoice.payments.length > 0) {
      throw new AppError('This invoice already has a payment recorded — void is only for an untouched invoice; reverse the payment first, or use a return for what remains', 409);
    }
    if (invoice.returns.length > 0) {
      throw new AppError('This invoice already has a return recorded against it — void is only for an untouched invoice', 409);
    }
    if (invoice.creditNotes.length > 0) {
      throw new AppError('This invoice already has a credit note recorded against it — void is only for an untouched invoice', 409);
    }
    if (invoice.taxDetails?.irn) {
      throw new AppError('An e-invoice (IRN) has already been generated for this invoice — it cannot be voided in-app; cancel the IRN with the GST portal first', 409);
    }
    // G2g-6d: a filed invoice is closed to a whole-invoice reversal too — same reasoning as
    // amendInvoice's own guard above it.
    await assertGstr1DocumentMutable(tx, ctx.companyId, {
      documentType: 'SALES_INVOICE', documentId: invoiceId,
      gstRegistrationId: invoice.taxDetails?.sellerRegistrationId, action: 'voided',
    });
    // G2g-7g: a whole-invoice reversal into an already-FILED/LOCKED period is exactly the kind of
    // "cancel/reverse" mutation brief §10 calls out — blocked here, not bypassed just because the
    // operation is named Void rather than Edit.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_INVOICE', documentId: invoiceId,
      gstRegistrationId: invoice.taxDetails?.sellerRegistrationId, documentDate: invoice.invoiceDate, action: 'voided',
    });

    const before = {
      status: invoice.status, totalAmount: invoice.totalAmount,
      items: invoice.items.map((i) => ({ id: i.id, tagId: i.tagId, productCode: i.productCode, totalPrice: i.totalPrice })),
    };

    // Stock: every tagged line goes back on the shelf — count-checked exactly like createInvoice's
    // own flip, and createSalesReturn's inverse of it.
    const tagIds = invoice.items.filter((i) => i.tagId).map((i) => i.tagId!);
    let cogsAmount = 0;
    if (tagIds.length > 0) {
      const tags = await tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } });
      const notSold = tags.filter((t) => t.status !== 'SOLD');
      if (notSold.length > 0) throw new AppError(`Tag(s) not currently SOLD, cannot void: ${notSold.map((t) => t.tagNumber).join(', ')}`, 409);
      const flipped = await tx.jewelryTag.updateMany({ where: { id: { in: tagIds }, status: 'SOLD', companyId: ctx.companyId }, data: { status: 'IN_STOCK' } });
      if (flipped.count !== tagIds.length) throw new AppError('One or more tags changed status just now — retry the void', 409);
      cogsAmount = tags.reduce((s, t) => s + Number(t.costPrice), 0);

      // A piece taken off the bill entirely is no longer billed by whatever estimate quoted it —
      // exact mirror of amendInvoice's own removed-line handling.
      await tx.tagEstimate.updateMany({ where: { companyId: ctx.companyId, invoiceId, tagId: { in: tagIds } }, data: { status: 'SENT', invoiceId: null } });
    }

    // Material (vault) lines: the metal goes back to the very lots it came from, at the cost it left at.
    for (const it of invoice.items.filter((i) => i.materialSale)) {
      const { cost } = await restoreVaultMetal(tx, ctx.companyId, {
        saleReferenceType: 'InvoiceItem', saleReferenceId: it.id, weight: Number(it.netGoldWeight) * it.quantity,
        meta: { referenceType: 'InvoiceVoid', referenceId: it.id, userId, branchId: invoice.branchId },
      });
      cogsAmount += cost;
    }

    // F1: exact inverse of createInvoice's own compound entry. taxableAmount is derived from the
    // persisted header (totalAmount = taxableAmount + taxAmount + roundOff, per SalesInvoice.roundOff's
    // own doc comment) rather than re-read from TaxInvoice, so this works for a non-INR invoice too
    // (which has no TaxInvoice row at all).
    const totalAmount = Number(invoice.totalAmount);
    const taxAmount = Number(invoice.taxAmount);
    const roundOffExact = Number(invoice.roundOff);
    const taxableAmount = round2(totalAmount - taxAmount - roundOffExact);
    const cgstAmt = Number(invoice.taxDetails?.cgst ?? 0);
    const sgstAmt = Number(invoice.taxDetails?.sgst ?? 0);
    const igstAmt = Number(invoice.taxDetails?.igst ?? 0);

    await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Void of Sales Invoice ${invoice.invoiceNumber}`,
      referenceType: 'SalesInvoiceVoid', referenceId: invoice.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, debit: taxableAmount },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, debit: cgstAmt },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, debit: sgstAmt },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, debit: igstAmt },
        { accountCode: LEDGER_ACCOUNT.ROUND_OFF, debit: roundOffExact > 0 ? roundOffExact : 0, credit: roundOffExact < 0 ? -roundOffExact : 0 },
        { accountCode: LEDGER_ACCOUNT.COST_OF_GOODS, credit: cogsAmount },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: cogsAmount },
      ],
    });

    await tx.client.update({ where: { id: invoice.clientId }, data: { currentBalance: { decrement: totalAmount } } });

    const updated = await tx.salesInvoice.update({
      where: { id: invoiceId },
      data: { status: 'VOID', voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });

    return {
      before,
      after: { status: updated.status, voidedAt: updated.voidedAt, voidReason: updated.voidReason },
    };
      });
    } catch (err) {
      await auditGstr1MutationBlocked(err, 'sales_invoices', userId, ctx.companyId);
      await auditGstr3bMutationBlocked(err, 'sales_invoices', userId, ctx.companyId);
      throw err;
    }
  })();

  await createAuditEntry('sales_invoices', invoiceId, userId, 'VOID', before, { ...after, reason }, ctx.companyId);
  return { id: invoiceId, status: 'VOID' as const };
}

// Shared by recordPayment (the standalone "record a payment later" endpoint) and createInvoice's
// optional inline payment (bill-and-collect in one screen). Both must apply a payment to an
// invoice + client balance identically — duplicating this math in two places is exactly how the
// A1 currency bug happened (two code paths computing the same thing, silently drifting apart).
export async function applyPayment(
  tx: Prisma.TransactionClient,
  companyId: string,
  invoice: { id: string; clientId: string; paidAmount: unknown; totalAmount: unknown; exchangeRate: unknown },
  data: PaymentInput,
  userId: string,
  // fromCredit: this "payment" settles the bill out of credit the customer already holds (old gold just
  // booked, or store credit from a return) — the row and the invoice's paid/due figures are written as for
  // any payment, but no cash came in, so there is no journal and the client's balance is left alone (the
  // credit was booked in the ledger and on the balance when it arose; the sale's debit already netted it).
  // advanceId: settled from a Customer Advance (ledger 2400) — see the branches below.
  opts: { fromCredit?: boolean; advanceId?: string; idempotencyKey?: string } = {},
) {
  const forexGainLoss = data.forexRate
    ? (Number(invoice.exchangeRate) - data.forexRate) * data.amount
    : 0;

  // Sec 269ST — before anything is written. Earlier splits of the same sale are already in the table
  // (same transaction), so a bill-and-collect with several CASH splits is aggregated correctly.
  if (!opts.fromCredit && !opts.advanceId) await assertCashLimit(tx, companyId, invoice.clientId, data);
  // The advance being spent: must be the invoice customer's own, unreversed, with enough left (rows locked by the caller).
  const advance = opts.advanceId ? await loadSpendableAdvance(tx, companyId, opts.advanceId, invoice.clientId) : null;
  if (advance && round2(data.amount) > advance.remaining + 0.005) {
    throw new AppError(`Advance ${advance.adv.advanceNumber} has only ${advance.remaining.toFixed(2)} available; ${data.amount.toFixed(2)} was asked for`, 409);
  }

  const newPaid = Number(invoice.paidAmount) + data.amount;
  const newBalance = Number(invoice.totalAmount) - newPaid;
  const paymentNumber = await nextDocumentNumber(companyId, 'PMT', 'PMT', tx, data.paymentDate.getFullYear());

  const payment = await tx.invoicePayment.create({
    data: {
      companyId, paymentNumber, invoiceId: invoice.id, clientId: invoice.clientId,
      paymentDate: data.paymentDate, amount: data.amount,
      mode: advance ? PAYMENT_MODE_CUSTOMER_ADVANCE : data.mode, referenceNo: advance ? advance.adv.advanceNumber : data.referenceNo, notes: data.notes,
      forexRate: data.forexRate, forexGainLoss: forexGainLoss || null,
    },
  });
  if (advance) {
    await recordAdvanceApplication(tx, {
      companyId, advanceId: advance.adv.id, clientId: invoice.clientId, invoiceId: invoice.id, invoicePaymentId: payment.id,
      amount: data.amount, appliedById: userId, idempotencyKey: opts.idempotencyKey,
    });
  }

  await tx.salesInvoice.update({
    where: { id: invoice.id },
    data: {
      paidAmount: newPaid,
      balanceDue: newBalance,
      status: newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID',
    },
  });

  if (advance) {
    // Money was booked as a liability when the advance was received (Dr Cash / Cr 2400). Applying it only moves
    // that liability onto this bill: Dr 2400 / Cr AR. No revenue, GST, inventory — the sale posted those. The
    // customer's receivable balance falls by the same amount a receipt would take off it.
    await postAutoJournalEntry(tx, companyId, {
      date: data.paymentDate, description: `Customer advance ${advance.adv.advanceNumber} applied (${payment.paymentNumber})`,
      referenceType: 'InvoicePayment', referenceId: payment.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.CUSTOMER_ADVANCES, debit: data.amount },
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: data.amount },
      ],
    });
    await tx.client.update({ where: { id: invoice.clientId }, data: { currentBalance: { decrement: data.amount } } });
  } else if (!opts.fromCredit) {
    // F1: cash/bank in, receivable down — the ledger mirror of the currentBalance decrement below.
    // Forex gain/loss (when this payment's rate differs from the invoice's) isn't journaled yet —
    // same "recorded but not yet fully wired" boundary as other deferred items (see D1/D3 notes);
    // the field stays on InvoicePayment for later, cash/bank still nets to exactly data.amount.
    await postAutoJournalEntry(tx, companyId, {
      date: data.paymentDate, description: `Payment ${payment.paymentNumber} for invoice`,
      referenceType: 'InvoicePayment', referenceId: payment.id, userId,
      lines: [
        { accountCode: cashOrBankAccount(data.mode), debit: data.amount },
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: data.amount },
      ],
    });

    await tx.client.update({
      where: { id: invoice.clientId },
      data: { currentBalance: { decrement: data.amount } },
    });
  }

  return { paidAmount: newPaid, balanceDue: newBalance };
}

export async function recordPayment(data: PaymentInput & { invoiceId: string }, ctx: TenantContext, userId: string) {
  // Layer 2: the invoice is validated as belonging to ctx.companyId before any payment is
  // recorded against it — a Company-B invoiceId must 404, not silently accept a payment.
  assertReceiptMode(data.mode);
  await assertOwnedByCompany('salesInvoice', data.invoiceId, ctx.companyId, 'Invoice');
  return tenantTransaction(ctx.companyId, async (tx) => {
    const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: data.invoiceId } });
    // J3 Decision 5: a voided invoice is closed — it can never receive a new payment.
    if (invoice.status === 'VOID') throw new AppError('This invoice has been voided and cannot receive a payment', 409);
    return applyPayment(tx, ctx.companyId, invoice, data, userId);
  });
}

// J3 Decision 1 (Option A — flag the original row, never edit/delete it) / Decision 2 (build the
// OLD_GOLD/STORE_CREDIT reversal properly rather than just blocking it): reverses a receipt. The
// InvoicePayment row is never edited or deleted — reversedAt/reversedById/reversalReason are set on
// it so every place that sums InvoicePayment as a receipt (getClientLedger, getDayBook —
// finance.service.ts) can filter it out by adding `reversedAt: null`, while amount/mode/date stay
// exactly as originally recorded.
//
// Three cases, by mode:
//  - cash/bank/UPI/card/... (anything not a CREDIT_SETTLEMENT_MODE): a real receipt. Reopen the
//    invoice (if invoice-scoped), credit client.currentBalance back, post the exact inverse journal.
//  - STORE_CREDIT: this "payment" never moved currentBalance or posted a journal in the first place
//    — the credit was already netted into currentBalance when the SalesReturn/OldGoldExchange that
//    funded it was booked, BEFORE this invoice's own debit (see createInvoice's payments loop).
//    Reversing it only needs to reopen the invoice: there is no separate credit-source movement to
//    undo, and no individually-redeemable "unit" of credit to double-spend — currentBalance is one
//    pooled running balance, not a ledger of discrete credit lots. (SalesReturn itself stays
//    append-only per Decision 4 — this does not touch it.)
//  - OLD_GOLD: unlike STORE_CREDIT, this mode DOES create its own real, separate movement at
//    payment-application time (bookOldGoldExchange, called from inside createInvoice's payments
//    loop): it credits currentBalance, posts its own journal, and adds real weight to the Metal
//    Vault. Reversing the payment WITHOUT reversing that exchange would let the business collect
//    cash for an invoice it has already extracted equivalent-value metal for — so both are reversed
//    together, atomically, exactly as Decision 2 requires. Refused (409, not silently skipped) if
//    the metal has since been reserved/consumed by anything else — checked via
//    MetalStock.availableWt vs netWeight. This codebase's only present-day consumer of Metal Vault
//    stock is the dormant-but-not-disabled production auto-reservation path
//    (orders.service.ts:autoReserveMaterials, off a SalesOrder/BOM) — if that already spent this
//    exchange's metal, there is nothing left to give back, and the reversal correctly refuses
//    rather than fabricating stock back into existence.
export async function reverseInvoicePayment(paymentId: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to reverse a payment', 400);
  await assertOwnedByCompany('invoicePayment', paymentId, ctx.companyId, 'Payment');

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    // Claim the reversal atomically FIRST, before anything else is touched — a concurrent duplicate
    // reversal of the same payment loses the race here, same count-checked pattern as every other
    // status flip in this codebase (createInvoice's tag flip, createSalesReturn's tag flip).
    const claimed = await tx.invoicePayment.updateMany({
      where: { id: paymentId, companyId: ctx.companyId, reversedAt: null },
      data: { reversedAt: new Date(), reversedById: userId, reversalReason: reason },
    });
    if (claimed.count !== 1) throw new AppError('This payment has already been reversed', 409);

    const payment = await tx.invoicePayment.findUniqueOrThrow({ where: { id: paymentId } });
    const mode = normalizeMode(payment.mode);
    const amount = Number(payment.amount);

    let invoiceBefore: Record<string, unknown> | null = null;
    let invoiceAfter: Record<string, unknown> | null = null;
    if (payment.invoiceId) {
      // J3.5 Finding 3: SELECT ... FOR UPDATE, same lock amendInvoice/voidInvoice already take on
      // this exact row — closes the lost-update race where two concurrent reversals (or a reversal
      // racing an amend/void) on the SAME invoice each compute paidAmount/balanceDue from a stale
      // read and the second write silently discards the first's effect. Postgres serialises here:
      // the second transaction blocks until the first commits, then re-reads the now-current row.
      await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${payment.invoiceId} FOR UPDATE`;
      const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
      invoiceBefore = { paidAmount: Number(invoice.paidAmount), balanceDue: Number(invoice.balanceDue), status: invoice.status };
      const newPaid = round2(Number(invoice.paidAmount) - amount);
      const newBalance = round2(Number(invoice.totalAmount) - newPaid);
      // Unlike applyPayment (monotonically increasing paid), a reversal can bring paid back to
      // zero — which must read as DRAFT again, not linger at whatever status the last payment set.
      const status = newPaid > 0.005 ? (newBalance <= 0.005 ? 'PAID' : 'PARTIALLY_PAID') : 'DRAFT';
      const updatedInvoice = await tx.salesInvoice.update({
        where: { id: payment.invoiceId },
        data: { paidAmount: newPaid, balanceDue: newBalance, status },
      });
      invoiceAfter = { paidAmount: Number(updatedInvoice.paidAmount), balanceDue: Number(updatedInvoice.balanceDue), status: updatedInvoice.status };
    }

    let exchangeReversal: { id: string; exchangeNumber: string } | null = null;
    let exchangeSnapshot: Record<string, unknown> | null = null;
    let metalStockAudit: { id: string; before: Record<string, unknown>; after: Record<string, unknown> } | null = null;

    let advanceRelease: Awaited<ReturnType<typeof releaseAdvanceApplication>> | null = null;
    if (mode === PAYMENT_MODE_CUSTOMER_ADVANCE) {
      // The application is released and the advance's available amount restored; the ORIGINAL advance receipt
      // (Dr Cash / Cr 2400) is not touched. Exact inverse of applyPayment's advance branch.
      advanceRelease = await releaseAdvanceApplication(tx, ctx.companyId, payment.id, userId, reason);
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Reversal of customer advance application ${payment.paymentNumber}`,
        referenceType: 'InvoicePaymentReversal', referenceId: payment.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: amount },
          { accountCode: LEDGER_ACCOUNT.CUSTOMER_ADVANCES, credit: amount },
        ],
      });
      await tx.client.update({ where: { id: payment.clientId }, data: { currentBalance: { increment: amount } } });
    } else if (!CREDIT_SETTLEMENT_MODES.includes(mode)) {
      // Real cash/bank/UPI/card receipt — exact inverse of applyPayment's non-credit branch.
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Reversal of payment ${payment.paymentNumber}`,
        referenceType: 'InvoicePaymentReversal', referenceId: payment.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: amount },
          { accountCode: cashOrBankAccount(payment.mode), credit: amount },
        ],
      });
      await tx.client.update({ where: { id: payment.clientId }, data: { currentBalance: { increment: amount } } });
    } else if (mode === PAYMENT_MODE_OLD_GOLD) {
      // bookOldGoldExchange stamps the payment's referenceNo with the exchange's own number, which
      // is unique per company (@@unique([companyId, exchangeNumber])) — this match is exact, not a
      // heuristic, and InvoicePayment has no edit path that could have altered referenceNo since.
      const exchange = await tx.oldGoldExchange.findFirst({
        where: { companyId: ctx.companyId, exchangeNumber: payment.referenceNo ?? '__none__' },
        include: { metalStock: true },
      });
      if (!exchange) {
        throw new AppError('Cannot reverse: the old-gold exchange this payment settled could not be found', 500);
      }
      // J3.5 Finding 5: a real before-snapshot, not just a reason string — the other J3 reversal
      // audit entries (invoice void, payment reverse) all carry a full before/after; this one now
      // matches that contract rather than being reconstructable only by cross-referencing other rows.
      exchangeSnapshot = {
        exchangeNumber: exchange.exchangeNumber, clientId: exchange.clientId, karat: exchange.karat,
        grossWeight: Number(exchange.grossWeight), stoneWeight: Number(exchange.stoneWeight),
        netWeight: Number(exchange.netWeight), ratePerGram: Number(exchange.ratePerGram),
        valuedAmount: Number(exchange.valuedAmount), metalStockId: exchange.metalStockId,
      };
      const stockBefore = exchange.metalStock
        ? { availableWt: Number(exchange.metalStock.availableWt), isActive: exchange.metalStock.isActive }
        : null;
      if (stockBefore && (!stockBefore.isActive || stockBefore.availableWt !== Number(exchange.metalStock!.netWeight))) {
        const consumed = round2(Number(exchange.metalStock!.netWeight) - stockBefore.availableWt);
        throw new AppError(
          `Cannot reverse: ${consumed}g of this exchange's metal has already been reserved or adjusted out of the Metal Vault`,
          409,
        );
      }

      // J3.5 Finding 3: claim the exchange atomically, exactly like the payment's own claim above —
      // this closes the structural gap where the exchange's own "already reversed" guard was a plain
      // check-then-act (findFirst + if), not self-defending against a concurrent second reversal
      // reaching this same exchange.
      const exchangeClaimed = await tx.oldGoldExchange.updateMany({
        where: { id: exchange.id, companyId: ctx.companyId, reversedAt: null },
        data: { reversedAt: new Date(), reversedById: userId, reversalReason: `Payment ${payment.paymentNumber} reversed: ${reason}` },
      });
      if (exchangeClaimed.count !== 1) throw new AppError('This old-gold exchange has already been reversed', 409);

      const valuedAmount = Number(exchange.valuedAmount);
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Reversal of Old Gold Exchange ${exchange.exchangeNumber}`,
        referenceType: 'OldGoldExchangeReversal', referenceId: exchange.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: valuedAmount },
          { accountCode: LEDGER_ACCOUNT.INVENTORY, credit: valuedAmount },
        ],
      });
      await tx.client.update({ where: { id: payment.clientId }, data: { currentBalance: { increment: valuedAmount } } });

      if (exchange.metalStockId && stockBefore) {
        // J3.5 Finding 3: count-checked, re-verifying the EXACT pre-state just checked above, not a
        // blind write — if any concurrent operation (e.g. orders.service.ts:autoReserveMaterials
        // reserving this same MetalStock row for a production order) changed availableWt/isActive
        // between the check and here, this affects 0 rows and the whole reversal rolls back rather
        // than silently clobbering that other, legitimate movement.
        const stockClaimed = await tx.metalStock.updateMany({
          where: { id: exchange.metalStockId, availableWt: stockBefore.availableWt, isActive: true },
          data: { availableWt: 0, isActive: false },
        });
        if (stockClaimed.count !== 1) {
          throw new AppError('This exchange\'s metal was reserved or adjusted by another operation just now — retry the reversal', 409);
        }
        await insertMetalMovement(tx, ctx.companyId, exchange.metalStock!, -stockBefore.availableWt, stockBefore.availableWt, 0, {
          movementType: METAL_MOVEMENT.OLD_GOLD_EXCHANGE_REVERSAL, referenceType: 'OldGoldExchange', referenceId: exchange.id,
          userId, branchId: exchange.branchId,
        });
        // Audited AFTER the transaction commits (see below) — createAuditEntry writes via its own
        // connection, so calling it from inside an open transaction can record an entry for a
        // mutation that later rolls back; captured here, written once the transaction is durable.
        metalStockAudit = { id: exchange.metalStockId, before: stockBefore, after: { availableWt: 0, isActive: false } };
      }
      exchangeReversal = { id: exchange.id, exchangeNumber: exchange.exchangeNumber };
    }
    // STORE_CREDIT: nothing further — see the function comment above. Reopening the invoice (done
    // above, for every mode) is the whole of it for this mode; no currentBalance/journal/exchange
    // movement was ever made for a STORE_CREDIT-mode payment to begin with.

    return { payment, invoiceBefore, invoiceAfter, exchangeReversal, exchangeSnapshot, metalStockAudit, advanceRelease };
  });

  // Every createAuditEntry call below runs AFTER the transaction has committed — it writes via its
  // own connection (see middleware/audit.ts), so writing it from inside an still-open transaction
  // could record an entry for a mutation that then rolls back. Same reasoning for all three calls.
  await createAuditEntry(
    'invoice_payments', paymentId, userId, 'REVERSE',
    { amount: Number(result.payment.amount), mode: result.payment.mode, invoice: result.invoiceBefore },
    { reversedAt: new Date().toISOString(), reason, invoice: result.invoiceAfter, exchangeReversed: result.exchangeReversal },
    ctx.companyId,
  );
  if (result.advanceRelease) {
    const r = result.advanceRelease;
    await createAuditEntry(
      'customer_advances', r.advance.id, userId, 'REVERSE_APPLICATION',
      { advanceNumber: r.advance.advanceNumber, appliedAmount: r.appliedBefore, invoicePaymentId: result.payment.id },
      { appliedAmount: r.appliedAfter, applicationId: r.app.id, amountReleased: Number(r.app.amount), reason },
      ctx.companyId,
    );
  }
  if (result.exchangeReversal) {
    await createAuditEntry(
      'old_gold_exchanges', result.exchangeReversal.id, userId, 'REVERSE',
      result.exchangeSnapshot ?? undefined,
      { reversedAt: new Date().toISOString(), reason: `Payment ${result.payment.paymentNumber} reversed: ${reason}` },
      ctx.companyId,
    );
  }
  if (result.metalStockAudit) {
    await createAuditEntry(
      'metal_stocks', result.metalStockAudit.id, userId, 'REVERSE',
      result.metalStockAudit.before, result.metalStockAudit.after, ctx.companyId,
    );
  }
  return result;
}

// F2: a standalone/on-account payment — an advance, or a payment against a client's general
// outstanding balance rather than one specific invoice. Same InvoicePayment row shape and PMT-
// numbering as an invoice-scoped payment (applyPayment above), just with no invoice to update
// paidAmount/balanceDue/status on: this only ever moves client.currentBalance and the ledger.
export async function recordClientPayment(data: PaymentInput & { clientId: string }, ctx: TenantContext, userId: string) {
  if (data.amount <= 0) throw new AppError('Payment amount must be positive', 400);
  assertReceiptMode(data.mode);
  const client = await tenantQuery(ctx.companyId, (tx) => tx.client.findUnique({ where: { id: data.clientId }, select: { companyId: true, name: true, isActive: true } }));
  if (!client || client.companyId !== ctx.companyId) throw new AppError('Client not found', 404);
  assertClientActive(client);

  return tenantTransaction(ctx.companyId, async (tx) => {
    await assertCashLimit(tx, ctx.companyId, data.clientId, data); // Sec 269ST — an advance is a receipt too
    const paymentNumber = await nextDocumentNumber(ctx.companyId, 'PMT', 'PMT', tx, data.paymentDate.getFullYear());

    const payment = await tx.invoicePayment.create({
      data: {
        companyId: ctx.companyId, paymentNumber, clientId: data.clientId, invoiceId: null,
        paymentDate: data.paymentDate, amount: data.amount,
        mode: data.mode, referenceNo: data.referenceNo, notes: data.notes,
      },
    });

    // Same Cash/Bank vs Accounts Receivable entry applyPayment posts — a payment received is a
    // payment received whether or not it's earmarked for one invoice yet.
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: data.paymentDate, description: `On-account payment ${payment.paymentNumber}`,
      referenceType: 'InvoicePayment', referenceId: payment.id, userId,
      lines: [
        { accountCode: cashOrBankAccount(data.mode), debit: data.amount },
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: data.amount },
      ],
    });

    await tx.client.update({
      where: { id: data.clientId },
      data: { currentBalance: { decrement: data.amount } },
    });

    return payment;
  });
}

// F2/F4: every payment for a client, invoice-scoped or standalone — the building block for a
// full account statement (F4). Layer 2: clientId ownership validated first, same as
// getClientLedger().
export async function listClientPayments(ctx: TenantContext, clientId: string) {
  await assertOwnedByCompany('client', clientId, ctx.companyId, 'Client');
  return tenantQuery(ctx.companyId, (tx) => tx.invoicePayment.findMany({
    where: { companyId: ctx.companyId, clientId },
    include: { invoice: { select: { invoiceNumber: true } } },
    orderBy: { paymentDate: 'desc' },
  }));
}

// D1: a customer brings a piece back. Validate -> flip -> link, same shape as createInvoice's own
// (guarded, count-checked) tag flip — a return has no prior reservation step to lean on either,
// so it can't borrow returnMemoItems' blind updateMany. The original SalesInvoice/InvoiceItem rows
// are never written to: a return is a new record referencing the sale, not an edit to it.
export async function createSalesReturn(data: {
  invoiceId: string;
  items: Array<{ invoiceItemId: string; amount?: number; weight?: number /* grams, material (vault) lines only — omit to return what is still outstanding */ }>; // amount defaults to what the
  // customer actually paid for that line: totalPrice grossed up by its own snapshotted taxRate
  // (matching client.currentBalance's debit on sale, which is tax-inclusive) — not a formal GST
  // credit-note reversal (no TaxInvoice counterpart is created; see CLAUDE.md/ROADMAP D1 notes).
  reason?: string;
  notes?: string;
  // The branch the piece physically came back to, when that is not the branch it was sold from. Defaults to the
  // tag's own branch. A returned tagged piece is NOT back in stock: see the RETURNED_PENDING_INSPECTION flip below.
  returnBranchId?: string;
}, ctx: TenantContext, userId: string, opts: { issueCreditNote?: boolean } = {}) {
  if (data.items.length === 0) throw new AppError('At least one item is required', 400);
  if (data.returnBranchId) await assertBranchAccessible(data.returnBranchId, ctx, 'Return branch');

  // Layer 2: the invoice is validated as belonging to ctx.companyId — a Company-B invoiceId
  // must 404, not let a Company-A user return items against another company's sale.
  const invoice = await tenantQuery(ctx.companyId, (_tx) => _tx.salesInvoice.findUnique({
    where: { id: data.invoiceId },
    include: { items: true, taxDetails: true },
  }));
  if (!invoice || invoice.companyId !== ctx.companyId) throw new AppError('Invoice not found', 404);
  // J3 Decision 5: a voided invoice is closed — nothing is left owed or owned on it to return.
  if (invoice.status === 'VOID') throw new AppError('This invoice has been voided and cannot be returned against', 409);

  // F1: whether the original sale charged GST at all (INR only — see createInvoice's own
  // currency === 'INR' gate) and, if so, same-state (CGST+SGST) vs inter-state (IGST) — read off
  // the invoice's own TaxInvoice rather than re-resolving the client's state, so a return always
  // reverses exactly what was actually charged, even if the client's state master entry changes
  // later.
  const taxDetails = invoice.taxDetails;
  const isSameState = !!taxDetails && Number(taxDetails.cgst) > 0;

  const requestedLineIds = data.items.map((r) => r.invoiceItemId);
  if (new Set(requestedLineIds).size !== requestedLineIds.length) {
    throw new AppError('The same invoice line cannot appear twice in one return', 400);
  }
  const invoiceItemById = new Map(invoice.items.map((i) => [i.id, i]));
  for (const r of data.items) {
    const line = invoiceItemById.get(r.invoiceItemId);
    if (!line) throw new AppError(`Invoice item not found on this invoice: ${r.invoiceItemId}`, 404);
    if (!line.tagId && !line.materialSale) {
      throw new AppError('Only tagged lines can be returned (or material lines drawn from the Metal Vault) — no physical item on a free-text line', 400);
    }
  }

  // G2g-7g: a SalesReturn is its own GSTR-3B outward source document (gstr3bReporting.service.ts's
  // loader reads it by its own returnDate, attributed to the ORIGINAL invoice's seller registration
  // snapshot — see that loader's own query) — so it is guarded against ITS OWN period, not the
  // original invoice's. Computed once, outside the transaction, and passed explicitly into the
  // create below so the checked date and the persisted date can never drift apart.
  const returnDate = new Date();

  const salesReturn = await tenantTransaction(ctx.companyId, async (tx) => {
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_RETURN', documentId: data.invoiceId,
      gstRegistrationId: taxDetails?.sellerRegistrationId, documentDate: returnDate, action: 'returned',
    });

    // Friendly pre-check for the common case; the count-checked updateMany below is the
    // authoritative guard (same pattern createInvoice uses for its own flip). companyId is
    // included here too — a tag in this list is only ever populated from invoice.items, which
    // is already proven to belong to this company via the invoice check above, but scoping the
    // query itself is cheap, consistent insurance against a future code path reusing this same
    // helper with less-trusted input.
    // Serialise returns (and voids/amends) of this invoice, then read what has already been returned on its lines FRESH —
    // two returns of the same line racing each other must not both see "nothing returned yet".
    await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
    const fresh = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true } });
    if (fresh.status === 'VOID') throw new AppError('This invoice has been voided and cannot be returned against', 409);
    const priorReturns = await tx.salesReturnItem.findMany({
      where: { companyId: ctx.companyId, invoiceItemId: { in: requestedLineIds } },
      select: { invoiceItemId: true, returnedWeight: true },
    });
    const priorWeightByLine = new Map<string, number>();
    const returnedLines = new Set<string>();
    for (const pr of priorReturns) {
      returnedLines.add(pr.invoiceItemId);
      priorWeightByLine.set(pr.invoiceItemId, (priorWeightByLine.get(pr.invoiceItemId) ?? 0) + Number(pr.returnedWeight ?? 0));
    }

    const resolvedItems = data.items.map((r) => {
      const line = invoiceItemById.get(r.invoiceItemId)!;
      const taxRate = taxDetails ? Number(line.taxRate) : 0;
      let fraction = 1;
      let weight: number | null = null;
      if (line.materialSale) {
        // A material line can be returned in parts: never more than was sold, summed over every return so far.
        const sold = Math.round(Number(line.netGoldWeight) * line.quantity * 10000) / 10000;
        const outstanding = Math.round((sold - (priorWeightByLine.get(line.id) ?? 0)) * 10000) / 10000;
        weight = r.weight ?? outstanding;
        if (!(weight > 0)) throw new AppError(`Line ${line.productCode} has nothing left to return`, 409);
        if (weight > outstanding + 0.00005) {
          throw new AppError(`Line ${line.productCode}: ${weight} g cannot be returned — only ${outstanding} g of the ${sold} g sold is outstanding`, 409);
        }
        fraction = weight / sold;
      } else if (returnedLines.has(line.id)) {
        // The tag status check below would not catch a piece that was returned and then sold again on another bill.
        throw new AppError(`Line ${line.productCode} has already been returned`, 409);
      }
      const paidAmount = Number(line.totalPrice) * (1 + taxRate) * fraction;
      const amount = r.amount ?? paidAmount;
      // Back out the revenue/tax split from whatever amount is actually being refunded (the default
      // or a caller override) — same tax-inclusive assumption the default itself uses.
      const revenuePortion = amount / (1 + taxRate);
      return {
        invoiceItemId: line.id, tagId: line.tagId, weight, amount,
        revenuePortion, taxPortion: amount - revenuePortion,
      };
    });

    const tagIds = resolvedItems.map((r) => r.tagId).filter((t): t is string => !!t);
    if (new Set(tagIds).size !== tagIds.length) {
      throw new AppError('The same tag cannot appear on more than one line of a return', 400);
    }

    const totalAmount = resolvedItems.reduce((s, r) => s + r.amount, 0);
    const revenueReversal = resolvedItems.reduce((s, r) => s + r.revenuePortion, 0);
    const taxReversal = resolvedItems.reduce((s, r) => s + r.taxPortion, 0);

    const tags = await tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } });
    const notSold = tags.filter((t) => t.status !== 'SOLD');
    if (notSold.length > 0) {
      throw new AppError(`Tag(s) not currently SOLD, cannot return: ${notSold.map((t) => t.tagNumber).join(', ')}`, 409);
    }

    // The tag itself comes back — same row, same tag number, same history (the tag_history trigger records the
    // change) — but NOT as saleable stock: it waits at the branch it came back to for Head Office inspection
    // (RETURNED_PENDING_INSPECTION). Only an authorised inspection PASS makes it IN_STOCK again.
    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, status: 'SOLD', companyId: ctx.companyId },
      data: { status: TAG_STATUS_RETURNED_PENDING_INSPECTION, ...(data.returnBranchId ? { branchId: data.returnBranchId } : {}) },
    });
    if (flipped.count !== tagIds.length) {
      throw new AppError('One or more tags changed status just now — retry the return', 409);
    }

    const returnNumber = await nextDocumentNumber(ctx.companyId, 'SRET', 'SRET', tx);

    // F1 COGS/inventory reversal — the returned piece goes back on the shelf at its own
    // (immutable) costPrice, same figure createInvoice originally moved out of Inventory.
    const costPriceByTagId = new Map(tags.map((t) => [t.id, Number(t.costPrice)]));
    let cogsReversal = resolvedItems.reduce((s, r) => s + (r.tagId ? (costPriceByTagId.get(r.tagId) ?? 0) : 0), 0);

    const created = await tx.salesReturn.create({
      data: {
        companyId: ctx.companyId,
        returnNumber,
        returnDate,
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        reason: data.reason,
        notes: data.notes,
        totalAmount,
        items: {
          createMany: {
            data: resolvedItems.map((r) => ({
              invoiceItemId: r.invoiceItemId, tagId: r.tagId, returnedWeight: r.weight, amount: r.amount,
            })),
          },
        },
      },
      include: { items: { include: { tag: { select: { tagNumber: true } } } } },
    });

    // Repair Register: one case per returned tagged line, in the same transaction as the flip above — so a piece can
    // never be parked as RETURNED_PENDING_INSPECTION without a register row to follow it. Pure operational record:
    // no ledger or customer-balance movement (the return's own entries below are the only financial effect).
    const repairCases: Array<{ id: string }> = [];
    for (const item of created.items.filter((i) => i.tagId)) {
      const tag = tags.find((t) => t.id === item.tagId)!;
      const repairNumber = await nextDocumentNumber(ctx.companyId, 'RPR', 'RPR', tx);
      repairCases.push(await tx.repairCase.create({
        data: {
          companyId: ctx.companyId, repairNumber, tagId: tag.id, salesReturnItemId: item.id,
          originBranchId: data.returnBranchId ?? tag.branchId, status: REPAIR_STATUS.RETURNED_PENDING_TRANSFER,
          currentLocation: REPAIR_LOCATION.BRANCH, returnReason: data.reason ?? null,
          description: tag.name, karat: tag.metalKarat, grossWeight: tag.grossWeight, stoneWeight: tag.stoneWeight,
          netWeight: tag.netWeight, createdById: userId,
        },
        select: { id: true },
      }));
    }

    // Material lines: the returned grams go back to the Metal Vault lots the sale drew from, at the cost they left at.
    // Each return line is the cause of its own movements, so replaying it can never restore twice.
    for (const item of created.items.filter((i) => i.returnedWeight != null)) {
      const { cost } = await restoreVaultMetal(tx, ctx.companyId, {
        saleReferenceType: 'InvoiceItem', saleReferenceId: item.invoiceItemId, weight: Number(item.returnedWeight),
        meta: { referenceType: 'SalesReturnItem', referenceId: item.id, userId, branchId: invoice.branchId },
      });
      cogsReversal += cost;
    }

    // F1: exact reversal of createInvoice's compound entry, scoped to just the returned lines —
    // Dr Revenue + Dr GST payable + Dr Inventory must equal Cr Accounts Receivable + Cr COGS.
    const returnJournalEntry = await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Sales Return ${returnNumber} (Invoice ${invoice.invoiceNumber})`,
      referenceType: 'SalesReturn', referenceId: created.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, debit: revenueReversal },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, debit: isSameState ? taxReversal / 2 : 0 },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, debit: isSameState ? taxReversal / 2 : 0 },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, debit: isSameState ? 0 : taxReversal },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: cogsReversal },
        { accountCode: LEDGER_ACCOUNT.COST_OF_GOODS, credit: cogsReversal },
      ],
    });

    // Credit the client account — exact mirror of createInvoice's debit on sale.
    await tx.client.update({
      where: { id: invoice.clientId },
      data: { currentBalance: { decrement: totalAmount } },
    });

    // G2c Path A: the formal GST document for this return, in the SAME transaction, when
    // requested. Posts no new journal — journalEntryId points at returnJournalEntry above; no
    // further client-balance movement (already done immediately above).
    let creditNote: Awaited<ReturnType<typeof createCreditNoteForReturn>> | null = null;
    if (opts.issueCreditNote) {
      creditNote = await createCreditNoteForReturn(tx, ctx, userId, {
        invoice, salesReturnId: created.id,
        returnItems: resolvedItems.map((r) => ({ invoiceItemId: r.invoiceItemId, amount: r.amount })),
        isSameState, journalEntryId: returnJournalEntry?.id ?? null, reasonNotes: data.reason ?? null,
      });
    }

    return { created, creditNote, repairCases };
  });

  for (const rc of salesReturn.repairCases) {
    await createAuditEntry('repair_cases', rc.id, userId, 'CREATE', undefined, { status: REPAIR_STATUS.RETURNED_PENDING_TRANSFER, source: 'SALES_RETURN' }, ctx.companyId);
  }
  await createAuditEntry('sales_returns', salesReturn.created.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  if (salesReturn.creditNote) {
    await createAuditEntry(
      'credit_notes', salesReturn.creditNote.id, userId, 'CREATE', undefined,
      {
        creditNoteNumber: salesReturn.creditNote.creditNoteNumber, invoiceId: salesReturn.creditNote.invoiceId,
        salesReturnId: salesReturn.creditNote.salesReturnId, totalAmount: Number(salesReturn.creditNote.totalAmount),
      },
      ctx.companyId,
    );
  }
  return { ...salesReturn.created, creditNote: salesReturn.creditNote };
}

// D4: a customer's old/used gold piece taken in and valued. Credits Client.currentBalance (the
// same field a sale debits and createSalesReturn credits) as a standing store credit, redeemable
// against any future purchase — not tied to one specific invoice (confirmed with the user).
// Also adds the melted-down weight to the Metal Vault via the existing addMetalStock(), so the
// physical metal is tracked, not just the financial side.
//
// A customer may hand over a TAGGED piece (a JewelryTag we sold): pass `tagId`. For this version that is an old-metal
// purchase, not a buy-back for resale — the tag is RETIRED (never deleted: its record and history stay) and its metal is
// what enters the vault. Karat, weights and description then default from the tag when omitted.
export async function createOldGoldExchange(data: {
  clientId: string;
  description?: string;
  karat?: string;
  grossWeight?: number;
  stoneWeight?: number;
  deductionPercent?: number;
  exchangeDate?: Date;
  notes?: string;
  branchId?: string;
  tagId?: string;
}, ctx: TenantContext, userId: string) {
  // Layer 2: the client this exchange credits must belong to the caller's own company.
  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  if (data.branchId) await assertBranchAccessible(data.branchId, ctx);

  let tag: Awaited<ReturnType<typeof loadTagForBuyback>> | null = null;
  if (data.tagId) {
    tag = await loadTagForBuyback(ctx, data.tagId);
    await assertBranchAccessible(tag.branchId, ctx);
  }
  const karat = data.karat ?? tag?.metalKarat ?? undefined;
  const grossWeight = data.grossWeight ?? (tag ? Number(tag.grossWeight) : undefined);
  const description = data.description ?? (tag ? `Old tagged piece ${tag.tagNumber}` : undefined);
  if (!karat || grossWeight === undefined || !description) {
    throw new AppError('Description, karat and gross weight are required', 400);
  }
  const resolved = {
    ...data, description, karat, grossWeight, stoneWeight: data.stoneWeight ?? (tag ? Number(tag.stoneWeight) : undefined),
    branchId: data.branchId ?? tag?.branchId, tagId: data.tagId,
  };

  const exchangeDate = data.exchangeDate ?? new Date();
  const valuation = await valueOldGold(resolved, exchangeDate, ctx);

  const exchange = await tenantTransaction(ctx.companyId, (tx) => bookOldGoldExchange(tx, ctx, userId, resolved, valuation));

  await createAuditEntry('old_gold_exchanges', exchange.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return exchange;
}

// Material Purchase: NON-TAGGED old gold bought over the counter at a purity the branch has TESTED. Valued off the 24K
// Old Gold rate (MetalRate.ogRatePerGram of the 24K row), never the normal gold rate and never karat/24:
//   fine weight = gross x tested purity / 100;  purchase value = fine weight x 24K Old Gold rate.
// It is an OldGoldExchange row (same ledger entry, same client credit, same Metal Vault lot + CUSTOMER_PURCHASE movement,
// same reversal path) carrying the tested-purity snapshot — not a parallel model. The server prices it; nothing the
// client sends about value, fine weight or rate is read.
export async function createMaterialPurchase(data: {
  clientId: string;
  branchId: string;
  metalType?: string;
  grossWeight: number;
  testedPurityPercent: number;
  description?: string;
  purchaseDate?: Date;
  notes?: string;
  idempotencyKey?: string;
}, ctx: TenantContext, userId: string) {
  const metalType = (data.metalType ?? 'GOLD').toUpperCase();
  if (metalType !== 'GOLD') throw new AppError('Only GOLD material purchases are supported', 400);
  const gross = Number(data.grossWeight);
  const purity = Number(data.testedPurityPercent);
  if (!Number.isFinite(gross) || !(gross > 0)) throw new AppError('Gross weight must be more than zero', 400);
  if (!Number.isFinite(purity) || !(purity > 0) || purity > 100) throw new AppError('Tested purity must be above 0 and at most 100%', 400);
  if (data.idempotencyKey !== undefined && (typeof data.idempotencyKey !== 'string' || data.idempotencyKey.length < 8 || data.idempotencyKey.length > 100)) {
    throw new AppError('idempotencyKey must be a string of 8-100 characters', 400);
  }

  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  await assertBranchAccessible(data.branchId, ctx);

  const purchaseDate = data.purchaseDate ?? new Date();
  const rate = await resolveMetalRate(ctx.companyId, GOLD_BASE_KARAT, purchaseDate);
  if (!rate || rate.ogRatePerGram == null || !(Number(rate.ogRatePerGram) > 0)) {
    throw new AppError(`No 24K Old Gold rate found on or before ${purchaseDate.toDateString()} — enter it in Metal Rates first`, 404);
  }
  const base = new Prisma.Decimal(rate.ogRatePerGram);
  const fine = new Prisma.Decimal(gross).mul(purity).div(100).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  const value = fine.mul(base).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const effective = base.mul(purity).div(100).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  if (!(Number(value) > 0)) throw new AppError('This purchase values to nothing — check the weight and purity', 400);

  // The vault lot's karat label: the active GOLD karat whose purity is nearest the tested one (within 1 point), else
  // the raw percentage. Free text on MetalStock — the tested purity itself is what the lot is valued and stocked at.
  const golds = await tenantQuery(ctx.companyId, (tx) => tx.karatMaster.findMany({ where: { companyId: ctx.companyId, metalType: 'GOLD', isActive: true } }));
  const near = golds
    .map((k) => ({ code: k.code, d: Math.abs(Number(k.purity) * 100 - purity) }))
    .filter((k) => k.d <= 1)
    .sort((a, b) => a.d - b.d)[0];
  const karatLabel = near?.code ?? `${purity}%`;

  const v: OldGoldValuation = {
    exchangeDate: purchaseDate, stoneWeight: 0, netWeight: gross, purity: purity / 100,
    ratePerGram: Number(effective), deductionPercent: 0, deductedRate: Number(effective), valuedAmount: Number(value),
  };

  let exchange;
  try {
    exchange = await tenantTransaction(ctx.companyId, async (tx) => {
      // Lock the customer's row so their credit moves one transaction at a time, then check they are still usable.
      await tx.$queryRaw`SELECT "id" FROM "clients" WHERE "id" = ${data.clientId} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
      const client = await tx.client.findFirst({ where: { id: data.clientId, companyId: ctx.companyId } });
      if (!client) throw new AppError('Client not found', 404);
      assertClientActive(client);
      if (data.idempotencyKey) {
        const dup = await tx.oldGoldExchange.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: data.idempotencyKey }, select: { exchangeNumber: true } });
        if (dup) throw new AppError(`This material purchase was already recorded (${dup.exchangeNumber})`, 409);
      }
      return bookOldGoldExchange(
        tx, ctx, userId,
        { clientId: data.clientId, description: data.description?.trim() || `Old gold ${purity}%`, karat: karatLabel, grossWeight: gross, notes: data.notes, branchId: data.branchId },
        v, METAL_MOVEMENT.CUSTOMER_PURCHASE,
        {
          metalType, testedPurityPercent: purity, fineWeight: Number(fine), baseRate24K: Number(base),
          effectivePurchaseRate: Number(effective), createdById: userId, idempotencyKey: data.idempotencyKey ?? null,
        },
      );
    });
  } catch (e: any) {
    if (e?.code === 'P2002' && data.idempotencyKey) throw new AppError('This material purchase was already recorded', 409);
    throw e;
  }

  await createAuditEntry('old_gold_exchanges', exchange.id, userId, 'CREATE', undefined, {
    kind: 'MATERIAL_PURCHASE', grossWeight: gross, testedPurityPercent: purity, fineWeight: Number(fine),
    baseRate24K: Number(base), purchaseValue: Number(value),
  } as any, ctx.companyId);
  return exchange;
}

// Completed Material Purchases (the rows carrying a tested-purity snapshot), newest first.
export async function listMaterialPurchases(ctx: TenantContext, filters: {
  clientId?: string; from?: Date; to?: Date; branchId?: string; metalType?: string; exchangeNumber?: string; createdById?: string;
} = {}) {
  // A requested branch must be one the caller is granted; with none requested a branch-restricted caller is capped to their own set.
  if (filters.branchId) await assertBranchAccessible(filters.branchId, ctx);
  const branchFilter = filters.branchId
    ? filters.branchId
    : (ctx.branchAccess.allBranches ? undefined : { in: ctx.branchAccess.branchIds });
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.oldGoldExchange.findMany({
    where: {
      companyId: ctx.companyId, testedPurityPercent: { not: null },
      ...(filters.clientId && { clientId: filters.clientId }),
      ...(branchFilter && { branchId: branchFilter }),
      ...(filters.metalType && { metalType: filters.metalType }),
      ...(filters.createdById && { createdById: filters.createdById }),
      ...(filters.exchangeNumber && { exchangeNumber: { contains: filters.exchangeNumber, mode: 'insensitive' as const } }),
      ...((filters.from || filters.to) && { exchangeDate: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) } }),
    },
    include: { client: { select: { name: true, clientCode: true } }, branch: { select: { name: true } } },
    orderBy: { exchangeDate: 'desc' },
    take: 500,
  }));
  const ids = [...new Set(rows.map((r) => r.createdById).filter(Boolean) as string[])];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, createdByName: r.createdById ? names.get(r.createdById) ?? null : null, creditCreated: r.valuedAmount }));
}

// The tag a customer hands back for its metal: it must be this company's and currently SOLD (a piece we still hold, or one
// already on memo/retired, is not the customer's to hand back).
async function loadTagForBuyback(ctx: TenantContext, tagId: string) {
  const tag = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findFirst({ where: { id: tagId, companyId: ctx.companyId } }));
  if (!tag) throw new AppError('Tag not found', 404);
  if (tag.status !== 'SOLD') throw new AppError(`Tag ${tag.tagNumber} is ${tag.status}, not SOLD — only a sold piece can be taken back as old metal`, 409);
  return tag;
}

type OldGoldValuation = {
  exchangeDate: Date; stoneWeight: number; netWeight: number; purity: number;
  ratePerGram: number; deductionPercent: number; deductedRate: number; valuedAmount: number;
};

// Validates and prices a piece of old metal — net weight x the day's MetalRate for its karat, less an optional
// melting-loss %. Read-only, so it runs before any transaction; shared by the standalone exchange screen and the
// OLD_GOLD payment on a bill, which must value the metal identically.
async function valueOldGold(
  data: { karat: string; grossWeight: number; stoneWeight?: number; deductionPercent?: number },
  exchangeDate: Date,
  ctx: TenantContext,
): Promise<OldGoldValuation> {
  if (!(await isValidKarat(ctx.companyId, data.karat))) {
    throw new AppError(`Unknown karat/purity code: ${data.karat}`, 400);
  }
  if (!(data.grossWeight > 0)) throw new AppError('Old gold gross weight must be more than zero', 400);

  const stoneWeight = data.stoneWeight ?? 0;
  if (stoneWeight < 0 || stoneWeight > data.grossWeight) {
    throw new AppError('Stone weight cannot exceed gross weight', 400);
  }
  const netWeight = data.grossWeight - stoneWeight;

  const deductionPercent = data.deductionPercent ?? 0;
  if (deductionPercent < 0 || deductionPercent > 100) throw new AppError('Deduction % must be between 0 and 100', 400);

  const rate = await resolveMetalRate(ctx.companyId, data.karat, exchangeDate);
  if (!rate) throw new AppError(`No metal rate found for ${data.karat} on or before ${exchangeDate.toDateString()}`, 404);
  const ratePerGram = Number(rate.ratePerGram);

  const deductedRate = ratePerGram * (1 - deductionPercent / 100);
  const valuedAmount = round2(netWeight * deductedRate);

  const karatMaster = await tenantQuery(ctx.companyId, (tx) =>
    tx.karatMaster.findUniqueOrThrow({ where: { companyId_code: { companyId: ctx.companyId, code: data.karat } } })
  );

  return { exchangeDate, stoneWeight, netWeight, purity: Number(karatMaster.purity), ratePerGram, deductionPercent, deductedRate, valuedAmount };
}

// The write half of an old-gold exchange, inside the caller's transaction: number it, add the melted weight to the
// Metal Vault, record it, post the ledger entry and credit the client. The client must already be checked as this
// company's. A standalone exchange and an OLD_GOLD payment on a bill both go through here, so they cannot drift.
async function bookOldGoldExchange(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  userId: string,
  data: { clientId: string; description: string; karat: string; grossWeight: number; notes?: string; branchId?: string | null; tagId?: string | null },
  v: OldGoldValuation,
  // CUSTOMER_PURCHASE for the standalone screen; OLD_GOLD_EXCHANGE when the metal is handed over against a bill.
  movementType: MetalMovementType = METAL_MOVEMENT.CUSTOMER_PURCHASE,
  // Material Purchase only: the tested-purity valuation snapshot stored on the row (see createMaterialPurchase).
  snapshot?: {
    metalType: string; testedPurityPercent: number; fineWeight: number; baseRate24K: number;
    effectivePurchaseRate: number; createdById: string; idempotencyKey?: string | null;
  },
) {
  const exchangeNumber = await nextDocumentNumber(ctx.companyId, 'OGX', 'OGX', tx, v.exchangeDate.getFullYear());
  const exchangeId = randomUUID();

  // A tagged piece is consumed by this exchange: SOLD -> RETIRED, count-checked so the same tag can never be taken
  // back twice (a replay or a race finds it already RETIRED and the whole exchange rolls back).
  if (data.tagId) {
    const retired = await tx.jewelryTag.updateMany({
      where: { id: data.tagId, companyId: ctx.companyId, status: 'SOLD' },
      data: { status: 'RETIRED' },
    });
    if (retired.count !== 1) throw new AppError('This tag is no longer SOLD — it cannot be taken back as old metal', 409);
  }

  const stock = await addMetalStock(
    {
      materialName: data.description, karat: data.karat, purity: v.purity,
      grossWeight: data.grossWeight, netWeight: v.netWeight,
      sourceType: 'CUSTOMER_SUPPLIED', sourceRef: exchangeNumber, avgCostPerGram: v.deductedRate,
    },
    ctx.companyId, userId, tx,
    { movementType, referenceType: 'OldGoldExchange', referenceId: exchangeId, branchId: data.branchId },
  );

  const created = await tx.oldGoldExchange.create({
    data: {
      id: exchangeId,
      companyId: ctx.companyId,
      branchId: data.branchId ?? null, tagId: data.tagId ?? null,
      exchangeNumber, clientId: data.clientId, exchangeDate: v.exchangeDate, description: data.description,
      karat: data.karat, grossWeight: data.grossWeight, stoneWeight: v.stoneWeight, netWeight: v.netWeight,
      ratePerGram: v.ratePerGram, deductionPercent: v.deductionPercent, valuedAmount: v.valuedAmount,
      metalStockId: stock.id, notes: data.notes,
      ...(snapshot && { ...snapshot, idempotencyKey: snapshot.idempotencyKey ?? null }),
    },
    include: { metalStock: true },
  });

  // F1: the melted-down metal enters the Metal Vault at exactly what it was valued at (Dr
  // Inventory), funded by reducing what the client is owed rather than cash out the door (Cr
  // Accounts Receivable — the same control account createInvoice debits and createSalesReturn
  // credits; a store credit is simply a negative receivable).
  await postAutoJournalEntry(tx, ctx.companyId, {
    date: v.exchangeDate, description: `Old Gold Exchange ${exchangeNumber}`,
    referenceType: 'OldGoldExchange', referenceId: created.id, userId,
    lines: [
      { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: v.valuedAmount },
      { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: v.valuedAmount },
    ],
  });

  // Store credit — symmetric opposite of createInvoice's debit on sale.
  await tx.client.update({
    where: { id: data.clientId },
    data: { currentBalance: { decrement: v.valuedAmount } },
  });

  return created;
}

// What a customer can spend on their next bill: credit sitting on their account from returns and old-gold
// exchanges (a negative Client.currentBalance). Net of any dues — if they owe us more than we owe them there is
// nothing to spend. Read fresh by the New Sale screen once a customer is picked.
export async function getClientCredit(ctx: TenantContext, clientId: string) {
  await assertOwnedByCompany('client', clientId, ctx.companyId, 'Client');
  const client = await tenantQuery(ctx.companyId, (tx) =>
    tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { currentBalance: true } })
  );
  const balance = Number(client.currentBalance);
  return { clientId, balance, available: Math.max(-balance, 0) };
}

export async function returnMemoItems(memoId: string, tagIds: string[], ctx: TenantContext, userId: string) {
  // Layer 2: the memo itself must belong to the caller's company.
  const memo = await tenantQuery(ctx.companyId, (_tx) => _tx.memoOut.findUnique({
    where: { id: memoId },
    include: { items: true },
  }));
  if (!memo || memo.companyId !== ctx.companyId) throw new AppError('Memo not found', 404);
  if (memo.status === 'RETURNED' || memo.status === 'CONVERTED') {
    throw new AppError('Memo is already closed', 400);
  }

  // Every tagId supplied must correspond to a real, still-OUT item on THIS memo — a tagId that
  // isn't actually part of this memo (forged, mistyped, or belonging to another memo/company
  // entirely) is rejected outright rather than silently matching zero rows in the updateMany
  // below, which would have looked like success while doing nothing.
  const memoItemByTagId = new Map(memo.items.filter((mi) => mi.tagId).map((mi) => [mi.tagId as string, mi]));
  for (const tagId of tagIds) {
    const mi = memoItemByTagId.get(tagId);
    if (!mi || mi.status !== 'OUT') throw new AppError(`Tag ${tagId} is not an outstanding item on this memo`, 404);
  }

  return tenantTransaction(ctx.companyId, async (tx) => {
    // Mark specified memo items as returned
    await tx.memoItem.updateMany({
      where: { memoId, companyId: ctx.companyId, tagId: { in: tagIds } },
      data: { status: 'RETURNED', returnedPieces: 1 },
    });

    // Return tags to IN_STOCK
    await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, companyId: ctx.companyId },
      data: { status: 'IN_STOCK' },
    });

    // If all items returned → close memo
    const remaining = await tx.memoItem.count({ where: { memoId, status: 'OUT' } });
    if (remaining === 0) {
      await tx.memoOut.update({ where: { id: memoId }, data: { status: 'RETURNED' } });
    }

    return tx.memoOut.findUnique({
      where: { id: memoId },
      include: { items: { include: { tag: { select: { tagNumber: true, status: true } } } } },
    });
  });
}

// D2/multi-tenant Phase 2: previously derived companyId from memo.client.companyId and branchId
// from "whichever tag happened to be first in the array" — both fixed now that MemoOut itself
// carries its own companyId+branchId (set once, correctly, at createMemoOut time) and every tag
// in the conversion is explicitly validated against THIS memo and THIS company, not inferred.
export async function convertMemoToInvoice(
  memoId: string,
  items: Array<{
    tagId: string;
    sellingPrice: number;     // final selling price (editable by user)
    description?: string;
  }>,
  ctx: TenantContext,
  userId: string,
) {
  const memo = await tenantQuery(ctx.companyId, (_tx) => _tx.memoOut.findUnique({
    where: { id: memoId },
    include: { client: true, items: { include: { tag: true } } },
  }));
  if (!memo || memo.companyId !== ctx.companyId) throw new AppError('Memo not found', 404);
  if (memo.status === 'CONVERTED') throw new AppError('Memo already converted to invoice', 400);
  if (memo.status === 'RETURNED') throw new AppError('Memo is already returned', 400);

  // Layer 2, exhaustive: the branch the memo was sent from must still be one the CONVERTING
  // user is authorized for (not just whoever created the memo originally).
  await assertBranchAccessible(memo.branchId, ctx, 'Memo branch');

  const tagIds = items.map((i) => i.tagId);
  if (new Set(tagIds).size !== tagIds.length) {
    throw new AppError('The same tag cannot appear on more than one line of this conversion', 400);
  }

  // Every tagId in `items` MUST correspond to a real, still-OUT MemoItem on THIS memo, whose
  // resolved tag ACTUALLY belongs to ctx.companyId. This is the fix item 2 called for
  // explicitly: no more "derive ownership from whichever tag resolves first" — every single
  // line is independently proven to belong to this memo and this company before any pricing,
  // invoice creation, or status flip happens. A forged tagId (wrong memo, wrong company, or one
  // that simply doesn't exist) is rejected with the same 404 a nonexistent id would get.
  const memoItemByTagId = new Map(memo.items.filter((mi) => mi.tagId).map((mi) => [mi.tagId as string, mi]));
  for (const tagId of tagIds) {
    const mi = memoItemByTagId.get(tagId);
    if (!mi || mi.status !== 'OUT') {
      throw new AppError(`Tag ${tagId} is not an outstanding item on this memo`, 404);
    }
    if (!mi.tag || mi.tag.companyId !== ctx.companyId) {
      throw new AppError(`Tag ${tagId} not found`, 404);
    }
  }

  // G1 Part D: reuse the SAME central tax engine createInvoice/amendInvoice use (priceInvoice) —
  // no second, divergent flat-rate calculation. Each line stays FIXED-rate (the memo's
  // already-agreed sellingPrice IS the decided price, exactly as before); HSN is omitted per line
  // (defaults to DEFAULT_HSN_CODE), matching this path's pre-existing single-rate behavior
  // numerically exactly when no per-line override is given (every line shares one rate, so the
  // per-line-then-summed tax below reduces to the old flat subtotal*rate). One side-effect of
  // reuse, not a bug: a tagged line's own ProductCategory is now attached (createInvoice already
  // does this; this path silently never had it before), and the automatic round-off this path was
  // explicitly missing (CLAUDE.md's own noted gap) now applies, booked to LEDGER_ACCOUNT.ROUND_OFF
  // below exactly like createInvoice's own entry.
  const invoiceDate = new Date();
  const mappedItems = items.map((lineItem) => {
    const memoItem = memoItemByTagId.get(lineItem.tagId)!;
    const tag = memoItem.tag!;
    return {
      productCode: tag.tagNumber,
      description: lineItem.description ?? memoItem.description ?? tag.name,
      huid: tag.huid ?? memoItem.huid ?? undefined,
      karat: tag.metalKarat ?? memoItem.karat ?? undefined,
      quantity: 1,
      grossWeight: Number(tag.grossWeight),
      netGoldWeight: Number(tag.netWeight),
      stoneWeight: Number(tag.stoneWeight),
      rateType: 'FIXED',
      goldRate: lineItem.sellingPrice,
      tagId: lineItem.tagId,
    };
  });
  const priced = await priceInvoice({ invoiceDate, currency: 'INR', items: mappedItems }, ctx);
  const { items: pricedItems, subtotal, taxAmount, totalAmount, discountScale, roundOffExact } = priced;

  const invoice = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoiceNumber = await nextDocumentNumber(ctx.companyId, 'INV', 'INV', tx, gstFinancialYear(invoiceDate));

    // F3: dealer credit limit — same check createInvoice runs, the memo path's client was already
    // loaded above so this is free.
    checkCreditLimit(memo.client, totalAmount);
    assertPanIfRequired(memo.client, totalAmount); // Rule 114B — same check as createInvoice (a GSTIN carries the dealer's PAN)

    // GST record. Same invariant as createInvoice (A1): a taxable INR sale must never emit an
    // e-invoice claiming zero GST. currency is hardcoded to 'INR' above, so this can't trip today,
    // but it's cheap insurance if this function ever grows a currency/discount parameter.
    if (subtotal > 0 && taxAmount <= 0) {
      throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
    }

    // G1 Part E: same seller-registration resolution and immutable seller/buyer snapshot as
    // createInvoice — fixes the hardcoded-seller-identity bug on this path too.
    const seller = await resolveSellerRegistration(tx, ctx.companyId, memo.branchId);
    // G2g-7g: a memo conversion is a real SalesInvoice-creating path too (invoiceDate is always
    // "now" here, but "now" can itself already fall inside an already-FILED/LOCKED current period).
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_INVOICE', documentId: invoiceNumber,
      gstRegistrationId: seller.registrationId, documentDate: invoiceDate, action: 'created',
    });
    // B2: same free-text-to-code resolution as createInvoice.
    const clientStateCode = await resolveStateCode(memo.client.state);
    const isSameState = clientStateCode === seller.stateCode;
    const { cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt } = splitGst(taxAmount, isSameState);

    // G1 Part D: per-line tax split, same numbers the invoice-level split above uses.
    const lineTax = allocateLineTax(pricedItems, discountScale, isSameState);
    const itemsWithTax = pricedItems.map((it, idx) => ({ ...it, ...lineTax[idx] }));

    const inv = await tx.salesInvoice.create({
      data: {
        companyId: ctx.companyId, branchId: memo.branchId,
        invoiceNumber,
        clientId: memo.clientId,
        invoiceDate,
        invoiceType: 'APPROVAL_CONVERTED',
        currency: 'INR',
        exchangeRate: 1,
        subtotal, taxAmount, roundOff: roundOffExact, totalAmount,
        balanceDue: totalAmount,
        notes: `Converted from approval memo ${memo.memoNumber}`,
        items: { createMany: { data: itemsWithTax } },
      },
      include: { client: true, items: true },
    });

    await tx.taxInvoice.create({
      data: {
        companyId: ctx.companyId,
        invoiceId: inv.id, gstin: seller.gstin,
        placeOfSupply: clientStateCode ?? memo.client.state ?? '', taxableAmount: subtotal,
        cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt, totalTax: taxAmount,
        sellerRegistrationId: seller.registrationId,
        sellerLegalName: seller.sellerLegalName, sellerTradeName: seller.sellerTradeName,
        sellerStateCode: seller.sellerStateCode, sellerAddress: seller.sellerAddress,
        sellerCity: seller.sellerCity, sellerDistrict: seller.sellerDistrict,
        sellerPincode: seller.sellerPincode, sellerCountry: seller.sellerCountry,
        ...buyerSnapshot(memo.client, clientStateCode),
      },
    });

    // Debit client
    await tx.client.update({
      where: { id: memo.clientId },
      data: { currentBalance: { increment: totalAmount } },
    });

    // Mark converted tags as SOLD — re-scoped to companyId here too (the query that actually
    // mutates), count-checked so a tag that changed status just now (e.g. a race) is caught
    // rather than silently under-flipping.
    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, companyId: ctx.companyId },
      data: { status: 'SOLD' },
    });
    if (flipped.count !== tagIds.length) {
      throw new AppError('One or more items changed status just now — retry the conversion', 409);
    }

    // F1 gap closed (Phase 2): this path (wholesale/dealer sales via memo conversion) never
    // posted a JournalEntry — only createInvoice's direct-sale path did, so Trial Balance/P&L
    // silently excluded every memo-converted sale. Same AR/Revenue/GST/COGS/Inventory/Round-off
    // shape as createInvoice's own entry, sized off each converted tag's own costPrice (COGS is
    // always present here — unlike createInvoice, every line on this path is tag-backed, never free-text).
    const cogsAmount = tagIds.reduce((s, tagId) => s + Number(memoItemByTagId.get(tagId)!.tag!.costPrice), 0);
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: inv.invoiceDate, description: `Memo Conversion ${invoiceNumber}`,
      referenceType: 'SalesInvoice', referenceId: inv.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, credit: subtotal },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, credit: cgstAmt },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, credit: sgstAmt },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, credit: igstAmt },
        { accountCode: LEDGER_ACCOUNT.ROUND_OFF, credit: roundOffExact > 0 ? roundOffExact : 0, debit: roundOffExact < 0 ? -roundOffExact : 0 },
        { accountCode: LEDGER_ACCOUNT.COST_OF_GOODS, debit: cogsAmount },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, credit: cogsAmount },
      ],
    });

    // Mark converted memo items as SOLD
    await tx.memoItem.updateMany({
      where: { memoId, companyId: ctx.companyId, tagId: { in: tagIds } },
      data: { status: 'SOLD' },
    });

    // Check if all memo items are now closed
    const stillOut = await tx.memoItem.count({ where: { memoId, status: 'OUT' } });
    await tx.memoOut.update({
      where: { id: memoId },
      data: { status: stillOut === 0 ? 'CONVERTED' : 'OUT' },
    });

    return inv;
  });

  await createAuditEntry('sales_invoices', invoice.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return invoice;
}

// H1: every SalesInvoice in a period — retail + wholesale together (invoiceType is just a label
// on the row, both channels land in the same table), filterable by salesperson and (now that
// SalesInvoice carries its own branchId directly — Phase 2) by branch exactly, not just
// approximately through a line's tag.
export async function getSalesRegister(ctx: TenantContext, filters: {
  from: Date; to: Date; salesPersonId?: string; branchId?: string;
}) {
  // A specific branchId request must itself be one the caller is granted (assertBranchAccessible
  // throws otherwise); with no specific request, a branch-restricted caller is still capped to
  // their own allowed set rather than seeing the whole company's register.
  if (filters.branchId) await assertBranchAccessible(filters.branchId, ctx);
  const branchFilter = filters.branchId
    ? filters.branchId
    : (ctx.branchAccess.allBranches ? undefined : { in: ctx.branchAccess.branchIds });

  const invoices = await tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.findMany({
    where: {
      companyId: ctx.companyId,
      invoiceDate: { gte: filters.from, lte: filters.to },
      // J3.5 Finding 1: a voided invoice was never a completed sale — exclude it from the register
      // entirely (not just its totals), the same way a DRAFT/PARTIALLY_PAID/PAID one that's still a
      // real sale is correctly included regardless of payment status.
      status: { not: 'VOID' },
      ...(filters.salesPersonId && { salesPersonId: filters.salesPersonId }),
      ...(branchFilter && { branchId: branchFilter }),
    },
    include: {
      client: { select: { clientCode: true, name: true, type: true } },
      salesPerson: { select: { name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { invoiceDate: 'asc' },
  }));

  const rows = invoices.map((inv) => ({
    id: inv.id, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate,
    invoiceType: inv.invoiceType, status: inv.status,
    client: inv.client, salesPerson: inv.salesPerson?.name ?? null,
    itemCount: inv._count.items, currency: inv.currency,
    subtotal: Number(inv.subtotal), taxAmount: Number(inv.taxAmount),
    totalAmount: Number(inv.totalAmount), paidAmount: Number(inv.paidAmount), balanceDue: Number(inv.balanceDue),
  }));

  const byType: Record<string, { count: number; totalAmount: number }> = {};
  for (const r of rows) {
    const bucket = byType[r.invoiceType] ?? { count: 0, totalAmount: 0 };
    bucket.count += 1;
    bucket.totalAmount += r.totalAmount;
    byType[r.invoiceType] = bucket;
  }

  return {
    from: filters.from, to: filters.to, rows, byType,
    totals: {
      count: rows.length,
      subtotal: rows.reduce((s, r) => s + r.subtotal, 0),
      taxAmount: rows.reduce((s, r) => s + r.taxAmount, 0),
      totalAmount: rows.reduce((s, r) => s + r.totalAmount, 0),
      balanceDue: rows.reduce((s, r) => s + r.balanceDue, 0),
    },
  };
}

export async function generatePackingList(ctx: TenantContext, invoiceId: string) {
  const invoice = await tenantQuery(ctx.companyId, (_tx) => _tx.salesInvoice.findUnique({
    where: { id: invoiceId },
    include: { client: true, items: true, taxDetails: true },
  }));
  if (!invoice || invoice.companyId !== ctx.companyId) throw new AppError('Invoice not found', 404);

  return {
    documentType: 'PACKING_LIST',
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    client: invoice.client,
    currency: invoice.currency,
    exchangeRate: invoice.exchangeRate,
    items: invoice.items.map((i) => ({
      productCode: i.productCode,
      description: i.description,
      huid: i.huid,
      karat: i.karat,
      quantity: i.quantity,
      grossWeightGrams: i.grossWeight,
      netGoldWeightGrams: i.netGoldWeight,
      stoneWeightCts: i.stoneWeight,
      unitValue: i.unitPrice,
      totalValue: i.totalPrice,
    })),
    totals: {
      pieces: invoice.items.reduce((s, i) => s + i.quantity, 0),
      grossWeight: invoice.items.reduce((s, i) => s + Number(i.grossWeight) * i.quantity, 0),
      netGoldWeight: invoice.items.reduce((s, i) => s + Number(i.netGoldWeight) * i.quantity, 0),
      stoneWeight: invoice.items.reduce((s, i) => s + Number(i.stoneWeight) * i.quantity, 0),
      totalValue: invoice.totalAmount,
    },
    generatedAt: new Date(),
  };
}
