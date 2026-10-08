import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { env } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { AppError } from '../../middleware/error';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import * as svc from './photography.service';
import * as settingsSvc from './photographySettings';
import * as stationSvc from './stationCredential.service';
import * as cmdSvc from './captureCommand.service';
import * as camSvc from './stationCameras';

export const photographyRouter = Router();

// Memory storage with a hard per-file cap: the service needs the whole buffer anyway (hash + sniff + put), and the
// cap is enforced while the multipart stream is read, so an oversize body is cut off, not buffered.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.PHOTO_MAX_UPLOAD_BYTES, files: 1, fields: 12, fieldSize: 8 * 1024 },
}).single('file');

function multipart(req: Request, res: Response, next: NextFunction) {
  // multer resolves a second copy of @types/express (workspace root), so its Request type is nominally different.
  upload(req as never, res as never, (err?: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(`File too large (max ${env.PHOTO_MAX_UPLOAD_BYTES} bytes)`, 413));
      return next(new AppError('Invalid upload request', 400));
    }
    next(err);
  });
}

// Camera Bridge heartbeat. Registered BEFORE the user-auth gate below: the caller is a station, not an ERP user, and
// is authenticated by its StationCredential alone (company + station come from the credential row, never the request).
photographyRouter.post('/stations/heartbeat', stationSvc.authenticateStation, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: await stationSvc.recordHeartbeat(req.station!, req.body) });
});

// Remote capture, Camera Bridge side (Phase 5D). Same rule as the heartbeat: the station is identified by its
// credential alone, company + station come from the credential row. A capture-scoped credential is required.
const stationCapture = stationSvc.authenticateStationWithScope(stationSvc.STATION_SCOPE_CAPTURE);
photographyRouter.get('/stations/commands/next', stationCapture, async (req: Request, res: Response) => {
  noStore(res);
  const command = await cmdSvc.pollNextCommand(req.station!, req.query.waitSeconds);
  // The camera a user asked this station to use, if the bridge has not applied it yet (the bridge validates it itself).
  res.json({ success: true, data: { command, cameraSelection: await camSvc.getPendingCameraSelection(req.station!) } });
});
photographyRouter.post('/stations/commands/:commandId/status', stationCapture, async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await cmdSvc.reportCommandStatus(req.station!, req.params.commandId, req.body) });
});
// The bridge uploads through the SAME URL and the SAME upload service as the browser; only the caller differs. A
// request bearing a station credential is handled here; anything else falls through to the user-authenticated route below.
const stationBearer = (req: Request, _res: Response, next: NextFunction) =>
  (/^Bearer stn_/i.test(req.headers.authorization ?? '') ? next() : next('route'));
photographyRouter.post('/images', stationBearer, stationCapture, multipart, rejectClientTenantSelectors,
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // tagId / stationId / companyId / branchId are never read from a station upload: the command-bound ticket decides.
    const result = await cmdSvc.uploadImageAsStation(req.station!, {
      ticket: b.ticket, imageType: b.imageType, idempotencyKey: b.idempotencyKey, cameraLabel: b.cameraLabel, capturedAt: b.capturedAt, file: req.file,
    });
    res.status(result.idempotentReplay ? 200 : 201).json({ success: true, data: result });
  });

photographyRouter.use(authenticate, resolveTenantContext);

const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

// Company Photography settings. The company comes from the tenant context only; the body is a strict settings object
// (an unknown key — companyId included — is a 400).
photographyRouter.get('/settings', requirePermission('photography:view'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await settingsSvc.getPhotographySettings(req.tenant!) });
});
photographyRouter.put('/settings', requirePermission('photography:manage_settings'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await settingsSvc.updatePhotographySettings(req.tenant!, req.body) });
});

// Dashboard numbers (aggregates only)
photographyRouter.get('/dashboard', requirePermission('photography:view'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await svc.getDashboard(req.tenant!) });
});

// Active capture stations in the caller's branches (read-only)
photographyRouter.get('/stations', requirePermission('photography:view'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await svc.listStations(req.tenant!) });
});

// Ask a station's Camera Bridge to use one of the cameras it reported (the browser never reaches the bridge itself).
photographyRouter.post('/stations/:stationId/camera-selection', requirePermission('photography:capture'), async (req: Request, res: Response) => {
  noStore(res);
  res.status(202).json({ success: true, data: await camSvc.requestCameraSelection(req.tenant!, req.params.stationId, req.body) });
});

// Station credential administration (never returns the hash; the plaintext is returned once, at issuance)
photographyRouter.post('/stations/:stationId/credentials', requirePermission('photography:manage_stations'), async (req: Request, res: Response) => {
  noStore(res);
  res.status(201).json({ success: true, data: await stationSvc.issueStationCredential(req.tenant!, req.params.stationId, req.body) });
});
photographyRouter.get('/stations/:stationId/credentials', requirePermission('photography:manage_stations'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await stationSvc.listStationCredentials(req.tenant!, req.params.stationId) });
});
photographyRouter.post('/stations/:stationId/credentials/:credentialId/revoke', requirePermission('photography:manage_stations'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await stationSvc.revokeStationCredential(req.tenant!, req.params.stationId, req.params.credentialId, req.body?.reason) });
});

// Tag lookup by scanned tag number
photographyRouter.get('/tags/:tagNumber', requirePermission('photography:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.lookupTagForPhotography(req.tenant!, req.params.tagNumber) });
});

// A tag's photo metadata (never storage keys or bucket URLs)
photographyRouter.get('/tags/:tagId/images', requirePermission('photography:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listTagImages(req.tenant!, req.params.tagId) });
});

// Start a capture session → short-lived scoped ticket
photographyRouter.post('/capture-sessions', requirePermission('photography:capture'), async (req: Request, res: Response) => {
  noStore(res);
  res.status(201).json({ success: true, data: await svc.startCaptureSession(req.tenant!, req.body ?? {}) });
});

// Upload one image against a ticket. multer runs first, so the tenant-selector guard (which app.ts applied BEFORE the
// multipart body existed) is applied again to the parsed fields.
photographyRouter.post('/images', requirePermission('photography:capture'), multipart, rejectClientTenantSelectors,
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await svc.uploadImage(req.tenant!, {
      ticket: b.ticket, tagId: b.tagId, stationId: b.stationId, imageType: b.imageType, idempotencyKey: b.idempotencyKey,
      cameraLabel: b.cameraLabel, capturedAt: b.capturedAt, file: req.file,
    });
    res.status(result.idempotentReplay ? 200 : 201).json({ success: true, data: result });
  });

// Remote capture, user side: ask a station's Camera Bridge to take the photo for an open capture session, then poll it.
photographyRouter.post('/capture-commands', requirePermission('photography:capture'), async (req: Request, res: Response) => {
  noStore(res);
  res.status(201).json({ success: true, data: await cmdSvc.createCaptureCommand(req.tenant!, req.body) });
});
photographyRouter.get('/capture-commands/:commandId', requirePermission('photography:capture'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await cmdSvc.getCaptureCommand(req.tenant!, req.params.commandId) });
});

// Short-lived signed read URL
photographyRouter.get('/images/:imageId/url', requirePermission('photography:view'), async (req: Request, res: Response) => {
  noStore(res);
  res.json({ success: true, data: await svc.getImageSignedUrl(req.tenant!, req.params.imageId, req.query.variant ?? 'original') });
});

// Soft delete (object is retained)
photographyRouter.delete('/images/:imageId', requirePermission('photography:delete'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.deleteImage(req.tenant!, req.params.imageId, req.body?.reason) });
});
