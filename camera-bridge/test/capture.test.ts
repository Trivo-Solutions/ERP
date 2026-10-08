import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { CaptureExecutor, CaptureExecutorOptions } from '../src/capture/captureExecutor';
import { CaptureTransport, classifyUploadFailure, HttpCaptureTransport, StatusReport, UploadOutcome, UploadRequest } from '../src/capture/captureTransport';
import { TempStore } from '../src/capture/tempStore';
import { parseCommand } from '../src/capture/types';
import { CredentialStore } from '../src/credentials';
import { createLogger } from '../src/logger';

const SECRET = 'stn_abc123.SECRET-VALUE-DO-NOT-LOG';
const STATION = 'MANIKONDA-PHOTO-01';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ticketFor = (sid = STATION, exp = Math.floor(Date.now() / 1000) + 600) => `${b64({ alg: 'HS256' })}.${b64({ sid, exp })}.c2ln${'x'.repeat(10)}`;
const cmd = (over: Record<string, unknown> = {}) => ({
  commandId: 'cmd1', correlationId: 'corr-1', stationId: STATION, imageType: 'PRIMARY', tagNumber: 'T-1',
  ticket: ticketFor(), expiresAt: new Date(Date.now() + 120_000).toISOString(), ...over,
});

class FakeTransport implements CaptureTransport {
  reports: Array<{ commandId: string; report: StatusReport }> = [];
  uploads: UploadRequest[] = [];
  reportResults: Array<{ ok: false; kind: 'NETWORK' | 'AUTH' | 'EXPIRED' | 'STATE' | 'REJECTED' | 'SERVER' }> = [];
  uploadResults: UploadOutcome[] = [];
  async pollCommand() { return { ok: true as const, command: null }; }
  async reportStatus(_s: string, commandId: string, report: StatusReport) {
    this.reports.push({ commandId, report });
    return this.reportResults.shift() ?? { ok: true as const };
  }
  async uploadImage(_s: string, req: UploadRequest): Promise<UploadOutcome> {
    this.uploads.push(req);
    return this.uploadResults.shift() ?? { ok: true, imageId: 'img-1', replay: false };
  }
  statuses() { return this.reports.map((r) => r.report.status + (r.report.status === 'FAILED' ? `:${r.report.code}${r.report.detail ? `/${r.report.detail}` : ''}` : '')); }
}

let dir: string;
let lines: string[];
let provider: MockCameraProvider;
let camera: CameraController;
let transport: FakeTransport;
let temp: TempStore;
let clock: number;
const creds: CredentialStore = { kind: 'dev-env', load: async () => SECRET, save: async () => undefined };

function build(over: Partial<CaptureExecutorOptions> = {}, store: CredentialStore = creds) {
  const log = createLogger({ sink: (l) => lines.push(l) });
  temp = new TempStore(dir, 60_000, log, () => clock);
  camera = new CameraController(provider, log);
  return new CaptureExecutor({ stationId: STATION, captureTimeoutMs: 1000, uploadTimeoutMs: 1000, uploadMaxAttempts: 3, uploadBackoffMs: 1, cameraLabel: 'mock', ...over }, camera, store, transport, temp, log);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-bridge-'));
  lines = []; transport = new FakeTransport(); clock = Date.now();
  provider = new MockCameraProvider();
  await provider.connect();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parseCommand', () => {
  it.each([
    [null], ['x'], [[]], [{}], [cmd({ commandId: '../x' })], [cmd({ imageType: 'NOPE' })], [cmd({ ticket: 'not-a-jwt' })],
    [cmd({ expiresAt: 'soon' })], [cmd({ correlationId: 'has space' })], [cmd({ tagNumber: 'x'.repeat(65) })],
  ])('rejects malformed command %#', (raw) => { expect(() => parseCommand(raw)).toThrow(); });
  it('accepts a well-formed command', () => { expect(parseCommand(cmd()).commandId).toBe('cmd1'); });
});

