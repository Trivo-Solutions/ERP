import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), post: vi.fn() }));
vi.mock('../api/client', () => ({
  api: { delete: vi.fn(), post: h.post },
  apiGet: h.apiGet,
  apiPost: h.apiPost,
  apiPut: vi.fn(),
}));

import {
  PhotoTypeSelector, StationPicker, SelectedPhotoPreview,
} from '../pages/Photography/PhotographyCapturePage';
import {
  IMAGE_TYPES, buildUploadForm, listStations, lookupTag, startCaptureSession, uploadImage,
  type CaptureSession, type PhotographyStation, type PhotographyTag, type TagImage, type UploadResult,
} from '../pages/Photography/photographyApi';
import {
  captureReducer, deriveStep, initialCaptureState, isSessionExpired, formatRemaining, newIdempotencyKey,
  validateImageFile, isTicketExpiredError, uploadError, sessionErrorMessage, UX_MAX_FILE_BYTES,
  type CaptureState,
} from '../pages/Photography/captureWorkflow';

const station = (o: Partial<PhotographyStation> = {}): PhotographyStation => ({
  id: 's1', name: 'Bench 1', branchId: 'b1', branchName: 'Main Branch', isActive: true, lastSeenAt: null, cameras: null, ...o,
});
const tag: PhotographyTag = {
  id: 't1', tagNumber: 'TAG-1', name: 'Ring', status: 'IN_STOCK', metalType: 'GOLD', metalKarat: '22K', grossWeight: '5', netWeight: '4',
  branch: { id: 'b1', name: 'Main Branch' }, category: null,
  photography: { imageCount: 0, hasPrimary: false, primaryImageId: null, lastCapturedAt: null },
};
const session = (o: Partial<CaptureSession> = {}): CaptureSession => ({
  sessionId: 'sess1', ticket: 'TICKET.JWT.VALUE', expiresAt: new Date(Date.now() + 900_000).toISOString(), expiresInSeconds: 900,
  stationId: 's1', tagId: 't1', tagNumber: 'TAG-1', operations: ['upload'], captureSource: 'DEVICE_CAMERA',
  tag: { id: 't1', tagNumber: 'TAG-1' }, station: { id: 's1', name: 'Bench 1' }, ...o,
});
const img = (o: Partial<TagImage> = {}): TagImage => ({
  id: 'i1', tagId: 't1', imageType: 'PRIMARY', isPrimary: true, reviewStatus: null, uploadStatus: 'CONFIRMED', processingStatus: 'READY',
  originalFilename: 'a.jpg', mimeType: 'image/jpeg', width: 1, height: 1, sizeBytes: 1, captureSource: 'DEVICE_CAMERA', cameraLabel: null,
  capturedAt: '2026-10-08T05:00:00Z', createdAt: '2026-10-08T05:00:00Z', station: null, variants: { original: true, optimized: true, thumbnail: true }, ...o,
});
const result = (o: Partial<UploadResult> = {}): UploadResult => ({ image: img(), idempotentReplay: false, replacedPrimaryImageId: null, ...o });
const file = (name = 'p.jpg', type = 'image/jpeg', bytes = 10) => new File([new Uint8Array(bytes)], name, { type });
const run = (actions: Parameters<typeof captureReducer>[1][], from: CaptureState = initialCaptureState) => actions.reduce(captureReducer, from);

beforeEach(() => { h.apiGet.mockReset(); h.apiPost.mockReset(); h.post.mockReset(); });

