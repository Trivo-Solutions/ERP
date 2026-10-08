// Test double for the native Sony helper: speaks the NDJSON protocol, behaviour chosen by --scenario=<name>.
// Shot counter is appended to SHOT_LOG (path in --log=) so tests can prove "exactly one shutter".
const fs = require('fs'); const path = require('path'); const readline = require('readline');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const outIdx = process.argv.indexOf('--out-dir'); const outDir = process.argv[outIdx + 1];
const scenario = arg('scenario') || 'ok'; const log = arg('log');
const devices = scenario === 'multi' ? [{ id: 'A1', model: 'ILCE-7RM5', connection: 'usb' }, { id: 'B2', model: 'ILCE-7RM5', connection: 'usb' }]
  : scenario === 'nocam' ? [] : [{ id: 'A1', model: 'ILCE-7RM5', connection: 'usb' }];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (scenario === 'badready') send({ event: 'ready', protocol: 99 }); else if (scenario !== 'silent') send({ event: 'ready', protocol: 1 });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); const id = m.id;
  if (m.op === 'list') return send({ id, ok: true, devices });
  if (m.op === 'connect') return send(scenario === 'reject' ? { id, ok: false, failure: 'CONNECT_REJECTED' } : { id, ok: true });
  if (m.op === 'close') { send({ id, ok: true }); return process.exit(0); }
  if (m.op !== 'shoot') return;
  if (log) fs.appendFileSync(log, 'shot\n');
  switch (scenario) {
    case 'hang': return;
    case 'busy': return send({ id, ok: false, failure: 'CAMERA_BUSY' });
    case 'shutterfail': return send({ id, ok: false, failure: 'SHUTTER_FAILED' });
    case 'badjson': return process.stdout.write('not json\n');
    case 'unknownfailure': return send({ id, ok: false, failure: 'SDK ERROR 0x8704 C:/secret' });
    case 'crash': return process.exit(3);
    case 'lost': send({ event: 'disconnected' }); return process.exit(0);
    case 'wrongid': return send({ id: id + 5, ok: true });
    case 'nofile': return send({ id, ok: true, file: m.file, width: 10, height: 5 });
    case 'notjpeg': fs.writeFileSync(path.join(outDir, m.file), Buffer.from('hello world')); return send({ id, ok: true, file: m.file, width: 10, height: 5 });
    case 'baddims': fs.writeFileSync(path.join(outDir, m.file), JPEG); return send({ id, ok: true, file: m.file, width: -1, height: 5 });
    case 'escape': return send({ id, ok: true, file: '../evil.jpg', width: 10, height: 5 });
    default: fs.writeFileSync(path.join(outDir, m.file), JPEG); return send({ id, ok: true, file: m.file, width: 8000, height: 5320 });
  }
});
process.stdin.on('end', () => process.exit(0));
