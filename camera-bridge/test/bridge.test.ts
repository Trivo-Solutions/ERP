import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { ConfigError, loadConfig } from '../src/config';
import { CredentialStore, DevEnvCredentialStore } from '../src/credentials';
import { ErpTransport, UnavailableTransport } from '../src/erpTransport';
import { createLogger, redact } from '../src/logger';
import { BRIDGE_VERSION } from '../src/version';

const SECRET = 'station-secret-DO-NOT-LEAK-456';
const store: CredentialStore = { kind: 'dev-env', load: async () => SECRET, save: async () => {} };
const config = { apiUrl: 'https://erp.example.com', stationId: 'MANIKONDA-PHOTO-01', cameraProvider: 'mock' as const, port: 0, heartbeatIntervalMs: 60_000, cameraOptions: {}, production: false, logLevel: 'info' as const, warnings: [] as string[] };

let bridges: Bridge[] = [];
afterEach(async () => { await Promise.all(bridges.map((b) => b.stop())); bridges = []; });

async function boot(opts: { provider?: MockCameraProvider; transport?: ErpTransport; credentials?: CredentialStore } = {}) {
  const lines: string[] = [];
  const bridge = new Bridge({
    config, provider: opts.provider ?? new MockCameraProvider(), credentials: opts.credentials ?? store,
    transport: opts.transport ?? new UnavailableTransport(), log: createLogger({ sink: (l) => lines.push(l) }),
  });
  bridges.push(bridge);
  const port = await bridge.start();
  return { bridge, port, lines };
}

function request(port: number, path: string, o: { method?: string; host?: string; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', (e) => reject(new Error(`${o.method ?? 'GET'} ${path} host=${o.host}: ${e.message}`)));
    req.end(o.body);
  });
}

