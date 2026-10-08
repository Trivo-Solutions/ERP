// Station camera discovery, bridge-reported (Photography: Windows webcam integration).
//
// The browser can never talk to a Camera Bridge (it listens on loopback only and refuses requests that carry a browser
// Origin), so the ERP learns about a station's cameras the only authenticated way it already has: the bridge REPORTS them
// in its heartbeat. An ERP user can then ASK for one of them; the request is parked on the station row and handed to the
// bridge on its next heartbeat / command poll. The bridge validates it and remains the only authority on what is selected —
// the ERP stores a mirror and a request, never a camera id it chose on its own.
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, type TenantContext } from '../../shared/tenantContext';
import * as photo from './photography.service';

export const CAMERA_ID_RE = /^(webcam|sony|mock):[A-Za-z0-9._:-]{1,64}$/;
const KINDS = ['webcam', 'sony', 'mock'] as const;
const UNAVAILABLE_REASONS = ['DRIVER_UNAVAILABLE', 'NOT_CONNECTED'] as const;
const MAX_CAMERAS = 16;
const MAX_NAME = 80;
/** A parked selection request stops being delivered after this long, so a camera that can never be applied cannot be re-sent forever. */
export const CAMERA_REQUEST_TTL_MS = 120_000;
/** A mirror older than this is not shown as the station's current cameras. Heartbeats arrive every 30 s. */
export const CAMERA_REPORT_FRESH_MS = 90_000;

export interface ReportedCamera {
  id: string; displayName: string; kind: (typeof KINDS)[number]; available: boolean; selected: boolean;
  unavailableReason?: (typeof UNAVAILABLE_REASONS)[number]; placement?: 'integrated';
}
export interface CameraReport { cameras: ReportedCamera[]; selectedId: string | null; selectionRequired: boolean }

/** Strict on shape, lenient on content: a malformed report is a 400, but a display name is cleaned rather than refused. */
export function parseCameraReport(input: unknown): CameraReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('cameras must be an object', 400);
  const b = input as Record<string, unknown>;
  if (!Array.isArray(b.cameras) || b.cameras.length > MAX_CAMERAS) throw new AppError(`cameras.cameras must be a list of at most ${MAX_CAMERAS}`, 400);
  if (b.selectedId !== null && b.selectedId !== undefined && (typeof b.selectedId !== 'string' || !CAMERA_ID_RE.test(b.selectedId))) {
    throw new AppError('cameras.selectedId is invalid', 400);
  }
  const cameras: ReportedCamera[] = [];
  for (const raw of b.cameras) {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (typeof c.id !== 'string' || !CAMERA_ID_RE.test(c.id)) throw new AppError('cameras.cameras[].id is invalid', 400);
    if (typeof c.available !== 'boolean' || typeof c.selected !== 'boolean') throw new AppError('cameras.cameras[] available/selected must be booleans', 400);
    const kind = c.id.split(':')[0] as ReportedCamera['kind'];
    // eslint-disable-next-line no-control-regex
    const name = (typeof c.displayName === 'string' ? c.displayName : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    cameras.push({
      id: c.id, displayName: name || 'Camera', kind, available: c.available, selected: c.selected,
      ...(UNAVAILABLE_REASONS.includes(c.unavailableReason as never) ? { unavailableReason: c.unavailableReason as ReportedCamera['unavailableReason'] } : {}),
      ...(c.placement === 'integrated' ? { placement: 'integrated' as const } : {}),
    });
  }
  return { cameras, selectedId: (b.selectedId as string | null | undefined) ?? null, selectionRequired: b.selectionRequired === true };
}

/** The selection the bridge has not applied yet, if a user asked for one recently. Pure so it is unit-testable. */
export function pendingSelection(
  s: { requestedCameraId: string | null; cameraRequestedAt: Date | null; reportedCameras: unknown },
  now = Date.now(),
): string | null {
  if (!s.requestedCameraId || !s.cameraRequestedAt) return null;
  if (now - s.cameraRequestedAt.getTime() > CAMERA_REQUEST_TTL_MS) return null;
  const reported = s.reportedCameras as Partial<CameraReport> | null;
  return reported?.selectedId === s.requestedCameraId ? null : s.requestedCameraId;
}

/** Bridge-facing: the selection waiting for this station (company + station come from the credential, never the request). */
export async function getPendingCameraSelection(station: { companyId: string; stationId: string }) {
  const row = await tenantQuery(station.companyId, (tx) => tx.photographyStation.findFirst({
    where: { id: station.stationId, companyId: station.companyId },
    select: { requestedCameraId: true, cameraRequestedAt: true, reportedCameras: true },
  }));
  const id = row ? pendingSelection(row) : null;
  return id ? { cameraId: id } : null;
}

/** The mirror as the browser sees it. `fresh` says whether the bridge has reported recently enough to trust it. */
export function toCameraDto(
  s: { reportedCameras: unknown; camerasReportedAt: Date | null; requestedCameraId: string | null; cameraRequestedAt: Date | null },
  now = Date.now(),
) {
  const report = s.reportedCameras as CameraReport | null;
  if (!report || !s.camerasReportedAt) return null;
  return {
    cameras: report.cameras, selectedId: report.selectedId, selectionRequired: report.selectionRequired,
    reportedAt: s.camerasReportedAt, fresh: now - s.camerasReportedAt.getTime() <= CAMERA_REPORT_FRESH_MS,
    pendingCameraId: pendingSelection(s, now),
  };
}

/** ERP-user side: ask a station's bridge to use one of the cameras it reported. */
export async function requestCameraSelection(ctx: TenantContext, stationId: string, input: unknown) {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b !== 'object' || Array.isArray(b)) throw new AppError('Invalid request body', 400);
  const extra = Object.keys(b).filter((k) => k !== 'cameraId');
  if (extra.length) throw new AppError(`Unexpected field(s): ${extra.join(', ')}`, 400);
  if (typeof b.cameraId !== 'string' || !CAMERA_ID_RE.test(b.cameraId)) throw new AppError('cameraId is invalid', 400);
  const cameraId = b.cameraId;

  const station = await photo.loadStation(ctx, stationId); // company, branch grant and active — else the same 404/409 as everywhere
  const row = await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.findFirst({
    where: { id: station.id, companyId: ctx.companyId }, select: { reportedCameras: true, camerasReportedAt: true, requestedCameraId: true },
  }));
  const report = row?.reportedCameras as CameraReport | null;
  const cam = report?.cameras.find((c) => c.id === cameraId);
  // Only a camera this very bridge reported can be asked for: an arbitrary id never reaches a bridge.
  if (!cam) throw new AppError('That camera was not reported by this station', 409, true, 'CAMERA_UNKNOWN');
  if (!cam.available) throw new AppError('That camera is not available', 409, true, 'CAMERA_UNAVAILABLE');

  const now = new Date();
  await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.updateMany({
    where: { id: station.id, companyId: ctx.companyId }, data: { requestedCameraId: cameraId, cameraRequestedAt: now },
  }));
  await createAuditEntry('photography_stations', station.id, ctx.userId, 'UPDATE', { requestedCameraId: row?.requestedCameraId ?? null },
    { action: 'CAMERA_SELECTION_REQUESTED', requestedCameraId: cameraId }, ctx.companyId);
  return { stationId: station.id, pendingCameraId: cameraId, requestedAt: now };
}
