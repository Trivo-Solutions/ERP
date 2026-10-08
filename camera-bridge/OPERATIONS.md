# Operations — deploying the Camera Bridge to a photography workstation (Phase 5E)

The bridge runs with `CAMERA_PROVIDER=mock` today (the Sony driver needs the station prerequisites in docs/SONY_HELPER_PROTOCOL.md). Everything here is hardware-independent.

## 1. Provisioning a station (first install)

1. **In the ERP**, a user with `photography:manage_stations` issues a station credential
   (`POST /photography/stations/:stationId/credentials`). The plaintext is shown **once**.
   A station that still holds a credential from before remote capture existed (heartbeat-only) **must be issued a new one**:
   the `station:capture` scope is required, and the bridge reports `captureScope: REJECTED` until it has it.
2. On the workstation, as the Windows user who will run the bridge: `npm ci && npm run build`.
3. `node dist/index.js provision --api-url https://erp.example.com --station-id MANIKONDA-PHOTO-01 [--provider mock]`
   - validates the settings exactly as the running bridge will (production rules);
   - asks for the credential with a **hidden prompt** (or reads stdin: `... provision ... < secret.txt`) — never argv;
   - rejects anything not shaped like a station credential, stores it with DPAPI, writes the **non-secret** settings to
     `%LOCALAPPDATA%\TrivoCameraBridge\bridge.config.json`, then verifies against the ERP and prints one normalized result:
     `OK`, `CREDENTIAL_REJECTED`, `CAPTURE_SCOPE_MISSING`, `STATION_ID_MISMATCH`, `ERP_UNREACHABLE`;
   - never prints the credential back, and the bridge has no command that can. A lost credential means issuing a new one.
   - `--dev` relaxes the production rules for a localhost http server.
4. `powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1`, then `node dist/index.js check`.

Re-provisioning (new credential, moved station) is the same command. `set-credential < secret.txt` replaces only the credential.

## 2. Configuration

Non-secret settings come from `%LOCALAPPDATA%\TrivoCameraBridge\bridge.config.json` (or `BRIDGE_CONFIG`), **overridden by the
environment**; both use the same names. The file may not contain anything secret-like (`secret/token/password/credential/…`) or any
unknown key — either stops the bridge at startup. Nothing falls back silently.

| Name | Default | |
|---|---|---|
| `TRIVO_API_URL` | required | https. `http://localhost` is dev-only; in production it also needs `TRIVO_ALLOW_LOCALHOST_HTTP=1`. No userinfo/query |
| `STATION_ID` | required | `[A-Za-z0-9_-]{1,64}`; company and branch are resolved **server-side** |
| `CAMERA_PROVIDER` | `mock` in dev | **required in production**: `mock` \| `sony` \| `webcam` \| `auto` (`webcam` = Windows laptop/USB cameras via `trivo-webcam-helper.exe`; `auto` = webcam + Sony listed). `mock` in production starts but logs `config.warning MOCK_CAMERA_IN_PRODUCTION` (it produces fake images) |
| `CAMERA_OPT_<NAME>` | — | provider-specific, validated by the provider (`sony`: `MODEL`, `DEVICE_ID`, `CONNECTION`=usb\|network, `HELPER_PATH`=absolute path of the native helper; default `<bridge>/native/sony/trivo-sony-helper.exe`). `webcam`/`auto`: `HELPER_PATH` = the webcam helper (default `<bridge>/native/webcam/trivo-webcam-helper.exe`), `auto` also `SONY_HELPER_PATH`. An option the provider does not declare is an error |
| `BRIDGE_PORT` | 9102 | loopback only |
| `BRIDGE_TEMP_DIR`, `BRIDGE_TEMP_MAX_MB` | `%LOCALAPPDATA%\TrivoCameraBridge\tmp`, 200 | |
| `CAPTURE_TIMEOUT_MS` | 15000 | 1000–120000 |
| `LOG_LEVEL` | info | debug\|info\|warn\|error |
| `BRIDGE_LOG_FILE` | `…\TrivoCameraBridge\logs\bridge.log` | file logging is on in production (rotated, 5 MB × 3) or whenever this is set |
| `NODE_ENV=production` | | set by `run-bridge.cmd`; enables the stricter rules above |

## 3. Credential handling

Never in source, env, argv, logs or the settings file. Production store: Windows DPAPI (CurrentUser) through `powershell.exe`
(secret on stdin) in `%LOCALAPPDATA%\TrivoCameraBridge\station.cred`. **DPAPI CurrentUser binds it to the Windows account that stored
it** — provision as the account that will run the bridge (which is why startup is a per-user logon task). Dev only:
`TRIVO_STATION_SECRET_DEV` (ignored when `NODE_ENV=production`). A revoked, expired or re-scoped credential stops the heartbeat and
the command channel: store a new one and restart the task.

## 4. Windows startup

**Chosen: a Task Scheduler logon task** (`scripts\install-task.ps1`, `uninstall-task.ps1`) running `scripts\run-bridge.cmd`.

- No new software and no custom service code. A Windows Service would need a wrapper (NSSM/WinSW) and would run as a different
  account that cannot decrypt the user's DPAPI credential. The task runs as the station user, at logon, with no time limit,
  `IgnoreNew` (never two tasks) and restart-on-failure.
- `run-bridge.cmd` sets `NODE_ENV=production` and restarts the process after a **crash** (exit 1, 10 s pause). It does not restart
  after a clean stop (0), a configuration error (2) or "another instance is running" (3) — restarting cannot fix those.
