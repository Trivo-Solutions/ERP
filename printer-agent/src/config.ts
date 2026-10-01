import path from 'path';
import os from 'os';
import fs from 'fs';

// Fixed, always-writable per-user location — independent of wherever the .exe happens to be
// extracted/moved to, and survives replacing the .exe with a newer download. This is what lets
// setup be "run the exe, pick a printer" instead of "copy a .env file next to the exe."
const CONFIG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SeaErpPrintAgent');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface AgentConfig {
  printerName?: string;
  port?: number;
}

export function readConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      printerName: typeof parsed.printerName === 'string' ? parsed.printerName : undefined,
      port: Number.isFinite(parsed.port) ? Number(parsed.port) : undefined,
    };
  } catch {
    return {};
  }
}

export function writeConfig(patch: AgentConfig): AgentConfig {
  const merged = { ...readConfig(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Write-then-rename so a crash/power-loss mid-write can't leave a half-written, unparseable
  // config file behind on the next launch.
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
  fs.renameSync(tmpPath, CONFIG_PATH);
  return merged;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
