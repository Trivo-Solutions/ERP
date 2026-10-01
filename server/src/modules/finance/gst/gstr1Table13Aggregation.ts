// G2g-3g-1 — GSTR-1 Table 13 Pure Document Range Engine.
// Aggregates already-loaded document records into statutory document series and contiguous ranges
// per Form GSTR-1 Table 13 (Documents Issued).
//
// Pure TypeScript, deterministic, independent of Prisma, database, Express, React, and network.
// Same input always produces identical output.
//
// Core Rules:
// 1. Conservative document-number parsing: parses prefix, optional financial year, and numeric serial.
// 2. Series identity: partitioned by document category, sellerRegistrationId, prefix/series, and financial year.
//    BranchId is preserved as metadata only and never splits statutory series.
// 3. Multi-GSTIN isolation: never merges documents belonging to different seller registrations into the same series.
// 4. Legacy null registration: sellerRegistrationId = null forms a distinct series (internal key 'LEGACY'),
//    marked filingEligible = false with MISSING_SELLER_REGISTRATION / LEGACY_SERIES diagnostics.
// 5. Contiguous ranges: splits on missing sequence numbers into separate contiguous ranges.
// 6. Gap vs Cancelled semantics: only real documents with status VOID or CANCELLED contribute to cancelledDocuments.
//    Missing numbers are reported as UNEXPLAINED_SEQUENCE_GAP diagnostics and NEVER manufactured as cancellations.
// 7. Duplicate handling: detects DUPLICATE_DOCUMENT_ID (deduplicated, not double-counted) and
//    DUPLICATE_DOCUMENT_SERIAL (flags conflicting documents, marks affected series filingEligible = false).
// 8. Financial year validation: verifies document date matches encoded FY; flags DOCUMENT_FY_MISMATCH if different.

export type Table13DocumentType =
  | 'SALES_INVOICE'
  | 'OUTWARD_INVOICE'
  | 'CREDIT_NOTE'
  | 'OUTWARD_DEBIT_NOTE'
  | 'DELIVERY_CHALLAN'
  | 'RECEIPT_VOUCHER'
  | 'PAYMENT_VOUCHER'
  | 'REFUND_VOUCHER'
  | 'OTHER';

export type Table13DocumentCategory =
  | 'OUTWARD_INVOICE'
  | 'CREDIT_NOTE'
  | 'OUTWARD_DEBIT_NOTE'
  | 'DELIVERY_CHALLAN'
  | 'RECEIPT_VOUCHER'
  | 'PAYMENT_VOUCHER'
  | 'REFUND_VOUCHER'
  | 'OTHER';

export interface Table13Document {
  id: string;
  documentNumber: string;
  documentDate: Date | string;
  status: string;
  documentType: Table13DocumentType | string;
  sellerRegistrationId: string | null;
  series?: string | null;
  branchId?: string | null;
}

export type Table13DiagnosticCode =
  | 'UNPARSEABLE_DOCUMENT_NUMBER'
  | 'DUPLICATE_DOCUMENT_ID'
  | 'DUPLICATE_DOCUMENT_SERIAL'
  | 'MISSING_SELLER_REGISTRATION'
  | 'DOCUMENT_FY_MISMATCH'
  | 'UNEXPLAINED_SEQUENCE_GAP'
  | 'LEGACY_SERIES'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'INVALID_DOCUMENT_STATUS';

export type Table13DiagnosticSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface Table13Diagnostic {
  code: Table13DiagnosticCode;
  severity: Table13DiagnosticSeverity;
  message: string;
  category?: Table13DocumentCategory;
  sellerRegistrationId?: string | null;
  seriesKey?: string;
  documentId?: string;
  documentNumber?: string;
  previousSerial?: number;
  nextSerial?: number;
  missingFrom?: number;
  missingTo?: number;
  missingCount?: number;
  serial?: number;
  conflictingDocumentIds?: string[];
  conflictingDocumentNumbers?: string[];
  encodedFinancialYear?: number | null;
  dateFinancialYear?: number | null;
}

export interface Table13SeriesResult {
  category: Table13DocumentCategory;
  sellerRegistrationId: string | null;
  seriesKey: string;
  prefix: string;
  financialYear: number | null;