- A **single-instance lock** (`bridge.lock`, pid-based; a stale lock from a crash is taken over) stops a second bridge polling the
  same station: two pollers could release the shutter twice.
- To run with nobody logged on: register `run-bridge.cmd` as an *at startup* task under a dedicated account and `provision` as it.
- Logs: `%LOCALAPPDATA%\TrivoCameraBridge\logs\bridge.log` (and `launcher.log` for restarts).

## 5. Lifecycle and shutdown

`SIGINT`, `SIGTERM`, `SIGBREAK`, `SIGHUP` (Ctrl+C, Ctrl+Break, console close) and fatal errors run an orderly, **bounded** stop
(10 s for the in-flight command, 30 s process backstop):

1. heartbeat stops; the command long-poll is aborted; a command that arrives now is refused *before anything is reported*, so the
   ERP still holds it `QUEUED` for the next start;
2. a command already in flight finishes its **current step** — it will not release the shutter once shutdown began, and upload
   retries stop;
3. camera released, local API closed, expired temp images swept, lock released.

A command still running at the deadline is abandoned and logged (`bridge.shutdown_timeout`); this bridge never retries it.
`Stop-ScheduledTask` or killing the process is a hard kill with no signal: that is the crash case below, and it is safe.

## 6. Crash and restart

No second recovery database: the ERP's command state machine and the upload idempotency key are the mechanism. The ERP re-delivers
a command **only while it is `QUEUED`**; a command the bridge acknowledged (`ACCEPTED`) is never offered again.

| Interrupted | Result |
|---|---|
| before `ACCEPTED` was acknowledged | still `QUEUED` → delivered again → runs once. Nothing was captured |
| after `ACCEPTED`, during capture | never re-delivered, so never captured twice; it expires after 180 s and the user retries. A photo taken but not uploaded is lost |
| during upload | retries *within* the process reuse one `idempotencyKey`. After a *crash* the ticket (never written to disk) is gone, so the leftover image cannot be uploaded; it is swept after the retention window. A durable offline queue is a later phase |
| after a successful upload | the ERP has the image and the command is `UPLOADED`; a re-delivery is refused (`COMMAND_STATE`). Replaying an upload with the same key returns the existing image (200), never a second one |

## 7. Temp files

One directory (`BRIDGE_TEMP_DIR`), generated names only (`cap-<uuid>.png|jpg|json`), no ticket on disk. Deleted on confirmed upload and
when the ERP refuses the bytes; a recoverable failure keeps the image for at most one hour. The sweep runs at start, every 5 minutes
and at stop; it only ever touches files matching the generated pattern inside that directory, and the directory is capped at
`BRIDGE_TEMP_MAX_MB` (oldest images evicted first; an image bigger than the cap is refused). Cleanup failures are logged by file
name only. There is no permanent local archive.

## 8. Diagnostics

`GET http://127.0.0.1:9102/status` (also `/health`, `/camera/status`; GET only, Host-header checked, no CORS) reports separately:
`bridge` (RUNNING|STOPPING|STOPPED, version, mode), `station` (id, status, `captureScope`), `erp` (`connectivity`,
`lastHeartbeatSuccessAt`), `camera` (state, `provider`), `heartbeat`, `capture` (channel state, `current` = command id + phase,
`lastResult`) and `lastError` (a normalized category). Never the credential, a ticket, a JWT, a storage URL/key, image bytes or a path.
`node dist/index.js check` verifies the stored credential against the ERP from the command line.

## 9. Camera provider boundary

`src/camera/types.ts` is all a real camera implementation needs and gets: `connect`, `disconnect`, `getStatus`, `capture(request)`;
errors `NOT_CONNECTED`, `BUSY`, `CONNECT_FAILED`, `CAPTURE_FAILED`, `CAPTURE_TIMEOUT`; `request.timeoutMs` carries the capture budget (the
bridge enforces it too, and keeps the camera `BUSY` until the provider really returns). A provider never sees users, companies, tags,
credentials, storage or the command queue. Provider settings arrive only as the validated `CAMERA_OPT_*` string map.

## 10. Logging

JSON lines; key-based redaction is a backstop. Events: `config.validated`, `config.warning`, `station.credential_present|missing`,
`erp.connectivity`, `heartbeat.*`, `command.accepted`, `capture.start|end|failed|result`, `upload.started|completed|attempt_failed`,
`camera.state`, `temp.expired|evicted|cleanup_failed`, `bridge.starting|started|stopping|stopped|shutdown_timeout`. Errors are
normalized categories, never stack traces or response bodies.

## 11. Not in this phase

durable offline image queue · ticket renewal · cloud messaging · second storage · local photo archive.

## Setting up a Windows webcam station (Phase 5G)
1. Build the helper once on a machine with MSVC Build Tools: `powershell -ExecutionPolicy Bypass -File scripts\build-webcam.ps1 -Install` (copies only `trivo-webcam-helper.exe` to `native\webcam\`). No SDK is needed.
2. Allow desktop apps to use the camera (*Settings → Privacy & security → Camera*). Set `CAMERA_PROVIDER=webcam` (or `auto`).
3. `node dist\index.js cameras` lists what discovery sees (nothing is captured). One usable camera is used automatically; with several, run `node dist\index.js select-camera <id>` against the running bridge
   (`select-camera auto` returns to automatic). The choice is remembered in `camera-selection.json` and survives restarts.
4. Status for the person at the counter is the existing `GET /camera/status`; the camera list is `GET /cameras`. A missing helper, a missing camera or a blocked privacy setting appear as neutral states, never as driver text.
