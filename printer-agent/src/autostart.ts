import path from 'path';
import fs from 'fs';
import { runPowerShell, resolveBundledScript } from './shell';

// Same filename the installer's own [Icons] entry creates (installer/trivo-print-agent.iss) —
// both write to this exact path so toggling autostart from /setup after an installer-driven
// install manages the very shortcut the installer made, instead of creating a second one.
const SHORTCUT_PATH = path.join(
  process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TRIVO Print Agent.lnk',
);

// Only meaningful for the packaged .exe — in dev (`ts-node`/`node dist/index.js`) `process.execPath`
// points at node.exe itself, not a standalone launchable agent, so a shortcut to it would either do
// nothing useful or launch a bare Node REPL at login.
export function isAutostartSupported(): boolean {
  return Boolean((process as unknown as { pkg?: unknown }).pkg);
}

export function isAutostartEnabled(): boolean {
  return SHORTCUT_PATH !== '' && fs.existsSync(SHORTCUT_PATH);
}

export async function setAutostart(enable: boolean): Promise<{ ok: boolean; error?: string }> {
  if (enable && !isAutostartSupported()) {
    return { ok: false, error: 'Autostart is only available in the downloaded .exe build, not this dev run.' };
  }
  const args = enable
    ? ['-File', resolveBundledScript('install-autostart.ps1'), '-Action', 'install', '-ExePath', process.execPath]
    : ['-File', resolveBundledScript('install-autostart.ps1'), '-Action', 'uninstall'];
  const { code, stderr } = await runPowerShell(args);
  if (code !== 0) {
    return { ok: false, error: stderr.trim() || 'Failed to update autostart.' };
  }
  return { ok: true };
}
