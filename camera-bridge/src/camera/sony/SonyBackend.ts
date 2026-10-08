// Sony-internal boundary. Nothing outside src/camera/sony may import this file.
//
// Sony's supported remote-control route is the Camera Remote SDK (CrSDK): a native C++ library (Windows x64 DLLs)
// under Sony's click-through licence. Node cannot load it, so the real backend (HelperSonyBackend) talks to a small
// native helper process. This interface is what SonyCameraProvider needs from ANY backend — real or a test fake.

/** Vendor-level failure reasons; SonyCameraProvider normalizes them to CameraError codes. Never leaves this folder. */
export const SONY_FAILURES = [
  'DRIVER_UNAVAILABLE', 'NO_CAMERA_FOUND', 'MULTIPLE_CAMERAS', 'CONNECT_REJECTED', 'CAMERA_BUSY', 'DEVICE_LOST',
  'SHUTTER_FAILED', 'TRANSFER_FAILED', 'TIMEOUT', 'PROTOCOL_ERROR',
] as const;
export type SonyFailure = (typeof SONY_FAILURES)[number];

export class SonyBackendError extends Error {
  constructor(public readonly failure: SonyFailure, message: string = failure) {
    super(message);
    this.name = 'SonyBackendError';
  }
}

export interface SonyDevice {
  /** Stable identifier the camera reports about itself (not an array position). */
  id: string;
  model: string;
  connection: 'usb' | 'network';
}

export interface SonyShot {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface SonyBackend {
  /** Initialise the SDK/helper and enumerate attached cameras. Throws DRIVER_UNAVAILABLE when there is no SDK. */
  listDevices(): Promise<SonyDevice[]>;
  /** Open a session with exactly this device. */
  connect(deviceId: string): Promise<void>;
  /** Release the session and every native resource. Idempotent. Also abandons any shutter operation in flight. */
  close(): Promise<void>;
  /** Release the shutter ONCE and transfer the resulting still. Never retries. Rejects TIMEOUT after `timeoutMs`. */
  shootAndFetch(opts?: { timeoutMs?: number }): Promise<SonyShot>;
  /** Called (at most once per session) when the camera or helper disappears without being asked to. */
  onDisconnected?(cb: () => void): void;
}

/** Used when no helper is configured at all. */
export class UnavailableSonyBackend implements SonyBackend {
  async listDevices(): Promise<SonyDevice[]> { throw new SonyBackendError('DRIVER_UNAVAILABLE'); }
  async connect(): Promise<void> { throw new SonyBackendError('DRIVER_UNAVAILABLE'); }
  async close(): Promise<void> {}
  async shootAndFetch(): Promise<SonyShot> { throw new SonyBackendError('DRIVER_UNAVAILABLE'); }
}
