# Windows webcam helper — protocol and security contract (Phase 5G)

`trivo-webcam-helper.exe` lets the bridge capture one JPEG from a Windows camera (laptop camera, USB webcam, virtual camera) through Media Foundation.
It is a **generic camera helper, not a Sony helper**: it shares the Sony helper's *wire protocol and hardened core*, but contains no Sony code and needs no SDK.

## What is shared with the Sony helper, and what is not
| | Shared (compiled unchanged from `native-src/sony-helper/`) | Webcam-specific (`native-src/webcam-helper/`) |
|---|---|---|
| Protocol engine, strict one-line JSON parser, id/file/path validators, JPEG verifier, stdin/stdout host loop, DLL-search restriction | yes (`json`, `validate`, `jpeg`, `engine`, `host`) | — |
| `ICameraDriver` seam | yes (`driver.h`) | `WebcamDriver` (Media Foundation + WIC) |
| Out-dir leaf name | parameter, default `sony-shots` (Sony behaviour unchanged) | `webcam-shots` |
| Camera-agnostic additions to the shared core | `list` devices may carry `"connection":"local"` and an optional `"placement":"integrated"`; both are *omitted/never emitted* by the Sony driver, so the Sony wire output is byte-identical | — |

The Sony SDK adapter is **not touched**. The Sony helper binary, its Node backend/provider and its 190 native checks are unchanged.

## Protocol v1 (UTF-8, one JSON object per line, stdin/stdout; stderr carries only fixed usage strings)
Helper → bridge on start: `{"event":"ready","protocol":1}`. One request in flight at a time; every request carries an integer `id` 1..2147483647 and the reply echoes it.

| Request | Success reply | Notes |
|---|---|---|
| `{"id":1,"op":"list"}` | `{"id":1,"ok":true,"devices":[{"id":"cam-<24 hex>","model":"Integrated Camera","connection":"usb"\|"network"\|"local","placement":"integrated"?}]}` | Enumerates video-capture devices. Zero cameras is a *successful* empty list. ≤32 devices. |
| `{"id":2,"op":"connect","deviceId":"cam-…"}` | `{"id":2,"ok":true}` | Valid only after `list`; `deviceId` must equal a listed id exactly (`NO_CAMERA_FOUND` otherwise). Records the device; **the camera is not opened or streamed** (its light stays off). |
| `{"id":3,"op":"shoot","file":"shot-<uuid>.jpg"}` | `{"id":3,"ok":true,"file":"…","width":W,"height":H}` | Opens the camera, lets auto-exposure settle (≥6 frames and ≥400 ms, never more than 1.5 s), takes **one** frame, writes one JPEG, releases the camera. No retry. |
| `{"id":4,"op":"close"}` | `{"id":4,"ok":true}` then exit | |

Failure reply: `{"id":n,"ok":false,"failure":"<code>"}` with code one of `DRIVER_UNAVAILABLE NO_CAMERA_FOUND MULTIPLE_CAMERAS CONNECT_REJECTED CAMERA_BUSY DEVICE_LOST SHUTTER_FAILED TRANSFER_FAILED TIMEOUT PROTOCOL_ERROR`.
Raw Windows/HRESULT/driver text is never emitted — the driver maps every result to this closed set before the engine sees it. Unsolicited: `{"event":"disconnected"}` (at most once per session) when the selected camera leaves.

### Required handling (each is covered by a test)
| Situation | Behaviour |
|---|---|
| `ready` | emitted once, after argument/out-dir validation. Wrong/missing `ready` ⇒ the bridge treats the helper as `DRIVER_UNAVAILABLE` and kills it |
| malformed JSON, non-object, duplicate key, nesting, missing/!integer/out-of-range `id` | `{"id":<n or 0>,"ok":false,"failure":"PROTOCOL_ERROR"}`; helper keeps running |
| unknown operation, extra key, out-of-sequence op (`connect` before `list`, `shoot` before `connect`) | `PROTOCOL_ERROR` |
| invalid `deviceId` / `file` | `PROTOCOL_ERROR` (never reaches the driver) |
| oversize line (> 64 KiB) | one `PROTOCOL_ERROR`, then exit 0 |
| camera unavailable / disappears | `NO_CAMERA_FOUND`, or `DEVICE_LOST` from `shoot` (+ `disconnected` event) |
| camera busy (another process holds it, or another helper is mid-capture) | `CAMERA_BUSY` |
| camera access blocked by Windows privacy settings | `CONNECT_REJECTED` |
| capture failure | `SHUTTER_FAILED` / `TRANSFER_FAILED` (a produced file that is not a valid JPEG is deleted and reported `TRANSFER_FAILED`) |
| capture slower than the helper's own 10 s budget | `TIMEOUT`. The **bridge's** capture timeout is authoritative: on expiry it kills the process, so an abandoned capture can never finish later |
| helper process exit/crash mid-request | the bridge maps it to `DEVICE_LOST` (session open) or `PROTOCOL_ERROR`, and starts a fresh helper next time |
| stdin EOF / `close` | release and exit 0 |

