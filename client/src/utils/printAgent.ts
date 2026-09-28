// Talks to the local print agent (printer-agent/) running on this counter PC's own machine —
// never the main API server, which has no route to a USB-attached printer. Loopback-only by
// design (see printer-agent/README.md), so this is always a same-machine call regardless of
// where the web app itself is served from.
const DEFAULT_AGENT_URL = 'http://127.0.0.1:9101';

// Served by client/nginx.conf straight from client/public/downloads (built by client/Dockerfile
// via printer-agent's `npm run package`) — a same-origin download, no git/USB drive needed.
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
  printerName: string;
  online: boolean;
  statusText: string;
}

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
