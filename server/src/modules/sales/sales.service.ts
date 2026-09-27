import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { emit } from '../../shared/websocket';
import { DEFAULT_HSN_CODE, CREDIT_SETTLEMENT_MODES, PAYMENT_MODE_OLD_GOLD, PAYMENT_MODE_STORE_CREDIT } from '../../shared/constants';
import { assertPanIfRequired, assertCashLimit } from '../../shared/compliance';
import { resolveStateCode } from '../../shared/stateMaster';
import { resolveMetalRate } from '../../shared/metalRate';
import { isValidKarat } from '../../shared/karatMaster';
import { addMetalStock } from '../inventory/inventory.service';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT, cashOrBankAccount } from '../../shared/ledgerAccounts';
import { nextDocumentNumber } from '../../shared/numberSequence';
import { TenantContext, tenantTransaction, tenantQuery, tenantBatch } from '../../shared/tenantContext';
import { assertBranchAccessible, assertOwnedByCompany, assertAllOwned } from '../../middleware/tenant';

// The customer's old metal handed over against this bill (mode OLD_GOLD) — see createInvoice.
type OldGoldInput = {
  description: string; karat: string; grossWeight: number; stoneWeight?: number; deductionPercent?: number;
};

type PaymentInput = {
  paymentDate: Date; amount: number; mode: string;
  referenceNo?: string; forexRate?: number; notes?: string;
  /** Required when mode is OLD_GOLD; `amount` is then ignored — the server values the metal itself. */
  oldGold?: OldGoldInput;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const normalizeMode = (mode: string) => mode.trim().toUpperCase();

// OLD_GOLD / STORE_CREDIT only exist inside createInvoice (they settle a bill from credit); a standalone
// "record a payment" has no such thing to draw on, so it must not accept them.
function assertReceiptMode(mode: string) {
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
  const client = await tenantQuery(ctx.companyId, (_tx) => _tx.client.findUnique({ where: { id: data.clientId }, select: { companyId: true } }));
  if (!client || client.companyId !== ctx.companyId) throw new AppError('Client not found', 404);

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
  categoryId?: string; /* ProductCategory — tagged lines default to the tag's own category */
  /* karat (above, near goldRate) doubles as the MakingCharge master's other match key —
    tagged lines default it to the tag's own metalKarat when omitted, same as categoryId. */
  tagId?: string; /* optional link to real inventory — see JewelryTag */
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

  const { currency, tagIds, items, subtotal, discount, otherCharges, taxableAmount, taxAmount, roundOffExact, totalAmount } =
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

  const invoice = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoiceNumber = await nextDocumentNumber(ctx.companyId, 'INV', 'INV', tx, data.invoiceDate.getFullYear());

    // F3: dealer credit limit — checked first, before any tag is touched, so a sale that's going
    // to be rejected doesn't flip inventory it'll just have to unwind.
    // Layer 2: clientId is explicitly scoped to ctx.companyId — a Company-B clientId must fail
    // here (404, "not found") exactly like a nonexistent id, not proceed to be billed against.
    const client = await tx.client.findUnique({ where: { id: data.clientId } });
    if (!client || client.companyId !== ctx.companyId) {
      throw new AppError('Client not found', 404);
    }
    checkCreditLimit(client, totalAmount);
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
        items: { createMany: { data: items } }, // (no companyId here: this row is written through a COMPOSITE relation, so Prisma fills it from the parent)
      },
      include: { client: true, items: true, salesPerson: { select: { id: true, name: true } } },
    });

    // Create GST tax record if INR invoice. cgstAmt/sgstAmt/igstAmt default to 0 (non-INR sale,
    // or a fully-discounted taxableAmount <= 0 sale) and feed the F1 journal entry below either way.
    let cgstAmt = 0, sgstAmt = 0, igstAmt = 0;
    if (currency === 'INR') {
      // A taxable INR sale must never emit an e-invoice claiming zero GST — if this trips, some
      // future change reintroduced a divergent rate calc; fail loudly rather than filing a bad
      // TaxInvoice. (A fully-discounted sale with taxableAmount <= 0 legitimately owes no tax.)
      if (taxableAmount > 0 && taxAmount <= 0) {
        throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
      }

      // Multi-tenant fix: this used to read process.env.COMPANY_STATE_CODE/GSTIN — a single,
      // process-wide value that would have been WRONG for every company but one the moment a
      // second company's invoices ran through this same server process. GSTIN/state now come
      // from the resolved Company row for the invoice's own companyId, not a global env var.
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
      const COMPANY_STATE = company.stateCode ?? '';
      // B2: client.state is free text (e.g. "Gujarat"), not a GST code — resolve it via the state
      // master before comparing. No confident match (blank/unrecognized — the common case for a
      // lightweight walk-in retail Client) is treated as inter-state, same as before this fix.
      const clientStateCode = await resolveStateCode(client.state);
      const isSameState = clientStateCode === COMPANY_STATE;

      cgstAmt = isSameState ? taxAmount / 2 : 0;
      sgstAmt = isSameState ? taxAmount / 2 : 0;
      igstAmt = isSameState ? 0 : taxAmount;

      await tx.taxInvoice.create({
        data: {
          companyId: ctx.companyId,
          invoiceId: inv.id,
          gstin: company.gstin ?? 'N/A',
          placeOfSupply: clientStateCode ?? client.state ?? '',
          taxableAmount,
          cgst: cgstAmt,
          sgst: sgstAmt,
          igst: igstAmt,
          totalTax: taxAmount,
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
          const exchange = await bookOldGoldExchange(tx, ctx, userId, { clientId: data.clientId, ...p.oldGold!, notes: p.notes }, v);
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

  const items = data.items.map((i) => {
    const { hsnCode, categoryId, id: _lineId, ...rest } = i; // id never reaches the row data
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
    return {
      ...rest, tagId: i.tagId ?? null, goldRate, makingCharge, wastagePercent,
      stoneWeight: i.stoneWeight ?? 0, stoneValue: i.stoneValue ?? 0, unitPrice, totalPrice,
      hsnCodeId: hsn.id, taxRate: Number(hsn.gstRate),
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
    roundOffExact, totalAmount,
  };
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
  const lineIdsIn = data.items.map((i) => i.id).filter(Boolean) as string[];
  if (new Set(lineIdsIn).size !== lineIdsIn.length) throw new AppError('The same invoice line appears twice', 400);

  const invoiceDate = data.invoiceDate ?? head.invoiceDate;
  const priced = await priceInvoice({
    invoiceDate, currency: head.currency, discountAmount: data.discountAmount, otherCharges: data.otherCharges,
    roundOff: data.roundOff, items: data.items,
  }, ctx);
  const { currency, tagIds: newTagIds, items, lineIds, subtotal, discount, otherCharges, taxableAmount, taxAmount, roundOffExact } = priced;
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

  const { before, after, updated } = await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise amendments of the same invoice, then read its state FRESH — payments, returns and tag statuses as
    // they are now, not as they were when the screen was opened.
    await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const inv = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        items: true, taxDetails: true, payments: { select: { id: true } },
        returns: { include: { items: { select: { invoiceItemId: true } } } },
      },
    });
    const newClientId = data.clientId ?? inv.clientId;
    const clientChanged = newClientId !== inv.clientId;
    if (clientChanged && (inv.payments.length > 0 || inv.returns.length > 0)) {
      throw new AppError('The customer cannot be changed once a payment or return is recorded on this invoice', 409);
    }

    const oldById = new Map(inv.items.map((i) => [i.id, i]));
    for (const id of lineIdsIn) if (!oldById.has(id)) throw new AppError(`Invoice line not found on this invoice: ${id}`, 404);

    // Returned lines are locked — the return has already reversed them (tag back in stock, ledger, customer credit).
    const returnedIds = new Set(inv.returns.flatMap((r) => r.items.map((x) => x.invoiceItemId)));
    for (const id of returnedIds) {
      const old = oldById.get(id)!;
      const at = lineIds.indexOf(id);
      const now = at >= 0 ? items[at] : undefined;
      if (!now || (now.tagId ?? null) !== old.tagId || now.quantity !== old.quantity || Math.abs(now.totalPrice - Number(old.totalPrice)) > 0.005) {
        throw new AppError(`Line ${old.productCode} has been returned and cannot be changed or removed`, 409);
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
    let cgstAmt = 0, sgstAmt = 0, igstAmt = 0;
    if (currency === 'INR') {
      if (taxableAmount > 0 && taxAmount <= 0) throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
      const clientStateCode = await resolveStateCode(client.state);
      const isSameState = clientStateCode === (company.stateCode ?? '');
      cgstAmt = isSameState ? taxAmount / 2 : 0;
      sgstAmt = isSameState ? taxAmount / 2 : 0;
      igstAmt = isSameState ? 0 : taxAmount;
      const gst = {
        gstin: company.gstin ?? 'N/A', placeOfSupply: clientStateCode ?? client.state ?? '',
        taxableAmount, cgst: cgstAmt, sgst: sgstAmt, igst: igstAmt, totalTax: taxAmount,
      };
      if (inv.taxDetails) await tx.taxInvoice.update({ where: { invoiceId }, data: gst });
      else await tx.taxInvoice.create({ data: { companyId: ctx.companyId, invoiceId, ...gst } });
    }

    // Lines: update in place, add, remove.
    if (removedIds.length > 0) await tx.invoiceItem.deleteMany({ where: { id: { in: removedIds }, invoiceId, companyId: ctx.companyId } });
    const toCreate: typeof items = [];
    for (let i = 0; i < items.length; i++) {
      if (lineIds[i]) await tx.invoiceItem.update({ where: { id: lineIds[i]! }, data: items[i] });
      else toCreate.push(items[i]);
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

  await createAuditEntry('sales_invoices', invoiceId, userId, 'AMEND', before, { ...after, reason: data.reason ?? null }, ctx.companyId);
  return updated;
}

// Shared by recordPayment (the standalone "record a payment later" endpoint) and createInvoice's
// optional inline payment (bill-and-collect in one screen). Both must apply a payment to an
// invoice + client balance identically — duplicating this math in two places is exactly how the
// A1 currency bug happened (two code paths computing the same thing, silently drifting apart).
async function applyPayment(
  tx: Prisma.TransactionClient,
  companyId: string,
  invoice: { id: string; clientId: string; paidAmount: unknown; totalAmount: unknown; exchangeRate: unknown },
  data: PaymentInput,
  userId: string,
  // fromCredit: this "payment" settles the bill out of credit the customer already holds (old gold just
  // booked, or store credit from a return) — the row and the invoice's paid/due figures are written as for
  // any payment, but no cash came in, so there is no journal and the client's balance is left alone (the
  // credit was booked in the ledger and on the balance when it arose; the sale's debit already netted it).
  opts: { fromCredit?: boolean } = {},
) {
  const forexGainLoss = data.forexRate
    ? (Number(invoice.exchangeRate) - data.forexRate) * data.amount
    : 0;

  // Sec 269ST — before anything is written. Earlier splits of the same sale are already in the table
  // (same transaction), so a bill-and-collect with several CASH splits is aggregated correctly.
  if (!opts.fromCredit) await assertCashLimit(tx, companyId, invoice.clientId, data);

  const newPaid = Number(invoice.paidAmount) + data.amount;
  const newBalance = Number(invoice.totalAmount) - newPaid;
  const paymentNumber = await nextDocumentNumber(companyId, 'PMT', 'PMT', tx, data.paymentDate.getFullYear());

  const payment = await tx.invoicePayment.create({
    data: {
      companyId, paymentNumber, invoiceId: invoice.id, clientId: invoice.clientId,
      paymentDate: data.paymentDate, amount: data.amount,
      mode: data.mode, referenceNo: data.referenceNo, notes: data.notes,
      forexRate: data.forexRate, forexGainLoss: forexGainLoss || null,
    },
  });

  await tx.salesInvoice.update({
    where: { id: invoice.id },
    data: {
      paidAmount: newPaid,
      balanceDue: newBalance,
      status: newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID',
    },
  });

  if (!opts.fromCredit) {
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
    return applyPayment(tx, ctx.companyId, invoice, data, userId);
  });
}

// F2: a standalone/on-account payment — an advance, or a payment against a client's general
// outstanding balance rather than one specific invoice. Same InvoicePayment row shape and PMT-
// numbering as an invoice-scoped payment (applyPayment above), just with no invoice to update
// paidAmount/balanceDue/status on: this only ever moves client.currentBalance and the ledger.
export async function recordClientPayment(data: PaymentInput & { clientId: string }, ctx: TenantContext, userId: string) {
  if (data.amount <= 0) throw new AppError('Payment amount must be positive', 400);
  assertReceiptMode(data.mode);
  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');

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
  items: Array<{ invoiceItemId: string; amount?: number }>; // amount defaults to what the
  // customer actually paid for that line: totalPrice grossed up by its own snapshotted taxRate
  // (matching client.currentBalance's debit on sale, which is tax-inclusive) — not a formal GST
  // credit-note reversal (no TaxInvoice counterpart is created; see CLAUDE.md/ROADMAP D1 notes).
  reason?: string;
  notes?: string;
}, ctx: TenantContext, userId: string) {
  if (data.items.length === 0) throw new AppError('At least one item is required', 400);

  // Layer 2: the invoice is validated as belonging to ctx.companyId — a Company-B invoiceId
  // must 404, not let a Company-A user return items against another company's sale.
  const invoice = await tenantQuery(ctx.companyId, (_tx) => _tx.salesInvoice.findUnique({
    where: { id: data.invoiceId },
    include: { items: true, taxDetails: true },
  }));
  if (!invoice || invoice.companyId !== ctx.companyId) throw new AppError('Invoice not found', 404);

  // F1: whether the original sale charged GST at all (INR only — see createInvoice's own
  // currency === 'INR' gate) and, if so, same-state (CGST+SGST) vs inter-state (IGST) — read off
  // the invoice's own TaxInvoice rather than re-resolving the client's state, so a return always
  // reverses exactly what was actually charged, even if the client's state master entry changes
  // later.
  const taxDetails = invoice.taxDetails;
  const isSameState = !!taxDetails && Number(taxDetails.cgst) > 0;

  const invoiceItemById = new Map(invoice.items.map((i) => [i.id, i]));
  const resolvedItems = data.items.map((r) => {
    const line = invoiceItemById.get(r.invoiceItemId);
    if (!line) throw new AppError(`Invoice item not found on this invoice: ${r.invoiceItemId}`, 404);
    if (!line.tagId) throw new AppError('Only tagged lines can be returned (no physical item on a free-text line)', 400);
    const taxRate = taxDetails ? Number(line.taxRate) : 0;
    const paidAmount = Number(line.totalPrice) * (1 + taxRate);
    const amount = r.amount ?? paidAmount;
    // Back out the revenue/tax split from whatever amount is actually being refunded (the default
    // or a caller override) — same tax-inclusive assumption the default itself uses.
    const revenuePortion = amount / (1 + taxRate);
    return {
      invoiceItemId: line.id, tagId: line.tagId, amount,
      revenuePortion, taxPortion: amount - revenuePortion,
    };
  });

  const tagIds = resolvedItems.map((r) => r.tagId);
  if (new Set(tagIds).size !== tagIds.length) {
    throw new AppError('The same tag cannot appear on more than one line of a return', 400);
  }

  const totalAmount = resolvedItems.reduce((s, r) => s + r.amount, 0);
  const revenueReversal = resolvedItems.reduce((s, r) => s + r.revenuePortion, 0);
  const taxReversal = resolvedItems.reduce((s, r) => s + r.taxPortion, 0);

  const salesReturn = await tenantTransaction(ctx.companyId, async (tx) => {
    // Friendly pre-check for the common case; the count-checked updateMany below is the
    // authoritative guard (same pattern createInvoice uses for its own flip). companyId is
    // included here too — a tag in this list is only ever populated from invoice.items, which
    // is already proven to belong to this company via the invoice check above, but scoping the
    // query itself is cheap, consistent insurance against a future code path reusing this same
    // helper with less-trusted input.
    const tags = await tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } });
    const notSold = tags.filter((t) => t.status !== 'SOLD');
    if (notSold.length > 0) {
      throw new AppError(`Tag(s) not currently SOLD, cannot return: ${notSold.map((t) => t.tagNumber).join(', ')}`, 409);
    }

    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, status: 'SOLD', companyId: ctx.companyId },
      data: { status: 'IN_STOCK' },
    });
    if (flipped.count !== tagIds.length) {
      throw new AppError('One or more tags changed status just now — retry the return', 409);
    }

    const returnNumber = await nextDocumentNumber(ctx.companyId, 'SRET', 'SRET', tx);

    // F1 COGS/inventory reversal — the returned piece goes back on the shelf at its own
    // (immutable) costPrice, same figure createInvoice originally moved out of Inventory.
    const costPriceByTagId = new Map(tags.map((t) => [t.id, Number(t.costPrice)]));
    const cogsReversal = resolvedItems.reduce((s, r) => s + (costPriceByTagId.get(r.tagId) ?? 0), 0);

    const created = await tx.salesReturn.create({
      data: {
        companyId: ctx.companyId,
        returnNumber,
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        reason: data.reason,
        notes: data.notes,
        totalAmount,
        items: {
          createMany: {
            data: resolvedItems.map((r) => ({ invoiceItemId: r.invoiceItemId, tagId: r.tagId, amount: r.amount })),
          },
        },
      },
      include: { items: { include: { tag: { select: { tagNumber: true } } } } },
    });

    // F1: exact reversal of createInvoice's compound entry, scoped to just the returned lines —
    // Dr Revenue + Dr GST payable + Dr Inventory must equal Cr Accounts Receivable + Cr COGS.
    await postAutoJournalEntry(tx, ctx.companyId, {
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

    return created;
  });

  await createAuditEntry('sales_returns', salesReturn.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return salesReturn;
}

