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
    throw new Error(body?.error || `Print agent error (HTTP ${res.status})`);
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
