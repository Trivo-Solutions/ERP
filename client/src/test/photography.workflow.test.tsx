import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../api/client', () => ({ api: { delete: vi.fn(), post: vi.fn() }, apiGet: h.apiGet, apiPost: h.apiPost, apiPut: vi.fn() }));

import { PhotographyCapturePage, PhotoSavedBanner } from '../pages/Photography/PhotographyCapturePage';
import { StationCameraPanel } from '../pages/Photography/StationCameraPanel';
import { photoKeys, type CaptureSession, type PhotographyStation, type StationCamera, type StationCameras, type TagImage } from '../pages/Photography/photographyApi';
import {
  captureReducer, deriveCameraView, ensureCaptureSession, initialCaptureState, REMOTE_STAGE_LABEL, resolveStation, stationFitsTag,
  type CaptureState,
} from '../pages/Photography/captureWorkflow';

const NOW = Date.now();
const online = new Date(NOW - 5000).toISOString();
const WEBCAM = 'webcam:cam-1';
const cam = (id: string, o: Partial<StationCamera> = {}): StationCamera => ({ id, displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: false, ...o });
const rep = (cameras: StationCamera[], o: Partial<StationCameras> = {}): StationCameras => ({ cameras, selectedId: null, selectionRequired: false, reportedAt: online, fresh: true, pendingCameraId: null, ...o });
const station = (o: Partial<PhotographyStation> = {}): PhotographyStation => ({
  id: 's1', name: 'HO-PHOTO-01', branchId: 'b1', branchName: 'Head Office', isActive: true, lastSeenAt: online,
  cameras: rep([cam(WEBCAM, { selected: true })], { selectedId: WEBCAM }), ...o,
});
const session = (o: Partial<CaptureSession> = {}): CaptureSession => ({
  sessionId: 'x', ticket: 'TKT', expiresAt: new Date(Date.now() + 600_000).toISOString(), expiresInSeconds: 600, stationId: 's1', tagId: 't1', tagNumber: 'SNKL00001',
  operations: ['upload'], captureSource: 'DEVICE_CAMERA', tag: { id: 't1', tagNumber: 'SNKL00001' }, station: { id: 's1', name: 'HO-PHOTO-01' }, ...o,
});
const img = (o: Partial<TagImage> = {}): TagImage => ({
  id: 'i1', tagId: 't1', imageType: 'PRIMARY', isPrimary: true, reviewStatus: null, uploadStatus: 'CONFIRMED', processingStatus: 'READY', originalFilename: null,
  mimeType: 'image/jpeg', width: 1, height: 1, sizeBytes: 1, captureSource: 'BRIDGE', cameraLabel: null, capturedAt: '2026-10-08T05:00:00Z',
  createdAt: '2026-10-08T05:00:00Z', station: null, variants: { original: true, optimized: true, thumbnail: true }, ...o,
});
const run = (actions: Parameters<typeof captureReducer>[1][], from: CaptureState = initialCaptureState) => actions.reduce(captureReducer, from);
const panel = (v: ReturnType<typeof deriveCameraView>, p: Partial<React.ComponentProps<typeof StationCameraPanel>> = {}) =>
  renderToStaticMarkup(<StationCameraPanel view={v} capturing={false} selecting={false} onSelect={() => undefined} onCapture={() => undefined} {...p} />);
const page = (stations: PhotographyStation[] | undefined) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (stations) qc.setQueryData(photoKeys.stations, stations);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter><SnackbarProvider><PhotographyCapturePage /></SnackbarProvider></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => { h.apiGet.mockReset(); h.apiPost.mockReset(); });

