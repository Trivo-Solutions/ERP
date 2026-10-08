# Sony camera provider — SDK findings and native helper contract (Phase 5F)

## SDK and licence (verified 2026-10-08 against Sony's official pages)
- **Camera Remote SDK 2.02.00**, released 2026-06-10. Windows download `CrSDK_v2.02.00_20260610a_Win64.zip` (~213 MB), behind a click-through licence at
  <https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en-US.html>; overview <https://support.d-imaging.sony.co.jp/app/sdk/en/index.html>.
- **Platform:** Windows 11, Intel/AMD x64 only (**not ARM**). **Cameras:** the supported list includes **ILCE-7RM5** (Sony's page does not itself say "A7R V";
  that mapping is the usual model-name convention). The camera must run current system software. The deployment's actual body/firmware must be checked against the SDK's own README.
- **Redistribution (summary of the agreement, not legal advice):** the library may be included only **in binary form, incorporated "in an inseparable way" into our
  application**; individual components may not be separated, and the SDK may not be shared/sublicensed/resold on its own. Obligations: obtain end-user consent that
  controlling a camera this way voids the camera warranty; do not imply Sony authored our app; provide our own support; keep Sony notices intact; indemnify Sony;
  no reverse engineering; export/military-use restrictions. Open-source components inside the SDK carry their own notices (oss.sony.net).
