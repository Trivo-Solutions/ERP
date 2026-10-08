import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { WEBCAM_FAILURES, WebcamBackend, WebcamBackendError, WebcamDevice, WebcamFailure, WebcamShot } from './WebcamBackend';

// The real backend: a small native helper process (trivo-webcam-helper.exe) that drives Windows cameras through Media Foundation
// and speaks newline-delimited JSON over stdin/stdout (contract: docs/WEBCAM_HELPER_PROTOCOL.md — protocol v1, the same wire
// format as the Sony helper, with a `placement` hint and a `local` connection kind added to `list`). The helper knows only
// cameras — it is never given a token, ticket, station credential, company, tag or ERP URL, and it runs with a minimal environment.
//
// This mirrors HelperSonyBackend on purpose (same process-supervision rules) but is kept separate: the Sony files are frozen, and a
// generic webcam helper must not pose as a Sony one.
//
// The image never travels over the pipe: the helper writes it into the bridge-owned `outDir` under a name the BRIDGE chose,
// and the bridge reads it back, checks it, and deletes it.

const PROTOCOL = 1;
const MAX_LINE = 64 * 1024;
const MAX_IMAGE_BYTES = 120 * 1024 * 1024;
const SHOT_NAME = /^shot-[0-9a-f-]{36}\.jpg$/;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const DEVICE_MODEL = /^[A-Za-z0-9._ -]{1,40}$/;

export interface HelperWebcamOptions {
  /** Executable to spawn. In production this comes only from validated local configuration (see resolveWebcamHelperPath). */
  command: string;
  /** Extra argv before the bridge's own (tests run a Node script; production passes none). */
  args?: string[];
  /** Bridge-owned directory the helper writes shots into (its leaf name must be `webcam-shots`). */
  outDir: string;
  readyTimeoutMs?: number;
  opTimeoutMs?: number;
}

/** Validates a configured helper path: absolute, an existing regular file, a .exe on Windows. Throws DRIVER_UNAVAILABLE. */
export function resolveWebcamHelperPath(configured: string | undefined, defaultPath: string, platform: NodeJS.Platform = process.platform): string {
  const p = configured ?? defaultPath;
  if (!path.isAbsolute(p)) throw new WebcamBackendError('DRIVER_UNAVAILABLE');
  if (platform === 'win32' && path.extname(p).toLowerCase() !== '.exe') throw new WebcamBackendError('DRIVER_UNAVAILABLE');
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new WebcamBackendError('DRIVER_UNAVAILABLE'); }
  if (!st.isFile()) throw new WebcamBackendError('DRIVER_UNAVAILABLE');
  return p;
}

type Child = ChildProcessByStdio<Writable, Readable, null>;

interface Pending { id: number; op: string; resolve: (m: Record<string, unknown>) => void; reject: (e: WebcamBackendError) => void; timer: NodeJS.Timeout }

export class HelperWebcamBackend implements WebcamBackend {
  private child: Child | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private disconnectCb: (() => void) | null = null;
  private sessionOpen = false;
  private starting: Promise<void> | null = null;
  /** Why the helper is going away, when we know better than "it exited" (protocol violation, device loss). */
  private exitReason: WebcamBackendError | null = null;

  constructor(private readonly o: HelperWebcamOptions) {}

  onDisconnected(cb: () => void): void { this.disconnectCb = cb; }

  async listDevices(): Promise<WebcamDevice[]> {
    const r = await this.request('list');
    if (!Array.isArray(r.devices) || r.devices.length > 32) throw this.kill(new WebcamBackendError('PROTOCOL_ERROR'));
    return r.devices.map((d: unknown) => {
      const x = d as Record<string, unknown>;
      if (!x || typeof x.id !== 'string' || typeof x.model !== 'string' || !DEVICE_ID.test(x.id) || !DEVICE_MODEL.test(x.model)
        || (x.connection !== 'usb' && x.connection !== 'network' && x.connection !== 'local')
        || (x.placement !== undefined && x.placement !== 'integrated')) throw this.kill(new WebcamBackendError('PROTOCOL_ERROR'));
      return { id: x.id, model: x.model, connection: x.connection, ...(x.placement === 'integrated' ? { placement: 'integrated' as const } : {}) };
    });
  }

  async connect(deviceId: string): Promise<void> {
    await this.request('connect', { deviceId });
    this.sessionOpen = true;
  }

