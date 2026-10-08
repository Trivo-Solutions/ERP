import { CAMERA_ID, CameraInfo, CameraListing, CameraSource, DiscoveredCamera } from './discovery';
import { MemorySelectionStore, SelectionStore, StoredSelection } from './selectionStore';
import { Logger } from '../logger';
import { CameraError, CameraProvider, CameraStatus, CapturedImage, CaptureRequest } from './types';

interface Known extends DiscoveredCamera { id: string; source: CameraSource }

type Resolution =
  | { kind: 'TARGET'; cam: Known }
  | { kind: 'NONE' }
  | { kind: 'CHOOSE' }
  | { kind: 'LOST'; sel: StoredSelection };

const DISCOVERY_TIMEOUT_MS = 12_000;

/**
 * The discovery/selection layer around the neutral CameraProvider contract. It owns no camera code: it asks each registered
 * `CameraSource` what exists, decides which ONE camera captures will use, and delegates every CameraProvider call to a
 * provider bound to that camera.
 *
 * Selection rules:
 *   - an explicit choice (select()) always wins and is remembered across restarts;
 *   - with no choice, exactly one usable camera is used automatically;
 *   - with no choice and several usable cameras, NOTHING is picked — status says a selection is required and captures fail
 *     with CONFIG_ERROR until a person chooses (we never grab an arbitrary device);
 *   - with no usable camera the status is simply "disconnected" (not an error): manual file upload remains the workflow;
 *   - if the explicitly chosen camera disappears the bridge reports NOT_CONNECTED. It does NOT switch to another camera, and it
 *     never fires a shutter by itself — a person must choose again.
 */
export class CameraHub implements CameraProvider {
  private active: { id: string; provider: CameraProvider } | null = null;
  private known: Known[] = [];
  private explicit: StoredSelection | null;
  private idle: CameraStatus = { state: 'DISCONNECTED' };
  private discovering: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private capturing = false;
  private switching = false;

  constructor(
    private readonly sources: readonly CameraSource[],
    private readonly log: Logger,
    private readonly store: SelectionStore = new MemorySelectionStore(),
  ) {
    this.explicit = store.load();
  }

  // — discovery —

  /** Current cameras and which one is selected. Re-enumerates every call (cheap: no camera is opened or triggered). */
  async listCameras(): Promise<CameraListing> {
    await this.discover();
    return this.listing();
  }

  private discover(): Promise<void> {
    this.discovering ??= this.doDiscover().finally(() => { this.discovering = null; });
    return this.discovering;
  }

  private async doDiscover(): Promise<void> {
    const next: Known[] = [];
    await Promise.all(this.sources.map(async (src) => {
      let found: DiscoveredCamera[] | null = null;
      if (src.exclusive && this.active && this.known.some((k) => k.source === src && k.id === this.active?.id)) {
        // Listing would disturb the open session; keep the last answer for this source.
        next.push(...this.known.filter((k) => k.source === src));
        return;
      }
      try {
        found = await withTimeout(src.discover(), DISCOVERY_TIMEOUT_MS);
      } catch {
        this.log.warn('camera.discovery_failed', { kind: src.kind });
        found = null;
      }
      for (const c of found ?? []) next.push({ ...c, id: `${src.kind}:${c.localId}`, source: src });
    }));
    // Stable order for the UI: by display name, then id (never by enumeration order).
    next.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
    this.known = next;
  }

  private resolve(): Resolution {
    const usable = this.known.filter((k) => k.available);
    if (this.explicit) {
      const hit = usable.find((k) => k.id === this.explicit?.id);
      return hit ? { kind: 'TARGET', cam: hit } : { kind: 'LOST', sel: this.explicit };
    }
    if (usable.length === 1) return { kind: 'TARGET', cam: usable[0] };
    return usable.length === 0 ? { kind: 'NONE' } : { kind: 'CHOOSE' };
  }

