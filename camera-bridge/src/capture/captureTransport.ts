import http from 'http';
import https from 'https';
import { randomBytes } from 'crypto';

// The bridge -> TRIVO channel for remote capture (poll a command, report progress, upload the image). Like the
// heartbeat transport: the station credential goes ONLY in the Authorization header; TLS verification is Node's
// default; redirects are never followed; response bodies are parsed for a small allow-list of fields and never logged.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const API = '/api/v1/photography';
const MAX_RESPONSE_BYTES = 64 * 1024;

export type StatusReport = { status: 'ACCEPTED' | 'CAPTURING' } | { status: 'FAILED'; code: string; detail?: string };

/** `cameraSelection`: a camera id an ERP user asked for; the bridge validates it itself before acting. */
export type PollOutcome = { ok: true; command: unknown | null; cameraSelection?: string } | { ok: false; kind: 'AUTH' | 'REJECTED' | 'NETWORK' | 'SERVER' };
export type ReportOutcome = { ok: true } | { ok: false; kind: 'AUTH' | 'EXPIRED' | 'STATE' | 'REJECTED' | 'NETWORK' | 'SERVER' };
export type UploadFailure = { ok: false; kind: 'AUTH' | 'EXPIRED' | 'REJECTED' | 'NETWORK' | 'SERVER'; retryable: boolean; timedOut?: boolean };
export type UploadOutcome = { ok: true; imageId: string; replay: boolean } | UploadFailure;

export interface UploadRequest {
  ticket: string; imageType: string; idempotencyKey: string; correlationId: string;
  data: Buffer; mimeType: string; capturedAt: string; cameraLabel: string; timeoutMs: number;
}

export interface CaptureTransport {
  pollCommand(secret: string, waitSeconds: number, signal?: AbortSignal): Promise<PollOutcome>;
  reportStatus(secret: string, commandId: string, report: StatusReport): Promise<ReportOutcome>;
  uploadImage(secret: string, req: UploadRequest): Promise<UploadOutcome>;
}

interface Raw { status: number; json: Record<string, any> | null }
type RawResult = { ok: true; res: Raw } | { ok: false; timedOut: boolean };

/** Maps a NON-2xx upload response to the bridge's model. Pure, so it is unit-tested directly. */
export function classifyUploadFailure(status: number, code: string | undefined): UploadFailure {
  if (code === 'TICKET_EXPIRED' || code === 'COMMAND_EXPIRED') return { ok: false, kind: 'EXPIRED', retryable: false };
  if (status === 401 || status === 403) return { ok: false, kind: 'AUTH', retryable: false };
  if (status === 408 || status === 429 || status >= 500) return { ok: false, kind: 'SERVER', retryable: true };
  return { ok: false, kind: 'REJECTED', retryable: false }; // 400/404/409/413/415...: the same bytes will be refused again
}

export class HttpCaptureTransport implements CaptureTransport {
  private readonly base: URL;
  private readonly defaultTimeout: number;

