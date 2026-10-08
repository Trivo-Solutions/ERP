import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge';
import { CameraController } from '../src/camera/CameraController';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { SonyCameraProvider } from '../src/camera/sony/SonyCameraProvider';
import { CaptureExecutor } from '../src/capture/captureExecutor';
import { CaptureTransport, PollOutcome, ReportOutcome, StatusReport, UploadOutcome, UploadRequest } from '../src/capture/captureTransport';
import { TempStore } from '../src/capture/tempStore';
import { checkStation } from '../src/check';
import { ConfigError, loadConfig } from '../src/config';
import { mergedEnv, parseConfigFile, readConfigFile, writeConfigFile } from '../src/configFile';
import { CredentialStore } from '../src/credentials';
import { ErpTransport, TransportResult } from '../src/erpTransport';
import { InstanceLock, InstanceLockError } from '../src/instanceLock';
import { createFileSink, createLogger } from '../src/logger';
import { CREDENTIAL_SHAPE, parseArgs, provision } from '../src/provision';

const STATION = 'MANIKONDA-PHOTO-01';
const SECRET = `stn_cm1abc2def.${'A1b2C3d4'.repeat(6)}`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TICKET = `${b64({ alg: 'HS256' })}.${b64({ sid: STATION, exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln${'x'.repeat(10)}`;
const command = (id = 'cmd1') => ({
  commandId: id, correlationId: `corr-${id}`, stationId: STATION, imageType: 'PRIMARY', tagNumber: 'T-1', ticket: TICKET,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
});
const code = (file: string) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const baseEnv = { TRIVO_API_URL: 'https://erp.example.com', STATION_ID: STATION, CAMERA_PROVIDER: 'mock' };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-ops-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function memStore(initial: string | null = null): CredentialStore & { value: string | null } {
  const s = { kind: 'dpapi' as const, value: initial, load: async () => s.value, save: async (v: string) => { s.value = v; } };
  return s;
}

// ── configuration ──────────────────────────────────────────────────────────────────────────────────────────────
describe('configuration: production vs development', () => {
  const prod = { ...baseEnv, NODE_ENV: 'production' };
  it('requires https in production, including for localhost unless explicitly allowed', () => {
    expect(() => loadConfig({ ...prod, TRIVO_API_URL: 'http://erp.example.com' } as never)).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, TRIVO_API_URL: 'http://localhost:5000' } as never)).toThrow(/https in production/);
    expect(loadConfig({ ...prod, TRIVO_API_URL: 'http://localhost:5000', TRIVO_ALLOW_LOCALHOST_HTTP: '1' } as never).apiUrl).toBe('http://localhost:5000');
    expect(loadConfig({ ...baseEnv, TRIVO_API_URL: 'http://localhost:5000' } as never).production).toBe(false); // dev: unchanged
  });
  it('refuses a URL that carries credentials or a query', () => {
    for (const u of ['https://u:p@erp.example.com', 'https://erp.example.com/?k=v']) expect(() => loadConfig({ ...baseEnv, TRIVO_API_URL: u } as never)).toThrow(ConfigError);
  });
  it('requires an explicit camera provider in production and warns about the mock camera', () => {
    const { CAMERA_PROVIDER: _omit, ...noProvider } = prod;
    expect(() => loadConfig(noProvider as never)).toThrow(/CAMERA_PROVIDER is required/);
    expect(loadConfig(prod as never).warnings).toEqual(['MOCK_CAMERA_IN_PRODUCTION']);
    expect(loadConfig({ ...prod, CAMERA_PROVIDER: 'sony' } as never).warnings).toEqual([]);
    expect(loadConfig({ TRIVO_API_URL: baseEnv.TRIVO_API_URL, STATION_ID: STATION } as never).cameraProvider).toBe('mock'); // dev default kept
  });
  it('rejects invalid station ids, providers, numbers and log levels clearly', () => {
    for (const bad of [{ STATION_ID: '' }, { STATION_ID: 'a b' }, { STATION_ID: 'x'.repeat(65) }, { CAMERA_PROVIDER: 'canon' }, { BRIDGE_PORT: '0' }, { BRIDGE_PORT: '12ab' },
      { CAPTURE_TIMEOUT_MS: '10' }, { LOG_LEVEL: 'chatty' }, { BRIDGE_TEMP_MAX_MB: '0' }]) {
      expect(() => loadConfig({ ...baseEnv, ...bad } as never)).toThrow(ConfigError);
    }
  });
  it('reads the optional knobs', () => {
    const c = loadConfig({ ...baseEnv, LOG_LEVEL: 'debug', CAPTURE_TIMEOUT_MS: '20000', BRIDGE_TEMP_MAX_MB: '50' } as never);
    expect(c.logLevel).toBe('debug');
    expect(c.capture).toMatchObject({ captureTimeoutMs: 20000, tempMaxBytes: 50 * 1024 * 1024 });
  });
});

