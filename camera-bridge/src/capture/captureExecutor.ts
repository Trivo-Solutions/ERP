import { createHash, randomUUID } from 'crypto';
import { CameraController } from '../camera/CameraController';
import { CameraError } from '../camera/types';
import { CredentialStore } from '../credentials';
import { Logger } from '../logger';
import { CaptureTransport, ReportOutcome, StatusReport } from './captureTransport';
import { TempHandle, TempStore } from './tempStore';
import { CaptureCommand, CaptureResult, CaptureResultCode, CommandRejected, FailureCode, parseCommand, peekTicket } from './types';

export interface CaptureExecutorOptions {
  stationId: string;
  /** Camera shutter-to-bytes budget. A slow camera is a CAMERA_ERROR (CAPTURE_TIMEOUT), never a network error. */
  captureTimeoutMs: number;
  /** Per-attempt budget for the image upload. */
  uploadTimeoutMs: number;
  uploadMaxAttempts: number;
  uploadBackoffMs: number;
  /** Informational camera label sent with the upload. */
  cameraLabel: string;
  now?: () => number;
}

export type CommandPhase = 'VALIDATING' | 'ACKNOWLEDGING' | 'CAPTURING' | 'UPLOADING';

interface Op { fingerprint: string; promise: Promise<CaptureResult>; finishedAt: number | null }
const OP_MEMORY_MS = 10 * 60 * 1000;
const OP_MEMORY_MAX = 200;

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Carries out ONE capture command at a time against the camera and the ERP. It decides nothing about tags, users, photo
 * types or branches — the ERP issued the command and re-validates everything at upload. What it does own:
 *   - command idempotency: the same commandId is the same operation (never a second shutter release);
 *   - never touching the camera unless the ERP has acknowledged the command (so the upload can later be authorized);
 *   - a bounded camera budget, a bounded upload budget, bounded retries that reuse ONE idempotency key;
 *   - a controlled temp area (see tempStore.ts) so an upload that cannot finish is not silently lost.
 */
export class CaptureExecutor {
  private readonly ops = new Map<string, Op>();
  private readonly now: () => number;
  private stopping = false;
  private active: { commandId: string; phase: CommandPhase } | null = null;

  constructor(
    private readonly o: CaptureExecutorOptions,
    private readonly camera: CameraController,
    private readonly credentials: CredentialStore,
    private readonly transport: CaptureTransport,
    private readonly temp: TempStore,
    private readonly log: Logger,
  ) { this.now = o.now ?? Date.now; }

  /** The command being worked on right now (ids and phase only), or null. */
  getCurrent(): { commandId: string; phase: CommandPhase } | null { return this.active && { ...this.active }; }

  /** Shutdown has begun: no NEW camera movement starts, and upload retries stop after the attempt in progress. */
  beginShutdown(): void { this.stopping = true; }

