import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';

// Payment Configuration: per-payment-leg metadata (provider, POS terminal, auth code, cheque details).
//
// This is SELECTION + RECONCILIATION metadata only. It never moves money, never touches a journal, and a UTR /
// auth code / TID here is not proof that anything settled - there is no gateway or acquirer integration in this
// codebase, so nothing can verify it. Existing payment status / posting paths stay authoritative.
//
// One validator is shared by every collection flow (invoice splits, standalone receipts, customer advances) so the
// rules cannot drift between them. Every lookup runs on the caller's tenant transaction (RLS) AND names companyId.

export const COLLECTION_METHODS = ['CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];
export const PROVIDER_CATEGORIES = ['BANK', 'UPI_PROVIDER', 'ACQUIRER', 'OTHER'] as const;
// Methods a physical POS terminal can serve; a provider can serve any collection method except cash.
export const TERMINAL_METHODS = ['CARD', 'UPI'] as const;
export const PROVIDER_METHODS = ['CARD', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;

/** What a client may send on a payment leg. Everything is optional; unknown keys are simply never read. */
export type PaymentLegMetaInput = {
  providerId?: string | null;
  terminalId?: string | null;
  authCode?: string | null;
  chequeNumber?: string | null;
  chequeDate?: string | Date | null;
  chequeBank?: string | null;
};

/** The columns persisted on InvoicePayment / CustomerAdvancePayment. Providers/terminals are snapshotted by value. */
export type PaymentLegMeta = {
  providerId?: string; terminalId?: string;
  providerName?: string; terminalCode?: string; terminalTid?: string; terminalMid?: string;
  authCode?: string; chequeNumber?: string; chequeDate?: Date; chequeBank?: string;
};

const META_KEYS = ['providerId', 'terminalId', 'authCode', 'chequeNumber', 'chequeDate', 'chequeBank'] as const;

/** True when the request names any of the new fields (used to decide whether a branch must be supplied / accessible). */
export function hasPaymentMeta(input: PaymentLegMetaInput | undefined | null): boolean {
  if (!input) return false;
  return META_KEYS.some((k) => {
    const v = (input as Record<string, unknown>)[k];
    return v !== undefined && v !== null && v !== '';
  });
}

/** Picks just the metadata keys off a request line (so a spread of the whole line never leaks other fields in). */
export function pickPaymentMeta(line: Record<string, unknown> | undefined | null): PaymentLegMetaInput {
  const out: Record<string, unknown> = {};
  for (const k of META_KEYS) if (line && line[k] !== undefined) out[k] = line[k];
  return out as PaymentLegMetaInput;
}

function text(v: unknown, label: string, max = 60): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError(`${label} must be text`, 400);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new AppError(`${label} must be at most ${max} characters`, 400);
  return t;
}

function id(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError(`${label} must be an id string`, 400);
  return v;
}

function luhnOk(digits: string): boolean {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/** An authorization code is a short alphanumeric approval code. Anything shaped like a card number is refused outright. */
export function assertSafeAuthCode(code: string) {
  if (!/^[A-Za-z0-9/-]{1,30}$/.test(code)) throw new AppError('Authorization code may only contain letters, digits, "-" and "/" (max 30)', 400);
  const digits = code.replace(/[^0-9]/g, '');
  if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
    throw new AppError('That looks like a card number. Never enter card numbers - enter only the approval / authorization code from the slip', 400);
  }
}

type Db = Prisma.TransactionClient;

/** Does this branch have any active terminal for the method? When it does, a card leg must name one. */
async function branchHasActiveTerminal(tx: Db, companyId: string, branchId: string, method: string) {
  const n = await tx.posTerminal.count({
    where: { companyId, branchId, isActive: true, supportedMethods: { has: method }, provider: { isActive: true } },
  });
  return n > 0;
}

/** Does this branch have any active provider allocated for the method? When it does, a bank transfer must name one. */
async function branchHasActiveProvider(tx: Db, companyId: string, branchId: string, method: string) {
  const n = await tx.branchPaymentProvider.count({
    where: { companyId, branchId, isActive: true, provider: { isActive: true, supportedMethods: { has: method } } },
  });
  return n > 0;
}

/**
 * Validates one payment leg's metadata against the company's configuration and returns the columns to persist.
 *
 * `credit: true` marks legs that settle a bill from credit already held (old gold, store credit, customer advance):
 * they take no provider/terminal/cheque data, and sending any is a 400 rather than silently dropped.
 * Modes outside the five collection methods (legacy free-text modes) are left exactly as before when no metadata is sent.
 *
 * Enforcement ("a card leg must name a terminal", "a bank transfer must name a provider") applies once the branch has
 * such a terminal / allocated provider configured - so companies that have not set anything up yet keep working with
 * their existing payloads, and the moment a branch is configured the rule bites. A supplied id is ALWAYS validated.
 */
export async function resolvePaymentLegMeta(
  tx: Db,
  companyId: string,
  branchId: string | null | undefined,
  rawMode: string,
  input: PaymentLegMetaInput | undefined | null,
  opts: { credit?: boolean } = {},
): Promise<PaymentLegMeta> {
  const mode = String(rawMode ?? '').trim().toUpperCase();
  if (!hasPaymentMeta(input)) {
    // Nothing supplied: only the "configured branch requires it" rules can still reject.
    if (opts.credit || !branchId) return {};
    if (mode === 'CARD' && await branchHasActiveTerminal(tx, companyId, branchId, 'CARD')) {
      throw new AppError('Select the POS terminal used for this card payment', 400);
    }
    if (mode === 'BANK_TRANSFER' && await branchHasActiveProvider(tx, companyId, branchId, 'BANK_TRANSFER')) {
      throw new AppError('Select the bank / provider for this bank transfer', 400);
    }
    return {};
  }
  const inp = input as PaymentLegMetaInput;

  if (opts.credit || !(COLLECTION_METHODS as readonly string[]).includes(mode)) {
    throw new AppError(`Provider, terminal and cheque details do not apply to a ${mode || 'this'} payment`, 400);
  }

  const providerId = id(inp.providerId, 'providerId');
  const terminalId = id(inp.terminalId, 'terminalId');
  const authCode = text(inp.authCode, 'Authorization code', 30);
  const chequeNumber = text(inp.chequeNumber, 'Cheque number', 30);
  const chequeBank = text(inp.chequeBank, 'Cheque bank', 80);
  let chequeDate: Date | undefined;
  if (inp.chequeDate !== undefined && inp.chequeDate !== null && inp.chequeDate !== '') {
    chequeDate = new Date(inp.chequeDate as string);
    if (Number.isNaN(chequeDate.getTime())) throw new AppError('Cheque date is not a valid date', 400);
  }

  // Which fields belong to which method - the same table the UI uses to decide what to show.
  if (mode === 'CASH') throw new AppError('Cash needs no provider, terminal, reference or cheque details', 400);
  if (terminalId && mode !== 'CARD' && mode !== 'UPI') throw new AppError(`A POS terminal does not apply to a ${mode} payment`, 400);
  if (authCode && mode !== 'CARD') throw new AppError('An authorization code only applies to a card payment', 400);
  if ((chequeNumber || chequeDate || chequeBank) && mode !== 'CHEQUE') throw new AppError('Cheque details only apply to a cheque payment', 400);
  if (authCode) assertSafeAuthCode(authCode);

  const out: PaymentLegMeta = {};
  if (authCode) out.authCode = authCode;
  if (chequeNumber) out.chequeNumber = chequeNumber;
  if (chequeDate) out.chequeDate = chequeDate;
  if (chequeBank) out.chequeBank = chequeBank;

  if (!providerId && !terminalId) {
    // Only an auth code / cheque details were sent: the same "configured branch" rules still apply.
    if (branchId && mode === 'CARD' && await branchHasActiveTerminal(tx, companyId, branchId, 'CARD')) {
      throw new AppError('Select the POS terminal used for this card payment', 400);
    }
    return out;
  }
  if (!branchId) throw new AppError('A branch is required to use a provider or terminal', 400);

  if (terminalId) {
    // Same company only (RLS + explicit companyId): another company's id is simply "not found", exactly like a forged id.
    const t = await tx.posTerminal.findFirst({ where: { id: terminalId, companyId }, include: { provider: true } });
    if (!t) throw new AppError('POS terminal not found', 404);
    if (t.branchId !== branchId) throw new AppError('That POS terminal is not assigned to this branch', 400);
    if (!t.isActive) throw new AppError(`POS terminal ${t.code} is inactive`, 409);
    if (!t.provider.isActive) throw new AppError(`${t.provider.name} is inactive`, 409);
    if (!t.supportedMethods.includes(mode)) throw new AppError(`POS terminal ${t.code} does not support ${mode}`, 400);
    if (providerId && providerId !== t.providerId) throw new AppError('That provider does not own the selected POS terminal', 400);
    return { ...out, terminalId: t.id, terminalCode: t.code, terminalTid: t.tid, ...(t.mid ? { terminalMid: t.mid } : {}), providerId: t.providerId, providerName: t.provider.name };
  }

  // A provider on its own: must be active, serve this method, and be allocated (and active) at this branch.
  const p = await tx.paymentProvider.findFirst({ where: { id: providerId!, companyId } });
  if (!p) throw new AppError('Payment provider not found', 404);
  if (!p.isActive) throw new AppError(`${p.name} is inactive`, 409);
  if (!p.supportedMethods.includes(mode)) throw new AppError(`${p.name} does not support ${mode}`, 400);
  const link = await tx.branchPaymentProvider.findFirst({ where: { companyId, branchId, providerId: p.id, isActive: true } });
  if (!link) throw new AppError(`${p.name} is not available at this branch`, 400);
  if (mode === 'CARD' && await branchHasActiveTerminal(tx, companyId, branchId, 'CARD')) {
    throw new AppError('Select the POS terminal used for this card payment', 400);
  }
  return { ...out, providerId: p.id, providerName: p.name };
}
