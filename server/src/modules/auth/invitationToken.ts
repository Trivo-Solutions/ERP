import crypto from 'crypto';

// An invitation token is `<companyId>.<secret>`.
//
// The companyId prefix is NOT a secret and grants nothing — the 256-bit random part is the
// credential. It exists so the PUBLIC accept endpoint (where the caller has no session and so no
// company context) can tell the database WHICH company's invitations to look in, letting the lookup
// run under that company's row-level security like every other tenant query instead of needing a
// database-wide bypass. A token whose company prefix is wrong simply finds nothing.
//
// Only the SHA-256 of the whole token is stored.

export function newInvitationToken(companyId: string): { token: string; tokenHash: string } {
  const token = `${companyId}.${crypto.randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Returns the company the token claims to belong to, or null if it is not even well-formed. */
export function parseInvitationToken(token: string): { companyId: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const companyId = token.slice(0, dot);
  if (!/^[a-z0-9]{20,32}$/.test(companyId)) return null;
  return { companyId };
}
