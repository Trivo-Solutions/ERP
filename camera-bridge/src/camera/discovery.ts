// Vendor-neutral camera discovery vocabulary. Like types.ts, nothing in here names a vendor SDK, helper, driver or OS API.
import { CameraProvider } from './types';

/** Where a camera comes from. The ERP and the UI only ever see this label, never a driver or SDK name. */
export const CAMERA_KINDS = ['webcam', 'sony', 'mock'] as const;
export type CameraKind = (typeof CAMERA_KINDS)[number];

export type CameraUnavailableReason = 'DRIVER_UNAVAILABLE' | 'NOT_CONNECTED';

/** What a source reports about one camera (ids are the source's own; the hub namespaces them). */
export interface DiscoveredCamera {
  /** Stable identifier of the physical camera — never an array position. [A-Za-z0-9._:-]{1,64}. */
  localId: string;
  displayName: string;
  available: boolean;
  unavailableReason?: CameraUnavailableReason;
  /** Only set when the camera itself says so (e.g. "Integrated Camera"); an unrecognised camera is not guessed at. */
  placement?: 'integrated';
  capabilities?: CameraCapabilities;
}

export interface CameraCapabilities {
  stillCapture: boolean;
  format: 'jpeg' | 'png';
}

/** One camera as the bridge exposes it (local API / CLI). */
export interface CameraInfo {
  /** `<kind>:<localId>` — the only identifier a caller uses to select a camera. */
  id: string;
  displayName: string;
  kind: CameraKind;
  available: boolean;
  selected: boolean;
  unavailableReason?: CameraUnavailableReason;
  placement?: 'integrated';
  capabilities?: CameraCapabilities;
}

export interface CameraListing {
  cameras: CameraInfo[];
  /** Id of the camera captures will use (explicitly chosen, or the only usable one), else null. */
  selectedId: string | null;
  /** True when several cameras are usable and none has been chosen: the person must pick one. */
  selectionRequired: boolean;
}

/**
 * A family of cameras the bridge can discover and open. `discover()` must never throw (return what it knows, or an
 * unavailable entry that explains why) and must not take a picture. `open()` returns a provider bound to ONE camera.
 */
export interface CameraSource {
  readonly kind: CameraKind;
  /** True when listing would disturb an open session of this source (so the hub reuses its last answer while one is active). */
  readonly exclusive?: boolean;
  discover(): Promise<DiscoveredCamera[]>;
  open(localId: string): CameraProvider;
}

export const CAMERA_ID = /^(webcam|sony|mock):[A-Za-z0-9._:-]{1,64}$/;
