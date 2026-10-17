import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import { runPowerShell, resolveBundledScript } from './shell';

// Sends already-encoded ESC/POS bytes to a Windows printer with the RAW datatype, reusing the
// existing print-raw.ps1 unchanged (it is byte-clean; rawPrint.ts's printTspl is not, since it
// writes a string). The label (TSPL) path is not touched.
export async function sendRawBytes(printerName: string, bytes: Buffer): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `receipt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`);
  await fs.writeFile(tmpFile, bytes);
  try {
    const { code, stdout, stderr } = await runPowerShell([
      '-File', resolveBundledScript('print-raw.ps1'), '-PrinterName', printerName, '-FilePath', tmpFile,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `print-raw.ps1 exited with code ${code}`);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

export type ReceiptJobResult = { jobId: string; status: 'SENT_TO_SPOOLER'; duplicate: boolean };

// One job at a time per agent (two clients must not interleave bytes on one printer), and a
// client-supplied jobId makes a repeated request safe: a job that is running or already went to the
// printer is never sent twice. Only successes are remembered - a failed job can be retried with the
// same id.
export class ReceiptJobRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<ReceiptJobResult>>();
  private done = new Map<string, ReceiptJobResult>();
  constructor(private maxRemembered = 500) {}

  run(jobId: string, send: () => Promise<void>): Promise<ReceiptJobResult> {
    const finished = this.done.get(jobId);
    if (finished) return Promise.resolve({ ...finished, duplicate: true });
    const running = this.inFlight.get(jobId);
    if (running) return running.then((r) => ({ ...r, duplicate: true }));

    const job = this.tail.then(async () => {
      await send();
      const result: ReceiptJobResult = { jobId, status: 'SENT_TO_SPOOLER', duplicate: false };
      this.done.set(jobId, result);
      if (this.done.size > this.maxRemembered) this.done.delete(this.done.keys().next().value as string);
      return result;
    });
    this.tail = job.catch(() => undefined);
    this.inFlight.set(jobId, job);
    const clear = () => { this.inFlight.delete(jobId); };
    job.then(clear, clear);
    return job;
  }
}

// ESC/POS bytes sent to the TSC label printer (or TSPL to the receipt printer) would print garbage
// or lock it up, so the two roles must never resolve to the same Windows queue.
export function sameQueue(a: string | null, b: string | null): boolean {
  return Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();
}
