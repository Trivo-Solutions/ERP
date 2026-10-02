import { describe, it, expect, afterEach, vi } from 'vitest';
import { getOrAuthenticate, invalidateSession, __resetAllSessionsForTests } from './tokenSession';
import { createMockProvider } from '../providers/mockProvider';
import { GstIntegrationCallContext } from '../types';

function ctxFor(configId: string): GstIntegrationCallContext {
  return { companyId: 'c1', gstRegistrationId: 'r1', configId, environment: 'SANDBOX', correlationId: 'corr', credentials: {} };
}

describe('G8a auth/tokenSession: caching, expiry, and single-flight concurrency protection', () => {
  afterEach(() => __resetAllSessionsForTests());

  it('authenticates once and serves the cached session on subsequent calls', async () => {
    const provider = createMockProvider({ tokenTtlMs: 60_000 });
    await getOrAuthenticate('cfgA', provider, ctxFor('cfgA'));
    await getOrAuthenticate('cfgA', provider, ctxFor('cfgA'));
    const third = await getOrAuthenticate('cfgA', provider, ctxFor('cfgA'));
    expect(provider.authenticateCallCount).toBe(1);
    expect(third.status).toBe('AUTHENTICATED');
  });

  it('re-authenticates once the cached session has expired', async () => {
    vi.useFakeTimers();
    try {
      const provider = createMockProvider({ tokenTtlMs: 1_000 });
      await getOrAuthenticate('cfgB', provider, ctxFor('cfgB'));
      expect(provider.authenticateCallCount).toBe(1);
      vi.advanceTimersByTime(2_000); // past expiry + skew
      await getOrAuthenticate('cfgB', provider, ctxFor('cfgB'));
      expect(provider.authenticateCallCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent callers for the same config share ONE in-flight authentication (single-flight)', async () => {
    const provider = createMockProvider({ authenticateDelayMs: 30, tokenTtlMs: 60_000 });
    const [a, b, c] = await Promise.all([
      getOrAuthenticate('cfgC', provider, ctxFor('cfgC')),
      getOrAuthenticate('cfgC', provider, ctxFor('cfgC')),
      getOrAuthenticate('cfgC', provider, ctxFor('cfgC')),
    ]);
    expect(provider.authenticateCallCount).toBe(1);
    expect([a.token, b.token, c.token]).toEqual([a.token, a.token, a.token]);
  });

  it('different configs authenticate independently (no cross-config cache bleed)', async () => {
    const provider = createMockProvider({ tokenTtlMs: 60_000 });
    await getOrAuthenticate('cfgD1', provider, ctxFor('cfgD1'));
    await getOrAuthenticate('cfgD2', provider, ctxFor('cfgD2'));
    expect(provider.authenticateCallCount).toBe(2);
  });

  it('a failed authentication is never cached — the next call re-attempts', async () => {
    const provider = createMockProvider({ failAuthentication: true });
    const first = await getOrAuthenticate('cfgE', provider, ctxFor('cfgE'));
    expect(first.status).toBe('AUTH_FAILED');
    const second = await getOrAuthenticate('cfgE', provider, ctxFor('cfgE'));
    expect(second.status).toBe('AUTH_FAILED');
    expect(provider.authenticateCallCount).toBe(2);
  });

  it('a result with no expiresAt is treated as single-use, never cached', async () => {
    // tokenTtlMs: undefined still sets an expiresAt in the mock provider's default — simulate the
    // "no expiry supplied" case directly against the cache contract instead.
    const provider = createMockProvider({ tokenTtlMs: 60_000 });
    const spy = vi.spyOn(provider, 'authenticate').mockResolvedValueOnce({ status: 'AUTHENTICATED', token: 'no-expiry-token' });
    await getOrAuthenticate('cfgF', provider, ctxFor('cfgF'));
    await getOrAuthenticate('cfgF', provider, ctxFor('cfgF'));
    expect(spy).toHaveBeenCalledTimes(2); // never cached, so the second call re-authenticates
  });

  it('invalidateSession forces the next call to re-authenticate even before expiry', async () => {
    const provider = createMockProvider({ tokenTtlMs: 60_000 });
    await getOrAuthenticate('cfgG', provider, ctxFor('cfgG'));
    invalidateSession('cfgG');
    await getOrAuthenticate('cfgG', provider, ctxFor('cfgG'));
    expect(provider.authenticateCallCount).toBe(2);
  });
});
