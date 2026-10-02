// G8a — application-level encryption for integration credentials (brief §7). No encryption helper
// existed anywhere in this codebase before this phase (verified: no `encrypt(`/`decrypt(` helper
// under server/src) — this is the smallest reusable abstraction the phase actually needs, not a
// general-purpose crypto library. Standard primitives only (AES-256-GCM via Node's built-in
// `crypto`) — no invented cipher construction (brief §27).
//
// The key NEVER lives in the database and is NEVER logged — it comes only from
// env.GST_INTEGRATION_ENCRYPTION_KEY (config/env.ts), which is itself validated at process start
// (min 32 chars) and otherwise left unset, same "declared but unconfigured" posture as every other
// optional provider credential in env.ts. A raw passphrase of any length ≥32 chars is reduced to an
// exact 32-byte AES-256 key via SHA-256 (a deterministic, standard KDF step — not a cipher of our
// own invention).
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';
import { AppError } from '../../../middleware/error';
import { env } from '../../../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit GCM nonce, the NIST-recommended size

function deriveKey(): Buffer {
  if (!env.GST_INTEGRATION_ENCRYPTION_KEY) {
    throw new AppError('GST integration encryption key is not configured (GST_INTEGRATION_ENCRYPTION_KEY) — cannot store or read integration credentials', 503);
  }
  return createHash('sha256').update(env.GST_INTEGRATION_ENCRYPTION_KEY).digest();
}

/** True once a real key is configured — callers use this to fail a create/update cleanly rather than racing into encrypt(). */
export function isEncryptionConfigured(): boolean {
  return !!env.GST_INTEGRATION_ENCRYPTION_KEY;
}

/** Encrypts one plaintext credential value. Output format: "<iv>:<authTag>:<ciphertext>", each base64. */
export function encryptCredentialValue(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypts a value produced by encryptCredentialValue. Throws (never returns a guess) on any tamper/format mismatch. */
export function decryptCredentialValue(stored: string): string {
  const key = deriveKey();
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new AppError('Stored credential value is not in the expected encrypted format', 500);
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Never leak WHY decryption failed (padding oracle-adjacent) — wrong key, tampered
    // ciphertext, and corruption all look identical from the outside.
    throw new AppError('Failed to decrypt stored credential value', 500);
  }
}
