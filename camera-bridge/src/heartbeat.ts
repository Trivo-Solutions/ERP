import { CameraController } from './camera/CameraController';
import { CredentialStore } from './credentials';
import { ErpTransport, TransportFailureKind } from './erpTransport';
import type { CameraListing } from './camera/discovery';
import { Logger } from './logger';

export type HeartbeatState =
  | 'NOT_STARTED'
  | 'OK'
  | 'RETRYING'          // transient failure; backing off
  | 'NOT_CONFIGURED'    // no station credential stored
  | 'AUTH_FAILED'       // credential rejected; stopped until restart/credential fix
  | 'CONFIG_REJECTED'   // request refused as invalid (e.g. STATION_ID does not match the credential); stopped
  | 'BACKEND_UNAVAILABLE'; // transport reports no endpoint; stopped

export interface HeartbeatStatus {
  state: HeartbeatState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** Normalized category of the most recent failure (AUTH | REJECTED | NETWORK | SERVER | UNAVAILABLE). */
  lastFailureKind: TransportFailureKind | null;
  lastFailureAt: string | null;
}

export interface HeartbeatOptions {
  stationId: string;
  bridgeVersion: string;
  intervalMs: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Current camera discovery result to report to the ERP; null/throw = report nothing this time (a heartbeat never fails over it). */
  getCameras?: () => Promise<CameraListing | null>;
  /** A camera id an ERP user asked for, handed back by the ERP. The handler validates it; a failure is its own to handle. */
  onCameraSelection?: (cameraId: string) => Promise<void>;
  /** Returns 0..1; injectable for deterministic tests. */
  random?: () => number;
}

/** Bounded exponential backoff with +/-20% jitter: base * 2^(failures-1), capped. */
export function backoffDelay(failures: number, base: number, max: number, random: () => number): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.round(raw * (0.8 + 0.4 * random()));
}

export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private status: HeartbeatStatus = { state: 'NOT_STARTED', lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailureKind: null, lastFailureAt: null };
  private readonly base: number;
  private readonly max: number;
  private readonly random: () => number;

  constructor(
    private readonly opts: HeartbeatOptions,
    private readonly camera: CameraController,
    private readonly credentials: CredentialStore,
    private readonly transport: ErpTransport,
    private readonly log: Logger,
  ) {
    this.base = opts.baseBackoffMs ?? 5_000;
    this.max = opts.maxBackoffMs ?? 300_000;
    this.random = opts.random ?? Math.random;
  }

  getStatus(): HeartbeatStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  /** Report again shortly (e.g. right after a camera selection was applied) instead of waiting out the interval. */
  reportSoon(ms = 300): void {
    this.schedule(ms);
  }

  /** One heartbeat attempt. Exposed for tests; never throws. */
  async tick(): Promise<void> {
    if (!this.running) return;
    this.status.lastAttemptAt = new Date().toISOString();
    try {
      const secret = await this.credentials.load();
      if (!secret) {
        this.status.state = 'NOT_CONFIGURED';
        this.log.warn('heartbeat.not_configured');
        this.schedule(this.opts.intervalMs); // the operator may store a credential later; re-check at the normal cadence
        return;
      }
      const cam = await this.camera.getStatus();
      const cameras = await this.opts.getCameras?.().catch(() => null);
      const result = await this.transport.sendHeartbeat(
        { stationId: this.opts.stationId, bridgeVersion: this.opts.bridgeVersion, cameraState: cam.state, timestamp: new Date().toISOString(), ...(cameras ? { cameras } : {}) },
        secret,
      );
      if (result.ok) {
        const recovered = this.status.state !== 'OK';
        this.status = { ...this.status, state: 'OK', lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 };
        if (recovered) this.log.info('erp.connectivity', { state: 'REACHABLE' });
        this.log.info('heartbeat.ok');
        let applied = false;
        if (result.cameraSelection && this.opts.onCameraSelection) {
          await this.opts.onCameraSelection(result.cameraSelection).then(() => { applied = true; }, () => undefined);
        }
        this.schedule(applied ? 1_000 : this.opts.intervalMs); // an applied selection is reported back promptly
        return;
      }
      this.handleFailure(result.kind);
    } catch {
      // Credential-store or unexpected error: treat as transient; never log the error body (it could echo input).
      this.handleFailure('NETWORK');
    }
  }

  private handleFailure(kind: TransportFailureKind): void {
    const wasOk = this.status.state === 'OK';
    this.status.consecutiveFailures += 1;
    this.status.lastFailureKind = kind;
    this.status.lastFailureAt = new Date().toISOString();
    if (wasOk) this.log.warn('erp.connectivity', { state: kind === 'NETWORK' || kind === 'SERVER' ? 'UNREACHABLE' : 'REFUSED', kind });
    if (kind === 'AUTH') {
      this.status.state = 'AUTH_FAILED';
      this.log.error('heartbeat.auth_failed', { action: 'stopped; correct the station credential and restart the bridge' });
      this.running = false; // never retry bad credentials
      return;
    }
    if (kind === 'REJECTED') {
      this.status.state = 'CONFIG_REJECTED';
      this.log.error('heartbeat.config_rejected', { action: 'stopped; check STATION_ID and TRIVO_API_URL, then restart the bridge' });
      this.running = false;
      return;
    }
    if (kind === 'UNAVAILABLE') {
      this.status.state = 'BACKEND_UNAVAILABLE';
      this.log.warn('heartbeat.backend_unavailable', { action: 'stopped; TRIVO exposes no station heartbeat endpoint yet' });
      this.running = false;
      return;
    }
    this.status.state = 'RETRYING';
    const delay = backoffDelay(this.status.consecutiveFailures, this.base, this.max, this.random);
    this.log.warn('heartbeat.failed', { kind, failures: this.status.consecutiveFailures, retryInMs: delay });
    this.schedule(delay);
  }
}
