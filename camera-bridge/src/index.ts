import { Bridge } from './bridge';
import { CameraHub } from './camera/CameraHub';
import { createCameraProvider } from './camera/createProvider';
import { checkStation, CHECK_MESSAGES } from './check';
import { BridgeConfig, ConfigError, loadConfig } from './config';
import { mergedEnv } from './configFile';
import { resolveCredentialStore } from './credentials';
import { HttpCaptureTransport } from './capture/captureTransport';
import { HttpErpTransport } from './erpTransport';
import { InstanceLock, InstanceLockError } from './instanceLock';
import { createFileSink, createLogger, LogLevel, Logger, teeSink } from './logger';
import { configFilePath, lockFilePath, logFilePath } from './paths';
import { parseArgs, provision } from './provision';
import { BRIDGE_VERSION } from './version';

// Exit codes (a supervising wrapper restarts on anything but 0/2/3): 0 clean stop, 1 crash, 2 configuration or usage
// error (restarting cannot fix it), 3 another bridge already owns this station.
const EXIT_CONFIG = 2;
const EXIT_LOCKED = 3;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Reads the credential without echoing it when a person types it; reads stdin when it is piped. Never via argv. */
async function readSecret(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readStdin();
  process.stderr.write('Paste the station credential (input is hidden), then press Enter: ');
  return new Promise((resolve) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return resolve(buf); }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(1); }
        if (ch === '\b' || ch === '\u007f') buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function makeLogger(env: NodeJS.ProcessEnv, level: LogLevel = 'info'): Logger {
  // Under Task Scheduler there is no console, so production (or an explicit BRIDGE_LOG_FILE) also writes a rotated file.
  const toFile = env.NODE_ENV === 'production' || !!env.BRIDGE_LOG_FILE?.trim();
  const sink = toFile ? teeSink((l) => process.stdout.write(l + '\n'), createFileSink(logFilePath(env))) : undefined;
  return createLogger({ base: { app: 'trivo-camera-bridge' }, level, ...(sink ? { sink } : {}) });
}

function loadValidatedConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  return loadConfig(mergedEnv(configFilePath(env), env));
}

function transports(config: BridgeConfig) {
  return { erp: new HttpErpTransport({ apiUrl: config.apiUrl }), capture: new HttpCaptureTransport({ apiUrl: config.apiUrl }) };
}

async function runCheck(): Promise<number> {
  let config: BridgeConfig;
  try { config = loadValidatedConfig(process.env); } catch (e) { console.log(`Configuration invalid: ${e instanceof ConfigError ? e.message : 'unknown error'}`); return EXIT_CONFIG; }
  console.log(`Configuration OK — station ${config.stationId}, ERP host ${new URL(config.apiUrl).host}, camera provider ${config.cameraProvider}${config.production ? '' : ' (development mode)'}`);
  for (const w of config.warnings) console.log(`Warning: ${w}`);
  const store = resolveCredentialStore();
  const secret = await store.load().catch(() => null);
  if (!secret) { console.log('NOT_CONFIGURED — no station credential is stored. Run "provision".'); return 1; }
  console.log('Station credential is stored.');
  const t = transports(config);
  const result = await checkStation(config, secret, t.erp, t.capture);
  console.log(`${result} — ${CHECK_MESSAGES[result]}`);
  return result === 'OK' ? 0 : 1;
}

/** `cameras` — lists what camera discovery sees on this machine (no bridge needs to be running; nothing is captured). */
async function runCameras(): Promise<number> {
  let config: BridgeConfig;
  try { config = loadValidatedConfig(process.env); } catch (e) { console.log(`Configuration invalid: ${e instanceof ConfigError ? e.message : 'unknown error'}`); return EXIT_CONFIG; }
  const hub = createCameraProvider(config.cameraProvider, config.cameraOptions);
  if (!(hub instanceof CameraHub)) { console.log(`Camera provider "${config.cameraProvider}" is a single fixed camera; set CAMERA_PROVIDER=webcam or auto to discover cameras.`); return 1; }
  const l = await hub.listCameras();
  if (l.cameras.length === 0) console.log('No cameras found. Manual "Choose file" upload remains available in TRIVO.');
  for (const c of l.cameras) {
    console.log(`${c.selected ? '*' : ' '} ${c.id}  ${c.displayName}  [${c.kind}${c.placement ? `, ${c.placement}` : ''}]  ${c.available ? 'available' : `unavailable (${c.unavailableReason ?? 'unknown'})`}`);
  }
  if (l.selectionRequired) console.log('Several cameras are available and none is selected: run  select-camera <id>');
  return 0;
}

