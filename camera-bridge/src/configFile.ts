import fs from 'fs';
import path from 'path';
import { ConfigError } from './config';

// The non-secret settings file. Keys are the same names as the environment variables (one vocabulary, not two), the
// environment overrides the file, and a key that looks like a secret — or any key we do not know — is a startup
// failure: a credential must never be parked in a plain file, and a typo must not silently fall back to a default.
const ALLOWED = /^(TRIVO_API_URL|STATION_ID|CAMERA_PROVIDER|BRIDGE_PORT|BRIDGE_TEMP_DIR|BRIDGE_TEMP_MAX_MB|LOG_LEVEL|CAPTURE_TIMEOUT_MS|TRIVO_ALLOW_LOCALHOST_HTTP|CAMERA_OPT_[A-Z0-9_]{1,40})$/;
const SECRET_LIKE = /secret|token|password|credential|ticket|jwt|bearer|apikey|api_key|private/i;

export function parseConfigFile(text: string): Record<string, string> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ConfigError('Config file is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('Config file must be a JSON object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_LIKE.test(k)) throw new ConfigError(`Config file key "${k}" looks like a secret — the station credential belongs in the DPAPI store (set-credential), never in a file`);
    if (!ALLOWED.test(k)) throw new ConfigError(`Config file key "${k}" is not a supported setting`);
    if (typeof v !== 'string' && typeof v !== 'number') throw new ConfigError(`Config file value for "${k}" must be a string or number`);
    out[k] = String(v);
  }
  return out;
}

/** Reads the settings file if it exists (a missing file is fine; an unreadable or malformed one is not). */
export function readConfigFile(file: string): Record<string, string> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError('Config file exists but cannot be read');
  }
  return parseConfigFile(text);
}

export function writeConfigFile(file: string, values: Record<string, string>): void {
  parseConfigFile(JSON.stringify(values)); // never write something we would refuse to read
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** File values first, real environment on top. */
export function mergedEnv(file: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...readConfigFile(file), ...env };
}
