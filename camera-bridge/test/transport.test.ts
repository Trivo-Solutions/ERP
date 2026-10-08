import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { createCameraProvider } from '../src/camera/createProvider';
import { CameraError } from '../src/camera/types';
import { SonyBackend, SonyBackendError } from '../src/camera/sony/SonyBackend';
import { SonyCameraProvider } from '../src/camera/sony/SonyCameraProvider';
import { loadConfig } from '../src/config';
import { classifyStatus, HEARTBEAT_PATH, HttpErpTransport, HeartbeatPayload } from '../src/erpTransport';
import { HeartbeatScheduler } from '../src/heartbeat';
import { createLogger } from '../src/logger';

const SECRET = 'stn_abc123.SECRET-VALUE-DO-NOT-LOG';
const payload: HeartbeatPayload = { stationId: 'ST-1', bridgeVersion: '0.1.0', cameraState: 'CONNECTED', timestamp: new Date().toISOString() };

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server | null = null;
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
async function closeServer() {
  if (!server) return;
  const s = server; server = null;
  s.closeAllConnections?.();
  await new Promise((r) => s.close(r));
}
afterEach(closeServer);

describe('HttpErpTransport', () => {
  it('POSTs the adapted payload with a Bearer credential and nothing secret elsewhere', async () => {
    const { url, seen } = await serve((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true}'); });
    const r = await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload, SECRET);
    expect(r).toEqual({ ok: true });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe(HEARTBEAT_PATH);
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(seen[0].body)).toEqual({ stationId: 'ST-1', bridgeVersion: '0.1.0', cameraStatus: 'CONNECTED', clientTimestamp: payload.timestamp });
    expect(seen[0].body).not.toContain(SECRET);
    expect(seen[0].url).not.toContain(SECRET);
  });

  it.each([[401, 'AUTH'], [403, 'AUTH'], [400, 'REJECTED'], [409, 'REJECTED'], [404, 'REJECTED'], [500, 'SERVER'], [503, 'SERVER'], [429, 'SERVER']])(
    'status %i -> %s', async (status, kind) => {
      const { url } = await serve((_q, res) => { res.writeHead(status); res.end(); });
      expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload, SECRET)).toEqual({ ok: false, kind });
    });

  it('does not follow redirects (credential must not be re-sent)', async () => {
    const { url, seen } = await serve((_q, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }); res.end(); });
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload, SECRET)).toEqual({ ok: false, kind: 'REJECTED' });
    expect(seen).toHaveLength(1);
  });

  it('network failure -> NETWORK', async () => {
    const { url } = await serve((_q, res) => res.end());
    await closeServer(); // port now closed
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload, SECRET)).toEqual({ ok: false, kind: 'NETWORK' });
  });

  it('timeout -> NETWORK', async () => {
    const { url } = await serve(() => { /* never respond */ });
    const t0 = Date.now();
    expect(await new HttpErpTransport({ apiUrl: url, timeoutMs: 150 }).sendHeartbeat(payload, SECRET)).toEqual({ ok: false, kind: 'NETWORK' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a failed TLS handshake (https to a non-TLS port) is a transport failure, never a success', async () => {
    const { url } = await serve((_q, res) => res.end('x'));
    const port = new URL(url).port;
    expect(await new HttpErpTransport({ apiUrl: `https://localhost:${port}` }).sendHeartbeat(payload, SECRET)).toEqual({ ok: false, kind: 'NETWORK' });
  });

  it('enforces https except localhost; rejects URLs carrying credentials/query', () => {
    expect(() => new HttpErpTransport({ apiUrl: 'http://erp.example.com' })).toThrow();
    expect(() => new HttpErpTransport({ apiUrl: 'https://u:p@erp.example.com' })).toThrow();
    expect(() => new HttpErpTransport({ apiUrl: 'https://erp.example.com?token=x' })).toThrow();
    expect(() => new HttpErpTransport({ apiUrl: 'https://erp.example.com' })).not.toThrow();
    expect(() => new HttpErpTransport({ apiUrl: 'http://localhost:3000' })).not.toThrow();
  });

  it('source never disables TLS verification', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'erpTransport.ts'), 'utf8');
    expect(src).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity/);
  });

  it('classifyStatus', () => {
    expect(classifyStatus(204)).toEqual({ ok: true });
    expect(classifyStatus(0)).toEqual({ ok: false, kind: 'REJECTED' });
  });
});