describe('configuration: provider options stay behind the provider boundary', () => {
  it('accepts only the options a provider declares, with validated values', () => {
    expect(loadConfig({ ...baseEnv, CAMERA_PROVIDER: 'sony', CAMERA_OPT_MODEL: 'ILCE-7RM5', CAMERA_OPT_CONNECTION: 'usb' } as never).cameraOptions)
      .toEqual({ MODEL: 'ILCE-7RM5', CONNECTION: 'usb' });
    expect(() => loadConfig({ ...baseEnv, CAMERA_PROVIDER: 'sony', CAMERA_OPT_CONNECTION: 'bluetooth' } as never)).toThrow(/invalid value/);
    expect(() => loadConfig({ ...baseEnv, CAMERA_PROVIDER: 'sony', CAMERA_OPT_TYPO: 'x' } as never)).toThrow(/not a setting/);
    expect(() => loadConfig({ ...baseEnv, CAMERA_OPT_MODEL: 'x' } as never)).toThrow(/not a setting of the "mock"/);
  });
  it('the generic provider contract and the bridge core name no vendor', () => {
    for (const f of ['camera/types.ts', 'camera/CameraController.ts', 'bridge.ts', 'capture/captureExecutor.ts']) {
      expect(code(f)).not.toMatch(/sony/i);
    }
  });
  it('a provider receives only options — never station, ERP or credential data', () => {
    const p = new SonyCameraProvider({ settings: { MODEL: 'ILCE-7RM5' } });
    expect(p.settings).toEqual({ MODEL: 'ILCE-7RM5' });
    expect(code('camera/types.ts')).not.toMatch(/credential|ticket|companyId|branchId|prisma|storage/i);
  });
});

describe('settings file', () => {
  it('merges under the environment and round-trips', () => {
    const f = path.join(dir, 'bridge.config.json');
    writeConfigFile(f, { TRIVO_API_URL: 'https://a.example.com', STATION_ID: 'S1' });
    expect(readConfigFile(f)).toEqual({ TRIVO_API_URL: 'https://a.example.com', STATION_ID: 'S1' });
    expect(mergedEnv(f, { STATION_ID: 'S2' } as never)).toMatchObject({ TRIVO_API_URL: 'https://a.example.com', STATION_ID: 'S2' });
    expect(readConfigFile(path.join(dir, 'missing.json'))).toEqual({});
  });
  it('refuses secrets, unknown keys, bad JSON and non-objects', () => {
    for (const bad of ['{"STATION_SECRET":"x"}', '{"TRIVO_STATION_SECRET_DEV":"x"}', '{"credential":"x"}', '{"TYPO":"x"}', '{not json', '[]', '{"STATION_ID":{"a":1}}']) {
      expect(() => parseConfigFile(bad), bad).toThrow(ConfigError);
    }
    expect(() => writeConfigFile(path.join(dir, 'x.json'), { password: 'p' })).toThrow(ConfigError);
    expect(fs.existsSync(path.join(dir, 'x.json'))).toBe(false);
  });
});

