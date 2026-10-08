import { CameraSource, DiscoveredCamera } from '../discovery';
import { CameraProvider } from '../types';
import { UnavailableWebcamBackend, WebcamBackend, WebcamBackendError } from './WebcamBackend';
import { WebcamCameraProvider } from './WebcamCameraProvider';

export interface WebcamSourceOptions {
  /** Builds a NEW backend (one helper process each). Returns undefined when no helper is installed. */
  makeBackend: () => WebcamBackend | undefined;
}

/**
 * The Windows webcam family (laptop camera, USB webcams, virtual cameras). Discovery uses a short-lived helper of its own, so
 * listing never disturbs — and is never blocked by — the helper that owns a capture session.
 */
export class WebcamSource implements CameraSource {
  readonly kind = 'webcam' as const;
  constructor(private readonly o: WebcamSourceOptions) {}

  async discover(): Promise<DiscoveredCamera[]> {
    const backend = this.o.makeBackend();
    const unavailable: DiscoveredCamera[] = [{ localId: 'unavailable', displayName: 'Windows camera', available: false, unavailableReason: 'DRIVER_UNAVAILABLE' }];
    if (!backend) return unavailable;
    try {
      const devices = await backend.listDevices();
      return devices.map((d) => ({
        localId: d.id, displayName: d.model, available: true,
        ...(d.placement ? { placement: d.placement } : {}),
        capabilities: { stillCapture: true, format: 'jpeg' as const },
      }));
    } catch (e) {
      return e instanceof WebcamBackendError && e.failure === 'DRIVER_UNAVAILABLE' ? unavailable : [];
    } finally {
      await backend.close().catch(() => undefined);
    }
  }

  open(localId: string): CameraProvider {
    return new WebcamCameraProvider({ backend: this.o.makeBackend() ?? new UnavailableWebcamBackend(), deviceId: localId });
  }
}
