import os from 'os';
import path from 'path';

/** The bridge's per-user data directory (DPAPI blob, config file, logs, temp images). */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TrivoCameraBridge');
}
export const configFilePath = (env: NodeJS.ProcessEnv = process.env) => (env.BRIDGE_CONFIG?.trim() ? path.resolve(env.BRIDGE_CONFIG.trim()) : path.join(dataDir(env), 'bridge.config.json'));
export const logFilePath = (env: NodeJS.ProcessEnv = process.env) => (env.BRIDGE_LOG_FILE?.trim() ? path.resolve(env.BRIDGE_LOG_FILE.trim()) : path.join(dataDir(env), 'logs', 'bridge.log'));
export const lockFilePath = (env: NodeJS.ProcessEnv = process.env) => path.join(dataDir(env), 'bridge.lock');
