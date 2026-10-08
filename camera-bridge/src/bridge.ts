import { CameraController } from './camera/CameraController';
import { CameraHub } from './camera/CameraHub';
import { CAMERA_ID } from './camera/discovery';
import { CameraProvider } from './camera/types';
import { CaptureExecutor } from './capture/captureExecutor';
import { CaptureTransport } from './capture/captureTransport';
import { CommandPoller } from './capture/commandPoller';
import { TempStore } from './capture/tempStore';
import { BridgeConfig, defaultCaptureConfig } from './config';
import { CredentialStore } from './credentials';
import { ErpTransport } from './erpTransport';
import { HeartbeatScheduler, HeartbeatState } from './heartbeat';
import { LocalApi } from './localApi';
import { Logger } from './logger';
import { BRIDGE_VERSION } from './version';

export interface BridgeDeps {
  config: BridgeConfig;
  provider: CameraProvider;
  credentials: CredentialStore;
  transport: ErpTransport;
  /** Remote capture channel (poll / report / upload). Omitted = the bridge does heartbeat only. */
  captureTransport?: CaptureTransport;
  log: Logger;
  /** Overrides config.heartbeat timings in tests. */
  heartbeat?: { baseBackoffMs?: number; maxBackoffMs?: number; random?: () => number };
}

export type ErpConnectivity = 'REACHABLE' | 'UNREACHABLE' | 'CREDENTIAL_REJECTED' | 'CONFIG_REJECTED' | 'NOT_CONFIGURED' | 'UNKNOWN';

const CONNECTIVITY: Record<HeartbeatState, ErpConnectivity> = {
  OK: 'REACHABLE', RETRYING: 'UNREACHABLE', AUTH_FAILED: 'CREDENTIAL_REJECTED', CONFIG_REJECTED: 'CONFIG_REJECTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED', NOT_STARTED: 'UNKNOWN', BACKEND_UNAVAILABLE: 'UNKNOWN',
};

/** Resolves true if `p` settled within `ms`, false if the wait ran out first. Never rejects. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref?.();
    p.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(true); });
  });
}

/**
 * Wires camera + station identity + heartbeat + local API and owns their lifecycle. "Bridge running", "station
 * configured", "camera connected" and "heartbeat reaching TRIVO" are four separate facts and are reported separately.
 */
export class Bridge {
  readonly camera: CameraController;
  readonly heartbeat: HeartbeatScheduler;
  readonly executor: CaptureExecutor | null = null;
  readonly commands: CommandPoller | null = null;
  private readonly temp: TempStore | null = null;
  private readonly shutdownTimeoutMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly api: LocalApi;
  private startedAt: string | null = null;
  private phase: 'STOPPED' | 'RUNNING' | 'STOPPING' = 'STOPPED';
  private stopPromise: Promise<void> | null = null;
  private credentialPresent = false;
  private port = 0;

  constructor(private readonly d: BridgeDeps) {
    this.camera = new CameraController(d.provider, d.log);
    const hub = d.provider instanceof CameraHub ? d.provider : null;
    this.heartbeat = new HeartbeatScheduler(
      {
        stationId: d.config.stationId, bridgeVersion: BRIDGE_VERSION, intervalMs: d.config.heartbeatIntervalMs, ...d.heartbeat,
        ...(hub ? { getCameras: () => hub.listCameras(), onCameraSelection: (id: string) => this.applyRequestedCamera(hub, id) } : {}),
      },
      this.camera, d.credentials, d.transport, d.log,
    );
    const c = { ...defaultCaptureConfig(), ...d.config.capture };
    this.shutdownTimeoutMs = c.shutdownTimeoutMs;
    if (d.captureTransport) {
      this.temp = new TempStore(c.tempDir, c.tempRetentionMs, d.log, Date.now, c.tempMaxBytes);
      this.executor = new CaptureExecutor(
        {
          stationId: d.config.stationId, captureTimeoutMs: c.captureTimeoutMs, uploadTimeoutMs: c.uploadTimeoutMs,
          uploadMaxAttempts: c.uploadMaxAttempts, uploadBackoffMs: c.uploadBackoffMs, cameraLabel: d.config.cameraProvider,
        },
        this.camera, d.credentials, d.captureTransport, this.temp, d.log,
      );
      this.commands = new CommandPoller({
        waitSeconds: c.commandWaitSeconds, ...d.heartbeat,
        ...(hub ? { onCameraSelection: (id: string) => this.applyRequestedCamera(hub, id) } : {}),
      }, this.executor, d.credentials, d.captureTransport, d.log);
    }
    this.api = new LocalApi({
      getBridgeStatus: () => this.getStatus(), getCameraStatus: () => this.getCameraStatus(),
      ...(hub ? { cameras: { list: () => hub.listCameras(), select: (id: string | null) => hub.select(id) } } : {}),
    }, d.log);
  }

  private applyingCamera = false;
  /**
   * A camera an ERP user asked for. The ERP only ever relays an id this bridge itself reported, but the bridge does not rely on
   * that: it re-validates the id, selects through the same CameraHub.select() the local API uses (which refuses an unknown or
   * unavailable camera and a selection during a capture), and never switches to anything else. Idempotent: re-delivery of an
   * already-applied request costs a listing, not a reconnect.
   */
  private async applyRequestedCamera(hub: CameraHub, id: string): Promise<void> {
    if (this.applyingCamera || this.phase !== 'RUNNING' || typeof id !== 'string' || !CAMERA_ID.test(id)) return;
    this.applyingCamera = true;
    try {
      if ((await hub.listCameras()).selectedId !== id) {
        await hub.select(id);
        this.d.log.info('camera.selection_applied', { source: 'erp' });
      }
    } catch {
      this.d.log.warn('camera.selection_refused', { source: 'erp' });
    } finally {
      this.applyingCamera = false;
    }
    this.heartbeat.reportSoon(); // the ERP learns the outcome (applied or not) from the next report
  }

