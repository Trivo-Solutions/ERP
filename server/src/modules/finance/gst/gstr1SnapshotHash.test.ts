import { describe, it, expect } from 'vitest';
import { canonicalizeForHash, canonicalJsonString, sha256Hex } from './gstr1SnapshotHash';

// G2g-6b — canonicalization + SHA-256 hashing. Pure unit tests, no database, no fixtures: proves
// the two properties the snapshot builder's integrity depends on — (1) object key order never
// affects the canonical form/hash, (2) array element order ALWAYS does (GSTN array order is
// semantically meaningful — see this file's own header) — plus ordinary SHA-256 determinism.
describe('G2g-6b: gstr1SnapshotHash', () => {
  describe('canonicalizeForHash / canonicalJsonString', () => {
    it('recursively sorts object keys', () => {
      const a = { b: 2, a: 1 };
      const b = { a: 1, b: 2 };
      expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
      expect(canonicalJsonString(a)).toBe('{"a":1,"b":2}');
    });

    it('sorts nested object keys at every level', () => {
      const nested = { z: { y: 2, x: 1 }, a: 1 };
      expect(canonicalJsonString(nested)).toBe('{"a":1,"z":{"x":1,"y":2}}');
    });

    it('preserves array order — does NOT sort array elements', () => {
      const arr = [3, 1, 2];
      expect(canonicalJsonString(arr)).toBe('[3,1,2]');
    });

    it('preserves the order of objects inside an array (never reorders by content)', () => {
      const arr = [{ id: 'b' }, { id: 'a' }];
      expect(canonicalJsonString(arr)).toBe('[{"id":"b"},{"id":"a"}]');
    });

    it('two equivalent objects (differing only in key order) produce identical canonical JSON and hash', () => {
      const objA = { metadata: { gstin: 'X', b2b: [{ num: 1 }] }, version: 2 };
      const objB = { version: 2, metadata: { b2b: [{ num: 1 }], gstin: 'X' } };
      expect(canonicalJsonString(objA)).toBe(canonicalJsonString(objB));
      expect(sha256Hex(canonicalJsonString(objA))).toBe(sha256Hex(canonicalJsonString(objB)));
    });

    it('array [A, B] does NOT hash identically to array [B, A] when ordering is semantically retained', () => {
      const A = { id: 'A' };
      const B = { id: 'B' };
      const forward = canonicalJsonString([A, B]);
      const reversed = canonicalJsonString([B, A]);
      expect(forward).not.toBe(reversed);
      expect(sha256Hex(forward)).not.toBe(sha256Hex(reversed));
    });

    it('a meaningful content change (not just key order) changes the hash', () => {
      const base = canonicalJsonString({ a: 1, b: 2 });
      const changed = canonicalJsonString({ a: 1, b: 3 });
      expect(sha256Hex(base)).not.toBe(sha256Hex(changed));
    });

    it('converts Date to its ISO-8601 string, matching JSON.stringify\'s own native conversion', () => {
      const d = new Date('2026-09-01T00:00:00.000Z');
      expect(canonicalJsonString({ when: d })).toBe(JSON.stringify({ when: d }));
    });

    it('omits undefined-valued object properties, matching JSON.stringify\'s own semantics', () => {
      const withUndefined = { a: 1, b: undefined };
      expect(canonicalJsonString(withUndefined)).toBe(JSON.stringify(withUndefined));
    });

    it('never mutates the input value', () => {
      const original = { b: 2, a: 1, nested: { y: 1, x: 2 } };
      const snapshot = JSON.parse(JSON.stringify(original));
      canonicalizeForHash(original);
      expect(original).toEqual(snapshot);
      expect(Object.keys(original)).toEqual(['b', 'a', 'nested']); // key insertion order itself untouched
    });

    it('null and undefined both canonicalize to null', () => {
      expect(canonicalJsonString(null)).toBe('null');
      expect(canonicalizeForHash(undefined)).toBeNull();
    });
  });

  describe('sha256Hex', () => {
    it('produces known, reproducible SHA-256 digests (fixed vectors, independently computed via Node\'s own crypto module)', () => {
      expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(sha256Hex('trivo')).toBe('aa66c5fbc375e0afe06e6aa5accf245bc30fdc63a4eb80dec71a96899d33ef40');
    });

    it('is deterministic: the same input always produces the same hex digest', () => {
      const input = 'gstr1-filing-snapshot-determinism-check';
      expect(sha256Hex(input)).toBe(sha256Hex(input));
    });

    it('two different inputs produce different digests (no accidental collision in this small sample)', () => {
      expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
    });

    it('always returns a 64-character lowercase hex string', () => {
      const h = sha256Hex('any input');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
