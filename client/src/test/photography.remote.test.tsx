import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), post: vi.fn() }));
vi.mock('../api/client', () => ({ api: { delete: vi.fn(), post: h.post }, apiGet: h.apiGet, apiPost: h.apiPost, apiPut: vi.fn() }));

import { StationPicker } from '../pages/Photography/PhotographyCapturePage';
import {
  createCaptureCommand, getCaptureCommand, startBridgeSession,
  type PhotographyStation, type PhotographyTag, type RemoteCommand, type TagImage,
} from '../pages/Photography/photographyApi';
import {
  STATION_ONLINE_WINDOW_MS, initialRemoteState, isStationOnline, remoteFailureMessage, remoteIsActive, remoteReducer, remoteRequestError,
} from '../pages/Photography/captureWorkflow';

const station = (o: Partial<PhotographyStation> = {}): PhotographyStation => ({
  id: 's1', name: 'Bench 1', branchId: 'b1', branchName: 'Main Branch', isActive: true, lastSeenAt: null, cameras: null, ...o,
});
const tag = { id: 't1', branch: { id: 'b1', name: 'Main Branch' } } as PhotographyTag;
const img = (o: Partial<TagImage> = {}): TagImage => ({
  id: 'i1', tagId: 't1', imageType: 'PRIMARY', isPrimary: true, reviewStatus: null, uploadStatus: 'CONFIRMED', processingStatus: 'READY',
  originalFilename: null, mimeType: 'image/png', width: 1, height: 1, sizeBytes: 1, captureSource: 'BRIDGE', cameraLabel: 'mock',
  capturedAt: '2026-10-08T05:00:00Z', createdAt: '2026-10-08T05:00:00Z', station: { id: 's1', name: 'Bench 1' },
  variants: { original: true, optimized: true, thumbnail: true }, ...o,
});
const cmd = (o: Partial<RemoteCommand> = {}): RemoteCommand => ({
  commandId: 'c1', status: 'QUEUED', stationId: 's1', tagId: 't1', imageType: 'PRIMARY', correlationId: 'k1',
  failureCode: null, failureDetail: null, expiresAt: new Date(Date.now() + 100_000).toISOString(), ...o,
});
const run = (actions: Parameters<typeof remoteReducer>[1][]) => actions.reduce(remoteReducer, initialRemoteState);

beforeEach(() => { h.apiGet.mockReset(); h.apiPost.mockReset(); });

describe('remote capture: API contract', () => {
  it('asks for a BRIDGE session with only tag + station + source', async () => {
    h.apiPost.mockResolvedValue({});
    await startBridgeSession('t1', 's1');
    expect(h.apiPost).toHaveBeenCalledWith('/photography/capture-sessions', { tagId: 't1', stationId: 's1', captureSource: 'BRIDGE' });
  });
  it('creates a command from the ticket and photo type alone (never company/branch/user/station/tag)', async () => {
    h.apiPost.mockResolvedValue(cmd());
    await createCaptureCommand('TICKET.JWT.VALUE', 'SIDE');
    expect(h.apiPost).toHaveBeenCalledWith('/photography/capture-commands', { ticket: 'TICKET.JWT.VALUE', imageType: 'SIDE' });
  });
  it('reads a command by id', async () => {
    h.apiGet.mockResolvedValue(cmd());
    await getCaptureCommand('c 1');
    expect(h.apiGet).toHaveBeenCalledWith('/photography/capture-commands/c%201');
  });
});

