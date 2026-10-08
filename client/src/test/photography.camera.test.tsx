import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../api/client', () => ({ api: { delete: vi.fn(), post: vi.fn() }, apiGet: h.apiGet, apiPost: h.apiPost, apiPut: vi.fn() }));

import { StationCameraPanel } from '../pages/Photography/StationCameraPanel';
import { requestCameraSelection, type StationCamera, type StationCameras } from '../pages/Photography/photographyApi';
import {
  REMOTE_STAGE_LABEL, deriveCameraView, initialRemoteState, remoteIsActive, remoteReducer, type CameraView,
} from '../pages/Photography/captureWorkflow';

const NOW = Date.parse('2026-10-11T10:00:00Z');
const online = new Date(NOW - 10_000).toISOString();
const WEBCAM = 'webcam:cam-10cbddd03f968218b0be759a';
const cam = (id: string, o: Partial<StationCamera> = {}): StationCamera => ({
  id, displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: false, ...o,
});
const rep = (cameras: StationCamera[], o: Partial<StationCameras> = {}): StationCameras => ({
  cameras, selectedId: null, selectionRequired: false, reportedAt: online, fresh: true, pendingCameraId: null, ...o,
});
const view = (cameras: StationCameras | null, lastSeenAt: string | null = online) => deriveCameraView({ lastSeenAt, cameras }, NOW);
const html = (v: CameraView, p: Partial<React.ComponentProps<typeof StationCameraPanel>> = {}) =>
  renderToStaticMarkup(<StationCameraPanel view={v} capturing={false} selecting={false} onSelect={() => undefined} onCapture={() => undefined} {...p} />);

beforeEach(() => { h.apiGet.mockReset(); h.apiPost.mockReset(); });

describe('deriveCameraView — what the bridge reported, never guessed', () => {
  it('no bridge heartbeat -> offline, nothing to capture with (manual route unaffected)', () => {
    for (const v of [view(null, null), view(rep([cam(WEBCAM)]), new Date(NOW - 200_000).toISOString()), deriveCameraView(null, NOW)]) {
      expect(v).toMatchObject({ state: 'BRIDGE_OFFLINE', canCapture: false, canSelect: false });
    }
  });

  it('an online bridge that does not report cameras (older bridge) can still capture', () => {
    expect(view(null)).toMatchObject({ state: 'UNREPORTED', canCapture: true });
    expect(view(rep([cam(WEBCAM, { selected: true })], { selectedId: WEBCAM, fresh: false }))).toMatchObject({ state: 'UNREPORTED' });
  });

  it('no camera detected', () => {
    expect(view(rep([]))).toMatchObject({ state: 'NO_CAMERA', label: 'No camera detected', canCapture: false });
    expect(view(rep([cam(WEBCAM, { available: false, unavailableReason: 'NOT_CONNECTED' })]))).toMatchObject({ state: 'NO_CAMERA', canCapture: false });
  });

  it('a single camera the bridge selected is connected and capturable', () => {
    const v = view(rep([cam(WEBCAM, { selected: true, placement: 'integrated' })], { selectedId: WEBCAM }));
    expect(v).toMatchObject({ state: 'READY', label: 'Connected', canCapture: true });
    expect(v.selected?.displayName).toBe('Integrated Camera');
  });

  it('several cameras and none chosen: selection required, capture blocked, nothing auto-picked', () => {
    const v = view(rep([cam(WEBCAM), cam('webcam:usb-2', { displayName: 'USB Camera' })], { selectionRequired: true }));
    expect(v).toMatchObject({ state: 'SELECTION_REQUIRED', canCapture: false, canSelect: true, selected: null });
  });

  it('the selected camera disappearing is DISCONNECTED and is not replaced by another one', () => {
    const lost = rep([cam(WEBCAM, { selected: true, available: false, unavailableReason: 'NOT_CONNECTED' }), cam('webcam:usb-2', { displayName: 'USB Camera' })], { selectedId: WEBCAM });
    const v = view(lost);
    expect(v).toMatchObject({ state: 'DISCONNECTED', label: 'Camera disconnected', canCapture: false, canSelect: true });
    expect(v.selected?.id).toBe(WEBCAM); // still the chosen one; the UI never swaps in the USB camera
    // and a selected id that is missing from the list altogether is the same
    expect(view(rep([cam('webcam:usb-2')], { selectedId: WEBCAM }))).toMatchObject({ state: 'DISCONNECTED', canCapture: false });
  });

  it('a requested camera the bridge has not applied yet is SWITCHING and blocks capture', () => {
    const v = view(rep([cam(WEBCAM, { selected: true }), cam('webcam:usb-2')], { selectedId: WEBCAM, pendingCameraId: 'webcam:usb-2' }));
    expect(v).toMatchObject({ state: 'SWITCHING', canCapture: false, canSelect: false });
    // once the bridge reports the new selection the pending id is cleared by the server -> ready again
    expect(view(rep([cam(WEBCAM), cam('webcam:usb-2', { selected: true })], { selectedId: 'webcam:usb-2' })).state).toBe('READY');
  });
});