/** `select-camera <id|auto>` — asks the RUNNING bridge (loopback API) to use a camera; `auto` clears the explicit choice. */
async function runSelectCamera(arg: string | undefined): Promise<number> {
  if (!arg) { console.log('Usage: trivo-camera-bridge select-camera <camera id | auto>   (see: cameras)'); return EXIT_CONFIG; }
  let config: BridgeConfig;
  try { config = loadValidatedConfig(process.env); } catch (e) { console.log(`Configuration invalid: ${e instanceof ConfigError ? e.message : 'unknown error'}`); return EXIT_CONFIG; }
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/cameras/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: arg === 'auto' ? null : arg }), signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json() as { ok?: boolean; error?: string; selectedId?: string | null };
    if (!res.ok || !body.ok) { console.log(`Not selected: ${body.error ?? res.status}`); return 1; }
    console.log(body.selectedId ? `Selected ${body.selectedId}` : 'Automatic selection');
    return 0;
  } catch { console.log('Could not reach the bridge on this machine. Is it running?'); return 1; }
}

async function runBridge(): Promise<void> {
  const bootLog = makeLogger(process.env);
  let config: BridgeConfig;
  try { config = loadValidatedConfig(process.env); } catch (e) {
    bootLog.error('config.invalid', { reason: e instanceof ConfigError ? e.message : 'unknown' });
    process.exit(EXIT_CONFIG);
  }
  const log = makeLogger(process.env, config.logLevel);
  log.info('config.validated', {
    stationId: config.stationId, apiHost: new URL(config.apiUrl).host, provider: config.cameraProvider,
    mode: config.production ? 'production' : 'development', port: config.port, version: BRIDGE_VERSION,
  });
  for (const code of config.warnings) log.warn('config.warning', { code });

  const lock = new InstanceLock(lockFilePath());
  try { lock.acquire(); } catch (e) {
    log.error('process.instance_lock', { reason: e instanceof InstanceLockError ? e.message : 'unknown' });
    process.exit(EXIT_LOCKED);
  }
  process.on('exit', () => lock.release());

  const t = transports(config);
  const bridge = new Bridge({
    config, provider: createCameraProvider(config.cameraProvider, config.cameraOptions, { log }),
    credentials: resolveCredentialStore(), transport: t.erp, captureTransport: t.capture, log,
  });
  log.info('process.start', { version: BRIDGE_VERSION, pid: process.pid });

  let stopping = false;
  const shutdown = (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('process.signal', { signal });
    // stop() is internally bounded; this is the backstop for a provider call that never returns.
    const hard = setTimeout(() => { log.error('process.shutdown_forced'); lock.release(); process.exit(1); }, 30_000);
    bridge.stop().finally(() => { clearTimeout(hard); lock.release(); process.exit(code); });
  };
  // SIGBREAK / SIGHUP are how a Windows console reports Ctrl+Break / window close. A Task Scheduler "End" is a hard kill with
  // no signal at all — the crash-safety rules (README) are what cover that case.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(s, () => shutdown(s));
  for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(ev, (err) => { log.error('process.fatal', { event: ev, name: err instanceof Error ? err.name : 'unknown' }); shutdown(ev, 1); });
  }

  await bridge.start();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'provision') {
    const store = resolveCredentialStore();
    if (store.kind !== 'dpapi') { console.log('Provisioning needs the Windows credential store (unset TRIVO_STATION_SECRET_DEV).'); process.exit(EXIT_CONFIG); }
    const code = await provision(parseArgs(process.argv.slice(3)), {
      store, configFile: configFilePath(), readSecret, out: (l) => console.log(l),
      verify: async (values, secret) => {
        const cfg = loadConfig({ ...values, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
        const t = transports(cfg);
        return checkStation(cfg, secret, t.erp, t.capture);
      },
    });
    process.exit(code);
  }
  // `set-credential` < secret.txt — replaces only the credential (e.g. after the ERP issued a new one).
  if (cmd === 'set-credential') {
    const log = createLogger({ base: { app: 'trivo-camera-bridge' } });
    const store = resolveCredentialStore();
    if (store.kind !== 'dpapi') { log.error('credential.set_unsupported'); process.exit(EXIT_CONFIG); }
    const secret = await readSecret();
    if (!secret) { log.error('credential.set_empty'); process.exit(EXIT_CONFIG); }
    await store.save(secret);
    log.info('credential.stored', { store: store.kind });
    return;
  }
  if (cmd === 'check') process.exit(await runCheck());
  if (cmd === 'cameras') process.exit(await runCameras());
  if (cmd === 'select-camera') process.exit(await runSelectCamera(process.argv[3]));
  if (cmd && cmd !== 'run') { console.log('Usage: trivo-camera-bridge [run | provision | set-credential | check | cameras | select-camera <id|auto>]'); process.exit(EXIT_CONFIG); }
  await runBridge();
}

main().catch(() => {
  // Deliberately no error body: it could contain request data.
  process.stderr.write('{"level":"error","event":"process.fatal"}\n');
  process.exit(1);
});
