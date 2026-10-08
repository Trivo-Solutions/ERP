// Remote capture (Photography Phase 5D): ERP user -> capture command -> Camera Bridge -> existing upload pipeline.
//
// Three different things stay separate here (never combined or substituted for each other):
//   StationCredential = the BRIDGE's identity (stationCredential.service.ts)
//   Capture ticket    = one USER's authorization to upload for ONE tag at ONE station (captureTicket.ts)
//   Command           = a durable record that this user asked this station to take one photo, and how far that got
//
// The user's session ticket is the proof that the user really started a capture session; it is verified when the
// command is created and is NOT stored. When the bridge picks the command up, a fresh ticket is minted from the
// command row's own columns (same claims, same session, plus `cmd` binding it to this command). The bridge uploads
// with that ticket through the ordinary POST /photography/images — a station credential alone authorizes no tag.
//
// Transport is HTTPS long-polling: the bridge asks `GET /stations/commands/next`; nothing is pushed to a LAN address.
// Lifecycle (all transitions are count-checked conditional writes):
//   QUEUED -> ACCEPTED (bridge validated it) -> CAPTURING -> UPLOADED (set by the server when the image is stored)
//   any live state -> FAILED (bridge-reported, whitelisted code) | EXPIRED (deadline passed; set lazily)
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { logger } from '../../config/logger';
import { tenantQuery, type TenantContext } from '../../shared/tenantContext';
import { issueCaptureTicket, verifyCaptureTicket } from './captureTicket';
import * as photo from './photography.service';
import type { StationPrincipal } from './stationCredential.service';
import { getPendingCameraSelection } from './stationCameras';

/** A queued command that no bridge picks up, or one that never finishes, stops being live after this long. */
export const COMMAND_TTL_SECONDS = 180;
/** The bridge-held ticket outlives its command only by this margin; the command's own status is the real bound. */
const COMMAND_TICKET_MARGIN_SECONDS = 60;
/** A station counts as reachable if its heartbeat (every 30 s) arrived within this window. */
export const STATION_ONLINE_WINDOW_MS = 90_000;
export const MAX_POLL_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 1000;

