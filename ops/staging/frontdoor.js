// Staging stand-in for client/nginx.conf: serves the built SPA (with index.html fallback) and reverse-proxies
// (staging harness — set TRIVO_STAGING_DIR to the directory holding staging.env / rlstest.env; default ./.staging)
const STAGING = process.env.TRIVO_STAGING_DIR || require("path").resolve(__dirname, ".staging");
const HARNESS = STAGING + "/harness";
// /api/ and /socket.io/ (including WebSocket upgrades) to the API — same-origin, exactly like production.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.TRIVO_CLIENT_DIST || path.resolve(__dirname, '../../client/dist'));
const API = { host: '127.0.0.1', port: 3101 };
const PORT = 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const proxyable = (u) => u.startsWith('/api/') || u.startsWith('/socket.io/');

const server = http.createServer((req, res) => {
  if (proxyable(req.url)) {
    const up = http.request({ ...API, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http' } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('bad gateway'); });
    req.pipe(up);
    return;
  }
  let file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// WebSocket upgrade passthrough (socket.io)
server.on('upgrade', (req, socket, head) => {
  if (!proxyable(req.url)) return socket.destroy();
  const up = http.request({ ...API, method: req.method, path: req.url, headers: req.headers });
  up.on('upgrade', (r, upSocket, upHead) => {
    const lines = [`HTTP/1.1 101 Switching Protocols`, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), '', ''];
    socket.write(lines.join('\r\n'));
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket); socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy());
  });
  up.on('error', () => socket.destroy());
  up.end(head);
});
server.listen(PORT, () => console.log('front door on http://localhost:' + PORT));
