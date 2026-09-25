// Registers a company through the REAL operator HTTP API (front door :8080 -> API :3101).
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
// usage: node provision-http.js CODE "Name" admin@email "Admin Name" [stateCode]
const fs = require('fs');
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync(STAGING + '/staging.env'));
const [code, name, email, adminName, stateCode = '24'] = process.argv.slice(2);
const password = require('crypto').randomBytes(12).toString('base64url') + 'aA1!';
(async () => {
  const t0 = Date.now();
  const res = await fetch('http://localhost:8080/api/v1/platform/companies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trivo-platform-key': env.TRIVO_PLATFORM_API_KEY },
    body: JSON.stringify({ code, name, stateCode, gstin: '24AAAAA0000A1Z5', address: `${name}, Surat`, admin: { email, name: adminName, password } }),
  });
  const body = await res.json();
  console.log('HTTP', res.status, 'in', Date.now() - t0, 'ms');
  if (res.status !== 201) { console.log(JSON.stringify(body).slice(0, 400)); process.exit(1); }
  const d = body.data;
  fs.writeFileSync(`${HARNESS}/${code}.json`, JSON.stringify({ code, email, password, companyId: d.company.id, branchId: d.branch.id }, null, 2));
  console.log('company', d.company.code, d.company.id, 'starterPackageVersion', d.company.starterPackageVersion, 'steps', JSON.stringify(d.counts ?? d.starterPackage ?? {}).slice(0, 300));
})();
