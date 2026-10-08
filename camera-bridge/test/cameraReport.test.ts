import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/bridge';
import { CameraController } from '../src/camera/CameraController';
import { CameraHub } from '../src/camera/CameraHub';
import { CameraSource, DiscoveredCamera } from '../src/camera/discovery';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { CredentialStore } from '../src/credentials';
import { ErpTransport, HeartbeatPayload, HttpErpTransport, TransportResult } from '../src/erpTransport';
import { HeartbeatScheduler } from '../src/heartbeat';
import { createLogger } from '../src/logger';

// Camera discovery goes to the ERP through the authenticated heartbeat, and a camera an ERP user picked comes back the same
// way. The browser never reaches the bridge, and the bridge re-validates anything it is handed.
const SECRET = 'station-secret-DO-NOT-LOG-123';
const store: CredentialStore = { kind: 'dev-env', load: async () => SECRET, save: async () => {} };
const quiet = createLogger({ sink: () => undefined });

class TwoCameraSource implements CameraSource {
  readonly kind = 'mock' as const;
  list: DiscoveredCamera[] = [
    { localId: 'a', displayName: 'Integrated Camera', available: true, placement: 'integrated' },
    { localId: 'b', displayName: 'USB Camera', available: true },
  ];
  async discover() { return this.list; }
  open() { return new MockCameraProvider(); }
}

describe('heartbeat reports cameras', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(result: TransportResult, getCameras?: () => Promise<any>, onCameraSelection?: (id: string) => Promise<void>) {
    const sent: HeartbeatPayload[] = [];
    const transport: ErpTransport = { sendHeartbeat: async (p) => { sent.push(p); return result; } };
    const hb = new HeartbeatScheduler(
      { stationId: 'S1', bridgeVersion: '1.0.0', intervalMs: 30_000, getCameras, onCameraSelection, random: () => 0.5 },
      new CameraController(new MockCameraProvider(), quiet), store, transport, quiet,
    );
    return { hb, sent };
  }

  it('includes the discovery result, and still beats when discovery fails', async () => {
    const listing = { cameras: [{ id: 'mock:a', displayName: 'Integrated Camera', kind: 'mock', available: true, selected: true }], selectedId: 'mock:a', selectionRequired: false };
    const a = setup({ ok: true }, async () => listing);
    a.hb.start(); await vi.advanceTimersByTimeAsync(0);
    expect(a.sent[0].cameras).toEqual(listing);
    a.hb.stop();
    const b = setup({ ok: true }, async () => { throw new Error('enumeration blew up'); });
    b.hb.start(); await vi.advanceTimersByTimeAsync(0);
    expect(b.sent).toHaveLength(1); expect(b.sent[0].cameras).toBeUndefined();
    b.hb.stop();
  });

  it('hands an ERP-requested camera to the handler, then reports back within a second instead of 30', async () => {
    const asked: string[] = [];
    const { hb, sent } = setup({ ok: true, cameraSelection: 'mock:b' }, async () => null, async (id) => { asked.push(id); });
    hb.start(); await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(['mock:b']);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    hb.stop();
  });

  it('a handler that throws never breaks or stops the heartbeat', async () => {
    const { hb, sent } = setup({ ok: true, cameraSelection: 'mock:b' }, async () => null, async () => { throw new Error('nope'); });
    hb.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    hb.stop();
  });
});