// ── provisioning ───────────────────────────────────────────────────────────────────────────────────────────────
describe('provisioning', () => {
  const args = () => parseArgs(['--api-url', 'https://erp.example.com', '--station-id', STATION]);
  const run = async (secret: string, extra: Partial<Parameters<typeof provision>[1]> = {}, a = args()) => {
    const store = memStore(); const out: string[] = []; const configFile = path.join(dir, 'bridge.config.json');
    const code = await provision(a, { store, configFile, readSecret: async () => secret, out: (l) => out.push(l), ...extra });
    return { code, store, out, configFile, text: out.join('\n') };
  };

  it('stores a well-formed credential, writes only non-secret settings, and never echoes it', async () => {
    const r = await run(SECRET, { verify: async () => 'OK' });
    expect(r.code).toBe(0);
    expect(r.store.value).toBe(SECRET);
    const file = fs.readFileSync(r.configFile, 'utf8');
    expect(JSON.parse(file)).toEqual({ TRIVO_API_URL: 'https://erp.example.com', STATION_ID: STATION, CAMERA_PROVIDER: 'mock' });
    expect(file).not.toContain(SECRET);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toMatch(/authorized user/);
    expect(r.text).toMatch(/station:capture/);
    expect(r.text).toMatch(/will not be displayed again/);
  });
  it('--dev without --api-url uses the ERP default dev API URL; production still requires an explicit one', async () => {
    const dev = await run(SECRET, {}, parseArgs(['--station-id', STATION, '--provider', 'webcam', '--dev']));
    expect(dev.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(dev.configFile, 'utf8'))).toEqual({ TRIVO_API_URL: 'http://localhost:3001', STATION_ID: STATION, CAMERA_PROVIDER: 'webcam' });
    const prod = await run(SECRET, {}, parseArgs(['--station-id', STATION]));
    expect(prod.code).toBe(2); expect(prod.store.value).toBeNull();
  });
  it('a missing / empty credential changes nothing', async () => {
    const r = await run('   ');
    expect(r.code).toBe(2);
    expect(r.store.value).toBeNull();
    expect(fs.existsSync(r.configFile)).toBe(false);
  });
  it('a malformed credential is rejected without being echoed or stored', async () => {
    for (const bad of ['hunter2', 'stn_x.short', `Bearer ${SECRET}`, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln']) {
      const r = await run(bad);
      expect(r.code).toBe(2);
      expect(r.store.value).toBeNull();
      expect(r.text).not.toContain(bad);
    }
    expect(CREDENTIAL_SHAPE.test(SECRET)).toBe(true);
  });
  it('invalid settings are rejected before the credential is even requested', async () => {
    let asked = false;
    const r = await run(SECRET, { readSecret: async () => { asked = true; return SECRET; } }, parseArgs(['--api-url', 'http://erp.example.com', '--station-id', STATION]));
    expect(r.code).toBe(2); expect(asked).toBe(false); expect(r.store.value).toBeNull();
    expect((await run(SECRET, {}, parseArgs(['--api-url', 'https://erp.example.com', '--station-id', '']))).code).toBe(2);
    expect((await run(SECRET, {}, parseArgs(['--api-url', 'https://erp.example.com', '--station-id', STATION, '--provider', 'canon']))).code).toBe(2);
    expect((await run(SECRET, {}, parseArgs(['--api-url', 'https://erp.example.com', '--station-id', STATION, '--secret', 'x']))).code).toBe(2); // no secret via argv
  });
  it('--dev allows a localhost http server; production provisioning does not', async () => {
    const dev = parseArgs(['--api-url', 'http://localhost:5000', '--station-id', STATION, '--dev']);
    expect((await run(SECRET, {}, dev)).code).toBe(0);
    expect((await run(SECRET, {}, parseArgs(['--api-url', 'http://localhost:5000', '--station-id', STATION]))).code).toBe(2);
  });
  it('reports a credential the ERP refuses (stored, exit 1) and an unreachable ERP (stored, exit 0)', async () => {
    expect((await run(SECRET, { verify: async () => 'CREDENTIAL_REJECTED' })).code).toBe(1);
    expect((await run(SECRET, { verify: async () => 'CAPTURE_SCOPE_MISSING' })).text).toMatch(/issue a new credential/);
    expect((await run(SECRET, { verify: async () => 'ERP_UNREACHABLE' })).code).toBe(0);
  });
  it('replacing says so', async () => {
    const store = memStore('old'); const out: string[] = [];
    await provision(args(), { store, configFile: path.join(dir, 'c.json'), readSecret: async () => SECRET, out: (l) => out.push(l) });
    expect(out.join('\n')).toMatch(/Replaced/);
    expect(store.value).toBe(SECRET);
  });
  it('the bridge has no command that prints the credential', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(src).not.toMatch(/get-credential|show-credential|print.*secret/i);
    expect(src).not.toMatch(/console\.log\([^)]*secret/);
  });
});

