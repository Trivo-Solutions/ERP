import fs from 'fs';
import path from 'path';

// Structured (one JSON object per line) logger with key-based redaction. Callers should never pass secrets, but
// redaction is a backstop: any field whose NAME suggests a secret, ticket, URL, storage key or image payload is
// replaced before it can reach the sink.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const SENSITIVE_KEY = /secret|token|authorization|credential|password|ticket|signed|url|storagekey|^data$|buffer|image(data|bytes)?$/i;
const MAX_DEPTH = 4;
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }; // never the stack
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[REDACTED:binary]';
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { sink?: LogSink; base?: Record<string, unknown>; level?: LogLevel } = {}): Logger {
  const sink = opts.sink ?? ((l) => process.stdout.write(l + '\n'));
  const min = RANK[opts.level ?? 'info'];
  const emit = (level: LogLevel) => (event: string, fields: Record<string, unknown> = {}) => {
    if (RANK[level] < min) return;
    const rec = { ts: new Date().toISOString(), level, event, ...(redact({ ...opts.base, ...fields }) as object) };
    sink(JSON.stringify(rec));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/**
 * Appends lines to a size-capped log file (bridge.log -> .1 -> .2 ...). A Windows scheduled task has no console, so this
 * is the only place an operator can read what happened. Logging must never take the bridge down: every failure is swallowed.
 */
export function createFileSink(file: string, opts: { maxBytes?: number; keep?: number } = {}): LogSink {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  let size = 0;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); size = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { /* retried on write */ }
  const rotate = () => {
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* absent */ } }
    try { fs.renameSync(file, `${file}.1`); } catch { /* absent */ }
    size = 0;
  };
  return (line) => {
    try {
      if (size + line.length + 1 > maxBytes) rotate();
      fs.appendFileSync(file, line + '\n');
      size += line.length + 1;
    } catch { /* never fatal */ }
  };
}

export function teeSink(...sinks: LogSink[]): LogSink {
  return (l) => { for (const s of sinks) s(l); };
}
