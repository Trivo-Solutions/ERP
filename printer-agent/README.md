# SEA ERP Print Agent

Runs on a branch counter PC that has a TSC TTP-244 Pro attached over USB. Listens on
`127.0.0.1:9101` only — nothing outside this PC can reach it — and receives TSPL from the SEA ERP
web app running in the browser on the same machine, draws the label (text, boxes, Code 128, QR) and
prints it through the Windows printer driver (`scripts/print-gdi.ps1`), the same way ordinary Windows
programs do. The old raw-bytes route (`scripts/print-raw.ps1`, `PRINT_MODE=raw`) locked the TTP-244 Pro
up after each job, so it is no longer the default.

## Setup (once per counter PC) — no files to copy or edit

1. Install the TSC TTP-244 Pro's Windows driver and confirm it prints a normal Windows test page
   first (Control Panel > Devices and Printers > right-click > Printer properties > Print Test
   Page). This proves USB + driver are fine before this agent is involved at all.
2. From the ERP web app, go to **Hardware** (or any "print agent not running" prompt) and click
   **Download Print Agent** — this fetches `printer-agent.zip` straight from the ERP site itself,
   no git or USB drive needed. Extract it anywhere on the counter PC.
3. Run `printer-agent.exe` (double-click). It's a standalone build — no Node/npm required on the
   counter PC.
   - If this PC has exactly one real printer installed, the agent picks it automatically —
     nothing else to do.
   - Otherwise it opens a small setup page in your browser (`http://127.0.0.1:9101/setup`): pick
     the printer from the list Windows already knows about and click **Save printer**. The choice
     is remembered under `%LOCALAPPDATA%\SeaErpPrintAgent\config.json` — it survives replacing the
     exe with a newer download, and you never edit that file by hand.
4. On the same setup page, tick **Start SEA ERP Print Agent at login** so you don't have to
   double-click the exe every morning — it creates a normal per-user Startup-folder shortcut, no
   admin rights needed. You can revisit `http://127.0.0.1:9101/setup` any time to change the
   printer or this setting.

Advanced/dev only: an `.env` next to the exe (see `.env.example`) can still force
`PRINTER_NAME`/`PRINT_AGENT_PORT`/`ALLOWED_ORIGIN`, and always wins over auto-detect and the setup
page — not needed for normal use.

### Building from source instead (development)

Only needed if you're changing the agent's code. Run `start.bat` (double-click, or from a
terminal) — the first run installs dependencies and builds via `tsc`; later runs just start the
agent with plain `node`/`ts-node`. It behaves the same as the packaged exe (auto-detect / setup
page), except **autostart is unavailable** in this mode — a Startup shortcut needs a real,
double-clickable exe to point at, not `node.exe` mid-source-tree.

The downloadable `.exe` above is built from this same source with `npm run package` (uses `pkg`
to bundle Node itself — see `package.json`'s `pkg` config) and is what `client/Dockerfile` ships
under `/downloads/printer-agent.zip` on every deploy. On a native (non-Docker) deploy, run
`scripts/build-download-package.ps1` before building the client — it does the same build + zip
step by hand.

## API

- `GET /status` → `{ ok, configured, printerName, online, statusText }`
- `POST /print` body `{ tspl: string, copies?: number }` → `{ ok: true, copies }` on success, or
  `{ ok: false, error }` (HTTP 502, or 409 if not configured yet) with the underlying Win32/spooler
  error text on failure.
- `GET /setup` → the HTML setup page (open it directly if it didn't auto-open).
- `GET /setup/printers` → `{ printers: string[] }`, the real (non-virtual) printers Windows has installed.
- `POST /setup` body `{ printerName: string }` → saves the choice and takes effect immediately, no restart.
- `GET /setup/autostart` → `{ enabled, supported }`.
- `POST /setup/autostart` body `{ enable: boolean }` → installs/removes the Startup-folder shortcut.

## Troubleshooting

- **Web app says "print agent not running on this PC"** — this process isn't running, or died.
  Re-run the exe (or, if autostart is on, log out and back in).
- **Web app says the agent isn't configured** — open `http://127.0.0.1:9101/setup` and pick a
  printer; it wasn't auto-detected because either none or more than one real printer is installed.
- **`GET /status` reports offline, or a print fails with an OpenPrinter/WritePrinter error** — the
  saved printer no longer matches Windows' name for it (renamed/reinstalled), or it's
  off/disconnected/out of labels. Reopen `/setup` to re-pick it, and check the physical connection.
- **Agent reports success but nothing prints** — the raw write reached the spooler queue fine;
  check the printer itself (paused queue, out of labels, needs a manual "resume" in the print
  queue window).
