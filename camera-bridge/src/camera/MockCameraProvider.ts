import { createHash } from 'crypto';
import { encodePng } from './png';
import { CameraError, CameraProvider, CameraStatus, CapturedImage, CaptureRequest } from './types';

export interface MockCameraOptions {
  width?: number;
  height?: number;
  /** Artificial delays, for exercising the CONNECTING / CAPTURING states. */
  connectDelayMs?: number;
  captureDelayMs?: number;
  now?: () => Date;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Fully local test camera: no hardware, no network. Output is deterministic per correlationId. */
export class MockCameraProvider implements CameraProvider {
  private state: CameraStatus = { state: 'DISCONNECTED' };
  private failNextConnect = false;
  private failNextCapture = false;
  private readonly width: number;
  private readonly height: number;
  private readonly now: () => Date;

  constructor(private readonly opts: MockCameraOptions = {}) {
    this.width = opts.width ?? 64;
    this.height = opts.height ?? 48;
    this.now = opts.now ?? (() => new Date());
  }

  /** Test hooks (not part of CameraProvider). */
  injectConnectFailure(): void { this.failNextConnect = true; }
  injectCaptureFailure(): void { this.failNextCapture = true; }

  async getStatus(): Promise<CameraStatus> {
    return { ...this.state };
  }

  async connect(): Promise<void> {
    if (this.state.state === 'CONNECTED' || this.state.state === 'CAPTURING') return;
    this.state = { state: 'CONNECTING' };
    await sleep(this.opts.connectDelayMs ?? 0);
    if (this.failNextConnect) {
      this.failNextConnect = false;
      this.state = { state: 'ERROR', errorCode: 'CONNECT_FAILED', errorMessage: 'Mock camera failed to connect' };
      throw new CameraError('CONNECT_FAILED', 'Mock camera failed to connect');
    }
    this.state = { state: 'CONNECTED' };
  }

  async disconnect(): Promise<void> {
    this.state = { state: 'DISCONNECTED' };
  }

  async capture(request: CaptureRequest): Promise<CapturedImage> {
    if (this.state.state === 'CAPTURING') throw new CameraError('BUSY', 'Camera is already capturing');
    if (this.state.state !== 'CONNECTED') throw new CameraError('NOT_CONNECTED', 'Camera is not connected');
    this.state = { state: 'CAPTURING' };
    try {
      await sleep(this.opts.captureDelayMs ?? 0);
      if (this.failNextCapture) {
        this.failNextCapture = false;
        throw new CameraError('CAPTURE_FAILED', 'Mock camera capture failed');
      }
      // Deterministic gradient seeded from the correlation id — same id, same bytes.
      const seed = createHash('sha256').update(request.correlationId).digest();
      const data = encodePng(this.width, this.height, (x, y) => [
        (x * 255 / this.width + seed[0]) & 0xff,
        (y * 255 / this.height + seed[1]) & 0xff,
        seed[2],
      ]);
      const capturedAt = this.now();
      this.state = { state: 'CONNECTED' };
      return {
        data, mimeType: 'image/png', width: this.width, height: this.height, capturedAt,
        filename: `mock-${capturedAt.getTime()}-${seed.subarray(0, 4).toString('hex')}.png`,
      };
    } catch (e) {
      const err = e instanceof CameraError ? e : new CameraError('CAPTURE_FAILED', 'Capture failed');
      // Surfaced as ERROR so a failed shot is visible; connect() recovers it.
      this.state = { state: 'ERROR', errorCode: err.code, errorMessage: err.message };
      throw err;
    }
  }
}
