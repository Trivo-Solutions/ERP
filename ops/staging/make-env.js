// Generates C:/trivo-staging/staging.env (secrets stay in the file; nothing is printed) and adds TLS to rlstest.env.
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
const fs = require('fs');
const crypto = require('crypto');
const roles = require('./roles.json');
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const q = 'schema=public&sslmode=require&sslaccept=accept_invalid_certs';
const url = (role, pw, db, extra = '') => `postgresql://${role}:${pw}@localhost:54329/${db}?${q}${extra}`;

const existing = fs.existsSync(STAGING + '/staging.env') ? fs.readFileSync(STAGING + '/staging.env', 'utf8') : '';
const keep = (k, gen) => (existing.match(new RegExp(`^${k}="?([^"\\n]+)"?$`, 'm')) || [])[1] || gen();

const env = `NODE_ENV=production
PORT=3101
CLIENT_URL=http://localhost:8080
DATABASE_URL="${url('trivo_runtime', roles.runtime, 'trivo_staging', '&connection_limit=20&pool_timeout=10&connect_timeout=5')}"
PLATFORM_DATABASE_URL="${url('trivo_platform', roles.platform, 'trivo_staging', '&connection_limit=5&pool_timeout=10&connect_timeout=5')}"
OWNER_DATABASE_URL="${url('trivo_owner', roles.owner, 'trivo_staging')}"
JWT_SECRET="${keep('JWT_SECRET', () => rnd(48))}"
JWT_REFRESH_SECRET="${keep('JWT_REFRESH_SECRET', () => rnd(48))}"
TRIVO_PLATFORM_API_KEY="${keep('TRIVO_PLATFORM_API_KEY', () => rnd(48))}"
`;
fs.writeFileSync(STAGING + '/staging.env', env);

// rlstest.env: same cluster, so add TLS to its URLs too (idempotent)
let r = fs.readFileSync(STAGING + '/rlstest.env', 'utf8');
if (!r.includes('sslmode=')) r = r.replace(/schema=public/g, q);
fs.writeFileSync(STAGING + '/rlstest.env', r);
console.log('env written');
