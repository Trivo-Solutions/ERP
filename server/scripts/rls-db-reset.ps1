# Rebuilds a database with the REAL role split from scratch: drop, create (owner = trivo_owner), migrate as the
# owner, then apply prisma/db-secure.sql (grants + FORCE ROW LEVEL SECURITY).
#
#   powershell -File scripts/rls-db-reset.ps1 -Db trivo_rlstest
#
# Prerequisites: a PostgreSQL cluster whose superuser you can reach, and C:\trivo-staging\{superpw.txt,roles.json}
# (created by the one-time bootstrap; see prisma/production-rls-roles.sql). Nothing here is used in production —
# production runs the same two SQL files by hand under your DBA's control.
param(
  [string]$Db = 'trivo_rlstest',
  [string]$Root = 'C:\trivo-staging',
  [int]$Port = 54329,
  [string]$Bin = 'C:\Program Files\PostgreSQL\18\bin'
)
$ErrorActionPreference = 'Stop'
$r = Get-Content "$Root\roles.json" | ConvertFrom-Json
$env:PGPASSWORD = (Get-Content "$Root\superpw.txt" -Raw)

& "$Bin\psql.exe" -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$Db' AND pid <> pg_backend_pid()" | Out-Null
& "$Bin\psql.exe" -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $Db" | Out-Null
& "$Bin\psql.exe" -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -v db=$Db -v owner_pw=$($r.owner) -v runtime_pw=$($r.runtime) -v platform_pw=$($r.platform) -f "$PSScriptRoot\..\prisma\production-rls-roles.sql" | Out-Null

Push-Location "$PSScriptRoot\.."
try {
  $env:DATABASE_URL = "postgresql://trivo_owner:$($r.owner)@localhost:$Port/${Db}?schema=public"
  npx prisma migrate deploy 2>&1 | Select-Object -Last 2
  npx prisma db execute --file prisma/db-secure.sql --schema prisma/schema.prisma 2>&1 | Select-Object -Last 1
} finally { Pop-Location; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
"reset complete: $Db"