export const COMMAND_STATUSES = ['QUEUED', 'ACCEPTED', 'CAPTURING', 'UPLOADED', 'FAILED', 'EXPIRED'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
const LIVE: CommandStatus[] = ['QUEUED', 'ACCEPTED', 'CAPTURING'];
/** Normalized failure codes a bridge may report (SUCCESS is not a failure; UPLOADED is set by the server itself). */
export const FAILURE_CODES = ['BUSY', 'CAMERA_ERROR', 'AUTH_ERROR', 'UPLOAD_ERROR', 'NETWORK_ERROR', 'COMMAND_REJECTED', 'EXPIRED'] as const;
const DETAIL_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

const cmdSelect = {
  id: true, companyId: true, stationId: true, tagId: true, requestedById: true, sessionId: true, correlationId: true,
  imageType: true, status: true, failureCode: true, failureDetail: true, idempotencyKey: true, tagImageId: true,
  expiresAt: true, acceptedAt: true, completedAt: true, createdAt: true,
} satisfies Prisma.PhotographyCaptureCommandSelect;
type CmdRow = Prisma.PhotographyCaptureCommandGetPayload<{ select: typeof cmdSelect }>;

function toDto(r: CmdRow) {
  return {
    commandId: r.id, status: r.status as CommandStatus, stationId: r.stationId, tagId: r.tagId, imageType: r.imageType,
    correlationId: r.correlationId, failureCode: r.failureCode, failureDetail: r.failureDetail,
    expiresAt: r.expiresAt, acceptedAt: r.acceptedAt, completedAt: r.completedAt, createdAt: r.createdAt,
  };
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Marks every live command of the station (or all of the company's, when stationId is omitted) past its deadline. */
async function expireStale(companyId: string, stationId?: string) {
  const now = new Date();
  await tenantQuery(companyId, (tx) => tx.photographyCaptureCommand.updateMany({
    where: { companyId, ...(stationId ? { stationId } : {}), status: { in: LIVE }, expiresAt: { lte: now } },
    data: { status: 'EXPIRED', completedAt: now },
  }));
}

// ── ERP user side ────────────────────────────────────────────────────────────

export async function createCaptureCommand(ctx: TenantContext, input: unknown) {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b !== 'object' || Array.isArray(b)) throw new AppError('Invalid request body', 400);
  const extra = Object.keys(b).filter((k) => k !== 'ticket' && k !== 'imageType');
  if (extra.length) throw new AppError(`Unexpected field(s): ${extra.join(', ')}`, 400);
  const imageType = b.imageType as photo.ImageType;
  if (!photo.IMAGE_TYPES.includes(imageType)) throw new AppError(`imageType must be one of ${photo.IMAGE_TYPES.join(', ')}`, 400);

  // The ticket proves this user started a capture session for this tag + station. It must be a plain session ticket
  // (never a command ticket) and for a bridge-sourced session.
  const claims = verifyCaptureTicket(b.ticket);
  if (claims.cid !== ctx.companyId || claims.uid !== ctx.userId || claims.cmd) throw new AppError('Invalid capture ticket', 401, true, 'TICKET_INVALID');
  if (claims.src !== 'BRIDGE') throw new AppError('This capture session was not started for a Camera Bridge', 409, true, 'SESSION_NOT_BRIDGE');

  // ERP stays authoritative for tag / station / branch rules — re-validated now, and again at upload.
  const tag = await photo.loadTag(ctx, { id: claims.tid });
  const station = await photo.loadStation(ctx, claims.sid);
  photo.assertSameBranch(tag, station);
  const seen = await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.findFirst({
    where: { id: station.id, companyId: ctx.companyId }, select: { lastSeenAt: true },
  }));
  if (!seen?.lastSeenAt || Date.now() - seen.lastSeenAt.getTime() > STATION_ONLINE_WINDOW_MS) {
    throw new AppError('The Camera Bridge for this station is not online; choose a file instead', 409, true, 'STATION_OFFLINE');
  }

  await expireStale(ctx.companyId, station.id);
  const now = Date.now();
  let row: CmdRow;
  try {
    row = await tenantQuery(ctx.companyId, (tx) => tx.photographyCaptureCommand.create({
      data: {
        companyId: ctx.companyId, stationId: station.id, tagId: tag.id, requestedById: ctx.userId, sessionId: claims.sess,
        correlationId: randomUUID(), imageType, status: 'QUEUED', expiresAt: new Date(now + COMMAND_TTL_SECONDS * 1000),
      },
      select: cmdSelect,
    }));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('This station is already handling a capture', 409, true, 'STATION_BUSY');
    throw e;
  }
  await createAuditEntry('photography_capture_commands', row.id, ctx.userId, 'CREATE', undefined,
    { stationId: station.id, tagId: tag.id, imageType, sessionId: claims.sess, correlationId: row.correlationId }, ctx.companyId);
  return toDto(row);
}

/** The requesting user's own command — anyone else's (or another company's) is the same 404. */
export async function getCaptureCommand(ctx: TenantContext, commandId: unknown) {
  if (typeof commandId !== 'string' || !commandId) throw new AppError('Command not found', 404);
  await expireStale(ctx.companyId);
  const row = await tenantQuery(ctx.companyId, (tx) => tx.photographyCaptureCommand.findFirst({
    where: { id: commandId, companyId: ctx.companyId, requestedById: ctx.userId }, select: cmdSelect,
  }));
  if (!row) throw new AppError('Command not found', 404);
  const image = row.tagImageId ? await photo.getImage(ctx, row.tagImageId) : null;
  return { ...toDto(row), image: image ? photo.toDto(image) : null };
}

// ── Camera Bridge side (authenticated by StationCredential only) ─────────────

function mintCommandTicket(c: Pick<CmdRow, 'id' | 'companyId' | 'tagId' | 'stationId' | 'requestedById' | 'sessionId'>) {
  return issueCaptureTicket({
    cid: c.companyId, tid: c.tagId, sid: c.stationId, uid: c.requestedById, src: 'BRIDGE', cmd: c.id, sess: c.sessionId,
    ttlSeconds: COMMAND_TTL_SECONDS + COMMAND_TICKET_MARGIN_SECONDS,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Long-poll: resolves with the station's next QUEUED command, or null when none arrived within `waitSeconds`.
 *  A command is re-delivered until the bridge acknowledges it (ACCEPTED), so a lost response never loses a command;
 *  the bridge de-duplicates by commandId. */
export async function pollNextCommand(station: StationPrincipal, waitSecondsRaw: unknown, pollIntervalMs = POLL_INTERVAL_MS) {
  let wait = 0;
  if (waitSecondsRaw !== undefined) {
    wait = Number(waitSecondsRaw);
    if (!Number.isFinite(wait) || wait < 0) throw new AppError('waitSeconds must be a non-negative number', 400);
    wait = Math.min(wait, MAX_POLL_WAIT_SECONDS);
  }
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    await expireStale(station.companyId, station.stationId);
    const row = await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.findFirst({
      where: { companyId: station.companyId, stationId: station.stationId, status: 'QUEUED', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { ...cmdSelect, tag: { select: { tagNumber: true } } },
    }));
    if (row) {
      const t = mintCommandTicket(row);
      return {
        commandId: row.id, correlationId: row.correlationId, stationId: row.stationId, tagNumber: row.tag.tagNumber,
        imageType: row.imageType, ticket: t.ticket, expiresAt: row.expiresAt,
      };
    }
    // A camera selection a user just asked for ends the wait early so the bridge applies it now, not after the full long-poll.
    if (await getPendingCameraSelection(station)) return null;
    if (Date.now() + pollIntervalMs >= deadline) return null;
    await sleep(pollIntervalMs);
  }
}

const FROM: Record<'ACCEPTED' | 'CAPTURING' | 'FAILED', CommandStatus[]> = {
  ACCEPTED: ['QUEUED'], CAPTURING: ['ACCEPTED'], FAILED: LIVE,
};

export async function reportCommandStatus(station: StationPrincipal, commandId: unknown, input: unknown) {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b !== 'object' || Array.isArray(b)) throw new AppError('Invalid request body', 400);
  const extra = Object.keys(b).filter((k) => !['status', 'code', 'detail'].includes(k));
  if (extra.length) throw new AppError(`Unexpected field(s): ${extra.join(', ')}`, 400);
  const status = b.status as 'ACCEPTED' | 'CAPTURING' | 'FAILED';
  if (status !== 'ACCEPTED' && status !== 'CAPTURING' && status !== 'FAILED') throw new AppError('status must be ACCEPTED, CAPTURING or FAILED', 400);
  let code: string | null = null; let detail: string | null = null;
  if (status === 'FAILED') {
    if (typeof b.code !== 'string' || !(FAILURE_CODES as readonly string[]).includes(b.code)) throw new AppError(`code must be one of ${FAILURE_CODES.join(', ')}`, 400);
    code = b.code;
    if (b.detail !== undefined && b.detail !== null) {
      if (typeof b.detail !== 'string' || !DETAIL_RE.test(b.detail)) throw new AppError('detail must be an upper-case code (A-Z, 0-9, _; max 40)', 400);
      detail = b.detail;
    }
  } else if (b.code !== undefined || b.detail !== undefined) throw new AppError('code/detail are only valid with FAILED', 400);
  // A station sees ONLY its own commands: another station's (or company's) id is the same 404.
  if (typeof commandId !== 'string' || !commandId) throw new AppError('Command not found', 404);
  const cur = await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.findFirst({
    where: { id: commandId, companyId: station.companyId, stationId: station.stationId }, select: cmdSelect,
  }));
  if (!cur) throw new AppError('Command not found', 404);

  const now = new Date();
  // Count-checked conditional write: the state check and the write are one statement, so two reports cannot both win.
  const n = await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.updateMany({
    where: { id: cur.id, companyId: station.companyId, stationId: station.stationId, status: { in: FROM[status] }, expiresAt: { gt: now } },
    data: status === 'FAILED'
      ? { status, failureCode: code, failureDetail: detail, completedAt: now }
      : { status, ...(status === 'ACCEPTED' ? { acceptedAt: now } : {}) },
  }));
  if (n.count !== 1) {
    await expireStale(station.companyId, station.stationId);
    const after = await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.findFirst({
      where: { id: cur.id, companyId: station.companyId }, select: { status: true },
    }));
    if (after?.status === 'EXPIRED') throw new AppError('Command expired', 410, true, 'COMMAND_EXPIRED');
    throw new AppError(`Command is ${after?.status ?? cur.status}; ${status} is not a valid next step`, 409, true, 'COMMAND_STATE');
  }
  if (status === 'FAILED') {
    try {
      await createAuditEntry('photography_capture_commands', cur.id, station.createdById, 'FAIL', { status: cur.status },
        { actor: 'STATION', stationId: station.stationId, credentialId: station.credentialId, failureCode: code, failureDetail: detail }, station.companyId);
    } catch (e) { logger.warn(`capture command audit not recorded: ${(e as Error).message}`); }
  }
  return { commandId: cur.id, status };
}