  from: string;
  to: string;
  fromDocumentNumber: string;
  toDocumentNumber: string;
  fromSerial: number;
  toSerial: number;

  totalDocuments: number;
  cancelledDocuments: number;
  netIssued: number;

  documentCount: number;

  filingEligible: boolean;

  diagnostics: Table13Diagnostic[];

  branchIds?: string[];
}

export interface Table13AggregationSummary {
  seriesCount: number;
  filingEligibleSeries: number;
  nonFilingEligibleSeries: number;
  documentCount: number;
  cancelledDocumentCount: number;
}

export interface Table13Aggregation {
  series: Table13SeriesResult[];
  diagnostics: Table13Diagnostic[];
  summary: Table13AggregationSummary;
}

export interface Table13AggregationOptions {
  gstRegistrationId?: string | null;
  period?: { from: Date; to: Date };
  branchId?: string | null;
}

export interface ParsedDocumentNumber {
  originalNumber: string;
  prefix: string;
  financialYear: number | null;
  financialYearRaw: string | null;
  serial: number;
  formattedSerial: string;
}

/**
 * Calculates Indian GST Financial Year from a Date.
 * In India, FY runs Apr 1 to Mar 31.
 * Returns the calendar year the FY starts in (e.g. Apr 2026 -> 2026 for FY 2026-27; Jan 2026 -> 2025 for FY 2025-26).
 */
export function getGstFinancialYear(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed: 0=Jan, 1=Feb, 2=Mar
  return month < 3 ? year - 1 : year;
}

/**
 * Conservative document-number parser.
 * Identifies:
 * 1. prefix / series component
 * 2. financial-year component if present
 * 3. numeric serial component (with leading zero preservation)
 * 4. original complete document number
 *
 * Examples:
 * - "INV-2026-000001" -> prefix: "INV", financialYear: 2026, serial: 1, formattedSerial: "000001"
 * - "CN-2026-000001"  -> prefix: "CN", financialYear: 2026, serial: 1, formattedSerial: "000001"
 * - "DN-2026-000001"  -> prefix: "DN", financialYear: 2026, serial: 1, formattedSerial: "000001"
 * - "INV/2026/000001" -> prefix: "INV", financialYear: 2026, serial: 1, formattedSerial: "000001"
 * - "INV/2025-26/001" -> prefix: "INV", financialYear: 2025, serial: 1, formattedSerial: "001"
 * - "INV-000042"      -> prefix: "INV", financialYear: null, serial: 42, formattedSerial: "000042"
 * - "000005"          -> prefix: "", financialYear: null, serial: 5, formattedSerial: "000005"
 *
 * Returns null if the number cannot be safely parsed without guessing.
 */