describe('check: old heartbeat-only credential', () => {
  const erp = (r: TransportResult): ErpTransport => ({ sendHeartbeat: async () => r });
  const cap = (r: PollOutcome): CaptureTransport => ({ pollCommand: async () => r, reportStatus: async () => ({ ok: true }), uploadImage: async () => ({ ok: false, kind: 'NETWORK', retryable: true }) });
  const cfg = loadConfig(baseEnv as never);
  it('heartbeat accepted but capture refused => CAPTURE_SCOPE_MISSING', async () => {
    expect(await checkStation(cfg, SECRET, erp({ ok: true }), cap({ ok: false, kind: 'AUTH' }))).toBe('CAPTURE_SCOPE_MISSING');
  });
  it('maps every outcome to a category', async () => {
    expect(await checkStation(cfg, SECRET, erp({ ok: true }), cap({ ok: true, command: null }))).toBe('OK');
    expect(await checkStation(cfg, SECRET, erp({ ok: false, kind: 'AUTH' }), cap({ ok: true, command: null }))).toBe('CREDENTIAL_REJECTED');
    expect(await checkStation(cfg, SECRET, erp({ ok: false, kind: 'REJECTED' }), cap({ ok: true, command: null }))).toBe('STATION_ID_MISMATCH');
    expect(await checkStation(cfg, SECRET, erp({ ok: false, kind: 'NETWORK' }), cap({ ok: true, command: null }))).toBe('ERP_UNREACHABLE');
  });
});

// ── lifecycle / shutdown ───────────────────────────────────────────────────────────────────────────────────────
class PollTransport implements CaptureTransport {
  queue: unknown[] = [];
  polls = 0; aborted = 0;
  reports: Array<{ commandId: string; report: StatusReport }> = [];
  uploads: UploadRequest[] = [];
  uploadHook: (() => Promise<UploadOutcome>) | null = null;
  async pollCommand(_s: string, _w: number, signal?: AbortSignal): Promise<PollOutcome> {
    this.polls++;
    const next = this.queue.shift();
    if (next !== undefined) return { ok: true, command: next };
    return new Promise((resolve) => { // a long poll that only ends when aborted
      const t = setTimeout(() => resolve({ ok: true, command: null }), 5000);
      signal?.addEventListener('abort', () => { this.aborted++; clearTimeout(t); resolve({ ok: false, kind: 'NETWORK' }); }, { once: true });
    });
  }
  async reportStatus(_s: string, commandId: string, report: StatusReport): Promise<ReportOutcome> { this.reports.push({ commandId, report }); return { ok: true }; }
  async uploadImage(_s: string, req: UploadRequest): Promise<UploadOutcome> { this.uploads.push(req); return this.uploadHook ? this.uploadHook() : { ok: true, imageId: 'img-1', replay: false }; }
  statuses() { return this.reports.map((r) => r.report.status); }
}

const okErp: ErpTransport = { sendHeartbeat: async () => ({ ok: true }) };
let bridges: Bridge[] = [];
afterEach(async () => { await Promise.all(bridges.map((b) => b.stop())); bridges = []; });

async function boot(o: { provider?: MockCameraProvider; transport?: PollTransport; shutdownTimeoutMs?: number; captureTimeoutMs?: number; creds?: CredentialStore } = {}) {
  const lines: string[] = [];
  const transport = o.transport ?? new PollTransport();
  const provider = o.provider ?? new MockCameraProvider();
  const bridge = new Bridge({
    config: { apiUrl: 'https://erp.example.com', stationId: STATION, cameraProvider: 'mock', cameraOptions: {}, port: 0, heartbeatIntervalMs: 60_000, production: true, logLevel: 'debug', warnings: [],
      capture: { tempDir: path.join(dir, 'tmp'), shutdownTimeoutMs: o.shutdownTimeoutMs ?? 5000, captureTimeoutMs: o.captureTimeoutMs ?? 5000, uploadBackoffMs: 1, commandWaitSeconds: 1 } },
    provider, credentials: o.creds ?? memStore(SECRET), transport: okErp, captureTransport: transport, log: createLogger({ sink: (l) => lines.push(l), level: 'debug' }),
    heartbeat: { baseBackoffMs: 1, maxBackoffMs: 2 },
  });
  bridges.push(bridge);
  const port = await bridge.start();
  return { bridge, port, lines, transport, provider };
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const get = (port: number, p: string, host?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host ?? `127.0.0.1:${port}` } }, (res) => { let text = ''; res.on('data', (d) => (text += d)); res.on('end', () => resolve({ status: res.statusCode!, text })); }).on('error', reject);
});

