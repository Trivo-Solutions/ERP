// Capture ticket — a short-lived, server-issued, scoped credential for ONE capture session (one user shooting one
// tag at one station). It is a signed token (HS256) so it needs no table, but it is NOT the access token:
//   * signed with a key derived from JWT_SECRET for this purpose only (an access token does not verify as a
//     ticket, and a ticket does not verify as an access token);
//   * carries a distinct audience;
//   * binds company + tag + station + user + session + capture source + permitted operation.
// It never replaces authentication: the upload route still requires the caller's own login (and the
// photography:capture permission), and the ticket's company/user must match that login. A future Camera Bridge
// will present a station credential instead (StationCredential) — a separate, later phase.
//
// Lifecycle: valid for TICKET_TTL_SECONDS and for multiple uploads in that window (one session shoots several
// angles). It cannot be revoked early — there is no session table (deliberately: Phase 1 schema is frozen); each
// upload is individually protected by its own idempotency key, and the tag/station are re-validated on every use.
import { createHmac, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../middleware/error';

export const TICKET_TTL_SECONDS = 900;
const AUDIENCE = 'trivo:photography:capture';
const ISSUER = 'trivo-erp';
export const CAPTURE_SOURCES = ['DEVICE_CAMERA', 'BRIDGE'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export interface CaptureTicketClaims {
  cid: string; tid: string; sid: string; uid: string; sess: string; src: CaptureSource; ops: ['upload'];
  /** Present ONLY on a ticket minted for the Camera Bridge to carry out one remote-capture command (Phase 5D): it
   *  binds the ticket to that command, so a station can upload only for a command that was really issued to it. */
  cmd?: string;
}

const key = () => createHmac('sha256', env.JWT_SECRET).update('trivo:photography:capture-ticket:v1').digest();

export function issueCaptureTicket(
  c: Omit<CaptureTicketClaims, 'sess' | 'ops'> & { sess?: string; ttlSeconds?: number },
): { ticket: string; sessionId: string; expiresAt: Date } {
  const { sess, ttlSeconds, ...rest } = c;
  const sessionId = sess ?? randomUUID();
  const ttl = ttlSeconds ?? TICKET_TTL_SECONDS;
  const claims: CaptureTicketClaims = { ...rest, sess: sessionId, ops: ['upload'] };
  const ticket = jwt.sign(claims, key(), { algorithm: 'HS256', audience: AUDIENCE, issuer: ISSUER, expiresIn: ttl, jwtid: randomUUID() });
  return { ticket, sessionId, expiresAt: new Date(Date.now() + ttl * 1000) };
}

export function verifyCaptureTicket(ticket: unknown): CaptureTicketClaims {
  if (typeof ticket !== 'string' || !ticket) throw new AppError('Capture ticket is required', 400);
  try {
    const p = jwt.verify(ticket, key(), { algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER }) as CaptureTicketClaims;
    if (!p.cid || !p.tid || !p.sid || !p.uid || !p.sess || !Array.isArray(p.ops) || !p.ops.includes('upload')) throw new Error('shape');
    if (p.cmd !== undefined && (typeof p.cmd !== 'string' || !p.cmd)) throw new Error('shape');
    return p;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw new AppError('Capture ticket expired', 401, true, 'TICKET_EXPIRED');
    throw new AppError('Invalid capture ticket', 401, true, 'TICKET_INVALID');
  }
}
