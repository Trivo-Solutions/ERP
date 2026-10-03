// G8c — e-invoice (IRN) generation orchestration through the G8a provider boundary.
//
// Pipeline (route: authenticate → tenant context → permission) → registration + invoice ownership →
// idempotent short-circuit on an existing SUCCESS → eligibility (pure) → integration config →
// provider capability → claim the operation record (unique-index gate) → provider auth → provider
// generateIrn (OUTSIDE any DB transaction; NEVER retried) → persist result + audit.
//
// The server builds the request from the persisted invoice; nothing about the document comes from the
// client. IRN generation is not retry-safe, so an unknown outcome (timeout / network / 5xx /
// malformed reply / duplicate-at-provider / a failed local save after provider success) is recorded
// as AMBIGUOUS and is never resubmitted by this code — it needs a controlled lookup (Get IRN by
// document, a later phase). Only a DEFINITIVE rejection (provider said no / never reached) is FAILED
// and may be attempted again by an explicit new request.
import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { assertOwnedByCompany } from '../../../middleware/tenant';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantQuery, tenantTransaction, TenantContext } from '../../../shared/tenantContext';
import { logger } from '../../../config/logger';
import { decryptCredentialValue } from './encryption';
import { generateCorrelationId } from './correlationId';
import { resolveProvider } from './providers/resolveProvider';
import { getOrAuthenticate, invalidateSession } from './auth/tokenSession';
import { startRequest, completeRequest, buildIdempotencyKey } from './requestTracking.service';
import { GstIntegrationError } from './errors';
import {
  GstIntegrationCallContext, GstIntegrationEnvironment, GstIntegrationErrorCategory, GstProviderName,
  isValidGstIntegrationEnvironment,
} from './types';
import {
  EInvoiceSource, EInvoiceEligibilityResult, EInvoiceGenerationResult, EInvoiceDocumentType,
} from './eInvoice.types';
import { evaluateEInvoiceEligibility } from './eInvoiceEligibility';
import { buildCanonicalIrnRequest } from './eInvoiceRequestBuilder';

const DOCUMENT_TYPE: EInvoiceDocumentType = 'INV';

export class EInvoiceNotEligibleError extends AppError {
  constructor(readonly eligibility: EInvoiceEligibilityResult) {
    super(`Invoice is not eligible for e-invoicing: ${eligibility.blockingReasons.map((r) => r.code).join(', ')}`, 422);
  }
}

export interface EInvoiceRecordView {
  id: string;
  invoiceId: string;
  gstRegistrationId: string;
  documentType: string;
  provider: string;
  environment: string;
  status: string;
  irn: string | null;
  ackNumber: string | null;
  ackDate: Date | null;
  signedInvoice: string | null;
  signedQrCode: string | null;
  providerStatus: string | null;
  generatedAt: Date | null;
  correlationId: string;
  errorCategory: string | null;
  errorCode: string | null;
}

export interface GenerateIrnOutcome {
  /** 201 newly generated, 200 an existing IRN returned unchanged. */
  httpStatus: 200 | 201;
  record: EInvoiceRecordView;
  eligibility?: EInvoiceEligibilityResult;
  correlationId: string;
}

const HTTP_STATUS_FOR_CATEGORY: Record<GstIntegrationErrorCategory, number> = {
  AUTHENTICATION: 502, AUTHORIZATION: 502, VALIDATION: 422, RATE_LIMIT: 429, TIMEOUT: 504,
  NETWORK: 502, PROVIDER: 502, DUPLICATE: 409, UNSUPPORTED: 501, UNKNOWN: 502,
};

// The provider definitively did NOT register an IRN for these — a new explicit request may try again.
// Everything else might have reached the provider, so the outcome is unknown.
const DEFINITIVE_FAILURE: ReadonlySet<GstIntegrationErrorCategory> = new Set(['VALIDATION', 'AUTHENTICATION', 'AUTHORIZATION', 'RATE_LIMIT', 'UNSUPPORTED']);

const RECORD_SELECT = {
  id: true, invoiceId: true, gstRegistrationId: true, documentType: true, provider: true, environment: true, status: true,
  irn: true, ackNumber: true, ackDate: true, signedInvoice: true, signedQrCode: true, providerStatus: true,
  generatedAt: true, correlationId: true, errorCategory: true, errorCode: true,
} as const;

