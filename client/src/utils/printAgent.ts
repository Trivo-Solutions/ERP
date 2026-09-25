// Talks to the local print agent (printer-agent/) running on this counter PC's own machine —
// never the main API server, which has no route to a USB-attached printer. Loopback-only by
// design (see printer-agent/README.md), so this is always a same-machine call regardless of
// where the web app itself is served from.
const DEFAULT_AGENT_URL = 'http://127.0.0.1:9101';

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
    throw new Error('Print agent not running on this PC. Start it (see printer-agent/README.md) and try again.');
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