describe('Bridge applies an ERP-requested camera (through CameraHub.select, never anything else)', () => {
  const config = { apiUrl: 'https://erp.example.com', stationId: 'S1', cameraProvider: 'mock' as const, port: 0, heartbeatIntervalMs: 60_000, cameraOptions: {}, production: false, logLevel: 'info' as const, warnings: [] as string[] };
  let bridge: Bridge | null = null;
  afterEach(async () => { await bridge?.stop(); bridge = null; });

  async function boot(sendHeartbeat: ErpTransport['sendHeartbeat']) {
    const src = new TwoCameraSource();
    const hub = new CameraHub([src], quiet);
    bridge = new Bridge({ config, provider: hub, credentials: store, transport: { sendHeartbeat }, log: quiet });
    await bridge.start();
    return { hub, src };
  }
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('selects the requested camera and reports the new selection on the very next heartbeat', async () => {
    const seen: Array<string | null | undefined> = [];
    let first = true;
    const { hub } = await boot(async (p) => {
      seen.push(p.cameras?.selectedId);
      if (first) { first = false; return { ok: true, cameraSelection: 'mock:b' }; }
      return { ok: true };
    });
    expect((await hub.listCameras()).selectionRequired).toBe(true); // two usable cameras and none chosen: never guessed
    await settle();
    expect((await hub.listCameras()).selectedId).toBe('mock:b');
    expect(seen[0]).toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen).toContain('mock:b'); // the outcome reaches the ERP promptly
  });

  it('refuses an unknown or malformed id and changes nothing', async () => {
    const answers = ['mock:does-not-exist', 'http://evil/', '../../x', 'webcam:zzz'];
    let n = 0;
    const { hub } = await boot(async () => ({ ok: true, cameraSelection: answers[Math.min(n++, answers.length - 1)] }));
    await settle();
    expect((await hub.listCameras()).selectedId).toBeNull();
  });

  it('never switches away from a chosen camera to another one when it disappears', async () => {
    const { hub, src } = await boot(async () => ({ ok: true }));
    await hub.select('mock:a');
    src.list = [src.list[1]]; // the integrated camera is unplugged; the USB one remains
    const l = await hub.listCameras();
    expect(l.selectedId).toBe('mock:a');
    expect(l.cameras.find((c) => c.id === 'mock:a')).toMatchObject({ available: false, selected: true });
    expect(l.cameras.find((c) => c.id === 'mock:b')).toMatchObject({ selected: false });
  });
});

describe('HttpErpTransport: camera report out, requested camera in', () => {
  let server: http.Server; let url: string;
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  let respond: (res: http.ServerResponse) => void = (res) => res.end('{}');

  beforeEach(async () => {
    requests.length = 0;
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { requests.push({ headers: req.headers, body: JSON.parse(b) }); respond(res); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  const payload = (): HeartbeatPayload => ({
    stationId: 'S1', bridgeVersion: '1.0.0', cameraState: 'CONNECTED', timestamp: new Date().toISOString(),
    cameras: {
      cameras: [{ id: 'webcam:x', displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: true, placement: 'integrated', capabilities: { stillCapture: true, format: 'jpeg' } }],
      selectedId: 'webcam:x', selectionRequired: false,
    },
  });

  it('sends only the allow-listed camera fields (no capabilities, helper paths or anything else), credential only in the header', async () => {
    await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET);
    const { headers, body } = requests[0];
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers.origin).toBeUndefined();
    expect(body.cameras).toEqual({
      cameras: [{ id: 'webcam:x', displayName: 'Integrated Camera', available: true, selected: true, placement: 'integrated' }],
      selectedId: 'webcam:x', selectionRequired: false,
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('returns the requested camera from the answer, and nothing when there is none / the body is not JSON', async () => {
    respond = (res) => res.end(JSON.stringify({ success: true, data: { accepted: true, cameraSelection: { cameraId: 'webcam:y' } } }));
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET)).toEqual({ ok: true, cameraSelection: 'webcam:y' });
    respond = (res) => res.end(JSON.stringify({ success: true, data: { accepted: true, cameraSelection: null } }));
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET)).toEqual({ ok: true });
    respond = (res) => res.end('<html>not json</html>');
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET)).toEqual({ ok: true });
    respond = (res) => res.end(JSON.stringify({ data: { cameraSelection: { cameraId: 12345 } } }));
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET)).toEqual({ ok: true });
  });

  it('an error status is still classified as before, whatever the body says', async () => {
    respond = (res) => { res.statusCode = 403; res.end(JSON.stringify({ data: { cameraSelection: { cameraId: 'webcam:y' } } })); };
    expect(await new HttpErpTransport({ apiUrl: url }).sendHeartbeat(payload(), SECRET)).toEqual({ ok: false, kind: 'AUTH' });
  });
});

describe('default native helper locations', () => {
  it('resolve INSIDE the bridge package (<bridge>/native/...), not one directory above it', async () => {
    const path = await import('path');
    const { DEFAULT_HELPER, DEFAULT_WEBCAM_HELPER } = await import('../src/camera/createProvider');
    const root = path.resolve(__dirname, '..');
    expect(DEFAULT_WEBCAM_HELPER).toBe(path.join(root, 'native', 'webcam', 'trivo-webcam-helper.exe'));
    expect(DEFAULT_HELPER).toBe(path.join(root, 'native', 'sony', 'trivo-sony-helper.exe'));
  });
});
