// Production start: apply pending migrations as the owner, THEN start the API as the runtime role.
//   npm run start:prod
//
// Why a wrapper and not "migrate inside the API": the API refuses to start as a table owner (CLAUDE.md §11),
// so it can never migrate itself. This script runs the owner steps in short-lived child processes and starts
// the API with OWNER_DATABASE_URL REMOVED from its environment, so the API process never holds the owner login.
//
// Fails closed: if a migration or db:secure fails, the API is NOT started.
// Set AUTO_MIGRATE=false in .env to skip the owner steps (start the API only).
require('dotenv').config();
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const mask = (u) => u.replace(/:[^:@/]+@/, ':***@');

function run(label, cmd, env) {
  console.log(`\n[start-prod] ${label}`);
  const r = spawnSync(cmd, { cwd: root, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`[start-prod] ${label} FAILED (exit ${r.status}) - API not started.`);
    process.exit(1);
  }
}

// "Up to date" is the only answer that skips the backup; anything else (pending, failed, unreadable) backs up first.
function hasPendingMigrations(env) {
  const r = spawnSync('npx prisma migrate status', { cwd: root, env, shell: true, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const upToDate = /Database schema is up to date/i.test(out);
  console.log(`[start-prod] migrations: ${upToDate ? 'up to date' : 'pending (or status unreadable) - will back up first'}`);
  return !upToDate;
}

// Finds pg_dump: PG_DUMP_PATH, else PATH, else the newest C:\Program Files\PostgreSQL\<ver>\bin.
function findPgTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.PG_BIN_DIR) return path.join(process.env.PG_BIN_DIR, exe);
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (onPath.status === 0) return onPath.stdout.split(/\r?\n/)[0].trim();
  const base = 'C:\\Program Files\\PostgreSQL';
  if (fs.existsSync(base)) {
    const vers = fs.readdirSync(base).filter((v) => /^\d+/.test(v)).sort((a, b) => parseInt(b) - parseInt(a));
    for (const v of vers) {
      const p = path.join(base, v, 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Dump as trivo_backup (BYPASSRLS, read-only) - the owner/runtime roles would silently dump nothing under FORCE RLS.
// Fails closed: no verified backup, no migration.
function backupBeforeMigrating() {
  const src = (process.env.BACKUP_DATABASE_URL || '').trim();
  const pgDump = findPgTool('pg_dump');
  const pgRestore = findPgTool('pg_restore');
  if (!src || !pgDump || !pgRestore) {
    console.error('[start-prod] Cannot back up before migrating:');
    if (!src) console.error('  - BACKUP_DATABASE_URL is not set in .env (trivo_backup login)');
    if (!pgDump || !pgRestore) console.error('  - pg_dump/pg_restore not found (set PG_BIN_DIR in .env to the PostgreSQL bin folder)');
    console.error('[start-prod] Migration NOT run, API not started. (Set AUTO_BACKUP=false to migrate without a backup.)');
    process.exit(1);
  }
  const dir = path.resolve(root, process.env.BACKUP_DIR || 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(dir, `trivo_premigrate_${stamp}.dump`);
  // libpq rejects Prisma-only URL parameters
  const url = src.replace(/([?&])(schema|connection_limit|pool_timeout|connect_timeout|sslaccept|pgbouncer)=[^&]*&?/g, '$1').replace(/[?&]$/, '');
  console.log(`\n[start-prod] backing up to ${file}`);
  const dump = spawnSync(pgDump, [url, '-Fc', '-Z', '6', '--no-owner', '-f', file], { stdio: 'inherit' });
  if (dump.status !== 0) { try { fs.unlinkSync(file); } catch {} ; fail('pg_dump failed'); }
  const check = spawnSync(pgRestore, ['--list', file], { stdio: 'ignore' });
  if (check.status !== 0) fail('backup file is not readable');
  fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}\n`);
  console.log(`[start-prod] backup OK (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
  // keep the newest N pre-migration dumps
  const keep = parseInt(process.env.BACKUP_KEEP || '10', 10);
  const old = fs.readdirSync(dir).filter((f) => /^trivo_premigrate_.*\.dump$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) { fs.unlinkSync(path.join(dir, f)); try { fs.unlinkSync(path.join(dir, `${f}.sha256`)); } catch {} }
}
function fail(msg) {
  console.error(`[start-prod] ${msg} - migration NOT run, API not started.`);
  process.exit(1);
}

const ownerUrl = (process.env.OWNER_DATABASE_URL || '').trim();
const apiEnv = { ...process.env };
delete apiEnv.OWNER_DATABASE_URL; // the API never sees the owner login

if (process.env.AUTO_MIGRATE === 'false') {
  console.log('[start-prod] AUTO_MIGRATE=false - skipping migrations.');
} else if (!ownerUrl) {
  console.error('[start-prod] OWNER_DATABASE_URL is not set in .env - cannot check migrations. API not started.');
  console.error('[start-prod] (set AUTO_MIGRATE=false to start without migrating)');
  process.exit(1);
} else {
  console.log(`[start-prod] owner login: ${mask(ownerUrl)}`);
  const ownerEnv = { ...apiEnv, DATABASE_URL: ownerUrl };
  if (process.env.AUTO_BACKUP !== 'false' && hasPendingMigrations(ownerEnv)) backupBeforeMigrating();
  run('prisma migrate deploy (applies only what is pending)', 'npx prisma migrate deploy', ownerEnv);
  run('db:secure (re-apply RLS + grants)', 'npm run db:secure', ownerEnv);
}

console.log('\n[start-prod] starting API as runtime role');
const api = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], { cwd: root, env: apiEnv, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => api.kill(sig));
api.on('exit', (code) => process.exit(code ?? 0));
