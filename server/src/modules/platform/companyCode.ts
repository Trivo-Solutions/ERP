// Company codes are used as the first factor of login (Company Code + username/email + password),
// so they must be unique, normalized, easy to type and hard to confuse with each other.
//
//   format        3-12 characters, A-Z and 0-9 only, starting with a letter. Stored UPPER-CASE
//                 (login uppercases whatever it is given, so a lower-case stored code could never
//                 be matched).
//   reserved      words that would be confusing or could be mistaken for platform routes/roles.
//   confusable    "VASAV1" / "VASAVI", "SEA0" / "SEAO" and similar look-alikes are treated as the
//                 same code so one company can't be impersonated by a near-identical one.

export const COMPANY_CODE_PATTERN = /^[A-Z][A-Z0-9]{2,11}$/;

export const RESERVED_COMPANY_CODES: ReadonlySet<string> = new Set([
  'ADMIN', 'ADMINISTRATOR', 'API', 'APP', 'AUTH', 'LOGIN', 'LOGOUT', 'ROOT', 'SYSTEM', 'SYS',
  'TRIVO', 'PLATFORM', 'SUPPORT', 'HELP', 'BILLING', 'STAGING', 'PROD', 'PRODUCTION', 'DEV',
  'TEST', 'DEMO', 'SANDBOX', 'NULL', 'NONE', 'UNDEFINED', 'TRUE', 'FALSE', 'WWW', 'MAIL', 'SMTP',
  'DEFAULT', 'PUBLIC', 'INTERNAL', 'OPERATOR', 'OPERATIONS', 'SECURITY', 'AUDIT', 'DATABASE', 'DB',
]);

/** Trim + upper-case. Used by login too, so what a user types and what is stored compare equal. */
export function normalizeCompanyCode(input: string): string {
  return String(input ?? '').trim().toUpperCase();
}

/** Look-alike folding: 0→O, 1→I, L→I, 5→S, 8→B (so e.g. VASAV1, VASAVL and VASAVI collide). */
export function confusableKey(code: string): string {
  return normalizeCompanyCode(code).replace(/0/g, 'O').replace(/[1L]/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
}

export type CompanyCodeCheck =
  | { ok: true; code: string }
  | { ok: false; reason: 'FORMAT' | 'RESERVED' };

export function validateCompanyCodeFormat(input: string): CompanyCodeCheck {
  const code = normalizeCompanyCode(input);
  if (!COMPANY_CODE_PATTERN.test(code)) return { ok: false, reason: 'FORMAT' };
  if (RESERVED_COMPANY_CODES.has(code)) return { ok: false, reason: 'RESERVED' };
  return { ok: true, code };
}

/** True if `code` (or a look-alike of it) already belongs to one of `existingCodes`. */
export function collidesWithExisting(code: string, existingCodes: string[]): boolean {
  const key = confusableKey(code);
  return existingCodes.some((c) => confusableKey(c) === key);
}
