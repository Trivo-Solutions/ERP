// G2g-6b — deterministic canonicalization + SHA-256 hashing for GSTR-1 filing snapshots.
//
// Pure, synchronous, side-effect free: no Prisma, no Date.now(), no randomness, never mutates its
// input. Canonicalization recursively sorts OBJECT keys only — arrays are NEVER reordered. Array
// order is semantically meaningful in several GSTN structures this codebase's own frozen pipeline
// already relies on (e.g. gstr1GstnAdapter.ts's traceability id arrays, gstr1GstnSerializer.ts's
// per-document `itms[]` built in a specific, meaningful sequence) — reordering them here would
// silently change what the canonical representation means, not just how it's spelled.
//
// Two objects that differ only in key insertion order canonicalize to the identical string (and
// therefore hash identically); two arrays that differ only in element order do NOT.

import crypto from 'crypto';

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Recursively sorts object keys (locale-independent, ordinal `Array.prototype.sort`'s own default —
 * stable and deterministic for any fixed input); preserves array element order; converts a `Date` to
 * its ISO-8601 string (the exact conversion `JSON.stringify` already applies to a `Date` anywhere
 * else in this codebase — never a second, divergent date-formatting convention introduced here).
 * `undefined` (a value, or an object property) canonicalizes to being omitted, matching
 * `JSON.stringify`'s own native semantics, so the output of this function and of
 * `JSON.stringify(canonicalizeForHash(x))` always agree key-for-key. Never mutates `value`.
 */
export function canonicalizeForHash(value: unknown): CanonicalJson {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalizeForHash(v));
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    const out: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue; // omitted, never written as null — matches JSON.stringify's own object-property semantics
      out[key] = canonicalizeForHash(v);
    }
    return out;
  }
  return value as CanonicalJson;
}

/** The exact string this module hashes: `JSON.stringify` over the canonicalized (sorted-keys,
 *  original-array-order) form. Deterministic for any fixed input — same input always produces the
 *  same string, byte for byte. */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

/** SHA-256 of a UTF-8 string, hex-encoded — this codebase's existing convention (see
 *  `modules/auth/invitationToken.ts: hashInvitationToken`), reused rather than a new one invented
 *  here. Never MD5/SHA-1/a random id/a timestamp standing in for a hash. */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