async function selectConfig(ctx: TenantContext, gstRegistrationId: string, environment?: string) {
  if (environment !== undefined && !isValidGstIntegrationEnvironment(environment)) {
    throw new AppError(`Unknown GST integration environment '${environment}'`, 400);
  }
  const configs = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.findMany({
      where: { companyId: ctx.companyId, gstRegistrationId, isActive: true, ...(environment ? { environment } : {}) },
      include: { credentials: true },
      orderBy: { createdAt: 'asc' },
    })
  );
  if (configs.length === 0) throw new AppError('No active GST integration is configured for this registration', 422);
  if (configs.length > 1) throw new AppError('Multiple active GST integrations match this registration — specify ?environment= or deactivate the extra config', 409);
  return configs[0];
}

async function loadSource(ctx: TenantContext, gstRegistrationId: string, invoiceId: string): Promise<EInvoiceSource> {
  const { registration, invoice } = await tenantTransaction(ctx.companyId, async (tx) => ({
    registration: await tx.companyGstRegistration.findFirst({ where: { id: gstRegistrationId, companyId: ctx.companyId } }),
    invoice: await tx.salesInvoice.findFirst({
      where: { id: invoiceId, companyId: ctx.companyId },
      include: {
        taxDetails: true,
        branch: { select: { gstRegistrationId: true } },
        items: { orderBy: { id: 'asc' }, include: { hsnCode: { select: { code: true } } } },
      },
    }),
  }));
  if (!registration) throw new AppError('GST registration not found', 404);
  if (!invoice) throw new AppError('Invoice not found', 404);
  const t = invoice.taxDetails;
  return {
    documentType: DOCUMENT_TYPE,
    registration: { id: registration.id, companyId: registration.companyId, gstin: registration.gstin, isActive: registration.isActive },
    invoice: {
      id: invoice.id, companyId: invoice.companyId, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate,
      status: invoice.status, currency: invoice.currency, subtotal: invoice.subtotal, discountAmount: invoice.discountAmount,
      otherCharges: invoice.otherCharges, taxAmount: invoice.taxAmount, roundOff: invoice.roundOff, totalAmount: invoice.totalAmount,
      branchGstRegistrationId: invoice.branch?.gstRegistrationId ?? null,
    },
    tax: t && {
      gstin: t.gstin, placeOfSupply: t.placeOfSupply, reverseCharge: t.reverseCharge,
      cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, irn: t.irn, sellerRegistrationId: t.sellerRegistrationId,
      sellerLegalName: t.sellerLegalName, sellerTradeName: t.sellerTradeName, sellerStateCode: t.sellerStateCode,
      sellerAddress: t.sellerAddress, sellerCity: t.sellerCity, sellerPincode: t.sellerPincode,
      buyerName: t.buyerName, buyerGstin: t.buyerGstin, buyerAddress: t.buyerAddress, buyerCity: t.buyerCity,
      buyerStateCode: t.buyerStateCode, buyerPincode: t.buyerPincode, buyerCountry: t.buyerCountry,
    },
    items: invoice.items.map((i) => ({
      id: i.id, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, uqc: i.uqc, hsnCode: i.hsnCode?.code ?? null,
      taxRate: i.taxRate, taxableValue: i.taxableValue, lineDiscountAmount: i.lineDiscountAmount,
      cgstAmount: i.cgstAmount, sgstAmount: i.sgstAmount, igstAmount: i.igstAmount,
    })),
  };
}

const uniqueWhere = (companyId: string, gstRegistrationId: string, invoiceId: string, environment: string) => ({
  companyId_gstRegistrationId_documentType_invoiceId_environment: { companyId, gstRegistrationId, documentType: DOCUMENT_TYPE, invoiceId, environment },
});

function validResult(r: EInvoiceGenerationResult): boolean {
  return !!r && r.status === 'GENERATED' && /^[0-9a-f]{64}$/i.test(r.irn ?? '')
    && !!r.ackNumber?.trim() && !Number.isNaN(Date.parse(r.ackDate));
}

