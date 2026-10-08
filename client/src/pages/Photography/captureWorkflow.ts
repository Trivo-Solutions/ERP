import type { CaptureSession, ImageType, PhotographyStation, RemoteCommand, StationCamera, TagImage, UploadResult } from './photographyApi';
import { errorMessage } from './photographyApi';

// Pure workflow logic for the Capture page (no React, no network) so it can be unit-tested without a DOM.
// The page owns tag/station/image *data* through react-query; this reducer owns the operator's in-progress capture.
// The capture ticket lives in this state only — it is never written to any browser storage.

/** Backend authority for file limits is the server; this is only a sanity check to avoid shipping an absurd file. */
export const UX_MAX_FILE_BYTES = 100 * 1024 * 1024;

export type CaptureStep =
  | 'IDLE' | 'TAG_LOADING' | 'TAG_READY' | 'STATION_READY' | 'SESSION_STARTING'
  | 'CAPTURE_READY' | 'UPLOADING' | 'SUCCESS' | 'ERROR';

export type CaptureErrorKind = 'SESSION' | 'SESSION_EXPIRED' | 'UPLOAD' | 'NETWORK';
export interface CaptureError { kind: CaptureErrorKind; message: string }

export interface CaptureState {
  station: PhotographyStation | null;
  photoType: ImageType;
  session: CaptureSession | null;
  startingSession: boolean;
  file: File | null;
  /** One key per intended upload; kept across retries of the same file, replaced for a new file or after success. */
  idempotencyKey: string | null;
  uploading: boolean;
  progress: number | null;
  result: UploadResult | null;
  error: CaptureError | null;
}

export const initialCaptureState: CaptureState = {
  station: null, photoType: 'PRIMARY', session: null, startingSession: false,
  file: null, idempotencyKey: null, uploading: false, progress: null, result: null, error: null,
};

export type CaptureAction =
  | { type: 'SELECT_STATION'; station: PhotographyStation }
  | { type: 'SESSION_STARTING' }
  | { type: 'SESSION_STARTED'; session: CaptureSession }
  | { type: 'SESSION_FAILED'; message: string }
  | { type: 'SET_PHOTO_TYPE'; photoType: ImageType }
  | { type: 'FILE_CHOSEN'; file: File; idempotencyKey: string }
  | { type: 'FILE_CLEARED' }
  | { type: 'UPLOAD_STARTED' }
  | { type: 'UPLOAD_PROGRESS'; fraction: number }
  | { type: 'UPLOAD_SUCCEEDED'; result: UploadResult }
  | { type: 'UPLOAD_FAILED'; error: CaptureError }
  | { type: 'SESSION_EXPIRED' }
  | { type: 'NEXT_TAG' }
  | { type: 'RESET' };

export function captureReducer(s: CaptureState, a: CaptureAction): CaptureState {
  switch (a.type) {
    case 'SELECT_STATION':
      // A different station means a different ticket: drop any session minted for the old one.
      return s.station?.id === a.station.id ? s : { ...s, station: a.station, session: null, error: null };
    case 'SESSION_STARTING':
      return { ...s, startingSession: true, error: null };
    case 'SESSION_STARTED':
      return { ...s, startingSession: false, session: a.session, error: null };
    case 'SESSION_FAILED':
      return { ...s, startingSession: false, uploading: false, progress: null, session: null, error: { kind: 'SESSION', message: a.message } };
    case 'SET_PHOTO_TYPE':
      return { ...s, photoType: a.photoType };
    case 'FILE_CHOSEN':
      return { ...s, file: a.file, idempotencyKey: a.idempotencyKey, result: null, error: null, progress: null };
    case 'FILE_CLEARED':
      return { ...s, file: null, idempotencyKey: null, result: null, error: null, progress: null };
    case 'UPLOAD_STARTED':
      // Re-entry guard: a second click while a request is in flight changes nothing.
      return s.uploading ? s : { ...s, uploading: true, progress: 0, error: null, result: null };
    case 'UPLOAD_PROGRESS':
      return s.uploading ? { ...s, progress: a.fraction } : s;
    case 'UPLOAD_SUCCEEDED':
      // The key has done its job; the next image gets a fresh one. The session stays for further photos.
      return { ...s, uploading: false, progress: null, file: null, idempotencyKey: null, result: a.result, error: null };
    case 'UPLOAD_FAILED':
      // File and key are kept so a retry of the same request is idempotent.
      return { ...s, uploading: false, progress: null, error: a.error };
    case 'SESSION_EXPIRED':
      // Ticket is dropped; file/key stay so the operator can start a new session and send the same image.
      return { ...s, session: null, uploading: false, progress: null, error: { kind: 'SESSION_EXPIRED', message: 'The capture authorization expired. Try again.' } };
    case 'NEXT_TAG':
      // Moving to another tag: everything tag-bound goes (ticket, file, key, result, type back to PRIMARY), but the
      // operator's station stays so the loop is SCAN -> CAPTURE -> NEXT with no setup in between.
      return { ...initialCaptureState, station: s.station };
    case 'RESET':
      return initialCaptureState;
  }
}

