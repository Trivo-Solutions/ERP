import http from 'http';
import { AddressInfo } from 'net';
import { Logger } from './logger';

import { CameraListing } from './camera/discovery';
import { CameraError } from './camera/types';

export interface CameraSelector {
  list(): Promise<CameraListing>;
  /** `null` returns to automatic selection. */
  select(id: string | null): Promise<CameraListing>;
}

export interface StatusProvider {
  getBridgeStatus(): Promise<unknown>;
  getCameraStatus(): Promise<unknown>;
  /** Present only when the configured provider discovers cameras (webcam / auto). */
  cameras?: CameraSelector;
}

// Read-only, loopback-only status API. There is deliberately no route that takes a path, URL, command or file, no
// CORS headers (a browser page on another origin cannot read these responses), and a Host-header allow-list that
// blocks DNS-rebinding. A capture endpoint is NOT exposed in Phase 5A — see README.
//
// Phase 5G adds ONE mutating route, POST /cameras/select, which chooses among cameras the bridge itself discovered. It takes only
// a camera id (a bounded `{"id": "<kind>:<id>" | null}` document), never a path, command or file. Because a hostile web page can
// POST to loopback without any CORS permission when the request is "simple", it additionally requires Content-Type:
// application/json (which forces a preflight this API never grants) and rejects any request carrying an Origin header.
const BIND_HOST = '127.0.0.1';

export class LocalApi {
  private server: http.Server | null = null;

  constructor(private readonly status: StatusProvider, private readonly log: Logger) {}

  /** Starts listening on loopback. Pass port 0 for an ephemeral port (tests). Resolves with the bound port. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res, () => (server.address() as AddressInfo).port));
      server.once('error', reject);
      server.listen(port, BIND_HOST, () => {
        this.server = server;
        const bound = (server.address() as AddressInfo).port;
        this.log.info('localapi.listening', { host: BIND_HOST, port: bound });
        resolve(bound);
      });
    });
  }

  close(): Promise<void> {
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  private send(res: http.ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close', ...extra });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: () => number): Promise<void> {
    try {
      const isSelect = (req.url ?? '').split('?')[0] === '/cameras/select' && !!this.status.cameras;
      if (!isSelect) req.resume(); // every other route ignores the body; drain it so the client sees our response, not a reset
      const host = (req.headers.host ?? '').toLowerCase();
      const p = port();
      if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return this.send(res, 403, { ok: false, error: 'Forbidden host' });
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/cameras/select' && this.status.cameras) {
        if (req.method !== 'POST') return this.send(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });
        return await this.selectCamera(req, res);
      }
      if (req.method !== 'GET') return this.send(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' });

      switch (pathname) {
        case '/health':
          return this.send(res, 200, { ok: true });
        case '/status':
          return this.send(res, 200, { ok: true, ...(await this.status.getBridgeStatus() as object) });
        case '/camera/status':
          return this.send(res, 200, { ok: true, camera: await this.status.getCameraStatus() });
        case '/cameras':
          if (!this.status.cameras) return this.send(res, 404, { ok: false, error: 'Not found' });
          return this.send(res, 200, { ok: true, ...(await this.status.cameras.list()) });
        default:
          return this.send(res, 404, { ok: false, error: 'Not found' });
      }
    } catch {
      // Never leak internals or stack traces.
      this.log.error('localapi.error');
      if (!res.headersSent) this.send(res, 500, { ok: false, error: 'Internal error' });
    }
  }

  private async selectCamera(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const drain = () => req.resume();
    if (req.headers.origin !== undefined) { drain(); return this.send(res, 403, { ok: false, error: 'Forbidden' }); }
    if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) { drain(); return this.send(res, 415, { ok: false, error: 'Content-Type must be application/json' }); }
    const body = await new Promise<string | null>((resolve) => {
      let size = 0; let text = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { size += c.length; if (size > 1024) resolve(null); else text += c; });
      req.on('end', () => resolve(text));
      req.on('error', () => resolve(null));
    });
    if (body === null) {
      res.once('finish', () => req.destroy()); // stop reading the oversize upload once the refusal has been sent
      return this.send(res, 413, { ok: false, error: 'Request too large' });
    }
    let id: unknown;
    try {
      const doc = JSON.parse(body) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some((k) => k !== 'id') || !('id' in doc)) throw new Error('shape');
      id = doc.id;
    } catch { return this.send(res, 400, { ok: false, error: 'Body must be {"id": "<camera id>" | null}' }); }
    if (id !== null && typeof id !== 'string') return this.send(res, 400, { ok: false, error: 'Body must be {"id": "<camera id>" | null}' });
    try {
      return this.send(res, 200, { ok: true, ...(await this.status.cameras!.select(id)) });
    } catch (e) {
      const code = e instanceof CameraError ? e.code : null;
      if (code === 'INVALID_REQUEST') return this.send(res, 400, { ok: false, error: 'Unknown camera' });
      if (code === 'BUSY') return this.send(res, 409, { ok: false, error: 'Camera is busy; try again when the current capture has finished' });
      if (code === 'CONNECT_FAILED') return this.send(res, 409, { ok: false, error: 'Camera is not available' });
      throw e; // generic 500 handler: no internals leak
    }
  }
}
