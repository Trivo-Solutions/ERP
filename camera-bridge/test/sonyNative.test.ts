// Integration of the Node bridge with the REAL native helper binaries (built from native-src/sony-helper):
//   - trivo-sony-helper-fake.exe : the production protocol/validation code driven by a test FakeDriver (no camera)
//   - trivo-sony-helper.exe      : the production binary with NO Sony SDK adapter (NullDriver) => DRIVER_UNAVAILABLE
// Skipped (not failed) when the binaries have not been built: `cmake` + MSVC are a developer prerequisite, not a runtime one.
// No Sony camera or SDK is involved anywhere in this file.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelperSonyBackend } from '../src/camera/sony/HelperSonyBackend';
import { createCameraProvider } from '../src/camera/createProvider';

const build = process.env.TRIVO_NATIVE_BUILD ?? path.resolve(__dirname, '..', 'native-src', 'build', 'Release');
const REAL = path.join(build, 'trivo-sony-helper.exe');
const FAKE = path.join(build, 'trivo-sony-helper-fake.exe');
const built = process.platform === 'win32' && fs.existsSync(REAL) && fs.existsSync(FAKE);

describe.skipIf(!built)('native helper binaries (no camera, no SDK)', () => {
  let root: string; let out: string; let log: string;
  const active: HelperSonyBackend[] = [];
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-nat-')));
    out = path.join(root, 'sony-shots'); log = path.join(root, 'shots.log');
    fs.mkdirSync(out);
  });
  afterEach(async () => { for (const b of active.splice(0)) await b.close().catch(() => undefined); fs.rmSync(root, { recursive: true, force: true }); });
  const backend = (scenario: string, command = FAKE, extra: Record<string, unknown> = {}) => {
    const b = new HelperSonyBackend({ command, args: command === FAKE ? [`--scenario=${scenario}`, `--log=${log}`] : [], outDir: out, readyTimeoutMs: 5000, opTimeoutMs: 5000, ...extra });
    active.push(b);
    return b;
  };
  const shots = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

  it('list -> connect -> shoot returns a verified JPEG with the dimensions read from the file itself', async () => {
    const b = backend('ok');
    const devs = await b.listDevices();
    expect(devs).toEqual([{ id: 'A1', model: 'ILCE-7RM5', connection: 'usb' }]);
    await b.connect('A1');
    const s = await b.shootAndFetch();
    expect(s.mimeType).toBe('image/jpeg');
    expect([s.data[0], s.data[1], s.data[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect([s.width, s.height]).toEqual([16, 8]);
    expect(shots()).toBe(1);
    expect(fs.readdirSync(out)).toEqual([]); // bridge deleted it after reading
    await b.close();
  });

  it('a second capture on the same session works, one shutter each', async () => {
    const b = backend('ok');
    await b.listDevices(); await b.connect('A1');
    await b.shootAndFetch(); await b.shootAndFetch();
    expect(shots()).toBe(2);
  });

  it('zero and several cameras are reported faithfully (selection happens in the bridge, by id)', async () => {
    expect(await backend('nocam').listDevices()).toEqual([]);
    expect((await backend('multi').listDevices()).map((d) => d.id)).toEqual(['A1', 'B2']);
  });

  it('connecting to an id the camera list did not contain is NO_CAMERA_FOUND', async () => {
    const b = backend('ok');
    await b.listDevices();
    await expect(b.connect('ZZ')).rejects.toMatchObject({ failure: 'NO_CAMERA_FOUND' });
  });

  it.each([['shutterfail', 'SHUTTER_FAILED'], ['busy', 'CAMERA_BUSY'], ['noimage', 'TRANSFER_FAILED'], ['notjpeg', 'TRANSFER_FAILED'], ['noeoi', 'TRANSFER_FAILED'], ['lostonshoot', 'DEVICE_LOST']])(
    'scenario %s -> %s with exactly one shutter and no leftover file', async (scenario, code) => {
      const b = backend(scenario);
      await b.listDevices(); await b.connect('A1');
      await expect(b.shootAndFetch()).rejects.toMatchObject({ failure: code });
      expect(shots()).toBe(1);
      expect(fs.readdirSync(out)).toEqual([]);
    });

  it('a hung SDK call: the bridge kills the helper (TIMEOUT), and nothing re-fires the shutter', async () => {
    const b = backend('hang');
    await b.listDevices(); await b.connect('A1');
    await expect(b.shootAndFetch({ timeoutMs: 600 })).rejects.toMatchObject({ failure: 'TIMEOUT' });
    await new Promise((r) => setTimeout(r, 800));
    expect(shots()).toBe(1);
  });

  it('the production binary without an SDK adapter reports DRIVER_UNAVAILABLE (never crashes)', async () => {
    const b = backend('', REAL);
    await expect(b.listDevices()).rejects.toMatchObject({ failure: 'DRIVER_UNAVAILABLE' });
  });

  it('CAMERA_PROVIDER=sony + the real binary with no SDK adapter: ERROR / DRIVER_UNAVAILABLE, no crash, no vendor text', async () => {
    const p = createCameraProvider('sony', { HELPER_PATH: REAL });
    await expect(p.connect()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    const s = await p.getStatus();
    expect(s).toMatchObject({ state: 'ERROR', errorCode: 'DRIVER_UNAVAILABLE' });
    expect(JSON.stringify(s)).not.toMatch(/sdk|crsdk/i);
    await expect(p.disconnect()).resolves.toBeUndefined();
  });

  describe('raw protocol over the real process', () => {
    const run = (args: string[], lines: string[], closeStdin = true) => new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(REAL, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot ?? '' }, windowsHide: true });
      let so = ''; c.stdout.on('data', (d) => { so += d; });
      c.on('exit', (code) => resolve({ code, stdout: so }));
      for (const l of lines) c.stdin.write(l + '\n');
      if (closeStdin) c.stdin.end();
    });

    it('announces ready, survives garbage/unknown ops, answers list, and exits 0 when stdin closes', async () => {
      const r = await run(['--out-dir', out], ['garbage', '{"id":1,"op":"explode"}', '{"id":2,"op":"list","x":1}', '{"id":3,"op":"list"}']);
      const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ event: 'ready', protocol: 1 });
      expect(lines[1]).toEqual({ id: 0, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(lines[2]).toEqual({ id: 1, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(lines[3]).toEqual({ id: 2, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(lines[4]).toEqual({ id: 3, ok: false, failure: 'DRIVER_UNAVAILABLE' });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toMatch(/\r/);
    });

    it('close replies ok and exits', async () => {
      const r = await run(['--out-dir', out], ['{"id":1,"op":"close"}'], false);
      expect(r.stdout).toContain('{"id":1,"ok":true}');
      expect(r.code).toBe(0);
    });

    it('an oversize line is answered once and the helper exits', async () => {
      const r = await run(['--out-dir', out], ['{"id":1,"op":"' + 'x'.repeat(70000) + '"}']);
      expect(r.stdout).toContain('"failure":"PROTOCOL_ERROR"');
      expect(r.code).toBe(0);
    });

    const badArgs: Array<[string, (o: string, r: string) => string[]]> = [
      ['none', () => []], ['dangling flag', () => ['--out-dir']], ['extra flag', (o) => ['--out-dir', o, '--extra']],
      ['duplicate out-dir', (o) => ['--out-dir', o, '--out-dir', o]], ['fake-only flag', (o) => ['--scenario=ok', '--out-dir', o]],
      ['wrong leaf name', (_o, r) => ['--out-dir', path.join(r, 'not-sony-shots')]], ['relative', () => ['--out-dir', 'sony-shots']],
      ['traversal', (o) => ['--out-dir', o + '\..\sony-shots']], ['UNC', () => ['--out-dir', '\\localhost\c$\sony-shots']],
      ['missing dir', (_o, r) => ['--out-dir', path.join(r, 'missing', 'sony-shots')]],
    ];
    it.each(badArgs)('bad arguments (%s): exit 2, no ready event, nothing on stdout', (_n, mk) => {
      fs.mkdirSync(path.join(root, 'not-sony-shots'), { recursive: true });
      const r = spawnSync(REAL, mk(out, root), { input: '', env: { SystemRoot: process.env.SystemRoot ?? '' }, windowsHide: true, timeout: 10000 });
      expect(r.status).toBe(2);
      expect(r.stdout.toString()).toBe('');
    });

    it('does not read behaviour from its environment (secrets in env change nothing and never appear in output)', async () => {
      const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const c = spawn(REAL, ['--out-dir', out], { stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot ?? '', ERP_TOKEN: 'sekrit-token-123', CAPTURE_TICKET: 'sekrit-ticket' }, windowsHide: true });
        let so = ''; let se = '';
        c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
        c.on('exit', (code) => resolve({ code, stdout: so, stderr: se }));
        c.stdin.write('{"id":1,"op":"list"}\n'); c.stdin.end();
      });
      expect(r.stdout + r.stderr).not.toMatch(/sekrit/);
      expect(r.code).toBe(0);
    });
  });
});