  private listing(): CameraListing {
    const r = this.resolve();
    const selectedId = r.kind === 'TARGET' ? r.cam.id : r.kind === 'LOST' ? r.sel.id : null;
    const cameras: CameraInfo[] = this.known.map((k) => ({
      id: k.id, displayName: k.displayName, kind: k.source.kind, available: k.available, selected: k.id === selectedId,
      ...(k.unavailableReason ? { unavailableReason: k.unavailableReason } : {}),
      ...(k.placement ? { placement: k.placement } : {}),
      ...(k.capabilities ? { capabilities: k.capabilities } : {}),
    }));
    // A chosen camera that is no longer present is still shown (selected, unavailable) so the person sees what went missing.
    if (r.kind === 'LOST' && !cameras.some((c) => c.id === r.sel.id)) {
      cameras.push({ id: r.sel.id, displayName: r.sel.displayName, kind: r.sel.id.split(':')[0] as CameraInfo['kind'], available: false, selected: true, unavailableReason: 'NOT_CONNECTED' });
    }
    return { cameras, selectedId, selectionRequired: r.kind === 'CHOOSE' };
  }

  // — selection —

  /** Choose the camera captures use (or `null` to go back to automatic). Refused while a capture is running. */
  async select(id: string | null): Promise<CameraListing> {
    if (id !== null && (typeof id !== 'string' || !CAMERA_ID.test(id))) throw new CameraError('INVALID_REQUEST', 'Unknown camera');
    if (this.capturing) throw new CameraError('BUSY', 'Camera is already capturing');
    if (this.switching) throw new CameraError('BUSY', 'Camera selection is in progress');
    this.switching = true;
    try {
      await this.discover();
      if (id === null) {
        this.explicit = null;
        this.store.save(null);
      } else {
        const cam = this.known.find((k) => k.id === id);
        if (!cam) throw new CameraError('INVALID_REQUEST', 'Unknown camera');
        if (!cam.available) throw new CameraError('CONNECT_FAILED', 'Camera is not available');
        this.explicit = { id: cam.id, displayName: cam.displayName };
        this.store.save(this.explicit);
      }
      this.log.info('camera.selected', { cleared: id === null });
      await this.closeActive();
      await this.connect().catch(() => undefined); // a chosen camera that then fails to open is reported via status, not as a failed selection
      return this.listing();
    } finally {
      this.switching = false;
    }
  }

  // — CameraProvider —

  async getStatus(): Promise<CameraStatus> {
    return this.active ? this.active.provider.getStatus() : { ...this.idle };
  }

  /** (Re)resolves which camera to use and connects it. Never takes a picture. */
  connect(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    await this.discover();
    const r = this.resolve();
    if (r.kind === 'TARGET') {
      if (this.active && this.active.id !== r.cam.id) await this.closeActive();
      if (!this.active) this.active = { id: r.cam.id, provider: r.cam.source.open(r.cam.localId) };
      await this.active.provider.connect();
      return;
    }
    await this.closeActive();
    if (r.kind === 'NONE') this.idle = { state: 'DISCONNECTED', errorCode: 'NOT_CONNECTED', errorMessage: 'No camera available' };
    else if (r.kind === 'CHOOSE') this.idle = { state: 'DISCONNECTED', errorCode: 'CONFIG_ERROR', errorMessage: 'Select a camera' };
    else this.idle = { state: 'ERROR', errorCode: 'NOT_CONNECTED', errorMessage: 'Selected camera is not connected' };
    throw new CameraError(this.idle.errorCode ?? 'NOT_CONNECTED', this.idle.errorMessage ?? 'No camera available');
  }

  async disconnect(): Promise<void> {
    await this.closeActive();
    this.idle = { state: 'DISCONNECTED' };
  }

  async capture(request: CaptureRequest): Promise<CapturedImage> {
    if (this.switching) throw new CameraError('BUSY', 'Camera selection is in progress');
    if (this.capturing) throw new CameraError('BUSY', 'Camera is already capturing');
    this.capturing = true;
    try {
      // Re-resolve (without a shutter) unless the bound camera is healthy: a replugged camera, or a first capture after the
      // only camera appeared, is picked up here. An explicit choice is never swapped for a different camera.
      const st = this.active ? await this.active.provider.getStatus() : null;
      if (!this.active || st?.state !== 'CONNECTED') await this.connect().catch(() => undefined);
      if (!this.active) {
        throw new CameraError(this.idle.errorCode ?? 'NOT_CONNECTED', this.idle.errorMessage ?? 'No camera available');
      }
      return await this.active.provider.capture(request);
    } finally {
      this.capturing = false;
    }
  }

  private async closeActive(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (a) await a.provider.disconnect().catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