describe('local API', () => {
  it('GET /health', async () => {
    const { port } = await boot();
    const r = await request(port, '/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true });
  });

  it('GET /status keeps bridge, station, camera and heartbeat separate', async () => {
    const { port } = await boot();
    const s = JSON.parse((await request(port, '/status')).text);
    expect(s.bridge).toMatchObject({ status: 'RUNNING', version: BRIDGE_VERSION });
    expect(s.station).toEqual({ id: 'MANIKONDA-PHOTO-01', status: 'CONFIGURED', captureScope: 'DISABLED' });
    expect(s.camera.state).toBe('CONNECTED');
    expect(s.heartbeat.state).toBe('BACKEND_UNAVAILABLE'); // running + camera connected, yet NOT "online"
  });

  it('reports a disconnected camera while the bridge is still RUNNING', async () => {
    const p = new MockCameraProvider();
    p.injectConnectFailure();
    const { port } = await boot({ provider: p });
    const s = JSON.parse((await request(port, '/status')).text);
    expect(s.bridge.status).toBe('RUNNING');
    expect(s.camera.state).toBe('ERROR');
  });

  it('reports NOT_CONFIGURED without a credential', async () => {
    const { port } = await boot({ credentials: { ...store, load: async () => null } });
    const s = JSON.parse((await request(port, '/status')).text);
    expect(s.station.status).toBe('NOT_CONFIGURED');
  });

  it('GET /camera/status', async () => {
    const { port } = await boot();
    const r = JSON.parse((await request(port, '/camera/status')).text);
    expect(r).toEqual({ ok: true, camera: { state: 'CONNECTED', provider: 'mock' } });
  });

  it('rejects unknown routes, methods, odd paths and foreign Host headers', async () => {
    const { port } = await boot();
    expect((await request(port, '/nope')).status).toBe(404);
    for (const p of ['/execute', '/file', '/fetch', '/camera/capture', '/status/../../etc/passwd', '/%2e%2e/secret']) {
      expect((await request(port, p)).status).toBe(404);
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await request(port, '/status', { method: m, body: '{"cmd":"calc"}' });
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe('GET');
    }
    expect((await request(port, '/health', { host: 'evil.example.com' })).status).toBe(403); // DNS-rebinding guard
    expect((await request(port, '/health', { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
  });

  it('sends no CORS headers and no-store caching', async () => {
    const { port } = await boot();
    const r = await request(port, '/status');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('binds to loopback only', async () => {
    const { port } = await boot();
    const { execFileSync } = await import('child_process');
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => l.includes('LISTENING') && l.includes(`:${port} `));
    expect(line).toBeDefined();
    const local = line!.trim().split(/\s+/)[1]; // Local Address column
    expect(local).toBe(`127.0.0.1:${port}`);
  });
});

describe('security', () => {
  it('never exposes the credential, environment, paths or stack traces in any response', async () => {
    const { port, lines } = await boot();
    const bodies: string[] = [];
    for (const p of ['/health', '/status', '/camera/status', '/nope']) bodies.push((await request(port, p)).text);
    const all = bodies.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/[A-Za-z]:\\|\/Users\/|node_modules|\bat .*\(/);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('redacts secret-like keys and binary payloads in logs', () => {
    const out = JSON.stringify(redact({ stationSecret: 'x', accessToken: 'x', ticket: 'x', signedUrl: 'x', storageKey: 'k', imageData: Buffer.from('abc'), nested: { password: 'p', ok: 1 } }));
    expect(out).not.toMatch(/"x"|"k"|"p"|abc/);
    expect(out).toContain('"ok":1');
    expect(JSON.stringify(redact(new Error('boom')))).not.toContain('stack');
  });

  it('exposes no capture/file/exec surface in the local API source', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(require.resolve('../src/localApi.ts'), 'utf8');
    expect(src).not.toMatch(/child_process|\bexec\(|spawn|readFile|writeFile|\bfetch\(|https?\.request/);
  });
});

describe('config', () => {
  const ok = { TRIVO_API_URL: 'https://erp.example.com/', STATION_ID: 'MANIKONDA-PHOTO-01' };
  it('accepts the minimum config and ignores company/branch/user entries', () => {
    const c = loadConfig({ ...ok, COMPANY_ID: 'c', BRANCH_ID: 'b', ERP_USER: 'u' } as never);
    expect(c).toMatchObject({ apiUrl: 'https://erp.example.com', stationId: 'MANIKONDA-PHOTO-01', cameraProvider: 'mock', port: 9102 });
    expect(Object.keys(c).some((k) => /company|branch|user/i.test(k))).toBe(false);
  });
  it('rejects bad input', () => {
    for (const env of [{}, { ...ok, TRIVO_API_URL: 'http://erp.example.com' }, { ...ok, STATION_ID: '' }, { ...ok, STATION_ID: '../x' },
      { ...ok, CAMERA_PROVIDER: 'canon' }, { ...ok, BRIDGE_PORT: '99999' }]) {
      expect(() => loadConfig(env as never)).toThrow(ConfigError);
    }
  });
  it('allows plain http only for localhost', () => {
    expect(loadConfig({ ...ok, TRIVO_API_URL: 'http://localhost:5000' } as never).apiUrl).toBe('http://localhost:5000');
  });
});

describe('credential store', () => {
  it('dev-env store is refused in production and is read-only', async () => {
    await expect(new DevEnvCredentialStore({ NODE_ENV: 'production', TRIVO_STATION_SECRET_DEV: 'x' } as never).load()).rejects.toThrow();
    await expect(new DevEnvCredentialStore({} as never).save()).rejects.toThrow();
    expect(await new DevEnvCredentialStore({ TRIVO_STATION_SECRET_DEV: ' s ' } as never).load()).toBe('s');
  });
});

describe('lifecycle', () => {
  it('start -> stop disconnects the camera, stops heartbeat and frees the port', async () => {
    const provider = new MockCameraProvider();
    const { bridge, port, lines } = await boot({ provider });
    expect((await provider.getStatus()).state).toBe('CONNECTED');
    await bridge.stop();
    expect((await provider.getStatus()).state).toBe('DISCONNECTED');
    await expect(request(port, '/health')).rejects.toThrow();
    const joined = lines.join('\n');
    for (const e of ['bridge.starting', 'bridge.started', 'bridge.stopping', 'bridge.stopped']) expect(joined).toContain(e);
    expect(joined).toContain('MANIKONDA-PHOTO-01');
    expect(joined).toContain(BRIDGE_VERSION);
  });

  it('starts even if the camera fails to connect', async () => {
    const p = new MockCameraProvider();
    p.injectConnectFailure();
    const { port } = await boot({ provider: p });
    expect((await request(port, '/health')).status).toBe(200);
  });
});
