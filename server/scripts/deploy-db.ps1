# One-command database update for the server machine.
# Run from the server folder:  npm run deploy:db
#
# Reads OWNER_DATABASE_URL from .env, uses it ONLY for this process (the .env file is never changed),
# then: migrate status -> migrate deploy -> db:secure -> build. Stops at the first failure.
# After it finishes, restart the API yourself (pm2 / Windows service / IIS app pool).

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$line = Select-String -Path .\.env -Pattern '^OWNER_DATABASE_URL=' | Select-Object -First 1
if (-not $line) {
  Write-Host "No OWNER_DATABASE_URL line in .env - add it first (trivo_owner login)." -ForegroundColor Red
  exit 1
}

$original = $env:DATABASE_URL
$env:DATABASE_URL = ($line.Line -replace '^OWNER_DATABASE_URL=', '').Trim().Trim('"')
Write-Host ("Using owner login: " + ($env:DATABASE_URL -replace ':[^:@/]+@', ':***@'))

function Step($label, [scriptblock]$cmd) {
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE) - stopped. Nothing after this step was run." }
}

try {
  Step 'migrate status' { npx prisma migrate status }
  Step 'migrate deploy' { npx prisma migrate deploy }
  Step 'db:secure (restore RLS + grants)' { npm run db:secure }
  Step 'build' { npm run build }
  Write-Host "`nDone. Now restart the API." -ForegroundColor Green
}
catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
finally {
  # never leave the owner login in the session
  if ($original) { $env:DATABASE_URL = $original } else { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
}
