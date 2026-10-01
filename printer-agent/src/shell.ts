import path from 'path';
import os from 'os';
import fsSync from 'fs';
import { spawn } from 'child_process';

// When packaged with `pkg`, bundled assets live in a virtual snapshot filesystem that only this
// Node process can read — powershell.exe is a separate process and needs a real path on disk, so
// extract the script once per file (no-op in the normal, non-pkg dev/prod run).
const extractedPaths = new Map<string, string>();
export function resolveBundledScript(scriptName: string): string {
  const cached = extractedPaths.get(scriptName);
  if (cached) return cached;
  const bundled = path.resolve(__dirname, '..', 'scripts', scriptName);
  const dest = path.join(os.tmpdir(), `sea-erp-${scriptName}`);
  fsSync.writeFileSync(dest, fsSync.readFileSync(bundled));
  extractedPaths.set(scriptName, dest);
  return dest;
}

export function runPowerShell(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
