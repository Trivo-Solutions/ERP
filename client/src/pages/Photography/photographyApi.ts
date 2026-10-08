import { api, apiGet, apiPost, apiPut } from '../../api/client';

// Contracts mirror server/src/modules/photography (photography.service.ts, photographySettings.ts).
// The server owns every default, limit and rule — nothing here supplies a fallback value.

export const IMAGE_TYPES = ['PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER'] as const;
export type ImageVariant = 'original' | 'optimized' | 'thumbnail';

export interface PhotographyDashboardData {
  todaysPhotos: number;
  pendingProcessing: number;
  processingFailed: number;
  imagesReviewed: number;
  imagesDeletedToday: number;
  activeStations: number;
  storageUsage: { available: boolean; reason?: string; [k: string]: unknown };
}

export interface PhotographyTag {
  id: string;
  tagNumber: string;
  name: string | null;
  status: string;
  metalType: string | null;
  metalKarat: string | null;
  grossWeight: string;
  netWeight: string;
  branch: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  photography: {
    imageCount: number;
    hasPrimary: boolean;
    primaryImageId: string | null;
    lastCapturedAt: string | null;
  };
}

export interface TagImage {
  id: string;
  tagId: string;
  imageType: string;
  isPrimary: boolean;
  reviewStatus: string | null;
  uploadStatus: string;
  processingStatus: string;
  originalFilename: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  captureSource: string | null;
  cameraLabel: string | null;
  capturedAt: string;
  createdAt: string;
  station: { id: string; name: string } | null;
  variants: { original: boolean; optimized: boolean; thumbnail: boolean };
}

export interface SignedImageUrl {
  imageId: string;
  variant: ImageVariant;
  url: string;
  expiresInSeconds: number;
  mimeType: string | null;
}

export type PhotographySettingsValues = {
  generateOptimized: boolean;
  targetOptimizedSizeKB: number;
  minimumQuality: number;
  maximumQuality: number;
  maximumWidth: number;
  maximumHeight: number;
  minimumLongEdge: number;
  optimizedFormat: string;
  generateThumbnail: boolean;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnailCrop: boolean;
  thumbnailFormat: string;
  thumbnailQuality: number;
  keepOriginal: boolean;
  autoOrient: boolean;
  maxInputWidth: number;
  maxInputHeight: number;
};

export interface PhotographySettingsResponse {
  settings: PhotographySettingsValues;
  defaults: PhotographySettingsValues;
  limits: Partial<Record<keyof PhotographySettingsValues, readonly [number, number]>>;
  formats: string[];
  usingDefaults: boolean;
}

export const photoKeys = {
  dashboard: ['photography', 'dashboard'] as const,
  settings: ['photography', 'settings'] as const,
  tag: (n: string) => ['photography', 'tag', n] as const,
  stations: ['photography', 'stations'] as const,
  images: (tagId: string) => ['photography', 'images', tagId] as const,
  url: (imageId: string, variant: ImageVariant) => ['photography', 'url', imageId, variant] as const,
};

export const getDashboard = () => apiGet<PhotographyDashboardData>('/photography/dashboard');
export const lookupTag = (tagNumber: string) => apiGet<PhotographyTag>(`/photography/tags/${encodeURIComponent(tagNumber)}`);
export const listImages = (tagId: string) => apiGet<TagImage[]>(`/photography/tags/${encodeURIComponent(tagId)}/images`);
export const getImageUrl = (imageId: string, variant: ImageVariant) =>
  apiGet<SignedImageUrl>(`/photography/images/${encodeURIComponent(imageId)}/url`, { variant });
export const getSettings = () => apiGet<PhotographySettingsResponse>('/photography/settings');
export const saveSettings = (patch: Partial<PhotographySettingsValues>) => apiPut<PhotographySettingsResponse>('/photography/settings', patch);
// apiDelete sends no body, but the server requires a reason — use the axios instance directly.
export const deleteImage = (imageId: string, reason: string) =>
  api.delete(`/photography/images/${encodeURIComponent(imageId)}`, { data: { reason } }).then((r) => r.data.data);

// ── capture workflow (device-independent: a browser camera/file today, the Camera Bridge later — same contract) ──

export const CAPTURE_SOURCE_DEVICE_CAMERA = 'DEVICE_CAMERA' as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export interface PhotographyStation {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  isActive: boolean;
  /** Bridge heartbeat, null until a bridge exists — NOT an online/offline indicator. */
  lastSeenAt: string | null;
  /** What the station's Camera Bridge last reported about its cameras; null until a bridge that reports cameras has heartbeated. */
  cameras: StationCameras | null;
}

