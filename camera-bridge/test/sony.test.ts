import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { createCameraProvider } from '../src/camera/createProvider';
import { HelperSonyBackend, resolveHelperPath } from '../src/camera/sony/HelperSonyBackend';
import { SonyBackend, SonyBackendError, SonyDevice, SonyShot } from '../src/camera/sony/SonyBackend';
import { SonyCameraProvider } from '../src/camera/sony/SonyCameraProvider';
import { selectCamera } from '../src/camera/sony/sonySelection';
import { CaptureExecutor } from '../src/capture/captureExecutor';
import { CaptureTransport, StatusReport, UploadOutcome, UploadRequest } from '../src/capture/captureTransport';
import { TempStore } from '../src/capture/tempStore';
import { CredentialStore } from '../src/credentials';
import { createLogger } from '../src/logger';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const shot: SonyShot = { data: JPEG, mimeType: 'image/jpeg', width: 8000, height: 5320 };
const cam = (id: string, over: Partial<SonyDevice> = {}): SonyDevice => ({ id, model: 'ILCE-7RM5', connection: 'usb', ...over });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(over: Partial<SonyBackend> = {}): SonyBackend & { calls: string[] } {
  const calls: string[] = [];
  const b: SonyBackend & { calls: string[] } = {
    calls,
    listDevices: async () => { calls.push('list'); return [cam('A1')]; },
    connect: async (id) => { calls.push(`connect:${id}`); },
    close: async () => { calls.push('close'); },
    shootAndFetch: async () => { calls.push('shoot'); return shot; },
    ...over,
  };
  return b;
}

describe('selectCamera: deterministic, never by position', () => {
  it('zero / one / many', () => {
    expect(() => selectCamera([], {})).toThrow(expect.objectContaining({ failure: 'NO_CAMERA_FOUND' }));
    expect(selectCamera([cam('A1')], {}).id).toBe('A1');
    expect(() => selectCamera([cam('A1'), cam('B2')], {})).toThrow(expect.objectContaining({ failure: 'MULTIPLE_CAMERAS' }));
  });
  it('DEVICE_ID / MODEL / CONNECTION narrow the choice, whatever the enumeration order', () => {
    const devs = [cam('A1'), cam('B2'), cam('C3', { model: 'ILCE-7M4', connection: 'network' })];
    expect(selectCamera(devs, { DEVICE_ID: 'B2' }).id).toBe('B2');
    expect(selectCamera([...devs].reverse(), { DEVICE_ID: 'B2' }).id).toBe('B2');
    expect(selectCamera(devs, { MODEL: 'ilce-7m4' }).id).toBe('C3');
    expect(selectCamera(devs, { CONNECTION: 'network' }).id).toBe('C3');
    expect(() => selectCamera(devs, { DEVICE_ID: 'ZZ' })).toThrow(expect.objectContaining({ failure: 'NO_CAMERA_FOUND' }));
    expect(() => selectCamera(devs, { MODEL: 'ILCE-7RM5' })).toThrow(expect.objectContaining({ failure: 'MULTIPLE_CAMERAS' }));
  });
});

