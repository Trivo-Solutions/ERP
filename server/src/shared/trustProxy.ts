import net from 'net';

// Parses the TRUST_PROXY setting into the value handed to Express's `trust proxy`.
//
//   unset / ''          -> undefined  (do not trust any forwarded header: the API is exposed directly)
//   '1', '2', ...       -> a hop count: trust exactly that many proxies in front of the API
//   'false' / 'true'    -> boolean ('true' trusts EVERY hop, so a caller can forge its own address — avoid in production)
//   'loopback,10.0.0.0/8' -> a comma-separated list of named ranges (loopback, linklocal, uniquelocal), IPs or CIDRs
//
// Anything else is a configuration mistake and throws, so a typo stops the server at start-up instead of silently
// trusting nothing (every company then shares one rate-limit bucket) or the wrong thing (forgeable client IPs).

export type TrustProxySetting = number | boolean | string;

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 10;

export function parseTrustProxy(raw: string | undefined): TrustProxySetting | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '') return undefined;

  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (!Number.isSafeInteger(hops) || hops > MAX_HOPS) {
      throw new Error(`TRUST_PROXY hop count must be between 0 and ${MAX_HOPS}, got "${v}"`);
    }
    return hops;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;

  const tokens = v.split(',').map((t) => t.trim());
  for (const token of tokens) {
    if (NAMED_RANGES.has(token)) continue;
    const [addr, prefix, ...extra] = token.split('/');
    const family = net.isIP(addr);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (!family || extra.length > 0 || !prefixOk) {
      throw new Error(`TRUST_PROXY has an invalid entry "${token}" (expected a hop count, true/false, loopback/linklocal/uniquelocal, or an IP/CIDR list)`);
    }
  }
  return tokens.join(',');
}
