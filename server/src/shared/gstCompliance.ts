// GST Phase D — GST Compliance Validation Engine.
// Integrates GSTIN, HSN/SAC, UQC, and AATO rules into a single reusable compliance interface.
//
// Complies with:
// - Phase C GSTIN validation (structural + checksum verification)
// - Phase C HSN/SAC service (lookup against master)
// - GST Notification No. 78/2020 (AATO > ₹5 Cr requires min 6-digit HSN; AATO <= ₹5 Cr requires min 4-digit HSN)
// - GST UQC standard code catalog
//
// Structured Output Contract:
// {
//   valid: boolean,
//   errors: ComplianceIssue[],
//   warnings: ComplianceIssue[],
//   info: ComplianceIssue[],
// }
// Each issue contains: { code: string, field: string, message: string }

import { prisma } from '../config/database';
import { validateGstin, GstinValidationResult } from './gstin';
import { getHSN, getSAC, HsnSacCodeType, HsnSacCode } from './hsnSac';
import { validateUqc, UqcValidationResult } from './gstUqcValidation';

export const AATO_5CR_THRESHOLD = 50_000_000; // 5 Crores in INR

export type AatoApplicabilityState =
  | 'PRECEDING_FY_AATO_VERIFIED'
  | 'PRECEDING_FY_AATO_UNVERIFIED'
  | 'PRECEDING_FY_AATO_MISSING';

export interface ComplianceIssue {
  code: string;
  field: string;
  message: string;
}

export interface ComplianceValidationMetadata {
  gstin?: {
    valid: boolean;
    stateCode?: string;
    pan?: string;
    entityCode?: string;
  };
  hsnSac?: {
    code: string;
    codeType: HsnSacCodeType;
    description: string | null;
    gstRate: number | null;
    defaultUqc: string | null;
    existsInMaster: boolean;
    isActive: boolean;
    digitLength: number;
    supplyType?: 'B2B' | 'B2C' | null;
  };
  uqc?: {
    valid: boolean;
    canonicalCode: string | null;
  };
  aatoThreshold?: {
    aato: number | null;
    threshold: number;
    exceeds5Cr: boolean;
    mandatedMinHsnDigits: number | null;
    state: AatoApplicabilityState;
    status: 'authoritative' | 'warning/unknown';
    precedingTurnover?: number | null;
    precedingVerificationStatus?: string | null;
    currentTurnover?: number | null;
    supplyType?: 'B2B' | 'B2C' | null;
  };
}

export interface ComplianceValidationResult {
  valid: boolean;
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  info: ComplianceIssue[];
  metadata?: ComplianceValidationMetadata;
}

export interface ComplianceValidationRequest {
  gstin?: string | null;
  hsnCode?: string | null;
  codeType?: HsnSacCodeType | null;
  supplyType?: 'B2B' | 'B2C' | null;
  uqc?: string | null;
  financialYear?: string | null;
  aggregateTurnover?: number | null;
  precedingTurnover?: number | null;
  precedingVerificationStatus?: string | null;
  currentTurnover?: number | null;
  aatoState?: AatoApplicabilityState | null;
}

/**
 * Validates a GSTIN for statutory compliance.
 * Reuses Phase C shared/gstin.ts.
 */
export function validateGstinCompliance(gstin?: string | null): {
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  info: ComplianceIssue[];
  details?: GstinValidationResult;
} {
  const errors: ComplianceIssue[] = [];
  const warnings: ComplianceIssue[] = [];
  const info: ComplianceIssue[] = [];

  if (!gstin || gstin.trim() === '') {
    errors.push({
      code: 'MISSING_GSTIN',
      field: 'gstin',
      message: 'GSTIN is required',
    });
    return { errors, warnings, info };
  }

  const result = validateGstin(gstin);
  if (!result.valid) {
    for (const err of result.errors) {
      errors.push({
        code: 'INVALID_GSTIN',
        field: 'gstin',
        message: err,
      });
    }
  } else {
    info.push({
      code: 'VALID_GSTIN',
      field: 'gstin',
      message: `GSTIN "${result.gstin}" is valid with correct checksum`,
    });
    if (result.stateCode) {
      info.push({
        code: 'GSTIN_STATE_INFO',
        field: 'gstin',
        message: `State Code: ${result.stateCode}`,
      });
    }
  }

  return { errors, warnings, info, details: result };
}

