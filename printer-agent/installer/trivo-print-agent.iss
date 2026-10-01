; TRIVO Print Agent — Windows installer (Inno Setup 6).
;
; Replaces the old "download zip, extract, copy .env.example to .env, hand-type the printer
; name, double-click the exe" flow with: run this installer, done. It does NOT touch the
; printing architecture at all — it only places the same printer-agent.exe (built by
; `npm run package`, see ../package.json) into a per-user app folder and wires up autostart.
; The agent still binds 127.0.0.1:9101 only and still auto-detects/asks for the printer exactly
; as it does when run standalone — see ../src/index.ts.
;
; Build: see ../scripts/build-installer.ps1 (runs `npm run package` then compiles this script).
; Output: ../dist-installer/TRIVO Print Agent Setup.exe

#define MyAppName "TRIVO Print Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "TRIVO"
#define MyAppExeName "printer-agent.exe"

[Setup]
; Fixed AppId so re-running the installer is recognized as an upgrade of the same product
; (same install dir reused, config.json elsewhere is never touched either way).
AppId={{D0656303-030C-41C3-BE07-32570D032437}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppSupportURL=https://trivo.example
; Per-user install dir + lowest privileges: a counter-PC operator account rarely has admin
; rights, and this agent never needs system-wide install or a Program Files location — the
; identical posture already used for the per-user Startup autostart entry.
DefaultDirName={localappdata}\Programs\TRIVO Print Agent
DefaultGroupName=TRIVO Print Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-installer
OutputBaseFilename=TRIVO Print Agent Setup
Compression=lzma
SolidCompression=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern
DisableDirPage=yes
DisableReadyPage=yes
; Inno's own RestartManager-based "detect and close" negotiation (the CloseApplications default)
; was observed to stall for minutes against this agent even in /VERYSILENT mode. InitializeSetup
; below does the same job directly with a plain taskkill, before Inno gets a chance to try its own
; slower path — so that path is switched off entirely rather than raced against.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The exe already bundles Node + print-raw.ps1 + install-autostart.ps1 (see package.json's
; "pkg" config) — nothing else to ship.
Source: "..\dist-exe\printer-agent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; This is the "configure automatic startup" step — same Startup-folder mechanism, and the exact
; same shortcut filename, as the in-app "Start at login" toggle on http://127.0.0.1:9101/setup
; (see ../src/autostart.ts), so the two stay interchangeable instead of creating duplicates.
Name: "{userstartup}\TRIVO Print Agent"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Flags: runminimized
; A Start Menu entry too, purely for discoverability (manually re-launch / troubleshoot) — not
; required for the agent to function.
Name: "{group}\TRIVO Print Agent"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"

[Run]
; Starts the agent immediately after install so the wizard's final state matches reality without
; waiting for the next login — auto-detect/setup-page behavior is unchanged, see ../src/index.ts.
Filename: "{app}\{#MyAppExeName}"; Description: "Launch TRIVO Print Agent now"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
procedure StopRunningAgent();
var
  ResultCode: Integer;
begin
  // Lets an upgrade overwrite the .exe (Windows won't replace a running binary), and lets an
  // uninstall actually remove it. Config.json lives under a completely separate LOCALAPPDATA
  // path this installer never touches, so nothing about configuration is affected either way.
  Exec('taskkill.exe', '/IM {#MyAppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function InitializeSetup(): Boolean;
begin
  // Runs before Inno does any of its own file-lock/RestartManager handling for [Files], so the
  // exe is already free by the time it gets there — see the CloseApplications=no note above.
  StopRunningAgent();
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // Redundant safety net in case something else launched the agent between InitializeSetup and
  // the actual file copy (e.g. its own Startup entry firing during a slow install).
  if CurStep = ssInstall then
    StopRunningAgent();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopRunningAgent();
end;
