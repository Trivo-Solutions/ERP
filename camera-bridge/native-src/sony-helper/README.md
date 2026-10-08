# trivo-sony-helper (native, Windows x64)

Implements `camera-bridge/docs/SONY_HELPER_PROTOCOL.md` (v1, plus its "Clarifications" section, which is binding). The helper knows only the camera: no ERP
URL, token, ticket, company, tag or storage. It is spawned by the bridge with an empty environment and one argument pair, `--out-dir <dir>`.

## State of this directory
| Piece | Status |
|---|---|
| Protocol engine (`engine.cpp`), strict JSON (`json.cpp`), validators (`validate.cpp`), JPEG verifier (`jpeg.cpp`), process host (`host.cpp`) | implemented, 190 native checks pass |
| `ICameraDriver` seam (`driver.h`) + `NullDriver` | implemented; the shipped exe uses `NullDriver` => `list` = `DRIVER_UNAVAILABLE` |
| `FakeDriver` + `trivo-sony-helper-fake.exe` | test-only; lets the Node bridge run against a real native process with no camera |
| **`SonyDriver.cpp` (Sony Camera Remote SDK adapter)** | **NOT WRITTEN** — the licensed SDK was not installed on the build workstation (searched C:\ and P:\; no `Cr_Core.dll`, no CrSDK headers). SDK calls are not written blind against headers that were never seen. |

## Build / test
```
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-native.ps1          # configure, build, run native tests
cd ..\.. ; npx vitest run test\sonyNative.test.ts                                  # Node bridge <-> real native binaries (skips if not built)
```
MSVC 14.44 (VS 2022 Build Tools), Windows SDK 10.0.26100, `/W4 /WX /GS /guard:cf /permissive-`, static CRT (no VC++ redistributable needed), ASLR/DEP/CFG on.

## Writing the SDK adapter (the one remaining seam)
Install the licensed SDK locally, then add `SonyDriver.cpp` defining `trivo::ICameraDriver* makeSonyDriver()` and build with `-SdkDir <install dir>`
(`TRIVO_WITH_SONY_SDK` is then defined and `main.cpp` uses it). Nothing else changes. Requirements the adapter must meet (these come from the protocol,
not from SDK knowledge):
- `list`: initialise the SDK once, enumerate, return a **stable camera identity** (serial/GUID the SDK reports about the camera — never an index) and the model name.
- `connect(id)`: open exactly that device; map every SDK result to `CONNECT_REJECTED` / `CAMERA_BUSY` / `DEVICE_LOST` / `DRIVER_UNAVAILABLE`.
- `shoot(path)`: release the shutter **once**, wait for the SDK's own "image transferred" completion with a **bounded** wait (shorter than the bridge's capture
  timeout), write the JPEG to `path` (the engine already verified the path), return `SHUTTER_FAILED` / `TRANSFER_FAILED` / `TIMEOUT` / `CAMERA_BUSY`. **Never retry**,
  and never start an asynchronous transfer that could complete after a timeout reply (the bridge kills the process on timeout, so nothing may be relied on to survive).
  The camera must be configured to produce a **JPEG** (not RAW-only); if the body is set to RAW-only, return `TRANSFER_FAILED`.
- `pollDisconnected()`: return true once when the SDK's disconnect callback has fired (set a flag in the callback; do not block).
- `close()`: disconnect, release device, release SDK; idempotent.
- Return only `Failure` codes. Never put an SDK error number or string anywhere — the engine cannot forward what it never receives.
- DLLs: the host already restricts the loader to the application directory + System32 (`SetDefaultDllDirectories`). Put the SDK runtime files beside the exe.

## Security properties (each covered by a test)
argv exactly `--out-dir <dir>` (exit 2 otherwise) · out dir absolute `X:\`, no `..`/UNC/`\\?\`/ADS/wildcards/trailing dot-space, exists, not a reparse point,
canonical path == given path, leaf `sony-shots` · file name only `shot-<36 hex/dash>.jpg`, never overwritten, only inside the out dir · strict flat JSON ≤ 64 KiB,
no duplicate/unknown keys, bounded ids · sequence enforced (`connect` only after `list`, by exact id) · device strings charset-filtered, duplicates dropped ·
output image verified (regular file, `FF D8 FF` … `FF D9`, dimensions read from its own SOF) else deleted + `TRANSFER_FAILED` · no env var is read · no exceptions
escape (`catch (...)` ⇒ `PROTOCOL_ERROR`) · stdout is protocol only, stderr is two fixed usage strings.
