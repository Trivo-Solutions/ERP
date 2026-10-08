import { CameraSource, DiscoveredCamera } from '../discovery';
import { CameraProvider } from '../types';
import { SonyBackend, SonyBackendError, UnavailableSonyBackend } from './SonyBackend';
import { SonyCameraProvider } from './SonyCameraProvider';

export interface SonySourceOptions {
  /** Builds a NEW backend (one helper process each). Returns undefined when no helper is installed. */
  makeBackend: () => SonyBackend | undefined;
  /** Validated CAMERA_OPT_* values forwarded to the provider (MODEL / CONNECTION; DEVICE_ID is set per camera). */
  settings?: Record<string, string>;
}

/**
 * Sony cameras as one source among several. This file only ADAPTS the existing Sony provider to discovery — the provider,
 * backend and helper are unchanged. Without the SDK the helper answers DRIVER_UNAVAILABLE and this source reports a single
 * *unavailable* Sony entry; it never pretends a camera exists.
 */
export class SonySource implements CameraSource {
  readonly kind = 'sony' as const;
  readonly exclusive = true; // a second helper listing while a session is open would contend for the same USB device
  constructor(private readonly o: SonySourceOptions) {}

  async discover(): Promise<DiscoveredCamera[]> {
    const unavailable: DiscoveredCamera[] = [{ localId: 'unavailable', displayName: 'Sony camera', available: false, unavailableReason: 'DRIVER_UNAVAILABLE' }];
    const backend = this.o.makeBackend();
    if (!backend) return unavailable;
    try {
      const devices = await backend.listDevices();
      return devices.map((d) => ({
        localId: d.id, displayName: d.model, available: true, capabilities: { stillCapture: true, format: 'jpeg' as const },
      }));
    } catch (e) {
      return e instanceof SonyBackendError && e.failure === 'DRIVER_UNAVAILABLE' ? unavailable : [];
    } finally {
      await backend.close().catch(() => undefined);
    }
  }

  open(localId: string): CameraProvider {
    return new SonyCameraProvider({ backend: this.o.makeBackend() ?? new UnavailableSonyBackend(), settings: { ...this.o.settings, DEVICE_ID: localId } });
  }
}
