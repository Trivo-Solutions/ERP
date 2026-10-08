# TRIVO Photography System

## Master Implementation Specification & Claude Code Instructions

You are working inside the existing TRIVO / SEA ERP monorepo.

Your task is to design and implement a production-ready, platform-independent **TRIVO Photography System** integrated into the existing ERP.

This is NOT a standalone business application.

The Photography System is a first-class module inside TRIVO ERP, while physical camera communication is handled through a separate lightweight **TRIVO Camera Bridge** layer.

---

# 1. PRIMARY OBJECTIVE

Replace the current manual jewellery image workflow:

> Take photographs → rename files to Tag Number → bulk upload → ERP identifies the tag

with:

> Login to TRIVO → Photography → Select/scan Tag → Select Camera → Capture → Review → Save → Image automatically attached to Tag → Next Tag

The photographer must never be required to rename image files manually.

The system must support:

* Mobile devices
* Windows PCs
* macOS computers
* External professional cameras
* Device cameras
* USB cameras/webcams where supported
* Sony cameras
* Future Canon/Nikon/other camera adapters
* Camera fallback to the device camera
* Multiple images per jewellery tag
* Primary image designation
* Photography queue
* Barcode/QR scanning
* Audit trail
* Station/device management
* Camera connection status
* Automatic image upload
* Image validation
* Retry/recovery
* Role-based access

---

# 2. CRITICAL ARCHITECTURE DECISION

Do NOT build a separate business application with its own users, tags, inventory, or login system.

The architecture must be:

```text
                         TRIVO ERP
                            │
                    Photography Module
                            │
                    Photography API
                            │
                ┌───────────┴───────────┐
                │                       │
          Mobile Controller        PC Controller
                │                       │
                └───────────┬───────────┘
                            │
                  TRIVO Camera Bridge
                            │
              ┌─────────────┼─────────────┐
              │             │             │
         Sony Camera    Other Camera   Device Camera
```

TRIVO ERP owns:

* Users
* Authentication
* RBAC
* Companies
* Branches
* Tags
* Products
* Photography queue
* Photo records
* Image metadata
* Storage
* Audit
* Station registration
* Capture sessions
* Business rules

The Camera Bridge owns:

* Physical camera discovery
* Camera connection
* Camera status
* Camera-specific communication
* Capture command
* Live preview where supported
* Receiving captured image data
* Sending image data to TRIVO
* Device camera access where appropriate

The Camera Bridge must NOT own ERP business logic.

---

# 3. EXISTING ERP MUST BE UNDERSTOOD FIRST

Before changing any code:

1. Inspect the entire repository structure.
2. Identify:

   * Frontend
   * Backend
   * Prisma schema
   * Existing tag models
   * Tagging module
   * Inward module
   * Inventory models
   * Image/file storage
   * Existing local printer agent
   * Authentication
   * RBAC
   * Company/branch architecture
   * Audit system
   * WebSocket infrastructure
   * API conventions
   * Existing tests
   * Existing migrations
3. Determine the actual current architecture from the code.
4. Do not rely on assumptions from this specification if the repository shows a different implementation.
5. Reuse existing architecture wherever appropriate.
6. Do not create duplicate infrastructure.

Before implementation, produce a concise architecture assessment.

Do NOT modify production code during this initial assessment.

---

# 4. EXISTING HARDWARE-AGENT PATTERN

The ERP already has a local printer-agent concept.

Study it carefully.

Where technically appropriate, use the same architectural principles for the Camera Bridge.

Do not blindly copy the printer agent.

Determine:

* How it authenticates
* How it communicates with ERP
* How local devices are registered
* How WebSocket/local HTTP communication works
* How updates/errors are handled
* How the agent is packaged
* How the frontend knows whether the agent is online

The Camera Bridge should feel like a natural extension of the existing TRIVO architecture.

---

# 5. PLATFORM-INDEPENDENT DESIGN

The Photography System must NOT assume:

