// Prints straight to an Epson TM-m30III over the network (Wi-Fi / Ethernet) using the printer's own
// ePOS-Print web service - no PC and no print agent, so it works from an Android tablet/phone.
// The browser POSTs the ESC/POS bytes (the same raster + feed + cut the agent sends) wrapped in
// ePOS-Print XML to https://<printer-ip>/cgi-bin/epos/service.cgi. The printer's answer carries
// success="true|false" and an error code, so unlike the agent path a refusal (cover open, paper out,
// offline) is reported back.
//
// The setting is per DEVICE (localStorage), not per company: each tablet is told where its printer is.
//
// Prerequisites on the printer (Epson Web Config -> Network): a fixed IP, HTTPS enabled, ePOS-Print on,
// and the tablet's browser must trust the printer's certificate (open https://<ip> once and accept it).
const KEY = 'receiptPrinterIp';
const ENDPOINT = (host: string) => `https://${host}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`;

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d{1,5})?$/;

export function isValidPrinterHost(v: string): boolean {
  return HOST_RE.test(v.trim());
}

export function getNetworkPrinterHost(): string | null {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}

export function setNetworkPrinterHost(host: string | null): void {
  try {
    if (host && host.trim()) localStorage.setItem(KEY, host.trim());
    else localStorage.removeItem(KEY);
  } catch { /* private mode: setting just won't persist */ }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const BAND_ROWS = 256; // GS v 0 in bands so no single command overruns the printer's receive buffer

// ESC @, GS v 0 raster in bands, ESC J feed, GS V 66 0 partial cut - byte-for-byte the agent's buildReceiptJob.
export function buildEscPosRaster(bits: Uint8Array, widthDots: number, heightDots: number, feedDots = 96): Uint8Array {
  const bytesPerRow = widthDots / 8;
  const parts: number[] = [0x1b, 0x40];
  const out: Uint8Array[] = [];
  const flush = () => { out.push(Uint8Array.from(parts)); parts.length = 0; };
  for (let row = 0; row < heightDots; row += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, heightDots - row);
    parts.push(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8);
    flush();
    out.push(bits.subarray(row * bytesPerRow, (row + rows) * bytesPerRow));
  }
  for (let left = Math.max(0, Math.round(feedDots)); left > 0; left -= 255) parts.push(0x1b, 0x4a, Math.min(left, 255));
  parts.push(0x1d, 0x56, 0x42, 0x00);
  flush();
  const total = out.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of out) { all.set(p, at); at += p.length; }
  return all;
}

export function buildEposXml(escpos: Uint8Array): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><command>${hex(escpos)}</command></epos-print>`
    + '</s:Body></s:Envelope>';
}

export interface EposReply { success: boolean; code: string }

export function parseEposReply(xml: string): EposReply {
  // The reply is one fixed <response success=".." code=".." .../> element; read its attributes directly.
  const tag = /<(?:\w+:)?response\b([^>]*)>/.exec(xml);
  if (!tag) throw new Error('The printer sent a reply this app does not understand.');
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag[1])?.[1] ?? '';
  return { success: attr('success') === 'true', code: attr('code') };
}

const FRIENDLY: Record<string, string> = {
  EPTR_COVER_OPEN: 'the printer cover is open',
  EPTR_REC_EMPTY: 'the printer is out of paper',
  EPTR_AUTOMATICAL: 'the printer reported an error (check paper, cover and cutter)',
  EPTR_COMM: 'could not communicate with the printer',
  EPTR_TIMEOUT: 'the printer did not respond in time',
  EPTR_BUSY: 'the printer is busy - try again',
  SchemaError: 'the printer rejected the print data',
  PrintSystemError: 'the printer rejected the print job',
  DeviceNotFound: 'the printer did not accept the device id (is ePOS-Print enabled in Web Config?)',
};

export async function sendToNetworkPrinter(host: string, escpos: Uint8Array): Promise<void> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT(host), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: buildEposXml(escpos),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(`Could not reach the printer at ${host}. Check it is on, on the same Wi-Fi, and that you have opened https://${host} once in this browser and accepted its certificate.`);
  }
  if (!res.ok) throw new Error(`The printer answered HTTP ${res.status}.`);
  const reply = parseEposReply(await res.text());
  if (!reply.success) throw new Error(`Printer refused the job: ${FRIENDLY[reply.code] ?? (reply.code || 'unknown error')}.`);
}

// Text-only slip (init, text, feed, cut): proves address, certificate and cutter without an estimate.
export function printNetworkTest(host: string): Promise<void> {
  const text = ['TRIVO receipt printer test', new Date().toLocaleString('en-IN'), host].join('\n') + '\n';
  const body = Uint8Array.from([
    0x1b, 0x40,
    ...Array.from(text, (c) => { const n = c.charCodeAt(0); return n >= 0x20 && n < 0x7f || n === 0x0a ? n : 0x3f; }),
    0x1b, 0x4a, 96, 0x1d, 0x56, 0x42, 0x00,
  ]);
  return sendToNetworkPrinter(host, body);
}