/**
 * Validates HSN/SAC code against master and AATO digit length thresholds.
 */
export async function validateHsnCompliance(params: {
  code?: string | null;
  codeType?: HsnSacCodeType | null;
  aato?: number | null;
  aatoState?: AatoApplicabilityState | null;
  supplyType?: 'B2B' | 'B2C' | null;
}): Promise<{
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  info: ComplianceIssue[];
  details?: ComplianceValidationMetadata['hsnSac'];
}> {
  const errors: ComplianceIssue[] = [];
  const warnings: ComplianceIssue[] = [];
  const info: ComplianceIssue[] = [];

  const rawCode = params.code?.trim();
  const codeType: HsnSacCodeType = params.codeType === 'SAC' ? 'SAC' : 'HSN';

  if (!rawCode) {
    errors.push({
      code: 'MISSING_HSN_SAC',
      field: 'hsnCode',
      message: `${codeType} code is required`,
    });
    return { errors, warnings, info };
  }

  // 1. Numeric check
  if (!/^\d+$/.test(rawCode)) {
    errors.push({
      code: 'INVALID_HSN_CHARACTERS',
      field: 'hsnCode',
      message: `${codeType} code must contain numeric digits only`,
    });
    return { errors, warnings, info };
  }

  // 2. Code Type checks
  const is99 = rawCode.startsWith('99');
  if (codeType === 'HSN' && is99) {
    warnings.push({
      code: 'CODE_TYPE_RECOMMEND_SAC',
      field: 'codeType',
      message: `Code "${rawCode}" begins with 99, which is the statutory Chapter 99 for Services (SAC). Recommended type is SAC.`,
    });
  } else if (codeType === 'SAC' && !is99) {
    warnings.push({
      code: 'INVALID_SAC_PREFIX',
      field: 'hsnCode',
      message: `SAC codes in India standardly begin with 99 (Chapter 99 Services). Got prefix "${rawCode.substring(0, 2)}"`,
    });
  }

  // 3. Digit length checks
  const len = rawCode.length;
  if (codeType === 'SAC') {
    if (len !== 6) {
      warnings.push({
        code: 'SAC_INVALID_LENGTH',
        field: 'hsnCode',
        message: `SAC codes are standardly 6 digits. Got ${len} digits.`,
      });
    }
  } else {
    // HSN standard lengths: 2, 4, 6, 8
    if (len % 2 !== 0 || len < 2 || len > 8) {
      warnings.push({
        code: 'HSN_NONSTANDARD_DIGIT_LENGTH',
        field: 'hsnCode',
        message: `HSN code length is ${len} digits. Standard GST HSN codes are 2, 4, 6, or 8 digits.`,
      });
    }
  }

  // 4. Lookup in Master (read-only against HsnCode table)
  let masterRecord: HsnSacCode | null = null;
  if (codeType === 'SAC') {
    masterRecord = await getSAC(rawCode);
  } else {
    masterRecord = await getHSN(rawCode);
  }

  let existsInMaster = false;
  let isActive = false;
  let description: string | null = null;
  let gstRate: number | null = null;
  let defaultUqc: string | null = null;

  if (masterRecord) {
    existsInMaster = true;
    isActive = masterRecord.isActive;
    description = masterRecord.description;
    gstRate = masterRecord.gstRate;
    defaultUqc = masterRecord.defaultUqc;

    if (!isActive) {
      errors.push({
        code: 'HSN_INACTIVE',
        field: 'hsnCode',
        message: `${codeType} code "${rawCode}" exists in master but is marked inactive`,
      });
    } else {
      info.push({
        code: 'HSN_MASTER_MATCH',
        field: 'hsnCode',
        message: `${codeType} code "${rawCode}" is active in master${description ? ` (${description})` : ''}`,
      });
    }
  } else {
    // Check if 4-digit heading prefix exists in master
    if (rawCode.length >= 4) {
      const heading = rawCode.substring(0, 4);
      const headingRow = await prisma.hsnCode.findFirst({
        where: { code: heading, codeType, isActive: true },
      });
      if (headingRow) {
        info.push({
          code: 'HSN_HEADING_EXISTS',
          field: 'hsnCode',
          message: `Code "${rawCode}" is not registered in master, but heading "${heading}" exists (${headingRow.description ?? 'Active'})`,
        });
      } else {
        warnings.push({
          code: 'HSN_NOT_IN_MASTER',
          field: 'hsnCode',
          message: `${codeType} code "${rawCode}" is not found in the local master database`,
        });
      }
    } else {
      warnings.push({
        code: 'HSN_NOT_IN_MASTER',
        field: 'hsnCode',
        message: `${codeType} code "${rawCode}" is not found in the local master database`,
      });
    }
  }

  // 5. AATO-based HSN digit length compliance (Notification No. 78/2020)
  // Under GST statutory rules, HSN digit requirements are based SOLELY on the PRECEDING FY AATO.
  const aatoState =
    params.aatoState ??
    (params.aato !== undefined && params.aato !== null ? 'PRECEDING_FY_AATO_UNVERIFIED' : null);

  if (aatoState === 'PRECEDING_FY_AATO_VERIFIED') {
    if (params.aato !== undefined && params.aato !== null) {
      const aato = Number(params.aato);
      if (aato > AATO_5CR_THRESHOLD) {
        // Preceding FY AATO > 5 Cr: 6 digits mandatory for ALL supplies (Notification No. 78/2020)
        if (len < 6) {
          warnings.push({
            code: 'HSN_MIN_6_DIGITS_AATO_OVER_5CR',
            field: 'hsnCode',
            message: `For businesses with preceding FY AATO > ₹5 Cr (verified), at least 6-digit HSN code is mandatory (Notification No. 78/2020). Current length: ${len} digits.`,
          });
        } else {
          info.push({
            code: 'AATO_HSN_DIGITS_COMPLIANT',
            field: 'hsnCode',
            message: `HSN code meets the 6-digit requirement for AATO > ₹5 Cr`,
          });
        }
      } else {
        // Preceding FY AATO <= 5 Cr:
        // Notification No. 78/2020 requires min 4 digits for B2B supplies, and optional for B2C supplies.
        if (params.supplyType === 'B2B') {
          if (len < 4) {
            warnings.push({
              code: 'HSN_MIN_4_DIGITS_B2B',
              field: 'hsnCode',
              message: `For businesses with preceding FY AATO ≤ ₹5 Cr (verified), at least 4-digit HSN code is required for B2B supplies. Current length: ${len} digits.`,
            });
          } else {
            info.push({
              code: 'AATO_HSN_DIGITS_COMPLIANT',
              field: 'hsnCode',
              message: `HSN code meets the 4-digit requirement for AATO ≤ ₹5 Cr (B2B)`,
            });
          }
        } else if (params.supplyType === 'B2C') {
          if (len < 4) {
            info.push({
              code: 'HSN_B2C_OPTIONAL',
              field: 'hsnCode',
              message: `For B2C supplies with preceding FY AATO ≤ ₹5 Cr, 4-digit HSN is optional (Notification No. 78/2020).`,
            });
          } else {
            info.push({
              code: 'AATO_HSN_DIGITS_COMPLIANT',
              field: 'hsnCode',
              message: `HSN code meets the 4-digit standard for AATO ≤ ₹5 Cr`,
            });
          }
        } else {
          // Supply type is omitted/unknown — do NOT silently assume B2B
          if (len < 4) {
            warnings.push({
              code: 'SUPPLY_TYPE_REQUIRED_FOR_HSN_RULE',
              field: 'supplyType',
              message: `Supply type (B2B or B2C) is required to determine statutory HSN digit requirement for preceding FY AATO ≤ ₹5 Cr. 4-digit HSN is mandatory for B2B supplies, but optional for B2C supplies (Notification No. 78/2020).`,
            });
          } else {
            info.push({
              code: 'AATO_HSN_DIGITS_COMPLIANT',
              field: 'hsnCode',
              message: `HSN code meets the 4-digit requirement for AATO ≤ ₹5 Cr`,
            });
          }
        }
      }
    }
  } else if (aatoState === 'PRECEDING_FY_AATO_UNVERIFIED') {
    warnings.push({
      code: 'PRECEDING_FY_AATO_UNVERIFIED',
      field: 'hsnCode',
      message:
        'Preceding FY AATO exists but is UNVERIFIED. Statutory HSN digit requirement (4-digit vs 6-digit under Notification No. 78/2020) cannot be authoritatively determined until preceding FY turnover is verified.',
    });
  } else if (aatoState === 'PRECEDING_FY_AATO_MISSING') {
    warnings.push({
      code: 'PRECEDING_FY_AATO_MISSING',
      field: 'hsnCode',
      message:
        'Preceding FY AATO record is missing. Preceding FY AATO is required by Notification No. 78/2020 to determine statutory 4-digit or 6-digit HSN applicability. Current FY AATO cannot be used as a statutory substitute.',
    });
  }

  const details: ComplianceValidationMetadata['hsnSac'] = {
    code: rawCode,
    codeType,
    description,
    gstRate,
    defaultUqc,
    existsInMaster,
    isActive,
    digitLength: len,
    supplyType: params.supplyType ?? null,
  };

  return { errors, warnings, info, details };
}