* Windows only
* Android only
* Sony only
* USB only
* Browser-only camera access

The system must use an abstraction.

Conceptually:

```text
CameraProvider
    │
    ├── DeviceCameraProvider
    ├── SonyCameraProvider
    ├── CanonCameraProvider
    ├── NikonCameraProvider
    └── GenericCameraProvider
```

Do not implement every provider immediately.

Build the abstraction correctly first.

Initial priority:

1. Device camera
2. Sony A7R V / ILCE-7RM5
3. Architecture for future cameras

The user's current professional camera is:

**Sony A7R V / ILCE-7RM5**

There is also a Sony 4K camera in use. Its exact model must be confirmed before implementing a dedicated adapter.

Do not invent support for an unknown Sony 4K model.

---

# 6. CONTROLLER VS CAMERA

This distinction is fundamental.

A phone or PC is a CONTROLLER.

A Sony A7R V is a CAMERA.

Examples:

```text
Android Phone
    +
Sony A7R V
```

must work.

```text
Android Phone
    +
Phone Camera
```

must work.

```text
Windows PC
    +
Sony A7R V
```

must work.

```text
Windows PC
    +
USB Webcam
```

must work.

```text
Windows PC
    +
PC Camera
```

must work.

The ERP UI must not assume that the controller's own camera is the primary camera.

---

# 7. CAMERA SELECTION

The Photography UI should show available cameras.

Example:

```text
Camera

● Sony A7R V
  Connected

○ Device Camera

○ USB Camera
```

If the external camera disconnects:

```text
Sony A7R V disconnected.

[Reconnect]

[Use Device Camera]
```

The user must be able to switch cameras without leaving the photography workflow.

---

# 8. PHOTOGRAPHY MODULE

Create a dedicated TRIVO module:

```text
Photography
```

Do not force photographers through normal inventory screens.

The Photography workspace should be optimized for high-volume operation.

Primary sections:

* Photography Queue
* Capture
* Review
* Completed
* Rejected
* Stations
* Camera/Device Status

---

# 9. PHOTOGRAPHY QUEUE

Tags requiring photographs should be available in a queue.

Possible statuses:

```text
PENDING
IN_PROGRESS
CAPTURED
REVIEW_REQUIRED
COMPLETED
REJECTED
FAILED
```

Do not create unnecessary duplicate status systems if an existing tag/image workflow already has suitable states.

The queue must support:

* Search
* Tag number
* Product/category
* Branch
* Status
* Date
* Photographer
* Pagination
* Sorting
* Filtering

---

# 10. TAG SELECTION

The photographer must be able to:

1. Search Tag Number
2. Select from queue
3. Scan barcode/QR code

Preferred workflow:

```text
SCAN TAG
   ↓
TRIVO loads Tag
   ↓
Camera ready
   ↓
CAPTURE
   ↓
REVIEW
   ↓
SAVE
   ↓
NEXT
```

The system must verify that the scanned tag exists and that the photographer has permission to photograph it.

---

# 11. MULTIPLE PHOTOS

Design the data model to support multiple photographs per tag.

Initial image types:

```text
PRIMARY
SIDE
BACK
DETAIL
OTHER
```

Do not hard-code the system so that only one photograph can exist.

A tag may have:

```text
VG000123

PRIMARY → image
SIDE    → image
BACK    → image
DETAIL  → image
```

One image must be optionally designated as the primary image.

---

# 12. IMAGE DATA MODEL

Before creating models, inspect existing image/file models.

Reuse existing infrastructure if suitable.

If new models are required, they should conceptually contain:

* id
* companyId
* branchId where appropriate
* tagId
* image type
* storage key/path
* original filename
* MIME type
* width
* height
* file size
* checksum if appropriate
* capture device
* camera identifier
* station identifier
* capturedBy
* capturedAt
* upload status
* processing status
* createdAt
* updatedAt

Do not duplicate company/tenant fields if the existing architecture already handles them differently.

Follow the repository's established conventions.

---