// D4: a customer's old/used gold piece taken in and valued. Credits Client.currentBalance (the
// same field a sale debits and createSalesReturn credits) as a standing store credit, redeemable
// against any future purchase — not tied to one specific invoice (confirmed with the user).
// Also adds the melted-down weight to the Metal Vault via the existing addMetalStock(), so the
// physical metal is tracked, not just the financial side.
export async function createOldGoldExchange(data: {
  clientId: string;
  description: string;
  karat: string;
  grossWeight: number;
  stoneWeight?: number;
  deductionPercent?: number;
  exchangeDate?: Date;
  notes?: string;
}, ctx: TenantContext, userId: string) {
  // Layer 2: the client this exchange credits must belong to the caller's own company.
  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');

  const exchangeDate = data.exchangeDate ?? new Date();
  const valuation = await valueOldGold(data, exchangeDate, ctx);

  const exchange = await tenantTransaction(ctx.companyId, (tx) => bookOldGoldExchange(tx, ctx, userId, data, valuation));

  await createAuditEntry('old_gold_exchanges', exchange.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return exchange;
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
  data: { clientId: string; description: string; karat: string; grossWeight: number; notes?: string },
  v: OldGoldValuation,
) {
  const exchangeNumber = await nextDocumentNumber(ctx.companyId, 'OGX', 'OGX', tx, v.exchangeDate.getFullYear());
  const stock = await addMetalStock(
    {
      materialName: data.description, karat: data.karat, purity: v.purity,
      grossWeight: data.grossWeight, netWeight: v.netWeight,
      sourceType: 'CUSTOMER_SUPPLIED', sourceRef: exchangeNumber, avgCostPerGram: v.deductedRate,
    },
    ctx.companyId, userId, tx
  );

  const created = await tx.oldGoldExchange.create({
    data: {
      companyId: ctx.companyId,
      exchangeNumber, clientId: data.clientId, exchangeDate: v.exchangeDate, description: data.description,
      karat: data.karat, grossWeight: data.grossWeight, stoneWeight: v.stoneWeight, netWeight: v.netWeight,
      ratePerGram: v.ratePerGram, deductionPercent: v.deductionPercent, valuedAmount: v.valuedAmount,
      metalStockId: stock.id, notes: data.notes,
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

  const subtotal = items.reduce((s, i) => s + i.sellingPrice, 0);

  // Memo conversion doesn't take a per-line HSN from the caller — always the default (B1 gave
  // createInvoice per-line HSN; the memo path stays single-rate for now, same as before).
  const defaultHsn = await prisma.hsnCode.findUniqueOrThrow({ where: { code: DEFAULT_HSN_CODE } });
  const taxRate = Number(defaultHsn.gstRate);
  const taxAmount = subtotal * taxRate;
  const totalAmount = subtotal + taxAmount;

  const invoice = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoiceNumber = await nextDocumentNumber(ctx.companyId, 'INV', 'INV', tx);

    // F3: dealer credit limit — same check createInvoice runs, the memo path's client was already
    // loaded above so this is free.
    checkCreditLimit(memo.client, totalAmount);
    assertPanIfRequired(memo.client, totalAmount); // Rule 114B — same check as createInvoice (a GSTIN carries the dealer's PAN)

    // Build invoice items from memo items matched by tagId — every lookup below is guaranteed
    // to hit (memoItemByTagId/tag were already proven to exist above), so there is no longer a
    // silent "??" fallback path masking a forged/missing tag.
    const invoiceItems = items.map((lineItem) => {
      const memoItem = memoItemByTagId.get(lineItem.tagId)!;
      const tag = memoItem.tag!;
      return {
        productCode: tag.tagNumber,
        description: lineItem.description ?? memoItem.description ?? tag.name,
        huid: tag.huid ?? memoItem.huid ?? null,
        karat: tag.metalKarat ?? memoItem.karat ?? null,
        quantity: 1,
        grossWeight: Number(tag.grossWeight),
        netGoldWeight: Number(tag.netWeight),
        stoneWeight: Number(tag.stoneWeight),
        rateType: 'FIXED',
        goldRate: lineItem.sellingPrice,
        makingCharge: 0,
        stoneValue: 0,
        unitPrice: lineItem.sellingPrice,
        totalPrice: lineItem.sellingPrice,
        tagId: lineItem.tagId,
        hsnCodeId: defaultHsn.id,
        taxRate,
      };
    });

    const inv = await tx.salesInvoice.create({
      data: {
        companyId: ctx.companyId, branchId: memo.branchId,
        invoiceNumber,
        clientId: memo.clientId,
        invoiceDate: new Date(),
        invoiceType: 'APPROVAL_CONVERTED',
        currency: 'INR',
        exchangeRate: 1,
        subtotal,
        taxAmount,
        totalAmount,
        balanceDue: totalAmount,
        notes: `Converted from approval memo ${memo.memoNumber}`,
        items: { createMany: { data: invoiceItems } },
      },
      include: { client: true, items: true },
    });

    // GST record. Same invariant as createInvoice (A1): a taxable INR sale must never emit an
    // e-invoice claiming zero GST. currency is hardcoded to 'INR' above, so this can't trip today,
    // but it's cheap insurance if this function ever grows a currency/discount parameter.
    if (subtotal > 0 && taxAmount <= 0) {
      throw new AppError('Refusing to emit a zero-GST tax invoice on a taxable INR sale', 500);
    }

    // Same multi-tenant fix as createInvoice(): read from the resolved Company row, not a
    // global env var.
    const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    const COMPANY_STATE = company.stateCode ?? '';
    // B2: same free-text-to-code resolution as createInvoice.
    const clientStateCode = await resolveStateCode(memo.client.state);
    const isSameState = clientStateCode === COMPANY_STATE;
    await tx.taxInvoice.create({
      data: {
        companyId: ctx.companyId,
        invoiceId: inv.id, gstin: company.gstin ?? 'N/A',
        placeOfSupply: clientStateCode ?? memo.client.state ?? '', taxableAmount: subtotal,
        cgst: isSameState ? taxAmount / 2 : 0,
        sgst: isSameState ? taxAmount / 2 : 0,
        igst: isSameState ? 0 : taxAmount,
        totalTax: taxAmount,
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
    // silently excluded every memo-converted sale. Same AR/Revenue/GST/COGS/Inventory shape as
    // createInvoice's own entry, sized off each converted tag's own costPrice (COGS is always
    // present here — unlike createInvoice, every line on this path is tag-backed, never free-text).
    const cogsAmount = tagIds.reduce((s, tagId) => s + Number(memoItemByTagId.get(tagId)!.tag!.costPrice), 0);
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: inv.invoiceDate, description: `Memo Conversion ${invoiceNumber}`,
      referenceType: 'SalesInvoice', referenceId: inv.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, credit: subtotal },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, credit: isSameState ? taxAmount / 2 : 0 },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, credit: isSameState ? taxAmount / 2 : 0 },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, credit: isSameState ? 0 : taxAmount },
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
