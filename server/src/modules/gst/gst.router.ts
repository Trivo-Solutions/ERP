// GST Phase C — GST Master Services HTTP layer. Thin: every route just validates its own query
// params, calls a shared/* service, and shapes the response — no business logic lives here.
//
// Every route is authenticated and requires `masters:view` — the same permission that already
// gates every other read-only reference-data lookup in this app (karats, HSN-for-pricing,
// categories, ... — see masters.router.ts and its own "masters:view" grant history in CLAUDE.md).
// GSTIN validation/lookup and HSN/SAC search are the same class of capability: read-only reference
// data, not a company-scoped record, so no new permission was created for them (reusing an existing
// permission that already represents the needed authority, per this codebase's own convention).
//
// Response envelope matches every other router: `{ success: true, data }` on success. The GSTIN
// lookup/validate error contract below intentionally returns structured `{ success: false, error:
// { code, message } }` bodies directly from these two routes (see the module doc,
// PHASE_C_GST_MASTER_SERVICES.md, for why) — every other failure (auth, permission, a thrown
// AppError) still goes through the app's normal single-string error middleware, unchanged.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { qs, qsNum } from '../../shared/query';
import { validateGstin } from '../../shared/gstin';
import { lookupGstin } from '../../shared/gstProvider';
import { searchHSN, searchSAC, getHSN, getSAC, validateCode, HsnSacCodeType } from '../../shared/hsnSac';
import * as aatoService from './aato.service';
import { validateGstCompliance } from '../../shared/gstCompliance';

export const gstRouter = Router();
gstRouter.use(authenticate, resolveTenantContext);

const VIEW = requirePermission('masters:view');

// ─── GSTIN ──────────────────────────────────────────────────────────────────

gstRouter.get('/gstin/validate', VIEW, (req: Request, res: Response) => {
  const gstin = qs(req, 'gstin');
  const result = validateGstin(gstin);
  res.json({ success: true, data: result });
});

gstRouter.get('/gstin/lookup', VIEW, async (req: Request, res: Response) => {
  const gstin = qs(req, 'gstin');
  const outcome = await lookupGstin(gstin);

  switch (outcome.status) {
    case 'INVALID':
      return res.status(400).json({ success: false, error: { code: 'GST_INVALID_GSTIN', message: 'GSTIN is not valid', details: outcome.errors } });
    case 'NOT_CONFIGURED':
      return res.status(503).json({ success: false, error: { code: 'GST_PROVIDER_NOT_CONFIGURED', message: 'GST lookup provider is not configured' } });
    case 'NOT_FOUND':
      return res.status(404).json({ success: false, error: { code: 'GST_NOT_FOUND', message: 'No registration found for this GSTIN' } });
    case 'PROVIDER_ERROR':
      return res.status(502).json({ success: false, error: { code: 'GST_PROVIDER_ERROR', message: 'GST lookup provider failed' } });
    case 'FOUND':
      return res.json({ success: true, data: outcome.result });
  }
});

// ─── HSN / SAC ──────────────────────────────────────────────────────────────

gstRouter.get('/hsn/search', VIEW, async (req: Request, res: Response) => {
  const q = qs(req, 'q');
  const limit = qsNum(req, 'limit');
  const offset = qsNum(req, 'offset');
  res.json({ success: true, data: await searchHSN(q, { limit, offset }) });
});

gstRouter.get('/sac/search', VIEW, async (req: Request, res: Response) => {
  const q = qs(req, 'q');
  const limit = qsNum(req, 'limit');
  const offset = qsNum(req, 'offset');
  res.json({ success: true, data: await searchSAC(q, { limit, offset }) });
});

