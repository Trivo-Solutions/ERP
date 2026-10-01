// GST Phase D — UQC (Unit Quantity Code) Compliance Validation Layer.
// Builds directly on top of Phase C / G2's shared/gstUqc.ts without modifying it
// or touching any frozen GSTR-1 normalization logic.
//
// Supports:
// - valid UQC (matches official catalog exactly)
// - normalized UQC (valid after case/whitespace trimming)
// - missing UQC (null / undefined / empty string)
// - invalid / unsupported UQC (unrecognized code or informal unit name)

import { GST_UQC_CODES, GstUqc, isValidGstUqc, normalizeGstUqc } from './gstUqc';

export type UqcValidationStatus =
  | 'VALID'
  | 'NORMALIZED'
  | 'MISSING'
  | 'INVALID'
  | 'UNSUPPORTED';

export interface UqcValidationIssue {
  code: string;
  field: 'uqc';
  message: string;
}

export interface UqcValidationResult {
  valid: boolean;
  status: UqcValidationStatus;
  rawInput: unknown;
  canonicalCode: GstUqc | null;
  issue: UqcValidationIssue | null;
}

// Known common informal/legacy units mapped to their standard GST UQC equivalent or noted as unsupported
const COMMON_INFORMAL_UQC_MAP: Record<string, GstUqc> = {
  GRAM: 'GMS',
  GRAMS: 'GMS',
  GM: 'GMS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  PC: 'PCS',
  NUMBER: 'NOS',
  NUMBERS: 'NOS',
  NO: 'NOS',
  KILOGRAM: 'KGS',
  KILOGRAMS: 'KGS',
  KG: 'KGS',
  KGM: 'KGS',
  PAIR: 'PRS',
  PAIRS: 'PRS',
  SET: 'SET',
  SETS: 'SET',
  METER: 'MTR',
  METERS: 'MTR',
  LITRE: 'LTR',
  LITRES: 'LTR',
  BOXES: 'BOX',
};

/**
 * Validates a Unit Quantity Code (UQC) against the official GST master.
 * Distinguishes valid, normalized, missing, invalid, and unsupported codes.
 */
export function validateUqc(rawInput: unknown): UqcValidationResult {
  if (rawInput === undefined || rawInput === null || rawInput === '') {
    return {
      valid: false,
      status: 'MISSING',
      rawInput,
      canonicalCode: null,
      issue: {
        code: 'MISSING_UQC',
        field: 'uqc',
        message: 'Unit Quantity Code (UQC) is required for GST item/invoice reporting',
      },
    };
  }

  if (typeof rawInput !== 'string') {
    return {
      valid: false,
      status: 'INVALID',
      rawInput,
      canonicalCode: null,
      issue: {
        code: 'INVALID_UQC_TYPE',
        field: 'uqc',
        message: 'UQC must be a text code',
      },
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed === '') {
    return {
      valid: false,
      status: 'MISSING',
      rawInput,
      canonicalCode: null,
      issue: {
        code: 'MISSING_UQC',
        field: 'uqc',
        message: 'Unit Quantity Code (UQC) cannot be blank',
      },
    };
  }

  // 1. Exact match with catalog
  if (isValidGstUqc(trimmed)) {
    return {
      valid: true,
      status: 'VALID',
      rawInput,
      canonicalCode: trimmed,
      issue: null,
    };
  }

  // 2. Case / whitespace normalized match
  const normalized = normalizeGstUqc(trimmed);
  if (normalized) {
    return {
      valid: true,
      status: 'NORMALIZED',
      rawInput,
      canonicalCode: normalized,
      issue: {
        code: 'UQC_NORMALIZED',
        field: 'uqc',
        message: `UQC "${rawInput}" normalized to standard uppercase code "${normalized}"`,
      },
    };
  }

  // 3. Informal / unstandardized unit check
  const upper = trimmed.toUpperCase();
  const mapped = COMMON_INFORMAL_UQC_MAP[upper];
  if (mapped) {
    return {
      valid: false,
      status: 'UNSUPPORTED',
      rawInput,
      canonicalCode: mapped,
      issue: {
        code: 'UNSUPPORTED_UQC',
        field: 'uqc',
        message: `"${rawInput}" is not an official GST UQC. Recommended standard code is "${mapped}"`,
      },
    };
  }

  // 4. Completely unrecognized code
  return {
    valid: false,
    status: 'INVALID',
    rawInput,
    canonicalCode: null,
    issue: {
      code: 'INVALID_UQC',
      field: 'uqc',
      message: `"${rawInput}" is not a recognized GST Unit Quantity Code. Must be one of the standard GST UQC codes (e.g. GMS, PCS, NOS)`,
    },
  };
}

export { GST_UQC_CODES, GstUqc, isValidGstUqc, normalizeGstUqc };
