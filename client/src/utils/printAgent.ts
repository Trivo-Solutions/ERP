// Talks to the local print agent (printer-agent/) running on this counter PC's own machine —
// never the main API server, which has no route to a USB-attached printer. Loopback-only by
// design (see printer-agent/README.md), so this is always a same-machine call regardless of
// where the web app itself is served from.
const DEFAULT_AGENT_URL = 'http://127.0.0.1:9101';

// Served by client/nginx.conf straight from client/public/downloads — a same-origin download, no
// git/USB drive needed. The installer is the recommended path (run it, done — no .env, no
// manual printer name). It's committed to the repo rather than built by client/Dockerfile,
// because Inno Setup (its compiler) is Windows-only and can't run in that Linux build container —
// see printer-agent/scripts/build-download-package.ps1 and the root .gitignore's carve-out.
export const PRINT_AGENT_INSTALLER_URL = '/downloads/trivo-print-agent-setup.exe';

// The old manual flow (extract zip, run the exe directly) — built by client/Dockerfile via
// printer-agent's `npm run package`. Kept as a fallback for anyone who wants to inspect the
// contents first or can't run an installer for some reason.
export const PRINT_AGENT_DOWNLOAD_URL = '/downloads/printer-agent.zip';

// Distinguishable from other agent errors (bad request, printer offline, ...) so the UI can offer
// a download link specifically when the agent process itself isn't reachable.
export class PrintAgentNotRunningError extends Error {
  constructor() {
    super('Print agent not running on this PC. Download and run it, then try again.');
    this.name = 'PrintAgentNotRunningError';
  }
}

function agentBaseUrl(): string {
  return (localStorage.getItem('printAgentUrl') || DEFAULT_AGENT_URL).replace(/\/$/, '');
}

export interface PrintAgentStatus {
  ok: true;
  configured: boolean;
  printerName: string | null;
  online: boolean;
  statusText: string;
}

// Same-machine setup page the agent serves itself — open it to pick/change the printer or toggle
// autostart. Not affected by `printAgentUrl` overrides; the agent always binds 127.0.0.1:9101
// unless PRINT_AGENT_PORT was explicitly overridden, same assumption the rest of this file makes.
export const PRINT_AGENT_SETUP_URL = `${DEFAULT_AGENT_URL}/setup`;

async function callAgent<T>(path: string, init?: RequestInit, timeoutMs = 3000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new PrintAgentNotRunningError();
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    throw Object.assign(new Error(body?.error || `Print agent error (HTTP ${res.status})`), { status: res.status });
  }
  return body as T;
}

export function getPrintAgentStatus(): Promise<PrintAgentStatus> {
  return callAgent<PrintAgentStatus>('/status');
}

export function printTsplViaAgent(tspl: string, copies = 1): Promise<{ ok: true; copies: number }> {
  return callAgent('/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tspl, copies }),
  }, 15000);
}

// ── Receipt printer (ESC/POS, e.g. Epson TM-m30III) — separate routes on the same agent ─────────
export interface ReceiptAgentStatus {
  ok: true;
  configured: boolean;
  printerName: string | null;
  online: boolean;
  statusText: string;
}

export interface ReceiptPrintResult {
  ok: true;
  jobId: string;
  // The agent can only vouch that the bytes reached the Windows print queue — never that paper came out.
  status: 'SENT_TO_SPOOLER';
  duplicate: boolean;
  copies: number;
}

// A running agent that predates the receipt printer answers /receipt/* with 404 - "needs updating",
// not "not running". Polling stops for it (react-query refetchInterval below) so it is not hammered.
export const isReceiptAgentOutdated = (err: unknown) => (err as { status?: number } | null)?.status === 404;
export const receiptStatusRefetchMs = (ms: number) => (q: { state: { error: unknown } }) => (isReceiptAgentOutdated(q.state.error) ? false : ms);

export function getReceiptPrinterStatus(): Promise<ReceiptAgentStatus> {
  // The agent asks Windows (PowerShell) for the printer state, which takes 2-5 s - well past callAgent's
  // 3 s default, which made a healthy agent look "not running".
  return callAgent<ReceiptAgentStatus>('/receipt/status', undefined, 15000);
}

export function printReceiptViaAgent(job: {
  jobId: string; widthDots: number; heightDots: number; data: string; copies?: number;
}): Promise<ReceiptPrintResult> {
  return callAgent<ReceiptPrintResult>('/receipt/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  }, 30000);
}

// Text-only test slip (init, text, feed, cut) — proves the receipt printer is wired up without an estimate.
export function printReceiptTest(): Promise<{ ok: true; status: 'SENT_TO_SPOOLER' }> {
  return callAgent('/receipt/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 30000);
}
