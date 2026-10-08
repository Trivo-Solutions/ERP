import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { SONY_FAILURES, SonyBackend, SonyBackendError, SonyDevice, SonyFailure, SonyShot } from './SonyBackend';

// The real backend: a small native helper process that links Sony's Camera Remote SDK and speaks newline-delimited JSON
// over stdin/stdout (contract: docs/SONY_HELPER_PROTOCOL.md). The helper knows only the camera — it is never given a
// token, ticket, station credential, company, tag or ERP URL, and it runs with a minimal environment.
//
//   -> {"id":1,"op":"list"}                          <- {"id":1,"ok":true,"devices":[{"id","model","connection"}]}
//   -> {"id":2,"op":"connect","deviceId":"..."}      <- {"id":2,"ok":true}
//   -> {"id":3,"op":"shoot","file":"shot-<uuid>.jpg"} <- {"id":3,"ok":true,"file":"...","width":N,"height":N}
//   -> {"id":4,"op":"close"}                         <- {"id":4,"ok":true}
//   failures:  {"id":n,"ok":false,"failure":"<one of SONY_FAILURES>"}     events: {"event":"ready"|"disconnected"}
//
// The image never travels over the pipe: the helper writes it into the bridge-owned `outDir` under a name the BRIDGE chose,
// and the bridge reads it back, checks it, and deletes it.

const PROTOCOL = 1;
const MAX_LINE = 64 * 1024;
const MAX_IMAGE_BYTES = 120 * 1024 * 1024;
const SHOT_NAME = /^shot-[0-9a-f-]{36}\.jpg$/;

export interface HelperBackendOptions {
  /** Executable to spawn. In production this comes only from validated local configuration (see resolveHelperPath). */
  command: string;
  /** Extra argv before the bridge's own (tests run a Node script; production passes none). */
  args?: string[];
  /** Bridge-owned directory the helper writes shots into. */
  outDir: string;
  readyTimeoutMs?: number;
  opTimeoutMs?: number;
}

/** Validates a configured helper path: absolute, an existing regular file, a .exe on Windows. Throws DRIVER_UNAVAILABLE. */
export function resolveHelperPath(configured: string | undefined, defaultPath: string, platform: NodeJS.Platform = process.platform): string {
  const p = configured ?? defaultPath;
  if (!path.isAbsolute(p)) throw new SonyBackendError('DRIVER_UNAVAILABLE');
  if (platform === 'win32' && path.extname(p).toLowerCase() !== '.exe') throw new SonyBackendError('DRIVER_UNAVAILABLE');
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new SonyBackendError('DRIVER_UNAVAILABLE'); }
  if (!st.isFile()) throw new SonyBackendError('DRIVER_UNAVAILABLE');
  return p;
}

type Child = ChildProcessByStdio<Writable, Readable, null>;

interface Pending { id: number; op: string; resolve: (m: Record<string, unknown>) => void; reject: (e: SonyBackendError) => void; timer: NodeJS.Timeout }

export class HelperSonyBackend implements SonyBackend {
  private child: Child | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private disconnectCb: (() => void) | null = null;
  private sessionOpen = false;
  private starting: Promise<void> | null = null;
  /** Why the helper is going away, when we know better than "it exited" (protocol violation, device loss). */
  private exitReason: SonyBackendError | null = null;

  constructor(private readonly o: HelperBackendOptions) {}

  onDisconnected(cb: () => void): void { this.disconnectCb = cb; }

  async listDevices(): Promise<SonyDevice[]> {
    const r = await this.request('list');
    if (!Array.isArray(r.devices) || r.devices.length > 32) throw new SonyBackendError('PROTOCOL_ERROR');
    return r.devices.map((d: unknown) => {
      const x = d as Record<string, unknown>;
      if (!x || typeof x.id !== 'string' || typeof x.model !== 'string' || (x.connection !== 'usb' && x.connection !== 'network')
        || !x.id || x.id.length > 64 || x.model.length > 40) throw this.kill(new SonyBackendError('PROTOCOL_ERROR'));
      return { id: x.id, model: x.model, connection: x.connection };
    });
  }

  async connect(deviceId: string): Promise<void> {
    await this.request('connect', { deviceId });
    this.sessionOpen = true;
  }

