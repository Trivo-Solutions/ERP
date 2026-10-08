// Test double for the native webcam helper: speaks the same NDJSON protocol v1, behaviour chosen by --scenario=<name>.
//   --devices=<file>  JSON array of {id,model,connection,placement?}, re-read on every request (tests add/remove cameras live)
//   --log=<file>      one line appended per shoot (proves "exactly one frame per capture")
const fs = require('fs'); const path = require('path'); const readline = require('readline');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const outIdx = process.argv.indexOf('--out-dir'); const outDir = process.argv[outIdx + 1];
const scenario = arg('scenario') || 'ok'; const log = arg('log'); const devFile = arg('devices');
const devices = () => (devFile ? JSON.parse(fs.readFileSync(devFile, 'utf8')) : [{ id: 'cam-aaaaaaaaaaaaaaaaaaaaaaaa', model: 'Integrated Camera', connection: 'usb', placement: 'integrated' }]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (scenario === 'badready') send({ event: 'ready', protocol: 99 }); else if (scenario !== 'silent') send({ event: 'ready', protocol: 1 });
let bound = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); const id = m.id;
  if (m.op === 'list') {
    if (scenario === 'nodriver') return send({ id, ok: false, failure: 'DRIVER_UNAVAILABLE' });
    if (scenario === 'dirtylist') return send({ id, ok: true, devices: [{ id: 'bad id', model: 'x', connection: 'usb' }] });
    return send({ id, ok: true, devices: scenario === 'nocam' ? [] : devices() });
  }
  if (m.op === 'connect') {
    if (!devices().some((d) => d.id === m.deviceId)) return send({ id, ok: false, failure: 'NO_CAMERA_FOUND' });
    bound = m.deviceId; return send({ id, ok: true });
  }
  if (m.op === 'close') { send({ id, ok: true }); return process.exit(0); }
  if (m.op !== 'shoot') return send({ id, ok: false, failure: 'PROTOCOL_ERROR' });
  if (!devices().some((d) => d.id === bound)) return send({ id, ok: false, failure: 'DEVICE_LOST' });
  if (log) fs.appendFileSync(log, `shot ${bound}\n`); // one line per frame actually taken
  switch (scenario) {
    case 'hang': return;
    case 'shutterfail': return send({ id, ok: false, failure: 'SHUTTER_FAILED' });
    case 'busy': return send({ id, ok: false, failure: 'CAMERA_BUSY' });
    case 'badjson': return process.stdout.write('not json\n');
    case 'rawerror': return send({ id, ok: false, failure: 'MF_E_HW_MFT_FAILED_START_STREAMING 0xC00D3EA2 C:/secret/usb#vid_5986' });
    case 'crash': return process.exit(3);
    case 'lost': send({ event: 'disconnected' }); return process.exit(0);
    case 'wrongid': return send({ id: id + 5, ok: true });
    case 'notjpeg': fs.writeFileSync(path.join(outDir, m.file), Buffer.from('hello world')); return send({ id, ok: true, file: m.file, width: 10, height: 5 });
    case 'escape': return send({ id, ok: true, file: '../evil.jpg', width: 10, height: 5 });
    default: fs.writeFileSync(path.join(outDir, m.file), JPEG); return send({ id, ok: true, file: m.file, width: 1920, height: 1080 });
  }
});
process.stdin.on('end', () => process.exit(0));