describe('scheduler over the real transport', () => {
  async function run(status: number | 'drop') {
    const { url, seen } = await serve((req, res) => { if (status === 'drop') { req.socket.destroy(); return; } res.writeHead(status); res.end(); });
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    const hb = new HeartbeatScheduler(
      { stationId: 'ST-1', bridgeVersion: '0.1.0', intervalMs: 300, baseBackoffMs: 30, maxBackoffMs: 120, random: () => 0.5 },
      new CameraController(new MockCameraProvider(), log), { kind: 'dev-env', load: async () => SECRET, save: async () => {} },
      new HttpErpTransport({ apiUrl: url }), log,
    );
    return { hb, seen, lines };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  afterEach(() => vi.useRealTimers());

  it.each([401, 403])('%i -> AUTH_FAILED and stops', async (s) => {
    const { hb, seen } = await run(s); hb.start(); await wait(700);
    expect(hb.getStatus().state).toBe('AUTH_FAILED'); expect(seen).toHaveLength(1);
  });
  it('400 (e.g. station id mismatch) -> CONFIG_REJECTED and stops', async () => {
    const { hb, seen } = await run(400); hb.start(); await wait(700);
    expect(hb.getStatus().state).toBe('CONFIG_REJECTED'); expect(seen).toHaveLength(1);
  });
  it.each([500, 'drop' as const])('%s retries with backoff', async (s) => {
    const { hb, seen } = await run(s); hb.start(); await wait(700); hb.stop();
    expect(seen.length).toBeGreaterThan(2); expect(hb.getStatus().state).toBe('RETRYING');
  });
  it('200 reports OK and keeps scheduling; secret never logged', async () => {
    const { hb, seen, lines } = await run(200); hb.start(); await wait(1000); hb.stop();
    expect(hb.getStatus().state).toBe('OK'); expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('Sony provider foundation', () => {
  const shot = { data: Buffer.from([0xff, 0xd8, 0xff, 1]), mimeType: 'image/jpeg', width: 10, height: 5 };
  const backend = (over: Partial<SonyBackend> = {}): SonyBackend => ({
    listDevices: async () => [{ id: 'A1', model: 'ILCE-7RM5', connection: 'usb' }], connect: async () => {}, close: async () => {}, shootAndFetch: async () => shot, ...over,
  });

  it('config accepts sony; factory returns the Sony provider; mock stays default', () => {
    const env = { TRIVO_API_URL: 'https://e.example.com', STATION_ID: 'S1' };
    expect(loadConfig(env as never).cameraProvider).toBe('mock');
    expect(loadConfig({ ...env, CAMERA_PROVIDER: 'sony' } as never).cameraProvider).toBe('sony');
    expect(createCameraProvider('sony')).toBeInstanceOf(SonyCameraProvider);
    expect(createCameraProvider('mock')).toBeInstanceOf(MockCameraProvider);
  });

  it('lifecycle: DISCONNECTED -> CONNECTING -> CONNECTED -> CAPTURING -> CONNECTED -> DISCONNECTED', async () => {
    let release!: () => void;
    let releaseShot!: () => void;
    const p = new SonyCameraProvider({ backend: backend({
      connect: () => new Promise<void>((r) => (release = r)),
      shootAndFetch: () => new Promise((r) => (releaseShot = () => r(shot))),
    }) });
    expect((await p.getStatus()).state).toBe('DISCONNECTED');
    const c = p.connect(); expect((await p.getStatus()).state).toBe('CONNECTING'); await new Promise((r) => setTimeout(r, 5)); release(); await c;
    expect((await p.getStatus()).state).toBe('CONNECTED');
    const s = p.capture({ correlationId: 'x' }); expect((await p.getStatus()).state).toBe('CAPTURING'); releaseShot();
    const img = await s;
    expect(img).toMatchObject({ mimeType: 'image/jpeg', width: 10, height: 5 });
    expect(img.filename).toMatch(/^cam-\d+\.jpg$/);
    expect((await p.getStatus()).state).toBe('CONNECTED');
    await p.disconnect(); expect((await p.getStatus()).state).toBe('DISCONNECTED');
  });

  it('default (no SDK helper): connect fails into a neutral ERROR with no vendor text', async () => {
    const p = new SonyCameraProvider();
    await expect(p.connect()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    const s = await p.getStatus();
    expect(s).toMatchObject({ state: 'ERROR', errorCode: 'DRIVER_UNAVAILABLE' });
    expect(JSON.stringify(s)).not.toMatch(/sony|sdk|crsdk/i);
    await expect(p.capture({ correlationId: 'x' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('normalizes vendor and unknown capture failures; raw exception text is not exposed', async () => {
    const p = new SonyCameraProvider({ backend: backend({ shootAndFetch: async () => { throw new SonyBackendError('TRANSFER_FAILED', 'CrError 0x8704 C:/secret/path'); } }) });
    await p.connect();
    const e = (await p.capture({ correlationId: 'x' }).catch((x) => x)) as CameraError;
    expect(e).toBeInstanceOf(CameraError); expect(e.code).toBe('CAPTURE_FAILED'); expect(e.message).not.toMatch(/0x8704|secret/);
    expect((await p.getStatus()).state).toBe('ERROR');
    const q = new SonyCameraProvider({ backend: backend({ shootAndFetch: async () => { throw new Error('boom /etc/passwd'); } }) });
    await q.connect();
    expect(((await q.capture({ correlationId: 'y' }).catch((x) => x)) as Error).message).toBe('Capture failed');
  });

  it('rejects overlapping capture as BUSY', async () => {
    let release!: () => void;
    const p = new SonyCameraProvider({ backend: backend({ shootAndFetch: () => new Promise((r) => (release = () => r(shot))) }) });
    await p.connect();
    const first = p.capture({ correlationId: 'a' });
    await expect(p.capture({ correlationId: 'b' })).rejects.toMatchObject({ code: 'BUSY' });
    release(); await first;
  });
});
