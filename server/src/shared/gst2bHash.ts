// G2g-7e — deterministic canonicalization + SHA-256 hashing for GSTR-2B statement imports.
//
// Deliberately a SEPARATE, duplicated copy of the same two pure helpers `gstr1SnapshotHash.ts`
// (G2g-6b) already implements — not an import from that file. `gstr1SnapshotHash.ts` is part of
// the named-frozen "GSTR-1 filing snapshot" module (brief §28's frozen list); this phase's own
// module boundary stays independent of it rather than creating a cross-phase dependency on a
// frozen file for a few dozen lines of generic, pure logic. See that file for the identical
// algorithm and its own rationale (key-sorting objects only, never reordering arrays; Date ->
// ISO-8601; `undefined` omitted like `JSON.stringify`).
//
// Pure, synchronous, side-effect free: no Prisma, no Date.now(), no randomness, never mutates input.

import crypto from 'crypto';

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function canonicalizeForHash(value: unknown): CanonicalJson {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalizeForHash(v));
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    const out: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = canonicalizeForHash(v);
    }
    return out;
  }
  return value as CanonicalJson;
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 of raw bytes (e.g. the exact uploaded request body), hex-encoded. */
export function sha256HexBytes(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
