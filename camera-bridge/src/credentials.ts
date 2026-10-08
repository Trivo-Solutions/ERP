import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The station secret is never in source, git, argv, logs or a plain config file. Production storage is Windows
// DPAPI (CurrentUser scope), driven through the built-in powershell.exe — no new dependency and no home-made
// cryptography. The secret goes to PowerShell on STDIN, never on the command line.
export interface CredentialStore {
  /** The station secret, or null when none is stored. */
  load(): Promise<string | null>;
  save(secret: string): Promise<void>;
  readonly kind: 'dpapi' | 'dev-env';
}

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TrivoCameraBridge');

const PS_PROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd().Trim();" +
  "$b=[Text.Encoding]::UTF8.GetBytes($s);" +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd().Trim();" +
  "$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser');" +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))";

function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    // stderr is deliberately discarded: it could echo input. Callers get a generic error.
    p.on('error', () => reject(new Error('Credential store unavailable')));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('Credential store operation failed'))));
    p.stdin.end(stdin);
  });
}

export class DpapiCredentialStore implements CredentialStore {
  readonly kind = 'dpapi' as const;
  constructor(private readonly file = path.join(DIR, 'station.cred')) {}

  async load(): Promise<string | null> {
    let blob: string;
    try { blob = fs.readFileSync(this.file, 'utf8').trim(); } catch { return null; }
    if (!blob) return null;
    return (await runPowerShell(PS_UNPROTECT, blob)) || null;
  }

  async save(secret: string): Promise<void> {
    if (!secret.trim()) throw new Error('Secret is empty');
    const blob = await runPowerShell(PS_PROTECT, secret);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** DEVELOPMENT ONLY. Reads the secret from the process environment; refused when NODE_ENV=production. */
export class DevEnvCredentialStore implements CredentialStore {
  readonly kind = 'dev-env' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async load(): Promise<string | null> {
    if (this.env.NODE_ENV === 'production') throw new Error('The dev-env credential store is disabled in production');
    return this.env.TRIVO_STATION_SECRET_DEV?.trim() || null;
  }
  async save(): Promise<void> {
    throw new Error('The dev-env credential store is read-only');
  }
}

export function resolveCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  if (env.NODE_ENV !== 'production' && env.TRIVO_STATION_SECRET_DEV) return new DevEnvCredentialStore(env);
  return new DpapiCredentialStore();
}
