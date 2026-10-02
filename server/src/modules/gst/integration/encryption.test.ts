import { describe, it, expect } from 'vitest';
import { encryptCredentialValue, decryptCredentialValue, isEncryptionConfigured } from './encryption';
import { env } from '../../../config/env';

describe('G8a encryption: credential values are never stored in plaintext', () => {
  it('is configured in the test environment (.env.test sets a placeholder key)', () => {
    expect(isEncryptionConfigured()).toBe(true);
  });

  it('round-trips a plaintext value through encrypt/decrypt', () => {
    const plaintext = 'super-secret-client-secret-value';
    const encrypted = encryptCredentialValue(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptCredentialValue(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext for the same plaintext each time (random IV)', () => {
    const a = encryptCredentialValue('same-value');
    const b = encryptCredentialValue('same-value');
    expect(a).not.toBe(b);
    expect(decryptCredentialValue(a)).toBe('same-value');
    expect(decryptCredentialValue(b)).toBe('same-value');
  });

  it('is in the documented "<iv>:<authTag>:<ciphertext>" base64 shape', () => {
    const encrypted = encryptCredentialValue('shape-check');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(() => Buffer.from(p, 'base64')).not.toThrow();
  });

  it('throws rather than decrypting tampered ciphertext (GCM auth tag fails)', () => {
    const encrypted = encryptCredentialValue('tamper-me');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const tamperedCiphertextByte = Buffer.from(ciphertext, 'base64');
    tamperedCiphertextByte[0] = tamperedCiphertextByte[0] ^ 0xff;
    const tampered = `${iv}:${authTag}:${tamperedCiphertextByte.toString('base64')}`;
    expect(() => decryptCredentialValue(tampered)).toThrow();
  });

  it('throws rather than decrypting a malformed stored value', () => {
    expect(() => decryptCredentialValue('not-the-right-shape')).toThrow();
  });

  it('refuses to encrypt/decrypt when the key is unset — never silently falls back to plaintext', () => {
    const original = env.GST_INTEGRATION_ENCRYPTION_KEY;
    try {
      (env as any).GST_INTEGRATION_ENCRYPTION_KEY = undefined;
      expect(isEncryptionConfigured()).toBe(false);
      expect(() => encryptCredentialValue('anything')).toThrow();
    } finally {
      (env as any).GST_INTEGRATION_ENCRYPTION_KEY = original;
    }
  });
});