describe('operator loop: SCAN -> CAPTURE -> NEXT keeps the station (and so the camera)', () => {
  it('PRIMARY is the default photo type', () => {
    expect(initialCaptureState.photoType).toBe('PRIMARY');
  });

  it('NEXT_TAG keeps the chosen station but drops every tag-bound thing and returns the type to PRIMARY', () => {
    const dirty = run([
      { type: 'SELECT_STATION', station: station() }, { type: 'SESSION_STARTED', session: session() }, { type: 'SET_PHOTO_TYPE', photoType: 'BACK' },
      { type: 'FILE_CHOSEN', file: new File([new Uint8Array(4)], 'a.jpg', { type: 'image/jpeg' }), idempotencyKey: 'k-12345678' },
    ]);
    const next = captureReducer(dirty, { type: 'NEXT_TAG' });
    expect(next.station?.id).toBe('s1');
    expect(next).toMatchObject({ session: null, file: null, idempotencyKey: null, result: null, error: null, photoType: 'PRIMARY', uploading: false });
    // RESET (hard reset) is still available and still clears the station
    expect(captureReducer(dirty, { type: 'RESET' })).toEqual(initialCaptureState);
  });

  it('a successful upload then NEXT_TAG leaves a clean slate for the next tag', () => {
    const done = run([{ type: 'SELECT_STATION', station: station() }, { type: 'UPLOAD_STARTED' }, { type: 'UPLOAD_SUCCEEDED', result: { image: img(), idempotentReplay: false, replacedPrimaryImageId: null } }]);
    expect(done.result).not.toBeNull();
    expect(captureReducer(done, { type: 'NEXT_TAG' }).result).toBeNull();
  });
});

describe('station resolution: automatic when unambiguous, never guessed', () => {
  it('one active station is selected automatically', () => {
    expect(resolveStation([station(), station({ id: 'off', isActive: false })], null)?.id).toBe('s1');
  });
  it('several active stations need one explicit choice, then it sticks', () => {
    const list = [station(), station({ id: 's2', name: 'Bench 2' })];
    expect(resolveStation(list, null)).toBeNull();
    expect(resolveStation(list, 's2')?.id).toBe('s2');
  });
  it('a chosen station that disappears or is deactivated is not silently replaced', () => {
    expect(resolveStation([station({ isActive: false }), station({ id: 's2' })], 's1')).toBeNull();
    expect(resolveStation([station({ id: 's2' })], 's1')).toBeNull();
    expect(resolveStation(undefined, null)).toBeNull();
  });
  it('the station must be in the tag branch', () => {
    expect(stationFitsTag(station(), { branch: { id: 'b1' } })).toBe(true);
    expect(stationFitsTag(station(), { branch: { id: 'b2' } })).toBe(false);
    expect(stationFitsTag(station(), { branch: null })).toBe(true);
  });
});

