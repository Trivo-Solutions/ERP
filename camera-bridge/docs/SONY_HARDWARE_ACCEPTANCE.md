# Sony hardware acceptance, packaging and licensing record (Phase 5F-B)

**Result of this pass: no Sony hardware was available and the Sony SDK was not installed. Every hardware row below is NOT RUN. Nothing here is a hardware PASS.**

## 1. Evidence from the build workstation (2026-10-08)
- Toolchain present: MSVC 14.44.35207 x64 (VS 2022 Build Tools), CMake (bundled), Windows SDK 10.0.26100.
- Searched `C:\` and `P:\` to depth 5 for `Cr_Core.dll`, `CrSDK*.zip`, `CrTypes.h`, `CrDefines.h`, `CameraRemote*.h`: **none found**. SDK version/package, header and library
  locations, runtime DLL list and supported-camera README therefore remain **unverified on this machine** (the protocol doc records Sony's published facts: v2.02.00,
  `CrSDK_v2.02.00_20260610a_Win64.zip`, Windows x64 only, ILCE-7RM5 in the supported list).
- Attached cameras: only the laptop's integrated webcam. No Sony body.

## 2. Hardware acceptance — procedure and status
Prerequisites: install the licensed SDK; write `SonyDriver.cpp` (see `native-src/sony-helper/README.md`); `scripts\build-native.ps1 -SdkDir <sdk> -Install`; copy the SDK runtime
files next to `native\sony\trivo-sony-helper.exe`; camera set to JPEG (or RAW+JPEG), PC Remote mode, USB; provision the station; `CAMERA_PROVIDER=sony`,
`CAMERA_OPT_DEVICE_ID=<id from the helper's list>`.

| # | Step | Status |
|---|---|---|
| 1-3 | Configure sony + device id, start bridge, `/status` | NOT RUN |
| 5 | Camera reaches CONNECTED | NOT RUN |
| 6-7 | ERP capture command; exactly one physical shutter (count with the camera's shutter counter/EXIF, not only logs) | NOT RUN |
| 8-12 | Image produced → existing upload endpoint → TagImage → processing → thumbnail/gallery | NOT RUN (the Node→ERP half is covered by the existing mock-camera tests) |
| 13 | Repeat capture | NOT RUN |
| 14-15 | Unplug: normalized NOT_CONNECTED / DEVICE_LOST | NOT RUN (protocol path covered natively with FakeDriver: `disconnected` event, `DEVICE_LOST`) |
| 16-18 | Replug: recovery, capture again | NOT RUN |
| 19 | Command replay produces no duplicate image | NOT RUN on hardware (ERP idempotency covered by existing tests) |
| — | Exact camera model / firmware | not recorded — no camera |

## 3. Task Scheduler end-to-end
**NOT VERIFIED.** It needs a provisioned DPAPI station credential, a reachable ERP and, for the Sony steps, a camera. Registering a persistent logon task on a shared
workstation for a test that cannot reach its meaningful steps was not done. `install-task.ps1` / `run-bridge.cmd` were not modified.

## 4. What a future installer needs (do not bundle yet)
`trivo-sony-helper.exe` (ours, static CRT) · the SDK's runtime DLL set beside it (`Cr_Core.dll` and its adapter folder historically — **confirm from the SDK's own README**) ·
bridge `dist/` + Node runtime · `CAMERA_PROVIDER=sony`, `CAMERA_OPT_DEVICE_ID`, optional `CAMERA_OPT_HELPER_PATH` · DPAPI provisioning as the station user (existing) ·
camera USB driver/PC Remote setup per Sony's instructions. SDK binaries are installed separately by the operator until legal review approves a distribution model.

## 5. Licensing — facts only, no legal conclusion
Per Sony's click-through agreement (summarised in `SONY_HELPER_PROTOCOL.md`): binary-only redistribution "incorporated in an inseparable way" into our application;
no separate sharing; end-user consent that remote control voids the camera warranty; keep Sony notices; no implication of Sony authorship; own support; indemnity; no reverse
engineering; export restrictions; open-source components carry their own notices. **Open questions for counsel:** whether shipping the DLLs beside a separate helper exe
counts as "inseparable"; whether commercial/SaaS-style deployment needs separate terms; the required notice text and where it must appear; the warranty-consent wording.
**Final commercial distribution remains subject to legal review.** No Sony file is in this repository (`native/` and `native-src/build/` are gitignored).