/** One camera as the bridge reported it. The id is the bridge's own opaque identifier; the browser only echoes it back. */
export interface StationCamera {
  id: string;
  displayName: string;
  kind: 'webcam' | 'sony' | 'mock';
  available: boolean;
  selected: boolean;
  unavailableReason?: 'DRIVER_UNAVAILABLE' | 'NOT_CONNECTED';
  placement?: 'integrated';
}

export interface StationCameras {
  cameras: StationCamera[];
  selectedId: string | null;
  /** Several cameras are usable and none has been chosen: a person must pick one. */
  selectionRequired: boolean;
  reportedAt: string;
  /** The report is recent enough to trust (the bridge heartbeats every 30 s). */
  fresh: boolean;
  /** A selection the user asked for that the bridge has not applied yet. */
  pendingCameraId: string | null;
}

export interface CaptureSession {
  sessionId: string;
  /** Short-lived, sensitive: keep in component state only, never in any browser storage. */
  ticket: string;
  expiresAt: string;
  expiresInSeconds: number;
  stationId: string;
  tagId: string;
  tagNumber: string;
  operations: string[];
  captureSource: string;
  tag: { id: string; tagNumber: string };
  station: { id: string; name: string };
}

export interface UploadResult {
  image: TagImage;
  idempotentReplay: boolean;
  replacedPrimaryImageId: string | null;
}

export const listStations = () => apiGet<PhotographyStation[]>('/photography/stations');
export const startCaptureSession = (tagId: string, stationId: string) =>
  apiPost<CaptureSession>('/photography/capture-sessions', { tagId, stationId, captureSource: CAPTURE_SOURCE_DEVICE_CAMERA });

/**
 * Multipart body for POST /photography/images. Only what the server asks for: the ticket (which already binds tag,
 * station, company and user), the type, the idempotency key and the file. Never a company/branch/user/storage field.
 */
export function buildUploadForm(p: { ticket: string; imageType: ImageType; idempotencyKey: string; file: File }): FormData {
  const f = new FormData();
  f.append('ticket', p.ticket);
  f.append('imageType', p.imageType);
  f.append('idempotencyKey', p.idempotencyKey);
  f.append('file', p.file, p.file.name);
  return f;
}

export const uploadImage = (form: FormData, onProgress?: (fraction: number) => void) =>
  api.post<{ success: boolean; data: UploadResult }>('/photography/images', form, {
    // Let the browser set multipart/form-data with its boundary (the instance default is JSON).
    headers: { 'Content-Type': undefined as unknown as string },
    timeout: 120000,
    onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.min(1, e.loaded / e.total)); },
  }).then((r) => r.data.data);

/** Server error text (AppError → { error }), else a generic fallback. */
export function errorMessage(e: unknown, fallback = 'Request failed'): string {
  const r = (e as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  return r?.error ?? r?.message ?? (e as Error)?.message ?? fallback;
}

// ── remote capture (Photography Phase 5D): ask the station's Camera Bridge to take the photo ──

export const CAPTURE_SOURCE_BRIDGE = 'BRIDGE' as const;
export type RemoteCommandStatus = 'QUEUED' | 'ACCEPTED' | 'CAPTURING' | 'UPLOADED' | 'FAILED' | 'EXPIRED';

export interface RemoteCommand {
  commandId: string;
  status: RemoteCommandStatus;
  stationId: string;
  tagId: string;
  imageType: string;
  correlationId: string;
  failureCode: string | null;
  failureDetail: string | null;
  expiresAt: string;
  /** Present on a GET once the status is UPLOADED. */
  image?: TagImage | null;
}

/** A bridge-sourced session is separate from the manual one, so a manual file never gets recorded as a bridge capture. */
export const startBridgeSession = (tagId: string, stationId: string) =>
  apiPost<CaptureSession>('/photography/capture-sessions', { tagId, stationId, captureSource: CAPTURE_SOURCE_BRIDGE });
/** Ask the station's bridge to use one of the cameras it reported. The bridge applies it; the next station refresh shows the result. */
export const requestCameraSelection = (stationId: string, cameraId: string) =>
  apiPost<{ stationId: string; pendingCameraId: string }>(`/photography/stations/${encodeURIComponent(stationId)}/camera-selection`, { cameraId });
export const createCaptureCommand = (ticket: string, imageType: ImageType) =>
  apiPost<RemoteCommand>('/photography/capture-commands', { ticket, imageType });
export const getCaptureCommand = (commandId: string) =>
  apiGet<RemoteCommand>(`/photography/capture-commands/${encodeURIComponent(commandId)}`);