## Identity and selection
* `id` = `"cam-"` + first 24 hex of SHA-256 of the lower-cased **device symbolic link** Windows reports for the camera. It is the OS's own per-device identity: stable across reboots and enumeration order, different for two otherwise identical webcams, and never an array index. (Plugging the same webcam into a *different USB port* can change its link, hence its id — then the person selects it again.)
* `model` = the friendly name reduced to `[A-Za-z0-9._ -]`, whitespace-collapsed, ≤40 chars (`Camera` if nothing remains).
* `placement:"integrated"` is set **only** when that name itself says so (`integrated`, `built-in`, `internal`, `facetime`). The helper never claims a camera is external; an unrecognised camera simply has no `placement`.
* Infrared / Windows Hello sensors (names containing `infrared`, `IR`, `Windows Hello`) are not offered: they produce a monochrome IR image.
* Selection is made by the bridge (`CameraHub`), by id — see README "Camera discovery & selection". The helper has no notion of a "default" camera.

## Security properties (each covered by a test)
* **argv** is exactly `--out-dir <dir>`; anything else (unknown, duplicate, extra, `--help`) ⇒ exit 2 before stdin is read. No environment variable is read for behaviour; the bridge spawns it with only `SystemRoot`, `TEMP`, `TMP`.
* **Out dir**: absolute `X:\…` only (rejects relative, UNC, `\\?\`, `\\.\`, forward slashes), no `.`/`..` segment, no `:` beyond the drive (alternate streams), no wildcard/control chars, no segment ending in space or dot, ≤240 chars, an existing directory that is **not a reparse point** whose canonical path equals the given path (no junction/symlink/subst/8.3 aliasing anywhere in the path), and whose leaf is exactly **`webcam-shots`**. Re-checked before every shot. The helper accepts no other executable or DLL path argument at all.
* **File name**: only `shot-<36 hex/dash>.jpg`, chosen by the bridge, written only inside the validated out dir, created with `CREATE_NEW` so an existing file is **never overwritten**.
* **No concurrent physical capture**: one request in flight per helper, a bridge-side `CameraController` busy lock, and a cross-process named mutex (`Local\TrivoWebcamHelperShoot`) held for the duration of a `shoot` (a second helper gets `CAMERA_BUSY`).
* **Image checks** before `ok`: regular non-reparse file, 4 B … 120 MB, `FF D8 FF … FF D9`, dimensions read from the JPEG's own SOF marker. The bridge repeats the checks, reads the file, **deletes it**, and sweeps leftovers at helper start.
* **DLL loading** restricted to the application directory + System32 (`SetDefaultDllDirectories`) before any Media Foundation call.
* **Redaction**: no credential, ticket, token, image data or sensitive device string is logged or sent; stdout is protocol only; the bridge only ever receives the neutral `CameraError` codes.

## Requirements and limits
* Windows 10/11 x64. Media Foundation + WIC ship with Windows; Windows "N" editions need the Media Feature Pack.
* Camera access for desktop apps must be allowed in *Settings → Privacy & security → Camera*; otherwise `shoot` reports `CONNECT_REJECTED`.
* Output is the camera's largest native mode converted to RGB and JPEG-encoded (quality 0.92). A webcam is a fixed-focus snapshot device — it is not a substitute for the Sony body for catalogue-quality jewellery photography.
* `placement` detection is a name heuristic. Built-in vs. external cannot be asserted reliably from the OS enumeration alone.