/**
 * Validates UQC for statutory GST reporting.
 */
export function validateUqcCompliance(uqc?: string | null, hsnDefaultUqc?: string | null): {
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  info: ComplianceIssue[];
  details?: UqcValidationResult;
} {
  const errors: ComplianceIssue[] = [];
  const warnings: ComplianceIssue[] = [];
  const info: ComplianceIssue[] = [];

  const res = validateUqc(uqc);
  if (!res.valid) {
    if (res.status === 'MISSING') {
      warnings.push({
        code: 'MISSING_UQC',
        field: 'uqc',
        message: 'UQC is missing; standard GST invoices require a valid UQC (e.g. GMS or PCS)',
      });
    } else {
      errors.push({
        code: res.issue?.code ?? 'INVALID_UQC',
        field: 'uqc',
        message: res.issue?.message ?? 'Invalid UQC',
      });
    }
  } else {
    if (res.status === 'NORMALIZED') {
      info.push({
        code: res.issue?.code ?? 'UQC_NORMALIZED',
        field: 'uqc',
        message: res.issue?.message ?? `UQC normalized to "${res.canonicalCode}"`,
      });
    } else {
      info.push({
        code: 'VALID_UQC',
        field: 'uqc',
        message: `UQC "${res.canonicalCode}" is a standard GST Unit Quantity Code`,
      });
    }

    if (hsnDefaultUqc && res.canonicalCode && res.canonicalCode !== hsnDefaultUqc) {
      info.push({
        code: 'UQC_DIFFERS_FROM_HSN_DEFAULT',
        field: 'uqc',
        message: `Item UQC "${res.canonicalCode}" differs from HSN default UQC "${hsnDefaultUqc}"`,
      });
    }
  }

  return { errors, warnings, info, details: res };
}

