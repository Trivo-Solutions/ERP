// G8a — GST Integration Foundation HTTP layer. Thin: every route validates its own body, calls
// gstIntegration.service.ts, and shapes the response. Mounted at its own top-level path
// (/api/v1/gst/integration, see app.ts) — a NEW router, not an addition to the existing, working
// gst.router.ts (GSTIN lookup / HSN / AATO / compliance) or the frozen finance GST reporting
// routes, so this phase touches neither.
//
// No route here ever returns a decrypted credential or an encryptedValue (brief §20) — see
// gstIntegration.service.ts's toSummary(), which only ever surfaces credential KEYS.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../../middleware/auth';
import { requirePermission } from '../../../middleware/rbac';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../../middleware/tenant';
import { validate } from '../../../middleware/validate';
import * as gstIntegrationService from './gstIntegration.service';
import * as gstinLookupService from './gstinLookup.service';
import * as eInvoiceService from './eInvoice.service';

export const gstIntegrationRouter = Router();
gstIntegrationRouter.use(authenticate, resolveTenantContext);

const VIEW = requirePermission('gst:integration_view');
const MANAGE = requirePermission('gst:integration_manage');
const TEST = requirePermission('gst:integration_test');
const GENERATE_EINVOICE = requirePermission('gst:einvoice_generate');

const credentialsSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(4000)).optional();

const createConfigSchema = z.object({
  provider: z.string().min(1),
  environment: z.string().min(1),
  label: z.string().max(200).optional().nullable(),
  credentials: credentialsSchema,
});

const updateConfigSchema = z.object({
  label: z.string().max(200).optional().nullable(),
  isActive: z.boolean().optional(),
  credentials: credentialsSchema,
});

gstIntegrationRouter.get(
  '/registrations/:gstRegistrationId', VIEW,
  async (req: Request, res: Response) => {
    const data = await gstIntegrationService.listIntegrationConfigs(req.tenant!, req.params.gstRegistrationId);
    res.json({ success: true, data });
  }
);

// G8b — GSTIN lookup via this registration's configured provider. Read-only; optional
// ?environment=SANDBOX|PRODUCTION disambiguates when a registration has more than one active config.
gstIntegrationRouter.get(
  '/registrations/:gstRegistrationId/gstin/:gstin', rejectClientTenantSelectors, VIEW,
  async (req: Request, res: Response) => {
    const environment = typeof req.query.environment === 'string' ? req.query.environment : undefined;
    const { details, correlationId } = await gstinLookupService.lookupGstin(req.tenant!, req.params.gstRegistrationId, req.params.gstin, environment);
    res.json({ success: true, data: details, correlationId });
  }
);

// G8c — register an IRN for one persisted invoice. The body is IGNORED (the server builds the request
// from the stored invoice); a tenant selector anywhere in the request is rejected.
gstIntegrationRouter.post(
  '/registrations/:gstRegistrationId/invoices/:invoiceId/irn', rejectClientTenantSelectors, GENERATE_EINVOICE,
  async (req: Request, res: Response) => {
    const environment = typeof req.query.environment === 'string' ? req.query.environment : undefined;
    try {
      const out = await eInvoiceService.generateIrnForInvoice(req.tenant!, req.params.gstRegistrationId, req.params.invoiceId, environment);
      res.status(out.httpStatus).json({ success: true, data: out.record, correlationId: out.correlationId });
    } catch (err) {
      if (err instanceof eInvoiceService.EInvoiceNotEligibleError) {
        return res.status(422).json({ success: false, error: err.message, eligibility: err.eligibility });
      }
      throw err;
    }
  }
);

gstIntegrationRouter.post(
  '/registrations/:gstRegistrationId', rejectClientTenantSelectors,
  MANAGE, validate(createConfigSchema),
  async (req: Request, res: Response) => {
    const data = await gstIntegrationService.createIntegrationConfig(req.tenant!, req.params.gstRegistrationId, req.body);
    res.status(201).json({ success: true, data });
  }
);

gstIntegrationRouter.patch(
  '/:id', rejectClientTenantSelectors,
  MANAGE, validate(updateConfigSchema),
  async (req: Request, res: Response) => {
    const data = await gstIntegrationService.updateIntegrationConfig(req.tenant!, req.params.id, req.body);
    res.json({ success: true, data });
  }
);

// Health-check only — never an IRN/EWB mutation (brief §20/§23).
gstIntegrationRouter.post(
  '/:id/test', TEST,
  async (req: Request, res: Response) => {
    const data = await gstIntegrationService.testIntegrationConnection(req.tenant!, req.params.id);
    res.json({ success: true, data });
  }
);