describe('lifecycle', () => {
  it('clean startup logs the operational events and reports a credentialed, running bridge', async () => {
    const { port, lines } = await boot();
    const s = JSON.parse((await get(port, '/status')).text);
    expect(s.bridge).toMatchObject({ status: 'RUNNING', mode: 'production' });
    const j = lines.join('\n');
    for (const e of ['bridge.starting', 'station.credential_present', 'camera.state', 'bridge.started']) expect(j).toContain(e);
  });
  it('shutdown stops heartbeat and command polling (aborting the long poll), disconnects the camera and frees the port', async () => {
    const { bridge, port, transport, provider, lines } = await boot();
    await until(() => transport.polls >= 1);
    await bridge.stop();
    expect(transport.aborted).toBe(1);
    const polls = transport.polls;
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.polls).toBe(polls);              // no further polls
    expect(bridge.heartbeat.getStatus().state).toBeDefined();
    expect((await provider.getStatus()).state).toBe('DISCONNECTED');
    await expect(get(port, '/health')).rejects.toThrow();
    const j = lines.join('\n');
    expect(j).toContain('bridge.stopping'); expect(j).toContain('bridge.stopped');
    expect(j).not.toContain('shutdown_timeout');
  });
  it('stop() is idempotent', async () => {
    const { bridge } = await boot();
    await Promise.all([bridge.stop(), bridge.stop()]);
    await bridge.stop();
  });
  it('shutdown waits for the in-flight upload to finish its step and the command completes', async () => {
    const t = new PollTransport(); t.queue.push(command());
    let release!: () => void;
    t.uploadHook = () => new Promise((res) => { release = () => res({ ok: true, imageId: 'img-1', replay: false }); });
    const { bridge, lines } = await boot({ transport: t });
    await until(() => t.uploads.length === 1);
    const stopping = bridge.stop();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await stopping;
    expect(lines.join('\n')).toContain('"code":"SUCCESS"');
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]); // uploaded => nothing kept
  });
  it('shutdown is bounded: a camera that never answers does not hold the process, and the abandoned command is logged', async () => {
    const t = new PollTransport(); t.queue.push(command());
    const provider = new MockCameraProvider({ captureDelayMs: 4000 });
    const { bridge, lines, port } = await boot({ transport: t, provider, shutdownTimeoutMs: 150, captureTimeoutMs: 10_000 });
    await until(() => t.statuses().includes('CAPTURING'));
    const live = JSON.parse((await get(port, '/status')).text);
    expect(live.capture.current).toMatchObject({ commandId: 'cmd1', phase: 'CAPTURING' });
    const t0 = Date.now();
    await bridge.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(lines.join('\n')).toContain('bridge.shutdown_timeout');
    expect(t.uploads).toHaveLength(0); // the abandoned command is not retried or uploaded by this process
  });
  it('a command that arrives after shutdown began is refused before any report or capture (the ERP keeps it QUEUED)', async () => {
    const log = createLogger({ sink: () => undefined });
    const provider = new MockCameraProvider(); await provider.connect();
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const t = new PollTransport();
    const ex = new CaptureExecutor({ stationId: STATION, captureTimeoutMs: 1000, uploadTimeoutMs: 1000, uploadMaxAttempts: 3, uploadBackoffMs: 1, cameraLabel: 'mock' },
      new CameraController(provider, log), memStore(SECRET), t, new TempStore(path.join(dir, 't'), 60_000, log), log);
    ex.beginShutdown();
    expect(await ex.handle(command())).toMatchObject({ code: 'COMMAND_REJECTED', detail: 'SHUTTING_DOWN' });
    expect(shots).toBe(0); expect(t.reports).toHaveLength(0);
  });
  it('upload retries stop once shutdown begins and the image stays for the retention sweep', async () => {
    const t = new PollTransport(); t.queue.push(command());
    let calls = 0; let bridgeRef: Bridge;
    t.uploadHook = async () => { calls++; if (calls === 1) void bridgeRef.stop(); return { ok: false, kind: 'NETWORK', retryable: true }; };
    const { bridge } = await boot({ transport: t }); bridgeRef = bridge;
    await until(() => calls >= 1);
    await bridge.stop();
    expect(calls).toBe(1);
  });
  it('an unavailable ERP does not stop the bridge; a missing credential reports NOT_CONFIGURED', async () => {
    const { port } = await boot({ creds: memStore(null) });
    const s = JSON.parse((await get(port, '/status')).text);
    expect(s.station.status).toBe('NOT_CONFIGURED');
    expect(s.erp.connectivity).toBe('NOT_CONFIGURED');
  });
});

