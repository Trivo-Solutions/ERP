import { CameraSource, DiscoveredCamera } from './discovery';
import { MockCameraProvider, MockCameraOptions } from './MockCameraProvider';
import { CameraProvider } from './types';

/** Test/dev source: one always-available synthetic camera. */
export class MockCameraSource implements CameraSource {
  readonly kind = 'mock' as const;
  constructor(private readonly opts: MockCameraOptions = {}) {}
  async discover(): Promise<DiscoveredCamera[]> {
    return [{ localId: 'default', displayName: 'Mock camera', available: true, capabilities: { stillCapture: true, format: 'png' } }];
  }
  open(): CameraProvider { return new MockCameraProvider(this.opts); }
}
