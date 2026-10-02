// G8a — authentication/session abstraction (brief §11). A small in-process cache in front of
// whatever a provider's own authenticate() does — the calling business code never knows whether a
// provider uses OAuth, a static API key, or something else; it only ever calls
// getOrAuthenticate(configId, provider, ctx).
//
// Scope limitation, stated plainly: this cache is PER PROCESS (a plain Map), not Redis-backed. For
// a single-instance deployment this is exactly correct; a horizontally-scaled API would want a
// shared cache so every instance doesn't authenticate independently — that is an explicit
// out-of-scope item for G8a (see the final report), not an oversight, and nothing above this layer
// needs to change to add it later (getOrAuthenticate's signature doesn't leak the storage).
import { GstIntegrationAuthResult, GstIntegrationCallContext, GstIntegrationProvider } from '../types';

// A token is treated as expired slightly before its real expiry so a call doesn't race a
// still-in-flight provider-side expiration.
const EXPIRY_SKEW_MS = 5_000;

interface CachedSession {
  result: GstIntegrationAuthResult;
  expiresAt: number; // epoch ms; sessions with no provider-supplied expiry are never cached (see below)
}

const sessionCache = new Map<string, CachedSession>();
const inFlight = new Map<string, Promise<GstIntegrationAuthResult>>();

function isFresh(session: CachedSession | undefined): session is CachedSession {
  return !!session && session.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

/**
 * Returns a cached, still-valid session for `configId` if one exists; otherwise calls
 * `provider.authenticate(ctx)` exactly once even under concurrent callers for the same configId
 * (single-flight — concurrent requests await the same in-flight promise rather than each starting
 * their own authentication). A provider result with no `expiresAt` is never cached (treated as
 * single-use) since caching an unbounded-lifetime credential by accident would be the more
 * dangerous failure mode.
 */
export async function getOrAuthenticate(
  configId: string,
  provider: GstIntegrationProvider,
  ctx: GstIntegrationCallContext,
): Promise<GstIntegrationAuthResult> {
  const cached = sessionCache.get(configId);
  if (isFresh(cached)) return cached.result;

  const pending = inFlight.get(configId);
  if (pending) return pending;

  const attempt = (async () => {
    try {
      const result = await provider.authenticate(ctx);
      if (result.status === 'AUTHENTICATED' && result.expiresAt) {
        sessionCache.set(configId, { result, expiresAt: result.expiresAt });
      } else {
        sessionCache.delete(configId);
      }
      return result;
    } finally {
      inFlight.delete(configId);
    }
  })();
  inFlight.set(configId, attempt);
  return attempt;
}

/** Forces the next call for this config to re-authenticate — e.g. after a 401 mid-session. */
export function invalidateSession(configId: string): void {
  sessionCache.delete(configId);
}

/** Test-only: resets all cached/in-flight sessions so test files don't leak state into each other. */
export function __resetAllSessionsForTests(): void {
  sessionCache.clear();
  inFlight.clear();
}
