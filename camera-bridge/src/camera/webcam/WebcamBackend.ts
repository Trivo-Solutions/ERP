// Webcam-internal boundary. Nothing outside src/camera/webcam may import this file.
//
// Windows exposes cameras through Media Foundation, a native API Node cannot call, so the real backend (HelperWebcamBackend)
// talks to a small native helper process (docs/WEBCAM_HELPER_PROTOCOL.md). This interface is what WebcamCameraProvider needs
// from ANY backend — the real one or a test fake.

/** Helper-level failure reasons; WebcamCameraProvider normalizes them to CameraError codes. Never leaves this folder. */
export const WEBCAM_FAILURES = [
  'DRIVER_UNAVAILABLE', 'NO_CAMERA_FOUND', 'MULTIPLE_CAMERAS', 'CONNECT_REJECTED', 'CAMERA_BUSY', 'DEVICE_LOST',
  'SHUTTER_FAILED', 'TRANSFER_FAILED', 'TIMEOUT', 'PROTOCOL_ERROR',
] as const;
export type WebcamFailure = (typeof WEBCAM_FAILURES)[number];

export class WebcamBackendError extends Error {
  constructor(public readonly failure: WebcamFailure, message: string = failure) {
    super(message);
    this.name = 'WebcamBackendError';
  }
}

export interface WebcamDevice {
  /** Stable identifier derived from the OS device identity (not an array position). */
  id: string;
  /** Sanitized display name, safe to show. */
  model: string;
  connection: 'usb' | 'network' | 'local';
  /** Only set when the camera's own name says it is part of the machine; never guessed otherwise. */
  placement?: 'integrated';
}

export interface WebcamShot {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface WebcamBackend {
  /** Initialise the helper and enumerate cameras. Throws DRIVER_UNAVAILABLE when the helper cannot run. */
  listDevices(): Promise<WebcamDevice[]>;
  /** Bind the session to exactly this device. */
  connect(deviceId: string): Promise<void>;
  /** Release the session. Idempotent. Also abandons any capture in flight. */
  close(): Promise<void>;
  /** Grab ONE frame and return it as a JPEG. Never retries. Rejects TIMEOUT after `timeoutMs`. */
  shootAndFetch(opts?: { timeoutMs?: number }): Promise<WebcamShot>;
  /** Called (at most once per session) when the camera or helper disappears without being asked to. */
  onDisconnected?(cb: () => void): void;
}

/** Used when no helper is installed at all. */
export class UnavailableWebcamBackend implements WebcamBackend {
  async listDevices(): Promise<WebcamDevice[]> { throw new WebcamBackendError('DRIVER_UNAVAILABLE'); }
  async connect(): Promise<void> { throw new WebcamBackendError('DRIVER_UNAVAILABLE'); }
  async close(): Promise<void> {}
  async shootAndFetch(): Promise<WebcamShot> { throw new WebcamBackendError('DRIVER_UNAVAILABLE'); }
}