# 13. PHOTOGRAPHY STATION

Introduce the concept of a Photography Station.

Example:

```text
MANIKONDA-PHOTO-01
MIYAPUR-PHOTO-01
JUBILEE-PHOTO-01
```

A station represents a physical photography setup.

It may have:

* Company
* Branch
* Station name
* Controller device
* Camera
* Status
* Last seen
* Registered date
* Active/inactive state

A station must NOT be permanently tied to a particular user.

A different authorized photographer should be able to use it.

---

# 14. DEVICE REGISTRATION

Devices/camera bridges should be registered securely.

Do not store a user's ERP password in the Camera Bridge.

Use device/station credentials or secure tokens.

The device should have restricted permissions.

The Camera Bridge must NOT have unrestricted ERP access.

It should only be able to perform the required hardware-related operations.

---

# 15. CAMERA BRIDGE

The Camera Bridge should be a separate technical component.

Suggested responsibilities:

```text
discover()
connect()
disconnect()
getStatus()
startPreview()
stopPreview()
capture()
downloadCapture()
switchCamera()
```

Do not force every camera provider to support every feature.

For example:

```text
Sony A7R V
  capture ✓
  preview ✓ if supported
  status ✓

Basic webcam
  capture ✓
  preview ✓

Some future camera
  capture ✓
  preview ✗
```

The UI must gracefully handle unsupported capabilities.

---

# 16. LIVE PREVIEW

Live preview is desirable but must not become a blocker for the first working release.

Priority:

P0:

* Connect camera
* Capture image
* Receive image
* Upload image
* Associate image with tag

P1:

* Live preview
* Camera settings
* Focus control
* Exposure information

Never delay the complete system because a camera's live-preview API is difficult.

---

# 17. MOBILE

On mobile:

If an external supported camera is available:

```text
Mobile
  ↓
External Camera
  ↓
Capture
```

If no external camera is available:

```text
Mobile
  ↓
Device Camera
  ↓
Capture
```

Do not assume mobile means phone camera only.

The mobile UI should be optimized for touch:

* Large Capture button
* Large Next button
* Swipe/navigation where appropriate
* Camera status
* Clear tag information
* Minimal typing

---

# 18. PC

On PC:

If a professional camera is connected:

```text
PC
 ↓
Camera Bridge
 ↓
Sony / other camera
```

If not:

```text
PC
 ↓
Webcam / Device Camera
```

The PC UI should support keyboard shortcuts where practical:

```text
Enter / Space → Capture
R → Retake
N → Next
Esc → Cancel
```

Do not implement shortcuts if they conflict with existing application conventions.

---

# 19. IMAGE PROCESSING

Images should not blindly be stored at whatever resolution the camera produces.

Design an image-processing pipeline.

Potential stages:

```text
Captured Original
       ↓
Validation
       ↓
Orientation correction
       ↓
Metadata handling
       ↓
Resize / optimization
       ↓
Thumbnail generation
       ↓
Storage
       ↓
ERP record
```

Do not destroy the original unless the existing storage strategy explicitly requires it.

Determine whether TRIVO should retain:

* Original
* Optimized
* Thumbnail

based on actual storage architecture.

---

# 20. UPLOAD RELIABILITY

The system must handle:

* Camera disconnected
* Network disconnected
* ERP temporarily unavailable
* Upload failure
* Duplicate capture
* Camera timeout
* Invalid image
* User closing the page
* Browser refresh
* Agent restart

A captured photograph should not simply disappear because the network failed.

Where appropriate, use a local pending queue.

Example:

```text
CAPTURED LOCALLY
      ↓
PENDING UPLOAD
      ↓
UPLOAD
      ↓
CONFIRMED
```

Only mark the ERP photo record as completed after successful confirmation.

---

# 21. DUPLICATE PROTECTION

Prevent accidental duplicate uploads.

Use appropriate identifiers/checksums/idempotency keys.

Example:

```text
captureId
stationId
deviceId
timestamp
tagId
```

