// Integration of the Node bridge with the REAL native webcam helper (native-src/webcam-helper -> trivo-webcam-helper.exe).
// Skipped (not failed) when it has not been built: `scripts\build-webcam.ps1` (MSVC Build Tools) is a developer prerequisite.
//
// Everything here except the final block is camera-free: argument/path hardening and protocol robustness are answered by the
// helper BEFORE any camera is touched, and `list` only enumerates (the camera light does not come on).
// The final block takes a real photograph and is OPT-IN: set TRIVO_WEBCAM_LIVE=1 on a machine with a camera.
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CameraHub } from '../src/camera/CameraHub';
import { HelperWebcamBackend } from '../src/camera/webcam/HelperWebcamBackend';
import { WebcamSource } from '../src/camera/webcam/webcamSource';
import { createLogger } from '../src/logger';

const build = process.env.TRIVO_WEBCAM_BUILD ?? path.resolve(__dirname, '..', 'native-src', 'build-webcam', 'Release');
const EXE = path.join(build, 'trivo-webcam-helper.exe');
const built = process.platform === 'win32' && fs.existsSync(EXE);
const quiet = createLogger({ sink: () => undefined });

describe.skipIf(!built)('native webcam helper (no shutter fired)', () => {
  let root: string; let out: string;
  const open: ChildProcessWithoutNullStreams[] = [];
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-wc-')));
    out = path.join(root, 'webcam-shots');
    fs.mkdirSync(out);
  });
  afterEach(() => { for (const c of open.splice(0)) c.kill(); fs.rmSync(root, { recursive: true, force: true }); });

  const env = { SystemRoot: process.env.SystemRoot ?? '' };
  function run(args: string[]) { return spawnSync(EXE, args, { env, encoding: 'utf8', timeout: 10_000, windowsHide: true }); }

  /** A live helper process with line-oriented reads. */
  async function start(outDir = out) {
    const child = spawn(EXE, ['--out-dir', outDir], { env, windowsHide: true });
    open.push(child);
    const lines: string[] = []; const waiters: Array<(l: string) => void> = [];
    readline.createInterface({ input: child.stdout }).on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); });
    const next = () => new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('no reply')), 8000);
      const done = (l: string) => { clearTimeout(t); res(l); };
      const l = lines.shift(); if (l !== undefined) done(l); else waiters.push(done);
    });
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    const ready = JSON.parse(await next());
    return { child, next, exited, ready, send: (s: string) => child.stdin.write(s + '\n'), ask: async (s: string) => { child.stdin.write(s + '\n'); return JSON.parse(await next()); } };
  }

  describe('arguments and output directory (fail closed, exit 2, nothing spawned past validation)', () => {
    it('rejects missing, unknown, duplicate and extra arguments', () => {
      for (const args of [[], ['--out-dir'], ['--out-dir', out, '--scenario=ok'], ['--out-dir', out, '--out-dir', out], ['--exe', 'x.exe'], ['--out-dir', out, 'extra'], ['--help']]) {
        expect(run(args).status, JSON.stringify(args)).toBe(2);
      }
    });

    it('rejects a wrong leaf name, relative path, traversal, UNC / device paths, alternate streams and wildcards', () => {
      const bad = [
        root, path.join(root, 'sony-shots'), 'webcam-shots', '.\\webcam-shots', `${root}\\webcam-shots\\..`, `${root}\\..\\webcam-shots`,
        `${root}\\.\\webcam-shots`, '\\\\server\\share\\webcam-shots', `\\\\?\\${out}`, `\\\\.\\${out}`, `${out}:stream`, `${root}\\web*cam-shots`,
        `${root}/webcam-shots`, `${root}\\missing\\webcam-shots`, `${out} `, `${out}.`,
      ];
      for (const dir of bad) expect(run(['--out-dir', dir]).status, dir).toBe(2);
    });

    it('rejects a junction as the output directory, and an output directory reached through a junction', () => {
      const real = path.join(root, 'real'); fs.mkdirSync(real);
      const junction = path.join(root, 'j'); fs.mkdirSync(junction);
      const viaJunction = path.join(junction, 'webcam-shots');
      const mk = spawnSync('cmd', ['/c', 'mklink', '/J', viaJunction, real], { windowsHide: true });
      if (mk.status !== 0) return; // junction creation not permitted here; the leaf/canonical-path rules above still hold
      expect(run(['--out-dir', viaJunction]).status).toBe(2); // reparse point as the directory itself
      fs.mkdirSync(path.join(real, 'webcam-shots'));
      const parentJ = path.join(root, 'pj');
      spawnSync('cmd', ['/c', 'mklink', '/J', parentJ, real], { windowsHide: true });
      expect(run(['--out-dir', path.join(parentJ, 'webcam-shots')]).status).toBe(2); // canonical path differs
    });

    it('accepts the bridge-owned directory and announces protocol v1 on stdout', async () => {
      const h = await start();
      expect(h.ready).toEqual({ event: 'ready', protocol: 1 });
      expect(await h.ask('{"id":1,"op":"close"}')).toEqual({ id: 1, ok: true });
      expect(await h.exited).toBe(0);
    });
  });

  describe('protocol robustness (the helper answers PROTOCOL_ERROR and keeps running)', () => {
    it('malformed JSON, non-objects, duplicate keys, nesting and bad ids', async () => {
      const h = await start();
      for (const raw of ['not json', '[]', '"str"', '{"id":1,"op":"list","op":"list"}', '{"id":1,"op":{"a":1}}', '{"op":"list"}', '{"id":0,"op":"list"}', '{"id":-3,"op":"list"}',
        '{"id":"7","op":"list"}', '{"id":99999999999,"op":"list"}', '{"id":1.5,"op":"list"}', '{', '}{']) {
        const r = await h.ask(raw);
        expect(r, raw).toMatchObject({ ok: false, failure: 'PROTOCOL_ERROR' });
      }
      expect(await h.ask('{"id":5,"op":"close"}')).toEqual({ id: 5, ok: true }); // still alive and sane after all of it
    });

    it('unknown operation, extra keys, out-of-sequence calls', async () => {
      const h = await start();
      expect(await h.ask('{"id":2,"op":"status"}')).toEqual({ id: 2, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(await h.ask('{"id":3,"op":"capture"}')).toEqual({ id: 3, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(await h.ask('{"id":4,"op":"list","extra":"x"}')).toEqual({ id: 4, ok: false, failure: 'PROTOCOL_ERROR' });
      expect(await h.ask('{"id":5,"op":"connect","deviceId":"cam-aaaaaaaaaaaaaaaaaaaaaaaa"}')).toEqual({ id: 5, ok: false, failure: 'PROTOCOL_ERROR' }); // connect before list
      expect(await h.ask('{"id":6,"op":"shoot","file":"shot-123e4567-e89b-12d3-a456-426614174000.jpg"}')).toEqual({ id: 6, ok: false, failure: 'PROTOCOL_ERROR' }); // shoot before connect
      expect(fs.readdirSync(out)).toEqual([]);
    });

    it('rejects an unknown or malformed deviceId and every unsafe shoot file name', async () => {
      const h = await start();
      const listed = await h.ask('{"id":1,"op":"list"}');
      expect(listed.ok).toBe(true);
      expect(await h.ask('{"id":2,"op":"connect","deviceId":"cam-000000000000000000000000"}')).toMatchObject({ ok: false, failure: 'NO_CAMERA_FOUND' });
      for (const id of ['', '../x', 'C:\\x', 'a b', 'x'.repeat(65), 'cam-"q']) {
        expect((await h.ask(JSON.stringify({ id: 3, op: 'connect', deviceId: id })))).toMatchObject({ ok: false, failure: 'PROTOCOL_ERROR' });
      }
      for (const file of ['../evil.jpg', '..\\evil.jpg', 'C:\\evil.jpg', 'shot-1.jpg', 'x.jpg', 'shot-123e4567-e89b-12d3-a456-426614174000.png', 'shot-123e4567-e89b-12d3-a456-426614174000.jpg ', 'shot-123e4567-e89b-12d3-a456-42661417400g.jpg', '']) {
        expect((await h.ask(JSON.stringify({ id: 4, op: 'shoot', file }))), file).toMatchObject({ ok: false, failure: 'PROTOCOL_ERROR' });
      }
      expect(fs.readdirSync(root).sort()).toEqual(['webcam-shots']); // nothing written anywhere
      expect(fs.readdirSync(out)).toEqual([]);
    });

    it('an oversize line is refused once and the helper exits', async () => {
      const h = await start();
      h.send('x'.repeat(70 * 1024));
      expect(JSON.parse(await h.next())).toMatchObject({ ok: false, failure: 'PROTOCOL_ERROR' });
      expect(await h.exited).toBe(0);
    });

    it('stdin closing ends the helper cleanly', async () => {
      const h = await start();
      h.child.stdin.end();
      expect(await h.exited).toBe(0);
    });
  });

  describe('enumeration on this machine (reads the camera list only)', () => {
    it('list returns protocol-clean devices with stable ids, in both a raw session and through the bridge hub', async () => {
      const h = await start();
      const a = await h.ask('{"id":1,"op":"list"}');
      const b = await h.ask('{"id":2,"op":"list"}');
      expect(a.ok).toBe(true);
      expect(b.devices.map((d: { id: string }) => d.id)).toEqual(a.devices.map((d: { id: string }) => d.id)); // stable between calls
      for (const d of a.devices) {
        expect(d.id).toMatch(/^cam-[0-9a-f]{24}$/);
        expect(d.model).toMatch(/^[A-Za-z0-9._ -]{1,40}$/);
        expect(['usb', 'network', 'local']).toContain(d.connection);
        if (d.placement !== undefined) expect(d.placement).toBe('integrated');
      }
      expect(new Set(a.devices.map((d: { id: string }) => d.id)).size).toBe(a.devices.length);
      await h.ask('{"id":3,"op":"close"}');

      const hub = new CameraHub([new WebcamSource({ makeBackend: () => new HelperWebcamBackend({ command: EXE, outDir: out, readyTimeoutMs: 8000, opTimeoutMs: 8000 }) })], quiet);
      const l = await hub.listCameras();
      expect(l.cameras.filter((c) => c.available).length).toBe(a.devices.length);
      // 0 cameras: nothing selected, not an error. 1: auto-selected. >1: a person must choose.
      expect(l.selectionRequired).toBe(a.devices.length > 1);
      expect(l.selectedId !== null).toBe(a.devices.length === 1);
      console.log(`      (live) ${a.devices.length} camera(s): ${l.cameras.map((c) => `${c.displayName}${c.placement ? ' [integrated]' : ''}`).join(', ') || 'none'}`);
    });

    it('connecting a camera id that does not exist is NO_CAMERA_FOUND, not a crash', async () => {
      const h = await start();
      await h.ask('{"id":1,"op":"list"}');
      expect(await h.ask('{"id":2,"op":"connect","deviceId":"cam-ffffffffffffffffffffffff"}')).toMatchObject({ ok: false, failure: 'NO_CAMERA_FOUND' });
    });
  });
});

// OPT-IN: this block turns the camera on and takes real photographs. TRIVO_WEBCAM_LIVE=1
describe.skipIf(!built || process.env.TRIVO_WEBCAM_LIVE !== '1')('LIVE webcam capture (opt-in; uses the real camera)', () => {
  let root: string; let out: string;
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-wclive-'))); out = path.join(root, 'webcam-shots'); fs.mkdirSync(out); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('captures valid JPEGs repeatedly through the real stack, never overwrites, and cleans up its temp files', async () => {
    const hub = new CameraHub([new WebcamSource({ makeBackend: () => new HelperWebcamBackend({ command: EXE, outDir: out, readyTimeoutMs: 8000, opTimeoutMs: 20_000 }) })], quiet);
    const l = await hub.listCameras();
    const first = l.cameras.find((c) => c.available);
    if (!first) { console.log('      (live) no camera on this machine - nothing to capture'); return; }
    await hub.select(first.id);
    const sizes: number[] = [];
    for (let i = 0; i < 2; i++) {
      const img = await hub.capture({ correlationId: `live${i}`, timeoutMs: 15_000 });
      expect(img.mimeType).toBe('image/jpeg');
      expect([img.data[0], img.data[1], img.data[2]]).toEqual([0xff, 0xd8, 0xff]);
      expect(img.data.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      expect(img.width).toBeGreaterThan(0); expect(img.height).toBeGreaterThan(0);
      expect(img.data.length).toBeGreaterThan(2000);
      sizes.push(img.width * img.height);
    }
    console.log(`      (live) captured 2 JPEGs, ${sizes[0]} px each; nothing was kept`);
    expect(fs.readdirSync(out)).toEqual([]); // temp files removed
    await hub.disconnect();
  }, 60_000);
});
