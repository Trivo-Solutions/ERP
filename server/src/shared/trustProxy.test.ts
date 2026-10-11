import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { parseTrustProxy } from './trustProxy';

// Resolves what Express reports as req.ip for a request that arrives from loopback carrying the given X-Forwarded-For.
async function resolvedIp(setting: string | undefined, xff?: string): Promise<string> {
  const app = express();
  const parsed = parseTrustProxy(setting);
  if (parsed !== undefined) app.set('trust proxy', parsed);
  app.get('/ip', (req, res) => res.send(req.ip));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/ip', headers: xff ? { 'x-forwarded-for': xff } : {} }, (res) => {
        let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('parseTrustProxy', () => {
  it('leaves proxy trust off when unset or blank', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('')).toBeUndefined();
    expect(parseTrustProxy('   ')).toBeUndefined();
  });

  it('reads numeric values as hop counts (regression: the regex lacked a backslash, so "2" stayed a string)', () => {
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(parseTrustProxy('10')).toBe(10);
  });

  it('reads true / false as booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('keeps accepting named ranges and IP / CIDR lists, unchanged', () => {
    expect(parseTrustProxy('loopback,uniquelocal')).toBe('loopback,uniquelocal');
    expect(parseTrustProxy('loopback, uniquelocal')).toBe('loopback,uniquelocal');
    expect(parseTrustProxy('linklocal')).toBe('linklocal');
    expect(parseTrustProxy('10.0.0.0/8,172.16.0.0/12,192.168.1.5')).toBe('10.0.0.0/8,172.16.0.0/12,192.168.1.5');
    expect(parseTrustProxy('::1,fc00::/7')).toBe('::1,fc00::/7');
  });

  it.each([
    'abc', '1,2', '-1', '1.5', '11', '99999999999999999999', 'loopback,', ',loopback', 'loopback uniquelocal',
    '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/8/8', '::1/129', '300.1.1.1', 'TRUE', 'yes', '0x10',
  ])('rejects the malformed value %j instead of silently misconfiguring', (bad) => {
    expect(() => parseTrustProxy(bad)).toThrow(/TRUST_PROXY/);
  });
});

describe('trust proxy as Express applies it', () => {
  const forgedThenReal = '6.6.6.6, 203.0.113.9'; // a forged leftmost value, then the client address the first proxy appended

  it('ignores X-Forwarded-For entirely when unset (API exposed directly)', async () => {
    expect(await resolvedIp(undefined, forgedThenReal)).toMatch(/127\.0\.0\.1/);
  });

  it('a hop count of 1 trusts only the immediate peer: the real client wins, a forged prefix is ignored', async () => {
    expect(await resolvedIp('1', forgedThenReal)).toBe('203.0.113.9');
  });

  it('a hop count of 2 is genuinely applied (before the fix it was ignored and req.ip was the proxy)', async () => {
    expect(await resolvedIp('2', forgedThenReal)).toBe('6.6.6.6');
    expect(await resolvedIp('2', '203.0.113.9, 172.18.0.1')).toBe('203.0.113.9');
  });

  it('loopback,uniquelocal resolves the real client through private hops and ignores a forged prefix', async () => {
    expect(await resolvedIp('loopback,uniquelocal', forgedThenReal)).toBe('203.0.113.9');
    expect(await resolvedIp('loopback,uniquelocal', '6.6.6.6, 203.0.113.9, 172.18.0.1')).toBe('203.0.113.9');
    expect(await resolvedIp('loopback,uniquelocal', '203.0.113.9, 172.18.0.1')).toBe('203.0.113.9');
  });

  it('different real clients behind the same proxy get different identities (separate rate-limit buckets)', async () => {
    const a = await resolvedIp('loopback,uniquelocal', '203.0.113.9');
    const b = await resolvedIp('loopback,uniquelocal', '198.51.100.7');
    expect(a).not.toBe(b);
  });

  it('a public peer is never trusted by the private-range list', async () => {
    // (the peer here is loopback, so emulate an untrusted list instead: only a public CIDR is trusted)
    expect(await resolvedIp('198.51.100.0/24', forgedThenReal)).toMatch(/127\.0\.0\.1/);
  });
});
