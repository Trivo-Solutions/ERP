# TRIVO Camera Bridge (Windows)

Runs on a photography station (e.g. `MANIKONDA-PHOTO-01`), owns the camera, and reports status to TRIVO.
Sibling of `printer-agent/` (standalone package, not an npm workspace). **Phase 5A ships the architecture and a
mock camera only — no Sony code, no real hardware.**

```
TRIVO ERP <-- ErpTransport --> Bridge --> CameraController --> CameraProvider
                                                                 |- MockCameraProvider  (done)
                                                                 |- SonyCameraProvider   (Phase 5F; real SDK adapter not built)
                                                                 '- CameraHub (Phase 5G)  --> WebcamCameraProvider (Windows laptop / USB webcams)
                                                                                         '-> SonyCameraProvider (listed; unavailable without its SDK)
```

## Operating it (Phase 5E)
Provisioning, configuration (settings file + env), credential handling, Windows startup, shutdown, crash/restart behaviour, temp files,
diagnostics and the camera-provider boundary are in **[OPERATIONS.md](OPERATIONS.md)**. In short: `provision` once, `scripts\install-task.ps1`,
`check` any time; `CAMERA_PROVIDER` must be explicit in production; the local API is loopback-only `GET /health|/status|/camera/status`.

## Transport (Phase 5C)
`HttpErpTransport` POSTs `/api/v1/photography/stations/heartbeat` with `Authorization: Bearer <station credential>` (from
the credential store; never an ERP user/JWT). It adapts `cameraState`->`cameraStatus`, `timestamp`->`clientTimestamp`;
`stationId` is only an echo. TLS verification is Node's default (never disabled), no redirects are followed, https is
required except localhost. Mapping: 2xx ok; 401/403 AUTH (stop); 400/404/409/3xx REJECTED (config fault, stop);
408/429/5xx SERVER and network/TLS/timeout NETWORK (retry with backoff).