export async function generateIrnForInvoice(
  ctx: TenantContext, gstRegistrationId: string, invoiceId: string, environment?: string,
): Promise<GenerateIrnOutcome> {
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');
  await assertOwnedByCompany('salesInvoice', invoiceId, ctx.companyId, 'Invoice');

  const config = await selectConfig(ctx, gstRegistrationId, environment);
  const env = config.environment as GstIntegrationEnvironment;
  const providerName = config.provider as GstProviderName;

  // Idempotent repeat: an already-generated IRN is returned as-is, never regenerated.
  const existing = await tenantQuery(ctx.companyId, (tx) =>
    tx.eInvoiceRecord.findUnique({ where: uniqueWhere(ctx.companyId, gstRegistrationId, invoiceId, env), select: RECORD_SELECT }));
  if (existing?.status === 'SUCCESS') return { httpStatus: 200, record: existing, correlationId: existing.correlationId };
  if (existing?.status === 'PENDING') throw new AppError('An IRN generation for this invoice is already in progress', 409);
  if (existing?.status === 'AMBIGUOUS') {
    throw new AppError('A previous IRN generation for this invoice has an unknown outcome and will not be resubmitted automatically — verify it with the provider first', 409);
  }

  const source = await loadSource(ctx, gstRegistrationId, invoiceId);
  const eligibility = evaluateEInvoiceEligibility(source);
  if (!eligibility.technicallyEligible) {
    await createAuditEntry('sales_invoices', invoiceId, ctx.userId, 'IRN_BLOCKED', undefined,
      { gstRegistrationId, environment: env, status: eligibility.status, reasons: eligibility.blockingReasons.map((r) => r.code) }, ctx.companyId);
    throw new EInvoiceNotEligibleError(eligibility);
  }
  const request = buildCanonicalIrnRequest(source);

  const provider = resolveProvider(config.provider);
  if (!provider.supportsIrnGeneration) {
    throw new AppError(`IRN generation is not supported for provider ${providerName}`, 501);
  }

  const correlationId = generateCorrelationId();
  const idempotencyKey = buildIdempotencyKey({
    companyId: ctx.companyId, gstRegistrationId, provider: providerName, environment: env, operation: 'GENERATE_IRN', naturalKey: `${DOCUMENT_TYPE}:${invoiceId}`,
  });

  // ── claim: the unique index is the concurrency gate ──────────────────────
  let recordId: string;
  if (existing) { // FAILED — an explicit new attempt; claim it count-checked
    const claimed = await tenantQuery(ctx.companyId, (tx) => tx.eInvoiceRecord.updateMany({
      where: { id: existing.id, companyId: ctx.companyId, status: 'FAILED' },
      data: { status: 'PENDING', correlationId, provider: providerName, attempts: { increment: 1 }, errorCategory: null, errorCode: null, errorMessage: null, createdById: ctx.userId },
    }));
    if (claimed.count !== 1) throw new AppError('An IRN generation for this invoice is already in progress', 409);
    recordId = existing.id;
  } else {
    try {
      const created = await tenantQuery(ctx.companyId, (tx) => tx.eInvoiceRecord.create({
        data: { companyId: ctx.companyId, gstRegistrationId, invoiceId, documentType: DOCUMENT_TYPE, provider: providerName, environment: env, status: 'PENDING', correlationId, idempotencyKey, createdById: ctx.userId },
        select: { id: true },
      }));
      recordId = created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError('An IRN generation for this invoice is already in progress', 409);
      throw err;
    }
  }

  const { row: log } = await startRequest({ companyId: ctx.companyId, configId: config.id, provider: providerName, environment: env, operation: 'GENERATE_IRN', correlationId });

  const settle = async (status: 'FAILED' | 'AMBIGUOUS', category: GstIntegrationErrorCategory, code: string | undefined, message: string) => {
    await tenantQuery(ctx.companyId, (tx) => tx.eInvoiceRecord.updateMany({
      where: { id: recordId, companyId: ctx.companyId, status: 'PENDING' },
      data: { status, errorCategory: category, errorCode: code, errorMessage: message },
    }));
    await completeRequest({ companyId: ctx.companyId, logId: log.id, status: 'FAILED', errorCategory: category, errorCode: code, errorMessage: message });
    await createAuditEntry('einvoice_records', recordId, ctx.userId, status === 'FAILED' ? 'IRN_FAILED' : 'IRN_AMBIGUOUS', undefined,
      { invoiceId, gstRegistrationId, environment: env, provider: providerName, errorCategory: category, errorCode: code ?? null, correlationId }, ctx.companyId);
  };

  // ── provider call (outside any transaction, no retry) ─────────────────────
  const credentials: Record<string, string> = {};
  for (const c of config.credentials) {
    try { credentials[c.credentialKey] = decryptCredentialValue(c.encryptedValue); } catch { /* surfaces as a missing credential */ }
  }
  const callCtx: GstIntegrationCallContext = { companyId: ctx.companyId, gstRegistrationId, configId: config.id, environment: env, correlationId, credentials };

  let result: EInvoiceGenerationResult;
  try {
    const auth = await getOrAuthenticate(config.id, provider, callCtx);
    if (auth.status !== 'AUTHENTICATED' || !auth.token) {
      throw new GstIntegrationError({ message: 'Provider authentication failed — check the integration credentials', category: auth.status === 'NOT_CONFIGURED' ? 'UNSUPPORTED' : 'AUTHENTICATION', provider: providerName, operation: 'GENERATE_IRN', correlationId });
    }
    const out = await provider.generateIrn({ ...callCtx, authToken: auth.token }, request);
    if ('status' in out && out.status === 'UNSUPPORTED_PROVIDER_OPERATION') {
      throw new GstIntegrationError({ message: `IRN generation is not supported for provider ${providerName}`, category: 'UNSUPPORTED', provider: providerName, operation: 'GENERATE_IRN', correlationId });
    }
    result = out as EInvoiceGenerationResult;
  } catch (err) {
    const failure = err instanceof GstIntegrationError ? err : new GstIntegrationError({
      message: 'Unexpected error during IRN generation', category: 'UNKNOWN', provider: providerName, operation: 'GENERATE_IRN', correlationId,
    });
    if (failure.category === 'AUTHENTICATION') invalidateSession(config.id);
    await settle(DEFINITIVE_FAILURE.has(failure.category) ? 'FAILED' : 'AMBIGUOUS', failure.category, failure.providerCode, failure.message);
    const suffix = DEFINITIVE_FAILURE.has(failure.category) ? '' : ' — outcome unknown, will not be resubmitted automatically';
    throw new AppError(`${failure.message}${suffix} (correlationId: ${correlationId})`, HTTP_STATUS_FOR_CATEGORY[failure.category] ?? 502);
  }

  if (!validResult(result)) {
    // The provider answered "success" with something unusable: it may well have registered the IRN.
    await settle('AMBIGUOUS', 'PROVIDER', 'MALFORMED_SUCCESS_RESPONSE', 'Provider returned an unusable IRN response');
    throw new AppError(`Provider returned an unusable IRN response — outcome unknown, will not be resubmitted automatically (correlationId: ${correlationId})`, 502);
  }

  // ── persist ───────────────────────────────────────────────────────────────
  const ackDate = new Date(result.ackDate);
  const data = {
    irn: result.irn.toLowerCase(), ackNumber: result.ackNumber.trim(), ackDate,
    signedInvoice: result.signedInvoice, signedQrCode: result.signedQrCode,
    providerStatus: result.providerStatus, providerTimestamp: result.providerTimestamp ? new Date(result.providerTimestamp) : null,
  };
  try {
    await tenantTransaction(ctx.companyId, async (tx) => {
      const upd = await tx.eInvoiceRecord.updateMany({
        where: { id: recordId, companyId: ctx.companyId, status: 'PENDING' },
        data: { ...data, status: 'SUCCESS', generatedAt: new Date() },
      });
      if (upd.count !== 1) throw new AppError('E-invoice record changed concurrently', 409);
      // Only a PRODUCTION IRN is the legal e-invoice: stamp the existing TaxInvoice IRN fields so every
      // existing guard (voidInvoice / amendInvoice refuse when taxDetails.irn is set) protects the
      // document. A SANDBOX IRN is test data and must never lock a real invoice.
      if (env === 'PRODUCTION') {
        await tx.taxInvoice.updateMany({
          where: { invoiceId, companyId: ctx.companyId, irn: null },
          data: { irn: data.irn, ackNumber: data.ackNumber, ackDate, qrCodeData: result.signedQrCode, isEInvoice: true },
        });
      }
    });
  } catch (err) {
    // The provider DID register this IRN; losing it silently would be the worst outcome. Keep what we
    // have on the record, flag it AMBIGUOUS so nothing resubmits it.
    logger.error(`[einvoice] persisting a provider-issued IRN failed (correlationId ${correlationId})`);
    try {
      await tenantQuery(ctx.companyId, (tx) => tx.eInvoiceRecord.updateMany({
        where: { id: recordId, companyId: ctx.companyId, status: 'PENDING' },
        data: { ...data, status: 'AMBIGUOUS', errorCategory: 'UNKNOWN', errorCode: 'PERSIST_FAILED_AFTER_PROVIDER_SUCCESS' },
      }));
    } catch { /* record stays PENDING (409 on repeat) — still never resubmitted */ }
    throw err instanceof AppError ? err : new AppError(`The IRN was issued but could not be saved completely — outcome flagged for verification (correlationId: ${correlationId})`, 500);
  }

  await completeRequest({ companyId: ctx.companyId, logId: log.id, status: 'SUCCESS', providerReferenceId: data.ackNumber });
  await createAuditEntry('einvoice_records', recordId, ctx.userId, 'IRN_GENERATE', undefined,
    { invoiceId, gstRegistrationId, environment: env, provider: providerName, irn: data.irn, ackNumber: data.ackNumber, correlationId }, ctx.companyId);

  const record = await tenantQuery(ctx.companyId, (tx) => tx.eInvoiceRecord.findUniqueOrThrow({ where: { id: recordId }, select: RECORD_SELECT }));
  return { httpStatus: 201, record, eligibility, correlationId };
}