describe('SonyCameraProvider with a fake backend', () => {
  it('connects the selected device by id and captures a JPEG with a generated filename', async () => {
    const b = fake({ listDevices: async () => [cam('A1'), cam('B2')] });
    const p = new SonyCameraProvider({ backend: b, settings: { DEVICE_ID: 'B2' } });
    await p.connect();
    expect(b.calls).toContain('connect:B2');
    const img = await p.capture({ correlationId: 'c1' });
    expect(img).toMatchObject({ mimeType: 'image/jpeg', width: 8000, height: 5320 });
    expect(img.filename).toMatch(/^cam-\d+\.jpg$/);
    expect((await p.getStatus()).state).toBe('CONNECTED');
  });

  it('multiple cameras without a selector -> CONFIG_ERROR; none -> CONNECT_FAILED; neither connects', async () => {
    const many = fake({ listDevices: async () => [cam('A1'), cam('B2')] });
    const p = new SonyCameraProvider({ backend: many });
    await expect(p.connect()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(many.calls.some((c) => c.startsWith('connect:'))).toBe(false);
    const none = new SonyCameraProvider({ backend: fake({ listDevices: async () => [] }) });
    await expect(none.connect()).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
  });

  it('busy is BUSY and leaves the provider usable; timeout and failure are distinct codes', async () => {
    let mode: 'busy' | 'fail' | 'ok' = 'busy';
    const p = new SonyCameraProvider({ backend: fake({ shootAndFetch: async () => {
      if (mode === 'busy') throw new SonyBackendError('CAMERA_BUSY');
      if (mode === 'fail') throw new SonyBackendError('SHUTTER_FAILED', 'CrError 0x8704 C:/secret');
      return shot;
    } }) });
    await p.connect();
    await expect(p.capture({ correlationId: 'a' })).rejects.toMatchObject({ code: 'BUSY' });
    expect((await p.getStatus()).state).toBe('CONNECTED');
    mode = 'fail';
    const e = await p.capture({ correlationId: 'b' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'CAPTURE_FAILED' }); expect(e.message).not.toMatch(/0x8704|secret/);
    expect((await p.getStatus())).toMatchObject({ state: 'ERROR', errorCode: 'CAPTURE_FAILED' });
    mode = 'ok';
    await expect(p.capture({ correlationId: 'c' })).resolves.toBeTruthy(); // self-heals by reconnecting, then a NEW capture
  });

  it('a timeout abandons the operation (backend closed) and the shutter is not fired again', async () => {
    let shots = 0;
    const b = fake({ shootAndFetch: () => { shots++; return new Promise<SonyShot>(() => undefined); } });
    const p = new SonyCameraProvider({ backend: b });
    await p.connect();
    await expect(p.capture({ correlationId: 't', timeoutMs: 20 })).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' });
    expect(shots).toBe(1);
    expect(b.calls).toContain('close');
    expect((await p.getStatus())).toMatchObject({ state: 'ERROR', errorCode: 'CAPTURE_TIMEOUT' });
  }, 5000);

  it('malformed backend output is rejected before reaching the bridge core', async () => {
    for (const bad of [{ ...shot, mimeType: 'image/png' }, { ...shot, data: Buffer.from('nope!') }, { ...shot, width: 0 }, { ...shot, height: 1.5 }, null as never]) {
      const p = new SonyCameraProvider({ backend: fake({ shootAndFetch: async () => bad }) });
      await p.connect();
      await expect(p.capture({ correlationId: 'm' })).rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
    }
  });

  it('device loss: unsolicited disconnect -> ERROR/NOT_CONNECTED; capture then reconnects once or reports NOT_CONNECTED', async () => {
    let fire!: () => void; let present = true;
    const b = fake({ onDisconnected: (cb) => { fire = cb; }, listDevices: async () => (present ? [cam('A1')] : []) });
    const p = new SonyCameraProvider({ backend: b });
    await p.connect();
    present = false; fire();
    expect(await p.getStatus()).toMatchObject({ state: 'ERROR', errorCode: 'NOT_CONNECTED' });
    await expect(p.capture({ correlationId: 'x' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(b.calls.filter((c) => c === 'shoot')).toHaveLength(0);
    present = true;
    await expect(p.capture({ correlationId: 'y' })).resolves.toBeTruthy();
  });

  it('device lost during a shot is NOT_CONNECTED, not CAPTURE_FAILED', async () => {
    const p = new SonyCameraProvider({ backend: fake({ shootAndFetch: async () => { throw new SonyBackendError('DEVICE_LOST'); } }) });
    await p.connect();
    await expect(p.capture({ correlationId: 'x' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('overlapping capture is BUSY and fires one shutter', async () => {
    let release!: () => void; let shots = 0;
    const p = new SonyCameraProvider({ backend: fake({ shootAndFetch: () => { shots++; return new Promise((r) => (release = () => r(shot))); } }) });
    await p.connect();
    const first = p.capture({ correlationId: 'a' });
    await expect(p.capture({ correlationId: 'b' })).rejects.toMatchObject({ code: 'BUSY' });
    release(); await first; expect(shots).toBe(1);
  });

  it('driver absent: DRIVER_UNAVAILABLE, no crash, no vendor text', async () => {
    const p = createCameraProvider('sony', { HELPER_PATH: path.join(os.tmpdir(), 'definitely-missing', 'helper.exe') });
    await expect(p.connect()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    const s = await p.getStatus();
    expect(s).toMatchObject({ state: 'ERROR', errorCode: 'DRIVER_UNAVAILABLE' });
    expect(JSON.stringify(s)).not.toMatch(/sony|sdk|crsdk/i);
    await expect(p.disconnect()).resolves.toBeUndefined();
  });
});

describe('resolveHelperPath', () => {
  it('requires an absolute path to an existing regular file (.exe on Windows)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-h-'));
    const exe = path.join(d, 'h.exe'); fs.writeFileSync(exe, 'x');
    expect(resolveHelperPath(exe, 'unused', 'win32')).toBe(exe);
    for (const bad of ['h.exe', path.join(d, 'missing.exe'), d, path.join(d, 'h.dll')]) {
      if (bad.endsWith('h.dll')) fs.writeFileSync(bad, 'x');
      expect(() => resolveHelperPath(bad, 'unused', 'win32')).toThrow(expect.objectContaining({ failure: 'DRIVER_UNAVAILABLE' }));
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('HelperSonyBackend against a fake native helper process (protocol boundary)', () => {
  let dir: string; let logFile: string;
  const helper = path.join(__dirname, 'fixtures', 'fakeSonyHelper.js');
  const backend = (scenario: string, extra: Partial<ConstructorParameters<typeof HelperSonyBackend>[0]> = {}) =>
    new HelperSonyBackend({ command: process.execPath, args: [helper, `--scenario=${scenario}`, `--log=${logFile}`], outDir: path.join(dir, 'out'), readyTimeoutMs: 3000, opTimeoutMs: 3000, ...extra });
  const shots = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0);
  const active: HelperSonyBackend[] = [];
  const mk = (s: string, e = {}) => { const b = backend(s, e); active.push(b); return b; };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-sony-')); logFile = path.join(dir, 'shots.log'); });
  afterEach(async () => { await Promise.all(active.splice(0).map((b) => b.close())); fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists, connects, shoots once, returns the JPEG and leaves no file behind', async () => {
    const b = mk('ok');
    const devs = await b.listDevices(); expect(devs).toEqual([cam('A1')]);
    await b.connect('A1');
    const s = await b.shootAndFetch({ timeoutMs: 3000 });
    expect(s).toMatchObject({ mimeType: 'image/jpeg', width: 8000, height: 5320 }); expect(s.data.equals(JPEG)).toBe(true);
    expect(shots()).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual([]);
  });

  it('end to end through SonyCameraProvider: multi-camera config error, then selection by id', async () => {
    const p = new SonyCameraProvider({ backend: mk('multi') });
    await expect(p.connect()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    const q = new SonyCameraProvider({ backend: mk('multi'), settings: { DEVICE_ID: 'B2' } });
    await q.connect(); expect((await q.getStatus()).state).toBe('CONNECTED');
  });

  it.each([
    ['nocam', 'CONNECT_FAILED', 'connect'],
    ['reject', 'CONNECT_FAILED', 'connect'],
    ['busy', 'BUSY', 'shoot'],
    ['shutterfail', 'CAPTURE_FAILED', 'shoot'],
    ['badjson', 'CAPTURE_FAILED', 'shoot'],
    ['unknownfailure', 'CAPTURE_FAILED', 'shoot'],
    ['wrongid', 'CAPTURE_FAILED', 'shoot'],
    ['nofile', 'CAPTURE_FAILED', 'shoot'],
    ['notjpeg', 'CAPTURE_FAILED', 'shoot'],
    ['baddims', 'CAPTURE_FAILED', 'shoot'],
    ['escape', 'CAPTURE_FAILED', 'shoot'],
    ['crash', 'NOT_CONNECTED', 'shoot'],
    ['lost', 'NOT_CONNECTED', 'shoot'],
    ['badready', 'DRIVER_UNAVAILABLE', 'connect'],
  ])('scenario %s -> %s, with no raw helper text', async (scenario, code, phase) => {
    const p = new SonyCameraProvider({ backend: mk(scenario) });
    const e = (await (async () => {
      try { await p.connect(); if (phase === 'connect') return null; return await p.capture({ correlationId: 'k', timeoutMs: 3000 }); } catch (x) { return x; }
    })()) as Error & { code?: string };
    expect(e?.code).toBe(code);
    expect(e.message).not.toMatch(/0x8704|secret|SDK ERROR/);
    expect(shots()).toBeLessThanOrEqual(1); // never a second shutter
  });

  it('a hung shutter times out, the helper is killed, and exactly one shutter was released', async () => {
    const p = new SonyCameraProvider({ backend: mk('hang') });
    await p.connect();
    const started = Date.now();
    await expect(p.capture({ correlationId: 'h', timeoutMs: 200 })).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2500);
    await wait(100);
    expect(shots()).toBe(1);
    expect((await p.getStatus())).toMatchObject({ state: 'ERROR', errorCode: 'CAPTURE_TIMEOUT' });
  });

  it('a helper that never says ready is DRIVER_UNAVAILABLE', async () => {
    const b = mk('silent', { readyTimeoutMs: 150 });
    await expect(b.listDevices()).rejects.toMatchObject({ failure: 'DRIVER_UNAVAILABLE' });
  });

  it('the helper gets a minimal environment: bridge secrets never reach it', async () => {
    process.env.TRIVO_STATION_SECRET_DEV = 'leak-me'; process.env.CAMERA_OPT_DEVICE_ID = 'A1';
    try {
      const probe = path.join(dir, 'env.js');
      fs.writeFileSync(probe, "process.stdout.write(JSON.stringify({event:'ready',protocol:1})+'\\n');require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);require('fs').writeFileSync(process.argv[2],JSON.stringify(process.env));process.stdout.write(JSON.stringify({id:m.id,ok:true,devices:[]})+'\\n');});");
      const out = path.join(dir, 'env.json');
      const b = new HelperSonyBackend({ command: process.execPath, args: [probe, out], outDir: path.join(dir, 'out'), opTimeoutMs: 3000 });
      active.push(b);
      await b.listDevices();
      const env = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(Object.keys(env).join()).not.toMatch(/TRIVO|CAMERA_OPT/); expect(JSON.stringify(env)).not.toContain('leak-me');
    } finally { delete process.env.TRIVO_STATION_SECRET_DEV; delete process.env.CAMERA_OPT_DEVICE_ID; }
  });

  it('stale shots from an earlier run are swept when the helper starts', async () => {
    const out = path.join(dir, 'out'); fs.mkdirSync(out, { recursive: true });
    const stale = path.join(out, 'shot-00000000-0000-0000-0000-000000000000.jpg'); fs.writeFileSync(stale, 'x');
    fs.writeFileSync(path.join(out, 'keep.txt'), 'mine');
    await mk('ok').listDevices();
    expect(fs.existsSync(stale)).toBe(false); expect(fs.existsSync(path.join(out, 'keep.txt'))).toBe(true);
  });
});

describe('CaptureExecutor -> SonyCameraProvider (fake backend)', () => {
  const SECRET = 'stn_abc123.SECRET-VALUE-DO-NOT-LOG'; const STATION = 'ST-1';
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-sx-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup(backend: SonyBackend, captureTimeoutMs = 1000) {
    const uploads: UploadRequest[] = []; const reports: StatusReport[] = [];
    const transport: CaptureTransport = {
      pollCommand: async () => ({ ok: true as const, command: null }),
      reportStatus: async (_s: string, _id: string, r: StatusReport) => { reports.push(r); return { ok: true as const }; },
      uploadImage: async (_s: string, r: UploadRequest): Promise<UploadOutcome> => { uploads.push(r); return { ok: true, imageId: 'img-1', replay: false }; },
    } as CaptureTransport;
    const log = createLogger({ sink: () => undefined });
    const creds: CredentialStore = { kind: 'dev-env', load: async () => SECRET, save: async () => undefined };
    const provider = new SonyCameraProvider({ backend });
    const ex = new CaptureExecutor({ stationId: STATION, captureTimeoutMs, uploadTimeoutMs: 1000, uploadMaxAttempts: 2, uploadBackoffMs: 1, cameraLabel: 'sony' },
      new CameraController(provider, log), creds, transport, new TempStore(dir, 60_000, log), log);
    const command = (id: string) => ({ commandId: id, correlationId: `corr-${id}`, stationId: STATION, imageType: 'PRIMARY', tagNumber: 'T-1',
      ticket: `${b64({ alg: 'HS256' })}.${b64({ sid: STATION, exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln${'x'.repeat(10)}`, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    return { provider, ex, uploads, reports, command };
  }

  it('uploads the JPEG with the sony label after exactly one shutter', async () => {
    const b = fake(); const { provider, ex, uploads, command } = setup(b);
    await provider.connect();
    const r = await ex.handle(command('c1'));
    expect(r).toMatchObject({ code: 'SUCCESS', imageId: 'img-1' });
    expect(b.calls.filter((c) => c === 'shoot')).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ mimeType: 'image/jpeg', cameraLabel: 'sony' });
  });

  it('a duplicate delivery of the same command does not fire a second shutter', async () => {
    const b = fake(); const { provider, ex, command } = setup(b);
    await provider.connect();
    await Promise.all([ex.handle(command('c2')), ex.handle(command('c2'))]);
    await ex.handle(command('c2'));
    expect(b.calls.filter((c) => c === 'shoot')).toHaveLength(1);
  });

  it('a camera timeout is a CAMERA_ERROR with no retry of the shutter', async () => {
    let shots = 0;
    const b = fake({ shootAndFetch: () => { shots++; return new Promise<SonyShot>(() => undefined); } });
    const { provider, ex, reports, uploads, command } = setup(b, 100);
    await provider.connect();
    const r = await ex.handle(command('c3'));
    expect(r).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_TIMEOUT' });
    expect(reports.map((x) => x.status)).toEqual(['ACCEPTED', 'CAPTURING', 'FAILED']);
    await wait(1300);
    expect(shots).toBe(1); expect(uploads).toHaveLength(0);
  }, 6000);

  it('camera busy surfaces as BUSY (distinct from a timeout)', async () => {
    const { provider, ex, command } = setup(fake({ shootAndFetch: async () => { throw new SonyBackendError('CAMERA_BUSY'); } }));
    await provider.connect();
    expect(await ex.handle(command('c4'))).toMatchObject({ code: 'BUSY' });
  });
});
