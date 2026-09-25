import { logger } from './logger';

// Redis is optional. If REDIS_URL is unset or the connection fails, all
// cache operations become no-ops so the server runs without Redis installed.

let redisClient: import('ioredis').Redis | null = null;

export async function connectRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('REDIS_URL not set — caching disabled, running without Redis');
    return;
  }

  try {
    const { default: Redis } = await import('ioredis');
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 3000,
    });

    redisClient.on('connect', () => logger.info('✅ Redis connected'));
    redisClient.on('error', (err) => {
      logger.warn(`Redis unavailable (${err.message}) — cache disabled`);
      redisClient = null;
    });

    await redisClient.connect();
  } catch (err: any) {
    logger.warn(`Redis init failed (${err.message}) — running without cache`);
    redisClient = null;
  }
}

// Exported singleton — may be null when Redis is unavailable
export { redisClient as redis };

// ═══════════════════════════════════════════════════════════════════════════
// MANDATORY KEY RULE: every company-owned cache/job/session key is
//
//     trivo:<companyId>:<...parts>
//
// and is only reachable through cache.forCompany(companyId) — there is deliberately NO raw
// cache.get(key)/set(key). A key can therefore never be global by accident, and one company can never
// read or clear another's. Genuinely platform-level keys (owned by no company) use
// cache.platform(...) and live under trivo:platform:. (If a Socket.io Redis adapter is ever added,
// give it the prefix `trivo:<env>:socketio` — its rooms are already company-namespaced.)
// A source-scanning test (redisNamespace.test.ts) fails the build if anything reaches the Redis
// client or these primitives another way.
// ═══════════════════════════════════════════════════════════════════════════

const COMPANY_ID = /^[a-z0-9]{20,32}$/;
const PART = /^[A-Za-z0-9_.:-]{1,128}$/;

export function companyCacheKey(companyId: string, ...parts: string[]): string {
  if (!COMPANY_ID.test(companyId)) throw new Error('cache key requires a valid companyId');
  if (parts.length === 0) throw new Error('cache key requires at least one part');
  for (const p of parts) if (!PART.test(p)) throw new Error(`invalid cache key part: ${JSON.stringify(p)}`);
  return `trivo:${companyId}:${parts.join(':')}`;
}

export function platformCacheKey(...parts: string[]): string {
  if (parts.length === 0) throw new Error('cache key requires at least one part');
  for (const p of parts) if (!PART.test(p)) throw new Error(`invalid cache key part: ${JSON.stringify(p)}`);
  return `trivo:platform:${parts.join(':')}`;
}

const ops = {
  async get<T>(key: string): Promise<T | null> {
    if (!redisClient) return null;
    try {
      const value = await redisClient.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch { return null; }
  },
  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    if (!redisClient) return;
    try { await redisClient.setex(key, ttlSeconds, JSON.stringify(value)); } catch {}
  },
  async del(key: string): Promise<void> {
    if (!redisClient) return;
    try { await redisClient.del(key); } catch {}
  },
  async delPrefix(prefix: string): Promise<void> {
    if (!redisClient) return;
    try {
      const keys = await redisClient.keys(`${prefix}*`);
      if (keys.length > 0) await redisClient.del(...keys);
    } catch {}
  },
};

export const cache = {
  /** The ONLY way to cache company-owned data. Every key is prefixed trivo:<companyId>:. */
  forCompany(companyId: string) {
    companyCacheKey(companyId, '_'); // validates the id up front
    return {
      get: <T>(...parts: string[]) => ops.get<T>(companyCacheKey(companyId, ...parts)),
      set: (parts: string[], value: unknown, ttlSeconds = 300) => ops.set(companyCacheKey(companyId, ...parts), value, ttlSeconds),
      del: (...parts: string[]) => ops.del(companyCacheKey(companyId, ...parts)),
      /** Clears only THIS company's keys that start with the given parts. */
      delPrefix: (...parts: string[]) => ops.delPrefix(companyCacheKey(companyId, ...parts)),
    };
  },
  /** For data owned by no company (e.g. a shared statutory reference). Never for company data. */
  platform: {
    get: <T>(...parts: string[]) => ops.get<T>(platformCacheKey(...parts)),
    set: (parts: string[], value: unknown, ttlSeconds = 300) => ops.set(platformCacheKey(...parts), value, ttlSeconds),
    del: (...parts: string[]) => ops.del(platformCacheKey(...parts)),
  },
};
