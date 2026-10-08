import { CredentialStore } from '../credentials';
import { backoffDelay } from '../heartbeat';
import { Logger } from '../logger';
import { CaptureExecutor } from './captureExecutor';
import { CaptureTransport } from './captureTransport';

export type CommandChannelState =
  | 'NOT_STARTED' | 'POLLING' | 'BUSY' | 'RETRYING'
  | 'NOT_CONFIGURED'   // no station credential stored
  | 'AUTH_FAILED'      // credential (or its capture scope) rejected; stopped until it is fixed and the bridge restarted
  | 'CONFIG_REJECTED'; // ERP refused the request as invalid; stopped

export interface CommandChannelStatus {
  state: CommandChannelState;
  lastPollAt: string | null;
  lastCommandAt: string | null;
  lastResult: { commandId: string; code: string } | null;
  consecutiveFailures: number;
}

export interface CommandPollerOptions {
  waitSeconds: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  /** Pause after an empty poll that returned instantly (a misbehaving proxy must not turn this into a busy loop). */
  emptyPollPauseMs?: number;
  /** A camera id an ERP user asked for (delivered with a poll answer). The handler validates it and never throws into the loop. */
  onCameraSelection?: (cameraId: string) => Promise<void>;
}

/**
 * ERP -> bridge command channel: authenticated HTTPS long-polling. The bridge always dials out; nothing listens on a
 * LAN address. Commands run strictly one at a time (a camera takes one picture at a time), so no command queue exists
 * on the bridge: while one runs, the next poll simply is not made.
 */
export class CommandPoller {
  private running = false;
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private status: CommandChannelStatus = { state: 'NOT_STARTED', lastPollAt: null, lastCommandAt: null, lastResult: null, consecutiveFailures: 0 };
  private readonly base: number;
  private readonly max: number;
  private readonly random: () => number;
  private readonly pause: number;

  constructor(
    private readonly opts: CommandPollerOptions,
    private readonly executor: CaptureExecutor,
    private readonly credentials: CredentialStore,
    private readonly transport: CaptureTransport,
    private readonly log: Logger,
  ) {
    this.base = opts.baseBackoffMs ?? 5_000;
    this.max = opts.maxBackoffMs ?? 120_000;
    this.random = opts.random ?? Math.random;
    this.pause = opts.emptyPollPauseMs ?? 1_000;
  }

  getStatus(): CommandChannelStatus {
    return { ...this.status, lastResult: this.status.lastResult && { ...this.status.lastResult } };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  private wake: (() => void) | null = null;
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
      this.timer.unref?.();
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const secret = await this.credentials.load();
        if (!secret) {
          this.status.state = 'NOT_CONFIGURED';
          await this.wait(30_000); // the operator may store a credential later
          continue;
        }
        this.abort = new AbortController();
        this.status.lastPollAt = new Date().toISOString();
        if (this.status.state !== 'RETRYING') this.status.state = 'POLLING';
        const startedAt = Date.now();
        const out = await this.transport.pollCommand(secret, this.opts.waitSeconds, this.abort.signal);
        if (!this.running) return;
        if (!out.ok) {
          if (out.kind === 'AUTH') {
            this.status.state = 'AUTH_FAILED';
            this.log.error('commands.auth_failed', { action: 'stopped; the credential needs the station:capture scope (re-issue it), then restart the bridge' });
            return;
          }
          if (out.kind === 'REJECTED') {
            this.status.state = 'CONFIG_REJECTED';
            this.log.error('commands.config_rejected', { action: 'stopped; check STATION_ID and TRIVO_API_URL, then restart the bridge' });
            return;
          }
          this.status.consecutiveFailures += 1;
          this.status.state = 'RETRYING';
          const delay = backoffDelay(this.status.consecutiveFailures, this.base, this.max, this.random);
          this.log.warn('commands.poll_failed', { kind: out.kind, failures: this.status.consecutiveFailures, retryInMs: delay });
          await this.wait(delay);
          continue;
        }
        this.status.consecutiveFailures = 0;
        this.status.state = 'POLLING';
        if (out.cameraSelection && this.opts.onCameraSelection) await this.opts.onCameraSelection(out.cameraSelection).catch(() => undefined);
        if (out.command === null || out.command === undefined) {
          if (Date.now() - startedAt < this.pause) await this.wait(this.pause);
          continue;
        }
        this.status.state = 'BUSY';
        this.status.lastCommandAt = new Date().toISOString();
        const result = await this.executor.handle(out.command);
        this.status.lastResult = { commandId: result.commandId, code: result.code };
        this.status.state = 'POLLING';
        // A command the ERP re-delivers (our acknowledgement was lost) maps to the same operation in the executor; this
        // short pause keeps that from becoming a tight loop.
        if (result.code !== 'SUCCESS') await this.wait(Math.min(this.pause, 1_000));
      } catch {
        // Credential-store or unexpected error: transient; the error body is never logged.
        this.status.consecutiveFailures += 1;
        this.status.state = 'RETRYING';
        await this.wait(backoffDelay(this.status.consecutiveFailures, this.base, this.max, this.random));
      }
    }
  }
}
