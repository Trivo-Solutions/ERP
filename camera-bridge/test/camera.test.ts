import { describe, expect, it } from 'vitest';
import { CameraController } from '../src/camera/CameraController';
import { MockCameraProvider } from '../src/camera/MockCameraProvider';
import { CameraError } from '../src/camera/types';
import { createLogger } from '../src/logger';

const quiet = () => createLogger({ sink: () => {} });

describe('MockCameraProvider', () => {
  it('starts DISCONNECTED, connects, disconnects', async () => {
    const cam = new MockCameraProvider();
    expect((await cam.getStatus()).state).toBe('DISCONNECTED');
    await cam.connect();
    expect((await cam.getStatus()).state).toBe('CONNECTED');
    await cam.disconnect();
    expect((await cam.getStatus()).state).toBe('DISCONNECTED');
  });

  it('passes through CONNECTING and CAPTURING', async () => {
    const cam = new MockCameraProvider({ connectDelayMs: 30, captureDelayMs: 30 });
    const c = cam.connect();
    expect((await cam.getStatus()).state).toBe('CONNECTING');
    await c;
    const shot = cam.capture({ correlationId: 'a' });
    expect((await cam.getStatus()).state).toBe('CAPTURING');
    await shot;
    expect((await cam.getStatus()).state).toBe('CONNECTED');
  });

  it('captures a valid, deterministic local PNG', async () => {
    const cam = new MockCameraProvider({ width: 16, height: 8, now: () => new Date(1_700_000_000_000) });
    await cam.connect();
    const a = await cam.capture({ correlationId: 'corr-1' });
    const b = await cam.capture({ correlationId: 'corr-1' });
    const c = await cam.capture({ correlationId: 'corr-2' });
    expect(a.mimeType).toBe('image/png');
    expect(a.data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(a.data.readUInt32BE(16)).toBe(16); // IHDR width
    expect(a.data.readUInt32BE(20)).toBe(8);  // IHDR height
    expect([a.width, a.height]).toEqual([16, 8]);
    expect(a.data.equals(b.data)).toBe(true);
    expect(a.data.equals(c.data)).toBe(false);
    expect(a.filename).toMatch(/^mock-\d+-[0-9a-f]{8}\.png$/); // generated, no caller input
  });

  it('refuses to capture when not connected', async () => {
    const cam = new MockCameraProvider();
    await expect(cam.capture({ correlationId: 'x' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('enters ERROR on capture failure and recovers via connect()', async () => {
    const cam = new MockCameraProvider();
    await cam.connect();
    cam.injectCaptureFailure();
    await expect(cam.capture({ correlationId: 'x' })).rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
    expect(await cam.getStatus()).toMatchObject({ state: 'ERROR', errorCode: 'CAPTURE_FAILED' });
    await cam.connect();
    expect((await cam.getStatus()).state).toBe('CONNECTED');
  });

  it('enters ERROR on connect failure', async () => {
    const cam = new MockCameraProvider();
    cam.injectConnectFailure();
    await expect(cam.connect()).rejects.toBeInstanceOf(CameraError);
    expect((await cam.getStatus()).state).toBe('ERROR');
  });
});

describe('CameraController', () => {
  it('validates the capture request', async () => {
    const ctl = new CameraController(new MockCameraProvider(), quiet());
    await ctl.connect();
    for (const bad of [undefined, {}, { correlationId: '' }, { correlationId: '../../etc/passwd' }, { correlationId: 'a'.repeat(65) },
      { correlationId: 'ok', tagNumber: 5 }, { correlationId: 'ok', imageType: 'x'.repeat(65) }]) {
      await expect(ctl.capture(bad as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('rejects a second concurrent capture as BUSY', async () => {
    const ctl = new CameraController(new MockCameraProvider({ captureDelayMs: 40 }), quiet());
    await ctl.connect();
    const first = ctl.capture({ correlationId: 'one' });
    await expect(ctl.capture({ correlationId: 'two' })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(first).resolves.toBeDefined();
    await expect(ctl.capture({ correlationId: 'three' })).resolves.toBeDefined(); // lock released
  });

  it('connect() reports ERROR instead of throwing', async () => {
    const p = new MockCameraProvider();
    p.injectConnectFailure();
    expect((await new CameraController(p, quiet()).connect()).state).toBe('ERROR');
  });

  it('never logs image bytes', async () => {
    const lines: string[] = [];
    const ctl = new CameraController(new MockCameraProvider(), createLogger({ sink: (l) => lines.push(l) }));
    await ctl.connect();
    const img = await ctl.capture({ correlationId: 'log-check' });
    const all = lines.join('\n');
    expect(all).toContain('capture.start');
    expect(all).toContain('capture.end');
    expect(all).not.toContain(img.data.toString('base64').slice(0, 24));
  });
});
