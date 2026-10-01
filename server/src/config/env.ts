import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3001').transform(Number),
  // Interface to bind. Set 127.0.0.1 when a local reverse proxy fronts the API, so the port (incl. the operator
  // /platform API) is not reachable from the network. Unset = all interfaces.
  HOST: z.string().optional(),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('8h'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.string().default('9000').transform(Number),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET_NAME: z.string().default('sea-erp-files'),
  MINIO_USE_SSL: z.string().default('false').transform(v => v === 'true'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587').transform(Number),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  METAL_RATE_API_URL: z.string().optional(),
  METAL_RATE_API_KEY: z.string().optional(),
  // GST Phase C — GSTIN lookup provider. Unset (the default) = shared/gstProvider.ts always reports
  // NOT_CONFIGURED, never a guess or fabricated result. Same "declared but unconfigured until a real
  // provider is chosen" posture as METAL_RATE_API_URL/KEY above. GST_PROVIDER_NAME is only a label
  // stamped onto a lookup result's `source` field — defaults to 'http' if unset.
  GST_PROVIDER_API_URL: z.string().optional(),
  GST_PROVIDER_API_KEY: z.string().optional(),
  GST_PROVIDER_NAME: z.string().optional(),
  // (GSTIN / COMPANY_NAME / COMPANY_ADDRESS / COMPANY_STATE_CODE used to live here. Company identity is
  // per-company data on the Company row now; a process-wide env value would be shared by every company.)
  // Operator (platform) API key for POST /platform/* — unset = the platform API is disabled (404).
  // Must be a long random secret; compared in constant time. Never a tenant credential.
  // Number of reverse-proxy hops in front of the API (nginx = 1). REQUIRED behind a proxy: without it every client
  // appears to come from the proxy's address, so ALL companies' users would share ONE rate-limit bucket (one
  // company's failed logins could lock out another's). Leave unset when the API is exposed directly — trusting
  // X-Forwarded-For there would let a caller spoof its own address and dodge the limits.
  // Per-IP request budget for the whole API per 15 minutes. A shop's counters all share one public IP (NAT), so size
  // this for the busiest office, not one user. (Credential endpoints have their own much stricter limiter.)
  API_RATE_LIMIT_MAX: z.string().default('1000').transform(Number),
  // Login / refresh / invitation-accept attempts per IP per 15 minutes. Deliberately low (brute-force defence), but a
  // shop's counters share one public IP, so size it for the number of people signing in at once.
  AUTH_RATE_LIMIT_MAX: z.string().default('20').transform(Number),
  TRUST_PROXY: z.string().optional(),
  TRIVO_PLATFORM_API_KEY: z.string().min(32).optional(),
  // (SCALE_PORT / SCALE_BAUD_RATE / RFID_READER_PORT used to live here — a process-wide "default scale" no
  // company owns. Devices are company-owned HardwareDevice rows only; see shared/hardware.ts.)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