  constructor(opts: { apiUrl: string; timeoutMs?: number }) {
    const base = new URL(opts.apiUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOCAL_HOSTS.has(base.hostname))) {
      throw new Error('ERP transport requires https (http is allowed only for localhost development)');
    }
    if (base.username || base.password || base.search || base.hash) throw new Error('ERP transport URL must not carry credentials or a query string');
    this.base = base;
    this.defaultTimeout = opts.timeoutMs ?? 10_000;
  }

  private url(p: string): URL { return new URL(this.base.pathname.replace(/\/+$/, '') + API + p, this.base); }

  private request(method: 'GET' | 'POST', url: URL, secret: string, headers: Record<string, string | number>, body: Buffer | null, timeoutMs: number, signal?: AbortSignal): Promise<RawResult> {
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise<RawResult>((resolve) => {
      let settled = false; let timedOut = false;
      const done = (r: RawResult) => { if (!settled) { settled = true; resolve(r); } };
      const req = lib.request(url, {
        method, timeout: timeoutMs,
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...headers, ...(body ? { 'Content-Length': body.length } : {}) },
      }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_RESPONSE_BYTES) chunks.push(c); });
        res.on('end', () => {
          let json: Record<string, any> | null = null;
          try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); json = j && typeof j === 'object' ? j : null; } catch { /* not JSON */ }
          done({ ok: true, res: { status: res.statusCode ?? 0, json } });
        });
        res.on('error', () => done({ ok: false, timedOut }));
      });
      req.on('timeout', () => { timedOut = true; req.destroy(); done({ ok: false, timedOut: true }); });
      req.on('error', () => done({ ok: false, timedOut })); // the Error (TLS/DNS detail) never leaves this method
      if (signal?.aborted) { req.destroy(); return done({ ok: false, timedOut: false }); }
      signal?.addEventListener('abort', () => { req.destroy(); done({ ok: false, timedOut: false }); }, { once: true });
      req.end(body ?? undefined);
    });
  }

  async pollCommand(secret: string, waitSeconds: number, signal?: AbortSignal): Promise<PollOutcome> {
    const wait = Math.max(0, Math.floor(waitSeconds));
    const r = await this.request('GET', this.url(`/stations/commands/next?waitSeconds=${wait}`), secret, {}, null, (wait + 10) * 1000, signal);
    if (!r.ok) return { ok: false, kind: 'NETWORK' };
    const s = r.res.status;
    if (s >= 200 && s < 300) {
      const sel = r.res.json?.data?.cameraSelection?.cameraId;
      return { ok: true, command: r.res.json?.data?.command ?? null, ...(typeof sel === 'string' ? { cameraSelection: sel } : {}) };
    }
    if (s === 401 || s === 403) return { ok: false, kind: 'AUTH' };
    if (s === 408 || s === 429 || s >= 500) return { ok: false, kind: 'SERVER' };
    return { ok: false, kind: 'REJECTED' };
  }

  async reportStatus(secret: string, commandId: string, report: StatusReport): Promise<ReportOutcome> {
    const body = Buffer.from(JSON.stringify(report));
    const r = await this.request('POST', this.url(`/stations/commands/${encodeURIComponent(commandId)}/status`), secret,
      { 'Content-Type': 'application/json' }, body, this.defaultTimeout);
    if (!r.ok) return { ok: false, kind: 'NETWORK' };
    const s = r.res.status; const code = r.res.json?.code;
    if (s >= 200 && s < 300) return { ok: true };
    if (code === 'COMMAND_EXPIRED') return { ok: false, kind: 'EXPIRED' };
    if (code === 'COMMAND_STATE') return { ok: false, kind: 'STATE' };
    if (s === 401 || s === 403) return { ok: false, kind: 'AUTH' };
    if (s === 408 || s === 429 || s >= 500) return { ok: false, kind: 'SERVER' };
    return { ok: false, kind: 'REJECTED' };
  }

  async uploadImage(secret: string, q: UploadRequest): Promise<UploadOutcome> {
    // Same conceptual multipart as the browser: ticket, imageType, idempotencyKey, file (+ capturedAt / cameraLabel,
    // informational). No company, branch, user, station, bucket or storage key — the ticket is the authority.
    const boundary = `----trivo${randomBytes(12).toString('hex')}`;
    const ext = q.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const field = (n: string, v: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
    const body = Buffer.concat([
      field('ticket', q.ticket), field('imageType', q.imageType), field('idempotencyKey', q.idempotencyKey),
      field('capturedAt', q.capturedAt), field('cameraLabel', q.cameraLabel),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="capture.${ext}"\r\nContent-Type: ${q.mimeType}\r\n\r\n`),
      q.data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await this.request('POST', this.url('/images'), secret,
      { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Correlation-Id': q.correlationId }, body, q.timeoutMs);
    if (!r.ok) return { ok: false, kind: 'NETWORK', retryable: true, timedOut: r.timedOut };
    const s = r.res.status;
    if (s >= 200 && s < 300) {
      const id = r.res.json?.data?.image?.id;
      if (typeof id !== 'string' || !id) return { ok: false, kind: 'SERVER', retryable: true }; // 2xx without an image: never claim success
      return { ok: true, imageId: id, replay: s === 200 };
    }
    return classifyUploadFailure(s, typeof r.res.json?.code === 'string' ? r.res.json.code : undefined);
  }
}