describe('transparent capture-authorization renewal', () => {
  it('reuses a comfortably valid in-memory ticket without calling the server', async () => {
    const start = vi.fn();
    const cur = session();
    await expect(ensureCaptureSession(cur, start)).resolves.toEqual({ session: cur, renewed: false });
    expect(start).not.toHaveBeenCalled();
  });
  it('mints a fresh one when there is none, when it expired, or when it is within the expiry skew', async () => {
    const fresh = session({ ticket: 'NEW' });
    const start = vi.fn().mockResolvedValue(fresh);
    for (const cur of [null, session({ expiresAt: new Date(Date.now() - 1000).toISOString() }), session({ expiresAt: new Date(Date.now() + 2000).toISOString() })]) {
      await expect(ensureCaptureSession(cur, start)).resolves.toEqual({ session: fresh, renewed: true });
    }
    expect(start).toHaveBeenCalledTimes(3);
  });
  it('a renewal that fails surfaces the server error to the caller (which shows a useful message)', async () => {
    const err = { response: { status: 409 } };
    await expect(ensureCaptureSession(null, () => Promise.reject(err))).rejects.toBe(err);
    // and the reducer turns it into a visible error that keeps the chosen file for a retry
    const s = run([{ type: 'FILE_CHOSEN', file: new File([new Uint8Array(4)], 'a.jpg', { type: 'image/jpeg' }), idempotencyKey: 'k-12345678' }, { type: 'UPLOAD_STARTED' }, { type: 'SESSION_FAILED', message: 'Could not start' }]);
    expect(s).toMatchObject({ uploading: false, session: null, error: { kind: 'SESSION', message: 'Could not start' } });
    expect(s.file).not.toBeNull();
  });
  it('an expired ticket reads as a retry, never as "start a new session"', () => {
    const s = run([{ type: 'SESSION_EXPIRED' }]);
    expect(s.error?.message).not.toMatch(/new session|Start/i);
  });
  it('the capture code still never touches persistent browser storage', () => {
    const dir = path.resolve(__dirname, '../pages/Photography');
    for (const f of ['PhotographyCapturePage.tsx', 'captureWorkflow.ts', 'photographyApi.ts', 'StationCameraPanel.tsx']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});

describe('camera panel', () => {
  const ready = deriveCameraView(station());
  it('shows the selected camera as connected, with no picker for a single camera', () => {
    const out = panel(ready);
    expect(out).toContain('Integrated Camera'); expect(out).toContain('Connected'); expect(out).not.toContain('<select'); expect(out).not.toContain('Change camera');
  });
  it('several cameras: shows the selected one with Change camera, the picker only opens on demand', () => {
    const v = deriveCameraView(station({ cameras: rep([cam(WEBCAM, { selected: true }), cam('webcam:2', { displayName: 'USB Camera' })], { selectedId: WEBCAM }) }));
    const out = panel(v);
    expect(out).toContain('Change camera'); expect(out).toContain('Integrated Camera'); expect(out).not.toContain('<select');
  });
  it('Capture Photo waits for a tag, and says so', () => {
    const out = panel(ready, { tagReady: false });
    expect(out).toMatch(/<button[^>]*disabled/); expect(out).toContain('Scan a tag to capture.');
    expect(panel(ready, { tagReady: true })).not.toMatch(/<button[^>]*disabled/);
  });
  it('a missing selected camera shows Disconnected and is never swapped', () => {
    const v = deriveCameraView(station({ cameras: rep([cam(WEBCAM, { selected: true, available: false }), cam('webcam:2', { displayName: 'USB Camera' })], { selectedId: WEBCAM }) }));
    expect(v.state).toBe('DISCONNECTED');
    expect(panel(v)).toContain('not replaced automatically');
  });
});

describe('progress + saved state', () => {
  it('uses the operator stages Queued -> Camera accepted -> Capturing and uploading -> Complete', () => {
    expect(REMOTE_STAGE_LABEL.WAITING).toMatch(/^Queued/);
    expect(REMOTE_STAGE_LABEL.ACCEPTED).toMatch(/^Camera accepted/);
    expect(REMOTE_STAGE_LABEL.CAPTURING).toMatch(/^Capturing and uploading/);
    expect(REMOTE_STAGE_LABEL.DONE).toBe('Complete');
  });
  it('the saved banner confirms the photo and makes Next the action', () => {
    const out = renderToStaticMarkup(<PhotoSavedBanner image={img()} onNext={() => undefined} />);
    expect(out).toContain('Photo saved'); expect(out).toContain('Next'); expect(out).toContain('PRIMARY');
  });
  it('mentions a replaced primary only when the server reported one', () => {
    expect(renderToStaticMarkup(<PhotoSavedBanner image={img()} replacedPrimary onNext={() => undefined} />)).toContain('replaced the previous primary');
    expect(renderToStaticMarkup(<PhotoSavedBanner image={img()} onNext={() => undefined} />)).not.toContain('replaced');
  });
});

describe('Capture page, before any tag is scanned', () => {
  it('shows the camera at the top (station auto-selected), the scan field, and no session/expiry wording', () => {
    const out = page([station()]);
    expect(out).toContain('Integrated Camera'); expect(out).toContain('Connected'); expect(out).toContain('Capture Photo');
    expect(out).toContain('aria-label="Tag number"'); expect(out).toContain('Capture: Scan a tag');
    expect(out).not.toMatch(/expires in|Capture session|capture session|Start capture/i);
    expect(out).not.toContain('<select'); // one station, one camera: nothing to choose
  });
  it('with several stations, asks once via a native select', () => {
    const out = page([station(), station({ id: 's2', name: 'Bench 2' })]);
    expect(out).toContain('<select'); expect(out).toContain('Select a station…'); expect(out).not.toContain('Capture Photo');
  });
  it('an offline bridge shows the camera as unavailable but the page still renders and the scan field works', () => {
    const out = page([station({ lastSeenAt: null, cameras: null })]);
    expect(out).toContain('Station camera offline'); expect(out).toContain('aria-label="Tag number"');
  });
  it('a missing station list does not break the page', () => {
    expect(page(undefined)).toContain('aria-label="Tag number"');
  });
});