// Neither 404 message below echoes the requested :code back — this route is a path param, and this
// app's cross-company isolation sweep (src/test/isolation.newCompany.test.ts) generically treats
// ANY response body that contains a caller-supplied path segment matching another company's row id
// as a suspected leak (it cannot distinguish "echoed the id because it's real cross-tenant data"
// from "echoed the id because it's just restating what you asked for"). HSN/SAC codes are global,
// not tenant rows, so there is nothing to actually leak here — but the response still can't safely
// contain the raw param, so it doesn't.
gstRouter.get('/hsn/:code', VIEW, async (req: Request, res: Response) => {
  const row = await getHSN(req.params.code);
  if (!row) return res.status(404).json({ success: false, error: { code: 'GST_HSN_NOT_FOUND', message: 'HSN code not found' } });
  res.json({ success: true, data: row });
});

gstRouter.get('/sac/:code', VIEW, async (req: Request, res: Response) => {
  const row = await getSAC(req.params.code);
  if (!row) return res.status(404).json({ success: false, error: { code: 'GST_SAC_NOT_FOUND', message: 'SAC code not found' } });
  res.json({ success: true, data: row });
});

gstRouter.get('/codes/validate', VIEW, async (req: Request, res: Response) => {
  const code = qs(req, 'code') ?? '';
  const codeTypeParam = qs(req, 'codeType');
  const codeType: HsnSacCodeType = codeTypeParam === 'SAC' ? 'SAC' : 'HSN';
  res.json({ success: true, data: await validateCode(code, codeType) });
});

// ─── Phase D: AATO ──────────────────────────────────────────────────────────

const REG_VIEW = requirePermission('gst:registration_view');
const REG_EDIT = requirePermission('gst:registration_edit');

const saveAatoSchema = z.object({
  gstRegistrationId: z.string().min(1),
  financialYear: z.string().min(1),
  turnover: z.union([z.number(), z.string()]),
  precedingTurnover: z.union([z.number(), z.string()]).optional().nullable(),
  source: z.enum(['MANUAL', 'GST_PORTAL', 'IMPORT', 'SYSTEM_CALCULATED', 'OTHER']).optional(),
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']).optional(),
  verifiedDate: z.union([z.string(), z.date()]).optional().nullable(),
  notes: z.string().optional().nullable(),
});

gstRouter.get('/aato', REG_VIEW, async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) {
    return res.status(400).json({ success: false, error: 'gstRegistrationId is required' });
  }
  const financialYear = qs(req, 'financialYear');
  const data = await aatoService.getAato(req.tenant!, { gstRegistrationId, financialYear });
  res.json({ success: true, data });
});

gstRouter.get('/aato/history', REG_VIEW, async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) {
    return res.status(400).json({ success: false, error: 'gstRegistrationId is required' });
  }
  const financialYear = qs(req, 'financialYear');
  const limit = qsNum(req, 'limit');
  const data = await aatoService.getAatoHistory(req.tenant!, { gstRegistrationId, financialYear, limit });
  res.json({ success: true, data });
});

gstRouter.post(
  '/aato',
  rejectClientTenantSelectors,
  REG_EDIT,
  validate(saveAatoSchema),
  async (req: Request, res: Response) => {
    const data = await aatoService.saveAato(req.tenant!, req.body);
    res.status(200).json({ success: true, data });
  }
);

// ─── Phase D: GST Compliance Validation ────────────────────────────────────

const complianceValidationSchema = z.object({
  gstin: z.string().optional().nullable(),
  hsnCode: z.string().optional().nullable(),
  codeType: z.enum(['HSN', 'SAC']).optional().nullable(),
  supplyType: z.enum(['B2B', 'B2C']).optional().nullable(),
  uqc: z.string().optional().nullable(),
  financialYear: z.string().optional().nullable(),
  aggregateTurnover: z.union([z.number(), z.string()]).optional().nullable(),
  precedingTurnover: z.union([z.number(), z.string()]).optional().nullable(),
  precedingVerificationStatus: z.string().optional().nullable(),
  currentTurnover: z.union([z.number(), z.string()]).optional().nullable(),
  gstRegistrationId: z.string().optional().nullable(),
});