  async shootAndFetch(opts: { timeoutMs?: number } = {}): Promise<WebcamShot> {
    const file = `shot-${randomUUID()}.jpg`;
    const full = path.join(this.o.outDir, file);
    try {
      const r = await this.request('shoot', { file }, opts.timeoutMs);
      const { width, height } = r;
      if (r.file !== file || !Number.isInteger(width) || !Number.isInteger(height)
        || (width as number) < 1 || (height as number) < 1 || (width as number) > 100_000 || (height as number) > 100_000) {
        throw this.kill(new WebcamBackendError('PROTOCOL_ERROR'));
      }
      let data: Buffer;
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 4 || st.size > MAX_IMAGE_BYTES) throw new Error('size');
        data = fs.readFileSync(full);
      } catch { throw new WebcamBackendError('TRANSFER_FAILED'); }
      if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new WebcamBackendError('TRANSFER_FAILED'); // not a JPEG
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
        cwd: path.isAbsolute(this.o.command) ? path.dirname(this.o.command) : undefined,
      });
    } catch { throw new WebcamBackendError('DRIVER_UNAVAILABLE'); }
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
      if (buf.length > MAX_LINE) { buf = ''; this.kill(new WebcamBackendError('PROTOCOL_ERROR')); }
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => this.onExit(child, true));
    child.on('exit', () => this.onExit(child, false));
    this.starting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(this.kill(new WebcamBackendError('DRIVER_UNAVAILABLE'))); }, this.o.readyTimeoutMs ?? 10_000);
      this.readyHook = (ok) => { clearTimeout(timer); ok ? resolve() : reject(new WebcamBackendError('DRIVER_UNAVAILABLE')); };
    });
    this.starting.catch(() => undefined);
    return this.starting;
  }
  private readyHook: ((ok: boolean) => void) | null = null;

  private onLine(child: Child, line: string) {
    if (child !== this.child) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('shape'); } catch { this.kill(new WebcamBackendError('PROTOCOL_ERROR')); return; }
    if (typeof m.event === 'string') {
      if (m.event === 'ready') { if (m.protocol === PROTOCOL) { this.readyHook?.(true); } else { this.kill(new WebcamBackendError('PROTOCOL_ERROR')); } this.readyHook = null; }
      else if (m.event === 'disconnected') { const had = this.sessionOpen; this.sessionOpen = false; this.exitReason = new WebcamBackendError('DEVICE_LOST'); this.terminate(); if (had) this.disconnectCb?.(); }
      return; // unknown events are ignored
    }
    const p = this.pending;
    if (!p || m.id !== p.id) { this.kill(new WebcamBackendError('PROTOCOL_ERROR')); return; }
    clearTimeout(p.timer); this.pending = null;
    if (m.ok === true) return p.resolve(m);
    if (m.ok === false && typeof m.failure === 'string' && (WEBCAM_FAILURES as readonly string[]).includes(m.failure)) return p.reject(new WebcamBackendError(m.failure as WebcamFailure));
    p.reject(this.kill(new WebcamBackendError('PROTOCOL_ERROR')));
  }

  private onExit(child: Child, spawnError: boolean) {
    if (child !== this.child) return;
    this.child = null; this.starting = null;
    const hadSession = this.sessionOpen; this.sessionOpen = false;
    this.readyHook?.(false); this.readyHook = null;
    const p = this.pending; this.pending = null;
    const reason = this.exitReason; this.exitReason = null;
    if (p) { clearTimeout(p.timer); p.reject(reason ?? new WebcamBackendError(spawnError ? 'DRIVER_UNAVAILABLE' : hadSession ? 'DEVICE_LOST' : 'PROTOCOL_ERROR')); }
    if (hadSession) this.disconnectCb?.();
  }

  /** Kills the helper (the only way to guarantee an abandoned operation can never complete later). Returns `e` for `throw this.kill(...)`. */
  private kill(e: WebcamBackendError): WebcamBackendError {
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
    if (!child) throw new WebcamBackendError('DRIVER_UNAVAILABLE');
    if (this.pending) throw new WebcamBackendError('CAMERA_BUSY');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = timeoutMs ?? this.o.opTimeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        // The operation may or may not have grabbed a frame; the helper is killed so it can never finish later.
        this.pending = null; this.terminate(); reject(new WebcamBackendError('TIMEOUT'));
      }, t);
      this.pending = { id, op, resolve, reject, timer };
      try { child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n'); }
      catch { clearTimeout(timer); this.pending = null; this.terminate(); reject(new WebcamBackendError('PROTOCOL_ERROR')); }
    });
  }
}
