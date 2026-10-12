import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import * as svc from './tableLayout.service';

// A member's own UI preferences. Any authenticated member may manage THEIR OWN - there is deliberately no permission
// string (it is not business data) and no way to name another user: the owner is always the caller's membership.
export const userPreferencesRouter = Router();
userPreferencesRouter.use(authenticate, resolveTenantContext);

userPreferencesRouter.get('/table-layouts', async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listMyLayouts(req.tenant!) });
});
userPreferencesRouter.put('/table-layouts/:tableId', rejectClientTenantSelectors, async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.saveMyLayout(req.tenant!, req.params.tableId, req.body?.layout) });
});
userPreferencesRouter.delete('/table-layouts/:tableId', async (req: Request, res: Response) => {
  await svc.resetMyLayout(req.tenant!, req.params.tableId);
  res.json({ success: true, message: 'Layout reset' });
});
