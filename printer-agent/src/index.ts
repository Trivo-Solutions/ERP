import 'dotenv/config';
import { exec } from 'child_process';
import express from 'express';
import cors from 'cors';
import { printTspl, getPrinterStatus } from './rawPrint';
import { printViaDriver } from './gdiPrint';
import { readConfig, writeConfig } from './config';
import { listRealPrinters } from './printers';
import { isAutostartEnabled, isAutostartSupported, setAutostart } from './autostart';
import { renderSetupPage } from './setupPage';
import crypto from 'crypto';
import { buildReceiptJob, buildTestJob, validateBitmap } from './escpos';
import { ReceiptJobRunner, sameQueue, sendRawBytes } from './receiptPrint';

// A single raw write already takes real time on a thermal head; a runaway "copies" value from a
// bad request shouldn't be able to queue an unbounded number of them.
const MAX_COPIES = 50;

// Env vars still win when set (handy for dev/CI), but they're now optional — the normal path is
// no .env at all: config.json (auto-written by /setup, or by the one-printer auto-detect below)
// is what a real counter-PC install runs on. This mutable object (not consts) is what lets /setup
// take effect immediately, without restarting the process.
const fileConfig = readConfig();
const state: { printerName: string | null; port: number } = {
  printerName: process.env.PRINTER_NAME || fileConfig.printerName || null,
  port: Number(process.env.PRINT_AGENT_PORT) || fileConfig.port || 9101,
};
const PRINT_MODE = (process.env.PRINT_MODE || 'driver').toLowerCase();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
// Loopback-only bind (below) is the actual security boundary here, not CORS — nothing outside
// this PC can reach the agent regardless of ALLOWED_ORIGIN.
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

app.get('/status', async (_req, res) => {
  if (!state.printerName) {
    res.json({ ok: true, configured: false, printerName: null, online: false, statusText: `Not configured — open http://127.0.0.1:${state.port}/setup` });
    return;
  }
  const status = await getPrinterStatus(state.printerName);
  res.json({ ok: true, configured: true, printerName: state.printerName, ...status });
});