The exact implementation must follow the existing backend conventions.

---

# 22. SECURITY

Follow the existing TRIVO authentication and RBAC architecture.

Photography permissions should be granular enough to support roles such as:

```text
Photography.View
Photography.Capture
Photography.Review
Photography.Delete
Photography.ManageStations
Photography.ManageCameras
```

Do not automatically create these exact permissions if the ERP uses a different permission convention.

Inspect and follow the current RBAC system.

Deleting images should be restricted.

Prefer soft-delete/audit behavior if consistent with existing architecture.

---

# 23. AUDIT

Every meaningful photography operation should be auditable.

Examples:

```text
Tag photographed
Image captured
Image uploaded
Image replaced
Image deleted
Image marked primary
Camera connected
Camera disconnected
Station registered
```

Use the existing audit system.

Do not build a second audit framework.

---

# 24. API DESIGN

Follow existing TRIVO API conventions.

Conceptual endpoints might include:

```text
GET    /photography/queue
GET    /photography/tags/:tagId
POST   /photography/captures
POST   /photography/images
PATCH  /photography/images/:id
DELETE /photography/images/:id

GET    /photography/stations
POST   /photography/stations
PATCH  /photography/stations/:id

POST   /photography/devices/pair
POST   /photography/devices/heartbeat
```

These are examples only.

DO NOT blindly implement these exact routes.

First inspect the existing API structure and naming conventions.

---

# 25. REAL-TIME COMMUNICATION

The repository already uses WebSocket/socket.io infrastructure.

Inspect it.

Where appropriate, use it for:

* Camera connection status
* Capture command
* Capture result
* Upload status
* Station heartbeat
* Device online/offline
* Queue updates

Do not introduce another real-time technology unless there is a compelling technical reason.

---

# 26. DATABASE MIGRATIONS

All schema changes must use proper Prisma migrations according to the repository's established workflow.

Before migration:

* Inspect current migration history.
* Verify database state.
* Never assume development database state.
* Do not reset databases containing real data.
* Do not create destructive migrations without explicit justification.
* Preserve existing production/client data.

Follow the same migration discipline already used in the ERP.

---

# 27. NO DATA DESTRUCTION

Absolutely do NOT:

* reset the database
* delete existing tags
* delete existing images
* recreate the Prisma database
* remove existing models because they appear unused
* rewrite unrelated modules
* change existing production behavior unnecessarily

If an existing model must change, explain why first in the phase report.

---

# 28. TESTING REQUIREMENTS

Every phase must include appropriate tests.

Depending on the phase:

* Unit tests
* API tests
* Prisma/RLS tests
* Permission tests
* Integration tests
* Browser tests
* Camera Bridge tests
* Failure/recovery tests

Do not create meaningless tests merely to increase test counts.

Tests must verify actual behavior.

---

# 29. BROWSER TESTING

For frontend work, test real workflows.

Minimum important workflow:

```text
Login
 ↓
Photography
 ↓
Open queue
 ↓
Select tag
 ↓
Connect/select camera
 ↓
Capture
 ↓
Preview
 ↓
Save
 ↓
Image appears against tag
 ↓
Next tag
```

Also test:

```text
Camera unavailable
Device camera fallback
Upload failure
Duplicate capture
Permission denied
Refresh during pending upload
```

---

# 30. PHASED IMPLEMENTATION

DO NOT implement everything in one pass.

Work in these phases.

## PHASE 0 — Repository & Architecture Audit

Read this specification.

Inspect the complete repository.

Identify all existing systems relevant to:

* Tags
* Images
* Storage
* Authentication
* RBAC
* Audit
* Company/branch
* WebSockets
* Printer agent
* Device registration
* API
* Prisma
* frontend routing

Output:

`docs/TRIVO_PHOTOGRAPHY_PHASE_0_AUDIT.md`

Do not make production code changes unless absolutely necessary for investigation.

STOP and report findings.

---

# PHASE 1 — Data Model & Domain Design