gstRouter.post(
  '/compliance/validate',
  VIEW,
  validate(complianceValidationSchema),
  async (req: Request, res: Response) => {
    const {
      gstin,
      hsnCode,
      codeType,
      supplyType,
      uqc,
      financialYear,
      gstRegistrationId,
      precedingVerificationStatus: explicitPrecStatus,
    } = req.body;
    let aggregateTurnover =
      req.body.aggregateTurnover !== undefined && req.body.aggregateTurnover !== null
        ? Number(req.body.aggregateTurnover)
        : null;
    let precedingTurnover =
      req.body.precedingTurnover !== undefined && req.body.precedingTurnover !== null
        ? Number(req.body.precedingTurnover)
        : null;
    let currentTurnover =
      req.body.currentTurnover !== undefined && req.body.currentTurnover !== null
        ? Number(req.body.currentTurnover)
        : null;
    let precedingVerificationStatus = explicitPrecStatus ?? null;

    if (gstRegistrationId) {
      try {
        const aatoRes = await aatoService.getAato(req.tenant!, { gstRegistrationId, financialYear });
        if (precedingTurnover === null && aatoRes.precedingAato?.turnover != null) {
          precedingTurnover = aatoRes.precedingAato.turnover;
          precedingVerificationStatus = aatoRes.precedingAato.verificationStatus;
        }
        if (currentTurnover === null && aatoRes.aato?.turnover != null) {
          currentTurnover = aatoRes.aato.turnover;
        }
      } catch {
        // Proceed with direct validation
      }
    }

    const result = await validateGstCompliance({
      gstin,
      hsnCode,
      codeType,
      supplyType,
      uqc,
      financialYear,
      aggregateTurnover,
      precedingTurnover,
      precedingVerificationStatus,
      currentTurnover,
    });

    res.json({ success: true, data: result });
  }
);

gstRouter.get('/compliance/validate', VIEW, async (req: Request, res: Response) => {
  const gstin = qs(req, 'gstin');
  const hsnCode = qs(req, 'hsnCode');
  const codeTypeParam = qs(req, 'codeType');
  const codeType = codeTypeParam === 'SAC' ? 'SAC' : codeTypeParam === 'HSN' ? 'HSN' : undefined;
  const supplyTypeParam = qs(req, 'supplyType');
  const supplyType = supplyTypeParam === 'B2B' ? 'B2B' : supplyTypeParam === 'B2C' ? 'B2C' : undefined;
  const uqc = qs(req, 'uqc');
  const financialYear = qs(req, 'financialYear');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const aatoParam = qsNum(req, 'aggregateTurnover');
  let aggregateTurnover = aatoParam ?? null;
  const precTurnoverParam = qsNum(req, 'precedingTurnover');
  let precedingTurnover = precTurnoverParam ?? null;
  let precedingVerificationStatus = qs(req, 'precedingVerificationStatus') ?? null;
  const currTurnoverParam = qsNum(req, 'currentTurnover');
  let currentTurnover = currTurnoverParam ?? null;

  if (gstRegistrationId) {
    try {
      const aatoRes = await aatoService.getAato(req.tenant!, { gstRegistrationId, financialYear });
      if (precedingTurnover === null && aatoRes.precedingAato?.turnover != null) {
        precedingTurnover = aatoRes.precedingAato.turnover;
        precedingVerificationStatus = aatoRes.precedingAato.verificationStatus;
      }
      if (currentTurnover === null && aatoRes.aato?.turnover != null) {
        currentTurnover = aatoRes.aato.turnover;
      }
    } catch {
      // Proceed with direct validation
    }
  }

  const result = await validateGstCompliance({
    gstin,
    hsnCode,
    codeType,
    supplyType,
    uqc,
    financialYear,
    aggregateTurnover,
    precedingTurnover,
    precedingVerificationStatus,
    currentTurnover,
  });

  res.json({ success: true, data: result });
});