  async shootAndFetch(opts: { timeoutMs?: number } = {}): Promise<SonyShot> {
    const file = `shot-${randomUUID()}.jpg`;
    const full = path.join(this.o.outDir, file);
    try {
      const r = await this.request('shoot', { file }, opts.timeoutMs);
      const { width, height } = r;
      if (r.file !== file || !Number.isInteger(width) || !Number.isInteger(height)
        || (width as number) < 1 || (height as number) < 1 || (width as number) > 100_000 || (height as number) > 100_000) {
        throw this.kill(new SonyBackendError('PROTOCOL_ERROR'));
      }
      let data: Buffer;
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 4 || st.size > MAX_IMAGE_BYTES) throw new Error('size');
        data = fs.readFileSync(full);
      } catch { throw new SonyBackendError('TRANSFER_FAILED'); }
      if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new SonyBackendError('TRANSFER_FAILED'); // not a JPEG
      return { data, mimeType: 'image/jpeg', width: width as number, height: height as number };
    } finally {
      try { fs.rmSync(full, { force: true }); } catch { /* swept at next start */ }
    }
  }

  async close(): Promise<void> {
    const c = this.child;
    this.sessionOpen = false;
    if (!c) return;
    if (!this.pending) { try { await this.request('close', {}, 2000); } catch { /* killed below */ } }
    this.terminate();
  }

  // — process plumbing —

  private async ensureStarted(): Promise<void> {
    if (this.child) return this.starting ?? undefined;
    fs.mkdirSync(this.o.outDir, { recursive: true });
    for (const f of fs.readdirSync(this.o.outDir)) if (SHOT_NAME.test(f)) fs.rmSync(path.join(this.o.outDir, f), { force: true }); // leftovers of an abandoned shot
    let child: Child;
    try {
      child = spawn(this.o.command, [...(this.o.args ?? []), '--out-dir', this.o.outDir], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        // Deliberately minimal: nothing of the bridge's environment (tokens, URLs, secrets) reaches the helper.
        env: { SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' },
        cwd: path.isAbsolute(this.o.command) ? path.dirname(this.o.command) : undefined, // the SDK DLLs sit next to the helper
      });
    } catch { throw new SonyBackendError('DRIVER_UNAVAILABLE'); }
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) this.onLine(child, line);
      }
      if (buf.length > MAX_LINE) { buf = ''; this.kill(new SonyBackendError('PROTOCOL_ERROR')); }
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => this.onExit(child, true));
    child.on('exit', () => this.onExit(child, false));
    this.starting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(this.kill(new SonyBackendError('DRIVER_UNAVAILABLE'))); }, this.o.readyTimeoutMs ?? 10_000);
      this.readyHook = (ok) => { clearTimeout(timer); ok ? resolve() : reject(new SonyBackendError('DRIVER_UNAVAILABLE')); };
    });
    this.starting.catch(() => undefined);
    return this.starting;
  }
  private readyHook: ((ok: boolean) => void) | null = null;

  private onLine(child: Child, line: string) {
    if (child !== this.child) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('shape'); } catch { this.kill(new SonyBackendError('PROTOCOL_ERROR')); return; }
    if (typeof m.event === 'string') {
      if (m.event === 'ready') { if (m.protocol === PROTOCOL) { this.readyHook?.(true); } else { this.kill(new SonyBackendError('PROTOCOL_ERROR')); } this.readyHook = null; }
      else if (m.event === 'disconnected') { const had = this.sessionOpen; this.sessionOpen = false; this.exitReason = new SonyBackendError('DEVICE_LOST'); this.terminate(); if (had) this.disconnectCb?.(); }
      return; // unknown events are ignored
    }
    const p = this.pending;
    if (!p || m.id !== p.id) { this.kill(new SonyBackendError('PROTOCOL_ERROR')); return; }
    clearTimeout(p.timer); this.pending = null;
    if (m.ok === true) return p.resolve(m);
    if (m.ok === false && typeof m.failure === 'string' && (SONY_FAILURES as readonly string[]).includes(m.failure)) return p.reject(new SonyBackendError(m.failure as SonyFailure));
    p.reject(this.kill(new SonyBackendError('PROTOCOL_ERROR')));
  }

  private onExit(child: Child, spawnError: boolean) {
    if (child !== this.child) return;
    this.child = null; this.starting = null;
    const hadSession = this.sessionOpen; this.sessionOpen = false;
    this.readyHook?.(false); this.readyHook = null;
    const p = this.pending; this.pending = null;
    const reason = this.exitReason; this.exitReason = null;
    if (p) { clearTimeout(p.timer); p.reject(reason ?? new SonyBackendError(spawnError ? 'DRIVER_UNAVAILABLE' : hadSession ? 'DEVICE_LOST' : 'PROTOCOL_ERROR')); }
    if (hadSession) this.disconnectCb?.();
  }

  /** Kills the helper (the only way to guarantee an abandoned operation can never complete later). Returns `e` for `throw this.kill(...)`. */
  private kill(e: SonyBackendError): SonyBackendError {
    this.exitReason = e;
    this.terminate();
    return e;
  }
  private terminate() {
    const c = this.child;
    if (!c) return;
    try { c.kill(); } catch { /* already gone */ }
    this.onExit(c, false);
  }

  private async request(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new SonyBackendError('DRIVER_UNAVAILABLE');
    if (this.pending) throw new SonyBackendError('CAMERA_BUSY');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = timeoutMs ?? this.o.opTimeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        // The operation may or may not have fired the shutter; the helper is killed so it can never finish later.
        this.pending = null; this.terminate(); reject(new SonyBackendError('TIMEOUT'));
      }, t);
      this.pending = { id, op, resolve, reject, timer };
      try { child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n'); }
      catch { clearTimeout(timer); this.pending = null; this.terminate(); reject(new SonyBackendError('PROTOCOL_ERROR')); }
    });
  }
}