export function parseDocumentNumber(raw: string): ParsedDocumentNumber | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 16) {
    // Under Rule 46(b), document serial numbers must not exceed 16 characters
    return null;
  }

  // 1. Purely numeric document number, e.g. "000001", "12345"
  if (/^\d+$/.test(trimmed)) {
    const serial = parseInt(trimmed, 10);
    if (isNaN(serial) || serial <= 0) return null;
    return {
      originalNumber: trimmed,
      prefix: '',
      financialYear: null,
      financialYearRaw: null,
      serial,
      formattedSerial: trimmed,
    };
  }

  // 2. Trailing numeric serial preceded by a separator (- or /)
  // e.g. "INV-2026-000001", "INV/2026/000001", "CN-2026-000001", "INV-000042", "INV/2025-26/0001"
  const serialMatch = trimmed.match(/^(.+)[-/](\d+)$/);
  if (!serialMatch) {
    // No separator before trailing digits or no trailing digits at all (e.g. "INV2026000001", "INVALID")
    return null;
  }

  const remainder = serialMatch[1];
  const formattedSerial = serialMatch[2];
  const serial = parseInt(formattedSerial, 10);
  if (isNaN(serial) || serial <= 0) return null;

  // Check if remainder ends with a financial year:
  // Case A: Combined FY like "INV-2025-26", "INV/2025-26", "INV/25-26", "2025-26"
  const fyCombinedMatch = remainder.match(/^(?:(.*)[-/])?(\d{2,4})[-/](\d{2})$/);
  if (fyCombinedMatch) {
    const rawFyStart = fyCombinedMatch[2];
    const rawFyEnd = fyCombinedMatch[3];
    const fyStartNum = rawFyStart.length === 2 ? 2000 + parseInt(rawFyStart, 10) : parseInt(rawFyStart, 10);
    const fyEndNum = parseInt(rawFyEnd, 10);
    // Sanity check: e.g. 2025-26 => (25 + 1) % 100 === 26
    if ((fyStartNum + 1) % 100 === fyEndNum % 100) {
      const prefix = fyCombinedMatch[1] ?? '';
      return {
        originalNumber: trimmed,
        prefix,
        financialYear: fyStartNum,
        financialYearRaw: `${rawFyStart}-${rawFyEnd}`,
        serial,
        formattedSerial,
      };
    }
  }

  // Case B: 4-digit calendar year: e.g. "INV-2026", "CN/2026", "2026"
  const fy4Match = remainder.match(/^(?:(.*)[-/])?(\d{4})$/);
  if (fy4Match) {
    const fyNum = parseInt(fy4Match[2], 10);
    // Indian GST years (2017 to 2099)
    if (fyNum >= 2017 && fyNum <= 2099) {
      const prefix = fy4Match[1] ?? '';
      return {
        originalNumber: trimmed,
        prefix,
        financialYear: fyNum,
        financialYearRaw: fy4Match[2],
        serial,
        formattedSerial,
      };
    }
  }

  // Case C: Remainder is the prefix with no encoded financial year, e.g. "INV-000042"
  return {
    originalNumber: trimmed,
    prefix: remainder,
    financialYear: null,
    financialYearRaw: null,
    serial,
    formattedSerial,
  };
}

/**
 * Maps documentType string to Table13DocumentCategory.
 * Procurement-side debit notes and non-statutory documents (MemoOut, BranchTransfer, PO) return null.
 */
export function resolveDocumentCategory(documentType: string): Table13DocumentCategory | null {
  if (!documentType || typeof documentType !== 'string') return null;
  const norm = documentType.trim().toUpperCase();
  switch (norm) {
    case 'SALES_INVOICE':
    case 'OUTWARD_INVOICE':
    case 'INVOICE':
      return 'OUTWARD_INVOICE';
    case 'CREDIT_NOTE':
      return 'CREDIT_NOTE';
    case 'OUTWARD_DEBIT_NOTE':
      return 'OUTWARD_DEBIT_NOTE';
    case 'DELIVERY_CHALLAN':
      return 'DELIVERY_CHALLAN';
    case 'RECEIPT_VOUCHER':
      return 'RECEIPT_VOUCHER';
    case 'PAYMENT_VOUCHER':
      return 'PAYMENT_VOUCHER';
    case 'REFUND_VOUCHER':
      return 'REFUND_VOUCHER';
    case 'OTHER':
      return 'OTHER';
    default:
      return null;
  }
}

/**
 * Returns true if status represents a cancelled/voided document.
 */
export function isDocumentVoidOrCancelled(status: string): boolean {
  if (!status || typeof status !== 'string') return false;
  const s = status.trim().toUpperCase();
  return s === 'VOID' || s === 'CANCELLED';
}

const KNOWN_VALID_STATUSES = new Set([
  'DRAFT',
  'ISSUED',
  'PAID',
  'PARTIALLY_PAID',
  'ACTIVE',
  'VOID',
  'CANCELLED',
]);

/**
 * Returns true if status is an existing valid document status.
 */
export function isKnownValidStatus(status: string): boolean {
  if (!status || typeof status !== 'string') return false;
  return KNOWN_VALID_STATUSES.has(status.trim().toUpperCase());
}

interface NormalizedDocRecord {
  doc: Table13Document;
  parsed: ParsedDocumentNumber;
  docDate: Date;
  category: Table13DocumentCategory;
  effectivePrefix: string;
  effectiveFy: number;
}

/**
 * Aggregates already-loaded document records into GSTR-1 Table 13 series and contiguous ranges.
 * Pure and deterministic: no Prisma, no Express, no HTTP, no side effects.
 */
