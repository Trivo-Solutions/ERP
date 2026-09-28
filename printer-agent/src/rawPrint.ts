import path from 'path';
import os from 'os';
import fsSync from 'fs';
import fs from 'fs/promises';
import crypto from 'crypto';
import { spawn } from 'child_process';

const BUNDLED_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'print-raw.ps1');

// When packaged with `pkg`, bundled assets live in a virtual snapshot filesystem that only this
// Node process can read — powershell.exe is a separate process and needs a real path on disk, so
// extract the script once (no-op in the normal, non-pkg dev/prod run).
let extractedScriptPath: string | null = null;
function getPrintScriptPath(): string {
  if (!extractedScriptPath) {
    const dest = path.join(os.tmpdir(), 'sea-erp-print-raw.ps1');
    fsSync.writeFileSync(dest, fsSync.readFileSync(BUNDLED_SCRIPT));
    extractedScriptPath = dest;
  }
  return extractedScriptPath;
}

function runPowerShell(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

export async function printTspl(printerName: string, tspl: string): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `tspl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.prn`);
  await fs.writeFile(tmpFile, tspl);
  try {
    const { code, stdout, stderr } = await runPowerShell([
      '-File', getPrintScriptPath(), '-PrinterName', printerName, '-FilePath', tmpFile,
    ]);
    if (code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `print-raw.ps1 exited with code ${code}`);
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// Win32_Printer.PrinterStatus: 3=Idle, 4=Printing, 5=Warmup are all "fine"; 7=Offline is the one
// that matters for the counter operator. WorkOffline is Windows' own separate "set offline" flag
// and takes priority over whatever PrinterStatus happens to say.
export async function getPrinterStatus(printerName: string): Promise<{ online: boolean; statusText: string }> {
  const escaped = printerName.replace(/'/g, "''");
  const script = `Get-CimInstance -ClassName Win32_Printer -Filter "Name='${escaped}'" | Select-Object WorkOffline,PrinterStatus | ConvertTo-Json -Compress`;
  const { code, stdout, stderr } = await runPowerShell(['-Command', script]);
  if (code !== 0) {
    return { online: false, statusText: stderr.trim() || 'Unable to query printer status' };
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { online: false, statusText: `Printer not found: ${printerName}` };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const workOffline = Boolean(parsed.WorkOffline);
    const printerStatus = Number(parsed.PrinterStatus);
    if (workOffline) return { online: false, statusText: 'Offline (marked offline in Windows)' };
    if (printerStatus === 7) return { online: false, statusText: 'Offline' };
    return { online: true, statusText: 'Online' };
  } catch {
    return { online: false, statusText: 'Unable to parse printer status' };
  }
}