Design the Photography domain.

Determine whether new models are required.

Potential concepts:

* PhotographyStation
* CameraDevice
* CameraConnection
* PhotographySession
* Photo
* Capture
* UploadJob

Do not create unnecessary models.

Integrate with existing Tag/Image models where possible.

Implement migrations only after validating the design.

Add tests.

STOP after Phase 1.

---

# PHASE 2 — Backend Photography APIs

Implement:

* Queue
* Tag photography state
* Capture records
* Image association
* Primary image
* Multiple image types
* Station APIs
* Device pairing foundation
* Permissions
* Audit

Use existing backend patterns.

Add tests.

STOP after Phase 2.

---

# PHASE 3 — Photography UI

Build the TRIVO Photography workspace.

Must include:

* Queue
* Tag search
* Tag scanning foundation
* Capture screen
* Existing images
* Image type
* Primary image
* Review
* Retake
* Save & Next
* Camera status

At this stage, support simulated/device-camera capture if needed.

Do NOT wait for Sony integration to build the complete UI.

Add browser tests.

STOP after Phase 3.

---

# PHASE 4 — Device Camera

Implement:

* Android device camera
* iPhone device camera where technically supported
* Browser camera APIs where appropriate
* PC webcam fallback

The user should be able to use TRIVO Photography without a professional camera.

Add permissions and failure handling.

STOP after Phase 4.

---

# PHASE 5 — TRIVO Camera Bridge

Build the Camera Bridge abstraction.

Requirements:

* Secure registration
* Station association
* Heartbeat
* Camera discovery
* Camera status
* Capture command
* Image transfer
* Retry
* Offline queue where required

Do not yet implement every camera brand.

Start with the architecture and a mock/test camera provider.

STOP after Phase 5.

---

# PHASE 6 — Sony A7R V

Implement the Sony A7R V / ILCE-7RM5 adapter.

Before coding:

* Verify the actual supported Sony APIs/protocols.
* Verify USB capability.
* Verify supported remote shooting mechanism.
* Verify image transfer mechanism.
* Verify live preview capability.
* Verify platform limitations.

Do not invent an undocumented API.

The adapter should expose the common CameraProvider interface.

Test:

```text
Connect
Status
Capture
Receive image
Upload
Associate with tag
Disconnect
Reconnect
```

STOP after Phase 6.

---

# PHASE 7 — Second Sony 4K Camera

The exact model is currently not specified.

Do not guess.

Once the exact model is available:

* Determine supported remote-control mechanism.
* Create a dedicated adapter if required.
* Reuse the common CameraProvider interface.

STOP after Phase 7.

---

# PHASE 8 — Mobile External Camera

Implement mobile controller support for supported external cameras.

Important:

Mobile external camera support must be independent of mobile device camera fallback.

Test:

```text
Android + Sony
Android + Device Camera

iOS + Sony
iOS + Device Camera
```

Where a platform/camera combination cannot technically support a feature, display a clear capability message rather than pretending it works.

STOP after Phase 8.

---

# PHASE 9 — PC External Camera

Implement:

```text
Windows + Sony
Windows + Webcam

macOS + supported camera
macOS + device camera
```

Use the Camera Bridge.

STOP after Phase 9.

---

# PHASE 10 — Barcode/QR Workflow

Implement:

```text
Scan Tag
 ↓
Resolve Tag
 ↓
Photography screen
 ↓
Capture
 ↓
Save
 ↓
Next scan
```

Optimize for high-volume jewellery photography.

STOP after Phase 10.

---

# PHASE 11 — Production Hardening

Test:

* Camera disconnect
* Network failure
* ERP failure
* Duplicate image
* Agent restart
* Browser refresh
* Device sleep
* Camera reconnect
* Large image
* Slow upload
* Multiple stations
* Multiple photographers
* Permission boundaries
* Cross-company isolation
* Cross-branch isolation
* Audit correctness

Optimize only after correctness is established.

STOP after Phase 11.

---