  /** Resolves with the bound local-API port. */
  async start(): Promise<number> {
    const { config, log } = this.d;
    this.startedAt = new Date().toISOString();
    this.phase = 'RUNNING';
    log.info('bridge.starting', { stationId: config.stationId, version: BRIDGE_VERSION, store: this.d.credentials.kind, provider: config.cameraProvider });
    try { this.credentialPresent = !!(await this.d.credentials.load()); } catch { this.credentialPresent = false; }
    if (this.credentialPresent) log.info('station.credential_present');
    else log.warn('station.credential_missing', { action: 'run "provision" (or "set-credential") with a freshly issued station credential; heartbeat is idle until then' });
    this.port = await this.api.listen(config.port);
    await this.camera.connect(); // a failed connect is reported via status; it must not stop the bridge
    this.heartbeat.start();
    if (this.temp && this.commands) {
      await this.temp.sweep().catch(() => 0); // images a previous run left behind: expired ones go now
      this.sweepTimer = setInterval(() => void this.temp?.sweep().catch(() => 0), 5 * 60 * 1000);
      this.sweepTimer.unref?.();
      this.commands.start();
    }
    log.info('bridge.started', { port: this.port });
    return this.port;
  }

  /**
   * Orderly, bounded shutdown. Order matters for the "never two physical captures" rule:
   *   1. stop taking work (heartbeat, command poll — the long poll is aborted, a command already received is refused);
   *   2. let the command in flight finish its CURRENT step, for at most `shutdownTimeoutMs`;
   *   3. only then release the camera and the local API.
   * A command abandoned at the deadline is never retried by this bridge: the ERP only re-delivers a command it still holds
   * QUEUED (i.e. one that was never acknowledged, so never captured); an ACCEPTED/CAPTURING one just expires there.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    const { log } = this.d;
    this.phase = 'STOPPING';
    const inFlight = this.executor?.getCurrent() ?? null;
    log.info('bridge.stopping', { inFlight: inFlight ? { commandId: inFlight.commandId, phase: inFlight.phase } : null });
    this.heartbeat.stop();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.executor?.beginShutdown();
    const drained = await settledWithin(this.commands?.stop() ?? Promise.resolve(), this.shutdownTimeoutMs);
    if (!drained) {
      const stuck = this.executor?.getCurrent() ?? null;
      log.warn('bridge.shutdown_timeout', { timeoutMs: this.shutdownTimeoutMs, abandoned: stuck ? { commandId: stuck.commandId, phase: stuck.phase } : null });
    }
    try { await this.camera.disconnect(); } catch { log.warn('camera.disconnect_failed'); }
    await this.api.close();
    await this.temp?.sweep().catch(() => 0); // anything past its retention goes now rather than at the next start
    this.phase = 'STOPPED';
    log.info('bridge.stopped', { clean: drained });
  }

  private async getCameraStatus() {
    return { ...(await this.camera.getStatus()), provider: this.d.config.cameraProvider };
  }

  async getStatus() {
    const hb = this.heartbeat.getStatus();
    const stationStatus = hb.state === 'AUTH_FAILED' ? 'CREDENTIAL_REJECTED'
      : hb.state === 'CONFIG_REJECTED' ? 'CONFIG_REJECTED'
      : this.credentialPresent && hb.state !== 'NOT_CONFIGURED' ? 'CONFIGURED' : 'NOT_CONFIGURED';
    const capture = this.commands ? this.commands.getStatus() : null;
    // The command channel is authorized separately from the heartbeat: a credential issued before capture existed
    // heartbeats fine and is refused here. Surfacing it is what tells an operator "re-issue the credential".
    const captureScope = !capture ? 'DISABLED' : capture.state === 'AUTH_FAILED' ? 'REJECTED' : capture.state === 'POLLING' || capture.state === 'BUSY' ? 'OK' : 'UNKNOWN';
    const failedCommand = capture?.lastResult && capture.lastResult.code !== 'SUCCESS' ? { at: capture.lastCommandAt, category: capture.lastResult.code } : null;
    const hbFailure = hb.lastFailureKind ? { at: hb.lastFailureAt, category: `HEARTBEAT_${hb.lastFailureKind}` } : null;
    const lastError = [failedCommand, hbFailure].filter((e): e is { at: string | null; category: string } => !!e)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
    return {
      bridge: { status: this.phase, version: BRIDGE_VERSION, startedAt: this.startedAt, mode: this.d.config.production ? 'production' : 'development' },
      station: { id: this.d.config.stationId, status: stationStatus, captureScope },
      erp: { connectivity: CONNECTIVITY[hb.state], lastHeartbeatSuccessAt: hb.lastSuccessAt },
      camera: await this.getCameraStatus(),
      heartbeat: hb,
      capture: capture ? { ...capture, current: this.executor?.getCurrent() ?? null } : { state: 'DISABLED' },
      lastError,
    };
  }
}