// ── crash / restart ────────────────────────────────────────────────────────────────────────────────────────────
describe('crash and restart safety', () => {
  const rebuild = (provider: MockCameraProvider, t: PollTransport) => {
    const log = createLogger({ sink: () => undefined });
    return new CaptureExecutor({ stationId: STATION, captureTimeoutMs: 1000, uploadTimeoutMs: 1000, uploadMaxAttempts: 3, uploadBackoffMs: 1, cameraLabel: 'mock' },
      new CameraController(provider, log), memStore(SECRET), t, new TempStore(path.join(dir, 't'), 60_000, log), log);
  };
  // The ERP's own rule (captureCommand.service.ts): a command is re-delivered only while QUEUED. Past ACCEPTED, the report
  // endpoint answers 409 COMMAND_STATE — which is all a restarted bridge ever sees of a command its predecessor touched.
  class ErpAfterAck extends PollTransport {
    override async reportStatus(_s: string, commandId: string, report: StatusReport): Promise<ReportOutcome> { this.reports.push({ commandId, report }); return report.status === 'ACCEPTED' ? { ok: false, kind: 'STATE' } : { ok: true }; }
  }
  it('restart before capture: a command the ERP still holds QUEUED runs exactly once on the new process', async () => {
    const provider = new MockCameraProvider(); await provider.connect();
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const t = new PollTransport();
    expect(await rebuild(provider, t).handle(command())).toMatchObject({ code: 'SUCCESS' });
    expect(shots).toBe(1); expect(t.uploads).toHaveLength(1);
  });
  it('restart during/after capture: the redelivered command is refused by the ERP (not QUEUED) and is NOT captured again', async () => {
    const provider = new MockCameraProvider(); await provider.connect();
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const t = new ErpAfterAck();
    // A brand-new executor (= restarted process: empty memory) is handed the command the dead process had accepted.
    const r = await rebuild(provider, t).handle(command());
    expect(r).toMatchObject({ code: 'COMMAND_REJECTED', detail: 'COMMAND_STATE' });
    expect(shots).toBe(0); expect(t.uploads).toHaveLength(0);
  });
  it('restart after a successful upload: no second image', async () => {
    const provider = new MockCameraProvider(); await provider.connect();
    let shots = 0; const orig = provider.capture.bind(provider); provider.capture = async (q) => { shots++; return orig(q); };
    const first = new PollTransport();
    await rebuild(provider, first).handle(command());
    const second = new ErpAfterAck();
    await rebuild(provider, second).handle(command()); // redelivered to the new process
    expect(shots).toBe(1); expect(first.uploads).toHaveLength(1); expect(second.uploads).toHaveLength(0);
  });
  it('upload retries inside one process reuse the same idempotency key', async () => {
    const provider = new MockCameraProvider(); await provider.connect();
    const t = new PollTransport(); let n = 0;
    t.uploadHook = async () => (++n < 3 ? { ok: false, kind: 'NETWORK', retryable: true } : { ok: true, imageId: 'i', replay: false });
    await rebuild(provider, t).handle(command());
    expect(t.uploads).toHaveLength(3);
    expect(new Set(t.uploads.map((u) => u.idempotencyKey)).size).toBe(1);
  });
  it('an image orphaned by a crash is swept after retention at the next start, and nothing else is touched', async () => {
    const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
    const old = `cap-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;
    fs.writeFileSync(path.join(tmp, `${old}.png`), 'x'); fs.writeFileSync(path.join(tmp, `${old}.json`), '{}'); fs.writeFileSync(path.join(tmp, 'notes.txt'), 'mine');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of [`${old}.png`, `${old}.json`, 'notes.txt']) fs.utimesSync(path.join(tmp, f), past, past);
    const { bridge } = await boot();
    await bridge.stop();
    expect(fs.readdirSync(tmp)).toEqual(['notes.txt']);
  });
});

// ── temp-file maintenance ──────────────────────────────────────────────────────────────────────────────────────
describe('temp area bounds', () => {
  const meta = (id: string) => ({ commandId: id, correlationId: id, idempotencyKey: `k-${id}`, imageType: 'PRIMARY', capturedAt: new Date().toISOString(), mimeType: 'image/png' });
  it('evicts the oldest retained images to stay under the byte cap, and refuses an image larger than the cap', async () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    let clock = Date.now();
    const store = new TempStore(path.join(dir, 't'), 3_600_000, log, () => clock, 2500);
    const a = await store.write(Buffer.alloc(1000), meta('a')); await new Promise((r) => setTimeout(r, 15));
    await store.write(Buffer.alloc(1000), meta('b')); await new Promise((r) => setTimeout(r, 15));
    await store.write(Buffer.alloc(1000), meta('c'));
    expect(fs.existsSync(a.imagePath)).toBe(false);
    expect(fs.existsSync(a.metaPath)).toBe(false);
    expect(fs.readdirSync(path.join(dir, 't')).filter((f) => f.endsWith('.png'))).toHaveLength(2);
    await expect(store.write(Buffer.alloc(3000), meta('d'))).rejects.toThrow();
    expect(lines.join('\n')).toContain('temp.evicted');
    clock += 1;
  });
  it('never deletes outside its directory or matching files it did not create', async () => {
    const outside = path.join(dir, 'outside.png'); fs.writeFileSync(outside, 'x');
    const t = path.join(dir, 't'); fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, 'cap-..%2f..%2foutside.png'), 'x'); fs.writeFileSync(path.join(t, 'photo.png'), 'x');
    const log = createLogger({ sink: () => undefined });
    await new TempStore(t, 0, log, () => Date.now() + 10_000, 1).sweep();
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readdirSync(t).sort()).toEqual(['cap-..%2f..%2foutside.png', 'photo.png']);
  });
});

// ── instance lock ──────────────────────────────────────────────────────────────────────────────────────────────
describe('single instance', () => {
  it('a second bridge for the same station is refused while the first is alive; a stale lock is taken over; release frees it', () => {
    const f = path.join(dir, 'bridge.lock');
    const a = new InstanceLock(f, process.pid); a.acquire();
    expect(() => new InstanceLock(f, process.pid + 1).acquire()).toThrow(InstanceLockError);
    a.release(); expect(fs.existsSync(f)).toBe(false);
    fs.writeFileSync(f, '2147483000'); // a pid that is not running
    const b = new InstanceLock(f, process.pid); b.acquire(); b.release();
  });
  it('release never removes a lock someone else now holds', () => {
    const f = path.join(dir, 'bridge.lock');
    const a = new InstanceLock(f, process.pid); a.acquire();
    fs.writeFileSync(f, '999999');
    a.release();
    expect(fs.existsSync(f)).toBe(true);
  });
});

// ── diagnostics ────────────────────────────────────────────────────────────────────────────────────────────────
describe('diagnostics', () => {
  it('reports provider, state, ERP connectivity, current command, last result and last error — and no secrets', async () => {
    const t = new PollTransport(); t.queue.push(command());
    t.uploadHook = async () => ({ ok: false, kind: 'REJECTED', retryable: false });
    const { port, bridge } = await boot({ transport: t });
    await until(() => bridge.commands!.getStatus().lastResult !== null);
    const raw = (await get(port, '/status')).text;
    const s = JSON.parse(raw);
    expect(s.camera).toMatchObject({ provider: 'mock', state: 'CONNECTED' });
    expect(s.erp).toMatchObject({ connectivity: 'REACHABLE' });
    expect(s.erp.lastHeartbeatSuccessAt).toBeTruthy();
    expect(s.capture).toMatchObject({ lastResult: { commandId: 'cmd1', code: 'UPLOAD_ERROR' }, current: null });
    expect(s.lastError).toMatchObject({ category: 'UPLOAD_ERROR' });
    expect(s.station.captureScope).toBe('OK');
    for (const forbidden of [SECRET, TICKET, 'stn_', 'eyJ', 'tmp', dir, 'idempotency', 'storage', 'Bearer', 'objectKey']) expect(raw, forbidden).not.toContain(forbidden);
    const cam = (await get(port, '/camera/status')).text;
    expect(cam).not.toContain(SECRET);
  });
  it('surfaces a pre-capture credential as captureScope REJECTED while the heartbeat is fine', async () => {
    const t = new PollTransport();
    t.pollCommand = async () => ({ ok: false, kind: 'AUTH' });
    const { port } = await boot({ transport: t });
    await until(() => true); await new Promise((r) => setTimeout(r, 150));
    const s = JSON.parse((await get(port, '/status')).text);
    expect(s.station.captureScope).toBe('REJECTED');
    expect(s.erp.connectivity).toBe('REACHABLE');
  });
  it('is loopback-only with Host-header protection and no CORS', async () => {
    const { port } = await boot();
    expect((await get(port, '/status', 'evil.example.com')).status).toBe(403);
    expect((await get(port, '/status', `rebind.example.com:${port}`)).status).toBe(403);
    expect((await get(port, '/status')).status).toBe(200);
    const src = fs.readFileSync(path.join(__dirname, '../src/localApi.ts'), 'utf8');
    expect(src).toContain("'127.0.0.1'");
    expect(src).not.toMatch(/['"]Access-Control/i);
  });
});

// ── logging ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('logging', () => {
  it('honours the level and redacts secret-like fields', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'warn' });
    log.info('ignored'); log.warn('kept', { ticket: TICKET, signedUrl: 'https://s3/x?sig=1', storageKey: 'companies/c/x', apiHost: 'erp.example.com' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TICKET); expect(lines[0]).not.toContain('sig=1'); expect(lines[0]).not.toContain('companies/');
    expect(lines[0]).toContain('erp.example.com');
  });
  it('a full command run logs the lifecycle events and none of the secrets', async () => {
    const t = new PollTransport(); t.queue.push(command());
    const { lines, bridge } = await boot({ transport: t });
    await until(() => lines.some((l) => l.includes('upload.completed')));
    await bridge.stop();
    const j = lines.join('\n');
    for (const e of ['command.accepted', 'capture.start', 'capture.end', 'upload.started', 'upload.completed', 'capture.result', 'bridge.stopping']) expect(j, e).toContain(e);
    for (const secret of [SECRET, TICKET, 'eyJ', 'Bearer']) expect(j).not.toContain(secret);
  });
  it('the file sink rotates by size and never throws', () => {
    const f = path.join(dir, 'logs', 'bridge.log');
    const sink = createFileSink(f, { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) sink(JSON.stringify({ n: i, pad: 'x'.repeat(30) }));
    const files = fs.readdirSync(path.dirname(f)).sort();
    expect(files).toEqual(['bridge.log', 'bridge.log.1', 'bridge.log.2']);
    expect(fs.statSync(f).size).toBeLessThanOrEqual(200);
    expect(() => createFileSink(path.join(dir, 'bridge.log', 'cannot', 'write'))('x')).not.toThrow();
  });
});

// ── camera provider boundary ───────────────────────────────────────────────────────────────────────────────────
describe('camera provider boundary', () => {
  it('a provider can express busy, unavailable, timeout and failure with neutral codes', async () => {
    const types = fs.readFileSync(path.join(__dirname, '../src/camera/types.ts'), 'utf8');
    for (const code of ['BUSY', 'NOT_CONNECTED', 'CONNECT_FAILED', 'CAPTURE_FAILED', 'CAPTURE_TIMEOUT']) expect(types).toContain(`'${code}'`);
    expect(types).toContain('timeoutMs');
  });
  it('the executor hands the provider the capture budget and reports a provider timeout as CAMERA_ERROR / CAPTURE_TIMEOUT', async () => {
    const log = createLogger({ sink: () => undefined });
    const provider = new MockCameraProvider(); await provider.connect();
    let seen: number | undefined;
    provider.capture = async (q) => { seen = q.timeoutMs; const { CameraError } = await import('../src/camera/types'); throw new CameraError('CAPTURE_TIMEOUT', 'slow'); };
    const t = new PollTransport();
    const ex = new CaptureExecutor({ stationId: STATION, captureTimeoutMs: 777, uploadTimeoutMs: 1000, uploadMaxAttempts: 1, uploadBackoffMs: 1, cameraLabel: 'mock' },
      new CameraController(provider, log), memStore(SECRET), t, new TempStore(path.join(dir, 't'), 60_000, log), log);
    expect(await ex.handle(command())).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_TIMEOUT' });
    expect(seen).toBe(777);
  });
});
