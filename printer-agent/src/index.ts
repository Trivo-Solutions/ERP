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
app.use(express.json({ limit: '1mb' }));

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
