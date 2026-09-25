# SEA ERP Print Agent

Runs on a branch counter PC that has a TSC TTP-244 Pro attached over USB. Listens on
`127.0.0.1:9101` only — nothing outside this PC can reach it — and receives TSPL from the SEA ERP
web app running in the browser on the same machine, writing it straight to the Windows printer
queue as raw bytes (`scripts/print-raw.ps1`, bypassing the driver's normal GDI rendering so TSPL
commands reach the printer unmodified).

## Setup (once per counter PC)

1. Install the TSC TTP-244 Pro's Windows driver and confirm it prints a normal Windows test page
   first (Control Panel > Devices and Printers > right-click > Printer properties > Print Test
   Page). This proves USB + driver are fine before this agent is involved at all.
2. Note the printer's exact name as Windows shows it (or run `Get-Printer` in PowerShell).
3. Copy `.env.example` to `.env` and set `PRINTER_NAME` to that exact name.
4. Run `start.bat` (double-click, or from a terminal). The first run installs dependencies and
   builds; later runs just start the agent.

Leave the window open — this is a foreground process for now. Running it as a proper Windows
service / autostart-at-login is a documented fast-follow, not required to use printing today.

## API

- `GET /status` → `{ ok, printerName, online, statusText }`
- `POST /print` body `{ tspl: string, copies?: number }` → `{ ok: true, copies }` on success, or
  `{ ok: false, error }` (HTTP 502) with the underlying Win32/spooler error text on failure.

## Troubleshooting

- **Web app says "print agent not running on this PC"** — this process isn't running, or died.
  Re-run `start.bat`.
- **`GET /status` reports offline, or a print fails with an OpenPrinter/WritePrinter error** — the
  `PRINTER_NAME` in `.env` doesn't exactly match Windows' name for it, or the printer is
  off/disconnected/out of labels. Re-check with `Get-Printer` and the physical connection.
- **Agent reports success but nothing prints** — the raw write reached the spooler queue fine;
  check the printer itself (paused queue, out of labels, needs a manual "resume" in the print
  queue window).
