import http from 'http';
import https from 'https';
import { CameraState } from './camera/types';
import type { CameraListing } from './camera/discovery';

export interface HeartbeatPayload {
  stationId: string;
  bridgeVersion: string;
  cameraState: CameraState;
  /** ISO timestamp. */
  timestamp: string;
  /** What discovery found and which camera is selected; omitted when the provider cannot list cameras. */
  cameras?: CameraListing;
}

export type TransportResult =
  /** `cameraSelection`: a camera id an ERP user asked this station to use (the bridge validates it before acting on it). */
  | { ok: true; cameraSelection?: string }
  | { ok: false; kind: TransportFailureKind };

/** AUTH = credential/station refused (401/403, never retried). REJECTED = request refused as invalid (400, incl. a
 *  stationId echo that does not match the credential's station): a configuration fault, never retried.
 *  NETWORK/SERVER = transient, retried with backoff. */
export type TransportFailureKind = 'AUTH' | 'REJECTED' | 'NETWORK' | 'SERVER' | 'UNAVAILABLE';

/**
 * The bridge -> TRIVO channel. Phase 5A defines the boundary only: TRIVO has no endpoint that authenticates a
 * StationCredential or accepts a heartbeat yet (see README "Backend gaps"), so no HTTP implementation exists â€”
 * the bridge must not call an invented API. A real transport is a Phase 5B+ addition once that contract exists.
 */
export interface ErpTransport {
  sendHeartbeat(payload: HeartbeatPayload, stationSecret: string): Promise<TransportResult>;
}

/** Sends nothing and reports UNAVAILABLE. Kept for tests / explicit opt-out. */
export class UnavailableTransport implements ErpTransport {
  async sendHeartbeat(): Promise<TransportResult> {
    return { ok: false, kind: 'UNAVAILABLE' };
  }
}

export const HEARTBEAT_PATH = '/api/v1/photography/stations/heartbeat';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Maps an HTTP status to the bridge's transport model. Pure, so it is unit-tested directly. */
export function classifyStatus(status: number): TransportResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, kind: 'AUTH' };
  if (status === 408 || status === 429 || status >= 500) return { ok: false, kind: 'SERVER' };
  return { ok: false, kind: 'REJECTED' }; // 400 / 404 / 409 / 3xx ...: retrying the same request cannot help
}

export interface HttpTransportOptions {
  apiUrl: string;
  timeoutMs?: number;
}

/**
 * Real transport: POST {apiUrl}/api/v1/photography/stations/heartbeat with `Authorization: Bearer <station
 * credential>`. TLS verification is Node's default and is never overridden; redirects are never followed (the
 * credential must not be re-sent to a host the operator did not configure). The credential is only ever placed in
 * the Authorization header — never the URL, body, logs or thrown errors.
 */
export class HttpErpTransport implements ErpTransport {
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(opts: HttpTransportOptions) {
    const base = new URL(opts.apiUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOCAL_HOSTS.has(base.hostname))) {
      throw new Error('ERP transport requires https (http is allowed only for localhost development)');
    }
    if (base.username || base.password || base.search || base.hash) throw new Error('ERP transport URL must not carry credentials or a query string');
    this.url = new URL(base.pathname.replace(/\/+$/, '') + HEARTBEAT_PATH, base);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  sendHeartbeat(payload: HeartbeatPayload, stationSecret: string): Promise<TransportResult> {
    // Adapt the bridge's internal names to the backend contract; the backend contract is not changed for this.
    const body = JSON.stringify({
      stationId: payload.stationId, // an echo only — the credential identifies the station
      bridgeVersion: payload.bridgeVersion,
      cameraStatus: payload.cameraState,
      clientTimestamp: payload.timestamp,
      // Only the fields the ERP stores: no paths, no driver detail, nothing the camera layer did not already expose locally.
      ...(payload.cameras ? { cameras: {
        cameras: payload.cameras.cameras.map((c) => ({
          id: c.id, displayName: c.displayName, available: c.available, selected: c.selected,
          ...(c.unavailableReason ? { unavailableReason: c.unavailableReason } : {}), ...(c.placement ? { placement: c.placement } : {}),
        })),
        selectedId: payload.cameras.selectedId, selectionRequired: payload.cameras.selectionRequired,
      } } : {}),
    });
    const lib = this.url.protocol === 'https:' ? https : http;
    return new Promise<TransportResult>((resolve) => {
      let settled = false;
      const done = (r: TransportResult) => { if (!settled) { settled = true; resolve(r); } };
      const req = lib.request(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${stationSecret}`,
          Accept: 'application/json',
        },
        timeout: this.timeoutMs,
      }, (res) => {
        // The body is read only for one allow-listed field (a requested camera id), capped, and never logged.
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size <= 16 * 1024) chunks.push(c); });
        res.on('end', () => {
          const r = classifyStatus(res.statusCode ?? 0);
          if (!r.ok) return done(r);
          let sel: unknown = null;
          try { sel = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.cameraSelection?.cameraId; } catch { /* no body: nothing requested */ }
          done({ ok: true, ...(typeof sel === 'string' ? { cameraSelection: sel } : {}) });
        });
        res.on('error', () => done({ ok: false, kind: 'NETWORK' }));
      });
      // Errors are swallowed into a kind: the Error object (TLS/DNS details) never leaves this method.
      req.on('timeout', () => { req.destroy(); done({ ok: false, kind: 'NETWORK' }); });
      req.on('error', () => done({ ok: false, kind: 'NETWORK' }));
      req.end(body);
    });
  }
}