describe('remote capture: server-driven stages (no guessing from timeouts)', () => {
  it('walks Select -> Request -> Capture -> Uploading -> Processing -> Success from the server status', () => {
    expect(run([{ type: 'REQUESTING' }]).stage).toBe('REQUESTING');
    expect(run([{ type: 'REQUESTING' }, { type: 'COMMAND', command: cmd() }]).stage).toBe('WAITING');
    expect(run([{ type: 'COMMAND', command: cmd({ status: 'ACCEPTED' }) }]).stage).toBe('ACCEPTED');
    expect(run([{ type: 'COMMAND', command: cmd({ status: 'CAPTURING' }) }]).stage).toBe('CAPTURING');
    const proc = run([{ type: 'COMMAND', command: cmd({ status: 'UPLOADED', image: img({ processingStatus: 'PENDING' }) }) }]);
    expect(proc.stage).toBe('PROCESSING'); expect(remoteIsActive(proc)).toBe(true);
    const done = run([{ type: 'COMMAND', command: cmd({ status: 'UPLOADED', image: img() }) }]);
    expect(done).toMatchObject({ stage: 'DONE', commandId: 'c1' }); expect(done.image?.id).toBe('i1'); expect(remoteIsActive(done)).toBe(false);
  });

  it('a FAILED command shows the normalized reason and always points at the manual route', () => {
    const s = run([{ type: 'COMMAND', command: cmd({ status: 'FAILED', failureCode: 'CAMERA_ERROR', failureDetail: 'CAPTURE_TIMEOUT' }) }]);
    expect(s.stage).toBe('FAILED');
    expect(s.message).toMatch(/too long/);
    for (const code of ['BUSY', 'CAMERA_ERROR', 'NETWORK_ERROR', 'UPLOAD_ERROR', 'AUTH_ERROR', 'EXPIRED', 'COMMAND_REJECTED', 'WHATEVER', null]) {
      expect(remoteFailureMessage(code, null)).toMatch(/Take photo or Choose file/);
    }
    expect(run([{ type: 'COMMAND', command: cmd({ status: 'EXPIRED' }) }]).stage).toBe('FAILED');
  });

  it('ignores a late poll response for an abandoned command', () => {
    const s = run([{ type: 'COMMAND', command: cmd({ commandId: 'new' }) }, { type: 'COMMAND', command: cmd({ commandId: 'old', status: 'UPLOADED', image: img() }) }]);
    expect(s).toMatchObject({ stage: 'WAITING', commandId: 'new' });
  });

  it('RESET (Next / new tag) clears everything', () => {
    expect(run([{ type: 'COMMAND', command: cmd() }, { type: 'RESET' }])).toEqual(initialRemoteState);
  });

  it('a request that never became a command (offline / busy) surfaces the server reason', () => {
    expect(remoteRequestError({ response: { status: 409, data: { code: 'STATION_OFFLINE', error: 'x' } } })).toMatch(/offline/);
    expect(remoteRequestError({ response: { status: 409, data: { code: 'STATION_BUSY', error: 'x' } } })).toMatch(/already taking/);
    expect(remoteRequestError({})).toMatch(/Take photo or Choose file/);
    expect(run([{ type: 'REQUEST_FAILED', message: 'nope' }])).toMatchObject({ stage: 'FAILED', message: 'nope' });
  });
});

describe('remote capture: station availability + manual fallback', () => {
  it('a station is online only within the heartbeat window', () => {
    const now = Date.now();
    expect(isStationOnline({ lastSeenAt: null }, now)).toBe(false);
    expect(isStationOnline({ lastSeenAt: new Date(now - 10_000).toISOString() }, now)).toBe(true);
    expect(isStationOnline({ lastSeenAt: new Date(now - STATION_ONLINE_WINDOW_MS - 1000).toISOString() }, now)).toBe(false);
  });
  it('the station picker still lists a station with no recent heartbeat (selection and manual capture never need the bridge)', () => {
    const html = renderToStaticMarkup(<StationPicker stations={[station()]} tag={tag} onSelect={() => undefined} />);
    expect(html).toContain('Bench 1'); expect(html).not.toContain('Camera online'); expect(html).toContain('Active');
    const on = renderToStaticMarkup(<StationPicker stations={[station({ lastSeenAt: new Date().toISOString() })]} tag={tag} onSelect={() => undefined} />);
    expect(on).toContain('Camera online');
  });
});
