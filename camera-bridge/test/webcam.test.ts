// Phase 5G: universal camera discovery + Windows webcam. No real camera is used anywhere in this file: the helper is the Node
// fixture test/fixtures/fakeWebcamHelper.js (same wire protocol as the native helper), and hub rules are tested against
// in-memory sources. The real native helper is covered by test/webcamNative.test.ts.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { CameraHub } from '../src/camera/CameraHub';
import { CameraSource } from '../src/camera/discovery';
import { createCameraProvider, createCameraSources } from '../src/camera/createProvider';
import { MockCameraSource } from '../src/camera/MockCameraSource';
import { parseProviderOptions } from '../src/camera/providerOptions';
import { FileSelectionStore, MemorySelectionStore, SelectionStore } from '../src/camera/selectionStore';
import { SonySource } from '../src/camera/sony/sonySource';
import { HelperWebcamBackend, resolveWebcamHelperPath } from '../src/camera/webcam/HelperWebcamBackend';
import { UnavailableWebcamBackend, WebcamBackendError } from '../src/camera/webcam/WebcamBackend';
import { WebcamCameraProvider } from '../src/camera/webcam/WebcamCameraProvider';
import { WebcamSource } from '../src/camera/webcam/webcamSource';
import { CameraError } from '../src/camera/types';
import { loadConfig } from '../src/config';
import { LocalApi } from '../src/localApi';
import { createLogger } from '../src/logger';

const FIX = path.resolve(__dirname, 'fixtures', 'fakeWebcamHelper.js');
const quiet = createLogger({ sink: () => undefined });
const INTEGRATED = { id: 'cam-aaaaaaaaaaaaaaaaaaaaaaaa', model: 'Integrated Camera', connection: 'usb', placement: 'integrated' };
const LOGITECH = { id: 'cam-bbbbbbbbbbbbbbbbbbbbbbbb', model: 'Logitech C920', connection: 'usb' };
const OTHER = { id: 'cam-cccccccccccccccccccccccc', model: 'Desk Camera', connection: 'usb' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string; let devFile: string; let logFile: string; let outDir: string;
const backends: HelperWebcamBackend[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-webcam-'));
  devFile = path.join(root, 'devices.json'); logFile = path.join(root, 'shots.log'); outDir = path.join(root, 'webcam-shots');
  setDevices([INTEGRATED]);
});
afterEach(async () => { for (const b of backends.splice(0)) await b.close().catch(() => undefined); fs.rmSync(root, { recursive: true, force: true }); });

function setDevices(d: unknown[]) { fs.writeFileSync(devFile, JSON.stringify(d)); }
const shots = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
function backendFactory(scenario = 'ok', opts: { opTimeoutMs?: number } = {}) {
  return () => {
    const b = new HelperWebcamBackend({ command: process.execPath, args: [FIX, `--scenario=${scenario}`, `--devices=${devFile}`, `--log=${logFile}`], outDir, readyTimeoutMs: 5000, opTimeoutMs: opts.opTimeoutMs ?? 5000 });
    backends.push(b);
    return b;
  };
}
function hubFor(scenario = 'ok', store: SelectionStore = new MemorySelectionStore()) {
  return new CameraHub([new WebcamSource({ makeBackend: backendFactory(scenario) })], quiet, store);
}