export function aggregateGstr1Table13(
  documents: Table13Document[],
  options?: Table13AggregationOptions
): Table13Aggregation {
  const topDiagnostics: Table13Diagnostic[] = [];
  const seenDocIds = new Set<string>();

  // 1. Group documents by statutory series key
  // seriesKey incorporates: category, sellerRegistrationId (or 'LEGACY'), prefix/series, and financial year.
  // branchId is preserved as metadata and never used to split statutory series.
  const seriesGroups = new Map<string, {
    category: Table13DocumentCategory;
    sellerRegistrationId: string | null;
    prefix: string;
    financialYear: number;
    docs: NormalizedDocRecord[];
    diagnostics: Table13Diagnostic[];
    branchIds: Set<string>;
    hasDuplicateId: boolean;
    hasFyMismatch: boolean;
    hasInvalidStatus: boolean;
  }>();

  for (const doc of documents) {
    // Optional filtering
    if (options?.gstRegistrationId !== undefined) {
      if (doc.sellerRegistrationId !== options.gstRegistrationId) {
        continue;
      }
    }
    if (options?.branchId !== undefined && options.branchId !== null) {
      if (doc.branchId !== options.branchId) {
        continue;
      }
    }

    // Parse date
    const docDate = doc.documentDate instanceof Date ? doc.documentDate : new Date(doc.documentDate);
    const isDateValid = !isNaN(docDate.getTime());
    if (options?.period !== undefined) {
      if (!isDateValid || docDate < options.period.from || docDate > options.period.to) {
        continue;
      }
    }

    // Category resolution
    const category = resolveDocumentCategory(doc.documentType);
    if (!category) {
      topDiagnostics.push({
        code: 'UNSUPPORTED_DOCUMENT_TYPE',
        severity: 'ERROR',
        message: `Document '${doc.documentNumber}' has unsupported documentType '${doc.documentType}'.`,
        sellerRegistrationId: doc.sellerRegistrationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      });
      continue;
    }

    // Number parsing
    const parsed = parseDocumentNumber(doc.documentNumber);
    if (!parsed) {
      topDiagnostics.push({
        code: 'UNPARSEABLE_DOCUMENT_NUMBER',
        severity: 'ERROR',
        message: `Document number '${doc.documentNumber}' cannot be safely parsed into prefix, financial year, and numeric serial.`,
        category,
        sellerRegistrationId: doc.sellerRegistrationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      });
      continue;
    }

    // Status validation
    let hasInvalidStatus = false;
    if (!isKnownValidStatus(doc.status)) {
      hasInvalidStatus = true;
      topDiagnostics.push({
        code: 'INVALID_DOCUMENT_STATUS',
        severity: 'ERROR',
        message: `Document '${doc.documentNumber}' has unrecognized status '${doc.status}'.`,
        category,
        sellerRegistrationId: doc.sellerRegistrationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      });
    }

    // Financial year check
    const effectivePrefix = (doc.series ?? parsed.prefix).trim();
    const dateFy = isDateValid ? getGstFinancialYear(docDate) : null;
    let hasFyMismatch = false;

    if (parsed.financialYear !== null && dateFy !== null && parsed.financialYear !== dateFy) {
      hasFyMismatch = true;
      topDiagnostics.push({
        code: 'DOCUMENT_FY_MISMATCH',
        severity: 'ERROR',
        message: `Document '${doc.documentNumber}' date (${docDate.toISOString().slice(0, 10)}) corresponds to FY ${dateFy}, but document number encodes FY ${parsed.financialYear}.`,
        category,
        sellerRegistrationId: doc.sellerRegistrationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        encodedFinancialYear: parsed.financialYear,
        dateFinancialYear: dateFy,
      });
    }

    const effectiveFy = parsed.financialYear ?? (dateFy ?? 0);
    const sellerRegKey = doc.sellerRegistrationId ?? 'LEGACY';
    const seriesKey = `${category}|${sellerRegKey}|${effectivePrefix}|${effectiveFy}`;

    let group = seriesGroups.get(seriesKey);
    if (!group) {
      group = {
        category,
        sellerRegistrationId: doc.sellerRegistrationId,
        prefix: effectivePrefix,
        financialYear: effectiveFy,
        docs: [],
        diagnostics: [],
        branchIds: new Set<string>(),
        hasDuplicateId: false,
        hasFyMismatch: false,
        hasInvalidStatus: false,
      };
      seriesGroups.set(seriesKey, group);

      // Legacy series diagnostic
      if (doc.sellerRegistrationId === null) {
        group.diagnostics.push({
          code: 'MISSING_SELLER_REGISTRATION',
          severity: 'ERROR',
          message: `Series '${seriesKey}' is missing seller GST registration ID. Registration is required for statutory GSTR-1 Table 13 filing.`,
          category,
          sellerRegistrationId: null,
          seriesKey,
        });
        group.diagnostics.push({
          code: 'LEGACY_SERIES',
          severity: 'WARNING',
          message: `Series '${seriesKey}' belongs to legacy null registration. Calculated for audit/inspection only.`,
          category,
          sellerRegistrationId: null,
          seriesKey,
        });
      }
    }

    if (hasFyMismatch) group.hasFyMismatch = true;
    if (hasInvalidStatus) group.hasInvalidStatus = true;
    if (doc.branchId) group.branchIds.add(doc.branchId);

    // Duplicate document ID detection
    if (seenDocIds.has(doc.id)) {
      group.hasDuplicateId = true;
      const dupIdDiag: Table13Diagnostic = {
        code: 'DUPLICATE_DOCUMENT_ID',
        severity: 'ERROR',
        message: `Duplicate document ID '${doc.id}' supplied multiple times (document number: ${doc.documentNumber}).`,
        category,
        sellerRegistrationId: doc.sellerRegistrationId,
        seriesKey,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      };
      group.diagnostics.push(dupIdDiag);
      topDiagnostics.push(dupIdDiag);
      continue;
    }
    seenDocIds.add(doc.id);

    group.docs.push({
      doc,
      parsed,
      docDate,
      category,
      effectivePrefix,
      effectiveFy,
    });
  }

  // 2. Process each series: sort documents by serial, detect duplicate serials, detect gaps, split contiguous ranges
  const seriesResults: Table13SeriesResult[] = [];

  for (const [seriesKey, group] of seriesGroups.entries()) {
    // Check for duplicate serial numbers within the series
    const docsBySerial = new Map<number, NormalizedDocRecord[]>();
    for (const d of group.docs) {
      const list = docsBySerial.get(d.parsed.serial) ?? [];
      list.push(d);
      docsBySerial.set(d.parsed.serial, list);
    }

    let hasDuplicateSerial = false;
    for (const [serial, docs] of docsBySerial.entries()) {
      if (docs.length > 1) {
        hasDuplicateSerial = true;
        const dupSerialDiag: Table13Diagnostic = {
          code: 'DUPLICATE_DOCUMENT_SERIAL',
          severity: 'ERROR',
          message: `Multiple documents share serial number ${serial} in series '${seriesKey}': ${docs.map((d) => d.doc.documentNumber).join(', ')}.`,
          category: group.category,
          sellerRegistrationId: group.sellerRegistrationId,
          seriesKey,
          serial,
          conflictingDocumentIds: docs.map((d) => d.doc.id),
          conflictingDocumentNumbers: docs.map((d) => d.doc.documentNumber),
        };
        group.diagnostics.push(dupSerialDiag);
        topDiagnostics.push(dupSerialDiag);
      }
    }

    // Sort documents by numeric serial ascending
    group.docs.sort((a, b) => a.parsed.serial - b.parsed.serial);

    if (group.docs.length === 0) {
      continue;
    }

    // Split into contiguous ranges and detect unexplained sequence gaps
    const contiguousRanges: NormalizedDocRecord[][] = [];
    let currentRange: NormalizedDocRecord[] = [];

    for (let i = 0; i < group.docs.length; i++) {
      const current = group.docs[i];
      if (currentRange.length === 0) {
        currentRange.push(current);
        continue;
      }

      const prev = currentRange[currentRange.length - 1];

      if (current.parsed.serial === prev.parsed.serial) {
        // Same serial (duplicate serial scenario) - group together
        currentRange.push(current);
      } else if (current.parsed.serial === prev.parsed.serial + 1) {
        // Contiguous
        currentRange.push(current);
      } else {
        // Gap! current.parsed.serial > prev.parsed.serial + 1
        const missingFrom = prev.parsed.serial + 1;
        const missingTo = current.parsed.serial - 1;
        const missingCount = current.parsed.serial - prev.parsed.serial - 1;

        const gapDiag: Table13Diagnostic = {
          code: 'UNEXPLAINED_SEQUENCE_GAP',
          severity: 'WARNING',
          message: `Unexplained sequence gap in series '${seriesKey}': missing serials ${missingFrom} to ${missingTo} (${missingCount} missing) between ${prev.doc.documentNumber} and ${current.doc.documentNumber}.`,
          category: group.category,
          sellerRegistrationId: group.sellerRegistrationId,
          seriesKey,
          previousSerial: prev.parsed.serial,
          nextSerial: current.parsed.serial,
          missingFrom,
          missingTo,
          missingCount,
        };
        group.diagnostics.push(gapDiag);
        topDiagnostics.push(gapDiag);

        contiguousRanges.push(currentRange);
        currentRange = [current];
      }
    }

    if (currentRange.length > 0) {
      contiguousRanges.push(currentRange);
    }

    // Determine series filing eligibility
    const isLegacy = group.sellerRegistrationId === null;
    const seriesFilingEligible =
      !isLegacy &&
      !hasDuplicateSerial &&
      !group.hasDuplicateId &&
      !group.hasFyMismatch &&
      !group.hasInvalidStatus;

    // Create a series result for each contiguous range
    for (const range of contiguousRanges) {
      const first = range[0];
      const last = range[range.length - 1];

      const from = first.parsed.formattedSerial;
      const to = last.parsed.formattedSerial;
      const fromDocumentNumber = first.doc.documentNumber;
      const toDocumentNumber = last.doc.documentNumber;
      const fromSerial = first.parsed.serial;
      const toSerial = last.parsed.serial;

      const totalDocuments = range.length;
      const cancelledDocuments = range.filter((d) => isDocumentVoidOrCancelled(d.doc.status)).length;
      const netIssued = totalDocuments - cancelledDocuments;
      const documentCount = totalDocuments;

      // Diagnostics associated with this series / range
      const rangeDiagnostics = [...group.diagnostics];

      seriesResults.push({
        category: group.category,
        sellerRegistrationId: group.sellerRegistrationId,
        seriesKey,
        prefix: group.prefix,
        financialYear: group.financialYear,
        from,
        to,
        fromDocumentNumber,
        toDocumentNumber,
        fromSerial,
        toSerial,
        totalDocuments,
        cancelledDocuments,
        netIssued,
        documentCount,
        filingEligible: seriesFilingEligible,
        diagnostics: rangeDiagnostics,
        branchIds: group.branchIds.size > 0 ? Array.from(group.branchIds) : undefined,
      });
    }
  }

  // 3. Deterministic sorting of series results
  seriesResults.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    const regA = a.sellerRegistrationId ?? '';
    const regB = b.sellerRegistrationId ?? '';
    if (regA !== regB) return regA.localeCompare(regB);
    if (a.prefix !== b.prefix) return a.prefix.localeCompare(b.prefix);
    const fyA = a.financialYear ?? 0;
    const fyB = b.financialYear ?? 0;
    if (fyA !== fyB) return fyA - fyB;
    return a.fromSerial - b.fromSerial;
  });

  // 4. Construct summary
  const summary: Table13AggregationSummary = {
    seriesCount: seriesResults.length,
    filingEligibleSeries: seriesResults.filter((s) => s.filingEligible).length,
    nonFilingEligibleSeries: seriesResults.filter((s) => !s.filingEligible).length,
    documentCount: seriesResults.reduce((sum, s) => sum + s.documentCount, 0),
    cancelledDocumentCount: seriesResults.reduce((sum, s) => sum + s.cancelledDocuments, 0),
  };

  return {
    series: seriesResults,
    diagnostics: topDiagnostics,
    summary,
  };
}
