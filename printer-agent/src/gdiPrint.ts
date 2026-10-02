import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import bwipjs from 'bwip-js';
import { runPowerShell, resolveBundledScript } from './shell';
import { DOTS_PER_MM, parseTspl } from './tsplParser';

// Prints the way Windows apps (and Gati) do: draw the label as a normal page and hand it to the TSC
// driver, which converts it to printer language and handles the handshake with the printer. Raw
// TSPL through the port monitor locked this printer up after every job.
async function modulesImage(bcid: 'code128' | 'qrcode', text: string): Promise<string> {
  const png = await bwipjs.toBuffer({
    bcid, text, scale: 1, includetext: false, paddingwidth: 0, paddingheight: 0,
    ...(bcid === 'qrcode' ? { eclevel: 'M' } : { height: 10 }),
  });
  return png.toString('base64');
}

export async function printViaDriver(printerName: string, tspl: string): Promise<{ copies: number }> {
  const label = parseTspl(tspl);
  const items = [];
  for (const it of label.items) {
    if (it.type === 'barcode') items.push({ ...it, sbs: (bwipjs.raw('code128', it.text)[0] as { sbs: number[] }).sbs });
    else if (it.type === 'qrcode') items.push({ ...it, png: await modulesImage('qrcode', it.text) });
    else items.push(it);
  }
  const job = { widthMm: label.widthMm, heightMm: label.heightMm, dotsPerMm: DOTS_PER_MM, items };
  const file = path.join(os.tmpdir(), `label-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.writeFile(file, JSON.stringify(job));
  try {
    for (let i = 0; i < label.copies; i++) {
      const { code, stdout, stderr } = await runPowerShell([
        '-File', resolveBundledScript('print-gdi.ps1'), '-PrinterName', printerName, '-JobFile', file,
      ]);
      if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `print-gdi.ps1 exited with code ${code}`);
    }
  } finally {
    await fs.unlink(file).catch(() => {});
  }
  return { copies: label.copies };
}