# 31. CLAUDE CODE WORKING RULES

These rules are mandatory.

## Rule 1 — Inspect before changing

Never start editing code based solely on this document.

Read the relevant existing implementation first.

## Rule 2 — Small phases

Do not silently continue into the next phase.

After completing a phase:

1. Run tests.
2. Review changes.
3. Check migration status.
4. Check git diff.
5. Report what changed.
6. Report risks.
7. STOP.

Wait for approval before the next phase.

## Rule 3 — No giant rewrites

Do not rewrite existing modules merely to make implementation easier.

Extend existing architecture.

## Rule 4 — No duplicate systems

Before creating:

* Image model
* Audit system
* Device registration
* WebSocket system
* Storage system
* RBAC permission

search the repository for an existing equivalent.

Reuse it when appropriate.

## Rule 5 — Keep migrations clean

One logical schema change should have a clear migration.

Never reset the database.

## Rule 6 — Verify actual behavior

Do not say:

> "Implemented."

unless the relevant code has actually been tested.

## Rule 7 — No fake camera implementation

During early phases, mocks are acceptable.

Do not pretend a Sony camera works until actual integration has been verified.

## Rule 8 — Preserve unrelated work

The repository may contain work from other ERP modules.

Do not modify unrelated files unnecessarily.

## Rule 9 — Check git status

At the beginning and end of every phase:

```bash
git status
```

Review:

```bash
git diff
```

Do not commit unless explicitly instructed.

## Rule 10 — Never conceal problems

If you find:

* schema inconsistencies
* migration drift
* broken existing tests
* unrelated uncommitted changes
* unexpected commits
* existing bugs
* architecture conflicts

STOP and report them.

Do not silently "fix" unrelated problems.

---

# 32. PHASE REPORT FORMAT

At the end of every phase, report:

```text
PHASE:
Status:

Implemented:
- ...

Files changed:
- ...

Database changes:
- ...

Tests:
- ...

Browser tests:
- ...

Security/RBAC:
- ...

Known limitations:
- ...

Risks:
- ...

Git status:
- ...

Next recommended phase:
- ...
```

Then STOP.

---

# 33. IMPORTANT PRODUCT PRINCIPLE

The photographer should experience the system as one application:

```text
LOGIN
 ↓
TRIVO
 ↓
PHOTOGRAPHY
 ↓
TAG
 ↓
CAMERA
 ↓
CAPTURE
 ↓
SAVE
 ↓
NEXT
```

They should not need to understand:

* Camera protocols
* USB drivers
* API calls
* storage paths
* filenames
* image folders
* tag matching

The technical complexity must remain behind the Camera Bridge.

---

# 34. FINAL TARGET EXPERIENCE

The final system should make this possible:

### Mobile + Sony

```text
Phone
  ↓
TRIVO
  ↓
Sony A7R V
  ↓
Capture
  ↓
VG000123
```

### Mobile + phone camera

```text
Phone
  ↓
TRIVO
  ↓
Phone Camera
  ↓
Capture
  ↓
VG000123
```

### PC + Sony

```text
PC
  ↓
TRIVO
  ↓
Camera Bridge
  ↓
Sony A7R V
  ↓
Capture
  ↓
VG000123
```

### PC + webcam

```text
PC
  ↓
TRIVO
  ↓
Webcam
  ↓
Capture
  ↓
VG000123
```

All four must produce the same business result:

```text
Tag VG000123
      │
      ├── Primary Image
      ├── Side Image
      ├── Back Image
      └── Detail Image
```

---

# 35. SUCCESS CRITERIA

The project is successful when a photographer can:

1. Login to TRIVO.
2. Open Photography.
3. See pending jewellery tags.
4. Scan or select a tag.
5. See available cameras.
6. Select Sony A7R V when available.
7. Capture without renaming the file.
8. See the captured image.
9. Retake if required.
10. Save the image.
11. Image automatically attaches to the correct tag.
12. Move to the next tag.
13. Use the phone camera if Sony is unavailable.
14. Perform the same workflow on PC.
15. Work with multiple photography stations.
16. Have every operation properly audited.
17. Recover safely from camera/network failures.

