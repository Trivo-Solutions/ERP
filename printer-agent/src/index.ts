import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { printTspl, getPrinterStatus } from './rawPrint';

const PORT = Number(process.env.PRINT_AGENT_PORT) || 9101;
const PRINTER_NAME = process.env.PRINTER_NAME;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// A single raw write already takes real time on a thermal head; a runaway "copies" value from a
// bad request shouldn't be able to queue an unbounded number of them.
const MAX_COPIES = 50;

if (!PRINTER_NAME) {
  console.error('PRINTER_NAME is not set. Copy .env.example to .env and set it to the exact Windows printer name (see `Get-Printer`). Exiting.');
  process.exit(1);
}

const app = express();
// Loopback-only bind (below) is the actual security boundary here, not CORS — nothing outside
// this PC can reach the agent regardless of ALLOWED_ORIGIN.
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

app.get('/status', async (_req, res) => {
  const status = await getPrinterStatus(PRINTER_NAME!);
  res.json({ ok: true, printerName: PRINTER_NAME, ...status });
});

app.post('/print', async (req, res) => {
  const { tspl, copies } = req.body ?? {};
  if (!tspl || typeof tspl !== 'string') {
    res.status(400).json({ ok: false, error: 'Request body must include a "tspl" string.' });
    return;
  }
  const count = Math.min(Math.max(Number(copies) || 1, 1), MAX_COPIES);

  try {
    for (let i = 0; i < count; i++) {
      await printTspl(PRINTER_NAME!, tspl);
    }
    res.json({ ok: true, copies: count });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SEA ERP print agent listening on http://127.0.0.1:${PORT} (printer: "${PRINTER_NAME}")`);
});
