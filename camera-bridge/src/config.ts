import path from 'path';
import { dataDir } from './paths';
import { parseProviderOptions, ProviderOptions } from './camera/providerOptions';
import type { CameraProviderKind } from './camera/createProvider';

// Minimum bridge configuration. Deliberately NO company id, branch id or user: the server resolves all of those
// from the station. The station secret is not configuration — see credentials.ts.
export interface BridgeConfig {
  apiUrl: string;
  stationId: string;
  cameraProvider: CameraProviderKind;
  /** Provider-specific settings (CAMERA_OPT_*); opaque to the bridge core. */
  cameraOptions: ProviderOptions;
  port: number;
  heartbeatIntervalMs: number;
  /** NODE_ENV=production. Stricter validation applies. */
  production: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Non-fatal findings the caller should log once (e.g. mock camera in production). */
  warnings: string[];
  /** Remote capture (Phase 5D). Optional: omitted values take defaultCaptureConfig(). */
  capture?: Partial<CaptureConfig>;
}

export interface CaptureConfig {
  /** Dedicated directory for in-flight / not-yet-uploaded images. The only place the bridge ever writes an image. */
  tempDir: string;
  /** How long an image that could not be uploaded (recoverable failure) may stay on disk before it is discarded. */
  tempRetentionMs: number;
  /** Upper bound on the bytes the temp area may hold; the oldest images are discarded first. */
  tempMaxBytes: number;
  captureTimeoutMs: number;
  uploadTimeoutMs: number;
  uploadMaxAttempts: number;
  uploadBackoffMs: number;
  /** Long-poll duration asked of the ERP (it caps this at 25 s). */
  commandWaitSeconds: number;
  /** How long stop() waits for an in-flight command before giving up on it. */
  shutdownTimeoutMs: number;
}

export function defaultCaptureConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  return {
    tempDir: path.join(dataDir(env), 'tmp'), tempRetentionMs: 60 * 60 * 1000, tempMaxBytes: 200 * 1024 * 1024,
    captureTimeoutMs: 15_000, uploadTimeoutMs: 30_000, uploadMaxAttempts: 3, uploadBackoffMs: 2_000, commandWaitSeconds: 20,
    shutdownTimeoutMs: 10_000,
  };
}

export type { CameraProviderKind } from './camera/createProvider';
export const CAMERA_PROVIDERS: readonly CameraProviderKind[] = ['mock', 'sony', 'webcam', 'auto'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export class ConfigError extends Error {}

const STATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function intIn(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new ConfigError(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const production = env.NODE_ENV === 'production';
  const warnings: string[] = [];
  const apiUrl = (env.TRIVO_API_URL ?? '').trim().replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(apiUrl); } catch { throw new ConfigError('TRIVO_API_URL is required and must be a valid URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new ConfigError('TRIVO_API_URL must not carry credentials, a query string or a fragment');
  // The station secret travels to this URL: require TLS except for a loopback dev server. In production even that
  // exception needs an explicit opt-in, so a stray localhost URL cannot ship by accident.
  const plainLocal = parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !plainLocal) throw new ConfigError('TRIVO_API_URL must use https (http is allowed only for localhost development)');
  if (plainLocal && production && env.TRIVO_ALLOW_LOCALHOST_HTTP !== '1') {
    throw new ConfigError('TRIVO_API_URL must use https in production (set TRIVO_ALLOW_LOCALHOST_HTTP=1 to allow a localhost http server)');
  }

  const stationId = (env.STATION_ID ?? '').trim();
  if (!STATION_ID.test(stationId)) throw new ConfigError('STATION_ID is required (letters, digits, "_" or "-", max 64)');

  // No silent fallback in production: the operator must say which camera this station has.
  const rawProvider = env.CAMERA_PROVIDER?.trim().toLowerCase();
  if (!rawProvider && production) throw new ConfigError('CAMERA_PROVIDER is required in production (mock | sony | webcam | auto)');
  const cameraProvider = (rawProvider || 'mock') as CameraProviderKind;
  if (!CAMERA_PROVIDERS.includes(cameraProvider)) throw new ConfigError(`CAMERA_PROVIDER "${rawProvider}" is not supported (mock | sony | webcam | auto)`);
  if (production && cameraProvider === 'mock') warnings.push('MOCK_CAMERA_IN_PRODUCTION');
  const cameraOptions = parseProviderOptions(cameraProvider, env);

  const port = intIn(env, 'BRIDGE_PORT', 1, 65535) ?? 9102;

  const level = (env.LOG_LEVEL?.trim().toLowerCase() || 'info') as BridgeConfig['logLevel'];
  if (!LOG_LEVELS.includes(level)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')}`);

  const capture: Partial<CaptureConfig> = {};
  if (env.BRIDGE_TEMP_DIR && env.BRIDGE_TEMP_DIR.trim()) capture.tempDir = path.resolve(env.BRIDGE_TEMP_DIR.trim());
  const timeout = intIn(env, 'CAPTURE_TIMEOUT_MS', 1_000, 120_000);
  if (timeout !== undefined) capture.captureTimeoutMs = timeout;
  const maxMb = intIn(env, 'BRIDGE_TEMP_MAX_MB', 1, 10_240);
  if (maxMb !== undefined) capture.tempMaxBytes = maxMb * 1024 * 1024;
  return { apiUrl, stationId, cameraProvider, cameraOptions, port, heartbeatIntervalMs: 30_000, production, logLevel: level, warnings, capture };
}
