// Camera Bridge identity (Photography Phase 5A-B).
//
//   StationCredential = the BRIDGE's identity (an opaque bearer secret bound to ONE station)
//   Capture ticket    = one USER's authorization to upload one image (captureTicket.ts)
// They are different things and are never combined or substituted for each other.
//
// Token format: `stn_<companyId>.<secret>` — secret = 32 CSPRNG bytes, base64url. Only SHA-256(token) is stored
// (station_credentials.tokenHash, DB CHECK ^[0-9a-f]{64}$). Same shape as invitation tokens: the companyId prefix is
// NOT a secret and grants nothing; it only tells the lookup WHICH company's rows to search, so the verification
// runs under that company's row-level security (tenantQuery) — no runAsPlatform / BYPASSRLS anywhere in this file.
// A token with a wrong prefix simply finds nothing. The credential row, not the request, decides company + station.
//
// A full-entropy random secret does not need a slow KDF; SHA-256 + a constant-time compare of the digests is the
// correct tool (same reasoning as invitation tokens).
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../config/logger';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, tenantTransaction, canAccessBranch, type TenantContext } from '../../shared/tenantContext';
import type { Prisma } from '@prisma/client';
import { parseCameraReport, pendingSelection } from './stationCameras';

export const STATION_SCOPE_HEARTBEAT = 'station:heartbeat';
/** Receive remote-capture commands, report their progress, and upload the resulting image (Phase 5D). Still no authority
 *  over ANY tag by itself: every upload must also carry a command-bound capture ticket (see captureCommand.service.ts). */
export const STATION_SCOPE_CAPTURE = 'station:capture';
/** Scope set for a newly issued credential. Credentials issued before Phase 5D carry heartbeat only and must be re-issued
 *  to take capture commands. */
export const DEFAULT_STATION_SCOPES = [STATION_SCOPE_HEARTBEAT, STATION_SCOPE_CAPTURE];

/** No expiry policy exists elsewhere in the codebase; this is the default, overridable per issuance (1–730 days). */
export const DEFAULT_CREDENTIAL_TTL_DAYS = 365;
const MAX_CREDENTIAL_TTL_DAYS = 730;
/** lastUsedAt is written at most this often per credential (a heartbeat can arrive every few seconds). */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
/** An "accepted" audit event is written when the station comes online: first ever heartbeat, or after this much silence. */
export const ONLINE_AUDIT_GAP_MS = 15 * 60 * 1000;