  /** Never throws. Resolves with the normalized result of the (possibly already running/finished) operation. */
  handle(raw: unknown): Promise<CaptureResult> {
    let cmd: CaptureCommand;
    try { cmd = parseCommand(raw); } catch (e) {
      const detail = e instanceof CommandRejected ? e.detail : 'MALFORMED';
      this.log.warn('command.rejected', { detail });
      return Promise.resolve({ commandId: this.safeId(raw), code: 'COMMAND_REJECTED', detail });
    }
    if (this.stopping) return Promise.resolve({ commandId: this.safeId(raw), code: 'COMMAND_REJECTED', detail: 'SHUTTING_DOWN' });
    this.prune();
    const fingerprint = createHash('sha256').update([cmd.commandId, cmd.correlationId, cmd.stationId, cmd.imageType, cmd.ticket].join('|')).digest('hex');
    const existing = this.ops.get(cmd.commandId);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        this.log.info('command.duplicate', { commandId: cmd.commandId, correlationId: cmd.correlationId });
        return existing.promise; // same command, same request: the same operation, not a second capture
      }
      this.log.warn('command.id_reused', { commandId: cmd.commandId });
      return Promise.resolve({ commandId: cmd.commandId, correlationId: cmd.correlationId, code: 'COMMAND_REJECTED', detail: 'COMMAND_ID_REUSED' });
    }
    const op: Op = { fingerprint, finishedAt: null, promise: undefined as never };
    this.active = { commandId: cmd.commandId, phase: 'VALIDATING' };
    op.promise = this.run(cmd).catch((): CaptureResult => ({ commandId: cmd.commandId, correlationId: cmd.correlationId, code: 'CAMERA_ERROR', detail: 'INTERNAL' }))
      .then((r) => { op.finishedAt = this.now(); if (this.active?.commandId === cmd.commandId) this.active = null; return r; });
    this.ops.set(cmd.commandId, op);
    return op.promise;
  }

  private safeId(raw: unknown): string {
    const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).commandId : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'unknown';
  }

  private prune() {
    const t = this.now();
    for (const [id, op] of this.ops) if (op.finishedAt !== null && t - op.finishedAt > OP_MEMORY_MS) this.ops.delete(id);
    // Hard cap on remembered operations (finished ones only; a running one is never dropped).
    for (const [id, op] of this.ops) { if (this.ops.size <= OP_MEMORY_MAX) break; if (op.finishedAt !== null) this.ops.delete(id); }
  }

  private async report(secret: string, cmd: CaptureCommand, r: StatusReport): Promise<ReportOutcome> {
    const out = await this.transport.reportStatus(secret, cmd.commandId, r);
    if (!out.ok && r.status !== 'FAILED') {
      // A lost acknowledgement is retried once: the camera must not move until the ERP knows about the command.
      if (out.kind === 'NETWORK' || out.kind === 'SERVER') return this.transport.reportStatus(secret, cmd.commandId, r);
    }
    return out;
  }

  private fail(cmd: CaptureCommand, code: FailureCode, detail?: string, extra: Partial<CaptureResult> = {}): CaptureResult {
    this.log.warn('capture.result', { commandId: cmd.commandId, correlationId: cmd.correlationId, code, detail });
    return { commandId: cmd.commandId, correlationId: cmd.correlationId, code, ...(detail ? { detail } : {}), ...extra };
  }

  /** Best-effort FAILED report (the server also expires the command on its own deadline). */
  private async reportFailed(secret: string, cmd: CaptureCommand, code: FailureCode, detail?: string) {
    try { await this.transport.reportStatus(secret, cmd.commandId, { status: 'FAILED', code, ...(detail ? { detail } : {}) }); }
    catch { /* nothing more to do */ }
  }

  private stageFailure(out: Exclude<ReportOutcome, { ok: true }>): [FailureCode, string] {
    switch (out.kind) {
      case 'AUTH': return ['AUTH_ERROR', 'STATION_AUTH'];
      case 'EXPIRED': return ['EXPIRED', 'COMMAND_EXPIRED'];
      case 'STATE': return ['COMMAND_REJECTED', 'COMMAND_STATE'];
      case 'REJECTED': return ['COMMAND_REJECTED', 'ERP_REJECTED'];
      default: return ['NETWORK_ERROR', 'ERP_UNREACHABLE'];
    }
  }

  private async run(cmd: CaptureCommand): Promise<CaptureResult> {
    const secret = await this.credentials.load().catch(() => null);
    if (!secret) return this.fail(cmd, 'AUTH_ERROR', 'NOT_CONFIGURED');

    // — 1. validate the command is for THIS station and still live (a client-supplied station id is never trusted alone;
    //      the ticket's own station claim is checked too, and the ERP re-checks everything at upload) —
    if (cmd.stationId !== this.o.stationId) { await this.reportFailed(secret, cmd, 'COMMAND_REJECTED', 'WRONG_STATION'); return this.fail(cmd, 'COMMAND_REJECTED', 'WRONG_STATION'); }
    const peek = peekTicket(cmd.ticket);
    if (peek.sid !== this.o.stationId) { await this.reportFailed(secret, cmd, 'COMMAND_REJECTED', 'TICKET_WRONG_STATION'); return this.fail(cmd, 'COMMAND_REJECTED', 'TICKET_WRONG_STATION'); }
    if (new Date(cmd.expiresAt).getTime() <= this.now() || (peek.exp !== undefined && peek.exp * 1000 <= this.now())) {
      await this.reportFailed(secret, cmd, 'EXPIRED', 'COMMAND_EXPIRED'); return this.fail(cmd, 'EXPIRED', 'COMMAND_EXPIRED');
    }
    if (this.camera.isBusy()) { await this.reportFailed(secret, cmd, 'BUSY'); return this.fail(cmd, 'BUSY'); }

    // — 2. the ERP must acknowledge before the camera moves —
    this.setPhase('ACKNOWLEDGING');
    for (const status of ['ACCEPTED', 'CAPTURING'] as const) {
      const out = await this.report(secret, cmd, { status });
      if (!out.ok) { const [code, detail] = this.stageFailure(out); return this.fail(cmd, code, detail); }
    }
    this.log.info('command.accepted', { commandId: cmd.commandId, correlationId: cmd.correlationId });
    // Shutdown began while we were acknowledging: do not release the shutter on a process that is going away.
    if (this.stopping) { await this.reportFailed(secret, cmd, 'COMMAND_REJECTED', 'SHUTTING_DOWN'); return this.fail(cmd, 'COMMAND_REJECTED', 'SHUTTING_DOWN'); }
    this.setPhase('CAPTURING');

    // — 3. capture, with its own budget —
    let image;
    try {
      image = await this.captureWithTimeout(cmd);
    } catch (e) {
      const timedOut = e instanceof Error && e.message === 'CAPTURE_TIMEOUT';
      if (e instanceof CameraError && e.code === 'BUSY') { await this.reportFailed(secret, cmd, 'BUSY'); return this.fail(cmd, 'BUSY'); }
      const detail = timedOut ? 'CAPTURE_TIMEOUT' : e instanceof CameraError ? e.code : 'CAPTURE_FAILED';
      await this.reportFailed(secret, cmd, 'CAMERA_ERROR', detail);
      return this.fail(cmd, 'CAMERA_ERROR', detail);
    }

    // — 4. controlled temp copy, then upload from it. One idempotency key per image, reused by every retry. —
    const idempotencyKey = `brg-${randomUUID()}`;
    let handle: TempHandle;
    try {
      handle = await this.temp.write(image.data, {
        commandId: cmd.commandId, correlationId: cmd.correlationId, idempotencyKey, imageType: cmd.imageType,
        capturedAt: image.capturedAt.toISOString(), mimeType: image.mimeType,
      });
    } catch {
      await this.reportFailed(secret, cmd, 'UPLOAD_ERROR', 'TEMP_WRITE_FAILED');
      return this.fail(cmd, 'UPLOAD_ERROR', 'TEMP_WRITE_FAILED');
    }
    this.setPhase('UPLOADING');
    return this.upload(secret, cmd, handle, idempotencyKey, image.capturedAt.toISOString());
  }

  private setPhase(phase: CommandPhase) { if (this.active) this.active.phase = phase; }

  private captureWithTimeout(cmd: CaptureCommand) {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('CAPTURE_TIMEOUT')), this.o.captureTimeoutMs); });
    // If the camera answers after the deadline its result is discarded; the controller stays BUSY until the provider
    // actually returns, so a second command cannot start a second capture on a camera that is still working.
    return Promise.race([this.camera.capture({ correlationId: cmd.correlationId, tagNumber: cmd.tagNumber, imageType: cmd.imageType, timeoutMs: this.o.captureTimeoutMs }), timeout])
      .finally(() => clearTimeout(timer));
  }

  private async upload(secret: string, cmd: CaptureCommand, handle: TempHandle, idempotencyKey: string, capturedAt: string): Promise<CaptureResult> {
    let last: { code: FailureCode; detail: string; retainable: boolean } = { code: 'UPLOAD_ERROR', detail: 'UNKNOWN', retainable: true };
    for (let attempt = 1; attempt <= this.o.uploadMaxAttempts; attempt++) {
      if (new Date(cmd.expiresAt).getTime() + 60_000 <= this.now()) { last = { code: 'EXPIRED', detail: 'COMMAND_EXPIRED', retainable: true }; break; }
      if (attempt > 1 && this.stopping) { last = { code: 'UPLOAD_ERROR', detail: 'SHUTTING_DOWN', retainable: true }; break; }
      let data: Buffer;
      try { data = await this.temp.read(handle); } catch { last = { code: 'UPLOAD_ERROR', detail: 'TEMP_READ_FAILED', retainable: false }; break; }
      this.log.info('upload.started', { commandId: cmd.commandId, correlationId: cmd.correlationId, attempt });
      const out = await this.transport.uploadImage(secret, {
        ticket: cmd.ticket, imageType: cmd.imageType, idempotencyKey, correlationId: cmd.correlationId, data,
        mimeType: handle.mimeType, capturedAt, cameraLabel: this.o.cameraLabel, timeoutMs: this.o.uploadTimeoutMs,
      });
      if (out.ok) {
        this.log.info('upload.completed', { commandId: cmd.commandId, correlationId: cmd.correlationId, attempt, replay: out.replay });
        await this.temp.remove(handle); // server-confirmed: the bridge keeps nothing
        this.log.info('capture.result', { commandId: cmd.commandId, correlationId: cmd.correlationId, code: 'SUCCESS', attempts: attempt, replay: out.replay });
        return { commandId: cmd.commandId, correlationId: cmd.correlationId, code: 'SUCCESS', imageId: out.imageId };
      }
      switch (out.kind) {
        case 'AUTH': last = { code: 'AUTH_ERROR', detail: 'UPLOAD_AUTH', retainable: true }; break;
        case 'EXPIRED': last = { code: 'EXPIRED', detail: 'TICKET_EXPIRED', retainable: true }; break;
        case 'REJECTED': last = { code: 'UPLOAD_ERROR', detail: 'ERP_REJECTED', retainable: false }; break;
        case 'NETWORK': last = { code: 'NETWORK_ERROR', detail: out.timedOut ? 'UPLOAD_TIMEOUT' : 'ERP_UNREACHABLE', retainable: true }; break;
        default: last = { code: 'UPLOAD_ERROR', detail: 'ERP_ERROR', retainable: true };
      }
      this.log.warn('upload.attempt_failed', { commandId: cmd.commandId, correlationId: cmd.correlationId, attempt, kind: out.kind, retryable: out.retryable });
      if (!out.retryable || attempt === this.o.uploadMaxAttempts) break;
      await sleep(this.o.uploadBackoffMs * 2 ** (attempt - 1)); // SAME idempotencyKey on the next attempt
    }
    // Unrecoverable (the ERP refused these bytes): nothing to retry, so nothing is kept. Recoverable (ERP/network/auth
    // /expiry): kept in the temp area only until the bounded retention window passes, then discarded by sweep().
    if (last.retainable) {
      await this.temp.annotate(handle, {
        commandId: cmd.commandId, correlationId: cmd.correlationId, idempotencyKey, imageType: cmd.imageType, capturedAt,
        mimeType: handle.mimeType, reason: last.detail, recoverable: true,
      }).catch(() => undefined);
    } else {
      await this.temp.remove(handle).catch(() => undefined);
    }
    await this.reportFailed(secret, cmd, last.code, last.detail);
    return this.fail(cmd, last.code, last.detail, { imageRetained: last.retainable });
  }
}

export type { CaptureResultCode };
