// GST Phase C — GSTIN validation service. Pure, synchronous, local/deterministic (no DB, no
// network) — the same posture as gstUqc.ts/compliance.ts's own reference-data helpers. Reused by
// (eventually) Customer Master, Supplier Master, Sales, Purchase, and the GSTIN lookup service
// below — one place, so a future consumer never re-derives this by hand.
//
// This is a superset of the simple 15-character regex check that already lives in
// company.service.ts (`assertValidGstin`, used only for CompanyGstRegistration — Phase G1, frozen).
// That existing check is deliberately left untouched here (out of this phase's scope) rather than
// refactored to call this module — see PHASE_C_GST_MASTER_SERVICES.md for why.
//
// COMPLIANCE CONFIRMATION REQUIRED (same posture as gstUqc.ts's own caveat): the structural rules
// and the check-digit algorithm below are reproduced from general public GST/GSTIN reference
// knowledge, not fetched from or verified against a live GSTN source at implementation time.
// Verify against a real, portal-verified GSTIN before relying on this for statutory filing
// decisions (e.g. rejecting a customer's GSTIN at billing time).

import { panFromGstin } from './compliance';

/**
 * The 2-digit GST state/UT codes that have ever been allotted, mirrored from the exact set
 * StateMaster is seeded with (prisma/migrations/20260824085712_add_state_master) so this module
 * never silently drifts from that table. Kept as a local constant (not a DB read) so
 * validateGstin() stays synchronous/deterministic, per this phase's "validation should be
 * local/deterministic" instruction.
 */
export const VALID_GST_STATE_CODES: ReadonlySet<string> = new Set([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16',
  '17', '18', '19', '20', '21', '22', '23', '24', '26', '27', '29', '30', '31', '32', '33', '34',
  '35', '36', '37', '38', '97', '99',
]);

// Base-36 alphabet a GSTIN's characters are drawn from — index IS the character's value in the
// check-digit algorithm below.
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Full structural shape: 2-digit state code, 10-char PAN (5 letters + 4 digits + 1 letter),
// 1-char entity/registration code (1-9 or A-Z — a dealer's 2nd+ registration in the same state on
// the same PAN uses A-Z here), a literal 'Z', then the 1-char checksum. Matches the equivalent
// regex already in company.service.ts's GSTIN_FORMAT — same shape, not reinvented.
const GSTIN_STRUCTURE = /^([0-9]{2})([A-Z]{5}[0-9]{4}[A-Z])([1-9A-Z])(Z)([0-9A-Z])$/;

export interface GstinValidationResult {
  valid: boolean;
  /** Normalized (trimmed + upper-cased) input, even when invalid — never the raw, unnormalized value. */
  gstin: string;
  stateCode?: string;
  pan?: string;
  entityCode?: string;
  errors: string[];
}

/** Trim + upper-case; null/undefined/'' all normalize to ''. Never throws. */
export function normalizeGstin(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().toUpperCase();
}

/**
 * GSTIN check-digit (character 15) — a base-36 Luhn-style checksum computed over characters 1-14.
 * Processes right-to-left with an alternating 2/1 multiplier, matching the algorithm published for
 * GSTIN verification (see the file-level compliance disclaimer above).
 */
function computeCheckDigit(first14: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]);
    let product = value * factor;
    factor = factor === 2 ? 1 : 2;
    product = Math.floor(product / 36) + (product % 36);
    sum += product;
  }
  const checkValue = (36 - (sum % 36)) % 36;
  return GSTIN_ALPHABET[checkValue];
}

/**
 * Validates a GSTIN's structure, state code, and check digit — never just its length. Always
 * returns a structured result (never throws); `errors` is empty iff `valid` is true.
 */
export function validateGstin(raw: unknown): GstinValidationResult {
  const gstin = normalizeGstin(raw);
  const errors: string[] = [];

  if (gstin === '') {
    return { valid: false, gstin, errors: ['GSTIN is required'] };
  }
  if (gstin.length !== 15) {
    errors.push(`GSTIN must be exactly 15 characters (got ${gstin.length})`);
    return { valid: false, gstin, errors };
  }

  // Every character must be from the GSTIN alphabet before the check-digit algorithm below can
  // mean anything — an out-of-alphabet character (e.g. a symbol) would make GSTIN_ALPHABET.indexOf
  // return -1 and silently corrupt the checksum rather than reporting the real problem.
  if (!/^[0-9A-Z]{15}$/.test(gstin)) {
    errors.push('GSTIN may only contain digits and upper-case letters');
    return { valid: false, gstin, errors };
  }

  const structureMatch = GSTIN_STRUCTURE.exec(gstin);
  const stateCode = gstin.slice(0, 2);
  const pan = panFromGstin(gstin) ?? gstin.slice(2, 12);
  const entityCode = gstin[12];

  if (!structureMatch) {
    // Report which specific segment broke, rather than one opaque "invalid format" message.
    if (!/^[0-9]{2}/.test(gstin)) errors.push('State code (characters 1-2) must be 2 digits');
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.push('PAN segment (characters 3-12) is not a valid PAN shape');
    if (!/^[1-9A-Z]$/.test(entityCode)) errors.push('Entity/registration code (character 13) must be 1-9 or A-Z');
    if (gstin[13] !== 'Z') errors.push("Character 14 must be 'Z'");
  }

  if (!VALID_GST_STATE_CODES.has(stateCode)) {
    errors.push(`"${stateCode}" is not a recognized GST state/UT code`);
  }

  const expectedCheckDigit = computeCheckDigit(gstin.slice(0, 14));
  if (gstin[14] !== expectedCheckDigit) {
    errors.push(`Checksum (character 15) is invalid — expected '${expectedCheckDigit}'`);
  }

  return {
    valid: errors.length === 0,
    gstin,
    stateCode,
    pan,
    entityCode,
    errors,
  };
}
