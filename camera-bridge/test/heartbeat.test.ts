import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { CredentialStore } from '../src/credentials';
import { ErpTransport, HeartbeatPayload, TransportResult, UnavailableTransport } from '../src/erpTransport';
import { backoffDelay, HeartbeatScheduler } from '../src/heartbeat';
import { createLogger } from '../src/logger';

const SECRET = 'station-secret-DO-NOT-LOG-123';
const store = (secret: string | null): CredentialStore => ({ kind: 'dev-env', load: async () => secret, save: async () => {} });

function setup(results: TransportResult[] | ErpTransport, secret: string | null = SECRET) {
  const lines: string[] = [];
  const sent: { payload: HeartbeatPayload; secret: string }[] = [];
  let i = 0;
  const transport: ErpTransport = Array.isArray(results)
    ? { sendHeartbeat: async (payload, s) => { sent.push({ payload, secret: s }); return results[Math.min(i++, results.length - 1)]; } }
    : results;
  const log = createLogger({ sink: (l) => lines.push(l) });
  const cam = new CameraController(new MockCameraProvider(), log);
  const hb = new HeartbeatScheduler(
    { stationId: 'STATION-1', bridgeVersion: '9.9.9', intervalMs: 1000, baseBackoffMs: 100, maxBackoffMs: 800, random: () => 0.5 },
    cam, store(secret), transport, log,
  );
  return { hb, sent, lines, cam };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('heartbeat', () => {
  it('sends station id, bridge version, camera state and timestamp; then repeats on the interval', async () => {
    const { hb, sent, cam } = setup([{ ok: true }]);
    await cam.connect();
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ stationId: 'STATION-1', bridgeVersion: '9.9.9', cameraState: 'CONNECTED' });
    expect(Number.isNaN(Date.parse(sent[0].payload.timestamp))).toBe(false);
    expect(Object.keys(sent[0].payload).sort()).toEqual(['bridgeVersion', 'cameraState', 'stationId', 'timestamp']); // no company/branch/user
    expect(hb.getStatus().state).toBe('OK');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
    hb.stop();
  });

  it('reports camera disconnected separately from the bridge running', async () => {
    const { hb, sent } = setup([{ ok: true }]);
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0].payload.cameraState).toBe('DISCONNECTED');
    hb.stop();
  });

  it('backs off exponentially on network failure, bounded, then recovers', async () => {
    const { hb, sent } = setup([{ ok: false, kind: 'NETWORK' }, { ok: false, kind: 'SERVER' }, { ok: false, kind: 'NETWORK' }, { ok: true }]);
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(hb.getStatus()).toMatchObject({ state: 'RETRYING', consecutiveFailures: 1 });
    await vi.advanceTimersByTimeAsync(99); expect(sent).toHaveLength(1);   // base 100ms
    await vi.advanceTimersByTimeAsync(1);  expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199); expect(sent).toHaveLength(2);  // 200ms
    await vi.advanceTimersByTimeAsync(1);  expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(399); expect(sent).toHaveLength(3);  // 400ms
    await vi.advanceTimersByTimeAsync(1);  expect(sent).toHaveLength(4);
    expect(hb.getStatus()).toMatchObject({ state: 'OK', consecutiveFailures: 0 });
    hb.stop();
  });

  it('backoffDelay is capped and jittered within +/-20%', () => {
    expect(backoffDelay(1, 100, 800, () => 0.5)).toBe(100);
    expect(backoffDelay(20, 100, 800, () => 0.5)).toBe(800);
    expect(backoffDelay(20, 100, 800, () => 0)).toBe(640);
    expect(backoffDelay(20, 100, 800, () => 1)).toBe(960);
  });

  it('stops permanently on an authentication failure (no retry loop)', async () => {
    const { hb, sent, lines } = setup([{ ok: false, kind: 'AUTH' }]);
    hb.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(hb.getStatus().state).toBe('AUTH_FAILED');
    expect(lines.join('\n')).toContain('heartbeat.auth_failed');
  });

  it('with the default transport sends nothing and reports BACKEND_UNAVAILABLE', async () => {
    const spy = vi.spyOn(UnavailableTransport.prototype, 'sendHeartbeat');
    const { hb } = setup(new UnavailableTransport());
    hb.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hb.getStatus().state).toBe('BACKEND_UNAVAILABLE');
  });

  it('is NOT_CONFIGURED and sends nothing without a stored credential', async () => {
    const { hb, sent } = setup([{ ok: true }], null);
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
    expect(hb.getStatus().state).toBe('NOT_CONFIGURED');
    hb.stop();
  });

  it('stop() cancels the pending timer', async () => {
    const { hb, sent } = setup([{ ok: true }]);
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    hb.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
  });

  it('never writes the secret to logs, including on failure', async () => {
    const { hb, lines } = setup([{ ok: false, kind: 'NETWORK' }, { ok: false, kind: 'AUTH' }]);
    hb.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