- **Not stated by the pages read:** the exact runtime DLL list (the SDK's own README/`app` sample lists it — historically `Cr_Core.dll` plus `CrAdapter/` DLLs),
  and whether commercial use needs separate terms. **Counsel must review the agreement before any SDK binary ships inside a TRIVO installer.**
- **Decision:** the SDK is **never committed**. The helper `trivo-sony-helper.exe` (built by us against the SDK) and the SDK DLLs are a **station prerequisite**
  installed by the operator, in `<bridge>/native/sony/` (gitignored) or wherever `CAMERA_OPT_HELPER_PATH` points. Bundling is a later, legal-review-gated step.

## Why a helper process (not an addon)
The SDK is C++ with callbacks, its own threads and DLL-relative loading. A separate process isolates crashes (a SDK fault cannot take down the bridge or its
temp store), makes "abandon a hung shutter" a `kill`, needs no node-gyp/Electron ABI matching, and keeps the SDK out of Node's address space. It talks only to
the camera: no ERP URL, token, ticket, company, tag or storage — it is spawned with an empty environment and a single `--out-dir <dir>` argument.

## Protocol v1 (UTF-8, one JSON object per line, helper stdin/stdout; stderr is discarded)
Helper -> bridge on start: `{"event":"ready","protocol":1}` (within 10 s, else DRIVER_UNAVAILABLE). One request in flight at a time.

| Request | Success reply | Notes |
|---|---|---|
| `{"id":1,"op":"list"}` | `{"id":1,"ok":true,"devices":[{"id":"<stable camera id/serial>","model":"ILCE-7RM5","connection":"usb"\|"network"}]}` | initialise SDK + enumerate. `id` must be stable, never an index. ≤32 devices |
| `{"id":2,"op":"connect","deviceId":"<id>"}` | `{"id":2,"ok":true}` | open exactly that device |
| `{"id":3,"op":"shoot","file":"shot-<uuid>.jpg"}` | `{"id":3,"ok":true,"file":"shot-<uuid>.jpg","width":W,"height":H}` | **release the shutter once**, write a **JPEG** to `<out-dir>/<file>` (name chosen by the bridge; echo it back; never write elsewhere). No retry, ever |
| `{"id":4,"op":"close"}` | `{"id":4,"ok":true}` then exit | release session |

Failure: `{"id":n,"ok":false,"failure":"<code>"}` with code one of `DRIVER_UNAVAILABLE NO_CAMERA_FOUND MULTIPLE_CAMERAS CONNECT_REJECTED CAMERA_BUSY DEVICE_LOST SHUTTER_FAILED TRANSFER_FAILED TIMEOUT PROTOCOL_ERROR`.
Anything else (free text, SDK error numbers) is treated as a protocol violation and **never forwarded**. Unsolicited: `{"event":"disconnected"}` when the camera goes away.

Bridge-side guarantees (tested with `test/fixtures/fakeSonyHelper.js`): the reply id must match; the reply file must equal the requested name; the file must be a
regular JPEG (`FF D8 FF`) ≤120 MB with sane dimensions, is read then deleted; invalid JSON / oversize line / wrong id / bad ready ⇒ helper killed; a shoot that
exceeds `timeoutMs` ⇒ helper **killed** (so an abandoned operation can never finish later and produce a second photo) and the next capture starts a fresh helper;
leftover `shot-*.jpg` in the out dir are swept at helper start.

## Clarifications (Phase 5F-B — these bind the native helper; the Node side already behaves this way)
1. **No `status` op in v1.** The `ready` event is the handshake and carries the version; `list` is the liveness/enumeration probe; device loss is reported by
   the unsolicited `disconnected` event or a `DEVICE_LOST` failure. Adding `status` would be a protocol v2 change (Node + helper together).
2. **Names.** The spec ops are `list / connect / shoot / close` (not `status / capture / disconnect`).
3. **Request shape (strict).** One flat JSON object per line, ≤ 64 KiB, UTF-8/ASCII, no nesting, no duplicate keys. `id` is an integer 1..2147483647. Each op accepts
   exactly its listed keys and no others (`list`/`close`: `id`,`op`; `connect`: + `deviceId`; `shoot`: + `file`). An unparsable line, an unknown/extra key, a bad id,
   an unknown op or an op out of sequence is answered `{"id":<n or 0>,"ok":false,"failure":"PROTOCOL_ERROR"}`; the helper keeps running (it never crashes on input).
   An oversize line (> 64 KiB) is answered once and the helper exits.
4. **Sequence.** `connect` is valid only after a successful `list` and `deviceId` must equal one of that list's ids exactly (else `NO_CAMERA_FOUND`) — selection is
   by stable id, never by position. `shoot` is valid only while connected (else `PROTOCOL_ERROR`). `connect` while already connected is `CAMERA_BUSY`.
   Zero devices is a *successful* `list` with `devices:[]`; the Node side turns that into NO_CAMERA_FOUND / MULTIPLE_CAMERAS.
5. **Argv.** The only accepted arguments are exactly `--out-dir <dir>`. Anything else ⇒ exit 2 without reading stdin. No env var is read for behaviour.
6. **Out dir.** Must be: absolute drive-letter path (`X:\...`, backslashes), ≤ 240 chars, no `..`/`.` segment, no UNC / `\\?\` / device path, no `:` beyond the drive, none of
   `< > " | ? *` or control characters, no segment ending in space or dot, an existing directory that is **not a reparse point**, whose canonical
   (final) path equals the given path (so no junction/symlink/subst/8.3 aliasing), and whose **leaf name is `sony-shots`** (the bridge-owned temp area; the bridge
   creates it as `<data>/sony-shots`). Re-checked before every shot.
7. **File name.** The bridge *nominates* the name; the helper accepts only the exact pattern `shot-<36 hex/dash chars>.jpg` (no separators, no traversal, no other
   names ever), refuses to overwrite an existing file, and writes only inside the validated out dir. (The bridge-picks/helper-enforces split keeps request/reply
   file-name matching, which the Node side verifies, while giving the caller no choice beyond one fixed shape.)
8. **Shot verification (helper-side, before replying ok).** The file exists, is a regular non-reparse file ≤ 120 MB, starts `FF D8 FF`, ends with `FF D9`
   (within its last 64 bytes), and the **helper reads width/height from the JPEG's own SOF marker** (1..100000 each) — it reports those, not any SDK-claimed
   numbers. Otherwise the file is deleted and `TRANSFER_FAILED` is returned. "SDK success but no valid image" is therefore `TRANSFER_FAILED`.
9. **Redaction.** stdout carries only the documented messages. Device `id`/`model` strings from the SDK are charset-filtered (`id`: `[A-Za-z0-9._:-]{1,64}`,
   `model`: `[A-Za-z0-9._ -]{1,40}`; non-conforming devices are dropped). Raw SDK error codes/text are never emitted anywhere; stderr gets short fixed diagnostics only.
10. **No timeout-retry.** The helper never re-fires a shutter for any reason. SDK-level waits are bounded (< the bridge's per-capture timeout); the bridge's process
    kill remains the authoritative timeout. The helper holds no state that must survive its own death.
11. **Lifecycle.** stdin EOF, `close`, or fatal error ⇒ release the session and exit 0 / non-zero. `disconnected` is emitted at most once per session, only while connected.
12. **DLL loading.** The helper restricts DLL search to its own directory + System32 (`SetDefaultDllDirectories`) before touching the SDK; `CAMERA_OPT_HELPER_PATH`
    (trusted local config) is the only way to choose which helper runs. The bridge sets cwd to the helper's directory; the SDK DLLs live beside the helper.

## Status
Node side: implemented and tested against the fake helper **and** against the native helper binary (see below). Native side (`camera-bridge/native-src/sony-helper/`,
CMake, MSVC x64, static CRT): protocol engine, validation, JPEG verification, lifecycle and a hardware-free test suite are implemented. **The Sony SDK adapter
(`SonyDriver`) is NOT written** — the licensed SDK (2.02.00) is not installed on the build workstation, and SDK calls were deliberately not written blind. The shipped
exe therefore uses `NullDriver` (`list` ⇒ `DRIVER_UNAVAILABLE`), which gives `CAMERA_PROVIDER=sony` ⇒ `ERROR / DRIVER_UNAVAILABLE` exactly as before. See
`native-src/sony-helper/README.md` for the one seam to fill in.

## Phase 5G note
The protocol engine, validators and host described above are also compiled, unchanged, into the **Windows webcam helper** (`native-src/webcam-helper`, see `WEBCAM_HELPER_PROTOCOL.md`).
Two camera-agnostic parameters were added to the shared core with Sony-preserving defaults: the required out-dir leaf name (default `sony-shots`) and an optional device `placement`
field / `local` connection kind that the Sony driver never emits. The Sony SDK adapter (`SonyDriver`) remains unwritten and untouched.