export interface StepInputs {
  tagLoading: boolean;
  hasTag: boolean;
  tagError: boolean;
  state: CaptureState;
}

/** Which step the operator is on — derived, never stored separately, so it cannot drift from the data. */
export function deriveStep({ tagLoading, hasTag, tagError, state: s }: StepInputs): CaptureStep {
  if (tagLoading) return 'TAG_LOADING';
  if (tagError || !hasTag) return tagError ? 'ERROR' : 'IDLE';
  if (s.startingSession) return 'SESSION_STARTING';
  if (!s.session) return s.error ? 'ERROR' : s.station ? 'STATION_READY' : 'TAG_READY';
  if (s.uploading) return 'UPLOADING';
  if (s.result) return 'SUCCESS';
  if (s.error && s.error.kind !== 'SESSION_EXPIRED') return 'ERROR';
  return 'CAPTURE_READY';
}

export const STEP_LABEL: Record<CaptureStep, string> = {
  IDLE: 'Scan a tag', TAG_LOADING: 'Looking up tag…', TAG_READY: 'Choose a station', STATION_READY: 'Ready to capture',
  SESSION_STARTING: 'Preparing to capture…', CAPTURE_READY: 'Ready to capture', UPLOADING: 'Uploading…', SUCCESS: 'Photo saved', ERROR: 'Needs attention',
};

// ── ticket expiry ────────────────────────────────────────────────────────────

/** Treat a ticket as expired a few seconds early so an upload never starts on one that dies in flight. */
export const EXPIRY_SKEW_MS = 5000;
export const msUntilExpiry = (session: Pick<CaptureSession, 'expiresAt'>, now = Date.now()) => new Date(session.expiresAt).getTime() - now;
export const isSessionExpired = (session: Pick<CaptureSession, 'expiresAt'>, now = Date.now()) => msUntilExpiry(session, now) <= EXPIRY_SKEW_MS;
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ── file validation (UX only — the server re-validates bytes, type, size and hash) ──