app.post('/print', async (req, res) => {
  if (!state.printerName) {
    res.status(409).json({ ok: false, error: `Print agent is not configured yet. Open http://127.0.0.1:${state.port}/setup and pick a printer.` });
    return;
  }
  const { tspl, copies } = req.body ?? {};
  if (!tspl || typeof tspl !== 'string') {
    res.status(400).json({ ok: false, error: 'Request body must include a "tspl" string.' });
    return;
  }
  const count = Math.min(Math.max(Number(copies) || 1, 1), MAX_COPIES);

  try {
    // Default: draw the label and print it through the Windows driver (what Gati does). Raw TSPL
    // through the port monitor locked the TTP-244 Pro up; PRINT_MODE=raw restores the old route.
    for (let i = 0; i < count; i++) {
      if (PRINT_MODE === 'raw') await printTspl(state.printerName, tspl);
      else await printViaDriver(state.printerName, tspl);
    }
    res.json({ ok: true, copies: count });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Receipt printer (ESC/POS, e.g. Epson TM-m30III) ─────────────────────────────────────────────
// Entirely separate from the label printer above: its own configured printer, its own routes, its
// own serialized queue. Nothing in /status or /print reads or changes any of it.
const receiptState: { printerName: string | null } = {
  printerName: process.env.RECEIPT_PRINTER_NAME || fileConfig.receiptPrinterName || null,
};
const receiptRunner = new ReceiptJobRunner();
const JOB_ID_PATTERN = /^[A-Za-z0-9:_-]{8,100}$/;
const MAX_RECEIPT_COPIES = 5;

// With ALLOWED_ORIGIN left at '*' (the default) nothing changes. Set it to the ERP's own origin
// and the receipt routes refuse a request that names any other web page as its origin, so an
// unrelated site open in the same browser cannot make the counter print.
function receiptOriginGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN !== '*' && origin && !ALLOWED_ORIGIN.split(',').map((s) => s.trim()).includes(origin)) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  next();
}

app.get('/receipt/status', async (_req, res) => {
  if (!receiptState.printerName) {
    res.json({ ok: true, configured: false, printerName: null, online: false, statusText: `Receipt printer not set — open http://127.0.0.1:${state.port}/setup` });
    return;
  }
  const status = await getPrinterStatus(receiptState.printerName);
  res.json({ ok: true, configured: true, printerName: receiptState.printerName, ...status });
});

app.post('/receipt/config', receiptOriginGuard, (req, res) => {
  const { printerName } = req.body ?? {};
  if (typeof printerName !== 'string' || !printerName.trim()) {
    res.status(400).json({ ok: false, error: 'printerName is required.' });
    return;
  }
  if (sameQueue(printerName, state.printerName)) {
    res.status(400).json({ ok: false, error: 'That is the label printer. Pick the receipt printer (e.g. EPSON TM-m30III) — a printer cannot be both.' });
    return;
  }
  writeConfig({ receiptPrinterName: printerName.trim() });
  receiptState.printerName = printerName.trim();
  res.json({ ok: true, printerName: receiptState.printerName });
});

// Body: { jobId, widthDots, heightDots, data (base64 1-bit bitmap), copies?, cut?, feedDots? }.
// "ok" means the bytes were handed to the Windows spooler for that printer - the agent cannot see
// paper-out or a jam after that, and says so (status: SENT_TO_SPOOLER, never "printed").
app.post('/receipt/print', receiptOriginGuard, async (req, res) => {
  if (!receiptState.printerName) {
    res.status(409).json({ ok: false, code: 'NOT_CONFIGURED', error: `Receipt printer is not set. Open http://127.0.0.1:${state.port}/setup and pick it.` });
    return;
  }
  if (sameQueue(receiptState.printerName, state.printerName)) {
    res.status(409).json({ ok: false, code: 'SAME_AS_LABEL_PRINTER', error: 'The receipt printer is set to the same printer as the label printer. Fix it on the setup page.' });
    return;
  }
  const { jobId, widthDots, heightDots, data, copies, cut, feedDots } = req.body ?? {};
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    res.status(400).json({ ok: false, error: 'jobId (8-100 chars: letters, digits, : _ -) is required.' });
    return;
  }
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    res.status(400).json({ ok: false, error: '"data" must be a base64 string.' });
    return;
  }
  const bitmap = { widthDots: Number(widthDots), heightDots: Number(heightDots), bits: Buffer.from(data, 'base64') };
  const invalid = validateBitmap(bitmap);
  if (invalid) {
    res.status(400).json({ ok: false, error: invalid });
    return;
  }
  const count = Math.min(Math.max(Number(copies) || 1, 1), MAX_RECEIPT_COPIES);
  const printerName = receiptState.printerName;
  try {
    // An offline printer is refused up front, not queued behind a spooler that will hold the job
    // and print it later (a surprise reprint when someone turns the printer back on).
    const status = await getPrinterStatus(printerName);
    if (!status.online) {
      res.status(409).json({ ok: false, code: 'PRINTER_OFFLINE', error: `Receipt printer is not ready: ${status.statusText}` });
      return;
    }
    const job = buildReceiptJob(bitmap, { cut: cut !== false, feedDots: feedDots === undefined ? undefined : Number(feedDots) });
    const result = await receiptRunner.run(jobId, async () => {
      for (let i = 0; i < count; i++) await sendRawBytes(printerName, job);
    });
    res.json({ ok: true, ...result, copies: count });
  } catch (err) {
    res.status(502).json({ ok: false, code: 'SEND_FAILED', error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/receipt/test', receiptOriginGuard, async (_req, res) => {
  if (!receiptState.printerName) {
    res.status(409).json({ ok: false, code: 'NOT_CONFIGURED', error: 'Receipt printer is not set.' });
    return;
  }
  if (sameQueue(receiptState.printerName, state.printerName)) {
    res.status(409).json({ ok: false, code: 'SAME_AS_LABEL_PRINTER', error: 'The receipt printer is set to the same printer as the label printer.' });
    return;
  }
  try {
    const status = await getPrinterStatus(receiptState.printerName);
    if (!status.online) {
      res.status(409).json({ ok: false, code: 'PRINTER_OFFLINE', error: `Receipt printer is not ready: ${status.statusText}` });
      return;
    }
    await receiptRunner.run(`test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, () =>
      sendRawBytes(receiptState.printerName!, buildTestJob(['TRIVO receipt printer test', receiptState.printerName!, new Date().toISOString()])));
    res.json({ ok: true, status: 'SENT_TO_SPOOLER' });
  } catch (err) {
    res.status(502).json({ ok: false, code: 'SEND_FAILED', error: err instanceof Error ? err.message : String(err) });
  }
});

// ── First-run / reconfigure setup (served by the agent itself, no separate installer) ──────────
app.get('/setup', (_req, res) => {
  res.type('html').send(renderSetupPage());
});

app.get('/setup/printers', async (_req, res) => {
  const printers = await listRealPrinters();
  res.json({ printers });
});

app.post('/setup', (req, res) => {
  const { printerName } = req.body ?? {};
  if (!printerName || typeof printerName !== 'string' || !printerName.trim()) {
    res.status(400).json({ ok: false, error: 'printerName is required.' });
    return;
  }
  writeConfig({ printerName: printerName.trim() });
  state.printerName = printerName.trim();
  res.json({ ok: true, printerName: state.printerName });
});

app.get('/setup/autostart', (_req, res) => {
  res.json({ enabled: isAutostartEnabled(), supported: isAutostartSupported() });
});

app.post('/setup/autostart', async (req, res) => {
  const { enable } = req.body ?? {};
  const result = await setAutostart(Boolean(enable));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json({ ok: true, enabled: isAutostartEnabled() });
});

app.listen(state.port, '127.0.0.1', () => {
  console.log(`SEA ERP print agent listening on http://127.0.0.1:${state.port}` + (state.printerName ? ` (printer: "${state.printerName}")` : ' — not configured yet.'));
  if (!state.printerName) void bootstrapConfiguration();
});

// Runs once at startup when nothing is configured yet: if Windows only has one real printer
// installed, just use it — that's the common counter-PC case and needs zero clicks. Otherwise
// (none found, or more than one candidate) fall back to opening the setup page for a human pick.
async function bootstrapConfiguration(): Promise<void> {
  const printers = await listRealPrinters();
  if (printers.length === 1) {
    writeConfig({ printerName: printers[0] });
    state.printerName = printers[0];
    console.log(`Auto-detected the only installed printer: "${printers[0]}"`);
    return;
  }

  const setupUrl = `http://127.0.0.1:${state.port}/setup`;
  console.log(`Opening setup page: ${setupUrl}`);
  if (process.platform === 'win32') {
    // Windows `start` needs an empty title arg before the URL when the command is quoted.
    exec(`start "" "${setupUrl}"`);
  }
}