describe('discovery: laptop and USB webcams', () => {
  it('lists the integrated laptop camera with a neutral shape and selects it automatically (exactly one usable camera)', async () => {
    const hub = hubFor();
    const l = await hub.listCameras();
    expect(l.cameras).toEqual([{
      id: `webcam:${INTEGRATED.id}`, displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: true,
      placement: 'integrated', capabilities: { stillCapture: true, format: 'jpeg' },
    }]);
    expect(l).toMatchObject({ selectedId: `webcam:${INTEGRATED.id}`, selectionRequired: false });
    expect(JSON.stringify(l)).not.toMatch(/usb|vid_|helper|\.exe|MF_E/i);
  });

  it('with several cameras, shows them all and picks NONE by itself', async () => {
    setDevices([LOGITECH, INTEGRATED]);
    const hub = hubFor();
    const l = await hub.listCameras();
    expect(l.cameras.map((c) => c.displayName)).toEqual(['Integrated Camera', 'Logitech C920']);
    expect(l.cameras.every((c) => c.available && !c.selected)).toBe(true);
    expect(l).toMatchObject({ selectedId: null, selectionRequired: true });
    await hub.connect().catch(() => undefined);
    expect(await hub.getStatus()).toMatchObject({ state: 'DISCONNECTED', errorCode: 'CONFIG_ERROR' });
    await expect(hub.capture({ correlationId: 'c1' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(shots()).toHaveLength(0); // an ambiguous station never fires a shutter
  });

  it('no camera is not an ERP failure: status stays DISCONNECTED (not ERROR), listing is empty, capture says NOT_CONNECTED', async () => {
    setDevices([]);
    const hub = hubFor();
    expect(await hub.listCameras()).toEqual({ cameras: [], selectedId: null, selectionRequired: false });
    await hub.connect().catch(() => undefined);
    expect(await hub.getStatus()).toMatchObject({ state: 'DISCONNECTED', errorCode: 'NOT_CONNECTED' });
    await expect(hub.capture({ correlationId: 'c1' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('reports an unavailable Windows-camera entry (not a crash) when the helper is not installed', async () => {
    const hub = new CameraHub([new WebcamSource({ makeBackend: () => undefined })], quiet);
    const l = await hub.listCameras();
    expect(l.cameras).toEqual([{ id: 'webcam:unavailable', displayName: 'Windows camera', kind: 'webcam', available: false, selected: false, unavailableReason: 'DRIVER_UNAVAILABLE' }]);
    expect(l.selectionRequired).toBe(false);
    await expect(hub.select('webcam:unavailable')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
  });

  it('a helper that reports DRIVER_UNAVAILABLE gives the same unavailable entry', async () => {
    const hub = new CameraHub([new WebcamSource({ makeBackend: backendFactory('nodriver') })], quiet);
    expect((await hub.listCameras()).cameras[0]).toMatchObject({ available: false, unavailableReason: 'DRIVER_UNAVAILABLE' });
  });

  it('a helper that returns hostile device strings is killed, nothing is listed', async () => {
    const hub = new CameraHub([new WebcamSource({ makeBackend: backendFactory('dirtylist') })], quiet);
    expect((await hub.listCameras()).cameras).toEqual([]);
  });
});

describe('selection by stable id', () => {
  it('selection survives enumeration-order changes and a bridge restart (persisted), never by position', async () => {
    setDevices([INTEGRATED, LOGITECH]);
    const file = path.join(root, 'camera-selection.json');
    const hub = hubFor('ok', new FileSelectionStore(file));
    const picked = await hub.select(`webcam:${LOGITECH.id}`);
    expect(picked).toMatchObject({ selectedId: `webcam:${LOGITECH.id}`, selectionRequired: false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ id: `webcam:${LOGITECH.id}`, displayName: 'Logitech C920' });

    setDevices([LOGITECH, INTEGRATED]); // the OS now enumerates them the other way round
    const restarted = hubFor('ok', new FileSelectionStore(file));
    await restarted.connect();
    expect((await restarted.listCameras()).selectedId).toBe(`webcam:${LOGITECH.id}`);
    await restarted.capture({ correlationId: 'c1' });
    expect(shots()).toEqual([`shot ${LOGITECH.id}`]); // the helper bound the chosen camera, not index 0
  });

  it('refuses an unknown or malformed id and leaves the previous choice alone', async () => {
    setDevices([INTEGRATED, LOGITECH]);
    const hub = hubFor();
    await hub.select(`webcam:${LOGITECH.id}`);
    for (const bad of ['', 'cam-1', 'webcam:', 'webcam:../x', 'sony:nope', 'webcam:cam-zzzzzzzzzzzzzzzzzzzzzzzz', 'x'.repeat(200)]) {
      await expect(hub.select(bad)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect((await hub.listCameras()).selectedId).toBe(`webcam:${LOGITECH.id}`);
  });

  it('can return to automatic selection', async () => {
    setDevices([INTEGRATED, LOGITECH]);
    const store = new MemorySelectionStore();
    const hub = hubFor('ok', store);
    await hub.select(`webcam:${INTEGRATED.id}`);
    expect(store.load()?.id).toBe(`webcam:${INTEGRATED.id}`);
    expect(await hub.select(null)).toMatchObject({ selectedId: null, selectionRequired: true });
    expect(store.load()).toBeNull();
  });

  it('a corrupt or hand-edited selection file is ignored', () => {
    const file = path.join(root, 'sel.json');
    for (const junk of ['not json', '{"id":"../../etc/passwd","displayName":"x"}', '{"id":"webcam:cam-1"}', '[]']) {
      fs.writeFileSync(file, junk);
      expect(new FileSelectionStore(file).load()).toBeNull();
    }
  });
});

describe('capture through the webcam provider', () => {
  it('captures one JPEG as the neutral CapturedImage with a generated filename', async () => {
    const hub = hubFor();
    const img = await hub.capture({ correlationId: 'c1', timeoutMs: 5000 });
    expect(img).toMatchObject({ mimeType: 'image/jpeg', width: 1920, height: 1080 });
    expect(img.filename).toMatch(/^cam-\d+\.jpg$/);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(shots()).toEqual([`shot ${INTEGRATED.id}`]);
    expect(fs.readdirSync(outDir)).toEqual([]); // the bridge deleted the helper's file after reading it
    expect(await hub.getStatus()).toEqual({ state: 'CONNECTED' });
  });

  it('repeated captures: one frame each, and a camera plugged in later does not change the chosen one', async () => {
    const hub = hubFor();
    for (let i = 0; i < 3; i++) await hub.capture({ correlationId: `c${i}` });
    expect(shots()).toHaveLength(3);
    setDevices([INTEGRATED, LOGITECH]); // a second camera appears; the bound (auto-selected) one stays in use while healthy
    await hub.capture({ correlationId: 'c3' });
    expect(shots().at(-1)).toBe(`shot ${INTEGRATED.id}`);
  });

  it('a failed capture is neutral, the helper text never reaches the caller, and the shutter is not retried', async () => {
    const hub = hubFor('shutterfail');
    await expect(hub.capture({ correlationId: 'c1' })).rejects.toMatchObject({ code: 'CAPTURE_FAILED', message: 'Capture failed' });
    expect(shots()).toHaveLength(1);
  });

  it('raw native/Windows error text from a misbehaving helper is a protocol violation and is never forwarded', async () => {
    const hub = hubFor('rawerror');
    const err = await hub.capture({ correlationId: 'c1' }).catch((e: CameraError) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('CAPTURE_FAILED');
    expect(JSON.stringify([(err as CameraError).message, await hub.getStatus()])).not.toMatch(/MF_E|0xC00D|usb|vid_/i);
    expect(shots()).toHaveLength(1);
  });

  it('a capture that exceeds its timeout is abandoned (helper killed), reports CAPTURE_TIMEOUT, and takes exactly one frame', async () => {
    const hub = hubFor('hang');
    const t0 = Date.now();
    await expect(hub.capture({ correlationId: 'c1', timeoutMs: 300 })).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(4000);
    await wait(200);
    expect(shots()).toHaveLength(1); // killed before anything could finish later or repeat
  });

  it.each(['notjpeg', 'escape', 'wrongid', 'badjson', 'crash'])('hostile or broken helper behaviour "%s" ends as a neutral capture failure', async (scenario) => {
    const hub = hubFor(scenario);
    const err = await hub.capture({ correlationId: 'c1' }).catch((e: CameraError) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect(['CAPTURE_FAILED', 'NOT_CONNECTED']).toContain((err as CameraError).code);
    expect(fs.existsSync(path.join(root, 'evil.jpg'))).toBe(false); // path traversal in the reply never reads or writes outside outDir
  });

  it('never runs two physical captures at once', async () => {
    const hub = hubFor('ok');
    const controller = new CameraController(hub, quiet);
    const a = controller.capture({ correlationId: 'a' });
    const b = controller.capture({ correlationId: 'b' });
    await expect(b).rejects.toMatchObject({ code: 'BUSY' });
    await a;
    expect(shots()).toHaveLength(1);
  });
});

describe('camera disconnected', () => {
  it('chosen camera unplugged: NOT_CONNECTED, no automatic switch to the other camera, no shutter, then the person can pick another', async () => {
    setDevices([INTEGRATED, LOGITECH]);
    const hub = hubFor();
    await hub.select(`webcam:${LOGITECH.id}`);
    await hub.capture({ correlationId: 'c1' });
    expect(shots()).toHaveLength(1);

    setDevices([INTEGRATED]); // Logitech unplugged
    await expect(hub.capture({ correlationId: 'c2' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(shots().filter((s) => s.includes(INTEGRATED.id))).toHaveLength(0); // did not silently use the laptop camera
    expect(await hub.getStatus()).toMatchObject({ state: 'ERROR', errorCode: 'NOT_CONNECTED' });
    const l = await hub.listCameras();
    expect(l.selectedId).toBe(`webcam:${LOGITECH.id}`);
    expect(l.cameras.find((c) => c.id === `webcam:${LOGITECH.id}`)).toMatchObject({ available: false, selected: true, unavailableReason: 'NOT_CONNECTED' });
    expect(l.cameras.find((c) => c.id === `webcam:${INTEGRATED.id}`)).toMatchObject({ available: true, selected: false });

    await hub.select(`webcam:${INTEGRATED.id}`);
    await hub.capture({ correlationId: 'c3' });
    expect(shots().at(-1)).toBe(`shot ${INTEGRATED.id}`);
  });

  it('camera removed in the middle of a session (helper reports DEVICE_LOST) fails the capture once, without a retry shot', async () => {
    const hub = hubFor('ok');
    await hub.capture({ correlationId: 'c1' });
    setDevices([]);
    await expect(hub.capture({ correlationId: 'c2' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(shots()).toHaveLength(1);
  });

  it('the helper announcing "disconnected" moves status to ERROR/NOT_CONNECTED without a capture', async () => {
    const b = backendFactory('ok')();
    const p = new WebcamCameraProvider({ backend: b, deviceId: INTEGRATED.id });
    await p.connect();
    expect(await p.getStatus()).toEqual({ state: 'CONNECTED' });
    // the fixture's `lost` scenario emits the event on the first shot
    const lost = new WebcamCameraProvider({ backend: backendFactory('lost')(), deviceId: INTEGRATED.id });
    await lost.connect();
    await expect(lost.capture({ correlationId: 'c1' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(await lost.getStatus()).toMatchObject({ state: 'ERROR', errorCode: 'NOT_CONNECTED' });
  });

  it('an auto-selected sole camera that vanishes is reported lost once; the next capture uses the new sole camera (no shutter was fired by the failed one)', async () => {
    const hub = hubFor();
    await hub.capture({ correlationId: 'c1' });
    setDevices([OTHER]);
    await expect(hub.capture({ correlationId: 'c2' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await hub.capture({ correlationId: 'c3' });
    expect(shots().filter((s) => s.includes(OTHER.id))).toHaveLength(1);
  });
});

describe('selection while busy, and sources', () => {
  it('select is refused while a capture is running', async () => {
    setDevices([INTEGRATED, LOGITECH]);
    const hub = hubFor('ok');
    await hub.select(`webcam:${INTEGRATED.id}`);
    const cap = hub.capture({ correlationId: 'c1' });
    await expect(hub.select(`webcam:${LOGITECH.id}`)).rejects.toMatchObject({ code: 'BUSY' });
    await cap;
    expect((await hub.listCameras()).selectedId).toBe(`webcam:${INTEGRATED.id}`);
  });

  it('a source that throws is skipped; the others still list', async () => {
    const broken: CameraSource = { kind: 'sony', discover: async () => { throw new Error('boom \\\\?\\usb#vid'); }, open: () => { throw new Error('no'); } };
    const hub = new CameraHub([broken, new MockCameraSource()], quiet);
    const l = await hub.listCameras();
    expect(l.cameras.map((c) => c.id)).toEqual(['mock:default']);
    expect(l.selectedId).toBe('mock:default');
    const img = await hub.capture({ correlationId: 'c1' });
    expect(img.mimeType).toBe('image/png');
  });

  it('Sony is listed as an UNAVAILABLE source without its SDK and is never selected or pretended available', async () => {
    const sony = new SonySource({ makeBackend: () => undefined });
    expect(await sony.discover()).toEqual([{ localId: 'unavailable', displayName: 'Sony camera', available: false, unavailableReason: 'DRIVER_UNAVAILABLE' }]);
    const hub = new CameraHub([new WebcamSource({ makeBackend: backendFactory() }), sony], quiet);
    const l = await hub.listCameras();
    expect(l.cameras.map((c) => [c.kind, c.available])).toEqual([['webcam', true], ['sony', false]]);
    expect(l.selectedId).toBe(`webcam:${INTEGRATED.id}`); // the unavailable Sony entry does not count as a second camera
    await expect(hub.select('sony:unavailable')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
  });

  it('createCameraProvider: webcam/auto build a hub, mock/sony are unchanged', () => {
    const store = new MemorySelectionStore();
    expect(createCameraProvider('webcam', {}, { selectionStore: store })).toBeInstanceOf(CameraHub);
    expect(createCameraProvider('auto', {}, { selectionStore: store })).toBeInstanceOf(CameraHub);
    expect(createCameraSources('webcam').map((s) => s.kind)).toEqual(['webcam']);
    expect(createCameraSources('auto').map((s) => s.kind)).toEqual(['webcam', 'sony']);
  });
});

describe('configuration', () => {
  const base = { TRIVO_API_URL: 'https://erp.example.com', STATION_ID: 'ST-1' };
  it('accepts webcam and auto, rejects unknown providers and unknown options', () => {
    expect(loadConfig({ ...base, CAMERA_PROVIDER: 'webcam' }).cameraProvider).toBe('webcam');
    expect(loadConfig({ ...base, CAMERA_PROVIDER: 'auto', CAMERA_OPT_SONY_HELPER_PATH: 'C:\\tools\\sony.exe' }).cameraOptions).toEqual({ SONY_HELPER_PATH: 'C:\\tools\\sony.exe' });
    expect(() => loadConfig({ ...base, CAMERA_PROVIDER: 'usb' })).toThrow();
    expect(() => parseProviderOptions('webcam', { CAMERA_OPT_DEVICE_ID: 'x' })).toThrow();
    expect(() => parseProviderOptions('webcam', { CAMERA_OPT_HELPER_PATH: '..\\evil.exe' })).toThrow();
    expect(() => parseProviderOptions('webcam', { CAMERA_OPT_HELPER_PATH: '\\\\server\\share\\h.exe' })).toThrow();
  });

  it('resolveWebcamHelperPath: only an absolute, existing, regular .exe', () => {
    const exe = path.join(root, 'h.exe'); fs.writeFileSync(exe, 'x');
    expect(resolveWebcamHelperPath(exe, 'unused', 'win32')).toBe(exe);
    for (const bad of ['relative\\h.exe', path.join(root, 'missing.exe'), root, path.join(root, 'h.txt')]) {
      fs.writeFileSync(path.join(root, 'h.txt'), 'x');
      expect(() => resolveWebcamHelperPath(bad, 'unused', 'win32')).toThrow(WebcamBackendError);
    }
  });
});

describe('local API: camera listing and selection', () => {
  let api: LocalApi; let port = 0; let hub: CameraHub;
  beforeEach(async () => {
    setDevices([INTEGRATED, LOGITECH]);
    hub = hubFor();
    api = new LocalApi({ getBridgeStatus: async () => ({}), getCameraStatus: async () => ({}), cameras: { list: () => hub.listCameras(), select: (id) => hub.select(id) } }, quiet);
    port = await api.listen(0);
  });
  afterEach(async () => { await api.close(); });

  function call(method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: b ? JSON.parse(b) : {} }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }
  const JSON_H = { 'Content-Type': 'application/json' };

  it('GET /cameras lists neutral camera info; POST /cameras/select with a valid id selects it', async () => {
    const l = await call('GET', '/cameras');
    expect(l.status).toBe(200);
    expect(l.json).toMatchObject({ ok: true, selectionRequired: true, selectedId: null });
    const s = await call('POST', '/cameras/select', { body: JSON.stringify({ id: `webcam:${LOGITECH.id}` }), headers: JSON_H });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ ok: true, selectedId: `webcam:${LOGITECH.id}`, selectionRequired: false });
  });

  it('rejects cross-site style requests: Origin header, non-JSON content type, wrong method', async () => {
    const body = JSON.stringify({ id: `webcam:${LOGITECH.id}` });
    expect((await call('POST', '/cameras/select', { body, headers: { ...JSON_H, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('POST', '/cameras/select', { body, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await call('POST', '/cameras/select', { body })).status).toBe(415);
    const get = await call('GET', '/cameras/select');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await call('POST', '/cameras', { body, headers: JSON_H })).status).toBe(405);
    expect((await hub.listCameras()).selectedId).toBeNull(); // none of the above selected anything
  });

  it('validates the document: bounded, exactly {id}, string-or-null, known camera', async () => {
    for (const bad of ['not json', '[]', '{}', '{"id":5}', '{"id":"webcam:cam-x","path":"C:\\\\x"}', '{"id":"../../etc/passwd"}', '{"id":"webcam:cam-zzzzzzzzzzzzzzzzzzzzzzzz"}']) {
      const r = await call('POST', '/cameras/select', { body: bad, headers: JSON_H });
      expect(r.status, bad).toBe(400);
    }
    expect((await call('POST', '/cameras/select', { body: JSON.stringify({ id: 'x'.repeat(5000) }), headers: JSON_H })).status).toBe(413);
    expect((await hub.listCameras()).selectedId).toBeNull();
  });

  it('is absent (404) when the provider does not discover cameras', async () => {
    const plain = new LocalApi({ getBridgeStatus: async () => ({}), getCameraStatus: async () => ({}) }, quiet);
    const p = await plain.listen(0);
    const r = await new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port: p, path: '/cameras', headers: { Host: `127.0.0.1:${p}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
    expect(r).toBe(404);
    await plain.close();
  });
});

describe('UnavailableWebcamBackend', () => {
  it('every operation is DRIVER_UNAVAILABLE and the provider reports it neutrally', async () => {
    const p = new WebcamCameraProvider({ backend: new UnavailableWebcamBackend(), deviceId: 'cam-x' });
    await expect(p.connect()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    expect(await p.getStatus()).toMatchObject({ state: 'ERROR', errorCode: 'DRIVER_UNAVAILABLE' });
  });
});