// ── station upload (the existing /photography/images pipeline, authenticated as a station) ─────────────

export interface StationUploadFields {
  ticket: unknown; imageType: unknown; idempotencyKey: unknown; cameraLabel?: unknown; capturedAt?: unknown;
  file?: photo.UploadInput['file'];
}

/** Station-authenticated entry to the SAME upload service the browser uses. The station may upload only with a
 *  command-bound ticket whose command is live, belongs to this station, and was requested by the ticket's user; the
 *  image type is the command's, not the caller's. Everything else (tag / station / branch / bytes / idempotency /
 *  processing) is `uploadImage` itself. */
export async function uploadImageAsStation(station: StationPrincipal, f: StationUploadFields) {
  const claims = verifyCaptureTicket(f.ticket);
  if (claims.cid !== station.companyId || claims.sid !== station.stationId || claims.src !== 'BRIDGE' || !claims.cmd) {
    throw new AppError('Invalid capture ticket', 401, true, 'TICKET_INVALID');
  }
  await expireStale(station.companyId, station.stationId);
  const cmd = await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.findFirst({
    where: { id: claims.cmd, companyId: station.companyId, stationId: station.stationId }, select: cmdSelect,
  }));
  if (!cmd || cmd.requestedById !== claims.uid || cmd.tagId !== claims.tid || cmd.sessionId !== claims.sess) {
    throw new AppError('Invalid capture ticket', 401, true, 'TICKET_INVALID');
  }
  if (cmd.status === 'EXPIRED') throw new AppError('Capture command expired', 401, true, 'COMMAND_EXPIRED');
  if (cmd.status === 'FAILED' || cmd.status === 'QUEUED') throw new AppError(`Capture command is ${cmd.status}`, 409, true, 'COMMAND_STATE');
  if (f.imageType !== cmd.imageType) throw new AppError('imageType does not match the capture command', 403, true, 'COMMAND_MISMATCH');
  if (cmd.status === 'UPLOADED' && cmd.idempotencyKey !== f.idempotencyKey) {
    throw new AppError('This capture command already has its image', 409, true, 'COMMAND_STATE');
  }
  // Acts as the user who authorized the capture, confined to the station's own branch (so a tag that moved branch is
  // a plain 404, exactly as it is for the user). `permissions` is empty on purpose: nothing downstream checks it.
  const ctx: TenantContext = {
    companyId: station.companyId, companyUserId: '', userId: claims.uid, roleId: '', roleName: 'STATION', permissions: [],
    branchAccess: { allBranches: false, branchIds: [station.branchId] },
  };
  const result = await photo.uploadImage(ctx, {
    ticket: f.ticket, imageType: f.imageType, idempotencyKey: f.idempotencyKey, cameraLabel: f.cameraLabel,
    capturedAt: f.capturedAt, file: f.file, commandId: cmd.id,
  });
  const now = new Date();
  await tenantQuery(station.companyId, (tx) => tx.photographyCaptureCommand.updateMany({
    where: { id: cmd.id, companyId: station.companyId, status: { in: ['ACCEPTED', 'CAPTURING'] } },
    data: { status: 'UPLOADED', tagImageId: result.image.id, idempotencyKey: String(f.idempotencyKey), completedAt: now },
  }));
  return result;
}
