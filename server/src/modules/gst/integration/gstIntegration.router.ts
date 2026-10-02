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

export const gstIntegrationRouter = Router();
gstIntegrationRouter.use(authenticate, resolveTenantContext);

const VIEW = requirePermission('gst:integration_view');
const MANAGE = requirePermission('gst:integration_manage');
const TEST = requirePermission('gst:integration_test');

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
