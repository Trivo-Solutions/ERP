import { CameraError, CameraErrorCode, CameraProvider, CameraStatus, CapturedImage, CaptureRequest } from '../types';
import { WebcamBackend, WebcamBackendError, WebcamFailure, WebcamShot, UnavailableWebcamBackend } from './WebcamBackend';

type Ctx = 'CONNECT' | 'CAPTURE';

// Helper failure -> neutral code + a safe message. Windows/driver text never reaches the bridge core or the ERP.
const MAP: Record<WebcamFailure, { code: CameraErrorCode; message: string }> = {
  DRIVER_UNAVAILABLE: { code: 'DRIVER_UNAVAILABLE', message: 'Camera support is not installed on this station' },
  NO_CAMERA_FOUND: { code: 'NOT_CONNECTED', message: 'Camera is not connected' },
  MULTIPLE_CAMERAS: { code: 'CONFIG_ERROR', message: 'More than one camera is connected; select a camera' },
  CONNECT_REJECTED: { code: 'CONNECT_FAILED', message: 'Camera access was refused (check Windows camera privacy settings)' },
  CAMERA_BUSY: { code: 'BUSY', message: 'Camera is busy' },
  DEVICE_LOST: { code: 'NOT_CONNECTED', message: 'Camera disconnected' },
  SHUTTER_FAILED: { code: 'CAPTURE_FAILED', message: 'Capture failed' },
  TRANSFER_FAILED: { code: 'CAPTURE_FAILED', message: 'Image capture failed' },
  TIMEOUT: { code: 'CAPTURE_TIMEOUT', message: 'Camera did not respond in time' },
  PROTOCOL_ERROR: { code: 'CAPTURE_FAILED', message: 'Camera driver returned an invalid response' }, // refined per context below
};

function normalize(e: unknown, ctx: Ctx): CameraError {
  if (e instanceof CameraError) return e;
  if (e instanceof WebcamBackendError) {
    const m = MAP[e.failure];
    if (e.failure === 'PROTOCOL_ERROR' && ctx === 'CONNECT') return new CameraError('CONNECT_FAILED', m.message);
    return new CameraError(m.code, m.message);
  }
  return ctx === 'CONNECT' ? new CameraError('CONNECT_FAILED', 'Camera connection failed') : new CameraError('CAPTURE_FAILED', 'Capture failed');
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT_GRACE_MS = 1_000; // the backend enforces timeoutMs itself; this is only a net under a hung backend

export interface WebcamOptions {
  backend?: WebcamBackend;
  /** Stable id (from discovery) of the ONE camera this provider is bound to. Selection is the caller's job — never an index here. */
  deviceId: string;
  now?: () => Date;
}

/**
 * Windows-webcam implementation of the neutral CameraProvider, bound to a single camera chosen by stable id. Everything
 * Windows-specific stays behind `backend`; this class owns only lifecycle, error normalization and the one-capture rule:
 * a capture is NEVER retried here — a timeout or failure surfaces as an error and the next capture is a new request.
 * If the camera is gone, connect() fails with NOT_CONNECTED and nothing is captured; it never falls back to another camera.
 */
export class WebcamCameraProvider implements CameraProvider {
  private state: CameraStatus = { state: 'DISCONNECTED' };
  private readonly backend: WebcamBackend;
  private readonly now: () => Date;
  private connecting: Promise<void> | null = null;

  constructor(private readonly opts: WebcamOptions) {
    this.backend = opts.backend ?? new UnavailableWebcamBackend();
    this.now = opts.now ?? (() => new Date());
    this.backend.onDisconnected?.(() => {
      if (this.state.state === 'CONNECTED') this.state = { state: 'ERROR', errorCode: 'NOT_CONNECTED', errorMessage: 'Camera disconnected' };
    });
  }

  async getStatus(): Promise<CameraStatus> { return { ...this.state }; }

  connect(): Promise<void> {
    if (this.state.state === 'CONNECTED' || this.state.state === 'CAPTURING') return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const recovering = this.state.state === 'ERROR';
    this.state = { state: 'CONNECTING' };
    try {
      if (recovering) await this.backend.close().catch(() => undefined); // start from a clean helper
      const devices = await this.backend.listDevices();
      if (!devices.some((d) => d.id === this.opts.deviceId)) throw new WebcamBackendError('NO_CAMERA_FOUND');
      await this.backend.connect(this.opts.deviceId);
      this.state = { state: 'CONNECTED' };
    } catch (e) {
      const err = normalize(e, 'CONNECT');
      await this.backend.close().catch(() => undefined);
      this.state = { state: 'ERROR', errorCode: err.code, errorMessage: err.message };
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try { await this.backend.close(); } finally { this.state = { state: 'DISCONNECTED' }; }
  }

  async capture(request: CaptureRequest): Promise<CapturedImage> {
    if (this.state.state === 'CAPTURING') throw new CameraError('BUSY', 'Camera is already capturing');
    if (this.state.state === 'CONNECTING') throw new CameraError('NOT_CONNECTED', 'Camera is not connected');
    if (this.state.state !== 'CONNECTED') {
      // Self-heal after an unplug/helper restart. Reconnecting never takes a picture.
      await this.connect().catch(() => undefined);
      if ((this.state as CameraStatus).state !== 'CONNECTED') throw new CameraError('NOT_CONNECTED', 'Camera is not connected');
    }
    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.state = { state: 'CAPTURING' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const shot = await Promise.race([
        this.backend.shootAndFetch({ timeoutMs }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new WebcamBackendError('TIMEOUT')), timeoutMs + TIMEOUT_GRACE_MS); }),
      ]);
      this.assertShot(shot);
      const capturedAt = this.now();
      this.state = { state: 'CONNECTED' };
      return { ...shot, capturedAt, filename: `cam-${capturedAt.getTime()}.jpg` };
    } catch (e) {
      const err = normalize(e, 'CAPTURE');
      if (err.code === 'CAPTURE_TIMEOUT') void this.backend.close().catch(() => undefined); // abandon the operation; never re-fire
      if (err.code === 'BUSY') this.state = { state: 'CONNECTED' }; // the camera refused; nothing broke
      else this.state = { state: 'ERROR', errorCode: err.code, errorMessage: err.message };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The backend is a trust boundary: whatever it returns is checked before the bridge core sees it. */
  private assertShot(s: WebcamShot): void {
    const ok = s && Buffer.isBuffer(s.data) && s.data.length >= 4 && s.mimeType === 'image/jpeg'
      && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0
      && s.data[0] === 0xff && s.data[1] === 0xd8;
    if (!ok) throw new WebcamBackendError('PROTOCOL_ERROR');
  }
}
