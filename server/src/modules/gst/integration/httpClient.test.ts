import { describe, it, expect, afterEach, vi } from 'vitest';
import { gstIntegrationFetch, GstIntegrationHttpRequest } from './httpClient';
import { GstIntegrationError } from './errors';

const BASE: Omit<GstIntegrationHttpRequest, 'url' | 'method'> = {
  provider: 'OTHER', operation: 'HEALTH_CHECK', environment: 'SANDBOX', correlationId: 'test-correlation-id',
};

describe('G8a httpClient: gstIntegrationFetch', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
    globalThis.fetch = ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
  }

  it('returns status/headers/body on a 2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('sends the correlation id as a header', async () => {
    let seenHeaders: Record<string, string> = {};
    stubFetch((_url, init) => {
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('{}', { status: 200 });
    });
    await gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET', correlationId: 'corr-123' });
    expect(seenHeaders['x-correlation-id']).toBe('corr-123');
  });

  it('never logs/sends an Authorization header unless the caller explicitly supplied one, and never fabricates one', async () => {
    let seenHeaders: Record<string, string> = {};
    stubFetch((_url, init) => {
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('{}', { status: 200 });
    });
    await gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET' });
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it('normalizes a non-2xx response into a categorized GstIntegrationError', async () => {
    stubFetch(() => new Response('server exploded', { status: 500 }));
    await expect(gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET', maxRetries: 0 }))
      .rejects.toMatchObject({ category: 'PROVIDER', correlationId: 'test-correlation-id' });
  });

  it('maps 401/403/429 to AUTHENTICATION/AUTHORIZATION/RATE_LIMIT respectively', async () => {
    for (const [status, category] of [[401, 'AUTHENTICATION'], [403, 'AUTHORIZATION'], [429, 'RATE_LIMIT']] as const) {
      stubFetch(() => new Response('x', { status }));
      await expect(gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/x', method: 'GET', maxRetries: 0 }))
        .rejects.toMatchObject({ category });
    }
  });

  it('normalizes a network-level fetch rejection to NETWORK', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    await expect(gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET', maxRetries: 0 }))
      .rejects.toMatchObject({ category: 'NETWORK' });
  });

  it('normalizes an aborted (timed-out) request to TIMEOUT', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
    await expect(gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/health', method: 'GET', timeoutMs: 20 }))
      .rejects.toMatchObject({ category: 'TIMEOUT' });
  });

  it('rejects a malformed URL before ever calling fetch', async () => {
    let called = false;
    stubFetch(() => { called = true; return new Response('{}', { status: 200 }); });
    await expect(gstIntegrationFetch({ ...BASE, url: 'not a url', method: 'GET' })).rejects.toMatchObject({ category: 'VALIDATION' });
    expect(called).toBe(false);
  });

  it('requires HTTPS for environment=PRODUCTION and never calls fetch for an http:// url', async () => {
    let called = false;
    stubFetch(() => { called = true; return new Response('{}', { status: 200 }); });
    await expect(gstIntegrationFetch({ ...BASE, environment: 'PRODUCTION', url: 'http://example.invalid/health', method: 'GET' }))
      .rejects.toMatchObject({ category: 'VALIDATION' });
    expect(called).toBe(false);
  });

  it('allows http:// for SANDBOX (no HTTPS requirement in non-production)', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    await expect(gstIntegrationFetch({ ...BASE, environment: 'SANDBOX', url: 'http://example.invalid/health', method: 'GET' })).resolves.toBeDefined();
  });

  it('rejects a response exceeding the configured byte limit, never buffering it unboundedly', async () => {
    stubFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20).fill(65));
        controller.close();
      },
    }), { status: 200 }));
    await expect(gstIntegrationFetch({ ...BASE, url: 'http://example.invalid/big', method: 'GET', maxResponseBytes: 5 }))
      .rejects.toMatchObject({ category: 'VALIDATION', message: expect.stringContaining('exceeded') });
  });

  it('retries an idempotent-safe operation (HEALTH_CHECK) on a transient 500, and succeeds on the second attempt', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1 ? new Response('transient', { status: 500 }) : new Response('{"ok":true}', { status: 200 });
    });
    const res = await gstIntegrationFetch({ ...BASE, operation: 'HEALTH_CHECK', url: 'http://example.invalid/health', method: 'GET', maxRetries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('NEVER retries a mutation-shaped operation (GENERATE_IRN), even on a 500 — brief §12', async () => {
    let calls = 0;
    stubFetch(() => { calls += 1; return new Response('transient', { status: 500 }); });
    await expect(gstIntegrationFetch({ ...BASE, operation: 'GENERATE_IRN', url: 'http://example.invalid/irn', method: 'POST', maxRetries: 5 }))
      .rejects.toBeInstanceOf(GstIntegrationError);
    expect(calls).toBe(1);
  });
});