---

# 36. FIRST INSTRUCTION TO CLAUDE

DO NOT start coding immediately.

First:

1. Read this entire specification.
2. Inspect the repository.
3. Understand the existing TRIVO architecture.
4. Inspect the existing Tagging/Image/Storage/RBAC/Audit/Printer-Agent implementations.
5. Produce the Phase 0 architecture audit.
6. Identify conflicts or missing information.
7. Do not modify production code.
8. STOP.

Only after explicit approval should implementation begin with Phase 1.


# TRIVO Photography — RLS & Multi-Tenant Security Requirements

## 1. RLS IS MANDATORY

Photography must follow the same tenant/company/branch isolation architecture as the rest of TRIVO.

RLS is not optional.

Do not rely solely on:

* React/frontend filtering
* API-level `companyId` checks
* Hidden UI elements
* Client-supplied company IDs
* Camera-agent supplied company IDs

Database-level protection must prevent cross-company data access.

---

## 2. COMPANY ISOLATION

Every Photography-owned database entity must be evaluated for tenant/company ownership.

Conceptually:

```text
Company A
   │
   ├── Branch A1
   ├── Photography Station A1
   ├── Camera Device A1
   ├── Photographer A1
   └── Tag Images A1


Company B
   │
   ├── Branch B1
   ├── Photography Station B1
   ├── Camera Device B1
   ├── Photographer B1
   └── Tag Images B1
```

Company A must NEVER be able to:

* view Company B photographs
* upload photographs against Company B tags
* modify Company B photographs
* delete Company B photographs
* view Company B photography stations
* control Company B camera stations
* access Company B capture sessions

This must remain true even if someone manually calls the API.

---

## 3. BRANCH ISOLATION

Follow the existing TRIVO branch-access architecture.

If the existing ERP permits a user to access multiple branches, respect those permissions.

Do not introduce a new branch-permission system unless the existing system cannot support the Photography requirements.

A user must only see Photography Queue records for branches they are authorized to access.

---

## 4. TAG-BASED SECURITY

Photography must inherit the security context of the Tag.

A photographer must not be able to submit:

```text
tagId = Tag belonging to Company B
```

while authenticated under Company A.

The backend must resolve and validate the tag under the authenticated tenant context.

Never trust:

```text
companyId
branchId
tagId
```

sent from the browser or Camera Bridge.

---

## 5. CAMERA STATION ISOLATION

Photography Stations must also be tenant-scoped.

Example:

```text
Company A
  └── MANIKONDA-PHOTO-01

Company B
  └── MANIKONDA-PHOTO-01
```

It is acceptable for two companies to have stations with the same human-readable name.

Their database identity and tenant ownership must remain separate.

A device registered to Company A must not be usable to capture/upload images for Company B unless it is explicitly re-paired/re-authorized.

---

## 6. DEVICE/CAMERA SECURITY

The Camera Bridge must authenticate as a registered device/station.

It must NOT use:

* ERP administrator credentials
* Photographer password
* Shared company password
* Hard-coded credentials

The device credential must be:

* unique
* revocable
* scoped
* rotatable where appropriate
* stored securely

The Camera Bridge should have only the minimum permissions necessary.

---

## 7. SERVER-SIDE TENANT CONTEXT

Where the existing TRIVO architecture uses PostgreSQL session variables / RLS context, Photography must use the same mechanism.

Do not invent a second tenant-context mechanism.

Conceptually:

```text
Authenticated User
        ↓
TRIVO Auth Context
        ↓
Company / Tenant Context
        ↓
Database Session
        ↓
PostgreSQL RLS
        ↓
Photography Records
```

The exact implementation must follow the existing TRIVO RLS architecture.

---

## 8. RLS FOR ALL PHOTOGRAPHY TABLES

