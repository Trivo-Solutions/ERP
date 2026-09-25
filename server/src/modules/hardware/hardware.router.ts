import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertBranchAccessible } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { hardwareService } from '../../shared/hardware';
import { tenantQuery, canAccessBranch, TenantContext } from '../../shared/tenantContext';

// Every device is a company-owned HardwareDevice row: there is no "default" or environment-configured
// scale. A device is reachable only by the company that owns it (and, if it is assigned to a branch,
// only by members who may access that branch); anything else is the same 404 as a nonexistent id.

export const hardwareRouter = Router();
hardwareRouter.use(authenticate, resolveTenantContext);

const DEVICE_FIELDS = ['deviceType', 'deviceId', 'port', 'baudRate', 'ipAddress', 'location', 'isActive', 'metadata', 'branchId'] as const;

// A device with no branch is company-wide; one with a branch is visible only to members of that branch.
const visibleTo = (ctx: TenantContext, d: { branchId: string | null }) => d.branchId === null || canAccessBranch(ctx, d.branchId);

async function ownedDevice(ctx: TenantContext, deviceId: string) {
  const device = await tenantQuery(ctx.companyId, (tx) =>
    tx.hardwareDevice.findFirst({ where: { deviceId, companyId: ctx.companyId } })
  );
  if (!device || !visibleTo(ctx, device)) throw new AppError('Device not found', 404);
  return device;
}

hardwareRouter.get('/devices', requirePermission('hardware:manage'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  const all = await tenantQuery(ctx.companyId, (tx) =>
    tx.hardwareDevice.findMany({ where: { companyId: ctx.companyId }, orderBy: { deviceType: 'asc' } })
  );
  const devices = all.filter((d) => visibleTo(ctx, d));
  const visibleIds = new Set(devices.map((d) => d.deviceId));
  // Only this company's connected scales — and only ones this member may see.
  const connectedScales = hardwareService.getConnectedScales(ctx.companyId).filter((id) => visibleIds.has(id));
  res.json({ success: true, data: devices, connectedScales });
});

hardwareRouter.post('/devices', requirePermission('hardware:manage'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  const data: Record<string, unknown> = {};
  for (const f of DEVICE_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
  // A branch named in the body must be one of this company's branches that the caller may access.
  if (data.branchId) await assertBranchAccessible(data.branchId as string, ctx);
  const device = await tenantQuery(ctx.companyId, (tx) =>
    tx.hardwareDevice.create({ data: { ...(data as any), companyId: ctx.companyId } })
  );
  if (device.isActive && device.deviceType === 'SCALE' && device.port) {
    void hardwareService.connectDevice({
      companyId: ctx.companyId, deviceId: device.deviceId, port: device.port, baudRate: device.baudRate ?? 9600, branchId: device.branchId,
    });
  }
  res.status(201).json({ success: true, data: device });
});

hardwareRouter.get('/scales/:deviceId/read', requirePermission('wip:update'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  await ownedDevice(ctx, req.params.deviceId);
  const reading = hardwareService.getLastReading(ctx.companyId, req.params.deviceId);
  if (!reading) return res.status(404).json({ success: false, error: 'No reading available' });
  res.json({ success: true, data: reading });
});

// Development aid only (refused in production by the service itself).
hardwareRouter.post('/scales/:deviceId/simulate', requirePermission('hardware:manage'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  const weight = Number(req.body.weight);
  if (!Number.isFinite(weight)) throw new AppError('weight must be a number', 400);
  const device = await ownedDevice(ctx, req.params.deviceId);
  await hardwareService.simulateScale(ctx.companyId, device.deviceId, weight, device.branchId);
  res.json({ success: true, message: `Simulated ${weight}g on ${device.deviceId}` });
});

hardwareRouter.post('/rfid/scan', requirePermission('job:view'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  const { tagId } = req.body;
  const jobCard = await tenantQuery(ctx.companyId, (tx) =>
    tx.jobCard.findFirst({
      where: { rfidTag: tagId, companyId: ctx.companyId },
      include: { design: true, processes: { where: { status: 'IN_PROGRESS' } } },
    })
  );
  if (!jobCard) return res.status(404).json({ success: false, error: 'RFID tag not found' });
  res.json({ success: true, data: jobCard });
});

hardwareRouter.post('/barcode/scan', requirePermission('job:view'), async (req: Request, res: Response) => {
  const ctx = req.tenant!;
  const { barcodeData } = req.body;
  const jobCard = await tenantQuery(ctx.companyId, (tx) =>
    tx.jobCard.findFirst({
      where: { barcodeData, companyId: ctx.companyId },
      include: { design: true, order: { include: { client: true } }, processes: { orderBy: { sequence: 'asc' } } },
    })
  );
  if (!jobCard) return res.status(404).json({ success: false, error: 'Barcode not found' });
  res.json({ success: true, data: jobCard });
});