describe('StationCameraPanel', () => {
  it('renders the Camera section with the camera name, a Connected status and an enabled Capture Photo button', () => {
    const out = html(view(rep([cam(WEBCAM, { selected: true })], { selectedId: WEBCAM })));
    expect(out).toContain('Camera'); expect(out).toContain('Integrated Camera'); expect(out).toContain('Connected');
    expect(out).toContain('Capture Photo'); expect(out).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]*>)*\s*Capture Photo/);
    expect(out).not.toContain('<select'); // one camera: nothing to choose
  });

  it('offers a native <select> (keyboard changeable while closed) when several cameras exist, with unavailable ones disabled', () => {
    const v = view(rep([cam(WEBCAM), cam('webcam:usb-2', { displayName: 'USB Camera', available: false })], { selectionRequired: true }));
    const out = html(v);
    expect(out).toContain('<select'); expect(out).toContain('Select a camera…'); expect(out).toContain('Camera detected');
    expect(out).toContain('Integrated Camera'); expect(out).toContain('USB Camera (unavailable)');
    expect(out).toMatch(/<button[^>]*disabled/); // Capture Photo blocked until a camera is chosen
  });

  it('shows the disconnected state loudly, offers no automatic switch, and blocks capture', () => {
    const v = view(rep([cam(WEBCAM, { selected: true, available: false }), cam('webcam:usb-2', { displayName: 'USB Camera' })], { selectedId: WEBCAM }));
    const out = html(v);
    expect(out).toContain('Camera disconnected'); expect(out).toContain('is disconnected'); expect(out).toContain('not replaced automatically');
    expect(out).toMatch(/<button[^>]*disabled/);
  });

  it('with no bridge it says so and the manual route is the pointer — it renders, it does not throw', () => {
    const out = html(view(null, null));
    expect(out).toContain('Station camera offline'); expect(out).toContain('Take photo or Choose file');
    expect(out).toMatch(/<button[^>]*disabled/);
  });

  it('no camera detected', () => {
    const out = html(view(rep([])));
    expect(out).toContain('No camera detected'); expect(out).toMatch(/<button[^>]*disabled/);
  });

  it('shows Capturing… and blocks a second click while a capture is running', () => {
    const out = html(view(rep([cam(WEBCAM, { selected: true })], { selectedId: WEBCAM })), { capturing: true });
    expect(out).toContain('Capturing…'); expect(out).toMatch(/<button[^>]*disabled/);
  });
});

describe('capture progress and retry (server-driven stages)', () => {
  const cmd = (status: string, o: object = {}) => ({
    commandId: 'c1', status, stationId: 's1', tagId: 't1', imageType: 'PRIMARY', correlationId: 'k', failureCode: null, failureDetail: null,
    expiresAt: new Date(Date.now() + 100_000).toISOString(), ...o,
  }) as never;
  const run = (...a: Parameters<typeof remoteReducer>[1][]) => a.reduce(remoteReducer, initialRemoteState);

  it('walks Queued -> Camera accepted -> Capturing -> Complete with its own wording at each step', () => {
    expect(REMOTE_STAGE_LABEL[run({ type: 'COMMAND', command: cmd('QUEUED') }).stage]).toMatch(/Queued/);
    expect(REMOTE_STAGE_LABEL[run({ type: 'COMMAND', command: cmd('ACCEPTED') }).stage]).toMatch(/Camera accepted/);
    expect(REMOTE_STAGE_LABEL[run({ type: 'COMMAND', command: cmd('CAPTURING') }).stage]).toMatch(/Capturing and uploading/);
    const done = run({ type: 'COMMAND', command: cmd('UPLOADED', { image: { id: 'i1', processingStatus: 'READY' } }) });
    expect(REMOTE_STAGE_LABEL[done.stage]).toBe('Complete'); expect(remoteIsActive(done)).toBe(false); expect(done.image?.id).toBe('i1');
    for (const s of ['QUEUED', 'ACCEPTED', 'CAPTURING']) expect(remoteIsActive(run({ type: 'COMMAND', command: cmd(s) }))).toBe(true);
  });

  it('a failed capture is recoverable: FAILED is not active, and a fresh request starts clean (no stale image, new command)', () => {
    const failed = run({ type: 'COMMAND', command: cmd('FAILED', { failureCode: 'CAMERA_ERROR' }) });
    expect(failed.stage).toBe('FAILED'); expect(remoteIsActive(failed)).toBe(false); expect(failed.image).toBeNull();
    const retry = remoteReducer(remoteReducer(failed, { type: 'REQUESTING' }), { type: 'COMMAND', command: cmd('QUEUED', { commandId: 'c2' }) });
    expect(retry).toMatchObject({ stage: 'WAITING', commandId: 'c2', message: null });
  });
});

describe('camera selection API: the browser only names a camera the bridge reported', () => {
  it('posts just the camera id to the station-scoped ERP route (never a URL, port, company, or credential)', async () => {
    h.apiPost.mockResolvedValue({ stationId: 's 1', pendingCameraId: WEBCAM });
    await requestCameraSelection('s 1', WEBCAM);
    expect(h.apiPost).toHaveBeenCalledWith('/photography/stations/s%201/camera-selection', { cameraId: WEBCAM });
    expect(JSON.stringify(h.apiPost.mock.calls)).not.toMatch(/localhost|127\.0\.0\.1|9102|stn_|Bearer/);
  });
});