describe('command validation', () => {
  it('runs a valid command: ACCEPTED -> CAPTURING -> upload -> SUCCESS, and keeps nothing on disk', async () => {
    const r = await build().handle(cmd());
    expect(r).toMatchObject({ commandId: 'cmd1', correlationId: 'corr-1', code: 'SUCCESS', imageId: 'img-1' });
    expect(transport.statuses()).toEqual(['ACCEPTED', 'CAPTURING']);
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0]).toMatchObject({ imageType: 'PRIMARY', mimeType: 'image/png', correlationId: 'corr-1' });
    expect(transport.uploads[0].data.subarray(1, 4).toString()).toBe('PNG');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a command for another station is rejected without touching the camera', async () => {
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const r = await build().handle(cmd({ stationId: 'OTHER-STATION' }));
    expect(r).toMatchObject({ code: 'COMMAND_REJECTED', detail: 'WRONG_STATION' });
    expect(shots).toBe(0); expect(transport.uploads).toHaveLength(0);
  });

  it('a ticket addressed to another station is rejected', async () => {
    const r = await build().handle(cmd({ ticket: ticketFor('OTHER-STATION') }));
    expect(r).toMatchObject({ code: 'COMMAND_REJECTED', detail: 'TICKET_WRONG_STATION' });
  });

  it('an expired command is EXPIRED and never captures', async () => {
    const r = await build().handle(cmd({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(r).toMatchObject({ code: 'EXPIRED' });
    expect(transport.statuses()).toEqual(['FAILED:EXPIRED/COMMAND_EXPIRED']);
  });

  it('an expired ticket is EXPIRED', async () => {
    const r = await build().handle(cmd({ ticket: ticketFor(STATION, Math.floor(Date.now() / 1000) - 5) }));
    expect(r.code).toBe('EXPIRED');
  });

  it('a malformed command is COMMAND_REJECTED and nothing is sent', async () => {
    const r = await build().handle({ commandId: 'c9', nope: true });
    expect(r.code).toBe('COMMAND_REJECTED');
    expect(transport.reports).toHaveLength(0);
  });

  it('no stored credential -> AUTH_ERROR, no camera', async () => {
    const r = await build({}, { ...creds, load: async () => null }).handle(cmd());
    expect(r).toMatchObject({ code: 'AUTH_ERROR', detail: 'NOT_CONFIGURED' });
  });
});

describe('command idempotency', () => {
  it('the same command delivered twice (concurrently) captures once and returns the same result', async () => {
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const ex = build();
    const [a, b] = await Promise.all([ex.handle(cmd()), ex.handle(cmd())]);
    expect(shots).toBe(1); expect(transport.uploads).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('redelivery after completion returns the cached result, no second shutter, no second upload', async () => {
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const ex = build();
    const a = await ex.handle(cmd());
    const b = await ex.handle(cmd());
    expect(shots).toBe(1); expect(transport.uploads).toHaveLength(1); expect(b).toEqual(a);
  });

  it('the same commandId with a different payload is rejected, not executed', async () => {
    const ex = build();
    await ex.handle(cmd());
    const r = await ex.handle(cmd({ imageType: 'SIDE' }));
    expect(r).toMatchObject({ code: 'COMMAND_REJECTED', detail: 'COMMAND_ID_REUSED' });
    expect(transport.uploads).toHaveLength(1);
  });
});

describe('camera', () => {
  it('a camera failure is CAMERA_ERROR and is reported', async () => {
    provider.injectCaptureFailure();
    const r = await build().handle(cmd());
    expect(r).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_FAILED' });
    expect(transport.statuses()).toEqual(['ACCEPTED', 'CAPTURING', 'FAILED:CAMERA_ERROR/CAPTURE_FAILED']);
    expect(transport.uploads).toHaveLength(0);
  });

  it('a busy camera is BUSY (reported before the ERP is told the command was accepted)', async () => {
    provider = new MockCameraProvider({ captureDelayMs: 150 }); await provider.connect();
    const ex = build();
    const slow = camera.capture({ correlationId: 'other' }); // something else already holds the camera
    const r = await ex.handle(cmd());
    expect(r.code).toBe('BUSY');
    expect(transport.statuses()).toEqual(['FAILED:BUSY']);
    await slow;
  });

  it('a slow camera is CAMERA_ERROR / CAPTURE_TIMEOUT, not a network error, and the camera stays BUSY until it returns', async () => {
    provider = new MockCameraProvider({ captureDelayMs: 200 }); await provider.connect();
    const ex = build({ captureTimeoutMs: 30 });
    const r = await ex.handle(cmd());
    expect(r).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_TIMEOUT' });
    expect(camera.isBusy()).toBe(true);
    expect((await ex.handle(cmd({ commandId: 'cmd2' }))).code).toBe('BUSY'); // a second command cannot start a second capture
    await new Promise((res) => setTimeout(res, 250));
    expect(camera.isBusy()).toBe(false);
  });

  it('never captures unless the ERP acknowledged the command', async () => {
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    transport.reportResults = [{ ok: false, kind: 'NETWORK' }, { ok: false, kind: 'NETWORK' }]; // ACCEPTED fails, retry fails
    const r = await build().handle(cmd());
    expect(r).toMatchObject({ code: 'NETWORK_ERROR', detail: 'ERP_UNREACHABLE' });
    expect(shots).toBe(0);
  });

  it('a command the ERP says is no longer live (expired / wrong state) does not capture', async () => {
    transport.reportResults = [{ ok: false, kind: 'EXPIRED' }];
    expect((await build().handle(cmd())).code).toBe('EXPIRED');
    transport.reportResults = [{ ok: false, kind: 'STATE' }];
    expect((await build().handle(cmd({ commandId: 'cmd2' }))).code).toBe('COMMAND_REJECTED');
  });
});

describe('upload', () => {
  it('retries a recoverable failure with the SAME idempotency key, then succeeds and cleans up', async () => {
    transport.uploadResults = [{ ok: false, kind: 'NETWORK', retryable: true }, { ok: false, kind: 'SERVER', retryable: true }];
    const r = await build().handle(cmd());
    expect(r.code).toBe('SUCCESS');
    expect(transport.uploads).toHaveLength(3);
    expect(new Set(transport.uploads.map((u) => u.idempotencyKey)).size).toBe(1);
    expect(transport.uploads[0].idempotencyKey).toMatch(/^brg-[0-9a-f-]{36}$/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a fresh idempotency key is used for the next image', async () => {
    const ex = build();
    await ex.handle(cmd()); await ex.handle(cmd({ commandId: 'cmd2' }));
    expect(transport.uploads[0].idempotencyKey).not.toBe(transport.uploads[1].idempotencyKey);
  });

  it('keeps ticket, idempotency key, correlation id and command id distinct', async () => {
    await build().handle(cmd());
    const u = transport.uploads[0];
    expect(new Set([u.ticket, u.idempotencyKey, u.correlationId, 'cmd1']).size).toBe(4);
  });

  it('a server rejection is UPLOAD_ERROR, is not retried, and the image is discarded', async () => {
    transport.uploadResults = [{ ok: false, kind: 'REJECTED', retryable: false }];
    const r = await build().handle(cmd());
    expect(r).toMatchObject({ code: 'UPLOAD_ERROR', detail: 'ERP_REJECTED', imageRetained: false });
    expect(transport.uploads).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(transport.statuses().at(-1)).toBe('FAILED:UPLOAD_ERROR/ERP_REJECTED');
  });

  it('exhausted network failure is NETWORK_ERROR; the image is retained (not lost) until the retention window passes', async () => {
    transport.uploadResults = Array(3).fill({ ok: false, kind: 'NETWORK', retryable: true });
    const r = await build().handle(cmd());
    expect(r).toMatchObject({ code: 'NETWORK_ERROR', detail: 'ERP_UNREACHABLE', imageRetained: true });
    expect(transport.uploads).toHaveLength(3);
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect(files.every((f) => /^cap-[0-9a-f-]{36}\.(png|json)$/.test(f))).toBe(true); // generated names only
    expect(JSON.stringify(files.map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')))).not.toContain('eyJ'); // no ticket on disk
    foreign('keep.txt');
    clock += 30_000; expect(await temp.sweep()).toBe(0); // inside the window
    clock += 31_000; expect(await temp.sweep()).toBe(1); // past it: discarded
    expect(fs.readdirSync(dir)).toEqual(['keep.txt']);     // and only our own files are ever touched
  });

  it('an upload timeout is NETWORK_ERROR / UPLOAD_TIMEOUT (distinct from CAPTURE_TIMEOUT)', async () => {
    transport.uploadResults = Array(3).fill({ ok: false, kind: 'NETWORK', retryable: true, timedOut: true });
    expect(await build().handle(cmd())).toMatchObject({ code: 'NETWORK_ERROR', detail: 'UPLOAD_TIMEOUT' });
  });

  it('an expired ticket at upload is EXPIRED; a refused credential is AUTH_ERROR; neither is retried', async () => {
    transport.uploadResults = [{ ok: false, kind: 'EXPIRED', retryable: false }];
    expect(await build().handle(cmd())).toMatchObject({ code: 'EXPIRED', detail: 'TICKET_EXPIRED' });
    transport.uploadResults = [{ ok: false, kind: 'AUTH', retryable: false }];
    expect(await build().handle(cmd({ commandId: 'cmd2' }))).toMatchObject({ code: 'AUTH_ERROR' });
    expect(transport.uploads).toHaveLength(2);
  });

  it('never logs the credential, the ticket or image bytes', async () => {
    transport.uploadResults = [{ ok: false, kind: 'NETWORK', retryable: true }];
    const c = cmd();
    await build().handle(c);
    const all = lines.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(c.ticket);
    expect(all).not.toContain('PNG');
    expect(all).toContain('corr-1');
  });
});

function foreign(name: string) { fs.writeFileSync(path.join(dir, name), 'not ours'); }

describe('classifyUploadFailure', () => {
  it.each([
    [401, 'TICKET_EXPIRED', 'EXPIRED', false], [401, 'COMMAND_EXPIRED', 'EXPIRED', false], [401, 'STATION_AUTH_REQUIRED', 'AUTH', false],
    [403, 'CREDENTIAL_INVALID', 'AUTH', false], [500, undefined, 'SERVER', true], [502, undefined, 'SERVER', true], [429, undefined, 'SERVER', true],
    [400, undefined, 'REJECTED', false], [409, 'COMMAND_STATE', 'REJECTED', false], [413, undefined, 'REJECTED', false],
  ] as const)('%i %s -> %s retryable=%s', (status, code, kind, retryable) => {
    expect(classifyUploadFailure(status, code)).toEqual({ ok: false, kind, retryable });
  });
});

describe('HttpCaptureTransport', () => {
  let server: http.Server | null = null;
  afterEach(async () => { if (server) { server.closeAllConnections?.(); await new Promise((r) => server!.close(r)); server = null; } });
  async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void) {
    const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { const body = Buffer.concat(chunks); seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
  }
  const json = (res: http.ServerResponse, status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const req: UploadRequest = {
    ticket: ticketFor(), imageType: 'SIDE', idempotencyKey: 'brg-key-12345678', correlationId: 'corr-1', data: Buffer.from('PNGDATA'),
    mimeType: 'image/png', capturedAt: new Date().toISOString(), cameraLabel: 'mock', timeoutMs: 2000,
  };

  it('uploads multipart with ticket / imageType / idempotencyKey / file and NO authority fields', async () => {
    const { url, seen } = await serve((_q, res) => json(res, 201, { success: true, data: { image: { id: 'img-9' } } }));
    const out = await new HttpCaptureTransport({ apiUrl: url }).uploadImage(SECRET, req);
    expect(out).toEqual({ ok: true, imageId: 'img-9', replay: false });
    expect(seen[0].method).toBe('POST'); expect(seen[0].url).toBe('/api/v1/photography/images');
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0].headers['x-correlation-id']).toBe('corr-1');
    const body = seen[0].body.toString('latin1');
    for (const n of ['ticket', 'imageType', 'idempotencyKey', 'file']) expect(body).toContain(`name="${n}"`);
    for (const n of ['companyId', 'branchId', 'userId', 'storageKey', 'stationId', 'tagId', 'bucket']) expect(body).not.toContain(`name="${n}"`);
    expect(body).not.toContain(SECRET);
    expect(seen[0].url).not.toContain(SECRET);
  });

  it('200 is an idempotent replay (success); 2xx without an image is NOT success', async () => {
    let n = 0;
    const { url } = await serve((_q, res) => (n++ === 0 ? json(res, 200, { success: true, data: { image: { id: 'i' } } }) : json(res, 201, { success: true, data: {} })));
    const t = new HttpCaptureTransport({ apiUrl: url });
    expect(await t.uploadImage(SECRET, req)).toEqual({ ok: true, imageId: 'i', replay: true });
    expect(await t.uploadImage(SECRET, req)).toMatchObject({ ok: false, retryable: true });
  });

  it('classifies HTTP errors by the ERP code, and network failure / timeout as retryable', async () => {
    const { url } = await serve((_q, res) => json(res, 401, { success: false, code: 'TICKET_EXPIRED' }));
    expect(await new HttpCaptureTransport({ apiUrl: url }).uploadImage(SECRET, req)).toEqual({ ok: false, kind: 'EXPIRED', retryable: false });
    await new Promise((r) => { server!.closeAllConnections?.(); server!.close(r); }); server = null;
    expect(await new HttpCaptureTransport({ apiUrl: url }).uploadImage(SECRET, req)).toMatchObject({ ok: false, kind: 'NETWORK', retryable: true });
    const slow = await serve(() => undefined);
    expect(await new HttpCaptureTransport({ apiUrl: slow.url }).uploadImage(SECRET, { ...req, timeoutMs: 50 })).toMatchObject({ ok: false, kind: 'NETWORK', retryable: true, timedOut: true });
  });

  it('polls with the credential in the header only and reads the command', async () => {
    const { url, seen } = await serve((_q, res) => json(res, 200, { success: true, data: { command: { commandId: 'c' } } }));
    expect(await new HttpCaptureTransport({ apiUrl: url }).pollCommand(SECRET, 5)).toEqual({ ok: true, command: { commandId: 'c' } });
    expect(seen[0].url).toBe('/api/v1/photography/stations/commands/next?waitSeconds=5');
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('refuses a non-https, non-localhost URL', () => {
    expect(() => new HttpCaptureTransport({ apiUrl: 'http://erp.example.com' })).toThrow();
  });
});