Any newly created Photography table that contains tenant-owned data must have appropriate RLS policies.

Potential tables include:

* PhotographyStation
* CameraDevice
* CameraConnection
* PhotographySession
* Capture
* Photo
* UploadJob

Only create RLS policies for models that actually exist after the domain design is finalized.

Do not blindly create unnecessary tables.

---

## 9. INSERT PROTECTION

RLS must prevent inserting a Photography record into another company.

For example, a malicious request must not succeed by submitting:

```text
companyId = anotherCompany
tagId = anotherCompanyTag
```

The database must enforce tenant ownership.

Where appropriate, derive tenant ownership from trusted relational records rather than accepting it from the client.

---

## 10. UPDATE PROTECTION

RLS must prevent:

```text
Company A
   ↓
UPDATE
   ↓
Company B photo
```

This includes:

* changing image metadata
* changing primary status
* changing image type
* changing associated tag
* changing station
* changing capture information

---

## 11. DELETE PROTECTION

RLS must prevent cross-tenant deletion.

Where the ERP's existing deletion policy uses soft-delete, follow it.

If hard deletion is permitted, it must still be protected by RLS and RBAC.

---

## 12. RELATIONAL SECURITY

Do not assume that adding `companyId` to every table automatically solves security.

For example:

```text
Photo
  ↓
Tag
  ↓
Company
```

must maintain tenant consistency.

A Photo belonging to Company A must not be attachable to a Tag belonging to Company B.

The database and backend must enforce this relationship.

---

## 13. CAMERA BRIDGE SECURITY

The Camera Bridge is an untrusted edge device.

Never trust the Camera Bridge to provide:

```text
companyId
branchId
userId
tag ownership
```

as authoritative information.

The server must resolve the authenticated station/device and verify the requested tag under the correct tenant context.

Conceptually:

```text
Camera Bridge
      │
      │ capture request
      ▼
TRIVO API
      │
      ├── Authenticate Device
      ├── Resolve Station
      ├── Resolve Company
      ├── Resolve Branch
      ├── Resolve User/Session where applicable
      ├── Resolve Tag
      ├── Verify Tenant Access
      ├── Verify RBAC
      └── Create Capture
             │
             ▼
          Database
             │
             ▼
             RLS
```

---

## 14. RLS TESTING IS MANDATORY

Do not consider Photography complete without cross-tenant RLS tests.

At minimum test:

### Company isolation

```text
Company A → can see A photos
Company A → cannot see B photos
Company B → can see B photos
Company B → cannot see A photos
```

### Tag isolation

```text
Company A user
   ↓
Company B tag
   ↓
MUST FAIL
```

### Photo update

```text
Company A
   ↓
attempt update Company B photo
   ↓
MUST FAIL
```

### Photo delete

```text
Company A
   ↓
attempt delete Company B photo
   ↓
MUST FAIL
```

### Station isolation

```text
Company A
   ↓
attempt to use Company B station
   ↓
MUST FAIL
```

### Device isolation

```text
Company A device
   ↓
attempt upload against Company B tag
   ↓
MUST FAIL
```

### Branch access

Where branch-level security exists:

```text
User with Branch A access
   ↓
Branch B photography record
   ↓
MUST FAIL
```

---

## 15. RLS REGRESSION REQUIREMENT

Photography RLS tests must be included in the normal test suite.

Do not make them one-time manual tests.

Future schema changes must not silently remove Photography RLS.

Any new tenant-owned Photography table must trigger a security review.

---

## 16. SECURITY REVIEW BEFORE PRODUCTION

Before Phase 11 is marked complete, perform a dedicated security review covering:

* RLS
* RBAC
* tenant isolation
* branch isolation
* device authentication
* station authorization
* image access
* image download URLs
* upload authorization
* deletion authorization
* API authorization
* WebSocket authorization
* Camera Bridge authentication
* audit trail

A Photography feature is NOT production-ready merely because the UI works.

It is production-ready only when the data isolation and authorization model has been verified.