export function validateImageFile(file: { type: string; size: number } | null | undefined): string | null {
  if (!file) return 'Choose a photo first.';
  if (file.size <= 0) return 'That file is empty.';
  if (!file.type.startsWith('image/')) return 'That file is not an image.';
  if (file.size > UX_MAX_FILE_BYTES) return 'That image is too large.';
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── idempotency key ──────────────────────────────────────────────────────────

/** Server accepts 8–128 chars of letters, digits and . _ : - . randomUUID needs a secure context (a tablet on a LAN http
 *  address is not one), so fall back to getRandomValues, which is available everywhere. */
export function newIdempotencyKey(c: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── error classification ─────────────────────────────────────────────────────

type HttpErr = { response?: { status?: number; data?: { error?: string } } };
const statusOf = (e: unknown) => (e as HttpErr)?.response?.status;

/** Ticket problems come back as 401 "…capture ticket…" from the upload route. */
export function isTicketExpiredError(e: unknown): boolean {
  return statusOf(e) === 401 && /ticket/i.test((e as HttpErr).response?.data?.error ?? '');
}

/** Generic, operator-safe text. Server messages are shown only for statuses where they are meant for the user. */
export function sessionErrorMessage(e: unknown): string {
  const s = statusOf(e);
  if (s === undefined) return 'Could not reach the server. Check the connection and try again.';
  if (s === 401 || s === 403) return 'You are not allowed to start a capture session here.';
  if (s === 404) return 'That tag or station is no longer available. Pick another.';
  if (s === 409) return 'This station cannot capture this tag (different branch or inactive). Choose another station.';
  return errorMessage(e, 'Could not start a capture session');
}

export function uploadError(e: unknown): CaptureError {
  const s = statusOf(e);
  if (isTicketExpiredError(e)) return { kind: 'SESSION_EXPIRED', message: 'The capture authorization expired. Try again.' };
  if (s === undefined) return { kind: 'NETWORK', message: 'Network problem — the photo was not confirmed. Retry to send it again safely.' };
  if (s >= 500) return { kind: 'NETWORK', message: 'The server could not store the photo. Retry to send it again safely.' };
  if (s === 413) return { kind: 'UPLOAD', message: 'That image is too large for the server.' };
  if (s === 403 || s === 401) return { kind: 'UPLOAD', message: 'You are not allowed to upload this photo.' };
  return { kind: 'UPLOAD', message: errorMessage(e, 'Upload failed') };
}

// ── remote capture via the station's Camera Bridge (Phase 5D) ──────────────────────────────────────────────────
// Manual capture (Take photo / Choose file) is untouched and never depends on any of this.

/** The bridge heartbeats every 30 s; the server treats a station as reachable for 90 s after the last one. */
export const STATION_ONLINE_WINDOW_MS = 90_000;
export const isStationOnline = (s: Pick<PhotographyStation, 'lastSeenAt'>, now = Date.now()) =>
  !!s.lastSeenAt && now - new Date(s.lastSeenAt).getTime() <= STATION_ONLINE_WINDOW_MS;

export type RemoteStage = 'IDLE' | 'REQUESTING' | 'WAITING' | 'ACCEPTED' | 'CAPTURING' | 'PROCESSING' | 'DONE' | 'FAILED';
export interface RemoteState {
  stage: RemoteStage;
  commandId: string | null;
  image: TagImage | null;
  message: string | null;
}
export const initialRemoteState: RemoteState = { stage: 'IDLE', commandId: null, image: null, message: null };

export type RemoteAction =
  | { type: 'REQUESTING' }
  | { type: 'COMMAND'; command: RemoteCommand }
  | { type: 'REQUEST_FAILED'; message: string }
  | { type: 'RESET' };

/** Failure wording from the server's normalized code; the operator is always pointed at the manual route. */
export function remoteFailureMessage(code: string | null, detail: string | null): string {
  const tail = ' You can still use Take photo or Choose file.';
  switch (code) {
    case 'BUSY': return 'The camera is busy. Wait a moment and try again.' + tail;
    case 'CAMERA_ERROR': return (detail === 'CAPTURE_TIMEOUT' ? 'The camera took too long to respond.' : 'The camera could not take the photo.') + tail;
    case 'NETWORK_ERROR': return 'The station could not reach the server to send the photo.' + tail;
    case 'UPLOAD_ERROR': return 'The photo was taken but the server did not accept it.' + tail;
    case 'AUTH_ERROR': return 'The station is not authorised to send photos. Ask an administrator to check its credential.' + tail;
    case 'EXPIRED': return 'The capture request timed out before the station finished.' + tail;
    case 'COMMAND_REJECTED': return 'The station refused the capture request.' + tail;
    default: return 'The station could not complete the capture.' + tail;
  }
}

export function remoteReducer(s: RemoteState, a: RemoteAction): RemoteState {
  switch (a.type) {
    case 'REQUESTING': return { stage: 'REQUESTING', commandId: null, image: null, message: null };
    case 'REQUEST_FAILED': return { stage: 'FAILED', commandId: null, image: null, message: a.message };
    case 'RESET': return initialRemoteState;
    case 'COMMAND': {
      const c = a.command;
      if (s.commandId && s.commandId !== c.commandId) return s; // a stale poll for an abandoned command
      switch (c.status) {
        case 'QUEUED': return { stage: 'WAITING', commandId: c.commandId, image: null, message: null };
        case 'ACCEPTED': return { stage: 'ACCEPTED', commandId: c.commandId, image: null, message: null };
        case 'CAPTURING': return { stage: 'CAPTURING', commandId: c.commandId, image: null, message: null };
        case 'UPLOADED': {
          const img = c.image ?? null;
          return { stage: img && img.processingStatus === 'PENDING' ? 'PROCESSING' : 'DONE', commandId: c.commandId, image: img, message: null };
        }
        case 'EXPIRED': return { stage: 'FAILED', commandId: c.commandId, image: null, message: remoteFailureMessage('EXPIRED', null) };
        case 'FAILED': return { stage: 'FAILED', commandId: c.commandId, image: null, message: remoteFailureMessage(c.failureCode, c.failureDetail) };
      }
    }
  }
}

export const remoteIsActive = (s: RemoteState) =>
  s.stage === 'REQUESTING' || s.stage === 'WAITING' || s.stage === 'ACCEPTED' || s.stage === 'CAPTURING' || s.stage === 'PROCESSING';
export const REMOTE_STAGE_LABEL: Record<RemoteStage, string> = {
  IDLE: '', REQUESTING: 'Sending request to the station…', WAITING: 'Queued…', ACCEPTED: 'Camera accepted…',
  CAPTURING: 'Capturing and uploading…', PROCESSING: 'Processing the photo…', DONE: 'Complete', FAILED: 'Capture failed',
};

// ── station camera (discovered and selected by the Camera Bridge, reported to the ERP in its heartbeat) ──────────────
// The browser never talks to a bridge. It only reads what the bridge reported and asks the ERP to relay a selection.

export type CameraUiState =
  | 'BRIDGE_OFFLINE'      // no recent heartbeat: the station has no bridge to take the photo
  | 'UNREPORTED'         // the bridge is online but does not report cameras (older bridge) - capture is still possible
  | 'NO_CAMERA'          // online, nothing usable detected
  | 'SELECTION_REQUIRED' // several usable cameras, none chosen: never guessed
  | 'SWITCHING'          // a selection was requested and the bridge has not applied it yet
  | 'DISCONNECTED'       // the chosen camera is gone: never replaced by another automatically
  | 'READY';

export interface CameraView {
  state: CameraUiState;
  label: string;
  /** error | warning | success | default - the chip colour for the state. */
  tone: 'error' | 'warning' | 'success' | 'default';
  cameras: StationCamera[];
  selected: StationCamera | null;
  canCapture: boolean;
  canSelect: boolean;
}

export function deriveCameraView(station: Pick<PhotographyStation, 'lastSeenAt' | 'cameras'> | null, now = Date.now()): CameraView {
  const base = { cameras: [] as StationCamera[], selected: null as StationCamera | null, canCapture: false, canSelect: false };
  if (!station || !isStationOnline(station, now)) {
    return { ...base, state: 'BRIDGE_OFFLINE', label: 'Station camera offline', tone: 'default' };
  }
  const rep = station.cameras;
  if (!rep || !rep.fresh) return { ...base, state: 'UNREPORTED', label: 'Station camera online', tone: 'success', canCapture: true };
  const cameras = rep.cameras;
  const selected = rep.selectedId ? cameras.find((c) => c.id === rep.selectedId) ?? null : null;
  const usable = cameras.filter((c) => c.available);
  const v = { ...base, cameras, selected, canSelect: usable.length > 0 };
  if (rep.pendingCameraId && rep.pendingCameraId !== rep.selectedId) return { ...v, state: 'SWITCHING', label: 'Selecting camera…', tone: 'warning', canSelect: false };
  if (rep.selectedId) {
    if (!selected || !selected.available) return { ...v, state: 'DISCONNECTED', label: 'Camera disconnected', tone: 'error' };
    return { ...v, state: 'READY', label: 'Connected', tone: 'success', canCapture: true };
  }
  if (rep.selectionRequired) return { ...v, state: 'SELECTION_REQUIRED', label: 'Camera detected — select one', tone: 'warning' };
  return { ...v, state: 'NO_CAMERA', label: 'No camera detected', tone: 'error' };
}

/** Server message for a request that never became a command (offline station, busy station, expired session...). */
export function remoteRequestError(e: unknown): string {
  const r = (e as { response?: { status?: number; data?: { error?: string; code?: string } } })?.response;
  if (!r) return 'Could not reach the server. You can still use Take photo or Choose file.';
  if (r.data?.code === 'STATION_OFFLINE') return 'The camera station is offline. Use Take photo or Choose file instead.';
  if (r.data?.code === 'STATION_BUSY') return 'That station is already taking a photo. Try again in a moment.';
  return (r.data?.error ?? 'Could not start the camera capture') + ' You can still use Take photo or Choose file.';
}

// ── continuous operator loop (scan -> capture -> next) ────────────────────────────────────────────────────────────

/**
 * Which station the page works with. A station the operator already picked is kept for as long as it is still active;
 * otherwise a single active station is chosen automatically, and with several the operator picks once. Never guesses
 * between several.
 */
export function resolveStation(stations: PhotographyStation[] | undefined, chosenId: string | null): PhotographyStation | null {
  const active = (stations ?? []).filter((s) => s.isActive);
  if (chosenId) return active.find((s) => s.id === chosenId) ?? null;
  return active.length === 1 ? active[0] : null;
}

/** The station's branch must match the tag's; the server re-checks this when the session starts. */
export const stationFitsTag = (station: Pick<PhotographyStation, 'branchId'>, tag: { branch: { id: string } | null }) =>
  !tag.branch || station.branchId === tag.branch.id;

/**
 * Reuse the in-memory ticket while it is comfortably valid; otherwise mint a fresh one through the same secure endpoint.
 * The backend lifetime is untouched — this only hides the renewal from the operator. Throws what `start` throws.
 */
export async function ensureCaptureSession(
  current: CaptureSession | null, start: () => Promise<CaptureSession>, now = Date.now(),
): Promise<{ session: CaptureSession; renewed: boolean }> {
  if (current && !isSessionExpired(current, now)) return { session: current, renewed: false };
  return { session: await start(), renewed: true };
}
