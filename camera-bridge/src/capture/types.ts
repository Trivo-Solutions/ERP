// Remote-capture vocabulary shared by the poller, executor and transport. Four identifiers stay distinct on purpose:
//   commandId       prevents duplicate EXECUTION of one command by this bridge
//   correlationId   traces one capture across ERP, bridge and camera logs
//   idempotencyKey  prevents a duplicate IMAGE when an upload is retried (generated here, per command)
//   ticket          the ERP's authorization for this capture (opaque to the bridge; never logged or persisted)
export const CAPTURE_RESULT_CODES = ['SUCCESS', 'BUSY', 'CAMERA_ERROR', 'AUTH_ERROR', 'UPLOAD_ERROR', 'NETWORK_ERROR', 'COMMAND_REJECTED', 'EXPIRED'] as const;
export type CaptureResultCode = (typeof CAPTURE_RESULT_CODES)[number];
export type FailureCode = Exclude<CaptureResultCode, 'SUCCESS'>;

export const IMAGE_TYPES = ['PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export interface CaptureCommand {
  commandId: string;
  correlationId: string;
  stationId: string;
  imageType: ImageType;
  tagNumber?: string;
  ticket: string;
  expiresAt: string;
}

export interface CaptureResult {
  commandId: string;
  correlationId?: string;
  code: CaptureResultCode;
  /** Finer, still-vendor-neutral reason, e.g. CAPTURE_TIMEOUT vs UPLOAD_TIMEOUT. Never a path, stack or payload. */
  detail?: string;
  /** Set on SUCCESS: the TagImage the ERP created. */
  imageId?: string;
  /** True when a failed capture left the image in the bridge's temp area for a later retry/inspection. */
  imageRetained?: boolean;
}

export class CommandRejected extends Error {
  constructor(public readonly detail: string) { super(detail); this.name = 'CommandRejected'; }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CORRELATION = /^[A-Za-z0-9._:-]{1,64}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Strict structural validation of a command received from the ERP. Anything unexpected is rejected, never coerced. */
export function parseCommand(raw: unknown): CaptureCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CommandRejected('MALFORMED');
  const r = raw as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  if (!ID.test(s('commandId'))) throw new CommandRejected('BAD_COMMAND_ID');
  if (!CORRELATION.test(s('correlationId'))) throw new CommandRejected('BAD_CORRELATION_ID');
  if (!ID.test(s('stationId'))) throw new CommandRejected('BAD_STATION_ID');
  if (!(IMAGE_TYPES as readonly string[]).includes(s('imageType'))) throw new CommandRejected('BAD_IMAGE_TYPE');
  const ticket = s('ticket');
  if (ticket.length < 20 || ticket.length > 4096 || !JWT_SHAPE.test(ticket)) throw new CommandRejected('BAD_TICKET');
  const exp = s('expiresAt');
  if (!exp || Number.isNaN(new Date(exp).getTime())) throw new CommandRejected('BAD_EXPIRY');
  const tagNumber = r.tagNumber;
  if (tagNumber !== undefined && (typeof tagNumber !== 'string' || tagNumber.length > 64)) throw new CommandRejected('BAD_TAG_NUMBER');
  return {
    commandId: s('commandId'), correlationId: s('correlationId'), stationId: s('stationId'), imageType: s('imageType') as ImageType,
    ticket, expiresAt: exp, ...(tagNumber ? { tagNumber: tagNumber as string } : {}),
  };
}

/** Reads (does NOT verify — only the ERP holds the signing key) the ticket's own claims, as a sanity check that the
 *  command is addressed to this station. */
export function peekTicket(ticket: string): { sid?: string; exp?: number } {
  try {
    const p = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString('utf8')) as { sid?: unknown; exp?: unknown };
    return { sid: typeof p.sid === 'string' ? p.sid : undefined, exp: typeof p.exp === 'number' ? p.exp : undefined };
  } catch { return {}; }
}