## Camera discovery & selection (Phase 5G)
`CAMERA_PROVIDER=webcam` (Windows cameras) or `auto` (Windows cameras + Sony, which is listed but *unavailable* without its SDK) builds a **`CameraHub`**: a discovery/selection
layer *around* the unchanged neutral `CameraProvider` contract. Sources (`CameraSource`) report neutral `CameraInfo` — `id` (`<kind>:<stable id>`), `displayName`, `kind`
(`webcam`|`sony`|`mock`), `available`, `selected`, `placement` (only when the camera's own name says "integrated"), `capabilities` — and the hub delegates every provider call to a provider bound
to the one selected camera. No vendor/SDK/driver text ever leaves the bridge.

| Situation | Behaviour |
|---|---|
| exactly one usable camera, no choice made | used automatically |
| several usable cameras, no choice made | **none is picked**: status `DISCONNECTED / CONFIG_ERROR`, capture refuses, `selectionRequired:true`; a person must choose |
| a camera was chosen | always wins; remembered in `%LOCALAPPDATA%\TrivoCameraBridge\camera-selection.json` (id + display name only) |
| the chosen camera disappears | `ERROR / NOT_CONNECTED`; **no automatic switch to another camera and no shutter**; choose another (listed with `selected:true, available:false`) |
| no camera at all | `DISCONNECTED / NOT_CONNECTED` — *not* an ERP fault; the ERP's manual "Take photo / Choose file" workflow is untouched |
| helper not installed | one unavailable entry (`DRIVER_UNAVAILABLE`); nothing crashes |

Local API (loopback): `GET /cameras` lists cameras; `POST /cameras/select` with `{"id":"webcam:cam-…"}` (or `{"id":null}` for automatic) chooses one — refused while a capture is running.
It takes only an id, requires `Content-Type: application/json` and **no `Origin` header** (so a web page cannot drive it), and is bounded to 1 KiB. CLI: `cameras` (list) and
`select-camera <id|auto>` (talks to the running bridge). Windows webcams use `trivo-webcam-helper.exe` — protocol and security contract in **[docs/WEBCAM_HELPER_PROTOCOL.md](docs/WEBCAM_HELPER_PROTOCOL.md)**, built by `scriptsuild-webcam.ps1`.

**ERP Photography page (station camera):** the browser never talks to this local API. The bridge **reports** its camera list (id, name, available, selected — nothing else) in the authenticated
heartbeat; the Capture page shows it, and a camera chosen there is relayed by the ERP back to the bridge (heartbeat answer / command poll), which re-validates it and selects through the same
`select` as above. A camera that disappears is shown as disconnected and is never replaced by another. A browser/mobile camera is a *browser-side* source and the ERP page's existing "Take photo" (phone camera via `capture=`) and "Choose file" remain that path — the bridge never talks to a phone.

## Sony (Phase 5F)
`CAMERA_PROVIDER=sony` -> `SonyCameraProvider` (lifecycle, deterministic camera selection, error normalization, one-shutter rule) over a `SonyBackend`.
The real backend, `HelperSonyBackend`, drives a small native helper process that links Sony's Camera Remote SDK 2.02.00 (JSON-lines over stdio). The SDK and
helper are an operator-installed **station prerequisite** (licence forbids committing/separating the SDK) and are loaded only when `sony` is selected;
`mock` and the test suite never need them. Without the helper the bridge starts normally and the camera reports `ERROR / DRIVER_UNAVAILABLE`.
Options: `CAMERA_OPT_DEVICE_ID` (pick one body when several are attached — otherwise `CONFIG_ERROR`), `MODEL`, `CONNECTION`, `HELPER_PATH`. Output is JPEG as
produced by the camera. See `docs/SONY_HELPER_PROTOCOL.md` for SDK/licence findings and the helper contract.

## Dev
`npm install`, `npm test`, `npm run typecheck`, `npm run build`, `npm start` (needs env above).

**Local ERP + a laptop webcam, no copying of ports:** start the ERP as usual (`npm run dev` in the repo root; API on `:3001`). In the ERP (as a user with `photography:manage_stations`) issue a
credential for a station, then `node dist/index.js provision --dev --provider webcam --station-id <STATION_ID>` — with `--dev` the API URL defaults to `http://localhost:3001` (the ERP's own
default port), the credential is read from a hidden prompt/stdin. Then `node dist/index.js run`. The Capture page shows the camera once the first heartbeat arrives (~30 s at most).

## Remote capture (Phase 5D) — ERP → bridge → camera → existing upload endpoint
```
user (capture session, ticket) -> POST /photography/capture-commands -> command row (QUEUED)
bridge: GET /photography/stations/commands/next  (HTTPS long-poll, station credential)  -> command + command-bound ticket
bridge: POST .../commands/:id/status ACCEPTED -> CAPTURING   (the camera does not move before the ERP has acknowledged)
bridge: CameraController.capture() (one at a time, own timeout) -> temp file -> POST /photography/images (the SAME endpoint)
ERP: validates ticket+command -> TagImage -> processing -> command UPLOADED   | bridge/ERP: FAILED(code) | EXPIRED
```
- **Identities stay separate.** StationCredential = *which bridge* (Authorization header only). Capture ticket = *which user,
  tag, station, operation*; the one delivered to the bridge is minted per command (`cmd` claim) and is useless for any other
  command, tag, station or user. A credential alone authorizes no tag. The bridge never receives a password, company secret,
  storage or database credential, and sends no `companyId`/`branchId`/`userId`/`stationId`/storage key on upload.
- **Four ids, never merged:** `commandId` (no duplicate execution), `correlationId` (tracing), `idempotencyKey` (no duplicate
  image; generated once per image, reused by every retry, fresh for the next image), ticket (authorization).
- **Idempotent commands.** Same `commandId` + same payload = the same in-flight/finished operation (no second shutter, no second
  upload); same id with a different payload is `COMMAND_REJECTED`. One command at a time; a busy camera answers `BUSY`; no
  command queue exists on either side (the ERP allows one live command per station).
- **Results** (normalized; no stack traces): `SUCCESS BUSY CAMERA_ERROR AUTH_ERROR UPLOAD_ERROR NETWORK_ERROR COMMAND_REJECTED
  EXPIRED`, plus a finer `detail` (e.g. `CAPTURE_TIMEOUT` ≠ `UPLOAD_TIMEOUT`: a slow camera is never a network error).
- **Temp images** live only in `BRIDGE_TEMP_DIR` (default `%LOCALAPPDATA%\TrivoCameraBridge\tmp`), generated names only, no ticket
  on disk. Deleted on confirmed upload and when the ERP refuses the bytes; kept after a *recoverable* failure (network, ERP error,
  auth, expiry) for at most one hour, then swept (logged as `temp.expired`). No durable offline queue yet — `CaptureExecutor.upload()` is the seam.
- **Credential scope.** Capture needs `station:capture`. Credentials issued before Phase 5D carry heartbeat only: the command
  channel reports `AUTH_FAILED` until the station credential is re-issued and stored again.
- Local API is unchanged (loopback, GET only). `CAMERA_PROVIDER=mock` remains the default; `sony` is still "driver unavailable".
