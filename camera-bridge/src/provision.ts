import { loadConfig, ConfigError } from './config';
import { CHECK_MESSAGES, StationCheck } from './check';
import { writeConfigFile } from './configFile';
import { CredentialStore } from './credentials';

// First-install provisioning. The station credential is accepted here ONCE (hidden prompt or stdin), stored in the
// credential store, and never echoed, logged, written to the settings file or shown again — the bridge has no command that
// prints it. A credential is issued in the ERP by a user holding photography:manage_stations; its plaintext is shown
// there exactly once.
/** `--dev` without `--api-url`: the ERP's own default API port (server PORT=3001, which is also the Vite dev proxy target), so a developer need not copy it. */
export const DEV_API_URL = 'http://localhost:3001';
export const CREDENTIAL_SHAPE = /^stn_[A-Za-z0-9]{8,40}\.[A-Za-z0-9_-]{32,128}$/;

export const PROVISION_BANNER = [
  'TRIVO Camera Bridge — station provisioning',
  '  You need a NEW station credential, issued in the ERP by an authorized user.',
  '  Credentials issued before remote capture existed (heartbeat-only) are not enough: the station:capture scope is required,',
  '  so such a station must be issued a fresh credential. The credential is shown by the ERP only once.',
].join('\n');

export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ConfigError(`Unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

export interface ProvisionDeps {
  store: CredentialStore;
  configFile: string;
  /** Returns the credential typed/piped by the operator. */
  readSecret(): Promise<string>;
  /** Verifies the stored credential against the ERP; omit to skip (offline install). */
  verify?(values: Record<string, string>, secret: string): Promise<StationCheck>;
  out(line: string): void;
}

/** Returns the process exit code: 0 stored (and verified, or unverifiable offline), 1 stored but the ERP refused it, 2 bad input. */
export async function provision(args: Record<string, string | true>, d: ProvisionDeps): Promise<number> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  const known = new Set(['api-url', 'station-id', 'provider', 'port', 'dev', 'skip-verify']);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  const values: Record<string, string> = { TRIVO_API_URL: str('api-url') ?? (args.dev ? DEV_API_URL : ''), STATION_ID: str('station-id') ?? '', CAMERA_PROVIDER: str('provider') ?? 'mock' };
  if (str('port')) values.BRIDGE_PORT = str('port')!;
  try {
    if (unknown.length) throw new ConfigError(`Unknown option --${unknown[0]}`);
    // Validated exactly as the running bridge will validate it (production rules unless --dev).
    loadConfig({ ...values, ...(args.dev ? {} : { NODE_ENV: 'production' }) } as NodeJS.ProcessEnv);
  } catch (e) {
    d.out(`Invalid configuration: ${e instanceof ConfigError ? e.message : 'unknown error'}`);
    d.out('Usage: provision --api-url https://erp.example.com (optional with --dev: http://localhost:3001) --station-id <STATION_ID> [--provider mock|sony|webcam|auto] [--port 9102] [--dev]');
    return 2;
  }
  d.out(PROVISION_BANNER);
  const secret = (await d.readSecret()).trim();
  if (!secret) { d.out('No credential received; nothing was changed.'); return 2; }
  if (!CREDENTIAL_SHAPE.test(secret)) { d.out('That does not look like a TRIVO station credential; nothing was changed.'); return 2; }

  const replacing = await d.store.load().then((s) => !!s, () => false);
  await d.store.save(secret);
  writeConfigFile(d.configFile, values);
  d.out(`${replacing ? 'Replaced the stored' : 'Stored the'} station credential (protected for this Windows user). It will not be displayed again.`);
  d.out('Settings saved (no secrets in the file).');

  if (!d.verify || args['skip-verify']) { d.out('Not verified against the ERP. Run "check" when the station is online.'); return 0; }
  const result = await d.verify(values, secret);
  d.out(`Verification: ${result} — ${CHECK_MESSAGES[result]}`);
  return result === 'OK' || result === 'ERP_UNREACHABLE' ? 0 : 1;
}