const TOKEN_RE = /^stn_([a-z0-9]{20,32})\.([A-Za-z0-9_-]{43})$/;
const CAMERA_STATUSES = ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'CAPTURING', 'ERROR'] as const;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function hashStationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newStationToken(companyId: string) {
  const token = `stn_${companyId}.${crypto.randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashStationToken(token) };
}

function parseStationToken(token: string): { companyId: string } | null {
  const m = TOKEN_RE.exec(token);
  return m ? { companyId: m[1] } : null;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

// ── management (user-authenticated; ctx from resolveTenantContext) ──────────────

const credentialSelect = {
  id: true, stationId: true, scopes: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/** Safe metadata only — never the hash or the secret. */
function toDto(r: {
  id: string; stationId: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null;
  createdBy: { id: string; name: string };
}) {
  return {
    id: r.id, stationId: r.stationId, scopes: r.scopes, createdAt: r.createdAt, createdBy: r.createdBy,
    lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt,
  };
}

/** A station of this company in a branch the caller may act on — anything else is the same 404. */
async function loadManagedStation(ctx: TenantContext, stationId: unknown) {
  if (typeof stationId !== 'string' || !stationId) throw new AppError('Station not found', 404);
  const st = await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.findFirst({
    where: { id: stationId, companyId: ctx.companyId }, select: { id: true, name: true, branchId: true, isActive: true },
  }));
  if (!st || !canAccessBranch(ctx, st.branchId)) throw new AppError('Station not found', 404);
  return st;
}

export async function issueStationCredential(ctx: TenantContext, stationId: unknown, input: unknown) {
  const body = (input ?? {}) as Record<string, unknown>;
  if (typeof body !== 'object' || Array.isArray(body)) throw new AppError('Invalid request body', 400);
  // Strict: the secret, scopes, hash, station and company are all server-decided, so none may be supplied.
  const unknown = Object.keys(body).filter((k) => k !== 'expiresInDays');
  if (unknown.length) throw new AppError(`Unexpected field(s): ${unknown.join(', ')}`, 400);
  let days = DEFAULT_CREDENTIAL_TTL_DAYS;
  if (body.expiresInDays !== undefined) {
    if (!Number.isInteger(body.expiresInDays) || (body.expiresInDays as number) < 1 || (body.expiresInDays as number) > MAX_CREDENTIAL_TTL_DAYS) {
      throw new AppError(`expiresInDays must be an integer between 1 and ${MAX_CREDENTIAL_TTL_DAYS}`, 400);
    }
    days = body.expiresInDays as number;
  }
  const station = await loadManagedStation(ctx, stationId);
  if (!station.isActive) throw new AppError('Station is inactive', 409);

  const { token, tokenHash } = newStationToken(ctx.companyId);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const row = await tenantQuery(ctx.companyId, (tx) => tx.stationCredential.create({
    data: { companyId: ctx.companyId, stationId: station.id, tokenHash, scopes: DEFAULT_STATION_SCOPES, createdById: ctx.userId, expiresAt },
    select: credentialSelect,
  }));
  await createAuditEntry('station_credentials', row.id, ctx.userId, 'ISSUE', undefined,
    { stationId: station.id, scopes: DEFAULT_STATION_SCOPES, expiresAt: expiresAt.toISOString() }, ctx.companyId);
  // The ONLY place the plaintext ever leaves the server.
  return { ...toDto(row), station: { id: station.id, name: station.name, branchId: station.branchId }, credential: token };
}

export async function listStationCredentials(ctx: TenantContext, stationId: unknown) {
  const station = await loadManagedStation(ctx, stationId);
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.stationCredential.findMany({
    where: { companyId: ctx.companyId, stationId: station.id }, select: credentialSelect, orderBy: { createdAt: 'desc' },
  }));
  return rows.map(toDto);
}

export async function revokeStationCredential(ctx: TenantContext, stationId: unknown, credentialId: unknown, reason: unknown) {
  const station = await loadManagedStation(ctx, stationId);
  if (typeof credentialId !== 'string' || !credentialId) throw new AppError('Credential not found', 404);
  let why: string | undefined;
  if (reason !== undefined && reason !== null && reason !== '') {
    if (typeof reason !== 'string' || reason.length > 500) throw new AppError('reason must be a string of at most 500 characters', 400);
    why = reason.replace(/[\u0000-\u001f\u007f]/g, '').trim() || undefined;
  }
  const now = new Date();
  const row = await tenantTransaction(ctx.companyId, async (tx) => {
    const cur = await tx.stationCredential.findFirst({
      where: { id: credentialId, companyId: ctx.companyId, stationId: station.id }, select: { id: true, revokedAt: true },
    });
    if (!cur) throw new AppError('Credential not found', 404);
    // Count-checked conditional write: two concurrent revokes cannot both "win".
    const n = await tx.stationCredential.updateMany({
      where: { id: cur.id, companyId: ctx.companyId, revokedAt: null }, data: { revokedAt: now, revokedById: ctx.userId },
    });
    if (n.count !== 1) throw new AppError('Credential is already revoked', 409);
    return tx.stationCredential.findFirstOrThrow({ where: { id: cur.id, companyId: ctx.companyId }, select: credentialSelect });
  });
  await createAuditEntry('station_credentials', row.id, ctx.userId, 'REVOKE', { revokedAt: null },
    { stationId: station.id, revokedAt: now.toISOString(), ...(why ? { reason: why } : {}) }, ctx.companyId);
  return toDto(row);
}

// ── station authentication (the credential is the ONLY authority) ───────────────

export interface StationPrincipal {
  companyId: string;
  stationId: string;
  stationName: string;
  branchId: string;
  credentialId: string;
  createdById: string;
  lastUsedAt: Date | null;
  lastSeenAt: Date | null;
}

declare global {
  namespace Express {
    interface Request { station?: StationPrincipal }
  }
}

function deny(res: Response, status: 401 | 403, code: string) {
  res.setHeader('Cache-Control', 'no-store');
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="trivo-station"');
  return res.status(status).json({ success: false, error: status === 401 ? 'Station authentication required' : 'Station is not authorized', code });
}

/** System-initiated audit entry: the audit table needs a user, so it is attributed to the human who ISSUED the
 *  credential, with `actor: 'STATION'` marking it as station-originated. Never throws into the request. */
async function stationAudit(p: StationPrincipal, action: string, recordId: string, detail: Record<string, unknown>) {
  try {
    await createAuditEntry('station_credentials', recordId, p.createdById, action, undefined,
      { actor: 'STATION', stationId: p.stationId, credentialId: p.credentialId, ...detail }, p.companyId);
  } catch (e) {
    logger.warn(`station audit not recorded (${action}): ${(e as Error).message}`);
  }
}

/** Station-credential authentication requiring `scope` (the credential must also be live, unexpired, and its station and
 *  company active). */
export function authenticateStationWithScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => authenticateStationImpl(scope, req, res, next);
}
export const authenticateStation = authenticateStationWithScope(STATION_SCOPE_HEARTBEAT);

async function authenticateStationImpl(scope: string, req: Request, res: Response, next: NextFunction) {
  try {
    const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    const parsed = m ? parseStationToken(m[1]) : null;
    if (!m || !parsed) return deny(res, 401, 'STATION_AUTH_REQUIRED'); // missing, malformed, or a user JWT
    const presentedHash = hashStationToken(m[1]);

    const cred = await tenantQuery(parsed.companyId, (tx) => tx.stationCredential.findUnique({
      where: { tokenHash: presentedHash },
      select: {
        id: true, companyId: true, stationId: true, tokenHash: true, scopes: true, createdById: true, lastUsedAt: true,
        revokedAt: true, expiresAt: true,
        company: { select: { isActive: true } },
        station: { select: { id: true, name: true, branchId: true, isActive: true, lastSeenAt: true, companyId: true } },
      },
    }));
    // Not found (incl. a prefix naming another company — RLS hides that company's row) is a plain 401. Nothing is
    // audited for it: the company in an unauthenticated token is only a claim, and writing into that company's trail
    // would let anyone spam it.
    if (!cred || !safeEqualHex(cred.tokenHash, presentedHash) || cred.companyId !== parsed.companyId) {
      logger.warn('station auth: unknown credential');
      return deny(res, 401, 'STATION_AUTH_REQUIRED');
    }

    const principal: StationPrincipal = {
      companyId: cred.companyId, stationId: cred.stationId, stationName: cred.station.name, branchId: cred.station.branchId,
      credentialId: cred.id, createdById: cred.createdById, lastUsedAt: cred.lastUsedAt, lastSeenAt: cred.station.lastSeenAt,
    };
    let reason: { code: string; why: string } | null = null;
    if (cred.revokedAt) reason = { code: 'CREDENTIAL_INVALID', why: 'REVOKED' };
    else if (cred.expiresAt && cred.expiresAt.getTime() <= Date.now()) reason = { code: 'CREDENTIAL_INVALID', why: 'EXPIRED' };
    else if (!cred.company.isActive) reason = { code: 'CREDENTIAL_INVALID', why: 'COMPANY_INACTIVE' };
    else if (cred.station.companyId !== cred.companyId) reason = { code: 'CREDENTIAL_INVALID', why: 'STATION_MISMATCH' };
    else if (!cred.station.isActive) reason = { code: 'STATION_DISABLED', why: 'STATION_INACTIVE' };
    else if (!cred.scopes.includes(scope)) reason = { code: 'CREDENTIAL_INVALID', why: 'SCOPE' };
    if (reason) {
      await stationAudit(principal, 'AUTH_DENIED', cred.id, { result: 'DENIED', reason: reason.why });
      return deny(res, 403, reason.code);
    }
    req.station = principal;
    next();
  } catch (e) {
    next(e);
  }
}

// ── heartbeat ────────────────────────────────────────────────────────────────

export function parseHeartbeat(input: unknown, station: { id: string }) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new AppError('Invalid heartbeat payload', 400);
  const b = input as Record<string, unknown>;
  // branchId (and companyId, rejected app-wide) are never accepted. stationId is accepted ONLY as an echo of what the
  // bridge believes it is; it carries no authority and must match the credential's station.
  const allowed = new Set(['bridgeVersion', 'cameraStatus', 'clientTimestamp', 'stationId', 'cameras']);
  const extra = Object.keys(b).filter((k) => !allowed.has(k));
  if (extra.length) throw new AppError(`Unexpected field(s): ${extra.join(', ')}`, 400);
  if (b.stationId !== undefined && b.stationId !== station.id) throw new AppError('stationId does not match the authenticated station', 400);
  if (typeof b.bridgeVersion !== 'string' || !VERSION_RE.test(b.bridgeVersion)) throw new AppError('bridgeVersion is required (max 32 chars: letters, digits, . + _ -)', 400);
  if (typeof b.cameraStatus !== 'string' || !(CAMERA_STATUSES as readonly string[]).includes(b.cameraStatus)) {
    throw new AppError(`cameraStatus must be one of ${CAMERA_STATUSES.join(', ')}`, 400);
  }
  let clientTimestamp: Date | undefined;
  if (b.clientTimestamp !== undefined) {
    const d = typeof b.clientTimestamp === 'string' ? new Date(b.clientTimestamp) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new AppError('clientTimestamp must be an ISO timestamp', 400);
    // Informational only (never stored or used for ordering); just refuse nonsense far in the future.
    if (d.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) throw new AppError('clientTimestamp is in the future', 400);
    clientTimestamp = d;
  }
  // Optional: an older bridge does not report cameras. When present it is the bridge's own discovery result (stationCameras.ts).
  const cameras = b.cameras === undefined ? undefined : parseCameraReport(b.cameras);
  return { bridgeVersion: b.bridgeVersion, cameraStatus: b.cameraStatus as (typeof CAMERA_STATUSES)[number], clientTimestamp, cameras };
}

export async function recordHeartbeat(p: StationPrincipal, input: unknown) {
  const hb = parseHeartbeat(input, { id: p.stationId });
  const now = new Date();
  // Re-check liveness at WRITE time (a revoke / deactivation can land between authentication and here): the guards
  // live in the WHERE clause and the write is count-checked, so a revoked credential or disabled station never
  // gets lastSeenAt.
  const touchUsed = !p.lastUsedAt || now.getTime() - p.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS;
  let cameraSelection: { cameraId: string } | null = null;
  const ok = await tenantTransaction(p.companyId, async (tx) => {
    // Read BEFORE the write: the selection this heartbeat's own report has not yet reflected is the one to hand back.
    const before = await tx.photographyStation.findFirst({
      where: { id: p.stationId, companyId: p.companyId }, select: { requestedCameraId: true, cameraRequestedAt: true, reportedCameras: true },
    });
    const pending = before ? pendingSelection(before) : null;
    cameraSelection = pending ? { cameraId: pending } : null;
    const n = await tx.photographyStation.updateMany({
      where: {
        id: p.stationId, companyId: p.companyId, isActive: true,
        credentials: { some: { id: p.credentialId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
      },
      data: { lastSeenAt: now, ...(hb.cameras ? { reportedCameras: hb.cameras as unknown as Prisma.InputJsonValue, camerasReportedAt: now } : {}) },
    });
    if (n.count !== 1) return false;
    if (touchUsed) await tx.stationCredential.updateMany({ where: { id: p.credentialId, companyId: p.companyId }, data: { lastUsedAt: now } });
    return true;
  });
  if (!ok) throw new AppError('Station is not authorized', 403);
  if (!p.lastSeenAt || now.getTime() - p.lastSeenAt.getTime() >= ONLINE_AUDIT_GAP_MS) {
    await stationAudit(p, 'HEARTBEAT_ACCEPTED', p.credentialId, { result: 'ACCEPTED', bridgeVersion: hb.bridgeVersion, cameraStatus: hb.cameraStatus });
  }
  return { accepted: true, stationId: p.stationId, stationName: p.stationName, branchId: p.branchId, serverTime: now.toISOString(), cameraSelection };
}