/**
 * Comprehensive GST compliance validation orchestrator.
 * Accepts any combination of GSTIN, HSN/SAC, UQC, and AATO parameters.
 * Distinguishes ERROR, WARNING, and INFO.
 */
export async function validateGstCompliance(
  request: ComplianceValidationRequest
): Promise<ComplianceValidationResult> {
  const errors: ComplianceIssue[] = [];
  const warnings: ComplianceIssue[] = [];
  const info: ComplianceIssue[] = [];
  const metadata: ComplianceValidationMetadata = {};

  // 1. GSTIN
  if (request.gstin !== undefined) {
    const gstinRes = validateGstinCompliance(request.gstin);
    errors.push(...gstinRes.errors);
    warnings.push(...gstinRes.warnings);
    info.push(...gstinRes.info);
    if (gstinRes.details) {
      metadata.gstin = {
        valid: gstinRes.details.valid,
        stateCode: gstinRes.details.stateCode,
        pan: gstinRes.details.pan,
        entityCode: gstinRes.details.entityCode,
      };
    }
  }

  // Determine AATO state and numbers
  let aatoState: AatoApplicabilityState;
  let effectivePrecedingTurnover: number | null = null;
  let effectiveCurrentTurnover: number | null = null;

  if (request.currentTurnover !== undefined && request.currentTurnover !== null) {
    effectiveCurrentTurnover = Number(request.currentTurnover);
  }

  if (request.precedingTurnover !== undefined && request.precedingTurnover !== null) {
    effectivePrecedingTurnover = Number(request.precedingTurnover);
  } else if (
    request.aggregateTurnover !== undefined &&
    request.aggregateTurnover !== null &&
    request.precedingTurnover === undefined
  ) {
    effectivePrecedingTurnover = Number(request.aggregateTurnover);
  }

  if (request.aatoState) {
    aatoState = request.aatoState;
  } else if (effectivePrecedingTurnover !== null) {
    const isExplicitlyVerified = request.precedingVerificationStatus === 'VERIFIED';
    if (isExplicitlyVerified) {
      aatoState = 'PRECEDING_FY_AATO_VERIFIED';
    } else {
      // UNVERIFIED, missing, null, or undefined: must NOT assume verification
      aatoState = 'PRECEDING_FY_AATO_UNVERIFIED';
    }
  } else {
    aatoState = 'PRECEDING_FY_AATO_MISSING';
  }

  // 2. HSN / SAC
  let hsnDefaultUqc: string | null = null;
  if (request.hsnCode !== undefined) {
    const hsnRes = await validateHsnCompliance({
      code: request.hsnCode,
      codeType: request.codeType,
      aato: effectivePrecedingTurnover,
      aatoState,
      supplyType: request.supplyType,
    });
    errors.push(...hsnRes.errors);
    warnings.push(...hsnRes.warnings);
    info.push(...hsnRes.info);
    if (hsnRes.details) {
      metadata.hsnSac = hsnRes.details;
      hsnDefaultUqc = hsnRes.details.defaultUqc;
    }
  } else {
    // If HSN code wasn't validated, still output AATO state warning if unverified or missing (when AATO params are provided)
    const hasAatoParams =
      request.aggregateTurnover !== undefined ||
      request.precedingTurnover !== undefined ||
      request.currentTurnover !== undefined ||
      request.aatoState !== undefined;

    if (hasAatoParams) {
      if (aatoState === 'PRECEDING_FY_AATO_UNVERIFIED') {
        warnings.push({
          code: 'PRECEDING_FY_AATO_UNVERIFIED',
          field: 'aatoThreshold',
          message:
            'Preceding FY AATO exists but is UNVERIFIED. Statutory HSN digit requirement (4-digit vs 6-digit under Notification No. 78/2020) cannot be authoritatively determined until preceding FY turnover is verified.',
        });
      } else if (aatoState === 'PRECEDING_FY_AATO_MISSING') {
        warnings.push({
          code: 'PRECEDING_FY_AATO_MISSING',
          field: 'aatoThreshold',
          message:
            'Preceding FY AATO record is missing. Preceding FY AATO is required by Notification No. 78/2020 to determine statutory 4-digit or 6-digit HSN applicability. Current FY AATO cannot be used as a statutory substitute.',
        });
      }
    }
  }

  // 3. UQC
  if (request.uqc !== undefined) {
    const uqcRes = validateUqcCompliance(request.uqc, hsnDefaultUqc);
    errors.push(...uqcRes.errors);
    warnings.push(...uqcRes.warnings);
    info.push(...uqcRes.info);
    if (uqcRes.details) {
      metadata.uqc = {
        valid: uqcRes.details.valid,
        canonicalCode: uqcRes.details.canonicalCode,
      };
    }
  }

  // 4. AATO metadata & Contextual Information
  const hasAatoParams =
    request.aggregateTurnover !== undefined ||
    request.precedingTurnover !== undefined ||
    request.currentTurnover !== undefined ||
    request.aatoState !== undefined;

  if (hasAatoParams) {
    if (aatoState === 'PRECEDING_FY_AATO_VERIFIED' && effectivePrecedingTurnover !== null) {
      const exceeds5Cr = effectivePrecedingTurnover > AATO_5CR_THRESHOLD;
      let mandatedMinHsnDigits: number | null;
      if (exceeds5Cr) {
        mandatedMinHsnDigits = 6;
      } else if (request.supplyType === 'B2C') {
        mandatedMinHsnDigits = null; // optional under Notification No. 78/2020
      } else {
        mandatedMinHsnDigits = 4;
      }

      metadata.aatoThreshold = {
        aato: effectivePrecedingTurnover,
        threshold: AATO_5CR_THRESHOLD,
        exceeds5Cr,
        mandatedMinHsnDigits,
        state: 'PRECEDING_FY_AATO_VERIFIED',
        status: 'authoritative',
        precedingTurnover: effectivePrecedingTurnover,
        precedingVerificationStatus: request.precedingVerificationStatus ?? 'VERIFIED',
        currentTurnover: effectiveCurrentTurnover,
        supplyType: request.supplyType ?? null,
      };
    } else if (aatoState === 'PRECEDING_FY_AATO_UNVERIFIED') {
      metadata.aatoThreshold = {
        aato: effectivePrecedingTurnover,
        threshold: AATO_5CR_THRESHOLD,
        exceeds5Cr: false,
        mandatedMinHsnDigits: null,
        state: 'PRECEDING_FY_AATO_UNVERIFIED',
        status: 'warning/unknown',
        precedingTurnover: effectivePrecedingTurnover,
        precedingVerificationStatus: request.precedingVerificationStatus ?? 'UNVERIFIED',
        currentTurnover: effectiveCurrentTurnover,
        supplyType: request.supplyType ?? null,
      };
    } else {
      // PRECEDING_FY_AATO_MISSING
      metadata.aatoThreshold = {
        aato: null,
        threshold: AATO_5CR_THRESHOLD,
        exceeds5Cr: false,
        mandatedMinHsnDigits: null,
        state: 'PRECEDING_FY_AATO_MISSING',
        status: 'warning/unknown',
        precedingTurnover: null,
        precedingVerificationStatus: null,
        currentTurnover: effectiveCurrentTurnover,
        supplyType: request.supplyType ?? null,
      };
    }

    // Contextual note if current FY turnover is available
    if (effectiveCurrentTurnover !== null) {
      info.push({
        code: 'CURRENT_FY_AATO_INFORMATIONAL',
        field: 'aatoThreshold',
        message: `Current FY turnover (₹${effectiveCurrentTurnover.toLocaleString('en-IN')}) is recorded for informational context only and does not determine statutory HSN digit requirements.`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
    metadata,
  };
}
