import { CameraError, CameraProvider, CameraStatus, CapturedImage, CaptureRequest } from './types';
import { Logger } from '../logger';

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The bridge's only handle on a camera: validates requests, serialises captures, logs without payloads. */
export class CameraController {
  private capturing = false;

  constructor(private readonly provider: CameraProvider, private readonly log: Logger) {}

  /** True while a capture is in flight (including one the caller already stopped waiting for). */
  isBusy(): boolean {
    return this.capturing;
  }

  getStatus(): Promise<CameraStatus> {
    return this.provider.getStatus();
  }

  async connect(): Promise<CameraStatus> {
    try {
      await this.provider.connect();
    } catch (e) {
      this.log.warn('camera.connect_failed', { code: e instanceof CameraError ? e.code : 'CONNECT_FAILED' });
    }
    const status = await this.provider.getStatus();
    this.log.info('camera.state', { state: status.state });
    return status;
  }

  async disconnect(): Promise<void> {
    await this.provider.disconnect();
    this.log.info('camera.state', { state: 'DISCONNECTED' });
  }

  async capture(request: CaptureRequest): Promise<CapturedImage> {
    if (!request || typeof request.correlationId !== 'string' || !CORRELATION_ID.test(request.correlationId)) {
      throw new CameraError('INVALID_REQUEST', 'correlationId must be 1-64 characters of [A-Za-z0-9._:-]');
    }
    for (const k of ['tagNumber', 'imageType'] as const) {
      const v = request[k];
      if (v !== undefined && (typeof v !== 'string' || v.length > 64)) throw new CameraError('INVALID_REQUEST', `${k} must be a string of at most 64 characters`);
    }
    if (this.capturing) throw new CameraError('BUSY', 'Camera is already capturing');
    this.capturing = true;
    this.log.info('capture.start', { correlationId: request.correlationId });
    try {
      const img = await this.provider.capture(request);
      this.log.info('capture.end', { correlationId: request.correlationId, width: img.width, height: img.height, bytes: img.data.length });
      return img;
    } catch (e) {
      this.log.warn('capture.failed', { correlationId: request.correlationId, code: e instanceof CameraError ? e.code : 'CAPTURE_FAILED' });
      throw e;
    } finally {
      this.capturing = false;
    }
  }
}