describe('capture: tag + stations', () => {
  it('tag lookup success and failure', async () => {
    h.apiGet.mockResolvedValueOnce(tag);
    await expect(lookupTag('TAG-1')).resolves.toBe(tag);
    h.apiGet.mockRejectedValueOnce({ response: { status: 404, data: { error: 'Tag not found' } } });
    await expect(lookupTag('NOPE')).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('loads stations from the stations endpoint', async () => {
    h.apiGet.mockResolvedValue([station()]);
    await expect(listStations()).resolves.toHaveLength(1);
    expect(h.apiGet).toHaveBeenCalledWith('/photography/stations');
  });

  it('shows a clear state when no station is usable for the tag branch', () => {
    const html = renderToStaticMarkup(<StationPicker stations={[station({ branchId: 'other' }), station({ id: 's2', isActive: false })]} tag={tag} onSelect={() => {}} />);
    expect(html).toContain('No capture station is available');
  });

  it('lists same-branch stations with name, branch and status — never "offline" from lastSeenAt', () => {
    const html = renderToStaticMarkup(<StationPicker stations={[station()]} tag={tag} selectedId="s1" onSelect={() => {}} />);
    for (const t of ['Bench 1', 'Main Branch', 'Active']) expect(html).toContain(t);
    expect(html.toLowerCase()).not.toContain('offline');
  });

  it('selecting a station stores it; a different station discards the old session', () => {
    let s = run([{ type: 'SELECT_STATION', station: station() }, { type: 'SESSION_STARTED', session: session() }]);
    expect(s.station?.id).toBe('s1');
    expect(s.session).not.toBeNull();
    s = run([{ type: 'SELECT_STATION', station: station({ id: 's2' }) }], s);
    expect(s.session).toBeNull();
  });
});

describe('capture: session', () => {
  it('sends the station id, tag id and DEVICE_CAMERA source — nothing else', async () => {
    h.apiPost.mockResolvedValue(session());
    await startCaptureSession('t1', 's1');
    expect(h.apiPost).toHaveBeenCalledWith('/photography/capture-sessions', { tagId: 't1', stationId: 's1', captureSource: 'DEVICE_CAMERA' });
  });

  it('keeps the session response in runtime state only', () => {
    const s = run([{ type: 'SESSION_STARTED', session: session() }]);
    expect(s.session?.ticket).toBe('TICKET.JWT.VALUE');
    // The capture code must not touch any persistent browser storage.
    const dir = path.resolve(__dirname, '../pages/Photography');
    for (const f of ['PhotographyCapturePage.tsx', 'captureWorkflow.ts', 'photographyApi.ts']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it('a failed session clears the ticket and shows a generic message', () => {
    const s = run([{ type: 'SESSION_FAILED', message: sessionErrorMessage({ response: { status: 409, data: { error: 'internal branch detail' } } }) }]);
    expect(s.session).toBeNull();
    expect(s.error?.message).not.toContain('internal branch detail');
    expect(deriveStep({ tagLoading: false, hasTag: true, tagError: false, state: s })).toBe('ERROR');
  });

  it('detects an expired ticket before upload, with a safety margin', () => {
    expect(isSessionExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isSessionExpired({ expiresAt: new Date(Date.now() + 2000).toISOString() })).toBe(true);
    expect(isSessionExpired({ expiresAt: new Date(Date.now() + 600_000).toISOString() })).toBe(false);
    expect(formatRemaining(872_000)).toBe('14:32');
  });

  it('expiry drops the ticket but keeps the chosen file for a fresh session', () => {
    const f = file();
    const s = run([
      { type: 'SESSION_STARTED', session: session() }, { type: 'FILE_CHOSEN', file: f, idempotencyKey: 'k-12345678' }, { type: 'SESSION_EXPIRED' },
    ]);
    expect(s.session).toBeNull();
    expect(s.file).toBe(f);
    expect(s.error?.kind).toBe('SESSION_EXPIRED');
  });
});

describe('capture: photo + preview', () => {
  it('offers exactly the five backend photo types, PRIMARY first', () => {
    expect([...IMAGE_TYPES]).toEqual(['PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER']);
    const html = renderToStaticMarkup(<PhotoTypeSelector value="PRIMARY" onChange={() => {}} />);
    for (const t of IMAGE_TYPES) expect(html).toContain(t);
  });

  it('validates only lightweight things', () => {
    expect(validateImageFile(null)).toBeTruthy();
    expect(validateImageFile({ type: 'application/pdf', size: 10 })).toMatch(/not an image/);
    expect(validateImageFile({ type: 'image/jpeg', size: 0 })).toMatch(/empty/);
    expect(validateImageFile({ type: 'image/jpeg', size: UX_MAX_FILE_BYTES + 1 })).toMatch(/too large/);
    expect(validateImageFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
  });

  it('choosing a file stores it with a key but does not upload', () => {
    const s = run([{ type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'abc-12345678' }]);
    expect(s.file?.name).toBe('p.jpg');
    expect(s.uploading).toBe(false);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('preview shows name, size, selected type and the upload / choose-another actions', () => {
    const html = renderToStaticMarkup(<SelectedPhotoPreview file={{ name: 'ring.jpg', size: 2048 }} url="blob:x" photoType="SIDE" progress={null} uploading={false} onUpload={() => {}} onRetake={() => {}} />);
    for (const t of ['ring.jpg', '2.0 KB', 'SIDE', 'Upload', 'Choose another', 'blob:x']) expect(html).toContain(t);
  });

  it('disables both buttons while uploading', () => {
    const html = renderToStaticMarkup(<SelectedPhotoPreview file={{ name: 'a', size: 1 }} url={null} photoType="PRIMARY" progress={0.4} uploading onUpload={() => {}} onRetake={() => {}} />);
    expect(html.match(/<button[^>]*disabled/g)?.length).toBe(2);
    expect(html).toContain('40%');
  });
});

describe('capture: upload', () => {
  it('builds multipart with ticket, type, key and file — and no tenant/storage fields', () => {
    const f = file('ring.jpg');
    const form = buildUploadForm({ ticket: 'TKT', imageType: 'BACK', idempotencyKey: 'key-12345678', file: f });
    expect([...form.keys()].sort()).toEqual(['file', 'idempotencyKey', 'imageType', 'ticket']);
    expect(form.get('ticket')).toBe('TKT');
    expect(form.get('imageType')).toBe('BACK');
    expect(form.get('idempotencyKey')).toBe('key-12345678');
    expect((form.get('file') as File).name).toBe('ring.jpg');
    for (const bad of ['companyId', 'tenantId', 'branchId', 'userId', 'storageKey', 'bucket']) expect(form.has(bad)).toBe(false);
  });

  it('posts to /photography/images and reports progress', async () => {
    h.post.mockImplementation(async (_u, _f, cfg) => { cfg.onUploadProgress({ loaded: 5, total: 10 }); return { data: { data: result() } }; });
    const seen: number[] = [];
    const r = await uploadImage(new FormData(), (x) => seen.push(x));
    expect(h.post.mock.calls[0][0]).toBe('/photography/images');
    expect(seen).toEqual([0.5]);
    expect(r.image.id).toBe('i1');
  });

  it('generates distinct, server-valid idempotency keys (also without randomUUID)', () => {
    const a = newIdempotencyKey(); const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    const fallback = newIdempotencyKey({ getRandomValues: (arr: any) => { arr.fill(171); return arr; } } as any);
    for (const k of [a, fallback]) expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it('a duplicate UPLOAD_STARTED while uploading is ignored', () => {
    const base = run([{ type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'k-12345678' }, { type: 'UPLOAD_STARTED' }, { type: 'UPLOAD_PROGRESS', fraction: 0.5 }]);
    expect(captureReducer(base, { type: 'UPLOAD_STARTED' })).toBe(base);
  });

  it('a failed upload keeps file and key so a retry is idempotent', () => {
    const s = run([
      { type: 'SESSION_STARTED', session: session() }, { type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'same-key-123' },
      { type: 'UPLOAD_STARTED' }, { type: 'UPLOAD_FAILED', error: uploadError({}) },
    ]);
    expect(s.idempotencyKey).toBe('same-key-123');
    expect(s.file).not.toBeNull();
    expect(s.error?.kind).toBe('NETWORK');
    expect(s.session).not.toBeNull();
  });

  it('success clears the file/key, keeps the session for the next photo and exposes the result', () => {
    const s = run([
      { type: 'SESSION_STARTED', session: session() }, { type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'k-12345678' },
      { type: 'UPLOAD_STARTED' }, { type: 'UPLOAD_SUCCEEDED', result: result() },
    ]);
    expect(s.file).toBeNull();
    expect(s.idempotencyKey).toBeNull();
    expect(s.session).not.toBeNull();
    expect(s.result?.image.id).toBe('i1');
    expect(deriveStep({ tagLoading: false, hasTag: true, tagError: false, state: s })).toBe('SUCCESS');
  });

  it('classifies an expired ticket (401 naming the ticket) separately from other failures', () => {
    const expired = { response: { status: 401, data: { error: 'Capture ticket expired' } } };
    expect(isTicketExpiredError(expired)).toBe(true);
    expect(uploadError(expired).kind).toBe('SESSION_EXPIRED');
    expect(isTicketExpiredError({ response: { status: 401, data: { error: 'Unauthorized' } } })).toBe(false);
    expect(uploadError({ response: { status: 400, data: { error: 'Not a supported image' } } })).toEqual({ kind: 'UPLOAD', message: 'Not a supported image' });
    expect(uploadError({ response: { status: 500 } }).kind).toBe('NETWORK');
  });
});

describe('capture: step model + Next', () => {
  const step = (state: CaptureState, extra: Partial<Parameters<typeof deriveStep>[0]> = {}) =>
    deriveStep({ tagLoading: false, hasTag: true, tagError: false, state, ...extra });

  it('walks idle → tag → station → session → capture → uploading → success', () => {
    expect(deriveStep({ tagLoading: false, hasTag: false, tagError: false, state: initialCaptureState })).toBe('IDLE');
    expect(step(initialCaptureState, { tagLoading: true, hasTag: false })).toBe('TAG_LOADING');
    expect(step(initialCaptureState)).toBe('TAG_READY');
    let s = run([{ type: 'SELECT_STATION', station: station() }]);
    expect(step(s)).toBe('STATION_READY');
    s = run([{ type: 'SESSION_STARTING' }], s);
    expect(step(s)).toBe('SESSION_STARTING');
    s = run([{ type: 'SESSION_STARTED', session: session() }], s);
    expect(step(s)).toBe('CAPTURE_READY');
    s = run([{ type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'k-12345678' }, { type: 'UPLOAD_STARTED' }], s);
    expect(step(s)).toBe('UPLOADING');
  });

  it('Next (RESET) clears session, ticket, file, key, type, upload and station', () => {
    const dirty = run([
      { type: 'SELECT_STATION', station: station() }, { type: 'SESSION_STARTED', session: session() }, { type: 'SET_PHOTO_TYPE', photoType: 'BACK' },
      { type: 'FILE_CHOSEN', file: file(), idempotencyKey: 'k-12345678' }, { type: 'UPLOAD_STARTED' },
    ]);
    expect(captureReducer(dirty, { type: 'RESET' })).toEqual(initialCaptureState);
    expect(initialCaptureState.photoType).toBe('PRIMARY');
  });
});
