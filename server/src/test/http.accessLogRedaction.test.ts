import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { accessLogMiddleware } from '../shared/accessLog';

// Drives the real access-log middleware (the function app.ts mounts) and reads what it actually emits. The sentinels
// are obviously fake and are never printed: the assertions only report that one was or was not found.
const NAME = 'ZzSentinelName';
const MOBILE = '9000000000';

function loggedApp() {
  const lines: string[] = [];
  const app = express();
  app.use(accessLogMiddleware((l) => lines.push(l)));
  const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  app.get('/api/v1/estimation/customers', ok);
  app.get('/api/v1/estimation/tags/search', ok);
  return { app, lines };
}
const leaked = (lines: string[]) => lines.some((l) => l.includes(NAME) || l.includes(MOBILE));

describe('HTTP access log: customer-search query values never reach the log', () => {
  for (const [label, url] of [
    ['normal path', `/api/v1/estimation/customers?q=${NAME}`],
    ['mobile', `/api/v1/estimation/customers?q=${MOBILE}`],
    ['trailing slash', `/api/v1/estimation/customers/?q=${NAME}`],
    ['letter case', `/API/V1/Estimation/Customers?q=${NAME}`],
    ['repeated q', `/api/v1/estimation/customers?q=${NAME}&q=${MOBILE}`],
    ['other params', `/api/v1/estimation/customers?x=1&q=${MOBILE}`],
  ] as const) {
    it(`redacts: ${label}`, async () => {
      const { app, lines } = loggedApp();
      await request(app).get(url);
      expect(lines.length).toBe(1);               // the request is still logged...
      expect(lines[0]).toContain('[redacted]');   // ...with the query replaced
      expect(leaked(lines)).toBe(false);
    });
  }

  it('still logs other requests normally, query string included', async () => {
    const { app, lines } = loggedApp();
    await request(app).get('/api/v1/estimation/tags/search?q=ring');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('GET /api/v1/estimation/tags/search?q=ring');
    expect(lines[0]).toContain('200');
  });

  it('honours skip (the test-env switch app.ts uses)', async () => {
    const lines: string[] = [];
    const app = express();
    app.use(accessLogMiddleware((l) => lines.push(l), () => true));
    app.get('/x', (_q, r) => r.send('ok'));
    await request(app).get('/x');
    expect(lines).toEqual([]);
  });

  it('app.ts mounts this middleware and has no second, unredacted request logger', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');
    expect(src).toContain('accessLogMiddleware(');
    expect(src).not.toMatch(/from 'morgan'|morgan\(/);
  });
});
