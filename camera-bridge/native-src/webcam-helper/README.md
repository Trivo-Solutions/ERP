# trivo-webcam-helper (native, Windows x64)

Implements `camera-bridge/docs/WEBCAM_HELPER_PROTOCOL.md`. It reuses the Sony helper's protocol engine, JSON parser, validators, JPEG verifier and process host
**unchanged** (compiled from `../sony-helper/`) and supplies a different driver behind `ICameraDriver`:

| File | |
|---|---|
| `webcam_driver.cpp/.h` | Media Foundation enumeration + capture, WIC JPEG encode, cross-process capture mutex, disconnect polling |
| `webcam_util.cpp/.h` | pure helpers: name sanitising, stable id (SHA-256 of the device link), integrated/IR heuristics (hardware-free tests) |
| `main.cpp` | entry point; out-dir leaf `webcam-shots` |
| `tests/webcam_tests.cpp` | 39 checks; the final test enumerates this machine's cameras read-only |

```
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-webcam.ps1            # configure, build, run native tests
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-webcam.ps1 -Install   # also copy the exe to <bridge>\native\webcam\
cd ..\.. ; npx vitest run test\webcamNative.test.ts                                # Node <-> real helper (skips if not built)
$env:TRIVO_WEBCAM_LIVE='1'; npx vitest run test\webcamNative.test.ts               # OPT-IN: also takes two real photos
```
MSVC 14.44, `/W4 /WX /GS /guard:cf /permissive-`, static CRT (no VC++ redistributable), ASLR/DEP/CFG. No SDK and no third-party dependency.

Design notes: the camera is opened only for the duration of a `shoot` (light off between photos, no exclusive hold); the device id is derived from the OS device link,
never an index; nothing but the closed `Failure` set leaves the driver.
